// Collaboration hub: hot notes as Yjs documents over the file's text. The file
// is still the source of truth; the document is a cache that exists while
// someone has the note open.
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
  /** Document state that matches what's on disk. */
  snapshot: Uint8Array
  flushedText: string
  flushedHash: string
  /** Last flushed states: an external editor may save starting from an old one. */
  history: Base[]
  /** uid the note had when loaded, so it isn't lost if it's removed in the editor. */
  uid: string | null
  /** The note was deleted from thoth: it's no longer flushed. */
  discarded: boolean
  /**
   * The file was deleted from outside while the note was open. Nothing is
   * written to disk until someone decides to keep or discard its copy;
   * meanwhile, what was written stays in the recovery log.
   */
  orphaned: boolean
}

/** Live message for editors of a note deleted from outside. */
export const ORPHAN_MESSAGE = 'thoth:deleted-externally'
/** After every flush: `etag` is the hash of the text already on the file. The UI uses it to say "saved". */
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
  /** How often hot notes' files are checked. */
  checkMs?: number
  uidKey?: string
  log?: (msg: string) => void
}

type Ctx = { user?: User; system?: Actor }

// --- Utilities ---------------------------------------------------------------

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

// Recovery log: [type:1][len:4 BE][payload]. 'S' = snapshot (hash + flushed state), 'U' = update.
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
    if (off + 5 + len > buf.length) break // record truncated by a crash
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
          throw new NoteError('not_found', `does not exist: ${documentName}`)
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

  // --- Connections -------------------------------------------------------------

  /** Accepts WebSockets on `/collab` from users with a session and the same origin. */
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
      for (const path of this.hot.keys()) this.checkExternal(path).catch((e) => this.log(`check of ${path}: ${e}`))
    }, this.opts.checkMs ?? 1000)
  }

  async close() {
    if (this.checkTimer) clearInterval(this.checkTimer)
    this.hocuspocus.flushPendingStores()
    for (const path of [...this.hot.keys()]) await this.flush(path)
    this.hocuspocus.closeConnections()
    this.wss.close()
  }

  // --- HotDocuments (note service) -------------------------------------

  /** A discarded note (deleted or moved) no longer counts as open: writes go to the file. */
  has(path: string) {
    const h = this.hot.get(path)
    return !!h && !h.discarded
  }

  /** Edit of a hot note: the change is applied as Yjs operations and reaches the open editors. */
  async edit(path: string, fn: (text: string) => string, opts: { ifMatch?: string; actor: Actor }): Promise<{ etag: string }> {
    const conn = await this.hocuspocus.openDirectConnection(path, { system: opts.actor })
    let result: { etag: string } | NoteError = { etag: '' }
    try {
      await conn.transact((doc) => {
        const ytext = doc.getText(TEXT)
        const cur = ytext.toString()
        const hash = contentHash(cur)
        if (opts.ifMatch !== undefined && opts.ifMatch !== hash) {
          result = new NoteError('precondition_failed', `the note has changed: ${path}`, hash)
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

  // --- Lifecycle ------------------------------------------------------------

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
        this.log(`recovered ${path} from the log (${recovered.updates.length} records)`)
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
      // A missing file isn't "empty": it was deleted (server down, or before reopening).
      if (diskOrNull === null) this.markOrphan(path, h)
      else if (recovered && diskHash !== flushedHash) this.mergeExternal(path, h, disk, diskHash)
    })
  }

  /**
   * Integrates an external change into the live document, from the closest
   * recent flush. `onDisk`: `newText` is what's now on disk (not when it was
   * rescued from a write that our own rename overwrote).
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
    if (ftext.toString() !== base.text) throw new Error('snapshot and base text do not match')
    fork.transact(() => applyTextDiff(ftext, base.text, newText))
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(fork, sv), 'external')
    this.log(`external change integrated into ${path}${onDisk ? '' : ' (rescued from the rename)'}`)
    if (!onDisk) return
    h.snapshot = Y.encodeStateAsUpdate(fork)
    h.flushedText = newText
    h.flushedHash = newHash
    this.remember(path, h)
    writeSync(h.logFd, snapshotRecord(newHash, h.snapshot))
  }

  /** Records the file's new state and tells the open editors it's now on disk. */
  private remember(path: string, h: Hot) {
    h.history.push({ snapshot: h.snapshot, text: h.flushedText, hash: h.flushedHash })
    if (h.history.length > HISTORY) h.history.shift()
    this.hocuspocus.documents.get(path)?.broadcastStateless(JSON.stringify({ type: SAVED_MESSAGE, path, etag: h.flushedHash }))
  }

  /** Checks whether a hot note's file changed from outside (watcher or periodic check). */
  checkExternal(path: string) {
    return withLock(path, async () => {
      const h = this.hot.get(path)
      if (!h || h.discarded || h.orphaned) return
      const now = readText(h.file)
      if (now === null) {
        // Could be an editor mid-save via rename: confirmed before deciding.
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
      // An undecided orphan keeps its log: it's the copy of what was being written.
      if (h.discarded || (!h.orphaned && h.doc.getText(TEXT).toString() === h.flushedText)) rmSync(h.logFile, { force: true })
      this.hot.delete(path)
      this.expected.delete(path)
    })
  }

  private markOrphan(path: string, h: Hot) {
    if (h.orphaned) return
    h.orphaned = true
    this.log(`${path} was deleted outside thoth while the note was open: nothing is written until someone decides`)
    this.hocuspocus.documents.get(path)?.broadcastStateless(JSON.stringify({ type: ORPHAN_MESSAGE, path }))
  }

  /** Notes deleted from outside with a copy pending a decision (open, or only in the log). */
  orphans(): string[] {
    const out = new Set<string>()
    for (const [path, h] of this.hot) if (h.orphaned && !h.discarded) out.add(path)
    for (const f of readdirSync(this.logDir).filter((x) => x.endsWith('.ylog'))) {
      const path = decodeURIComponent(f.slice(0, -'.ylog'.length))
      if (!this.hot.has(path) && readText(this.file(path)) === null) out.add(path)
    }
    return [...out].sort()
  }

  /** Keeps the copy: recreates the file with what was being written. */
  async restoreOrphan(path: string): Promise<{ etag: string }> {
    if (!this.orphans().includes(path)) throw new NoteError('not_found', `no pending copy for ${path}`)
    const conn = await this.hocuspocus.openDirectConnection(path, { system: { kind: 'system', reason: 'keep the copy of a note deleted outside' } })
    try {
      return await withLock(path, async () => {
        const h = this.hot.get(path)!
        const text = h.doc.getText(TEXT).toString()
        mkdirSync(dirname(h.file), { recursive: true })
        const r = await replaceText(h.file, text, null)
        if (!r.replaced) throw new NoteError('exists', `another note already exists at ${path}`)
        h.orphaned = false
        h.snapshot = Y.encodeStateAsUpdate(h.doc)
        h.flushedText = text
        h.flushedHash = contentHash(text)
        this.remember(path, h)
        this.opts.indexer.indexPaths([path])
        this.hocuspocus.documents.get(path)?.broadcastStateless(JSON.stringify({ type: 'thoth:orphan-resolved', path, action: 'restore' }))
        this.log(`${path}: the open copy is kept`)
        return { etag: h.flushedHash }
      })
    } finally {
      await conn.disconnect()
    }
  }

  /** Discards the copy: the external deletion is accepted as final. */
  async discardOrphan(path: string) {
    if (!this.orphans().includes(path)) throw new NoteError('not_found', `no pending copy for ${path}`)
    this.hocuspocus.documents.get(path)?.broadcastStateless(JSON.stringify({ type: 'thoth:orphan-resolved', path, action: 'discard' }))
    if (this.hot.has(path)) await this.discard(path)
    else rmSync(this.logPath(path), { force: true })
    this.log(`${path}: copy discarded; the external deletion is accepted as final`)
  }

  /** On startup: every pending log is a note with unflushed edits. */
  async recoverAll() {
    for (const f of readdirSync(this.logDir).filter((x) => x.endsWith('.ylog'))) {
      const path = decodeURIComponent(f.slice(0, -'.ylog'.length))
      try {
        const conn = await this.hocuspocus.openDirectConnection(path, { system: { kind: 'system', reason: 'recovery after a crash' } })
        await conn.disconnect()
      } catch (err) {
        this.log(`could not recover ${path}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // --- uid: added on flush if the note doesn't have one --------------------

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
