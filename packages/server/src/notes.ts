// Note service: the system's only write point (UI, API and MCP all go
// through here). Optimistic concurrency by hash, safe writes
// (fsutil.ts), lazy `uid` and deletion to trash.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { addToFrontmatterList, classifyPath, contentHash, hasControlCharacter, extract, folderOf, isIgnoredDir, isReserved, linkSpace, newUid, sameSpace, normKey, pathKeys, readFrontmatter, resolveImageRef, setFrontmatterKey, spaceRootOf, type AttachmentsConfig, type ErrorCode, type LinkIndex } from '@vihko/core'
import { commitText, createFile, followable, isPlainFile, linkNew, readStable, readText } from './fsutil.ts'
import { attachmentPath, noteAttachmentsDir, sniffImage, suffixedName } from './attachments.ts'
import { applyReplacements, beforeMoves, inTableRow, keptLinks, planImageRelinks, planLinks, planRelinks, rewriteLink, type ImageReplacement, type LinkReplacement, type Replacement, type Shift } from './relink.ts'
import type { Indexer } from './indexer.ts'
import type { RelinkRetries, RelinkRetry } from './relinkRetries.ts'
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

export type NoteErrorCode = 'not_found' | 'exists' | 'precondition_failed' | 'invalid_path' | 'control_characters' | 'edit_mismatch' | 'too_large' | 'note_too_large' | 'unsupported_type' | 'not_configured' | 'not_empty' | 'series_gone'

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
  /**
   * `rebased`: `ifMatch` named a text the note had a moment ago, and the
   * change was applied where nothing had changed since, in the text as it is now.
   */
  edit(path: string, fn: (text: string) => Change, opts: { ifMatch?: string; actor: Actor }): Promise<{ etag: string; rebased?: boolean }>
  /**
   * The note is deleted: flush what is pending, close its sessions and never
   * flush it again. `run`, the deletion itself, runs with the note flushed and
   * locked (if it throws, the note stays open). With `trash`, its editors are
   * told the trash entry once `run` is done.
   */
  discard(path: string, opts?: { ifMatch?: string; trash?: { id: string; actor: Actor }; run?: () => Promise<void> }): Promise<void>
  /**
   * The note is moved while open: `run` does the move on disk with the note
   * flushed and locked, and returns the text left at the destination.
   */
  move<T>(from: string, to: string, run: () => Promise<{ result: T; written: string | null }>): Promise<T>
  /** Notes moved (one, or every note of a folder): what the editor keeps of each one under its path follows it. */
  carrySaved?(moves: readonly { from: string; to: string }[]): void
  /** The name guard for aliases typed in an open note (NoteService.typedAliases), checked on each flush. */
  guardNames?(guard: (path: string, was: string, next: string, typist: { actor: Actor; mayName: (path: string) => boolean }) => TypedAliases | null): void
  /** A note deleted: what the editor keeps of it under its path goes. */
  forgetSaved?(path: string): void
}

/** Aliases typed in an open note, judged by the name guard (NoteService.typedAliases). */
export interface TypedAliases {
  /** The aliases added that can't be taken. */
  refused: string[]
  /** What to write instead: the typed text without the refused aliases. Null: as typed. */
  text: string | null
  /** Once it is written: the links the system keeps leading where they did. */
  after: () => Promise<void>
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
  /** Where new images of a note go: vihko.yaml's, or its space's settings for the notes of that space (noteSettings.ts). */
  attachments?: (notePath?: string) => AttachmentsConfig
  /** The history: every write is recorded with its actor (M2). */
  history?: NoteHistory
  /**
   * Link rewrites a move couldn't make and no alias can stand in for (other
   * spaces' links), tried again by `retryRelinks` after the next rescan.
   */
  retries?: RelinkRetries
  /** A retry that failed again: given up, for whoever made the move to be told. */
  onRelinkGaveUp?: (entry: RelinkRetry, failed: MoveReport['failed']) => void
  /** The largest note, in bytes (vihko.yaml `notes.maxSize`): a write that makes a note larger is refused. None by default. */
  maxNoteBytes?: () => number
}

export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024

export interface MoveReport {
  from: string
  to: string
  /**
   * Notes whose links are rewritten (or would be, in dryRun): number of links and
   * each change, text before and after, what it is (a link to a note, or a
   * reference to an image) and where it leads (`to`, from the notes root).
   */
  relinked: { path: string; links: number; changes: RelinkChange[] }[]
  /**
   * Links the move doesn't rewrite but whose resolution it changes: an
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
   * The moved note's images, when it changes folder; empty otherwise.
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
   * `copied`: when the note goes to another space, the images it
   * uses that would stay behind in the space it leaves (shared with other
   * notes, or in another folder of that space), where its new readers
   * wouldn't see them, are copied where a new image of it would go there
   * (next to it, its folder of images, or its new space's attachments
   * folder; a taken name gets a suffix) and the note links the
   * copies. Only images whoever moves it can read;
   * the rest stay (`stayed`).
   */
  images: {
    moved: { from: string; to: string }[]
    copied: { from: string; to: string }[]
    stayed: { path: string; reason: 'shared' | 'elsewhere' }[]
    folder: { from: string; to: string; files: number } | null
    failed: { path: string; to: string | null; outcome: 'stayed' | 'copied'; error: ErrorCode; message: string }[]
  }
  dryRun: boolean
  /** The moved note's ETag at its new path, as the move left it (its own links rewritten, the alias added); null in a dry run. */
  etag: string | null
}

/** One rewrite in a note: its text before and after, and the note (`link`) or image (`image`) it keeps leading to. */
export interface RelinkChange {
  before: string
  after: string
  kind: 'link' | 'image'
  to: string
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
  /**
   * When the folder goes to another space: the images its notes use
   * that stay behind in the space it leaves (outside the folder), copied
   * where a new image of each note that uses them would go (one
   * copy per such folder, a taken name gets a suffix), which then links the
   * copy; only images whoever moves it can
   * read. `failed`: a copy that couldn't be made (the note keeps linking the
   * original).
   */
  images: { copied: { from: string; to: string }[]; failed: MoveReport['images']['failed'] }
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
  /**
   * Which of the notes to rewrite the hooks count (all by default): whoever
   * follows a move learns how many of those, never of the rest.
   */
  counts?: (path: string) => boolean
}

/** Options of a folder move. `canRead`: whether whoever moves it may read a file (the images copied to another space); all by default. */
export interface FolderMoveOptions {
  actor: Actor
  dryRun?: boolean
  canRead?: (path: string) => boolean
  /** Whether a rewritten link may name this note: one whoever moves it can't read makes the move `exists`. All by default. */
  mayName?: (path: string) => boolean
}

/** Options of a note move. `canRead`: whether whoever moves it may read a file (the images copied to another space); all by default. */
export interface MoveOptions {
  ifMatch?: string
  actor: Actor
  dryRun?: boolean
  canRead?: (path: string) => boolean
  /** Whether a rewritten link may name this note: one whoever moves it can't read makes the move `exists`, as a taken name. All by default. */
  mayName?: (path: string) => boolean
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

/**
 * An entry in the trash: a note, with the files that went with it, or
 * (`kind: 'files'`) files alone.
 */
export interface TrashEntry {
  id: string
  /** The note's path; for files alone, the folder they were deleted from ('' for the root). */
  path: string
  deletedAt: string
  actor: Actor
  /** The note's ETag when it was deleted; absent for files alone. */
  etag?: string
  /** Files alone: what a folder sent to the trash with its notes held besides them, or a note's images that couldn't be restored with it. */
  kind?: 'files'
  /**
   * Files in the entry, by where they were: a note's images that no other note
   * used (what moving the note would take along), or a folder's files.
   * `stored`: its name in the entry's folder in the trash.
   */
  files?: { path: string; stored: string }[]
  /**
   * Who managed its shared space when the space was deleted (user ids):
   * once the space is gone, they still see and restore it.
   */
  managers?: string[]
}

/**
 * What restoring from the trash did: where the note is and its ETag (null
 * for files alone), the files that came back (`to` differs from `from` when
 * that name was taken meanwhile: it got a suffix and the note links it
 * there), and those left in the trash (`left`: where whoever restores can't
 * write, or where no name is free).
 */
export interface TrashRestoreReport {
  path: string
  etag: string | null
  files: { from: string; to: string }[]
  left: string[]
}

/**
 * What a folder holds, by what deleting it means for each (paths relative to
 * it). `notes` and `files` can go to the trash with it (`files` includes
 * hidden files, such as `.keep`). `hidden`: hidden folders (`.git/`,
 * `.obsidian/`, `.vihko/`, listed with a trailing `/`), which vihko doesn't
 * show; they go to the trash with it too, every file in them
 * (`hiddenFiles`), so whoever deletes the folder is told first. `kept`:
 * symbolic links (or stranger), anywhere in it, which vihko never follows or
 * removes: while there is one, the folder stays. `junk`: the operating
 * system's clutter (`.DS_Store`, `Thumbs.db`…), removed with the folder
 * without asking.
 */
export interface FolderContents {
  notes: string[]
  files: string[]
  hidden: string[]
  hiddenFiles: string[]
  kept: string[]
  junk: string[]
}

/**
 * A name taken by something spelled otherwise on a case-insensitive disk
 * (`path`: the disk's spelling), told only where the person sees the whole
 * folder.
 */
export class ExistsAs extends NoteError {
  readonly path: string
  constructor(path: string) {
    super('exists', `already exists as ${path}`)
    this.path = path
  }
}

/**
 * A note that isn't at `path` because vihko moved it a moment ago (`movedTo`,
 * NoteService.movedTo): `not_found`, saying where it went, to whoever reads
 * it there. An editor that followed one move missed the next while it
 * reopened the note (moved there and back).
 */
export class MovedAway extends NoteError {
  readonly movedTo: string
  constructor(path: string, to: string) {
    super('not_found', `${path} was moved to ${to}`)
    this.movedTo = to
  }
}

/** How long a move from vihko is remembered for MovedAway. */
export const RECENT_MOVE_MS = 120_000

/** A folder that can't be deleted as asked because of what it holds (`contents`, as the caller may show it). */
export class FolderNotEmpty extends NoteError {
  readonly contents: unknown
  constructor(path: string, contents: unknown) {
    super('not_empty', `the folder is not empty: ${path}`)
    this.contents = contents
  }
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
    // Aliases typed in the editor go through the same name guard as the API's and MCP's.
    opts.hot?.guardNames?.((path, was, next, typist) => this.typedAliases(path, was, next, typist))
  }

  /** The state volume: the trash is its `trash/` (folderRefs.ts rewrites its entries' paths when a folder moves). */
  /** Notes vihko moved lately: where each went, and when (MovedAway). */
  private recentMoves = new Map<string, { to: string; at: number }>()

  private remember(pairs: readonly { from: string; to: string }[]) {
    const now = Date.now()
    for (const [p, m] of this.recentMoves) if (now - m.at > RECENT_MOVE_MS) this.recentMoves.delete(p)
    for (const { from, to } of pairs) {
      this.recentMoves.set(from, { to, at: now })
      // Back where it was: that path holds the note again.
      this.recentMoves.delete(to)
    }
  }

  /**
   * Where the note that was at `path` a moment ago is now, if vihko moved it
   * (following one move after another, within RECENT_MOVE_MS) and it's
   * there; null otherwise. Whether the asker reads it is the caller's.
   */
  movedTo(path: string): string | null {
    const now = Date.now()
    let at = path
    for (let hops = 0; hops < 20; hops++) {
      const m = this.recentMoves.get(at)
      if (!m || now - m.at > RECENT_MOVE_MS || m.to === path) break
      at = m.to
    }
    return at !== path && this.isFile(at) ? at : null
  }

  get stateDir(): string {
    return this.opts.stateDir
  }

  /** Validates a note path: relative, no `..`, no hidden segments, ending in `.md` (and no NUL, which no file name holds). */
  static checkPath(path: string): string {
    if (typeof path !== 'string' || path === '') throw new NoteError('invalid_path', `invalid note path: ${String(path)}`)
    const norm = posix.normalize(path)
    if (path !== norm || path.startsWith('/') || path.includes('\0') || norm.split('/').includes('..') || classifyPath(norm) !== 'note' || isReserved(norm)) {
      throw new NoteError('invalid_path', `invalid note path: ${path}`)
    }
    return norm
  }

  /**
   * A name vihko is about to give (creating, moving, restoring to another
   * path): besides checkPath or checkFolder, no control characters. A file
   * that already has them is still read and written under its own name.
   */
  static checkNewName(path: string): void {
    if (typeof path === 'string' && hasControlCharacter(path)) throw new NoteError('control_characters', `a name with control characters: ${JSON.stringify(path)}`)
  }

  private file(path: string) {
    return NoteService.fileIn(this.opts.notesDir, path)
  }

  /**
   * The file of note `path` in `notesDir`: checkPath, and only a path vihko
   * follows (fsutil.ts followable: no symbolic link on the way, and on a
   * case-insensitive filesystem the disk's spelling of each name). Any other
   * doesn't exist for vihko, as it isn't in its index.
   */
  static fileIn(notesDir: string, path: string): string {
    const norm = NoteService.checkPath(path)
    if (!followable(notesDir, norm)) throw new NoteError('not_found', `does not exist: ${path}`)
    return join(notesDir, norm)
  }

  /** The file for a note vihko is about to name. */
  private newFile(path: string) {
    NoteService.checkNewName(path)
    return this.file(path)
  }

  /** Path of the note with that uid (if there are several, it's an identity conflict: rejected). */
  pathOfUid(uid: string): string {
    const rows = this.opts.db.prepare('select path from notes where uid = ?').all(uid) as { path: string }[]
    if (rows.length === 0) throw new NoteError('not_found', `no note with uid ${uid}`)
    if (rows.length > 1) throw new NoteError('not_found', `duplicate uid ${uid} in ${rows.map((r) => r.path).join(', ')}`)
    return rows[0]!.path
  }

  /** Whether a note is at `path` (on the disk, or open in an editor). */
  exists(path: string): boolean {
    return this.opts.hot?.has(path) === true || readText(this.file(path)) !== null
  }

  read(path: string): NoteRead {
    const text = readText(this.file(path))
    if (text === null) throw new NoteError('not_found', `does not exist: ${path}`)
    return { path, text, etag: contentHash(text) }
  }

  /**
   * The indexed links a note at `path` with `aliases` would take: those
   * that lead now to a note `mayName` refuses, or
   * are ambiguous among notes of which it refuses one, and would lead
   * elsewhere, or be ambiguous among others, once it is there. `keys`: the
   * names the change brings (all of a new note's; only the new aliases of an
   * edit).
   *
   * `refuse`: one of those links is in a note `mayName` accepts (whoever acts
   * reads it): keeping it would mean rewriting it with where it leads, which
   * they mustn't learn, so the change is refused as a taken name. `keep`: the
   * notes, none of them readable by whoever acts, holding the others that
   * led to one note; the system rewrites them (`keepLinks`) so each keeps
   * leading there, and nobody is told.
   */
  private linksTaken(path: string, aliases: string[], keys: Iterable<string>, mayName: (path: string) => boolean): LinksTaken {
    const now = this.opts.indexer.links
    const then = now.clone()
    then.set({ ...(now.get(path) ?? {}), path, aliases })
    const keep = new Set<string>()
    const byKey = this.opts.db.prepare('select src_path, kind, target, anchor from links where key = ?')
    for (const key of new Set(keys)) {
      for (const l of byKey.all(key) as { src_path: string; kind: 'wiki' | 'embed' | 'markdown'; target: string; anchor: string | null }[]) {
        const before = now.resolve(l.src_path, l)
        const hidden = before.status === 'resolved' ? !mayName(before.path) : before.status === 'ambiguous' && !before.candidates.every(mayName)
        if (!hidden) continue
        const after = then.resolve(l.src_path, l)
        const same = before.status === 'resolved'
          ? after.status === 'resolved' && after.path === before.path
          : after.status === 'ambiguous' && before.status === 'ambiguous' && after.candidates.join('\n') === before.candidates.join('\n')
        if (same) continue
        if (mayName(l.src_path)) return { refuse: true, keep: [], before: now, after: then, mayName }
        // An ambiguous link led to no one note: there is nothing to keep it on.
        if (before.status === 'resolved') keep.add(l.src_path)
      }
    }
    return { refuse: false, keep: [...keep].sort(), before: keep.size ? now.clone() : now, after: then, mayName }
  }

  /** `linksTaken` for an edit of the note at `path` from `was` to `next`: only the aliases it adds count. */
  private aliasesTaken(path: string, was: string, next: string, mayName: (path: string) => boolean): LinksTaken | null {
    if (!this.opts.indexer.linkAliases) return null
    const had = new Set(this.opts.indexer.aliasesIn(was).map(normKey))
    const aliases = this.opts.indexer.aliasesIn(next)
    const added = aliases.map(normKey).filter((k) => !had.has(k))
    return added.length ? this.linksTaken(path, aliases, added, mayName) : null
  }

  /**
   * The name guard for aliases typed in an open note (the hub's flush, which
   * writes what its editors typed): what `edit` does for an alias added
   * through the API or MCP, for whoever typed (`typist`). An alias that would
   * change where a link in a note they read leads, to what they can't read,
   * is refused: `text` is what to write instead, `next` without it. The
   * others are taken, and `after` (once written) has the system keep the
   * links of the notes they can't read leading where they did. Null when
   * the text adds no alias.
   */
  typedAliases(path: string, was: string, next: string, typist: { actor: Actor; mayName: (path: string) => boolean }): TypedAliases | null {
    if (!this.opts.indexer.linkAliases) return null
    const had = new Set(this.opts.indexer.aliasesIn(was).map(normKey))
    const aliases = this.opts.indexer.aliasesIn(next)
    const added = aliases.filter((a) => !had.has(normKey(a)))
    if (added.length === 0) return null
    const kept = aliases.filter((a) => had.has(normKey(a)))
    const refused = added.filter((a) => this.linksTaken(path, [...kept, a], [normKey(a)], typist.mayName).refuse)
    const taken = aliases.filter((a) => !refused.includes(a))
    // Its aliases were just read from it, so its frontmatter can be patched (setFrontmatterKey checks it).
    const text = refused.length ? setFrontmatterKey(next, this.opts.indexer.aliasesKey, taken) : null
    const fresh = taken.filter((a) => !had.has(normKey(a)))
    const keep = fresh.length ? this.linksTaken(path, taken, fresh.map(normKey), typist.mayName) : null
    return { refused, text, after: () => this.keepLinks(keep, path, typist.actor) }
  }

  /**
   * The rewrites `linksTaken` left to the system, once the note at `path`
   * has its name: each of those links keeps leading to its note, as any
   * rewrite. A rewrite that fails leaves that link as the change left it.
   */
  private async keepLinks(taken: LinksTaken | null, path: string, actor: Actor): Promise<void> {
    if (!taken || taken.keep.length === 0) return
    const system: Actor = { kind: 'system', reason: { code: 'links_kept', to: path, by: actor } }
    const failed: MoveReport['failed'] = []
    const plan = (text: string, src: string) => relinkSplices(text, planLinks(text, src, src, taken.before, taken.after, (p) => p).reps.filter((r) => !taken.mayName(r.target)))
    await this.history.operation(system, null, () => this.rewriteAll(taken.keep.map((src) => ({ path: src, change: (t: string) => plan(t, src) })), system, failed))
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
   *
   * A name in use answers `exists` without anything of the note there. With
   * `mayName`, a name (or an alias in the text) that would change where an
   * existing link leads, or make it ambiguous, when it leads to a note
   * `mayName` refuses (so that no name tells what exists): if that link is in a note whoever
   * creates reads, `exists` too (keeping it would show them where it leads,
   * and the answer mustn't tell it apart from a taken name); if it isn't,
   * the note is created and the system rewrites that link so it keeps
   * leading where it did, without saying so.
   */
  /** Unless a note's text fits the size limit (vihko.yaml `notes.maxSize`): `note_too_large`. */
  checkSize(text: string): void {
    const max = this.opts.maxNoteBytes?.()
    // Never more than 3 bytes of UTF-8 per UTF-16 unit: a short text needs no counting.
    if (max === undefined || text.length * 3 <= max) return
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > max) throw new NoteError('note_too_large', `the note would be ${bytes} bytes; notes are kept up to ${max} bytes here`)
  }

  async create(path: string, text: string, actor: Actor, opts: { freshUid?: boolean; reason?: Reason; mayName?: (path: string) => boolean } = {}): Promise<{ path: string; etag: string; uid: string | null }> {
    this.checkSize(text)
    const file = this.newFile(path)
    const taken = opts.mayName ? this.newNoteTakes(path, text, opts.mayName) : null
    if (taken?.refuse) throw nameTaken(path)
    mkdirSync(dirname(file), { recursive: true })
    if (opts.freshUid && this.uidIn(text)) text = setFrontmatterKey(text, this.uidKey, newUid())
    const withUid = this.ensureUid(text, null)
    const w = this.history.prepare([{ path, after: withUid.text }], { actor, reason: opts.reason, immediate: true })
    const r = await commitText(file, withUid.text, null).catch((err) => { w.abort(); throw err })
    if (!r.ok) {
      w.abort()
      throw nameTaken(path)
    }
    w.done()
    this.opts.indexer.indexPaths([path])
    await this.keepLinks(taken, path, actor)
    return { path, etag: contentHash(withUid.text), uid: withUid.uid }
  }

  /** `linksTaken` for a new note at `path` with `text`: its name, its path's suffixes and its aliases. */
  private newNoteTakes(path: string, text: string, mayName: (path: string) => boolean): LinksTaken {
    const aliases = this.opts.indexer.aliasesIn(text)
    return this.linksTaken(path, aliases, [...pathKeys(path), ...aliases.map(normKey)], mayName)
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
  async edit(path: string, given: (text: string) => Change, opts: { ifMatch?: string; actor: Actor; mayName?: (path: string) => boolean }): Promise<{ etag: string; rebased?: boolean }> {
    // A note never grows over the size limit by an edit (`note_too_large`); one already over it is never made larger.
    const fn = (t: string): Change => {
      const change = given(t)
      const next = changedText(t, change)
      if (next.length > t.length) this.checkSize(next)
      return change
    }
    // An alias the edit adds is a name the note takes, as when creating one.
    const mayName = opts.mayName
    if (mayName) {
      let taken: LinksTaken | null = null
      const r = await this.editNow(path, (t) => {
        const change = fn(t)
        taken = this.aliasesTaken(path, t, changedText(t, change), mayName)
        if (taken?.refuse) throw new NoteError('exists', `that alias isn't available here: ${path}`)
        return change
      }, { ifMatch: opts.ifMatch, actor: opts.actor })
      await this.keepLinks(taken, path, opts.actor)
      return r
    }
    return this.editNow(path, fn, { ifMatch: opts.ifMatch, actor: opts.actor })
  }

  private async editNow(path: string, fn: (text: string) => Change, opts: { ifMatch?: string; actor: Actor }): Promise<{ etag: string; rebased?: boolean }> {
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

  /**
   * Moves the note to the state volume's trash, with the files that go with
   * it (`filesGoingWith`: its images no other note uses, as a move would take
   * them), all in one entry and one version. `canWrite` says which files the
   * one deleting may take (an agent, within its key's folders).
   */
  async delete(path: string, opts: { ifMatch?: string; actor: Actor; canWrite?: (path: string) => boolean; managers?: string[] }): Promise<TrashEntry> {
    const id = newUid()
    // Open in the editor: flushed and closed, and its editors told the trash entry once it's all in the trash.
    if (this.opts.hot?.has(path)) {
      let entry: TrashEntry | null = null
      await this.opts.hot.discard(path, { ifMatch: opts.ifMatch, trash: { id, actor: opts.actor }, run: async () => { entry = await this.trashNow(path, id, opts) } })
      // Closed meanwhile (the hub had nothing open by then): deleted all the same.
      return entry ?? this.trashNow(path, id, opts)
    }
    return this.trashNow(path, id, opts)
  }

  /** The deletion of `delete`, with the trash entry's `id`. */
  private async trashNow(path: string, id: string, opts: { ifMatch?: string; actor: Actor; canWrite?: (path: string) => boolean; managers?: string[] }): Promise<TrashEntry> {
    const file = this.file(path)
    const current = await readStable(file)
    if (current === null) throw new NoteError('not_found', `does not exist: ${path}`)
    const hash = contentHash(current)
    if (opts.ifMatch !== undefined && opts.ifMatch !== hash) throw new NoteError('precondition_failed', `the note has changed: ${path}`, hash)
    const going = this.filesGoingWith(current, path, opts.canWrite ?? (() => true))

    // First it's set aside within the same filesystem (atomic rename), then we
    // check that what was set aside is what was meant to be deleted.
    const aside = asideOf(file)
    const deleted = (files: readonly string[]): FileChange[] => [{ path, before: current, after: null }, ...files.map((p) => ({ path: p, after: null }))]
    const w = this.history.prepare(deleted(going), { actor: opts.actor, immediate: true })
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
    const files = this.setAside(going)
    const entry: TrashEntry = { id, path, deletedAt: new Date().toISOString(), actor: opts.actor, etag: hash, ...(opts.managers ? { managers: opts.managers } : {}) }
    try {
      this.toTrash(entry, moved, files)
    } catch (err) {
      // The trash can't take it (a full disk): everything goes back.
      this.putBack(files)
      this.putBack([{ path, aside }])
      w.abort()
      throw err
    }
    w.done(files.length === going.length ? undefined : deleted(files.map((f) => f.path)))
    rmSync(aside)
    for (const f of files) rmSync(f.aside, { force: true })
    this.removeEmptyAssets(path)
    this.opts.indexer.indexPaths([path, ...files.map((f) => f.path)])
    this.opts.hot?.forgetSaved?.(path)
    return entry
  }

  /**
   * What goes to the trash with a note: what a move of the note would take
   * along, the images next to it that no other note uses and, in
   * `per-note` mode, the files in its own folder of images that no other note
   * uses. Never a file in the shared attachments folder of vihko.yaml, nor
   * one `canWrite` refuses.
   */
  private filesGoingWith(text: string, path: string, canWrite: (path: string) => boolean): string[] {
    // The fixed folder is each space's own (attachments.ts `attachmentPath`).
    const folder = this.opts.attachments?.(path).folder ?? null
    const space = spaceRootOf(path)
    const shared = folder === null ? null : space === null ? folder : `${space}/${folder}`
    const inShared = (p: string) => shared !== null && p.startsWith(shared + '/')
    // Its folder of images, unless it holds notes (as when moving) or is a link vihko doesn't follow.
    const assets = this.assetsOf(path)
    const own = assets !== null && !assets.holdsNotes && followable(this.opts.notesDir, assets.dir) ? assets.dir : null
    const going = new Set<string>()
    for (const img of this.imagesOf(text, path)) {
      if ((img.beside || (own !== null && img.path.startsWith(own + '/'))) && !img.shared()) going.add(img.path)
    }
    if (own !== null) {
      for (const rel of assets!.files) {
        const p = `${own}/${rel}`
        if (classifyPath(p) === 'other' && !this.usedByOthers(p, path)) going.add(p)
      }
    }
    return [...going].filter((p) => !inShared(p) && canWrite(p) && this.isFile(p)).sort()
  }

  /** Sets files aside next to where they are (a hidden name, same filesystem); one gone meanwhile is left out. */
  private setAside(paths: readonly string[]): { path: string; aside: string }[] {
    const out: { path: string; aside: string }[] = []
    for (const path of paths) {
      const abs = join(this.opts.notesDir, path)
      const aside = asideOf(abs)
      try {
        renameSync(abs, aside)
        out.push({ path, aside })
      } catch { /* gone meanwhile: nothing to take */ }
    }
    return out
  }

  /** Puts files set aside back under their names, never over a file that took one meanwhile (that one stays aside, hidden). */
  private putBack(files: readonly { path: string; aside: string }[]) {
    for (const f of files) {
      try {
        if (linkNew(f.aside, join(this.opts.notesDir, f.path))) rmSync(f.aside)
      } catch { /* left aside, whole */ }
    }
  }

  /** Writes a trash entry: the note's text (unless it's files alone), the files set aside, and meta.json last (what makes it an entry). */
  private toTrash(entry: TrashEntry, text: string | null, files: readonly { path: string; aside: string }[]) {
    const dir = join(this.opts.stateDir, 'trash', entry.id)
    try {
      mkdirSync(dir, { recursive: true })
      if (text !== null) writeFileSync(join(dir, 'note.md'), text)
      if (files.length) {
        mkdirSync(join(dir, 'files'))
        entry.files = files.map((f, i) => ({ path: f.path, stored: `files/${i + 1}-${posix.basename(f.path)}` }))
        files.forEach((f, i) => copyFileSync(f.aside, join(dir, entry.files![i]!.stored)))
      }
      writeFileSync(join(dir, 'meta.json'), JSON.stringify(entry, null, 2))
    } catch (err) {
      delete entry.files
      rmSync(dir, { recursive: true, force: true })
      throw err
    }
  }

  /** In `per-note` mode, the note's folder of images once nothing is left in it (empty subfolders go too). */
  private removeEmptyAssets(path: string) {
    const assets = this.assetsOf(path)
    if (assets === null || assets.files.length || !followable(this.opts.notesDir, assets.dir)) return
    try {
      removeEmptyTree(join(this.opts.notesDir, assets.dir))
    } catch { /* something landed in it meanwhile: it stays */ }
    this.opts.indexer.indexFolders([assets.dir])
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
  async move(from: string, to: string, opts: MoveOptions & MoveHooks): Promise<MoveReport> {
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
      hot?.carrySaved?.([{ from, to }])
      this.remember([{ from, to }])
      const { report, others, before, after, map, place } = moved
      opts.onMoved?.(counted(others, opts.counts))

      // The rest of the notes, as the system. The plan is recalculated over the
      // current text: links to the note, and references to images in its folder of images.
      const reason: RelinkRetry['reason'] = { code: 'note_moved', from, to, by: opts.actor }
      const system: Actor = { kind: 'system', reason }
      await this.history.operation(system, null, () =>
        this.rewriteAll(others.map((src) => ({ path: src, change: (t: string) => movedNotePlan(t, src, src, before, after, map, place).splices })), system, report.failed, opts.onProgress, opts.counts))

      // Safety net: if something couldn't be rewritten, the old name stays as an alias.
      // Not when aliases don't resolve links (vihko.yaml): it would save nothing. Nor
      // when the note changed space: nothing is rewritten across spaces, the links
      // left behind are broken on purpose (links never leave their space), and an alias only reaches the
      // notes of its own space.
      const oldName = posix.basename(from).replace(/\.md$/i, '')
      const newName = posix.basename(to).replace(/\.md$/i, '')
      const within = sameSpace(from, to)
      const leftBehind = report.failed.filter((f) => f.path !== to)
      if (within && leftBehind.length > 0 && oldName !== newName && this.opts.indexer.linkAliases) {
        try {
          const aliasActor: Actor = { kind: 'system', reason: { code: 'alias_added', alias: oldName, from, to, by: opts.actor } }
          report.etag = (await this.edit(to, (t) => addToFrontmatterList(t, 'aliases', oldName), { actor: aliasActor })).etag
          report.aliasAdded = oldName
        } catch (err) {
          const f = failure(err)
          report.failed.push({ path: to, error: f.error, message: `could not add the alias: ${f.message}` })
        }
      }
      // What the alias doesn't stand in for is tried again after the next rescan.
      const covered = report.aliasAdded !== null
      this.opts.retries?.record({ reason, moves: [{ from, to }], sources: covered ? [] : leftBehind.map((f) => f.path) })
      return report
    })
  }

  /**
   * Tries again the link rewrites moves couldn't make (RelinkRetries), each
   * by the rule of its move over the notes as they are now (as the links
   * after a move made outside vihko are, `relinkMoved`), as the system, only
   * in the notes that failed. Once per failure: what fails again is given
   * up (`onRelinkGaveUp`). Moves no longer in place (the note moved on, or is
   * back) have nothing left to do. Called after each rescan.
   */
  async retryRelinks(): Promise<void> {
    const retries = this.opts.retries
    if (!retries) return
    for (const entry of retries.list()) {
      await this.oneMoveAtATime(async () => {
        const plan = this.planMoved(entry.moves)
        const wanted = new Set(entry.sources)
        const items = plan.items.filter((i) => wanted.has(i.path))
        const failed: MoveReport['failed'] = []
        const system: Actor = { kind: 'system', reason: entry.reason }
        if (items.length) await this.history.operation(system, null, () => this.rewriteAll(items, system, failed))
        retries.drop(entry.id)
        if (failed.length) this.opts.onRelinkGaveUp?.(entry, failed)
      })
    }
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
  private async rewriteAll(items: { path: string; change: (text: string) => Change }[], system: Actor, failed: MoveReport['failed'], onProgress?: MoveHooks['onProgress'], counts?: MoveHooks['counts']) {
    let done = 0
    const total = counted(items.map((i) => i.path), counts)
    onProgress?.(0, total)
    await inPool(items, async ({ path, change }) => {
      try {
        await this.edit(path, change, { actor: system })
      } catch (err) {
        failed.push({ path, ...failure(err) })
      }
      if (!counts || counts(path)) onProgress?.(++done, total)
    })
    failed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }

  /** The move itself (or, with dryRun, its plan), and what the rewrites of the other notes need. */
  private async moveNow(from: string, to: string, opts: MoveOptions) {
    const fromFile = this.file(from)
    const toFile = this.newFile(to)
    const text = await readStable(fromFile)
    if (text === null) throw new NoteError('not_found', `does not exist: ${from}`)
    if (readText(toFile) !== null) throw nameTaken(to)
    const hash = contentHash(text)
    if (opts.ifMatch !== undefined && opts.ifMatch !== hash) throw new NoteError('precondition_failed', `the note has changed: ${from}`, hash)

    const assets = this.planAssets(from, to)
    const { before, after, map, sources } = this.relinkContext(new Map([[from, to]]), assets.folder?.from ?? null)

    const report: MoveReport = { from, to, relinked: [], shifted: [], kept: [], failed: [], aliasAdded: null, images: { moved: [], copied: [], stayed: [], folder: null, failed: [] }, dryRun: !!opts.dryRun, etag: null }
    const imagePlan = this.planImages(text, from, to, assets.folder?.from ?? null, opts.canRead)
    report.images = { moved: imagePlan.moved, copied: imagePlan.copied, stayed: imagePlan.stayed, folder: assets.folder, failed: [...assets.failed, ...imagePlan.unplaceable] }
    const planned = movedNotePlan(text, from, to, before, after, map, placeOf([...imagePlan.moved, ...imagePlan.copied], assets.folder))
    // The moved note names itself by where it goes: judged where it was (whoever moves it reads it).
    const guard = nameGuard(opts.mayName && ((p) => opts.mayName!(p === to ? from : p)), !!opts.dryRun)
    const ownChanges = guard.shown(from, planned)
    if (ownChanges.length) report.relinked.push({ path: to, links: ownChanges.length, changes: ownChanges })
    addShifts(report.shifted, to, planned.shifts)
    const others: string[] = []
    for (const src of sources) {
      const t = readText(this.file(src))
      if (t === null) continue
      const plan = movedNotePlan(t, src, src, before, after, map, placeOf([], assets.folder))
      const shown = guard.shown(src, plan)
      if (plan.changes.length) others.push(src)
      if (shown.length) report.relinked.push({ path: src, links: shown.length, changes: shown })
      addShifts(report.shifted, src, plan.shifts)
      for (const k of keptLinks(t, src, before, after, from, to)) report.kept.push({ path: src, ...k })
    }
    if (guard.refused) throw nameTaken(to)
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
    // Copies of what stays behind in the space it leaves: new files, gone again if the note can't move.
    // They go where a new image of the note would (copiesDir), its folder of images already in place.
    const copies = this.copyImages(imagePlan.copied, this.copiesDir(to), report)
    report.images.copied = copies.map(({ from, to }) => ({ from, to }))
    const unplace = () => {
      for (const p of [...placed, ...copies]) rmSync(join(this.opts.notesDir, p.to), { force: true })
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
    const final = movedNotePlan(text, from, to, before, after, map, placeOf([...placed, ...copies], folder))
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
      ...copies.map((c) => ({ path: c.to, before: null, after: c.bytes })),
      ...(folder ? [{ path: folder.to, from: folder.from, folder: true }] : []),
    ]
    const w = this.history.prepare(moved, { actor: opts.actor, immediate: true })
    try {
      mkdirSync(dirname(toFile), { recursive: true })
      const created = await commitText(toFile, newText, null)
      if (!created.ok) throw nameTaken(to)
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
   * Fixes where one ambiguous link leads, only on an explicit
   * request: the occurrence of `link.raw` in the note nearest to `link.at`
   * (the first one without it) is rewritten to the shortest form that, from
   * this note, leads to `target` alone, keeping its anchor and visible text.
   * `target` must be one of the link's candidates now; if the link already
   * leads there, nothing is written. On an open note it's an exact splice in
   * the live document. Returns the link as it is written now.
   */
  async pinLink(path: string, link: { raw: string; at?: number }, target: string, opts: { actor: Actor; sees?: (path: string) => boolean }): Promise<{ etag: string; raw: string }> {
    let raw = link.raw
    const r = await this.edit(path, (text) => {
      const index = this.opts.indexer.links
      const occurrence = nearest(extract(text).links.filter((l) => l.raw === link.raw && l.kind !== 'markdown'), link.at)
      if (!occurrence) throw new NoteError('edit_mismatch', `no link ${link.raw} in ${path}`)
      const now = index.resolve(path, occurrence)
      if (now.status === 'resolved' && now.path === target) return []
      // Ambiguous for whoever asks only if they see every candidate: otherwise, for them, it is broken.
      if (now.status !== 'ambiguous' || !now.candidates.includes(target) || (opts.sees && !now.candidates.every(opts.sees))) {
        throw new NoteError('edit_mismatch', `${link.raw} in ${path} is not ambiguous with ${target} among its candidates`)
      }
      const next = rewriteLink(occurrence, path, target, index, { inTable: inTableRow(text, occurrence.from) })
      if (next === null) throw new NoteError('edit_mismatch', `no form of ${link.raw} leads to ${target} from ${path}`)
      raw = next
      return [spliceOf(text, occurrence.from, occurrence.to, next)]
    }, { actor: opts.actor })
    return { etag: r.etag, raw }
  }

  /**
   * Updates the links after notes moved outside vihko: the rewrites
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
      opts.onMoved?.(counted(plan.items.map((i) => i.path), opts.counts))
      const system: Actor = { kind: 'system', reason: { code: 'links_after_external_move', moves: plan.moves, by: opts.actor } }
      await this.history.operation(system, null, () => this.rewriteAll(plan.items, system, report.failed, opts.onProgress, opts.counts))
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
      return { splices: relinkSplices(text, all), changes: [...changesOf(text, reps), ...imageReps.map(imageChange)], shifts }
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

  /** Validates a folder path: relative, no `..`, no hidden segments, not the root and not named like a note (and no NUL). */
  static checkFolder(path: string): string {
    if (typeof path !== 'string' || path === '') throw new NoteError('invalid_path', `invalid folder path: ${String(path)}`)
    const norm = posix.normalize(path)
    if (path !== norm || path.startsWith('/') || path.endsWith('/') || path.includes('\0') || norm.split('/').includes('..') || classifyPath(norm) !== 'other' || isReserved(norm)) {
      throw new NoteError('invalid_path', `invalid folder path: ${path}`)
    }
    return norm
  }

  private dir(path: string) {
    const norm = NoteService.checkFolder(path)
    if (!followable(this.opts.notesDir, norm)) throw new NoteError('not_found', `does not exist: ${path}`)
    return join(this.opts.notesDir, norm)
  }

  /** The directory for a folder vihko is about to name. */
  private newDir(path: string) {
    NoteService.checkNewName(path)
    return this.dir(path)
  }

  /** Creates an empty folder (and its missing parents). Never reuses an existing one. */
  createFolder(path: string, _actor: Actor): { path: string } {
    const dir = this.newDir(path)
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

  /** What a folder holds (see FolderContents), never looking inside what vihko doesn't follow. */
  folderContents(path: string): FolderContents {
    const dir = this.dir(path)
    if (!isDirectory(dir)) throw new NoteError('not_found', `no such folder: ${path}`)
    const out: FolderContents = { notes: [], files: [], hidden: [], hiddenFiles: [], kept: [], junk: [] }
    // `inHidden`: inside a hidden folder, where every file is the hidden folder's, whatever its name.
    const visit = (rel: string, inHidden: boolean) => {
      for (const e of readdirSync(rel ? join(dir, rel) : dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) {
          if (!inHidden && isIgnoredDir(e.name)) out.hidden.push(`${r}/`)
          visit(r, inHidden || isIgnoredDir(e.name))
        } else if (!e.isFile()) out.kept.push(r) // a symbolic link (or stranger): never followed, never removed
        else if (inHidden) out.hiddenFiles.push(r)
        else if (isJunk(e.name)) out.junk.push(r)
        else if (classifyPath(`${path}/${r}`) === 'note') out.notes.push(r)
        else out.files.push(r)
      }
    }
    visit('', false)
    for (const list of Object.values(out)) list.sort()
    return out
  }

  /**
   * Deletes a folder that holds nothing but empty subfolders and the
   * system's clutter (FolderContents `junk`), which go with it. Anything else
   * stops it with `not_empty`: to take the notes and files along, `trashFolder`.
   */
  deleteFolder(path: string, _actor: Actor): { path: string } {
    const c = this.folderContents(path)
    if (c.notes.length || c.files.length || c.hidden.length || c.kept.length) throw new NoteError('not_empty', `the folder is not empty: ${path}`)
    this.removeFolder(path, c.junk)
    return { path }
  }

  /**
   * Deletes a folder with everything in it: each note goes to the trash as if
   * deleted on its own (with its images, one entry each), then the other
   * files left, hidden ones and those of its hidden folders included, as one
   * entry of files alone (restoring it brings them back where they were);
   * then the folder, with its clutter. A symbolic link anywhere in it
   * (FolderContents `kept`) stops it before anything moves. `canWrite` is
   * passed on to each note's deletion. One version in the history (hidden
   * files have none).
   */
  async trashFolder(path: string, actor: Actor, opts: { canWrite?: (path: string) => boolean; managers?: string[] } = {}): Promise<{ path: string; trashed: TrashEntry[] }> {
    const c = this.folderContents(path)
    if (c.kept.length) throw new NoteError('not_empty', `the folder holds links vihko never follows: ${path}`)
    return this.history.operation(actor, null, async () => {
      const trashed: TrashEntry[] = []
      for (const rel of c.notes) {
        try {
          trashed.push(await this.delete(`${path}/${rel}`, { actor, canWrite: opts.canWrite, managers: opts.managers }))
        } catch (err) {
          if (!(err instanceof NoteError && err.code === 'not_found')) throw err // gone meanwhile: nothing to trash
        }
      }
      // What is left once the notes took their images: anything that came meanwhile is seen here.
      const rest = this.folderContents(path)
      if (rest.notes.length || rest.kept.length) throw new NoteError('not_empty', `the folder is not empty: ${path}`)
      const files = [...rest.files, ...rest.hiddenFiles]
      if (files.length) {
        const entry = this.trashFiles(path, files.map((r) => `${path}/${r}`), actor, opts.managers)
        if (entry) trashed.push(entry)
      }
      this.removeFolder(path, rest.junk)
      return { path, trashed }
    })
  }

  /**
   * Something hidden at the root of `folder` (`name`: a person's `.vihko/`,
   * which doesn't come along when their space becomes a shared one) to the
   * trash instead of being lost: its files as one entry of files alone, as
   * `trashFolder` takes a hidden folder; then what is left of it (empty
   * folders, and symbolic links, removed and never followed). Null if it had
   * no file.
   */
  async trashHidden(folder: string, name: string, actor: Actor): Promise<TrashEntry | null> {
    const root = join(this.dir(folder), name)
    let kind: 'folder' | 'file' | 'other'
    try {
      const st = lstatSync(root)
      kind = st.isDirectory() ? 'folder' : st.isFile() ? 'file' : 'other'
    } catch {
      return null
    }
    const files: string[] = []
    const walk = (rel: string) => {
      for (const e of readdirSync(rel ? join(root, rel) : root, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) walk(r)
        else if (e.isFile()) files.push(`${folder}/${name}/${r}`)
      }
    }
    if (kind === 'folder') walk('')
    else if (kind === 'file') files.push(`${folder}/${name}`)
    return this.history.operation(actor, null, async () => {
      const entry = files.length ? this.trashFiles(folder, files, actor) : null
      if (kind !== 'file') rmSync(root, { recursive: true, force: true })
      return entry
    })
  }

  /** Files alone to the trash, as one entry (`kind: 'files'`, `path` the folder they're in); null if none was left to take. */
  private trashFiles(folder: string, paths: readonly string[], actor: Actor, managers?: string[]): TrashEntry | null {
    const w = this.history.prepare(paths.map((p) => ({ path: p, after: null })), { actor, immediate: true })
    const files = this.setAside(paths)
    if (files.length === 0) {
      w.abort()
      return null
    }
    const entry: TrashEntry = { id: newUid(), kind: 'files', path: folder, deletedAt: new Date().toISOString(), actor, ...(managers ? { managers } : {}) }
    try {
      this.toTrash(entry, null, files)
    } catch (err) {
      this.putBack(files)
      w.abort()
      throw err
    }
    w.done(files.map((f) => ({ path: f.path, after: null })))
    for (const f of files) rmSync(f.aside, { force: true })
    this.opts.indexer.indexPaths(files.map((f) => f.path))
    return entry
  }

  /** Removes a folder of empty subfolders, after its clutter. Something created meanwhile stops it (rmdir never removes a file). */
  private removeFolder(path: string, junk: readonly string[]) {
    const dir = this.dir(path)
    try {
      for (const j of junk) rmSync(join(dir, j), { force: true })
      removeEmptyTree(dir)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOTEMPTY' || code === 'EEXIST') throw new NoteError('not_empty', `the folder is not empty: ${path}`)
      throw err
    } finally {
      this.opts.indexer.indexFolders([path])
    }
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
  async moveFolder(from: string, to: string, opts: FolderMoveOptions & MoveHooks): Promise<FolderMoveReport> {
    if (opts.dryRun) return this.moveFolderNow(from, to, opts)
    return this.oneMoveAtATime(() => this.moveFolderNow(from, to, opts))
  }

  private async moveFolderNow(from: string, to: string, opts: FolderMoveOptions & MoveHooks): Promise<FolderMoveReport> {
    const fromDir = this.dir(from)
    const toDir = this.newDir(to)
    if (from === to || to.startsWith(from + '/')) throw new NoteError('invalid_path', `cannot move ${from} into itself`)
    if (!isDirectory(fromDir)) throw new NoteError('not_found', `no such folder: ${from}`)
    if (existsSync(toDir)) throw nameTaken(to)

    const inside = listFiles(fromDir)
    const notesInside = inside.filter((p) => classifyPath(`${from}/${p}`) === 'note')
    const moves = new Map(notesInside.map((p) => [`${from}/${p}`, `${to}/${p}`]))
    const { before, after, map, sources } = this.relinkContext(moves, from)
    const place = (p: string) => (p.startsWith(from + '/') ? to + p.slice(from.length) : p)

    const report: FolderMoveReport = {
      from, to, notes: [...moves].map(([f, t]) => ({ from: f, to: t })),
      files: inside.filter((p) => classifyPath(`${from}/${p}`) === 'other').length,
      filePaths: inside.filter((p) => classifyPath(`${from}/${p}`) === 'other').map((p) => `${from}/${p}`),
      relinked: [], shifted: [], failed: [], images: { copied: [], failed: [] }, dryRun: !!opts.dryRun,
    }
    const copies = this.planFolderCopies(moves, from, to, opts.canRead)
    report.images.copied = [...copies.planned.values()]
    const own: [string, string][] = []
    // The moved notes name themselves by where they go: judged where they were (whoever moves them reads them).
    const guard = nameGuard(opts.mayName && ((p) => opts.mayName!(p === to || p.startsWith(to + '/') ? from + p.slice(to.length) : p)), !!opts.dryRun)
    for (const [f, t] of moves) {
      const text = readText(join(this.opts.notesDir, f))
      if (text === null) continue
      const plan = movedNotePlan(text, f, t, before, after, map, copies.placeFor(f, t, place))
      const shown = guard.shown(f, plan)
      if (plan.changes.length) own.push([f, t])
      if (shown.length) report.relinked.push({ path: t, links: shown.length, changes: shown })
      addShifts(report.shifted, t, plan.shifts)
    }
    const others: string[] = []
    for (const src of sources) {
      const text = readText(this.file(src))
      if (text === null) continue
      const plan = movedNotePlan(text, src, src, before, after, map, place)
      const shown = guard.shown(src, plan)
      if (plan.changes.length) others.push(src)
      if (shown.length) report.relinked.push({ path: src, links: shown.length, changes: shown })
      addShifts(report.shifted, src, plan.shifts)
    }
    if (guard.refused) throw nameTaken(to)
    report.shifted.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    if (opts.dryRun) return report

    const reason: RelinkRetry['reason'] = { code: 'folder_moved', from, to, by: opts.actor }
    const system: Actor = { kind: 'system', reason }
    // 1. One rename moves everything. The destination is claimed first with an
    // empty folder (mkdir never reuses one), which the rename then replaces:
    // anything that lands there meanwhile makes the rename fail, never overwritten.
    const run = async () => {
      mkdirSync(dirname(toDir), { recursive: true })
      try {
        mkdirSync(toDir)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw nameTaken(to)
        throw err
      }
      const w = this.history.prepare([{ path: to, from, folder: true }], { actor: opts.actor, immediate: true })
      try {
        renameSync(fromDir, toDir)
      } catch (err) {
        w.abort()
        try { rmdirSync(toDir) } catch { /* not ours any more: left as it is */ }
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOTEMPTY' || code === 'EEXIST') throw nameTaken(to)
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
    hot?.carrySaved?.(report.notes)
    this.remember(report.notes)
    // The copies of what stays behind in the space it leaves, now that their folders are there.
    report.images = this.makeFolderCopies(copies.planned, opts.actor)
    copies.settle(report.images.copied)
    opts.onMoved?.(counted([...own.map(([, t]) => t), ...others], opts.counts))

    // 2. The moved notes' own links and image references, then the rest of the
    // notes, as the system, recalculated over the current text.
    await this.history.operation(system, null, () => this.rewriteAll([
      ...own.map(([f, t]) => ({ path: t, change: (x: string) => movedNotePlan(x, f, t, before, after, map, copies.placeFor(f, t, place)).splices })),
      ...others.map((src) => ({ path: src, change: (x: string) => movedNotePlan(x, src, src, before, after, map, place).splices })),
    ], system, report.failed, opts.onProgress, opts.counts))
    // No alias stands in for a folder's notes: what failed is tried again after the next rescan.
    this.opts.retries?.record({ reason, moves: report.notes, sources: report.failed.map((f) => f.path) })
    return report
  }

  /**
   * Where the images a note copies when it goes to another space go:
   * where a new image of that note would go (vihko.yaml
   * `attachments`, attachments.ts `attachmentPath`): next to it, in its own
   * folder of images, or in the fixed folder of the space it goes to.
   */
  private copiesDir(notePath: string): string {
    return posix.dirname(attachmentPath(notePath, 'png', new Date(0), 1, this.opts.attachments?.(notePath) ?? { folder: null }))
  }

  /**
   * For a folder going to another space: the images its notes use
   * that would stay behind in the space it leaves (outside the folder, and
   * readable by whoever moves it), each to be copied next to the notes that
   * use it (`planned`, one per image and destination folder, keyed by both;
   * names only predicted). `placeFor` tells a moved note where each image
   * it uses ends up; `settle` puts in the names the copies really took
   * (and drops those that couldn't be made).
   */
  private planFolderCopies(moves: Map<string, string>, from: string, to: string, canRead: (path: string) => boolean = () => true) {
    const planned = new Map<string, { from: string; to: string }>()
    const origin = linkSpace(from)
    const key = (image: string, dir: string) => `${image}\u0000${dir}`
    if (origin !== linkSpace(to)) {
      const taken = new Set<string>()
      for (const [f, t] of moves) {
        const text = readText(join(this.opts.notesDir, f))
        if (text === null) continue
        const dir = this.copiesDir(t)
        for (const img of this.imagesOf(text, f)) {
          if (img.path.startsWith(from + '/') || linkSpace(img.path) !== origin || !canRead(img.path) || planned.has(key(img.path, dir))) continue
          // Where a new image of the note would go: a folder that may already be there,
          // or one in the destination, where only the copies planned here can take a name.
          const free = firstName(img.path, dir, (dest) => !taken.has(dest) && !existsSync(join(this.opts.notesDir, dest)))
          if (free === undefined) continue
          taken.add(free)
          planned.set(key(img.path, dir), { from: img.path, to: free })
        }
      }
    }
    return {
      planned,
      placeFor: (f: string, t: string, place: (p: string) => string) => {
        const dir = this.copiesDir(t)
        return (p: string) => planned.get(key(p, dir))?.to ?? place(p)
      },
      settle: (made: { from: string; to: string }[]) => {
        const byPlan = new Map(made.map((c) => [key(c.from, posix.dirname(c.to)), c]))
        for (const k of [...planned.keys()]) {
          const c = byPlan.get(k)
          if (c) planned.set(k, c)
          else planned.delete(k)
        }
      },
    }
  }

  /** Makes the copies a folder move planned (planFolderCopies), each as a new file never over another, by whoever moves it. */
  private makeFolderCopies(planned: Map<string, { from: string; to: string }>, actor: Actor): FolderMoveReport['images'] {
    const out: FolderMoveReport['images'] = { copied: [], failed: [] }
    for (const c of planned.values()) {
      try {
        const bytes = readFileSync(this.otherFile(c.from))
        const dir = posix.dirname(c.to)
        mkdirSync(join(this.opts.notesDir, dir), { recursive: true })
        const free = firstName(c.from, dir, (path) => this.createNewFile(path, bytes, actor))
        if (free === undefined) throw new NoteError('exists', `no free name for ${c.from} in ${dir}`)
        out.copied.push({ from: c.from, to: free })
      } catch (err) {
        out.failed.push({ path: c.from, to: null, outcome: 'stayed', ...failure(err) })
      }
    }
    return out
  }

  /**
   * Which of the note's images go with it when it moves to another folder:
   * those in its folder that no other note uses (by the index). The rest stay.
   * Names are only predicted here (the first free one); placing them decides.
   */
  private planImages(text: string, from: string, to: string, assetsDir: string | null, canRead: (path: string) => boolean = () => true): Pick<MoveReport['images'], 'moved' | 'copied' | 'stayed'> & { unplaceable: MoveReport['images']['failed'] } {
    const plan: ReturnType<NoteService['planImages']> = { moved: [], copied: [], stayed: [], unplaceable: [] }
    const toDir = posix.dirname(to)
    if (posix.dirname(from) === toDir) return plan
    // Changing space: what would stay behind in the space it leaves is copied, where the
    // destination puts a new image of the note (its space's `attachments`).
    const origin = linkSpace(from)
    const crossing = origin !== linkSpace(to)
    const copiesDir = crossing ? this.copiesDir(to) : toDir
    const taken = new Set<string>()
    const freeName = (path: string, dir = toDir) => {
      const free = firstName(path, dir, (dest) => !taken.has(dest) && !existsSync(join(this.opts.notesDir, dest)))
      if (free === undefined) plan.unplaceable.push({ path, to: null, outcome: 'stayed', error: 'exists', message: `no free name for ${path} in ${dir}` })
      else taken.add(free)
      return free
    }
    for (const img of this.imagesOf(text, from)) {
      const path = img.path
      if (assetsDir !== null && path.startsWith(assetsDir + '/')) continue // goes with its folder
      const reason = !img.beside ? 'elsewhere' : img.shared() ? 'shared' : null
      if (reason === null) {
        const free = freeName(path)
        if (free !== undefined) plan.moved.push({ from: path, to: free })
        continue
      }
      if (crossing && linkSpace(path) === origin && canRead(path)) {
        const free = freeName(path, copiesDir)
        if (free !== undefined) plan.copied.push({ from: path, to: free })
        continue
      }
      plan.stayed.push({ path, reason })
    }
    return plan
  }

  /**
   * Copies images into `dir` under their first free name, never over
   * anything; the originals stay where they are. One that can't be copied
   * is reported and stays (the note keeps linking it there).
   */
  private copyImages(copies: { from: string; to: string }[], dir: string, report: MoveReport): { from: string; to: string; bytes: Uint8Array }[] {
    const out: { from: string; to: string; bytes: Uint8Array }[] = []
    for (const c of copies) {
      try {
        const bytes = readFileSync(this.otherFile(c.from))
        mkdirSync(join(this.opts.notesDir, dir), { recursive: true })
        const free = firstName(c.from, dir, (path) => createFile(join(this.opts.notesDir, path), bytes))
        if (free === undefined) throw new NoteError('exists', `no free name for ${c.from} in ${dir}`)
        out.push({ from: c.from, to: free, bytes })
      } catch (err) {
        report.images.failed.push({ path: c.from, to: null, outcome: 'stayed', ...failure(err) })
      }
    }
    return out
  }

  /**
   * The images a note's text references that exist, each once: whether each
   * is next to the note (in its folder) and whether another note uses it too
   * (by the index; asked only when it matters).
   */
  private imagesOf(text: string, notePath: string): { path: string; beside: boolean; shared: () => boolean }[] {
    const dir = posix.dirname(notePath)
    const out: { path: string; beside: boolean; shared: () => boolean }[] = []
    const seen = new Set<string>()
    for (const img of extract(text).images) {
      const path = resolveImageRef(notePath, img.dest, { embed: img.kind === 'embed' || img.kind === 'wiki' })
      if (path === null || seen.has(path)) continue
      seen.add(path)
      if (!this.isFile(path)) continue // a broken reference: nothing of the note's there
      out.push({ path, beside: posix.dirname(path) === dir, shared: () => this.usedByOthers(path, notePath) })
    }
    return out
  }

  /** Whether a note other than `notePath` uses the file at `path` (by the index). */
  private usedByOthers(path: string, notePath: string): boolean {
    const users = this.opts.db.prepare('select distinct src_path from images where path = ?').all(path) as { src_path: string }[]
    return users.some((r) => r.src_path !== notePath)
  }

  /** In `per-note` mode, the note's own folder of images if it exists: the files in it (relative to it, hidden ones included) and whether any is a note. */
  private assetsOf(notePath: string): { dir: string; files: string[]; holdsNotes: boolean } | null {
    const suffix = this.opts.attachments?.(notePath).perNote
    if (suffix === undefined) return null
    const dir = noteAttachmentsDir(notePath, suffix)
    if (classifyPath(dir) !== 'other' || !isDirectory(join(this.opts.notesDir, dir))) return null
    const files = listFiles(join(this.opts.notesDir, dir))
    return { dir, files, holdsNotes: files.some((p) => classifyPath(`${dir}/${p}`) === 'note') }
  }

  /**
   * In `per-note` mode, whether the note's folder of images goes with it: it
   * exists and the note's name or folder changes. It stays (in `failed`) if
   * the name it would take is taken, or if it holds notes (moving those is a
   * folder move, with its own relinking).
   */
  private planAssets(from: string, to: string): { folder: MoveReport['images']['folder']; failed: MoveReport['images']['failed'] } {
    const suffix = this.opts.attachments?.(from).perNote
    if (suffix === undefined) return { folder: null, failed: [] }
    const dst = noteAttachmentsDir(to, suffix)
    const assets = noteAttachmentsDir(from, suffix) === dst ? null : this.assetsOf(from)
    if (assets === null) return { folder: null, failed: [] }
    const src = assets.dir
    if (assets.holdsNotes) {
      return { folder: null, failed: [{ path: src, to: null, outcome: 'stayed', error: 'not_empty', message: `${src} holds notes: it stays` }] }
    }
    if (classifyPath(dst) !== 'other' || existsSync(join(this.opts.notesDir, dst))) {
      return { folder: null, failed: [{ path: src, to: null, outcome: 'stayed', error: 'exists', message: `${dst} already exists: ${src} stays` }] }
    }
    return { folder: { from: src, to: dst, files: assets.files.length }, failed: [] }
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
    return isPlainFile(this.opts.notesDir, path)
  }

  /**
   * Stores an image for the note `notePath` and returns where it went:
   * `path` from the notes root and `src`, relative to the note, to link it.
   * Never overwrites: a taken name gets a suffix. The note itself isn't
   * touched; the editor inserts the link. Writing next to a note needs the same
   * access as writing the note: per-folder permissions apply here.
   */
  async attach(notePath: string, bytes: Uint8Array, actor: Actor, now = new Date()): Promise<{ path: string; src: string }> {
    this.read(notePath) // the note must exist (404 otherwise)
    if (bytes.byteLength > this.maxImageBytes) throw new NoteError('too_large', `${bytes.byteLength} bytes, the limit is ${this.maxImageBytes}`)
    const type = sniffImage(bytes)
    if (!type) throw new NoteError('unsupported_type', 'only PNG, JPEG, GIF, WebP and AVIF images are stored')
    const config = this.opts.attachments?.(notePath) ?? { folder: null }
    for (let n = 1; n <= 1000; n++) {
      const path = attachmentPath(notePath, type.ext, now, n, config)
      const file = this.otherFile(path)
      mkdirSync(dirname(file), { recursive: true })
      if (this.createNewFile(path, bytes, actor)) return { path, src: posix.relative(posix.dirname(notePath), path) }
    }
    throw new NoteError('exists', `no free name for an image of ${notePath}`)
  }

  /** The file for `path`, a file that isn't a note, only if vihko follows it (see fileIn). */
  private otherFile(path: string): string {
    if (!followable(this.opts.notesDir, path)) throw new NoteError('not_found', `does not exist: ${path}`)
    return join(this.opts.notesDir, path)
  }

  /** Creates a file that isn't a note, never over another; false if the name is taken. */
  private createNewFile(path: string, bytes: Uint8Array, actor: Actor): boolean {
    const w = this.history.prepare([{ path, after: bytes }], { actor, immediate: true })
    let created: boolean
    try {
      created = createFile(this.otherFile(path), bytes)
    } catch (err) {
      w.abort()
      throw err
    }
    if (created) {
      w.done()
      this.opts.indexer.indexPaths([path]) // findable by name at once (index.db `files`)
    } else w.abort()
    return created
  }

  /** The trash's entries, newest first: only folders `delete` made, whole (anything else there is left alone). */
  trash(): TrashEntry[] {
    const root = join(this.opts.stateDir, 'trash')
    let ids: string[]
    try { ids = readdirSync(root) } catch { return [] }
    return ids.sort().reverse().flatMap((id) => {
      const entry = this.trashEntry(id)
      return entry ? [entry] : []
    })
  }

  /**
   * What a trash entry holds on the disk, in bytes: its note's text (none
   * for files alone) and those of its files named by where they're stored
   * (`stored`), never the rest: whoever asks counts only what they may see.
   */
  trashBytes(id: string, stored: readonly string[]): number {
    const dir = this.trashDir(id)
    if (dir === null) return 0
    const size = (rel: string) => {
      try {
        const st = statSync(join(dir, rel))
        return st.isFile() ? st.size : 0
      } catch {
        return 0
      }
    }
    return size('note.md') + stored.reduce((n, s) => n + size(s), 0)
  }

  /**
   * Restores from the trash to its original path (or to `to`), with its
   * files. Never overwrites: a note whose name is taken isn't restored
   * (`exists`); a file whose name is taken comes back with a suffix, and the
   * note links it there (as when moving a note); an identical file
   * already there counts as restored. The files go back next to the note,
   * wherever it goes (in `per-note` mode, into its folder of images). Files
   * `canWrite` refuses stay in the trash, as an entry of files alone. Files
   * alone come back where they were (`to` doesn't apply). With `mayName`, a
   * note that would take a link to a note it refuses isn't restored either,
   * as a taken name (`create`).
   */
  async restore(id: string, actor: Actor, to?: string, opts: { canWrite?: (path: string) => boolean; mayName?: (path: string) => boolean } = {}): Promise<TrashRestoreReport> {
    const entry = this.trashEntry(id)
    const dir = this.trashDir(id)
    if (entry === null || dir === null) throw new NoteError('not_found', `not in the trash: ${id}`)
    const canWrite = opts.canWrite ?? (() => true)
    const reason: Reason = { code: 'trash_restored', id }
    if (entry.kind === 'files') {
      const back = this.placeBack(dir, entry.files ?? [], (p) => p, canWrite)
      // Recorded right after they land, before anything else runs (no await in between): never taken for an outside change.
      if (back.created.length) this.history.prepare(back.created.map((b) => ({ path: b.to, after: b.bytes })), { actor, reason, immediate: true }).done()
      this.settleEntry(entry, dir, null, back.left)
      this.opts.indexer.indexPaths(back.placed.map((p) => p.to))
      return { path: entry.path, etag: null, files: back.placed.map(({ from, to }) => ({ from, to })), left: back.left.map((f) => f.path) }
    }
    const text = readText(join(dir, 'note.md'))
    if (text === null) throw new NoteError('not_found', `not in the trash: ${id}`)
    const path = to ?? entry.path
    // Back under its own name, whatever it is; a new one is vihko's to give.
    const file = path === entry.path ? this.file(path) : this.newFile(path)
    if (readText(file) !== null) throw nameTaken(path)
    const taken = opts.mayName ? this.newNoteTakes(path, text, opts.mayName) : null
    if (taken?.refuse) throw nameTaken(path)

    // Its files first, next to where the note goes, under free names; then the
    // note, linking each where it landed. If the note can't go back, neither do they.
    const perNote = this.opts.attachments?.(entry.path).perNote
    const relocate = (p: string) => {
      if (path === entry.path) return p
      const assets = perNote === undefined ? null : noteAttachmentsDir(entry.path, perNote)
      if (assets !== null && p.startsWith(assets + '/')) return noteAttachmentsDir(path, perNote!) + p.slice(assets.length)
      return posix.join(posix.dirname(path), posix.relative(posix.dirname(entry.path), p))
    }
    const back = this.placeBack(dir, entry.files ?? [], relocate, canWrite)
    const at = new Map(back.placed.map((p) => [p.from, p.to]))
    const landed = new Set(at.values())
    const final = applyReplacements(text, planImageRelinks(text, entry.path, path, (p) => at.get(p) ?? p, (want) => landed.has(want)))
    const unplace = () => { for (const b of back.created) rmSync(join(this.opts.notesDir, b.to), { force: true }) }
    try {
      mkdirSync(dirname(file), { recursive: true })
    } catch (err) {
      unplace()
      throw err
    }
    const w = this.history.prepare([{ path, after: final }, ...back.created.map((b) => ({ path: b.to, after: b.bytes }))], { actor, reason, immediate: true })
    const r = await commitText(file, final, null).catch((err) => { unplace(); w.abort(); throw err })
    if (!r.ok) {
      unplace()
      w.abort()
      throw nameTaken(path)
    }
    w.done()
    this.settleEntry(entry, dir, path, back.left)
    this.opts.indexer.indexPaths([path, ...back.placed.map((p) => p.to)])
    await this.keepLinks(taken, path, actor)
    return { path, etag: contentHash(final), files: back.placed.map(({ from, to }) => ({ from, to })), left: back.left.map((f) => f.path) }
  }

  /**
   * Puts a trash entry's files back, each at `relocate(its path)` or, if that
   * name is taken by another file, the first free one with a suffix; an
   * identical file already there counts as it (`placed`, not `created`).
   * Those `canWrite` refuses, where vihko doesn't follow the path, or with no
   * free name are `left`.
   */
  private placeBack(dir: string, files: readonly { path: string; stored: string }[], relocate: (path: string) => string, canWrite: (path: string) => boolean) {
    const placed: { from: string; to: string }[] = []
    const created: { to: string; bytes: Uint8Array }[] = []
    const left: { path: string; stored: string }[] = []
    for (const f of files) {
      const want = relocate(f.path)
      const bytes = (() => { try { return readFileSync(join(dir, f.stored)) } catch { return null } })()
      if (bytes === null) continue // not in the entry any more: nothing to bring back
      if (classifyPath(want) === 'note' || want.startsWith('../') || !canWrite(want)) { left.push(f); continue }
      const where = posix.dirname(want)
      try {
        mkdirSync(join(this.opts.notesDir, where), { recursive: true })
      } catch {
        left.push(f)
        continue
      }
      let made = false
      const to = firstName(want, where, (candidate) => {
        if (!followable(this.opts.notesDir, candidate)) return false
        if (this.isFile(candidate)) return readFileSync(join(this.opts.notesDir, candidate)).equals(bytes)
        try {
          return (made = createFile(join(this.opts.notesDir, candidate), bytes))
        } catch {
          return false
        }
      })
      if (to === undefined) { left.push(f); continue }
      placed.push({ from: f.path, to })
      if (made) created.push({ to, bytes })
    }
    return { placed, created, left }
  }

  /**
   * After a restore: the entry goes, or, with files left, stays as files
   * alone (in the folder the note was restored to, or where they were).
   */
  private settleEntry(entry: TrashEntry, dir: string, restoredTo: string | null, left: { path: string; stored: string }[]) {
    if (left.length === 0) {
      rmSync(dir, { recursive: true })
      return
    }
    const kept = new Set(left.map((f) => f.stored))
    for (const f of entry.files ?? []) if (!kept.has(f.stored)) rmSync(join(dir, f.stored), { force: true })
    rmSync(join(dir, 'note.md'), { force: true })
    const folder = entry.kind === 'files' ? entry.path : folderOf(restoredTo ?? entry.path)
    const rest: TrashEntry = { id: entry.id, kind: 'files', path: folder, deletedAt: entry.deletedAt, actor: entry.actor, files: left, ...(entry.managers ? { managers: entry.managers } : {}) }
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(rest, null, 2))
  }

  /**
   * The folder of trash entry `id`, or null if `id` isn't one `delete` could
   * have made (a uid): an id is never a path, so nothing outside the trash is
   * read or removed through it.
   */
  private trashDir(id: string): string | null {
    if (!TRASH_ID.test(id)) return null
    const root = resolve(this.opts.stateDir, 'trash')
    const dir = resolve(root, id)
    return dirname(dir) === root ? dir : null
  }

  /** Trash entry `id` as its meta.json says, if it is one: a valid id, readable, and naming itself. */
  private trashEntry(id: string): TrashEntry | null {
    const dir = this.trashDir(id)
    const meta = dir === null ? null : readText(join(dir, 'meta.json'))
    if (meta === null) return null
    try {
      const entry = JSON.parse(meta) as TrashEntry
      return entry?.id === id && typeof entry.path === 'string' ? entry : null
    } catch {
      return null
    }
  }

  /**
   * Brings back a version of a note from the history: its text is
   * written like any edit (an open note changes live for its editors), and
   * the images it linked that no longer exist come back from the same commit
   * (`file`), never over an existing file, and only where `canWrite` allows.
   * One commit, by `actor`, with the reason `restored`. A note that no
   * longer exists is created again (with `mayName`, as `create` does).
   */
  async restoreVersion(path: string, version: { id: string; at: string; path: string; text: string }, opts: { ifMatch?: string; actor: Actor; file: (path: string) => Promise<Uint8Array | null>; canWrite?: (path: string) => boolean; mayName?: (path: string) => boolean; freshUid?: boolean }): Promise<RestoreReport> {
    const file = this.file(path)
    const reason: Reason = { code: 'restored', id: version.id, at: version.at }
    return this.history.operation(opts.actor, reason, async () => {
      let etag: string
      if (this.opts.hot?.has(path) || readText(file) !== null) {
        etag = (await this.edit(path, () => version.text, { ifMatch: opts.ifMatch, actor: opts.actor })).etag
      } else {
        if (opts.ifMatch !== undefined) throw new NoteError('precondition_failed', `the note doesn't exist: ${path}`)
        // A new uid only when the version's is another note's now (`freshUid`): otherwise it comes back as it was.
        const uid = this.uidIn(version.text)
        const fresh = opts.freshUid === true && uid !== null && this.opts.db.prepare('select 1 from notes where uid = ?').get(uid) !== undefined
        etag = (await this.create(path, version.text, opts.actor, { mayName: opts.mayName, freshUid: fresh })).etag
      }
      const images: RestoreReport['images'] = { restored: [], missing: [] }
      const seen = new Set<string>()
      for (const img of extract(version.text).images) {
        const embed = img.kind === 'embed' || img.kind === 'wiki'
        // Where the restored note looks for it, and where it was in that version (the note may have moved since).
        const target = resolveImageRef(path, img.dest, { embed })
        const source = resolveImageRef(version.path, img.dest, { embed })
        // A name vihko would never give (checkNewName), nor one the history can read (a line break ends a path there).
        if (target === null || source === null || seen.has(target) || classifyPath(target) !== 'other' || hasControlCharacter(target) || hasControlCharacter(source)) continue
        seen.add(target)
        // Where whoever restores can't write, or where vihko doesn't follow the path (a symbolic link on the way,
        // or another spelling: its permissions would be another folder's): as if the history didn't have it.
        if ((opts.canWrite && !opts.canWrite(target)) || !followable(this.opts.notesDir, target)) { images.missing.push({ path: target, reason: 'not_in_history' }); continue }
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

/** Removes `dir` and its empty subfolders, deepest first; a file anywhere stops it (ENOTEMPTY). Never follows a link. */
function removeEmptyTree(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) removeEmptyTree(join(dir, e.name))
  rmdirSync(dir)
}

/**
 * The operating system's clutter in a folder, never anyone's content: macOS's
 * `.DS_Store` and `._*` (AppleDouble) files, Windows's `Thumbs.db` and
 * `desktop.ini`. A folder is deleted with it.
 */
const isJunk = (name: string) => name === '.DS_Store' || name.startsWith('._') || /^(thumbs\.db|desktop\.ini)$/i.test(name)

let asides = 0

/** A hidden name next to `file` to set it aside while it goes to the trash (same filesystem: an atomic rename). */
const asideOf = (file: string) => join(dirname(file), `.${posix.basename(file)}.vihko-del-${process.pid}-${Date.now()}-${++asides}`)

const likePrefix = (dir: string) => dir.replace(/[\\%_]/g, (c) => '\\' + c) + '/%'

/**
 * A move's destination can't be taken: its name is in use, or the move would
 * have to rewrite a link to a note whoever moves it can't read.
 * Both answer alike, so that neither tells what exists.
 */
const nameTaken = (to: string) => new NoteError('exists', `that name isn't available here: ${to}`)

/** A trash entry's id: the uid `delete` gives it (a ULID in Crockford base32). */
const TRASH_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/

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
const changesOf = (text: string, reps: LinkReplacement[]): RelinkChange[] => reps.map((r) => ({ before: text.slice(r.from, r.to), after: r.text, kind: 'link', to: r.target }))
/** An image reference's rewrite as a report lists it. */
const imageChange = (r: ImageReplacement): RelinkChange => ({ before: r.before, after: r.after, kind: 'image', to: r.image })

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
    ...imageReps.map(imageChange),
  ]
  const reps = [...imageReps, ...linkReps]
  return { text: applyReplacements(text, reps), splices: relinkSplices(text, reps), changes, shifts, targets: linkReps.map((r) => r.target) }
}

/**
 * The name guard, for a move, so that no move tells what exists: a rewrite in a note whoever
 * moves it reads (`mayName` accepts it) that would name a note they can't
 * read refuses the move as a taken name (`refused`); the rewrites in notes
 * they don't read are the system's, as any other, and refuse nothing. A dry
 * run refuses nothing: its preview leaves those rewrites out (`shown`, the
 * changes the report lists of a note's plan), so it tells nothing either.
 */
function nameGuard(mayName: ((path: string) => boolean) | undefined, dryRun: boolean) {
  let hit = false
  return {
    shown(src: string, plan: { changes: RelinkChange[]; targets: string[] }) {
      if (!mayName || !mayName(src)) return plan.changes
      // The first `targets.length` changes are the links' (movedNotePlan), in order.
      const hidden = plan.targets.map((t) => !mayName(t))
      if (!hidden.includes(true)) return plan.changes
      hit = true
      return dryRun ? plan.changes.filter((_, i) => !hidden[i]) : plan.changes
    },
    get refused() { return hit && !dryRun },
  }
}

/** How many of `paths` a move's hooks count (MoveHooks `counts`). */
const counted = (paths: readonly string[], counts?: (path: string) => boolean) => (counts ? paths.filter(counts).length : paths.length)

/** What a new name takes (NoteService `linksTaken`). */
interface LinksTaken {
  refuse: boolean
  keep: string[]
  before: LinkIndex
  after: LinkIndex
  mayName: (path: string) => boolean
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
