// Servicio de notas: el único punto de escritura del sistema (UI, API y MCP
// pasan por aquí). Concurrencia optimista por hash, escritura segura
// (fsutil.ts), `uid` perezoso (D-015) y borrado a papelera.
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { classifyPath, contentHash, newUid, readFrontmatter, setFrontmatterKey } from '@thoth/core'
import { commitText, readStable, readText } from './fsutil.ts'
import type { Indexer } from './indexer.ts'
import type { Db } from './db.ts'

/** Quién hace un cambio. Se registrará en el historial (M2). */
export type Actor =
  | { kind: 'user'; id: string }
  | { kind: 'agent'; id: string; onBehalfOf: string }
  | { kind: 'system'; reason: string }

export type NoteErrorCode = 'not_found' | 'exists' | 'precondition_failed' | 'invalid_path'

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
