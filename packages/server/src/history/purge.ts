// `thoth history purge`: rewrites the managed history without a path (a file,
// or a folder with everything in it), or without the content a path has in
// one version. For a secret pasted by mistake (D-034.6). With thoth stopped:
// it takes the state volume's lock, as the server does.
//
// - Only the managed history (`<state>/history.git`, thoth's own). The user's
//   repository (unmanaged mode) is never rewritten, and the notes folder is
//   only read, never touched.
// - Everything else is kept as it was: authors, dates, trailers and the
//   `Thoth-Move` moves the history follows. A commit left with no change is
//   dropped; a version that pointed to it (`Thoth-Restored-From`, a restore's
//   reason) points to the commit before it, which has the same files.
// - The new commits go to a ref of their own; `refs/heads/main` moves only at
//   the end, in one step that checks it didn't move meanwhile. A process
//   killed half way leaves the history as it was, and running the command
//   again finishes the work.
// - Afterwards nothing of what was purged is left in the repository: no
//   reflog, no pack, no loose object (`reflog expire`, `gc --prune=now`),
//   unless the same content is also stored under another path, which the
//   report says.
// - The recorder's journal and its cache of the sweep's `stat`s forget the
//   purged paths. What the notes folder still holds for them is left in the
//   journal as known (`baseline`): it isn't recorded again as a change made
//   with thoth stopped, and enters the history with the file's next version,
//   which the report warns about.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isIgnoredDir, type HistoryMode } from '@thoth/core'
import { lockState, type StateLock } from '../lock.ts'
import { Git, GitError, blobOid, quotePath, readTree, resolveRef, write } from './git.ts'
import {
  HISTORY_REF, cacheFile, crashPoint, historyPath, isTextPath, journalFile, repositoryDir, writeAtomic,
  type Journal, type QChange,
} from './recorder.ts'
import { parseMessage } from './trailers.ts'

/** Where the rewritten history is built before `refs/heads/main` moves to it. */
const WORK_REF = 'refs/thoth/purge'

export type PurgeErrorCode =
  | 'history_unmanaged' | 'history_no_repository' | 'invalid_path' | 'invalid_version' | 'not_found' | 'not_a_version'
  | 'history_moved'

/** Why a purge can't run. Codes; the message is for whoever runs the command. */
export class PurgeError extends Error {
  readonly code: PurgeErrorCode
  constructor(code: PurgeErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface PurgeOptions {
  stateDir: string
  notesDir: string
  /** A file or a folder, relative to the notes root. */
  path: string
  /** Only the content `path` has in this version (a commit id, 7 to 40 hex digits). */
  version?: string
  /** Says what would change, and changes nothing. It doesn't need thoth stopped. */
  dryRun?: boolean
  /** thoth.yaml's `history.mode`: the purge refuses to run in unmanaged mode. */
  mode: HistoryMode
  /** thoth.yaml's `history.exclude`. */
  excluded?: (path: string) => boolean
  git?: string
}

/** A file of one commit that the purge changes. */
export interface PurgedFile {
  path: string
  /** What that commit did to it. */
  change: 'created' | 'modified' | 'deleted'
}

export interface PurgedCommit {
  id: string
  /** ISO, the author time. */
  at: string
  subject: string
  files: PurgedFile[]
  /** Left with no change: it goes. */
  dropped: boolean
}

export interface PurgeReport {
  path: string
  version: string | null
  dryRun: boolean
  /** The commits whose own changes the purge takes out, oldest first. */
  commits: PurgedCommit[]
  /** Commits rewritten (every one from the first affected to the newest), and of them, dropped for being left empty. */
  rewritten: number
  dropped: number
  /** Versions of files removed (contents taken out of the history). */
  filesRemoved: number
  /** The history's newest commit afterwards (null: none left). */
  head: string | null
  /** Paths still in the notes folder and not excluded: they enter the history again with their next version. */
  stillOnDisk: string[]
  /** Other paths that hold a purged content in the history: it stays stored under them. */
  sharedWith: string[]
  /** Where purged files came from by a move: their earlier versions are under that path. */
  movedFrom: string[]
  /** What the recorder's journal still had pending or queued for the purged paths, dropped. */
  journal: { pending: number; queued: number }
}

/** A commit as the purge reads it: its identities and dates exactly as stored, and its files against its parent. */
interface Commit {
  id: string
  parent: string | null
  author: string
  committer: string
  message: string
  files: { status: string; mode: string; oldOid: string | null; newOid: string | null; path: string }[]
}

const ZERO = /^0+$/
const FORMAT = '--format=%x1e%H%x1f%P%x1f%an <%ae> %ad%x1f%cn <%ce> %cd%x1f%B%x1f'

/** The path as given, checked: relative to the notes root, no `.`/`..`, no empty segment. */
export function purgeTarget(raw: string): string {
  const p = raw.replace(/\/+$/, '')
  if (p === '' || p.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(p) || p.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new PurgeError('invalid_path', `not a path relative to the notes folder: ${JSON.stringify(raw)}`)
  }
  return p
}

export async function purgeHistory(opts: PurgeOptions): Promise<PurgeReport> {
  if (opts.mode === 'unmanaged') {
    throw new PurgeError('history_unmanaged', 'the history is unmanaged in thoth.yaml: it is the notes folder\'s own git repository, which thoth never rewrites')
  }
  const target = purgeTarget(opts.path)
  if (opts.version !== undefined && !/^[0-9a-f]{7,40}$/.test(opts.version)) {
    throw new PurgeError('invalid_version', `not a version id (7 to 40 hexadecimal digits): ${JSON.stringify(opts.version)}`)
  }
  const gitDir = repositoryDir(opts.stateDir)
  if (!existsSync(join(gitDir, 'HEAD'))) throw new PurgeError('history_no_repository', `there is no managed history at ${gitDir}`)
  // A dry run only reads: it can look while thoth runs. Anything else needs thoth stopped.
  const lock: StateLock | null = opts.dryRun ? null : lockState(opts.stateDir)
  try {
    return await purge(opts, target, new Git({ gitDir, binary: opts.git }))
  } finally {
    lock?.release()
  }
}

async function purge(opts: PurgeOptions, target: string, git: Git): Promise<PurgeReport> {
  const head = await resolveRef(git, HISTORY_REF)
  const commits = head ? await readHistory(git) : []
  const plan = opts.version === undefined ? planPath(commits, target) : await planVersion(git, commits, target, opts.version)
  const report: PurgeReport = {
    path: target, version: plan.version, dryRun: !!opts.dryRun, commits: plan.affected,
    rewritten: 0, dropped: 0, filesRemoved: plan.removed, head,
    stillOnDisk: [], sharedWith: plan.sharedWith, movedFrom: plan.movedFrom, journal: { pending: 0, queued: 0 },
  }
  const first = commits.findIndex((c) => plan.touches(c))
  const recorder = await recorderAfter(opts, git, head, plan)
  report.stillOnDisk = recorder.stillOnDisk
  report.journal = recorder.counts
  if (first >= 0) {
    const built = commits.slice(first).map((c) => plan.rewrite(c))
    report.rewritten = built.length
    report.dropped = built.filter((b) => b.ops.length === 0).length
    for (const a of report.commits) a.dropped = built[commits.indexOf(commits.find((c) => c.id === a.id)!) - first]?.ops.length === 0
  }
  if (opts.dryRun) return report

  if (first < 0) {
    // Nothing in git (a run cut short before may have left it rewritten but not compacted).
    recorder.save()
    await compact(git)
    return report
  }
  const parent = first === 0 ? null : commits[first - 1]!.id
  const newHead = await importRewritten(git, parent, commits.slice(first), commits.slice(first).map((c) => plan.rewrite(c)))
  crashPoint('purge-imported')
  report.head = newHead
  recorder.save()
  // The one step that changes the history: only if nothing moved it meanwhile.
  try {
    if (newHead) await git.run(['update-ref', '-m', 'thoth history purge', HISTORY_REF, newHead, head!])
    else await git.run(['update-ref', '-d', HISTORY_REF, head!])
  } catch (err) {
    throw new PurgeError('history_moved', `the history changed while it was being rewritten; nothing was changed (${err instanceof Error ? err.message : String(err)})`)
  }
  crashPoint('purge-moved')
  await compact(git)
  return report
}

// --- Reading ----------------------------------------------------------------------

/** Every commit of the history, oldest first, with its files against its parent (the first one's, all created). */
async function readHistory(git: Git): Promise<Commit[]> {
  const { stdout } = await git.run(
    ['log', '--reverse', '--first-parent', '--root', '-z', '--raw', '--no-renames', '--no-abbrev', '--date=raw', FORMAT, HISTORY_REF, '--'],
    { timeoutMs: 600_000 },
  )
  const out: Commit[] = []
  for (const rec of stdout.toString('utf8').split('\x1e').slice(1)) {
    const parts = rec.split('\x1f')
    if (parts.length < 6) throw new GitError('failed', 'git log: unexpected output')
    const [id, parents, author, committer, message] = parts as [string, string, string, string, string]
    const tokens = parts.slice(5).join('\x1f').replace(/^[\0\n]+/, '').split('\0')
    const files: Commit['files'] = []
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const meta = tokens[i]!
      if (!meta.startsWith(':')) break
      const [, mode, oldOid, newOid, status] = meta.slice(1).split(' ') as [string, string, string, string, string]
      files.push({
        status: status[0]!, mode,
        oldOid: ZERO.test(oldOid) ? null : oldOid,
        newOid: ZERO.test(newOid) ? null : newOid,
        path: tokens[i + 1]!,
      })
    }
    out.push({ id, parent: parents ? parents.split(' ')[0]! : null, author, committer, message, files })
  }
  return out
}

// --- What to take out -------------------------------------------------------------

type Op = { op: 'M'; mode: string; oid: string; path: string } | { op: 'D'; path: string }

interface Plan {
  version: string | null
  affected: PurgedCommit[]
  removed: number
  sharedWith: string[]
  movedFrom: string[]
  /** Paths in the notes folder the purge is about (a folder: what is under it). */
  pathsOnDisk: string[]
  /** Whether this commit's tree has anything the purge takes out. */
  touches(c: Commit): boolean
  /** The commit's changes against its rewritten parent, and whether a move trailer stays. */
  rewrite(c: Commit): { ops: Op[]; keepMove: (from: string, to: string) => boolean }
  /** Whether a path's journal entries go (the whole path purged). */
  forget(path: string): boolean
  /** What the history's newest commit has for a path after the purge, given what it has now. */
  headAfter(path: string, now: Map<string, string>): string | null
}

const nfc = (s: string) => s.normalize('NFC')
const within = (path: string, target: string) => { const p = nfc(path); return p === target || p.startsWith(target + '/') }
const changeOf = (status: string): PurgedFile['change'] => (status === 'A' ? 'created' : status === 'D' ? 'deleted' : 'modified')
const iso = (ident: string) => new Date(Number(/ (\d+) [+-]\d{4}$/.exec(ident)?.[1] ?? 0) * 1000).toISOString()
const subjectOf = (message: string) => message.split('\n')[0] ?? ''

function opOf(f: Commit['files'][number]): Op {
  return f.newOid === null ? { op: 'D', path: f.path } : { op: 'M', mode: f.mode, oid: f.newOid, path: f.path }
}

/** The whole path: gone from every version, and every move trailer that names it. */
function planPath(commits: Commit[], raw: string): Plan {
  const target = nfc(raw)
  const affected: PurgedCommit[] = []
  const purged = new Set<string>()
  const paths = new Set<string>()
  const movedFrom = new Set<string>()
  let removed = 0
  for (const c of commits) {
    const files = c.files.filter((f) => within(f.path, target))
    for (const f of files) {
      paths.add(f.path)
      if (f.newOid) { purged.add(f.newOid); removed++ }
    }
    for (const m of parseMessage(c.message).moves) {
      // A file moved here, or a folder moved with the purged path in it.
      if (within(m.to, target) && !within(m.from, target)) movedFrom.add(m.from)
      else if (target.startsWith(nfc(m.to) + '/')) movedFrom.add(m.from + target.slice(nfc(m.to).length))
    }
    if (files.length) affected.push({ id: c.id, at: iso(c.author), subject: subjectOf(c.message), files: files.map((f) => ({ path: f.path, change: changeOf(f.status) })), dropped: false })
  }
  return {
    version: null, affected, removed, movedFrom: [...movedFrom].sort(),
    sharedWith: sharedWith(commits, purged, (p) => within(p, target)),
    pathsOnDisk: [...new Set([raw, ...paths])],
    touches: (c) => c.files.some((f) => within(f.path, target)) || parseMessage(c.message).moves.some((m) => within(m.from, target) || within(m.to, target)),
    rewrite: (c) => ({
      ops: c.files.filter((f) => !within(f.path, target)).map(opOf),
      keepMove: (from, to) => !within(from, target) && !within(to, target),
    }),
    forget: (p) => within(p, target),
    headAfter: (p, now) => (within(p, target) ? null : now.get(p) ?? null),
  }
}

/**
 * One version's content of a file: wherever the file holds that content (in
 * that version, and in any other it comes back in or is carried to), it holds
 * instead what it had right before.
 */
async function planVersion(git: Git, commits: Commit[], raw: string, version: string): Promise<Plan> {
  const { code, stdout } = await git.run(['rev-parse', '--verify', '-q', '--end-of-options', `${version}^{commit}`], { ok: [1] })
  const id = code === 0 ? stdout.toString('latin1').trim() : null
  const at = id ? commits.findIndex((c) => c.id === id) : -1
  if (at < 0) throw new PurgeError('not_found', `${version} is not a version in the history`)
  const entry = commits[at]!.files.find((f) => nfc(f.path) === nfc(raw))
  if (!entry || entry.newOid === null) throw new PurgeError('not_a_version', `${version} doesn't write ${raw}: it isn't one of its versions`)
  const path = entry.path
  const content = entry.newOid
  // The file's content after each commit, before and after the purge.
  const was = new Map<string, string | null>()
  const now = new Map<string, string | null>()
  const before = new Map<string, { was: string | null; now: string | null }>()
  let s: string | null = null
  let t: string | null = null
  for (const c of commits) {
    before.set(c.id, { was: s, now: t })
    const f = c.files.find((x) => x.path === path)
    if (f) s = f.newOid
    t = s === content ? t : s
    was.set(c.id, s)
    now.set(c.id, t)
  }
  const affected: PurgedCommit[] = []
  let removed = 0
  for (const c of commits) {
    const f = c.files.find((x) => x.path === path)
    if (!f) continue
    const b = before.get(c.id)!
    // Its own change to the file isn't the same any more.
    if (b.now === now.get(c.id) || f.newOid === content) {
      if (f.newOid === content) removed++
      affected.push({ id: c.id, at: iso(c.author), subject: subjectOf(c.message), files: [{ path, change: changeOf(f.status) }], dropped: false })
    }
  }
  return {
    version: id, affected, removed, movedFrom: [],
    sharedWith: sharedWith(commits, new Set([content]), (p) => p === path),
    pathsOnDisk: [path],
    touches: (c) => was.get(c.id) !== now.get(c.id) || before.get(c.id)!.was !== before.get(c.id)!.now,
    rewrite: (c) => {
      const ops = c.files.filter((f) => f.path !== path).map(opOf)
      const b = before.get(c.id)!
      const after = now.get(c.id)!
      if (after !== b.now) ops.push(after === null ? { op: 'D', path } : { op: 'M', mode: entry.mode, oid: after, path })
      return {
        ops,
        // A move that brings the file here, or takes it away, only if the file is still there.
        keepMove: (from, to) => !(to === path && after === null) && !(from === path && b.now === null && b.was !== null),
      }
    },
    forget: () => false,
    headAfter: (p, head) => (p === path ? t : head.get(p) ?? null),
  }
}

/** Other paths that hold one of these contents somewhere in the history (it stays stored under them). */
function sharedWith(commits: Commit[], contents: Set<string>, purged: (path: string) => boolean): string[] {
  const out = new Set<string>()
  for (const c of commits) for (const f of c.files) if (f.newOid && contents.has(f.newOid) && !purged(f.path)) out.add(f.path)
  return [...out].sort()
}

// --- Writing ------------------------------------------------------------------------

/**
 * The rewritten commits on top of `parent`, into a ref of their own (`main`
 * isn't touched). One fast-import run: each commit's id is asked for as soon
 * as it's written, so a later message can point to it (a restore's version).
 * Resolves with the new head (the parent itself when every commit went).
 */
async function importRewritten(git: Git, parent: string | null, commits: Commit[], built: ReturnType<Plan['rewrite']>[]): Promise<string | null> {
  await git.run(['update-ref', '-d', WORK_REF])
  const renamed = new Map<string, string | null>()
  let last = parent
  const emitted = built.filter((b) => b.ops.length).length
  if (emitted === 0) return last
  let buf = ''
  const lines: string[] = []
  let waiting: ((line: string) => void) | null = null
  const onStdout = (chunk: Buffer) => {
    buf += chunk.toString('latin1')
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (waiting) { const w = waiting; waiting = null; w(line) } else lines.push(line)
    }
  }
  let mark = 0
  await git.run(['fast-import', '--quiet', '--done'], {
    timeoutMs: 600_000 + commits.length * 100,
    onStdout,
    input: async (stdin) => {
      // fast-import gone (it failed): nothing more will come.
      let closed = false
      stdin.once('close', () => { closed = true; waiting?.('') })
      const nextLine = () => lines.length || closed ? Promise.resolve(lines.shift() ?? '') : new Promise<string>((resolve) => { waiting = resolve })
      let first = true
      for (let i = 0; i < commits.length; i++) {
        const c = commits[i]!
        const b = built[i]!
        if (b.ops.length === 0) { renamed.set(c.id, last); continue }
        mark++
        const msg = Buffer.from(rewriteMessage(c.message, renamed, b.keepMove), 'utf8')
        await write(stdin, `commit ${WORK_REF}\nmark :${mark}\nauthor ${c.author}\ncommitter ${c.committer}\ndata ${msg.byteLength}\n`)
        await write(stdin, msg)
        await write(stdin, '\n')
        if (first) {
          // The first one goes on top of the kept history; the ref is new, so without `from` it's a root.
          if (last) await write(stdin, `from ${last}\n`)
          first = false
        }
        for (const op of b.ops) {
          await write(stdin, op.op === 'D' ? `D ${quotePath(op.path)}\n` : `M ${op.mode} ${op.oid} ${quotePath(op.path)}\n`)
        }
        await write(stdin, `\nget-mark :${mark}\n`)
        const id = await nextLine()
        if (!/^[0-9a-f]{40}$/.test(id)) throw new GitError('failed', `fast-import: no id for the commit replacing ${c.id}`)
        renamed.set(c.id, id)
        last = id
        if (mark === Math.ceil(emitted / 2)) crashPoint('purge-importing')
      }
      await write(stdin, 'done\n')
    },
  }).catch((err) => {
    git.cleanCrashReports()
    throw err
  })
  return last
}

/**
 * The message as it was, except move trailers about what is gone, and
 * commit ids (a restore's version) that now have another id.
 */
function rewriteMessage(message: string, renamed: Map<string, string | null>, keepMove: (from: string, to: string) => boolean): string {
  return message.split('\n').filter((line) => {
    const m = /^Thoth-Move: ?(.*)$/.exec(line)
    if (!m) return true
    const tab = m[1]!.indexOf('\t')
    return tab < 0 || keepMove(m[1]!.slice(0, tab), m[1]!.slice(tab + 1))
  }).map((line) => {
    if (!/^Thoth-(Restored-From|Reason):/.test(line)) return line
    return line.replace(/\b[0-9a-f]{40}\b/g, (id) => renamed.get(id) ?? id)
  }).join('\n')
}

/** Nothing unreachable left: no work ref, no reflog, no loose object or pack holding what was purged. */
async function compact(git: Git) {
  await git.run(['update-ref', '-d', WORK_REF])
  await git.run(['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'])
  await git.run(['gc', '--prune=now', '--quiet'], { timeoutMs: 1_800_000 })
  git.cleanCrashReports()
}

// --- The recorder's files -----------------------------------------------------------

/**
 * The recorder's journal and its cache of the sweep's `stat`s as they will be
 * after the purge: without the purged paths' open versions, queued changes
 * and cached `stat`s. What the notes folder holds for a purged path, if it's
 * what the recorder knew before the purge and not what it knows after, stays
 * known (`baseline`), so it isn't recorded again as a change made with thoth
 * stopped. `stillOnDisk`: the purged paths whose content on disk isn't what
 * the history will know (it enters with their next version). `save` writes
 * both files.
 */
async function recorderAfter(opts: PurgeOptions, git: Git, head: string | null, plan: Plan) {
  const file = journalFile(opts.stateDir)
  let j: Journal | null = null
  try { j = JSON.parse(readFileSync(file, 'utf8')) as Journal } catch { /* none yet, or unreadable: the recorder starts without it too */ }
  const counts = { pending: 0, queued: 0 }
  const journal: Journal = {
    version: 1, mode: j?.mode ?? opts.mode, typing: j?.typing ?? {}, pending: j?.pending ?? {}, queue: j?.queue ?? [],
    inflight: j?.inflight ?? null, groups: j?.groups ?? [], writes: j?.writes ?? [], merged: j?.merged ?? null, baseline: { ...j?.baseline },
  }
  const baseline = journal.baseline!
  // A commit cut short on its way to git: settled against the history as it is before the purge (as the recorder does).
  if (journal.inflight) {
    if (head !== journal.inflight.parent) journal.queue.splice(0, journal.inflight.count)
    journal.inflight = null
  }
  const tree = head ? await readTree(git, head) : new Map<string, string>()
  // What the recorder knows for a path, in its order: an open version, the baseline, the queue, git's head.
  const known = (p: string, headHas: string | null) => {
    const open = journal.pending[p]
    if (open) return open.oids.at(-1) ?? null
    if (baseline[p] !== undefined) return baseline[p]!
    let oid: string | null | undefined
    for (const q of journal.queue) for (const c of q.changes) if (c.path === p && c.oid !== undefined) oid = c.oid
    return oid !== undefined ? oid : headHas
  }
  const excluded = opts.excluded ?? (() => false)
  const onDisk = new Map<string, string>()
  for (const p of filesUnder(opts.notesDir, plan.pathsOnDisk)) {
    if (!historyPath(p) || excluded(p)) continue
    try {
      const bytes = readFileSync(join(opts.notesDir, p))
      onDisk.set(p, blobOid(isTextPath(p) ? bytes.toString('utf8') : bytes))
    } catch { /* gone meanwhile */ }
  }
  const before = new Map([...onDisk.keys()].map((p) => [p, known(p, tree.get(p) ?? null)]))

  for (const p of Object.keys(journal.pending)) if (plan.forget(p)) { delete journal.pending[p]; counts.pending++ }
  for (const p of Object.keys(journal.typing)) if (plan.forget(p)) delete journal.typing[p]
  const keep = (c: QChange): QChange | null => {
    if (!plan.forget(c.path)) return c.from !== undefined && plan.forget(c.from) ? stripFrom(c) : c
    counts.queued++
    return null
  }
  journal.queue = journal.queue.map((q) => ({ ...q, changes: q.changes.map(keep).filter((c): c is QChange => c !== null) })).filter((q) => q.changes.length)
  journal.writes = journal.writes.map((w) => ({ ...w, changes: w.changes.filter((c) => !plan.forget(c.path) && !(c.from !== undefined && plan.forget(c.from))) })).filter((w) => w.changes.length)
  journal.groups = journal.groups.map((g) => ({ ...g, refs: g.refs.filter((r) => !plan.forget(r.path)) })).filter((g) => g.refs.length)
  for (const p of Object.keys(baseline)) if (plan.forget(p) || onDisk.has(p)) delete baseline[p]

  const stillOnDisk: string[] = []
  for (const [p, oid] of onDisk) {
    const after = known(p, plan.headAfter(p, tree))
    if (after === oid) continue
    stillOnDisk.push(p)
    // Only what the recorder knew already: a change made since thoth stopped is still one.
    if (oid === before.get(p)) baseline[p] = oid
  }
  if (Object.keys(baseline).length === 0) delete journal.baseline

  return {
    counts,
    stillOnDisk,
    save() {
      if (j || journal.baseline) {
        mkdirSync(dirname(file), { recursive: true })
        writeAtomic(file, JSON.stringify(journal))
      }
      // The sweep reads these paths again, and compares them with what it knows now.
      const cache = cacheFile(opts.stateDir)
      try {
        const entries = JSON.parse(readFileSync(cache, 'utf8')) as Record<string, unknown>
        const kept = Object.fromEntries(Object.entries(entries).filter(([p]) => !plan.forget(p) && !plan.pathsOnDisk.includes(p)))
        if (Object.keys(kept).length !== Object.keys(entries).length) writeAtomic(cache, JSON.stringify(kept))
      } catch { /* no cache: the sweep reads everything */ }
    },
  }
}

function stripFrom(c: QChange): QChange | null {
  const { from: _from, folder: _folder, ...rest } = c
  // A rename from a purged path with no content of its own: nothing left to say.
  return rest.oid === undefined ? null : rest
}

/** Files of the notes folder at these paths, or under them for a folder (hidden and ignored folders left out). */
function filesUnder(notesDir: string, paths: string[]): string[] {
  const out = new Set<string>()
  const visit = (rel: string) => {
    let st
    try { st = statSync(join(notesDir, rel)) } catch { return }
    if (st.isFile()) { out.add(rel); return }
    if (!st.isDirectory()) return
    for (const e of readdirSync(join(notesDir, rel), { withFileTypes: true })) {
      if (e.isDirectory() && isIgnoredDir(e.name)) continue
      visit(`${rel}/${e.name}`)
    }
  }
  for (const p of paths) visit(p)
  return [...out].sort()
}

