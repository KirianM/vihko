// Servicio de notas: el único punto de escritura del sistema (UI, API y MCP
// pasan por aquí). Concurrencia optimista por hash, escritura segura
// (fsutil.ts), `uid` perezoso (D-015) y borrado a papelera.
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { addToFrontmatterList, classifyPath, contentHash, newUid, normKey, pathKeys, readFrontmatter, setFrontmatterKey } from '@thoth/core'
import { commitText, readStable, readText } from './fsutil.ts'
import { applyReplacements, keptLinks, planRelinks, type Replacement } from './relink.ts'
import type { Indexer } from './indexer.ts'
import type { Db } from './db.ts'

/** Quién hace un cambio. Se registrará en el historial (M2). */
export type Actor =
  | { kind: 'user'; id: string }
  | { kind: 'agent'; id: string; onBehalfOf: string }
  | { kind: 'system'; reason: string }

export type NoteErrorCode = 'not_found' | 'exists' | 'precondition_failed' | 'invalid_path' | 'edit_mismatch'

export class NoteError extends Error {
  readonly code: NoteErrorCode
  /** ETag actual cuando la precondición falla, para reintentar sin releer. */
  readonly etag: string | null
  constructor(code: NoteErrorCode, message: string, etag: string | null = null) {
    super(message)
    this.code = code
    this.etag = etag
  }
}

export interface NoteRead {
  path: string
  text: string
  etag: string
}

/** Documentos abiertos en el editor colaborativo (D-012). Lo implementará el hub. */
export interface HotDocuments {
  has(path: string): boolean
  edit(path: string, fn: (text: string) => string, opts: { ifMatch?: string; actor: Actor }): Promise<{ etag: string }>
  /** La nota se borra: cerrar sus sesiones de edición sin volver a volcarla. */
  discard(path: string): Promise<void>
}

export interface NoteServiceOptions {
  notesDir: string
  /** Volumen de estado (disco local): aquí vive la papelera. */
  stateDir: string
  indexer: Indexer
  db: Db
  uidKey?: string
  hot?: HotDocuments
}

export interface MoveReport {
  from: string
  to: string
  /**
   * Notes whose links are rewritten (or would be, in dryRun): number of links and
   * each change, text before and after.
   */
  relinked: { path: string; links: number; changes: { before: string; after: string }[] }[]
  /** Links to the note that keep working untouched: through an alias (`via: 'alias'`) or by name or path. */
  kept: { path: string; raw: string; via: 'path' | 'alias' }[]
  /** Notas que no se pudieron reescribir. */
  failed: { path: string; reason: string }[]
  /** Se añadió el nombre antiguo como alias porque alguna reescritura falló (D-018). */
  aliasAdded: string | null
  dryRun: boolean
}

export interface TrashEntry {
  id: string
  path: string
  deletedAt: string
  actor: Actor
  etag: string
}

export class NoteService {
  private opts: NoteServiceOptions
  private uidKey: string

  constructor(opts: NoteServiceOptions) {
    this.opts = opts
    this.uidKey = opts.uidKey ?? 'uid'
  }

  /** Valida una ruta de nota: relativa, sin `..`, sin segmentos ocultos, terminada en `.md`. */
  static checkPath(path: string): string {
    if (typeof path !== 'string' || path === '') throw new NoteError('invalid_path', `invalid note path: ${String(path)}`)
    const norm = posix.normalize(path)
    if (path !== norm || path.startsWith('/') || norm.split('/').includes('..') || classifyPath(norm) !== 'note') {
      throw new NoteError('invalid_path', `ruta de nota no válida: ${path}`)
    }
    return norm
  }

  private file(path: string) {
    return join(this.opts.notesDir, NoteService.checkPath(path))
  }

  /** Ruta de la nota con ese uid (si hay varias, es un conflicto de identidad: se rechaza). */
  pathOfUid(uid: string): string {
    const rows = this.opts.db.prepare('select path from notes where uid = ?').all(uid) as { path: string }[]
    if (rows.length === 0) throw new NoteError('not_found', `no hay ninguna nota con uid ${uid}`)
    if (rows.length > 1) throw new NoteError('not_found', `uid ${uid} duplicado en ${rows.map((r) => r.path).join(', ')}`)
    return rows[0]!.path
  }

  read(path: string): NoteRead {
    const text = readText(this.file(path))
    if (text === null) throw new NoteError('not_found', `no existe: ${path}`)
    return { path, text, etag: contentHash(text) }
  }

  /** Crea una nota nueva; nunca sobrescribe. Nace con `uid` (D-015). */
  async create(path: string, text: string, _actor: Actor): Promise<{ path: string; etag: string; uid: string | null }> {
    const file = this.file(path)
    mkdirSync(dirname(file), { recursive: true })
    const withUid = this.ensureUid(text, null)
    const r = await commitText(file, withUid.text, null)
    if (!r.ok) throw new NoteError('exists', `ya existe: ${path}`, r.current === null ? null : contentHash(r.current))
    this.opts.indexer.indexPaths([path])
    return { path, etag: contentHash(withUid.text), uid: withUid.uid }
  }

  /** Sustituye el contenido entero. `ifMatch` es obligatorio: no se pisa lo que no se ha leído. */
  async write(path: string, text: string, opts: { ifMatch: string; actor: Actor }): Promise<{ etag: string }> {
    return this.edit(path, () => text, opts)
  }

  /**
   * Aplica `fn` sobre el contenido actual. Con `ifMatch`, solo si la nota no ha
   * cambiado desde que se leyó. Si la nota no tenía `uid`, lo recibe en esta
   * misma escritura; si lo tenía, se conserva aunque el nuevo texto lo omita.
   */
  async edit(path: string, fn: (text: string) => string, opts: { ifMatch?: string; actor: Actor }): Promise<{ etag: string }> {
    const hot = this.opts.hot
    if (hot?.has(path)) return hot.edit(path, fn, opts)
    const file = this.file(path)
    const current = await readStable(file)
    if (current === null) throw new NoteError('not_found', `no existe: ${path}`)
    const currentHash = contentHash(current)
    if (opts.ifMatch !== undefined && opts.ifMatch !== currentHash) {
      throw new NoteError('precondition_failed', `la nota ha cambiado: ${path}`, currentHash)
    }
    const oldUid = this.uidIn(current)
    const next = this.ensureUid(fn(current), oldUid).text
    if (next === current) return { etag: currentHash }
    const r = await commitText(file, next, currentHash)
    if (!r.ok) {
      throw new NoteError('precondition_failed', `la nota cambió durante la escritura: ${path}`, r.current === null ? null : contentHash(r.current))
    }
    this.opts.indexer.indexPaths([path])
    return { etag: contentHash(next) }
  }

  /** Mueve la nota a la papelera del volumen de estado. */
  async delete(path: string, opts: { ifMatch?: string; actor: Actor }): Promise<TrashEntry> {
    const file = this.file(path)
    if (this.opts.hot?.has(path)) await this.opts.hot.discard(path)
    const current = await readStable(file)
    if (current === null) throw new NoteError('not_found', `no existe: ${path}`)
    const hash = contentHash(current)
    if (opts.ifMatch !== undefined && opts.ifMatch !== hash) throw new NoteError('precondition_failed', `la nota ha cambiado: ${path}`, hash)

    // Primero se aparta dentro del mismo sistema de archivos (rename atómico) y se
    // comprueba que lo apartado es lo que se quería borrar.
    const aside = join(dirname(file), `.${posix.basename(path)}.thoth-del-${process.pid}-${Date.now()}`)
    renameSync(file, aside)
    const moved = readText(aside)
    if (moved === null || contentHash(moved) !== hash) {
      renameSync(aside, file)
      throw new NoteError('precondition_failed', `la nota cambió durante el borrado: ${path}`, moved === null ? null : contentHash(moved))
    }
    const entry: TrashEntry = { id: newUid(), path, deletedAt: new Date().toISOString(), actor: opts.actor, etag: hash }
    const dir = join(this.opts.stateDir, 'trash', entry.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'note.md'), moved)
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(entry, null, 2))
    rmSync(aside)
    this.opts.indexer.indexPaths([path])
    return entry
  }

  /**
   * Mueve o renombra una nota y reescribe los enlaces necesarios para que ninguno
   * cambie de destino (D-018). Las reescrituras las hace el sistema en nombre de
   * quien renombra. Con `dryRun`, solo informa de lo que haría.
   */
  async move(from: string, to: string, opts: { ifMatch?: string; actor: Actor; dryRun?: boolean }): Promise<MoveReport> {
    const fromFile = this.file(from)
    const toFile = this.file(to)
    if (this.opts.hot?.has(from)) throw new NoteError('precondition_failed', `la nota está abierta en el editor: ${from}`)
    const text = await readStable(fromFile)
    if (text === null) throw new NoteError('not_found', `no existe: ${from}`)
    if (readText(toFile) !== null) throw new NoteError('exists', `ya existe: ${to}`)
    const hash = contentHash(text)
    if (opts.ifMatch !== undefined && opts.ifMatch !== hash) throw new NoteError('precondition_failed', `la nota ha cambiado: ${from}`, hash)

    // Estado de resolución antes y después del movimiento.
    this.opts.indexer.indexPaths([from])
    // Copias congeladas: el índice vivo cambia en cuanto se reindexa durante la ejecución.
    const before = this.opts.indexer.links.clone()
    const after = before.clone()
    const keys = before.get(from) ?? { path: from }
    after.delete(from)
    after.set({ ...keys, path: to })
    const map = (p: string) => (p === from ? to : p)

    // Notas que pueden verse afectadas: la movida, las que enlazan a ella y las que
    // buscan alguna de sus claves (un nombre igual más cercano "robaría" el enlace).
    const affected = [...pathKeys(from), ...pathKeys(to), ...(keys.aliases ?? []).map(normKey)]
    const sources = new Set<string>([from])
    for (const r of this.opts.db.prepare('select distinct src_path from links where dst_path = ?').all(from) as { src_path: string }[]) sources.add(r.src_path)
    const byKey = this.opts.db.prepare('select distinct src_path from links where key = ?')
    for (const k of affected) for (const r of byKey.all(k) as { src_path: string }[]) sources.add(r.src_path)

    const report: MoveReport = { from, to, relinked: [], kept: [], failed: [], aliasAdded: null, dryRun: !!opts.dryRun }
    const changes = (t: string, reps: Replacement[]) => reps.map((r) => ({ before: t.slice(r.from, r.to), after: r.text }))
    const movedReps = planRelinks(text, from, to, before, after, map)
    if (movedReps.length) report.relinked.push({ path: to, links: movedReps.length, changes: changes(text, movedReps) })
    const others: string[] = []
    for (const src of [...sources].filter((p) => p !== from).sort()) {
      const t = readText(this.file(src))
      if (t === null) continue
      const reps = planRelinks(t, src, src, before, after, map)
      if (reps.length) { report.relinked.push({ path: src, links: reps.length, changes: changes(t, reps) }); others.push(src) }
      for (const k of keptLinks(t, src, before, after, from, to)) report.kept.push({ path: src, ...k })
    }
    if (opts.dryRun) return report

    // 1. La nota movida: se crea en destino (sin pisar) y se retira el origen si no cambió.
    const newText = this.ensureUid(applyReplacements(text, movedReps), this.uidIn(text)).text
    mkdirSync(dirname(toFile), { recursive: true })
    const created = await commitText(toFile, newText, null)
    if (!created.ok) throw new NoteError('exists', `ya existe: ${to}`)
    const aside = join(dirname(fromFile), `.${posix.basename(from)}.thoth-mv-${process.pid}-${Date.now()}`)
    try {
      renameSync(fromFile, aside)
    } catch (err) {
      // Sin esto quedaría la nota duplicada: se deshace la creación en destino.
      rmSync(toFile, { force: true })
      throw err
    }
    const moved = readText(aside)
    if (moved === null || contentHash(moved) !== hash) {
      renameSync(aside, fromFile)
      rmSync(toFile, { force: true })
      throw new NoteError('precondition_failed', `la nota cambió durante el movimiento: ${from}`, moved === null ? null : contentHash(moved))
    }
    rmSync(aside)
    this.opts.indexer.indexPaths([from, to])

    // 2. El resto de notas, como sistema. El plan se recalcula sobre el texto actual.
    const system: Actor = { kind: 'system', reason: `renombrado de ${from} a ${to} por ${actorLabel(opts.actor)}` }
    for (const src of others) {
      try {
        await this.edit(src, (t) => applyReplacements(t, planRelinks(t, src, src, before, after, map)), { actor: system })
      } catch (err) {
        report.failed.push({ path: src, reason: err instanceof Error ? err.message : String(err) })
      }
    }

    // 3. Red de seguridad: si algo no se pudo reescribir, el nombre antiguo queda como alias.
    const oldName = posix.basename(from).replace(/\.md$/i, '')
    const newName = posix.basename(to).replace(/\.md$/i, '')
    if (report.failed.length && oldName !== newName) {
      try {
        await this.edit(to, (t) => addToFrontmatterList(t, 'aliases', oldName), { actor: system })
        report.aliasAdded = oldName
      } catch (err) {
        report.failed.push({ path: to, reason: `no se pudo añadir el alias: ${err instanceof Error ? err.message : String(err)}` })
      }
    }
    return report
  }

  trash(): TrashEntry[] {
    const root = join(this.opts.stateDir, 'trash')
    let ids: string[]
    try { ids = readdirSync(root) } catch { return [] }
    return ids.sort().reverse().map((id) => JSON.parse(readText(join(root, id, 'meta.json'))!) as TrashEntry)
  }

  /** Restaura desde la papelera a su ruta original (o a `to`). Nunca sobrescribe. */
  async restore(id: string, _actor: Actor, to?: string): Promise<{ path: string; etag: string }> {
    const dir = join(this.opts.stateDir, 'trash', id)
    const meta = readText(join(dir, 'meta.json'))
    if (meta === null) throw new NoteError('not_found', `no está en la papelera: ${id}`)
    const entry = JSON.parse(meta) as TrashEntry
    const text = readText(join(dir, 'note.md'))!
    const path = to ?? entry.path
    const file = this.file(path)
    mkdirSync(dirname(file), { recursive: true })
    const r = await commitText(file, text, null)
    if (!r.ok) throw new NoteError('exists', `ya existe: ${path}`)
    rmSync(dir, { recursive: true })
    this.opts.indexer.indexPaths([path])
    return { path, etag: contentHash(text) }
  }

  private uidIn(text: string): string | null {
    const fm = readFrontmatter(text)
    const v = fm.error ? null : fm.data[this.uidKey]
    return typeof v === 'string' || typeof v === 'number' ? String(v) : null
  }

  /** Añade `uid` (el anterior si lo había, o uno nuevo) si el texto no lo tiene y el frontmatter es válido. */
  private ensureUid(text: string, previous: string | null): { text: string; uid: string | null } {
    const existing = this.uidIn(text)
    if (existing) return { text, uid: existing }
    if (readFrontmatter(text).error) return { text, uid: null } // YAML roto: se escribe tal cual, sin tocarlo
    const uid = previous ?? newUid()
    return { text: setFrontmatterKey(text, this.uidKey, uid), uid }
  }
}

function actorLabel(a: Actor): string {
  return a.kind === 'user' ? a.id : a.kind === 'agent' ? `${a.id} (en nombre de ${a.onBehalfOf})` : `sistema: ${a.reason}`
}
