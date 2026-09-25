// Hub de colaboración (D-012): notas calientes como documentos Yjs sobre el
// texto del archivo. El archivo sigue siendo la fuente de verdad; el documento
// es una caché que existe mientras alguien tiene la nota abierta. Diseño y
// casos límite validados en poc/crdt-bridge (ver su README).
import { Hocuspocus } from '@hocuspocus/server'
import diff from 'fast-diff'
import { closeSync, constants, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { dirname, join } from 'node:path'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import { contentHash, newUid, readFrontmatter, setFrontmatterKey } from '@thoth/core'
import type { Auth, User } from './auth.ts'
import { readStable, readText, replaceText } from './fsutil.ts'
import type { Indexer } from './indexer.ts'
import { NoteError, NoteService, type Actor, type HotDocuments } from './notes.ts'

export const TEXT = 'md'
export const COLLAB_PATH = '/collab'
const HISTORY = 20

interface Base { snapshot: Uint8Array; text: string; hash: string }

interface Hot {
  doc: Y.Doc
  file: string
  logFile: string
  logFd: number
  /** Estado del documento que coincide con lo que hay en disco. */
  snapshot: Uint8Array
  flushedText: string
  flushedHash: string
  /** Últimos estados volcados: un editor externo puede guardar partiendo de uno antiguo. */
  history: Base[]
  /** uid que tenía la nota al cargarla, para no perderlo si se borra en el editor. */
  uid: string | null
  /** La nota se borró desde thoth: no se vuelve a volcar. */
  discarded: boolean
  /**
   * El archivo se borró desde fuera con la nota abierta. No se escribe nada en
   * disco hasta que alguien decida conservar su copia o descartarla; mientras
   * tanto, lo escrito sigue en el log de recuperación.
   */
  orphaned: boolean
}

/** Mensaje en vivo para los editores de una nota borrada desde fuera. */
export const ORPHAN_MESSAGE = 'thoth:deleted-externally'
/** Tras cada volcado: `etag` es el hash del texto que ya está en el archivo. La UI lo usa para decir "guardado". */
export const SAVED_MESSAGE = 'thoth:saved'
/** The note was moved or renamed: editors reopen it at `to`. */
export const MOVED_MESSAGE = 'thoth:moved'
/** The note was moved to the trash from thoth: `id` is the entry, to restore it. */
export const TRASHED_MESSAGE = 'thoth:trashed'

export interface HubOptions {
  notesDir: string
  stateDir: string
  indexer: Indexer
  auth: Auth
  debounceMs?: number
  /** Cada cuánto se comprueban los archivos de las notas calientes. */
  checkMs?: number
  uidKey?: string
  log?: (msg: string) => void
}

type Ctx = { user?: User; system?: Actor }

// --- Utilidades ---------------------------------------------------------------

function applyTextDiff(ytext: Y.Text, from: string, to: string) {
  let pos = 0
  for (const [op, chunk] of diff(from, to)) {
    if (op === diff.EQUAL) pos += chunk.length
    else if (op === diff.DELETE) ytext.delete(pos, chunk.length)
    else { ytext.insert(pos, chunk); pos += chunk.length }
  }
}

function diffCost(a: string, b: string) {
  let n = 0
  for (const [op, chunk] of diff(a, b)) if (op !== diff.EQUAL) n += chunk.length
  return n
}

// Log de recuperación: [tipo:1][len:4 BE][payload]. 'S' = snapshot (hash + estado volcado), 'U' = update.
function record(type: 'S' | 'U', payload: Uint8Array): Buffer {
  const head = Buffer.alloc(5)
  head.write(type, 0, 'latin1')
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload])
}
const HASH_LEN = contentHash('').length
const snapshotRecord = (hash: string, update: Uint8Array) => record('S', Buffer.concat([Buffer.from(hash, 'latin1'), update]))

function readLog(file: string): { updates: Uint8Array[]; lastSnapshot: Uint8Array; lastHash: string } | null {
  if (!existsSync(file)) return null
  const buf = readFileSync(file)
  const updates: Uint8Array[] = []
  let lastSnapshot: Uint8Array | null = null
  let lastHash = ''
  let off = 0
  while (off + 5 <= buf.length) {
    const type = buf.toString('latin1', off, off + 1)
    const len = buf.readUInt32BE(off + 1)
    if (off + 5 + len > buf.length) break // registro truncado por una caída
    const payload = buf.subarray(off + 5, off + 5 + len)
    if (type === 'S') {
      lastHash = payload.toString('latin1', 0, HASH_LEN)
      lastSnapshot = payload.subarray(HASH_LEN)
      updates.push(lastSnapshot)
    } else updates.push(payload)
    off += 5 + len
  }
  return lastSnapshot ? { updates, lastSnapshot, lastHash } : null
}

const locks = new Map<string, Promise<unknown>>()
function withLock<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = locks.get(name) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  locks.set(name, next.catch(() => {}))
  return next
}

// --- Hub --------------------------------------------------------------------------

export class CollabHub implements HotDocuments {
  readonly hocuspocus: Hocuspocus<Ctx>
  private hot = new Map<string, Hot>()
  private expected = new Map<string, Set<string>>()
  private opts: HubOptions
  private uidKey: string
  private logDir: string
  private checkTimer: NodeJS.Timeout | null = null
  private wss = new WebSocketServer({ noServer: true })
  private log: (m: string) => void

  constructor(opts: HubOptions) {
    this.opts = opts
    this.uidKey = opts.uidKey ?? 'uid'
    this.logDir = join(opts.stateDir, 'collab')
    this.log = opts.log ?? (() => {})
    mkdirSync(this.logDir, { recursive: true })
    const debounce = opts.debounceMs ?? 1000
    this.hocuspocus = new Hocuspocus<Ctx>({
      name: 'thoth',
      quiet: true,
      debounce,
      maxDebounce: debounce * 10,
      onConnect: async ({ documentName }) => {
        NoteService.checkPath(documentName)
        // A note deleted or moved from thoth is not reopened: a reconnecting editor cannot resurrect it.
        if (this.hot.get(documentName)?.discarded) throw new NoteError('not_found', `does not exist: ${documentName}`)
        if (!this.hot.has(documentName) && readText(this.file(documentName)) === null) {
          throw new NoteError('not_found', `no existe: ${documentName}`)
        }
      },
      onLoadDocument: async ({ documentName, document }) => { await this.load(documentName, document) },
      onStoreDocument: async ({ documentName }) => { await this.flush(documentName) },
      beforeUnloadDocument: async ({ documentName }) => { await this.flush(documentName) },
      afterUnloadDocument: async ({ documentName }) => { await this.unload(documentName) },
    })
  }

  private file(path: string) {
    return join(this.opts.notesDir, NoteService.checkPath(path))
  }

  private logPath(path: string) {
    return join(this.logDir, encodeURIComponent(path) + '.ylog')
  }

  // --- Conexiones -------------------------------------------------------------

  /** Acepta WebSockets en `/collab` de usuarios con sesión y del mismo origen. */
  attach(server: Server, sessionCookie: string) {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      if (url.pathname !== COLLAB_PATH) return
      const origin = req.headers.origin
      if (origin && new URL(origin).host !== req.headers.host) return reject(socket, 403)
      const token = parseCookie(req.headers.cookie ?? '', sessionCookie)
      const user = this.opts.auth.session(token)
      if (!user) return reject(socket, 401)
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const request = new Request(url, { headers: req.headers as Record<string, string> })
        const conn = this.hocuspocus.handleConnection(ws as never, request, { user })
        ws.on('message', (data: Buffer) => conn.handleMessage(new Uint8Array(data)))
        ws.on('close', (code: number, reason: Buffer) => conn.handleClose({ code, reason: reason.toString() }))
      })
    })
    this.checkTimer = setInterval(() => {
      for (const path of this.hot.keys()) this.checkExternal(path).catch((e) => this.log(`comprobación de ${path}: ${e}`))
    }, this.opts.checkMs ?? 1000)
  }

  async close() {
    if (this.checkTimer) clearInterval(this.checkTimer)
    this.hocuspocus.flushPendingStores()
    for (const path of [...this.hot.keys()]) await this.flush(path)
    this.hocuspocus.closeConnections()
    this.wss.close()
  }

  // --- HotDocuments (servicio de notas) -------------------------------------

  /** A discarded note (deleted or moved) no longer counts as open: writes go to the file. */
  has(path: string) {
    const h = this.hot.get(path)
    return !!h && !h.discarded
  }

  /** Edición de una nota caliente: el cambio se aplica como operaciones Yjs y llega a los editores abiertos. */
  async edit(path: string, fn: (text: string) => string, opts: { ifMatch?: string; actor: Actor }): Promise<{ etag: string }> {
    const conn = await this.hocuspocus.openDirectConnection(path, { system: opts.actor })
    let result: { etag: string } | NoteError = { etag: '' }
    try {
      await conn.transact((doc) => {
        const ytext = doc.getText(TEXT)
        const cur = ytext.toString()
        const hash = contentHash(cur)
        if (opts.ifMatch !== undefined && opts.ifMatch !== hash) {
          result = new NoteError('precondition_failed', `la nota ha cambiado: ${path}`, hash)
          return
        }
        const next = fn(cur)
        applyTextDiff(ytext, cur, next)
        result = { etag: contentHash(next) }
      })
    } finally {
      await conn.disconnect()
    }
    if (result instanceof NoteError) throw result
    return result
  }

  /**
   * The note is deleted from thoth: what is pending is flushed (so the trash gets
   * the latest text), it stops being flushed and its sessions are closed. With
   * `trash`, editors are told the trash entry so they can restore it.
   */
  async discard(path: string, opts: { ifMatch?: string; trash?: { id: string; actor: Actor } } = {}) {
    await withLock(path, async () => {
      const h = this.hot.get(path)
      if (!h) return
      await this.flushNow(path, h)
      if (opts.ifMatch !== undefined && !h.orphaned && opts.ifMatch !== h.flushedHash) {
        throw new NoteError('precondition_failed', `the note has changed: ${path}`, h.flushedHash)
      }
      h.discarded = true
      if (opts.trash) {
        const msg = { type: TRASHED_MESSAGE, path, id: opts.trash.id, by: actorName(opts.trash.actor) }
        this.hocuspocus.documents.get(path)?.broadcastStateless(JSON.stringify(msg))
      }
    })
    this.hocuspocus.closeConnections(path)
  }

  /**
   * Moves a hot note. With the document locked, what is pending is flushed and
   * `run` does the move on disk (the file matches the document) and returns the
   * text left at the destination. The note's own changes (rewritten links, uid)
   * are merged into the document, and editors are told to reopen it at the new
   * path. Anything typed during the move is written to the destination: nothing
   * is lost.
   */
  async move<T>(from: string, to: string, run: () => Promise<{ result: T; written: string | null }>): Promise<T> {
    let late: { text: string; base: string } | null = null
    const result = await withLock(from, async () => {
      const h = this.hot.get(from)
      if (!h || h.discarded) return (await run()).result // closed meanwhile: plain move
      await this.flushNow(from, h)
      if (h.orphaned) throw new NoteError('not_found', `does not exist: ${from}`)
      const base = Y.encodeStateAsUpdate(h.doc)
      const text = h.doc.getText(TEXT).toString()
      h.discarded = true
      let r: { result: T; written: string | null }
      try {
        r = await run()
      } catch (err) {
        h.discarded = false
        throw err
      }
      if (r.written !== null && r.written !== text) {
        // Like an external change: from the flushed state, so as not to overwrite what was typed meanwhile.
        const fork = new Y.Doc()
        Y.applyUpdate(fork, base)
        const sv = Y.encodeStateVector(fork)
        fork.transact(() => applyTextDiff(fork.getText(TEXT), text, r.written!))
        Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(fork, sv), 'move')
      }
      this.hocuspocus.documents.get(from)?.broadcastStateless(JSON.stringify({ type: MOVED_MESSAGE, from, to }))
      this.hocuspocus.closeConnections(from)
      const final = h.doc.getText(TEXT).toString()
      if (r.written !== null && final !== r.written) late = { text: final, base: r.written }
      this.log(`${from} moved to ${to} while open`)
      return r.result
    })
    if (late) {
      const { text, base } = late as { text: string; base: string }
      const w = await replaceText(this.file(to), text, contentHash(base))
      if (w.replaced) this.opts.indexer.indexPaths([to])
      else this.log(`${to}: could not write what was typed during the move (the file changed)`)
    }
    return result
  }

  // --- Ciclo de vida ------------------------------------------------------------

  private load(path: string, doc: Y.Doc) {
    return withLock(path, async () => {
      const file = this.file(path)
      const logFile = this.logPath(path)
      const recovered = readLog(logFile)
      const diskOrNull = await readStable(file)
      const disk = diskOrNull ?? ''
      const diskHash = contentHash(disk)
      let snapshot: Uint8Array
      let flushedText: string
      let flushedHash: string
      if (recovered) {
        for (const u of recovered.updates) Y.applyUpdate(doc, u, 'recovery')
        const base = new Y.Doc()
        Y.applyUpdate(base, recovered.lastSnapshot)
        snapshot = recovered.lastSnapshot
        flushedText = base.getText(TEXT).toString()
        flushedHash = recovered.lastHash
        this.log(`recuperado ${path} desde el log (${recovered.updates.length} registros)`)
      } else {
        doc.getText(TEXT).insert(0, disk)
        snapshot = Y.encodeStateAsUpdate(doc)
        flushedText = disk
        flushedHash = diskHash
      }
      const { O_WRONLY, O_CREAT, O_TRUNC, O_APPEND } = constants
      const logFd = openSync(logFile, O_WRONLY | O_CREAT | O_TRUNC | O_APPEND)
      writeSync(logFd, snapshotRecord(flushedHash, snapshot))
      if (recovered) writeSync(logFd, record('U', Y.encodeStateAsUpdate(doc)))
      fsyncSync(logFd)
      const h: Hot = {
        doc, file, logFile, logFd, snapshot, flushedText, flushedHash,
        history: [{ snapshot, text: flushedText, hash: flushedHash }],
        uid: this.uidIn(flushedText), discarded: false, orphaned: false,
      }
      this.hot.set(path, h)
      doc.on('update', (update: Uint8Array) => writeSync(h.logFd, record('U', update)))
      // Un archivo ausente no es "vacío": se borró (con el servidor caído o antes de reabrir).
      if (diskOrNull === null) this.markOrphan(path, h)
      else if (recovered && diskHash !== flushedHash) this.mergeExternal(path, h, disk, diskHash)
    })
  }

  /**
   * Integra en el documento vivo un cambio externo, desde el volcado reciente más
   * parecido. `onDisk`: `newText` es lo que hay ahora en disco (no cuando se rescató
   * de una escritura que nuestro propio rename reemplazó).
   */
  private mergeExternal(path: string, h: Hot, newText: string, newHash: string, onDisk = true) {
    let base = h.history[h.history.length - 1]!
    let best = diffCost(base.text, newText)
    for (const b of h.history) {
      const c = diffCost(b.text, newText)
      if (c < best) { best = c; base = b }
    }
    const fork = new Y.Doc()
    Y.applyUpdate(fork, base.snapshot)
    const sv = Y.encodeStateVector(fork)
    const ftext = fork.getText(TEXT)
    if (ftext.toString() !== base.text) throw new Error('snapshot y texto de la base no coinciden')
    fork.transact(() => applyTextDiff(ftext, base.text, newText))
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(fork, sv), 'external')
    this.log(`cambio externo integrado en ${path}${onDisk ? '' : ' (rescatado del rename)'}`)
    if (!onDisk) return
    h.snapshot = Y.encodeStateAsUpdate(fork)
    h.flushedText = newText
    h.flushedHash = newHash
    this.remember(path, h)
    writeSync(h.logFd, snapshotRecord(newHash, h.snapshot))
  }

  /** Registra el nuevo estado del archivo y avisa a los editores abiertos de que ya está en disco. */
  private remember(path: string, h: Hot) {
    h.history.push({ snapshot: h.snapshot, text: h.flushedText, hash: h.flushedHash })
    if (h.history.length > HISTORY) h.history.shift()
    this.hocuspocus.documents.get(path)?.broadcastStateless(JSON.stringify({ type: SAVED_MESSAGE, path, etag: h.flushedHash }))
  }

  /** Comprueba si el archivo de una nota caliente cambió desde fuera (watcher o comprobación periódica). */
  checkExternal(path: string) {
    return withLock(path, async () => {
      const h = this.hot.get(path)
      if (!h || h.discarded || h.orphaned) return
      const now = readText(h.file)
      if (now === null) {
        // Puede ser un editor a mitad de guardar con rename: se confirma antes de decidir.
        if ((await readStable(h.file)) === null) this.markOrphan(path, h)
        return
      }
      if (contentHash(now) === h.flushedHash) return
      const text = await readStable(h.file, h.flushedText)
      if (text === null) return
      const hash = contentHash(text)
      if (hash === h.flushedHash || this.expected.get(path)?.has(hash)) return
      this.mergeExternal(path, h, text, hash)
    })
  }

  flush(path: string) {
    return withLock(path, async () => {
      const h = this.hot.get(path)
      if (h) await this.flushNow(path, h)
    })
  }

  /** Writes the document to the file. Only with the note's lock held. */
  private async flushNow(path: string, h: Hot) {
    if (h.discarded || h.orphaned) return
    const now = readText(h.file)
    if (now === null && (await readStable(h.file)) === null) {
      this.markOrphan(path, h)
      return
    }
    if (now !== null && contentHash(now) !== h.flushedHash) {
      const disk = await readStable(h.file, h.flushedText)
      if (disk !== null) {
        const dh = contentHash(disk)
        if (dh !== h.flushedHash && !this.expected.get(path)?.has(dh)) this.mergeExternal(path, h, disk, dh)
      }
    }
    for (let attempt = 0; ; attempt++) {
      if (attempt > 5) throw new Error(`too many races in a row on ${path}`)
      this.ensureUid(h)
      // Text and snapshot together, before any await.
      const text = h.doc.getText(TEXT).toString()
      if (text === h.flushedText && readText(h.file) !== null) return
      const snap = Y.encodeStateAsUpdate(h.doc)
      const hash = contentHash(text)
      let set = this.expected.get(path)
      if (!set) this.expected.set(path, (set = new Set()))
      set.add(hash)
      const r = await replaceText(h.file, text, h.flushedHash)
      if (!r.replaced) {
        const disk = await readStable(h.file, h.flushedText)
        if (disk === null) { this.markOrphan(path, h); return }
        this.log(`race with an external write on ${path} (before the rename)`)
        this.mergeExternal(path, h, disk, contentHash(disk))
        continue
      }
      h.snapshot = snap
      h.flushedText = text
      h.flushedHash = hash
      this.remember(path, h)
      ftruncateSync(h.logFd, 0)
      writeSync(h.logFd, snapshotRecord(hash, snap))
      if (text !== h.doc.getText(TEXT).toString()) {
        writeSync(h.logFd, record('U', Y.encodeStateAsUpdate(h.doc, Y.encodeStateVectorFromUpdate(snap))))
      }
      fsyncSync(h.logFd)
      this.opts.indexer.indexPaths([path])
      if (r.rescued === null) return
      this.mergeExternal(path, h, r.rescued, contentHash(r.rescued), false)
    }
  }

  private unload(path: string) {
    return withLock(path, () => {
      const h = this.hot.get(path)
      if (!h) return
      closeSync(h.logFd)
      // Una huérfana sin decidir conserva su log: es la copia de lo que se estaba escribiendo.
      if (h.discarded || (!h.orphaned && h.doc.getText(TEXT).toString() === h.flushedText)) rmSync(h.logFile, { force: true })
      this.hot.delete(path)
      this.expected.delete(path)
    })
  }

  private markOrphan(path: string, h: Hot) {
    if (h.orphaned) return
    h.orphaned = true
    this.log(`${path} se ha borrado fuera de thoth con la nota abierta: no se escribe hasta que alguien decida`)
    this.hocuspocus.documents.get(path)?.broadcastStateless(JSON.stringify({ type: ORPHAN_MESSAGE, path }))
  }

  /** Notas borradas desde fuera con una copia pendiente de decisión (abiertas o solo en el log). */
  orphans(): string[] {
    const out = new Set<string>()
    for (const [path, h] of this.hot) if (h.orphaned && !h.discarded) out.add(path)
    for (const f of readdirSync(this.logDir).filter((x) => x.endsWith('.ylog'))) {
      const path = decodeURIComponent(f.slice(0, -'.ylog'.length))
      if (!this.hot.has(path) && readText(this.file(path)) === null) out.add(path)
    }
    return [...out].sort()
  }

  /** Conserva la copia: vuelve a crear el archivo con lo que se estaba escribiendo. */
  async restoreOrphan(path: string): Promise<{ etag: string }> {
    if (!this.orphans().includes(path)) throw new NoteError('not_found', `no hay ninguna copia pendiente de ${path}`)
    const conn = await this.hocuspocus.openDirectConnection(path, { system: { kind: 'system', reason: 'conservar copia de una nota borrada fuera' } })
    try {
      return await withLock(path, async () => {
        const h = this.hot.get(path)!
        const text = h.doc.getText(TEXT).toString()
        mkdirSync(dirname(h.file), { recursive: true })
        const r = await replaceText(h.file, text, null)
        if (!r.replaced) throw new NoteError('exists', `ya existe otra nota en ${path}`)
        h.orphaned = false
        h.snapshot = Y.encodeStateAsUpdate(h.doc)
        h.flushedText = text
        h.flushedHash = contentHash(text)
        this.remember(path, h)
        this.opts.indexer.indexPaths([path])
        this.hocuspocus.documents.get(path)?.broadcastStateless(JSON.stringify({ type: 'thoth:orphan-resolved', path, action: 'restore' }))
        this.log(`${path}: se conserva la copia abierta`)
        return { etag: h.flushedHash }
      })
    } finally {
      await conn.disconnect()
    }
  }

  /** Descarta la copia: el borrado externo se da por bueno. */
  async discardOrphan(path: string) {
    if (!this.orphans().includes(path)) throw new NoteError('not_found', `no hay ninguna copia pendiente de ${path}`)
    this.hocuspocus.documents.get(path)?.broadcastStateless(JSON.stringify({ type: 'thoth:orphan-resolved', path, action: 'discard' }))
    if (this.hot.has(path)) await this.discard(path)
    else rmSync(this.logPath(path), { force: true })
    this.log(`${path}: se descarta la copia; el borrado externo se da por bueno`)
  }

  /** Al arrancar: cada log pendiente es una nota con ediciones sin volcar. */
  async recoverAll() {
    for (const f of readdirSync(this.logDir).filter((x) => x.endsWith('.ylog'))) {
      const path = decodeURIComponent(f.slice(0, -'.ylog'.length))
      try {
        const conn = await this.hocuspocus.openDirectConnection(path, { system: { kind: 'system', reason: 'recuperación tras una caída' } })
        await conn.disconnect()
      } catch (err) {
        this.log(`no se pudo recuperar ${path}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // --- uid (D-015): se añade al volcar si la nota no lo tiene --------------------

  private uidIn(text: string): string | null {
    const fm = readFrontmatter(text)
    const v = fm.error ? null : fm.data[this.uidKey]
    return typeof v === 'string' || typeof v === 'number' ? String(v) : null
  }

  private ensureUid(h: Hot) {
    const ytext = h.doc.getText(TEXT)
    const cur = ytext.toString()
    if (cur === h.flushedText || this.uidIn(cur) || readFrontmatter(cur).error) return
    h.uid ??= newUid()
    const next = setFrontmatterKey(cur, this.uidKey, h.uid)
    h.doc.transact(() => applyTextDiff(ytext, cur, next), 'uid')
  }
}

function actorName(a: Actor): string {
  return a.kind === 'user' ? a.id : a.kind === 'agent' ? a.id : 'system'
}

function parseCookie(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return undefined
}

function reject(socket: Duplex, status: 401 | 403) {
  socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}
