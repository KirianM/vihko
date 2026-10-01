// Automatic retention of the managed history: the versions older than the
// admin's period go, while vihko runs (the retention service, retention.ts,
// calls it at night). The rewrite is the purge's (purge.ts): the new commits
// go to a ref of their own, `refs/heads/main` moves at the end in one step
// that checks it didn't move meanwhile, and the repository is compacted.
// A process killed half way leaves the history as it was, or rewritten and
// not yet compacted; the next run finishes it. The recorder is paused while
// it runs (notes are written, and their versions wait for it).
//
// What stays, file by file (a «version» is one file's content in one commit):
//
// - Every version newer than the cutoff, as it was.
// - Of the older ones, only the version each file had at the cutoff: the
//   current version of a note that hasn't changed since, and the base the
//   newer versions of the others are compared with. It keeps its author and
//   date. A file deleted before the cutoff keeps nothing.
// - A note in the trash keeps its whole history, whatever its age (`keep`).
// - A note whose trash entry was emptied loses its history up to its
//   deletion, whatever its age (`drop`): a note of the same name made later
//   keeps its own.
//
// A deleted note is followed back through its moves (`Vihko-Move`) and
// through being restored, as the history UI follows it. Commits left with no
// change go, and a version that pointed to one of them (a restore's) points
// to the commit before it, as in a purge. Move trailers stay only where the
// file they moved is still in the commit.
import { Git, resolveRef } from './git.ts'
import { HISTORY_REF, repositoryDir } from './recorder.ts'
import { compact, opOf, readHistory, rewriteHistory, type Commit, type RunningRecorder, type Rewritten } from './purge.ts'
import { movedFrom, parseMessage } from './trailers.ts'

/** A deleted note (or a file that went to the trash with it): its path in the trash entry, and when it was deleted (ms). */
export interface DeletedFile {
  path: string
  deletedAt: number
}

export interface RetentionRequest {
  /** Versions older than this (ms since the epoch) go, except each file's version at that moment; null: none goes for its age. */
  cutoff: number | null
  /** Files in the trash: their history stays whole. */
  keep: readonly DeletedFile[]
  /** Files whose trash entry was emptied: their history up to their deletion goes. */
  drop: readonly DeletedFile[]
}

/** What a run takes out of the history (counts only: never a path). */
export interface RetentionReport {
  /** File versions taken out. */
  versions: number
  /** Commits left with no change, gone. */
  commits: number
  /** Bytes of content no version keeps any more (as git stores it before compressing). */
  bytes: number
  /** Commits written again (every one from the first it changes). */
  rewritten: number
  /** The history's newest commit afterwards. */
  head: string | null
}

const NONE: RetentionReport = { versions: 0, commits: 0, bytes: 0, rewritten: 0, head: null }

/** A deletion is found in the history this close to when its trash entry says it happened. */
const SLACK_MS = 10 * 60_000

/** What a run would do to the history as it is: each commit rewritten, from `first` (-1: nothing to do). */
export interface RetentionPlan {
  first: number
  built: Rewritten[]
  versions: number
  commits: number
  /** Contents that only removed versions held. */
  removed: Set<string>
}

const authorMs = (ident: string) => Number(/ (\d+) [+-]\d{4}$/.exec(ident)?.[1] ?? 0) * 1000
const key = (i: number, path: string) => `${i}\u0000${path}`

/**
 * What to take out of `commits` (oldest first, as `readHistory` reads them).
 * Pure: the caller writes it (`rewriteHistory`) or only counts it (a preview).
 */
export function planRetention(commits: readonly Commit[], req: RetentionRequest): RetentionPlan {
  const n = commits.length
  const time = commits.map((c) => authorMs(c.author))
  const parsed = commits.map((c) => (/Vihko-(Move|Reason)/.test(c.message) ? parseMessage(c.message) : null))
  const moves = (i: number) => parsed[i]?.moves ?? []
  const files: (Map<string, Commit['files'][number]> | undefined)[] = new Array(n)
  const fileAt = (i: number, path: string) => (files[i] ??= new Map(commits[i]!.files.map((f) => [f.path, f]))).get(path)
  const byPath = new Map<string, number[]>()
  for (let i = 0; i < n; i++) for (const f of commits[i]!.files) {
    const list = byPath.get(f.path)
    if (list) list.push(i)
    else byPath.set(f.path, [i])
  }
  const moving: number[] = []
  for (let i = 0; i < n; i++) if (moves(i).length) moving.push(i)

  /** Where a trash entry's file was when it was deleted: a folder moved since took the entry along. */
  const pathAt = (path: string, at: number) => {
    let p = path
    for (let j = moving.length - 1; j >= 0; j--) {
      const i = moving[j]!
      if (time[i]! <= at + SLACK_MS) break
      const from = movedFrom(p, moves(i))
      if (from !== null) p = from
    }
    return p
  }

  /**
   * Marks every version of a deleted file: from its deletion back to when it
   * was made, through its moves and the times it came back (a restore).
   */
  const lineage = (d: DeletedFile, mark: Set<string>) => {
    let name = pathAt(d.path, d.deletedAt)
    let list = byPath.get(name)
    if (!list) return
    // Its deletion: the last one of that path around when the entry says (none recorded: nothing to follow).
    let idx = -1
    for (let k = list.length - 1; k >= 0; k--) {
      const i = list[k]!
      if (time[i]! > d.deletedAt + SLACK_MS) continue
      if (time[i]! < d.deletedAt - SLACK_MS) break
      if (fileAt(i, name)!.newOid === null) { idx = i; break }
    }
    if (idx < 0) return
    for (;;) {
      let k = list.length - 1
      while (k >= 0 && list[k]! > idx) k--
      let next: { name: string; idx: number } | null = null
      for (; k >= 0; k--) {
        const i = list[k]!
        mark.add(key(i, name))
        if (fileAt(i, name)!.status !== 'A') continue
        // Made here: moved from another path, brought back (its earlier life is the same note), or new.
        const from = movedFrom(name, moves(i))
        if (from !== null && fileAt(i, from)) {
          mark.add(key(i, from))
          next = { name: from, idx: i - 1 }
          break
        }
        const why = parsed[i]?.reason?.code
        if (why === 'trash_restored' || why === 'restored') continue
        break
      }
      if (!next) return
      name = next.name
      idx = next.idx
      list = byPath.get(name)
      if (!list) return
    }
  }

  const dropped = new Set<string>()
  for (const d of req.drop) lineage(d, dropped)
  const kept = new Set<string>()
  for (const d of req.keep) lineage(d, kept)

  // The commits before `cut` are the old ones.
  let cut = 0
  if (req.cutoff !== null) {
    cut = time.findIndex((t) => t >= req.cutoff!)
    if (cut < 0) cut = n
  }
  // Of the old versions, file by file: those of notes in the trash, and the one in force at the cutoff.
  const keepOld = new Set<string>()
  if (cut > 0) {
    for (const [path, list] of byPath) {
      const old = list.filter((i) => i < cut && !dropped.has(key(i, path)))
      if (old.length === 0) continue
      const last = old[old.length - 1]!
      const atCutoff = fileAt(last, path)!.newOid
      let state: string | null = null
      for (const i of old) {
        const oid = fileAt(i, path)!.newOid
        let keep = kept.has(key(i, path)) || (i === last && oid !== null)
        // Deleting what isn't there any more says nothing.
        if (keep && oid === null && state === null) keep = false
        if (!keep) continue
        keepOld.add(key(i, path))
        state = oid
      }
      // The tree at the cutoff is the same as before: the newer commits change it as they did.
      if (state !== atCutoff) keepOld.add(key(last, path))
    }
  }

  const built: Rewritten[] = []
  const removed = new Set<string>()
  const stays = new Set<string>()
  let first = -1
  let versions = 0
  let gone = 0
  for (let i = 0; i < n; i++) {
    const c = commits[i]!
    const keep = c.files.filter((f) => (i < cut ? keepOld.has(key(i, f.path)) : !dropped.has(key(i, f.path))))
    const ops = keep.map(opOf)
    for (const f of keep) if (f.newOid) stays.add(f.newOid)
    if (keep.length !== c.files.length) {
      if (first < 0) first = i
      const left = new Set(keep)
      for (const f of c.files) if (f.newOid && !left.has(f)) { versions++; removed.add(f.newOid) }
      if (keep.length === 0 && c.files.length) gone++
    }
    const paths = new Set(keep.map((f) => f.path))
    // A move stays while what it moved is still in the commit.
    built.push({ ops, keepMove: (_from, to) => paths.has(to) || keep.some((f) => f.path.startsWith(to + '/')) })
  }
  for (const oid of stays) removed.delete(oid)
  return { first, built: first < 0 ? [] : built.slice(first), versions, commits: gone, removed }
}

/** Bytes of these contents, as git stores them before compressing. */
async function sizeOf(git: Git, oids: Set<string>): Promise<number> {
  if (oids.size === 0) return 0
  const { stdout } = await git.run(['cat-file', '--batch-check=%(objectsize)'], { input: [...oids].map((o) => o + '\n').join(''), timeoutMs: 600_000 })
  let total = 0
  for (const line of stdout.toString('latin1').split('\n')) if (/^\d+$/.test(line)) total += Number(line)
  return total
}

export interface RetainOptions {
  stateDir: string
  git?: string
  /** Right after `main` moved to the rewritten history, before it's compacted. */
  afterMove?: () => void
  /** The last run moved `main` and didn't compact (it was cut short): compact even with nothing new to take out. */
  compactPending?: boolean
}

/** What a run would take out now, without changing anything (vihko may be running). */
export async function retentionPreview(opts: RetainOptions, req: RetentionRequest): Promise<RetentionReport> {
  const git = new Git({ gitDir: repositoryDir(opts.stateDir), binary: opts.git })
  const head = await resolveRef(git, HISTORY_REF)
  if (!head) return NONE
  const commits = await readHistory(git)
  const plan = planRetention(commits, req)
  return { versions: plan.versions, commits: plan.commits, bytes: await sizeOf(git, plan.removed), rewritten: plan.built.length, head }
}

/**
 * Takes it out, from the running server: with the recorder paused while the
 * repository is rewritten (recorder.ts `purging`). Nothing of the notes
 * folder is forgotten: every file keeps its current version.
 */
export async function retainRunning(opts: RetainOptions, req: RetentionRequest, recorder: RunningRecorder): Promise<RetentionReport> {
  const git = new Git({ gitDir: repositoryDir(opts.stateDir), binary: opts.git })
  const r = await recorder.purging(async () => {
    const head = await resolveRef(git, HISTORY_REF)
    if (!head) return { result: NONE, forget: () => false, pathsOnDisk: [] }
    const commits = await readHistory(git)
    const plan = planRetention(commits, req)
    if (plan.first < 0) {
      if (opts.compactPending) await compact(git)
      return { result: { ...NONE, head }, forget: () => false, pathsOnDisk: [] }
    }
    const bytes = await sizeOf(git, plan.removed)
    const newHead = await rewriteHistory(git, commits, plan.first, plan.built, head, { afterMove: opts.afterMove })
    return { result: { versions: plan.versions, commits: plan.commits, bytes, rewritten: plan.built.length, head: newHead }, forget: () => false, pathsOnDisk: [] }
  })
  return r.result
}
