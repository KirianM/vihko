// Note service: the system's only write point (UI, API and MCP all go
// through here). Optimistic concurrency by hash, safe writes
// (fsutil.ts), lazy `uid` and deletion to trash.
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { addToFrontmatterList, classifyPath, contentHash, newUid, normKey, pathKeys, readFrontmatter, setFrontmatterKey, type ErrorCode } from '@thoth/core'
import { commitText, readStable, readText } from './fsutil.ts'
import { applyReplacements, keptLinks, planRelinks, type Replacement } from './relink.ts'
import type { Indexer } from './indexer.ts'
import type { Db } from './db.ts'

/** Who makes a change. Will be recorded in history (M2). */
export type Actor =
  | { kind: 'user'; id: string }
  | { kind: 'agent'; id: string; onBehalfOf: string }
  | { kind: 'system'; reason: string }

export type NoteErrorCode = 'not_found' | 'exists' | 'precondition_failed' | 'invalid_path' | 'edit_mismatch'

export class NoteError extends Error {
  readonly code: NoteErrorCode
  /** Current ETag when the precondition fails, to retry without re-reading. */
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

/** Documents open in the collaborative editor. The hub will implement this. */
export interface HotDocuments {
  has(path: string): boolean
  edit(path: string, fn: (text: string) => string, opts: { ifMatch?: string; actor: Actor }): Promise<{ etag: string }>
  /**
   * The note is deleted: flush what is pending, close its sessions and never
   * flush it again. With `trash`, its editors are told the trash entry.
   */
  discard(path: string, opts?: { ifMatch?: string; trash?: { id: string; actor: Actor } }): Promise<void>
  /**
   * The note is moved while open: `run` does the move on disk with the note
   * flushed and locked, and returns the text left at the destination.
   */
  move<T>(from: string, to: string, run: () => Promise<{ result: T; written: string | null }>): Promise<T>
}

export interface NoteServiceOptions {
  notesDir: string
  /** State volume (local disk): the trash lives here. */
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
  /**
   * Notes that couldn't be rewritten (or the moved note itself, if the alias
   * couldn't be added): an error code for the UI and a hint for developers.
   */
  failed: { path: string; error: ErrorCode; message: string }[]
  /** The old name was added as an alias because some rewrite failed: the links left behind still resolve. */
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

  /** Validates a note path: relative, no `..`, no hidden segments, ending in `.md`. */
  static checkPath(path: string): string {
    if (typeof path !== 'string' || path === '') throw new NoteError('invalid_path', `invalid note path: ${String(path)}`)
    const norm = posix.normalize(path)
    if (path !== norm || path.startsWith('/') || norm.split('/').includes('..') || classifyPath(norm) !== 'note') {
      throw new NoteError('invalid_path', `invalid note path: ${path}`)
    }
    return norm
  }

  private file(path: string) {
    return join(this.opts.notesDir, NoteService.checkPath(path))
  }

  /** Path of the note with that uid (if there are several, it's an identity conflict: rejected). */
  pathOfUid(uid: string): string {
    const rows = this.opts.db.prepare('select path from notes where uid = ?').all(uid) as { path: string }[]
    if (rows.length === 0) throw new NoteError('not_found', `no note with uid ${uid}`)
    if (rows.length > 1) throw new NoteError('not_found', `duplicate uid ${uid} in ${rows.map((r) => r.path).join(', ')}`)
    return rows[0]!.path
  }

  read(path: string): NoteRead {
    const text = readText(this.file(path))
    if (text === null) throw new NoteError('not_found', `does not exist: ${path}`)
    return { path, text, etag: contentHash(text) }
  }

  /** Creates a new note; never overwrites. Born with a `uid`. */
  async create(path: string, text: string, _actor: Actor): Promise<{ path: string; etag: string; uid: string | null }> {
    const file = this.file(path)
    mkdirSync(dirname(file), { recursive: true })
    const withUid = this.ensureUid(text, null)
    const r = await commitText(file, withUid.text, null)
    if (!r.ok) throw new NoteError('exists', `already exists: ${path}`, r.current === null ? null : contentHash(r.current))
    this.opts.indexer.indexPaths([path])
    return { path, etag: contentHash(withUid.text), uid: withUid.uid }
  }

  /** Replaces the entire content. `ifMatch` is mandatory: what hasn't been read isn't overwritten. */
  async write(path: string, text: string, opts: { ifMatch: string; actor: Actor }): Promise<{ etag: string }> {
    return this.edit(path, () => text, opts)
  }

  /**
   * Applies `fn` to the current content. With `ifMatch`, only if the note
   * hasn't changed since it was read. If the note had no `uid`, it gets one in
   * this same write; if it had one, it's kept even if the new text omits it.
   */
  async edit(path: string, fn: (text: string) => string, opts: { ifMatch?: string; actor: Actor }): Promise<{ etag: string }> {
    const hot = this.opts.hot
    if (hot?.has(path)) return hot.edit(path, fn, opts)
    const file = this.file(path)
    const current = await readStable(file)
    if (current === null) throw new NoteError('not_found', `does not exist: ${path}`)
    const currentHash = contentHash(current)
    if (opts.ifMatch !== undefined && opts.ifMatch !== currentHash) {
      throw new NoteError('precondition_failed', `the note has changed: ${path}`, currentHash)
    }
    const oldUid = this.uidIn(current)
    const next = this.ensureUid(fn(current), oldUid).text
    if (next === current) return { etag: currentHash }
    const r = await commitText(file, next, currentHash)
    if (!r.ok) {
      throw new NoteError('precondition_failed', `the note changed during the write: ${path}`, r.current === null ? null : contentHash(r.current))
    }
    this.opts.indexer.indexPaths([path])
    return { etag: contentHash(next) }
  }

  /** Moves the note to the state volume's trash. */
  async delete(path: string, opts: { ifMatch?: string; actor: Actor }): Promise<TrashEntry> {
    const file = this.file(path)
    const id = newUid()
    // Open in the editor: flush what is pending and close it, telling its editors the trash entry.
    if (this.opts.hot?.has(path)) await this.opts.hot.discard(path, { ifMatch: opts.ifMatch, trash: { id, actor: opts.actor } })
    const current = await readStable(file)
    if (current === null) throw new NoteError('not_found', `does not exist: ${path}`)
    const hash = contentHash(current)
    if (opts.ifMatch !== undefined && opts.ifMatch !== hash) throw new NoteError('precondition_failed', `the note has changed: ${path}`, hash)

    // First it's set aside within the same filesystem (atomic rename), then we
    // check that what was set aside is what was meant to be deleted.
    const aside = join(dirname(file), `.${posix.basename(path)}.thoth-del-${process.pid}-${Date.now()}`)
    renameSync(file, aside)
    const moved = readText(aside)
    if (moved === null || contentHash(moved) !== hash) {
      renameSync(aside, file)
      throw new NoteError('precondition_failed', `the note changed during deletion: ${path}`, moved === null ? null : contentHash(moved))
    }
    const entry: TrashEntry = { id, path, deletedAt: new Date().toISOString(), actor: opts.actor, etag: hash }
    const dir = join(this.opts.stateDir, 'trash', entry.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'note.md'), moved)
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(entry, null, 2))
    rmSync(aside)
    this.opts.indexer.indexPaths([path])
    return entry
  }

  /**
   * Moves or renames a note and rewrites the links needed so none of them
   * change destination. The rewrites are done by the system on behalf of
   * whoever renamed it. With `dryRun`, it only reports what it would do.
   */
  async move(from: string, to: string, opts: { ifMatch?: string; actor: Actor; dryRun?: boolean }): Promise<MoveReport> {
    const hot = this.opts.hot
    // Open in the editor: the hub flushes and locks it during the move, and its editors follow it.
    if (!opts.dryRun && hot?.has(from)) {
      return hot.move(from, to, async () => {
        const result = await this.moveNow(from, to, opts)
        return { result, written: readText(this.file(to)) }
      })
    }
    return this.moveNow(from, to, opts)
  }

  private async moveNow(from: string, to: string, opts: { ifMatch?: string; actor: Actor; dryRun?: boolean }): Promise<MoveReport> {
    const fromFile = this.file(from)
    const toFile = this.file(to)
    const text = await readStable(fromFile)
    if (text === null) throw new NoteError('not_found', `does not exist: ${from}`)
    if (readText(toFile) !== null) throw new NoteError('exists', `already exists: ${to}`)
    const hash = contentHash(text)
    if (opts.ifMatch !== undefined && opts.ifMatch !== hash) throw new NoteError('precondition_failed', `the note has changed: ${from}`, hash)

    // Resolution state before and after the move.
    this.opts.indexer.indexPaths([from])
    // Frozen copies: the live index changes as soon as reindexing happens during execution.
    const before = this.opts.indexer.links.clone()
    const after = before.clone()
    const keys = before.get(from) ?? { path: from }
    after.delete(from)
    after.set({ ...keys, path: to })
    const map = (p: string) => (p === from ? to : p)

    // Notes that may be affected: the moved one, those linking to it, and those
    // looking up one of its keys (a closer name match would "steal" the link).
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

    // 1. The moved note: created at the destination (without overwriting), and
    // the source is removed if it didn't change.
    const newText = this.ensureUid(applyReplacements(text, movedReps), this.uidIn(text)).text
    mkdirSync(dirname(toFile), { recursive: true })
    const created = await commitText(toFile, newText, null)
    if (!created.ok) throw new NoteError('exists', `already exists: ${to}`)
    const aside = join(dirname(fromFile), `.${posix.basename(from)}.thoth-mv-${process.pid}-${Date.now()}`)
    try {
      renameSync(fromFile, aside)
    } catch (err) {
      // Without this the note would end up duplicated: undo the creation at the destination.
      rmSync(toFile, { force: true })
      throw err
    }
    const moved = readText(aside)
    if (moved === null || contentHash(moved) !== hash) {
      renameSync(aside, fromFile)
      rmSync(toFile, { force: true })
      throw new NoteError('precondition_failed', `the note changed during the move: ${from}`, moved === null ? null : contentHash(moved))
    }
    rmSync(aside)
    this.opts.indexer.indexPaths([from, to])

    // 2. The rest of the notes, as the system. The plan is recalculated over the current text.
    const system: Actor = { kind: 'system', reason: `renamed ${from} to ${to} by ${actorLabel(opts.actor)}` }
    for (const src of others) {
      try {
        await this.edit(src, (t) => applyReplacements(t, planRelinks(t, src, src, before, after, map)), { actor: system })
      } catch (err) {
        report.failed.push({ path: src, ...failure(err) })
      }
    }

    // 3. Safety net: if something couldn't be rewritten, the old name stays as an alias.
    const oldName = posix.basename(from).replace(/\.md$/i, '')
    const newName = posix.basename(to).replace(/\.md$/i, '')
    if (report.failed.length && oldName !== newName) {
      try {
        await this.edit(to, (t) => addToFrontmatterList(t, 'aliases', oldName), { actor: system })
        report.aliasAdded = oldName
      } catch (err) {
        const f = failure(err)
        report.failed.push({ path: to, error: f.error, message: `could not add the alias: ${f.message}` })
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

  /** Restores from the trash to its original path (or to `to`). Never overwrites. */
  async restore(id: string, _actor: Actor, to?: string): Promise<{ path: string; etag: string }> {
    const dir = join(this.opts.stateDir, 'trash', id)
    const meta = readText(join(dir, 'meta.json'))
    if (meta === null) throw new NoteError('not_found', `not in the trash: ${id}`)
    const entry = JSON.parse(meta) as TrashEntry
    const text = readText(join(dir, 'note.md'))!
    const path = to ?? entry.path
    const file = this.file(path)
    mkdirSync(dirname(file), { recursive: true })
    const r = await commitText(file, text, null)
    if (!r.ok) throw new NoteError('exists', `already exists: ${path}`)
    rmSync(dir, { recursive: true })
    this.opts.indexer.indexPaths([path])
    return { path, etag: contentHash(text) }
  }

  private uidIn(text: string): string | null {
    const fm = readFrontmatter(text)
    const v = fm.error ? null : fm.data[this.uidKey]
    return typeof v === 'string' || typeof v === 'number' ? String(v) : null
  }

  /** Adds `uid` (the previous one if there was one, or a new one) if the text doesn't have one and the frontmatter is valid. */
  private ensureUid(text: string, previous: string | null): { text: string; uid: string | null } {
    const existing = this.uidIn(text)
    if (existing) return { text, uid: existing }
    if (readFrontmatter(text).error) return { text, uid: null } // broken YAML: written as-is, untouched
    const uid = previous ?? newUid()
    return { text: setFrontmatterKey(text, this.uidKey, uid), uid }
  }
}

function actorLabel(a: Actor): string {
  return a.kind === 'user' ? a.id : a.kind === 'agent' ? `${a.id} (on behalf of ${a.onBehalfOf})` : `system: ${a.reason}`
}

/** Why a rewrite failed, as the API reports errors: a code and a hint. */
function failure(err: unknown): { error: ErrorCode; message: string } {
  if (err instanceof NoteError) return { error: err.code, message: err.message }
  return { error: 'internal', message: err instanceof Error ? err.message : String(err) }
}
