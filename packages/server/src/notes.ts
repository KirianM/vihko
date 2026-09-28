// Note service: the system's only write point (UI, API and MCP all go
// through here). Optimistic concurrency by hash, safe writes
// (fsutil.ts), lazy `uid` and deletion to trash.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { addToFrontmatterList, classifyPath, contentHash, extract, newUid, normKey, pathKeys, readFrontmatter, resolveImageRef, setFrontmatterKey, type AttachmentsConfig, type ErrorCode, type LinkIndex } from '@vihko/core'
import { commitText, createFile, linkNew, readStable, readText } from './fsutil.ts'
import { attachmentPath, noteAttachmentsDir, sniffImage, suffixedName } from './attachments.ts'
import { applyReplacements, beforeMoves, keptLinks, planImageRelinks, planLinks, planRelinks, rewriteLink, type Replacement, type Shift } from './relink.ts'
import type { Indexer } from './indexer.ts'
import { applySplices, spliceOf, type Splice } from './edits.ts'
import type { Db } from './db.ts'
import type { Actor, Reason } from './actor.ts'
import type { FileChange, WriteHandle } from './history/recorder.ts'

export type { Actor, Reason } from './actor.ts'

/**
 * What the note service tells the history (history/recorder.ts): each write
 * right before it happens, `done` once it's on disk (or `abort`), and
 * operations whose writes are one commit.
 */
export interface NoteHistory {
  prepare(changes: FileChange[], opts: { actor: Actor; reason?: Reason; immediate?: boolean }): WriteHandle
  operation<T>(actor: Actor, reason: Reason | null, fn: () => Promise<T>): Promise<T>
}

const NO_HISTORY: NoteHistory = {
  prepare: () => ({ done() {}, abort() {} }),
  operation: (_a, _r, fn) => fn(),
}

export type NoteErrorCode = 'not_found' | 'exists' | 'precondition_failed' | 'invalid_path' | 'edit_mismatch' | 'too_large' | 'unsupported_type' | 'not_configured' | 'not_empty'

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

/**
 * What an edit makes of the current text: the new text, or exact splices
 * (edits.ts), which on an open note don't disturb what others type next to them.
 */
export type Change = string | Splice[]

export const changedText = (text: string, change: Change) => (typeof change === 'string' ? change : applySplices(text, change))

/** Documents open in the collaborative editor. The hub will implement this. */
export interface HotDocuments {
  has(path: string): boolean
  /**
   * The text its editors have now (what an edit is checked against), which
   * may be ahead of the file by what they typed since the last flush; null if
   * it isn't open, or its file is gone.
   */
  text?(path: string): string | null
  edit(path: string, fn: (text: string) => Change, opts: { ifMatch?: string; actor: Actor }): Promise<{ etag: string }>
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
  /**
   * Where new images go (vihko.yaml `attachments`): next to their note by
   * default. Asked on each upload and each move (in `per-note` mode a note's
   * folder of images moves with it).
   */
  attachments?: () => AttachmentsConfig
  /** The history: every write is recorded with its actor (M2). */
  history?: NoteHistory
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
  /**
   * Links the move doesn't rewrite but whose resolution it changes (D-019): an
   * ambiguous or broken link that will lead to a note, one that will be broken
   * or ambiguous, by source note (the moved note under its new path), with a
   * count. Reported in the preview so whoever moves decides; the report after
   * the move says the same.
   */
  shifted: ShiftGroup[]
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
   * `folder`: in `per-note` mode (vihko.yaml), the note's own folder of images
   * (`plan.assets/`), which goes with it whole and is renamed to match
   * (`files`: how many it holds). Links into it, from the note or from any
   * other, are rewritten. It stays where it is (and is in `failed`, with the
   * links rewritten to reach it there) if the destination's name is taken or
   * it holds notes.
   */
  images: {
    moved: { from: string; to: string }[]
    stayed: { path: string; reason: 'shared' | 'elsewhere' }[]
    folder: { from: string; to: string; files: number } | null
    failed: { path: string; to: string | null; outcome: 'stayed' | 'copied'; error: ErrorCode; message: string }[]
  }
  dryRun: boolean
  /** The moved note's ETag at its new path, as the move left it (its own links rewritten, the alias added); null in a dry run. */
  etag: string | null
}

/** What a folder move does (or would do, with `dryRun`). */
export interface FolderMoveReport {
  /** Folders, from the notes root. */
  from: string
  to: string
  /** Every note in the folder, subfolders included, and where it ends up. */
  notes: { from: string; to: string }[]
  /** Other files that go with the folder (images, attachments). */
  files: number
  /** Their paths, from the notes root, where they were (for filtering by who asks: scoped.ts drops them). */
  filePaths?: string[]
  /**
   * Notes whose links or image references are rewritten, moved ones under
   * their new path, with each change as in a note move.
   */
  relinked: MoveReport['relinked']
  /** Links whose resolution changes without being rewritten, as in a note move. */
  shifted: ShiftGroup[]
  /** Notes that couldn't be rewritten: an error code for the UI and a hint for developers. */
  failed: MoveReport['failed']
  dryRun: boolean
}

/**
 * What updating the links after notes moved outside vihko does (or would do,
 * with `dryRun`): the rewrites a vihko move of those notes would have made.
 */
export interface MovedRelinkReport {
  /** The moves it applies to: those still in place (the note at `to`, nothing back at `from`). */
  moves: { from: string; to: string }[]
  /** Notes rewritten, moved ones under their new path, with each change as in a move. */
  relinked: MoveReport['relinked']
  /** Links whose resolution changes without being rewritten, as in a move. */
  shifted: ShiftGroup[]
  failed: MoveReport['failed']
  dryRun: boolean
}

/** A source note's links whose resolution a move changes (relink.ts, `Shift`). */
export interface ShiftGroup {
  path: string
  links: number
  changes: Shift[]
}

/** What a move says while it runs: the move itself is done (and how many notes are left to rewrite), and how many are. */
export interface MoveHooks {
  onMoved?: (toRewrite: number) => void
  onProgress?: (done: number, total: number) => void
}

/**
 * What restoring a version did: the note's new ETag, the images it brought
 * back, and those it couldn't: not in that version's commit, or a different
 * file already at that path (never overwritten).
 */
export interface RestoreReport {
  etag: string
  images: { restored: string[]; missing: { path: string; reason: 'not_in_history' | 'exists' }[] }
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
  private history: NoteHistory

  readonly maxImageBytes: number

  constructor(opts: NoteServiceOptions) {
    this.opts = opts
    this.uidKey = opts.uidKey ?? 'uid'
    this.maxImageBytes = opts.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
    this.history = opts.history ?? NO_HISTORY
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
   * The note as whoever writes next will find it: an open note's text is its
   * editors' (ahead of the file by what they typed since the last flush), so
   * its ETag is the one an edit is checked against; otherwise, the file.
   */
  readCurrent(path: string): NoteRead {
    const live = this.opts.hot?.text?.(path) ?? null
    return live === null ? this.read(path) : { path, text: live, etag: contentHash(live) }
  }

  /**
   * Creates a new note; never overwrites. Born with a `uid`. With `freshUid`
   * (a copy of another note, such as a template) a `uid` already in the text
   * is replaced, so the copy doesn't share its identity.
   */
  async create(path: string, text: string, actor: Actor, opts: { freshUid?: boolean; reason?: Reason } = {}): Promise<{ path: string; etag: string; uid: string | null }> {
    const file = this.file(path)
    mkdirSync(dirname(file), { recursive: true })
    if (opts.freshUid && this.uidIn(text)) text = setFrontmatterKey(text, this.uidKey, newUid())
    const withUid = this.ensureUid(text, null)
    const w = this.history.prepare([{ path, after: withUid.text }], { actor, reason: opts.reason, immediate: true })
    const r = await commitText(file, withUid.text, null).catch((err) => { w.abort(); throw err })
    if (!r.ok) {
      w.abort()
      throw new NoteError('exists', `already exists: ${path}`, r.current === null ? null : contentHash(r.current))
    }
    w.done()
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
  async edit(path: string, fn: (text: string) => Change, opts: { ifMatch?: string; actor: Actor }): Promise<{ etag: string }> {
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
    const next = this.ensureUid(changedText(current, fn(current)), oldUid).text
    if (next === current) return { etag: currentHash }
    const w = this.history.prepare([{ path, before: current, after: next }], { actor: opts.actor })
    const r = await commitText(file, next, currentHash).catch((err) => { w.abort(); throw err })
    if (!r.ok) {
      w.abort()
      throw new NoteError('precondition_failed', `the note changed during the write: ${path}`, r.current === null ? null : contentHash(r.current))
    }
    w.done()
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
    const aside = join(dirname(file), `.${posix.basename(path)}.vihko-del-${process.pid}-${Date.now()}`)
    const w = this.history.prepare([{ path, before: current, after: null }], { actor: opts.actor, immediate: true })
    try {
      renameSync(file, aside)
    } catch (err) {
      w.abort()
      throw err
    }
    const moved = readText(aside)
    if (moved === null || contentHash(moved) !== hash) {
      renameSync(aside, file)
      w.abort()
      throw new NoteError('precondition_failed', `the note changed during deletion: ${path}`, moved === null ? null : contentHash(moved))
    }
    w.done()
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
   *
   * First the note moves (with its images); then the other notes are
   * rewritten one by one, each as an independent safe write: `onMoved` says
   * when the first part is done and `onProgress` counts the second. A crash
   * in between leaves every file whole, the note at its destination, and some
   * links not yet rewritten. One move (of a note or a folder) at a time: each
   * plans over the links as the previous one left them.
   */
  async move(from: string, to: string, opts: { ifMatch?: string; actor: Actor; dryRun?: boolean } & MoveHooks): Promise<MoveReport> {
    if (opts.dryRun) return (await this.moveNow(from, to, opts)).report
    return this.oneMoveAtATime(async () => {
      const hot = this.opts.hot
      // Open in the editor: the hub flushes and locks it while it moves, and its editors follow it.
      const moved = hot?.has(from)
        ? await hot.move(from, to, async () => {
          const result = await this.moveNow(from, to, opts)
          return { result, written: readText(this.file(to)) }
        })
        : await this.moveNow(from, to, opts)
      const { report, others, before, after, map, place } = moved
      opts.onMoved?.(others.length)

      // The rest of the notes, as the system. The plan is recalculated over the
      // current text: links to the note, and references to images in its folder of images.
      const system: Actor = { kind: 'system', reason: { code: 'note_moved', from, to, by: opts.actor } }
      await this.history.operation(system, null, () =>
        this.rewriteAll(others.map((src) => ({ path: src, change: (t: string) => movedNotePlan(t, src, src, before, after, map, place).splices })), system, report.failed, opts.onProgress))

      // Safety net: if something couldn't be rewritten, the old name stays as an alias.
      // Not when aliases don't resolve links (vihko.yaml): it would save nothing.
      const oldName = posix.basename(from).replace(/\.md$/i, '')
      const newName = posix.basename(to).replace(/\.md$/i, '')
      if (report.failed.length && oldName !== newName && this.opts.indexer.linkAliases) {
        try {
          const aliasActor: Actor = { kind: 'system', reason: { code: 'alias_added', alias: oldName, from, to, by: opts.actor } }
          report.etag = (await this.edit(to, (t) => addToFrontmatterList(t, 'aliases', oldName), { actor: aliasActor })).etag
          report.aliasAdded = oldName
        } catch (err) {
          const f = failure(err)
          report.failed.push({ path: to, error: f.error, message: `could not add the alias: ${f.message}` })
        }
      }
      return report
    })
  }

  private moving: Promise<unknown> = Promise.resolve()

  private oneMoveAtATime<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.moving.then(fn, fn)
    this.moving = run.catch(() => {})
    return run
  }

  /**
   * Rewrites notes as the system, several at a time (each safe write spends
   * most of its time waiting for stable reads and, on a network filesystem,
   * for the server). Failures are collected, sorted by path.
   */
  private async rewriteAll(items: { path: string; change: (text: string) => Change }[], system: Actor, failed: MoveReport['failed'], onProgress?: MoveHooks['onProgress']) {
    let done = 0
    onProgress?.(0, items.length)
    await inPool(items, async ({ path, change }) => {
      try {
        await this.edit(path, change, { actor: system })
      } catch (err) {
        failed.push({ path, ...failure(err) })
      }
      onProgress?.(++done, items.length)
    })
    failed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }

  /** The move itself (or, with dryRun, its plan), and what the rewrites of the other notes need. */
  private async moveNow(from: string, to: string, opts: { ifMatch?: string; actor: Actor; dryRun?: boolean }) {
    const fromFile = this.file(from)
    const toFile = this.file(to)
    const text = await readStable(fromFile)
    if (text === null) throw new NoteError('not_found', `does not exist: ${from}`)
    if (readText(toFile) !== null) throw new NoteError('exists', `already exists: ${to}`)
    const hash = contentHash(text)
    if (opts.ifMatch !== undefined && opts.ifMatch !== hash) throw new NoteError('precondition_failed', `the note has changed: ${from}`, hash)

    const assets = this.planAssets(from, to)
    const { before, after, map, sources } = this.relinkContext(new Map([[from, to]]), assets.folder?.from ?? null)

    const report: MoveReport = { from, to, relinked: [], shifted: [], kept: [], failed: [], aliasAdded: null, images: { moved: [], stayed: [], folder: null, failed: [] }, dryRun: !!opts.dryRun, etag: null }
    const imagePlan = this.planImages(text, from, to, assets.folder?.from ?? null)
    report.images = { moved: imagePlan.moved, stayed: imagePlan.stayed, folder: assets.folder, failed: [...assets.failed, ...imagePlan.unplaceable] }
    const planned = movedNotePlan(text, from, to, before, after, map, placeOf(imagePlan.moved, assets.folder))
    if (planned.changes.length) report.relinked.push({ path: to, links: planned.changes.length, changes: planned.changes })
    addShifts(report.shifted, to, planned.shifts)
    const others: string[] = []
    for (const src of sources) {
      const t = readText(this.file(src))
      if (t === null) continue
      const plan = movedNotePlan(t, src, src, before, after, map, placeOf([], assets.folder))
      if (plan.changes.length) { report.relinked.push({ path: src, links: plan.changes.length, changes: plan.changes }); others.push(src) }
      addShifts(report.shifted, src, plan.shifts)
      for (const k of keptLinks(t, src, before, after, from, to)) report.kept.push({ path: src, ...k })
    }
    const result = { report, others, before, after, map, place: placeOf([], assets.folder) }
    if (opts.dryRun) return result

    // 1. Its images get their name at the destination first (a second link to
    // the same file): until the note is in place, the originals stay untouched.
    // One that can't be placed stays where it is, and the note links it there.
    // Its folder of images (per-note mode) is renamed whole, and put back if the note can't move.
    const placed = this.placeImages(imagePlan.moved, posix.dirname(to), report)
    report.images.moved = placed
    const folder = assets.folder && this.moveAssets(assets.folder, report) ? assets.folder : null
    report.images.folder = folder
    const unplace = () => {
      for (const p of placed) rmSync(join(this.opts.notesDir, p.to), { force: true })
      if (folder) this.unmoveAssets(folder)
    }
    // The other notes only ever point into the folder (the images moved one by one are only this note's).
    result.place = placeOf([], folder)
    if (assets.folder && !folder) {
      // It stayed: notes that only pointed into it have nothing to rewrite (and aren't touched).
      result.others = others.filter((src) => {
        const t = readText(this.file(src))
        return t !== null && movedNotePlan(t, src, src, before, after, map, result.place).changes.length > 0
      })
      report.relinked = report.relinked.filter((r) => r.path === to || result.others.includes(r.path))
    }
    const final = movedNotePlan(text, from, to, before, after, map, placeOf(placed, folder))
    report.relinked = report.relinked.filter((r) => r.path !== to)
    if (final.changes.length) report.relinked.unshift({ path: to, links: final.changes.length, changes: final.changes })

    // 2. The moved note: created at the destination (without overwriting), and
    // the source is removed if it didn't change. If anything fails, the images
    // placed are removed again: everything stays as it was.
    const newText = this.ensureUid(final.text, this.uidIn(text)).text
    const aside = join(dirname(fromFile), `.${posix.basename(from)}.vihko-mv-${process.pid}-${Date.now()}`)
    // One version by whoever moves it: the note renamed (with its own links
    // rewritten), and its images and folder of images renamed with it.
    const moved: FileChange[] = [
      { path: to, from, before: text, after: newText },
      ...placed.map((p) => ({ path: p.to, from: p.from })),
      ...(folder ? [{ path: folder.to, from: folder.from, folder: true }] : []),
    ]
    const w = this.history.prepare(moved, { actor: opts.actor, immediate: true })
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
      w.abort()
      throw err
    }
    rmSync(aside)
    report.etag = contentHash(newText)
    this.opts.indexer.indexPaths([from, to])
    if (folder) this.opts.indexer.indexFolders([folder.from, folder.to])

    // 3. The note links its images at their new names: the originals go.
    const copied = new Set<string>()
    for (const p of placed) {
      try {
        this.removeOriginal(p.from, p.to)
      } catch (err) {
        report.images.failed.push({ path: p.from, to: p.to, outcome: 'copied', ...failure(err) })
        copied.add(p.to)
      }
    }
    // An image whose original couldn't be removed is a copy, not a rename.
    w.done(moved.map((c) => (copied.has(c.path) ? { path: c.path, after: readFileSync(join(this.opts.notesDir, c.path)) } : c)))

    return result
  }

  /**
   * Link resolution before and after moving the notes in `moves` (path → new
   * path), as frozen copies (the live index changes as soon as anything is
   * reindexed during the move), and the other notes that may need rewriting:
   * those linking to a moved note, those looking up one of its keys (a closer
   * name match would "steal" the link) and, with `imageDir`, those using an
   * image under that folder.
   */
  private relinkContext(moves: Map<string, string>, imageDir: string | null = null) {
    this.opts.indexer.indexPaths(moves.keys())
    const before = this.opts.indexer.links.clone()
    const after = before.clone()
    const affected = new Set<string>()
    for (const [from, to] of moves) {
      const keys = before.get(from) ?? { path: from }
      for (const k of [...pathKeys(from), ...pathKeys(to), ...(keys.aliases ?? []).map(normKey)]) affected.add(k)
      after.delete(from)
    }
    for (const [from, to] of moves) after.set({ ...(before.get(from) ?? { path: from }), path: to })
    const map = (p: string) => moves.get(p) ?? p

    const sources = new Set<string>()
    const add = (rows: unknown[]) => { for (const r of rows as { src_path: string }[]) if (!moves.has(r.src_path)) sources.add(r.src_path) }
    const byDst = this.opts.db.prepare('select distinct src_path from links where dst_path = ?')
    for (const from of moves.keys()) add(byDst.all(from))
    const byKey = this.opts.db.prepare('select distinct src_path from links where key = ?')
    for (const k of affected) add(byKey.all(k))
    if (imageDir !== null) add(this.opts.db.prepare("select distinct src_path from images where path like ? escape '\\'").all(likePrefix(imageDir)))
    return { before, after, map, sources: [...sources].sort() }
  }

  // --- Link fixes ---------------------------------------------------------

  /**
   * Fixes where one ambiguous link leads (D-031.2), only on an explicit
   * request: the occurrence of `link.raw` in the note nearest to `link.at`
   * (the first one without it) is rewritten to the shortest form that, from
   * this note, leads to `target` alone, keeping its anchor and visible text.
   * `target` must be one of the link's candidates now; if the link already
   * leads there, nothing is written. On an open note it's an exact splice in
   * the live document. Returns the link as it is written now.
   */
  async pinLink(path: string, link: { raw: string; at?: number }, target: string, opts: { actor: Actor }): Promise<{ etag: string; raw: string }> {
    let raw = link.raw
    const r = await this.edit(path, (text) => {
      const index = this.opts.indexer.links
      const occurrence = nearest(extract(text).links.filter((l) => l.raw === link.raw && l.kind !== 'markdown'), link.at)
      if (!occurrence) throw new NoteError('edit_mismatch', `no link ${link.raw} in ${path}`)
      const now = index.resolve(path, occurrence)
      if (now.status === 'resolved' && now.path === target) return []
      if (now.status !== 'ambiguous' || !now.candidates.includes(target)) {
        throw new NoteError('edit_mismatch', `${link.raw} in ${path} is not ambiguous with ${target} among its candidates`)
      }
      const next = rewriteLink(occurrence, path, target, index)
      if (next === null) throw new NoteError('edit_mismatch', `no form of ${link.raw} leads to ${target} from ${path}`)
      raw = next
      return [spliceOf(text, occurrence.from, occurrence.to, next)]
    }, opts)
    return { etag: r.etag, raw }
  }

  /**
   * Updates the links after notes moved outside vihko (D-031.4): the rewrites
   * a vihko move of those notes would have made, planned over the files as
   * they are now, without moving any file. Only the moves still in place
   * count (the note at `to`, and no note back at `from`). The moved notes'
   * image references are only rewritten when the image is still where they
   * led and the reference no longer reaches it: the other tool may have moved
   * the images too. With `dryRun`, it only reports; otherwise it waits its
   * turn with vihko's own moves and rewrites as the system, one note at a
   * time (`onMoved` with the count, then `onProgress`).
   */
  async relinkMoved(moves: readonly { from: string; to: string }[], opts: { actor: Actor; dryRun?: boolean } & MoveHooks): Promise<MovedRelinkReport> {
    const run = async () => {
      const plan = this.planMoved(moves)
      const report: MovedRelinkReport = { moves: plan.moves, relinked: plan.relinked, shifted: plan.shifted, failed: [], dryRun: !!opts.dryRun }
      if (opts.dryRun) return report
      opts.onMoved?.(plan.items.length)
      const system: Actor = { kind: 'system', reason: { code: 'links_after_external_move', moves: plan.moves, by: opts.actor } }
      await this.history.operation(system, null, () => this.rewriteAll(plan.items, system, report.failed, opts.onProgress))
      return report
    }
    return opts.dryRun ? run() : this.oneMoveAtATime(run)
  }

  private planMoved(requested: readonly { from: string; to: string }[]) {
    const after = this.opts.indexer.links.clone()
    const moves = requested.filter((m) => after.has(m.to) && !after.has(m.from)).map((m) => ({ from: m.from, to: m.to }))
    const before = beforeMoves(after, moves)
    const forward = new Map(moves.map((m) => [m.from, m.to]))
    const map = (p: string) => forward.get(p) ?? p
    const movedTo = new Set(moves.map((m) => m.to))

    const affected = new Set<string>()
    for (const m of moves) {
      for (const k of [...pathKeys(m.from), ...pathKeys(m.to), ...(after.get(m.to)?.aliases ?? []).map(normKey)]) affected.add(k)
    }
    const sources = new Set<string>()
    const byKey = this.opts.db.prepare('select distinct src_path from links where key = ?')
    for (const k of affected) for (const r of byKey.all(k) as { src_path: string }[]) if (!movedTo.has(r.src_path)) sources.add(r.src_path)

    const relinked: MoveReport['relinked'] = []
    const shifted: ShiftGroup[] = []
    const items: { path: string; change: (text: string) => Change }[] = []
    // The moved notes' own links and image references: written for where the note was.
    const imageHere = (want: string, now: string | null) => this.isFile(want) && (now === null || !this.isFile(now))
    const own = (text: string, m: { from: string; to: string }) => {
      const imageReps = planImageRelinks(text, m.from, m.to, (p) => p, imageHere)
      const { reps, shifts } = planLinks(text, m.from, m.to, before, after, map)
      const all = [...imageReps, ...reps]
      return { splices: relinkSplices(text, all), changes: [...changesOf(text, reps), ...imageReps.map((r) => ({ before: r.before, after: r.after }))], shifts }
    }
    for (const m of moves) {
      const text = readText(this.file(m.to))
      if (text === null) continue
      const p = own(text, m)
      if (p.changes.length) { relinked.push({ path: m.to, links: p.changes.length, changes: p.changes }); items.push({ path: m.to, change: (x) => own(x, m).splices }) }
      addShifts(shifted, m.to, p.shifts)
    }
    for (const src of [...sources].sort()) {
      const text = readText(this.file(src))
      if (text === null) continue
      const { reps, shifts } = planLinks(text, src, src, before, after, map)
      if (reps.length) {
        relinked.push({ path: src, links: reps.length, changes: changesOf(text, reps) })
        items.push({ path: src, change: (x) => relinkSplices(x, planLinks(x, src, src, before, after, map).reps) })
      }
      addShifts(shifted, src, shifts)
    }
    shifted.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { moves, relinked, shifted, items }
  }

  // --- Folders ------------------------------------------------------------
  // A folder only exists on disk: the index lists them (so an empty one shows
  // in the tree), but creating, moving or deleting one is a disk operation.

  /** Validates a folder path: relative, no `..`, no hidden segments, not the root and not named like a note. */
  static checkFolder(path: string): string {
    if (typeof path !== 'string' || path === '') throw new NoteError('invalid_path', `invalid folder path: ${String(path)}`)
    const norm = posix.normalize(path)
    if (path !== norm || path.startsWith('/') || path.endsWith('/') || norm.split('/').includes('..') || classifyPath(norm) !== 'other') {
      throw new NoteError('invalid_path', `invalid folder path: ${path}`)
    }
    return norm
  }

  private dir(path: string) {
    return join(this.opts.notesDir, NoteService.checkFolder(path))
  }

  /** Creates an empty folder (and its missing parents). Never reuses an existing one. */
  createFolder(path: string, _actor: Actor): { path: string } {
    const dir = this.dir(path)
    mkdirSync(dirname(dir), { recursive: true })
    try {
      mkdirSync(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new NoteError('exists', `already exists: ${path}`)
      throw err
    }
    this.opts.indexer.indexFolders([path])
    return { path }
  }

  /**
   * Deletes a folder only if it holds no file at all (empty subfolders go with
   * it). Notes and images are never deleted along with a folder: they are moved
   * or sent to the trash one by one first.
   */
  deleteFolder(path: string, _actor: Actor): { path: string } {
    const dir = this.dir(path)
    if (!isDirectory(dir)) throw new NoteError('not_found', `no such folder: ${path}`)
    const dirs: string[] = []
    const visit = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (!e.isDirectory()) throw new NoteError('not_empty', `the folder is not empty: ${path}`)
        visit(join(d, e.name))
      }
      dirs.push(d)
    }
    visit(dir)
    // Deepest first. Something created meanwhile stops it (rmdir never removes files).
    try {
      for (const d of dirs) rmdirSync(d)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOTEMPTY' || code === 'EEXIST') throw new NoteError('not_empty', `the folder is not empty: ${path}`)
      throw err
    } finally {
      this.opts.indexer.indexFolders([path])
    }
    return { path }
  }

  /**
   * Moves or renames a folder with everything in it, as one rename on disk:
   * its notes, images and other files go together, empty subfolders included.
   * Links are kept like in a note move: no link, inside or outside the folder,
   * changes destination (wikilinks by proximity, relative Markdown links and
   * image references). Never overwrites: the destination must not exist. With
   * `dryRun`, only reports what it would do. As with a note: the folder moves
   * first (`onMoved`), then the notes are rewritten one by one (`onProgress`).
   */
  async moveFolder(from: string, to: string, opts: { actor: Actor; dryRun?: boolean } & MoveHooks): Promise<FolderMoveReport> {
    if (opts.dryRun) return this.moveFolderNow(from, to, opts)
    return this.oneMoveAtATime(() => this.moveFolderNow(from, to, opts))
  }

  private async moveFolderNow(from: string, to: string, opts: { actor: Actor; dryRun?: boolean } & MoveHooks): Promise<FolderMoveReport> {
    const fromDir = this.dir(from)
    const toDir = this.dir(to)
    if (from === to || to.startsWith(from + '/')) throw new NoteError('invalid_path', `cannot move ${from} into itself`)
    if (!isDirectory(fromDir)) throw new NoteError('not_found', `no such folder: ${from}`)
    if (existsSync(toDir)) throw new NoteError('exists', `already exists: ${to}`)

    const inside = listFiles(fromDir)
    const notesInside = inside.filter((p) => classifyPath(`${from}/${p}`) === 'note')
    const moves = new Map(notesInside.map((p) => [`${from}/${p}`, `${to}/${p}`]))
    const { before, after, map, sources } = this.relinkContext(moves, from)
    const place = (p: string) => (p.startsWith(from + '/') ? to + p.slice(from.length) : p)

    const report: FolderMoveReport = {
      from, to, notes: [...moves].map(([f, t]) => ({ from: f, to: t })),
      files: inside.filter((p) => classifyPath(`${from}/${p}`) === 'other').length,
      filePaths: inside.filter((p) => classifyPath(`${from}/${p}`) === 'other').map((p) => `${from}/${p}`),
      relinked: [], shifted: [], failed: [], dryRun: !!opts.dryRun,
    }
    const own: [string, string][] = []
    for (const [f, t] of moves) {
      const text = readText(join(this.opts.notesDir, f))
      if (text === null) continue
      const plan = movedNotePlan(text, f, t, before, after, map, place)
      if (plan.changes.length) { report.relinked.push({ path: t, links: plan.changes.length, changes: plan.changes }); own.push([f, t]) }
      addShifts(report.shifted, t, plan.shifts)
    }
    const others: string[] = []
    for (const src of sources) {
      const text = readText(this.file(src))
      if (text === null) continue
      const plan = movedNotePlan(text, src, src, before, after, map, place)
      if (plan.changes.length) { report.relinked.push({ path: src, links: plan.changes.length, changes: plan.changes }); others.push(src) }
      addShifts(report.shifted, src, plan.shifts)
    }
    report.shifted.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    if (opts.dryRun) return report

    const system: Actor = { kind: 'system', reason: { code: 'folder_moved', from, to, by: opts.actor } }
    // 1. One rename moves everything. The destination is claimed first with an
    // empty folder (mkdir never reuses one), which the rename then replaces:
    // anything that lands there meanwhile makes the rename fail, never overwritten.
    const run = async () => {
      mkdirSync(dirname(toDir), { recursive: true })
      try {
        mkdirSync(toDir)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new NoteError('exists', `already exists: ${to}`)
        throw err
      }
      const w = this.history.prepare([{ path: to, from, folder: true }], { actor: opts.actor, immediate: true })
      try {
        renameSync(fromDir, toDir)
      } catch (err) {
        w.abort()
        try { rmdirSync(toDir) } catch { /* not ours any more: left as it is */ }
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOTEMPTY' || code === 'EEXIST') throw new NoteError('exists', `already exists: ${to}`)
        throw err
      }
      w.done()
      // Recorded as vihko's own change before anything else runs: the watcher and
      // the rescan find the index already in step (no mass removal, no external change).
      this.opts.indexer.indexPaths([...inside.map((p) => `${from}/${p}`), ...inside.map((p) => `${to}/${p}`)])
      this.opts.indexer.indexFolders([from, to])
    }
    // Notes open in an editor: the hub flushes and locks each one during the
    // move, and their editors follow them to the new path.
    const hot = this.opts.hot
    const open = [...moves].filter(([f]) => hot?.has(f)).sort(([a], [b]) => (a < b ? -1 : 1))
    const locked = open.reduceRight<() => Promise<void>>(
      (inner, [f, t]) => () => hot!.move(f, t, async () => ({ result: await inner(), written: readText(this.file(t)) })),
      run,
    )
    await locked()
    opts.onMoved?.(own.length + others.length)

    // 2. The moved notes' own links and image references, then the rest of the
    // notes, as the system, recalculated over the current text.
    await this.history.operation(system, null, () => this.rewriteAll([
      ...own.map(([f, t]) => ({ path: t, change: (x: string) => movedNotePlan(x, f, t, before, after, map, place).splices })),
      ...others.map((src) => ({ path: src, change: (x: string) => movedNotePlan(x, src, src, before, after, map, place).splices })),
    ], system, report.failed, opts.onProgress))
    return report
  }

  /**
   * Which of the note's images go with it when it moves to another folder:
   * those in its folder that no other note uses (by the index). The rest stay.
   * Names are only predicted here (the first free one); placing them decides.
   */
  private planImages(text: string, from: string, to: string, assetsDir: string | null): Pick<MoveReport['images'], 'moved' | 'stayed'> & { unplaceable: MoveReport['images']['failed'] } {
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
      if (assetsDir !== null && path.startsWith(assetsDir + '/')) continue // goes with its folder
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

  /**
   * In `per-note` mode, whether the note's folder of images goes with it: it
   * exists and the note's name or folder changes. It stays (in `failed`) if
   * the name it would take is taken, or if it holds notes (moving those is a
   * folder move, with its own relinking).
   */
  private planAssets(from: string, to: string): { folder: MoveReport['images']['folder']; failed: MoveReport['images']['failed'] } {
    const suffix = this.opts.attachments?.().perNote
    if (suffix === undefined) return { folder: null, failed: [] }
    const src = noteAttachmentsDir(from, suffix)
    const dst = noteAttachmentsDir(to, suffix)
    if (src === dst || classifyPath(src) !== 'other' || !isDirectory(join(this.opts.notesDir, src))) return { folder: null, failed: [] }
    const files = listFiles(join(this.opts.notesDir, src))
    if (files.some((p) => classifyPath(`${src}/${p}`) === 'note')) {
      return { folder: null, failed: [{ path: src, to: null, outcome: 'stayed', error: 'not_empty', message: `${src} holds notes: it stays` }] }
    }
    if (classifyPath(dst) !== 'other' || existsSync(join(this.opts.notesDir, dst))) {
      return { folder: null, failed: [{ path: src, to: null, outcome: 'stayed', error: 'exists', message: `${dst} already exists: ${src} stays` }] }
    }
    return { folder: { from: src, to: dst, files: files.length }, failed: [] }
  }

  /**
   * Renames the note's folder of images, never over anything: the destination
   * is claimed first with an empty folder (mkdir never reuses one), which the
   * rename then replaces. false (and in `failed`) if it stays.
   */
  private moveAssets(folder: { from: string; to: string }, report: MoveReport): boolean {
    const src = join(this.opts.notesDir, folder.from)
    const dst = join(this.opts.notesDir, folder.to)
    try {
      mkdirSync(dirname(dst), { recursive: true })
      mkdirSync(dst)
    } catch (err) {
      const taken = (err as NodeJS.ErrnoException).code === 'EEXIST'
      report.images.failed.push({ path: folder.from, to: null, outcome: 'stayed', ...failure(taken ? new NoteError('exists', `already exists: ${folder.to}`) : err) })
      return false
    }
    try {
      renameSync(src, dst)
      return true
    } catch (err) {
      try { rmdirSync(dst) } catch { /* not ours any more: left as it is */ }
      report.images.failed.push({ path: folder.from, to: null, outcome: 'stayed', ...failure(err) })
      return false
    }
  }

  /** Puts the folder of images back when the note couldn't move, with the same claim-then-rename. */
  private unmoveAssets(folder: { from: string; to: string }) {
    try {
      mkdirSync(join(this.opts.notesDir, folder.from))
      renameSync(join(this.opts.notesDir, folder.to), join(this.opts.notesDir, folder.from))
    } catch { /* something took its place meanwhile: it stays at the destination, whole */ }
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
  async attach(notePath: string, bytes: Uint8Array, actor: Actor, now = new Date()): Promise<{ path: string; src: string }> {
    this.read(notePath) // the note must exist (404 otherwise)
    if (bytes.byteLength > this.maxImageBytes) throw new NoteError('too_large', `${bytes.byteLength} bytes, the limit is ${this.maxImageBytes}`)
    const type = sniffImage(bytes)
    if (!type) throw new NoteError('unsupported_type', 'only PNG, JPEG, GIF, WebP and AVIF images are stored')
    const config = this.opts.attachments?.() ?? { folder: null }
    for (let n = 1; n <= 1000; n++) {
      const path = attachmentPath(notePath, type.ext, now, n, config)
      const file = join(this.opts.notesDir, path)
      mkdirSync(dirname(file), { recursive: true })
      if (this.createNewFile(path, bytes, actor)) return { path, src: posix.relative(posix.dirname(notePath), path) }
    }
    throw new NoteError('exists', `no free name for an image of ${notePath}`)
  }

  /** Creates a file that isn't a note, never over another; false if the name is taken. */
  private createNewFile(path: string, bytes: Uint8Array, actor: Actor): boolean {
    const w = this.history.prepare([{ path, after: bytes }], { actor, immediate: true })
    let created: boolean
    try {
      created = createFile(join(this.opts.notesDir, path), bytes)
    } catch (err) {
      w.abort()
      throw err
    }
    if (created) w.done()
    else w.abort()
    return created
  }

  trash(): TrashEntry[] {
    const root = join(this.opts.stateDir, 'trash')
    let ids: string[]
    try { ids = readdirSync(root) } catch { return [] }
    return ids.sort().reverse().map((id) => JSON.parse(readText(join(root, id, 'meta.json'))!) as TrashEntry)
  }

  /** Restores from the trash to its original path (or to `to`). Never overwrites. */
  async restore(id: string, actor: Actor, to?: string): Promise<{ path: string; etag: string }> {
    const dir = join(this.opts.stateDir, 'trash', id)
    const meta = readText(join(dir, 'meta.json'))
    if (meta === null) throw new NoteError('not_found', `not in the trash: ${id}`)
    const entry = JSON.parse(meta) as TrashEntry
    const text = readText(join(dir, 'note.md'))!
    const path = to ?? entry.path
    const file = this.file(path)
    mkdirSync(dirname(file), { recursive: true })
    const w = this.history.prepare([{ path, after: text }], { actor, reason: { code: 'trash_restored', id }, immediate: true })
    const r = await commitText(file, text, null).catch((err) => { w.abort(); throw err })
    if (!r.ok) {
      w.abort()
      throw new NoteError('exists', `already exists: ${path}`)
    }
    w.done()
    rmSync(dir, { recursive: true })
    this.opts.indexer.indexPaths([path])
    return { path, etag: contentHash(text) }
  }

  /**
   * Brings back a version of a note from the history (D-016): its text is
   * written like any edit (an open note changes live for its editors), and
   * the images it linked that no longer exist come back from the same commit
   * (`file`), never over an existing file, and only where `canWrite` allows.
   * One commit, by `actor`, with the reason `restored`. A note that no
   * longer exists is created again.
   */
  async restoreVersion(path: string, version: { id: string; at: string; path: string; text: string }, opts: { ifMatch?: string; actor: Actor; file: (path: string) => Promise<Uint8Array | null>; canWrite?: (path: string) => boolean }): Promise<RestoreReport> {
    const file = this.file(path)
    const reason: Reason = { code: 'restored', id: version.id, at: version.at }
    return this.history.operation(opts.actor, reason, async () => {
      let etag: string
      if (this.opts.hot?.has(path) || readText(file) !== null) {
        etag = (await this.edit(path, () => version.text, { ifMatch: opts.ifMatch, actor: opts.actor })).etag
      } else {
        if (opts.ifMatch !== undefined) throw new NoteError('precondition_failed', `the note doesn't exist: ${path}`)
        etag = (await this.create(path, version.text, opts.actor)).etag
      }
      const images: RestoreReport['images'] = { restored: [], missing: [] }
      const seen = new Set<string>()
      for (const img of extract(version.text).images) {
        const embed = img.kind === 'embed' || img.kind === 'wiki'
        // Where the restored note looks for it, and where it was in that version (the note may have moved since).
        const target = resolveImageRef(path, img.dest, { embed })
        const source = resolveImageRef(version.path, img.dest, { embed })
        if (target === null || source === null || seen.has(target) || classifyPath(target) !== 'other') continue
        seen.add(target)
        // Where whoever restores can't write: as if the history didn't have it (nothing of that folder is said).
        if (opts.canWrite && !opts.canWrite(target)) { images.missing.push({ path: target, reason: 'not_in_history' }); continue }
        const bytes = await opts.file(source)
        const abs = join(this.opts.notesDir, target)
        if (this.isFile(target)) {
          if (bytes !== null && !Buffer.from(bytes).equals(readFileSync(abs))) images.missing.push({ path: target, reason: 'exists' })
          continue
        }
        if (bytes === null) { images.missing.push({ path: target, reason: 'not_in_history' }); continue }
        mkdirSync(dirname(abs), { recursive: true })
        if (this.createNewFile(target, bytes, opts.actor)) images.restored.push(target)
        else images.missing.push({ path: target, reason: 'exists' })
      }
      return { etag, images }
    })
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

/** Files under `dir` (relative to it, with `/`), hidden ones included: everything a folder move takes along. */
function listFiles(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...listFiles(dir, r))
    else out.push(r)
  }
  return out.sort()
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

const likePrefix = (dir: string) => dir.replace(/[\\%_]/g, (c) => '\\' + c) + '/%'

/** Notes whose links a rename rewrites at the same time. */
const RELINK_CONCURRENCY = 16

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

/** Replacements as splices, from the last one: the earlier positions stay valid. */
const relinkSplices = (text: string, reps: Replacement[]): Splice[] =>
  [...reps].sort((a, b) => b.from - a.from).map((r) => spliceOf(text, r.from, r.to, r.text))

/** Each replacement as the preview shows it: the text before and after. */
const changesOf = (text: string, reps: Replacement[]) => reps.map((r) => ({ before: text.slice(r.from, r.to), after: r.text }))

/** Where each image ends up: the ones moved one by one, and those in a folder of images that moves whole. */
const placeOf = (moves: { from: string; to: string }[], folder: { from: string; to: string } | null = null) => {
  const at = new Map(moves.map((m) => [m.from, m.to]))
  return (path: string) => at.get(path) ?? (folder && path.startsWith(folder.from + '/') ? folder.to + path.slice(folder.from.length) : path)
}

/**
 * The moved note's text at its destination and what changes in it: image
 * references first (so they keep reaching each image where it ends up), then
 * links to notes, over the text with the images already rewritten.
 */
function movedNotePlan(text: string, from: string, to: string, before: LinkIndex, after: LinkIndex, map: (p: string) => string, place: (p: string) => string) {
  // Image references and note links never overlap, so both are planned over the
  // same text and applied as exact splices: a hot note merges them with live typing.
  const imageReps = planImageRelinks(text, from, to, place)
  const { reps: linkReps, shifts } = planLinks(text, from, to, before, after, map)
  const changes = [
    ...changesOf(text, linkReps),
    ...imageReps.map((r) => ({ before: r.before, after: r.after })),
  ]
  const reps = [...imageReps, ...linkReps]
  return { text: applyReplacements(text, reps), splices: relinkSplices(text, reps), changes, shifts }
}

/** The link nearest to `at` (the first one without it). */
function nearest<T extends { from: number }>(links: T[], at: number | undefined): T | undefined {
  if (at === undefined || !Number.isFinite(at)) return links[0]
  let best: T | undefined
  for (const l of links) if (!best || Math.abs(l.from - at) < Math.abs(best.from - at)) best = l
  return best
}

function addShifts(groups: ShiftGroup[], path: string, shifts: Shift[]) {
  if (shifts.length) groups.push({ path, links: shifts.length, changes: shifts })
}

/** Runs `fn` over `items`, RELINK_CONCURRENCY at a time. */
async function inPool<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item)
  }
  await Promise.all(Array.from({ length: Math.min(RELINK_CONCURRENCY, queue.length) }, worker))
}

/** Why a rewrite failed, as the API reports errors: a code and a hint. */
function failure(err: unknown): { error: ErrorCode; message: string } {
  if (err instanceof NoteError) return { error: err.code, message: err.message }
  return { error: 'internal', message: err instanceof Error ? err.message : String(err) }
}
