// Note service: the system's only write point (UI, API and MCP all go
// through here). Optimistic concurrency by hash, safe writes
// (fsutil.ts), lazy `uid` and deletion to trash.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { addToFrontmatterList, classifyPath, contentHash, extract, newUid, normKey, pathKeys, readFrontmatter, resolveImageRef, setFrontmatterKey, type ErrorCode, type LinkIndex } from '@thoth/core'
import { commitText, createFile, linkNew, readStable, readText } from './fsutil.ts'
import { attachmentPath, sniffImage, suffixedName } from './attachments.ts'
import { applyReplacements, keptLinks, planImageRelinks, planRelinks, type Replacement } from './relink.ts'
import type { Indexer } from './indexer.ts'
import type { Db } from './db.ts'

/** Who makes a change. Will be recorded in history (M2). */
export type Actor =
  | { kind: 'user'; id: string }
  | { kind: 'agent'; id: string; onBehalfOf: string }
  | { kind: 'system'; reason: string }

export type NoteErrorCode = 'not_found' | 'exists' | 'precondition_failed' | 'invalid_path' | 'edit_mismatch' | 'too_large' | 'unsupported_type' | 'not_configured'

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
  /** Largest image accepted, in bytes (20 MB by default). */
  maxImageBytes?: number
  /** Fixed folder for new images (thoth.yaml), or null to store them next to their note. Asked on each upload. */
  attachmentsFolder?: () => string | null
}

export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024

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
  /**
   * The moved note's images (D-028), when it changes folder; empty otherwise.
   * `moved`: images in its folder that only it uses go with it (a taken name
   * gets a suffix, nothing is overwritten). `stayed`: shared with other notes
   * (`shared`) or in another folder (`elsewhere`); the note's links to them
   * are rewritten so they keep working. The note's rewritten image links are
   * in `relinked`, under the note.
   * `failed`: what went wrong with an image. `outcome: 'stayed'`: it could not
   * go with the note, stays at `path` and the note links it there.
   * `outcome: 'copied'`: it is at `to` and the note links it there, but the
   * original at `path` could not be removed.
   */
  images: {
    moved: { from: string; to: string }[]
    stayed: { path: string; reason: 'shared' | 'elsewhere' }[]
    failed: { path: string; to: string | null; outcome: 'stayed' | 'copied'; error: ErrorCode; message: string }[]
  }
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

  readonly maxImageBytes: number

  constructor(opts: NoteServiceOptions) {
    this.opts = opts
    this.uidKey = opts.uidKey ?? 'uid'
    this.maxImageBytes = opts.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
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

  /**
   * Creates a new note; never overwrites. Born with a `uid`. With `freshUid`
   * (a copy of another note, such as a template) a `uid` already in the text
   * is replaced, so the copy doesn't share its identity.
   */
  async create(path: string, text: string, _actor: Actor, opts: { freshUid?: boolean } = {}): Promise<{ path: string; etag: string; uid: string | null }> {
    const file = this.file(path)
    mkdirSync(dirname(file), { recursive: true })
    if (opts.freshUid && this.uidIn(text)) text = setFrontmatterKey(text, this.uidKey, newUid())
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

    const report: MoveReport = { from, to, relinked: [], kept: [], failed: [], aliasAdded: null, images: { moved: [], stayed: [], failed: [] }, dryRun: !!opts.dryRun }
    const imagePlan = this.planImages(text, from, to)
    report.images = { moved: imagePlan.moved, stayed: imagePlan.stayed, failed: imagePlan.unplaceable }
    const planned = movedNotePlan(text, from, to, before, after, map, placeOf(imagePlan.moved))
    if (planned.changes.length) report.relinked.push({ path: to, links: planned.changes.length, changes: planned.changes })
    const others: string[] = []
    for (const src of [...sources].filter((p) => p !== from).sort()) {
      const t = readText(this.file(src))
      if (t === null) continue
      const reps = planRelinks(t, src, src, before, after, map)
      if (reps.length) { report.relinked.push({ path: src, links: reps.length, changes: changesOf(t, reps) }); others.push(src) }
      for (const k of keptLinks(t, src, before, after, from, to)) report.kept.push({ path: src, ...k })
    }
    if (opts.dryRun) return report

    // 1. Its images get their name at the destination first (a second link to
    // the same file): until the note is in place, the originals stay untouched.
    // One that can't be placed stays where it is, and the note links it there.
    const placed = this.placeImages(imagePlan.moved, posix.dirname(to), report)
    report.images.moved = placed
    const unplace = () => { for (const p of placed) rmSync(join(this.opts.notesDir, p.to), { force: true }) }
    const final = movedNotePlan(text, from, to, before, after, map, placeOf(placed))
    report.relinked = report.relinked.filter((r) => r.path !== to)
    if (final.changes.length) report.relinked.unshift({ path: to, links: final.changes.length, changes: final.changes })

    // 2. The moved note: created at the destination (without overwriting), and
    // the source is removed if it didn't change. If anything fails, the images
    // placed are removed again: everything stays as it was.
    const newText = this.ensureUid(final.text, this.uidIn(text)).text
    const aside = join(dirname(fromFile), `.${posix.basename(from)}.thoth-mv-${process.pid}-${Date.now()}`)
    try {
      mkdirSync(dirname(toFile), { recursive: true })
      const created = await commitText(toFile, newText, null)
      if (!created.ok) throw new NoteError('exists', `already exists: ${to}`)
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
    } catch (err) {
      unplace()
      throw err
    }
    rmSync(aside)
    this.opts.indexer.indexPaths([from, to])

    // 3. The note links its images at their new names: the originals go.
    for (const p of placed) {
      try {
        this.removeOriginal(p.from, p.to)
      } catch (err) {
        report.images.failed.push({ path: p.from, to: p.to, outcome: 'copied', ...failure(err) })
      }
    }

    // 4. The rest of the notes, as the system. The plan is recalculated over the current text.
    const system: Actor = { kind: 'system', reason: `renamed ${from} to ${to} by ${actorLabel(opts.actor)}` }
    for (const src of others) {
      try {
        await this.edit(src, (t) => applyReplacements(t, planRelinks(t, src, src, before, after, map)), { actor: system })
      } catch (err) {
        report.failed.push({ path: src, ...failure(err) })
      }
    }

    // 5. Safety net: if something couldn't be rewritten, the old name stays as an alias.
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

  /**
   * Which of the note's images go with it when it moves to another folder:
   * those in its folder that no other note uses (by the index). The rest stay.
   * Names are only predicted here (the first free one); placing them decides.
   */
  private planImages(text: string, from: string, to: string): Omit<MoveReport['images'], 'failed'> & { unplaceable: MoveReport['images']['failed'] } {
    const plan: ReturnType<NoteService['planImages']> = { moved: [], stayed: [], unplaceable: [] }
    const dir = posix.dirname(from)
    const toDir = posix.dirname(to)
    if (dir === toDir) return plan
    const users = this.opts.db.prepare('select distinct src_path from images where path = ?')
    const seen = new Set<string>()
    const taken = new Set<string>()
    for (const img of extract(text).images) {
      const path = resolveImageRef(from, img.dest, { embed: img.kind === 'embed' || img.kind === 'wiki' })
      if (path === null || seen.has(path)) continue
      seen.add(path)
      if (!this.isFile(path)) continue // a broken reference: nothing to move, its link keeps its target
      if (posix.dirname(path) !== dir) { plan.stayed.push({ path, reason: 'elsewhere' }); continue }
      if ((users.all(path) as { src_path: string }[]).some((r) => r.src_path !== from)) { plan.stayed.push({ path, reason: 'shared' }); continue }
      const free = firstName(path, toDir, (dest) => !taken.has(dest) && !existsSync(join(this.opts.notesDir, dest)))
      if (free === undefined) {
        plan.unplaceable.push({ path, to: null, outcome: 'stayed', error: 'exists', message: `no free name for ${path} in ${toDir}` })
        continue
      }
      taken.add(free)
      plan.moved.push({ from: path, to: free })
    }
    return plan
  }

  /** Gives each image a name in `dir` without overwriting anything; the originals stay. Failures are reported and the image stays. */
  private placeImages(moves: { from: string; to: string }[], dir: string, report: MoveReport): { from: string; to: string }[] {
    const placed: { from: string; to: string }[] = []
    for (const m of moves) {
      try {
        mkdirSync(join(this.opts.notesDir, dir), { recursive: true })
        placed.push({ from: m.from, to: this.linkImage(m.from, dir) })
      } catch (err) {
        report.images.failed.push({ path: m.from, to: null, outcome: 'stayed', ...failure(err) })
      }
    }
    return placed
  }

  private linkImage(from: string, dir: string): string {
    const src = join(this.opts.notesDir, from)
    const free = firstName(from, dir, (path) => linkNew(src, join(this.opts.notesDir, path)))
    if (free === undefined) throw new NoteError('exists', `no free name for ${from} in ${dir}`)
    return free
  }

  /** Removes an image's old name, only if it is still the same file as the new one. */
  private removeOriginal(from: string, to: string) {
    const a = statSync(join(this.opts.notesDir, from))
    const b = statSync(join(this.opts.notesDir, to))
    if (a.ino !== b.ino || a.dev !== b.dev) throw new NoteError('precondition_failed', `the image changed during the move: ${from}`)
    rmSync(join(this.opts.notesDir, from))
  }

  private isFile(path: string): boolean {
    try { return statSync(join(this.opts.notesDir, path)).isFile() } catch { return false }
  }

  /**
   * Stores an image for the note `notePath` (D-028) and returns where it went:
   * `path` from the notes root and `src`, relative to the note, to link it.
   * Never overwrites: a taken name gets a suffix. The note itself isn't
   * touched; the editor inserts the link. Writing next to a note needs the same
   * access as writing the note: per-folder permissions (D-014) apply here.
   */
  async attach(notePath: string, bytes: Uint8Array, _actor: Actor, now = new Date()): Promise<{ path: string; src: string }> {
    this.read(notePath) // the note must exist (404 otherwise)
    if (bytes.byteLength > this.maxImageBytes) throw new NoteError('too_large', `${bytes.byteLength} bytes, the limit is ${this.maxImageBytes}`)
    const type = sniffImage(bytes)
    if (!type) throw new NoteError('unsupported_type', 'only PNG, JPEG, GIF, WebP and AVIF images are stored')
    const folder = this.opts.attachmentsFolder?.() ?? null
    for (let n = 1; n <= 1000; n++) {
      const path = attachmentPath(notePath, type.ext, now, n, folder)
      const file = join(this.opts.notesDir, path)
      mkdirSync(dirname(file), { recursive: true })
      if (createFile(file, bytes)) return { path, src: posix.relative(posix.dirname(notePath), path) }
    }
    throw new NoteError('exists', `no free name for an image of ${notePath}`)
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

/** How many suffixed names are tried for an image before giving up. */
const MAX_NAMES = 1000

/**
 * The first name the image at `path` can take in `dir` for which `take` says
 * yes: its own, then with a suffix. undefined if none.
 */
function firstName(path: string, dir: string, take: (candidate: string) => boolean): string | undefined {
  for (let n = 1; n <= MAX_NAMES; n++) {
    const name = suffixedName(posix.basename(path), n)
    const candidate = dir === '.' ? name : `${dir}/${name}`
    if (take(candidate)) return candidate
  }
  return undefined
}

/** Each replacement as the preview shows it: the text before and after. */
const changesOf = (text: string, reps: Replacement[]) => reps.map((r) => ({ before: text.slice(r.from, r.to), after: r.text }))

const placeOf = (moves: { from: string; to: string }[]) => {
  const at = new Map(moves.map((m) => [m.from, m.to]))
  return (path: string) => at.get(path) ?? path
}

/**
 * The moved note's text at its destination and what changes in it: image
 * references first (so they keep reaching each image where it ends up), then
 * links to notes, over the text with the images already rewritten.
 */
function movedNotePlan(text: string, from: string, to: string, before: LinkIndex, after: LinkIndex, map: (p: string) => string, place: (p: string) => string) {
  const imageReps = planImageRelinks(text, from, to, place)
  const withImages = applyReplacements(text, imageReps)
  const linkReps: Replacement[] = planRelinks(withImages, from, to, before, after, map)
  const changes = [
    ...changesOf(withImages, linkReps),
    ...imageReps.map((r) => ({ before: r.before, after: r.after })),
  ]
  return { text: applyReplacements(withImages, linkReps), changes }
}

function actorLabel(a: Actor): string {
  return a.kind === 'user' ? a.id : a.kind === 'agent' ? `${a.id} (on behalf of ${a.onBehalfOf})` : `system: ${a.reason}`
}

/** Why a rewrite failed, as the API reports errors: a code and a hint. */
function failure(err: unknown): { error: ErrorCode; message: string } {
  if (err instanceof NoteError) return { error: err.code, message: err.message }
  return { error: 'internal', message: err instanceof Error ? err.message : String(err) }
}
