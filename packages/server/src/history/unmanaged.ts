// Unmanaged mode: the history is the git repository the user
// keeps in the notes folder, or above it when the folder is part of a larger
// repository (paths are translated between its top and the notes folder, and
// nothing outside the notes folder shows). A version is one of their commits
// that touches the file, by the commit's author; moves are followed with
// git's own rename detection (`--follow`, `-M`).
//
// vihko never writes to that repository: no commits, no refs, no index
// refresh, no gc. Only reading commands, with optional locks off
// (`--no-optional-locks`, `GIT_OPTIONAL_LOCKS=0`), no lazy fetch of missing
// objects, no network, and nothing the repository could name to run (hooks,
// fsmonitor, external diffs, signature checks). Restoring a version is an
// ordinary write through the core: for their git, a change without a commit.
//
// The repository may be on a network filesystem and long: every call has a
// time limit, pages are bounded, and cursors pin the commit a listing started
// from, so pages stay the same while the user commits.
import { existsSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { Alert } from '@vihko/core'
import { Git, GitError, Serial, readObjects, resolveRef } from './git.ts'
import { historyPath, isTextPath } from './recorder.ts'
import { wordStats } from './diff.ts'
import { HistoryError, authorFilter, decodeCursor, encodeCursor, matchesAuthor, type AuthorRef, type ChangeKind, type HistoryReader, type RawChange, type RawVersion, type VersionText } from './reader.ts'

export interface UnmanagedOptions {
  notesDir: string
  /** The git binary. */
  binary?: string
  /** How long a look for the repository holds before looking again (30 s). */
  recheckMs?: number
  log?: (msg: string) => void
  now?: () => number
}

/** Time limits: finding the repository, walking a log, reading contents, the author list. */
const LOCATE_TIMEOUT = 10_000
const LOG_TIMEOUT = 30_000
const READ_TIMEOUT = 30_000
const AUTHORS_TIMEOUT = 20_000
/** Commits looked at for one page of «Recent changes» before answering with what was found. */
const MAX_SCAN = 2000
/** A note's commits walked, at most (to find one of its versions, or across pages). */
const MAX_WALK = 20_000
/** Commits the author list starts from; then it adds the new ones. */
const AUTHORS_SCAN = 1000
const STATS_CACHE = 5000
/** Notes whose walks are kept (a version list, then its versions and diffs). */
const WALK_CACHE = 32

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/** The fields `parseLog` reads, for `git log -z --raw`. */
const LOG_FORMAT = '--format=%x1e%H%x1f%P%x1f%at%x1f%aN%x1f%aE%x1f'
const LOG_ARGS = ['-z', '--raw', '--no-abbrev', '-M', '--no-ext-diff', '--no-textconv', '--no-color', LOG_FORMAT]

/** A file a commit touched, as `git log -z --raw` lists it. */
interface LogFile {
  /** A, M, D, T, R or C. */
  status: string
  oldMode: string
  newMode: string
  oldOid: string | null
  newOid: string | null
  path: string
  /** Renamed (or copied) from. */
  from?: string
}

interface LogCommit {
  id: string
  parents: string[]
  /** Seconds. */
  authorTime: number
  name: string
  email: string
  files: LogFile[]
}

/** A file of a commit as a version of a note of the notes folder. */
interface Version {
  commit: LogCommit
  /** Its path in the notes folder. */
  path: string
  change: ChangeKind
  from?: string
  /** Blob ids: the file before and after (null: it didn't exist, or isn't a file). */
  before: string | null
  after: string | null
}

/** A note's commits, as `git log --follow` lists them from one commit, as far as they were read. */
interface Walk {
  /** Every commit git listed, with the note's version in it (null: none of ours). */
  items: (Version | null)[]
  byId: Map<string, Version>
  /** The note's path (in the repository) where the walk stands. */
  cur: string
  /**
   * Where reading goes on: `git log --follow` from `rev` with the note at
   * `path`, past the items read from there on (from `base`), which are left
   * out as they come again. (With `--follow`, git's `--skip` counts every
   * commit it walks, and it doesn't follow a rename in what it skips.) After
   * a move, reading goes on from the commit before it, with the old path.
   */
  resume: { rev: string; path: string; base: number }
  /** Nothing older: the history ends, or the note came from outside the notes folder. */
  done: boolean
}

interface Repo {
  git: Git
  /** The notes folder in the repository, with `/` ('' at its top). */
  prefix: string
  /** Where a shallow clone cuts the history: commits whose parents it doesn't have. */
  shallow: Set<string>
  /** What identifies it (caches are dropped when it changes). */
  key: string
}

type Located =
  | { kind: 'repo'; repo: Repo; top: string }
  | { kind: 'none'; message: string }
  | { kind: 'error'; code: string; message: string }

interface Cursor { start: string; skip: number }
const isCursor = (v: unknown): v is Cursor => typeof v === 'object' && v !== null
  && typeof (v as Cursor).start === 'string' && OID.test((v as Cursor).start)
  && Number.isSafeInteger((v as Cursor).skip) && (v as Cursor).skip >= 0

export class UnmanagedReader implements HistoryReader {
  private opts: UnmanagedOptions
  private log: (msg: string) => void
  private now: () => number
  private reads = new Serial()
  private located: Located | null = null
  private checkedAt = 0
  private looking: Promise<Located> | null = null
  private stats = new Map<string, { added: number; removed: number }>()
  private walks = new Map<string, Walk>()
  private authorsSeen: { head: string | null; list: Map<string, AuthorRef> } = { head: null, list: new Map() }

  constructor(opts: UnmanagedOptions) {
    this.opts = opts
    this.log = opts.log ?? (() => {})
    this.now = opts.now ?? Date.now
  }

  // --- The repository -----------------------------------------------------------

  /** Looks for the repository now (the mode just changed, or it's time). */
  refresh(): Promise<Located> {
    this.looking ??= this.look().then((l) => {
      this.adopt(l)
      return l
    }).finally(() => { this.looking = null })
    return this.looking
  }

  private stale(): boolean {
    return this.now() - this.checkedAt >= (this.opts.recheckMs ?? 30_000)
  }

  /** What `status` and `alerts` show is the last look; an old one is renewed in the background. */
  private renew() {
    if (this.located === null || this.stale()) this.refresh().catch((err) => this.log(`history: ${err instanceof Error ? err.message : String(err)}`))
  }

  private adopt(l: Located) {
    const before = this.located
    this.located = l
    this.checkedAt = this.now()
    const key = l.kind === 'repo' ? l.repo.key : null
    if (before?.kind === 'repo' && before.repo.key === key) return
    this.walks.clear()
    this.stats.clear()
    this.authorsSeen = { head: null, list: new Map() }
    if (l.kind === 'repo') this.log(`history: reading the git repository at ${l.top}${l.repo.prefix ? ` (notes in ${l.repo.prefix})` : ''}`)
    else if (before === null || before.kind === 'repo' || before.message !== l.message) this.log(`history: ${l.message}`)
  }

  private async look(): Promise<Located> {
    let notes: string
    try {
      notes = realpathSync(this.opts.notesDir)
    } catch (err) {
      return { kind: 'none', message: `the notes folder can't be read: ${err instanceof Error ? err.message : String(err)}` }
    }
    const top = repositoryOf(notes)
    if (top === null) return { kind: 'none', message: 'the notes folder is not inside a git repository' }
    try {
      // git finds it from the notes folder, as it would for the user; its owner
      // may be another user (NFS): `safe.directory` names only this work tree.
      const probe = readOnlyGit({ gitDir: join(top, '.git'), workTree: top, binary: this.opts.binary })
      const { stdout } = await probe.run(
        ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-path', 'shallow', '--is-shallow-repository'],
        { bare: true, cwd: notes, timeoutMs: LOCATE_TIMEOUT },
      )
      const [workTree, gitDir, shallowFile, isShallow] = stdout.toString('utf8').split('\n')
      if (!workTree || !gitDir || !shallowFile) throw new GitError('failed', 'git rev-parse: unexpected output')
      const rel = relative(workTree, notes)
      if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return { kind: 'none', message: 'the notes folder is outside the work tree of the git repository above it' }
      const shallow = new Set<string>()
      if (isShallow === 'true') for (const line of (await readFile(shallowFile, 'utf8')).split('\n')) if (OID.test(line)) shallow.add(line)
      const prefix = rel.split(sep).join('/')
      const git = readOnlyGit({ gitDir, workTree, binary: this.opts.binary })
      return { kind: 'repo', top: workTree, repo: { git, prefix, shallow, key: [gitDir, workTree, prefix, [...shallow].sort().join(',')].join('\0') } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof GitError && /not a git repository/i.test(message)) return { kind: 'none', message: `no git repository at ${top}: ${message}` }
      return { kind: 'error', code: err instanceof GitError ? `git_${err.code}` : 'failed', message }
    }
  }

  /** For /api/history/status: whether there is a repository git can read. */
  status(): { available: boolean; error: { code: string; message: string } | null } {
    this.renew()
    const l = this.located
    if (l === null) return { available: false, error: { code: 'history_unavailable', message: 'looking for the repository' } }
    if (l.kind === 'none') return { available: false, error: { code: 'history_no_repository', message: l.message } }
    if (l.kind === 'error') return { available: false, error: { code: l.code, message: l.message } }
    return { available: true, error: null }
  }

  alerts(): Alert[] {
    this.renew()
    const l = this.located
    if (l?.kind === 'none') return [{ code: 'history_no_repository', actions: [] }]
    if (l?.kind === 'error') return [{ code: 'history_unavailable', detail: l.message, actions: [] }]
    return []
  }

  /**
   * Runs a read on the repository, one at a time. Without a repository that
   * git could read at the last look, it looks again first; a git failure has
   * the next read look again.
   */
  private run<T>(fn: (repo: Repo) => Promise<T>): Promise<T> {
    return this.reads.run(async () => {
      const l = this.located?.kind === 'repo' && !this.stale() ? this.located : await this.refresh()
      if (l.kind !== 'repo') throw new HistoryError('history_unavailable', l.message)
      try {
        return await fn(l.repo)
      } catch (err) {
        if (err instanceof GitError) this.checkedAt = 0
        throw err
      }
    })
  }

  // --- HistoryReader ------------------------------------------------------------

  versions(path: string, page: { cursor?: string | null; limit: number }) {
    return this.run(async (repo) => {
      const c = decodeCursor(page.cursor, isCursor)
      const gitPath = toGit(repo, path)
      const start = c?.start ?? await resolveRef(repo.git, 'HEAD')
      if (gitPath === null || start === null) return { versions: [], next: null }
      const skip = c?.skip ?? 0
      const walk = this.walkOf(repo, start, gitPath)
      // Until one version past the page: then there is a next one.
      let have = 0
      for (let i = skip; i < walk.items.length; i++) if (walk.items[i]) have++
      if (have <= page.limit) await this.extend(repo, walk, (v, i) => (v && i >= skip && ++have > page.limit) || false)
      const list: Version[] = []
      let i = skip
      for (; i < walk.items.length && list.length < page.limit; i++) { const v = walk.items[i]; if (v) list.push(v) }
      const next = walk.items.slice(i).some(Boolean) ? encodeCursor({ start, skip: i } satisfies Cursor) : null
      const counts = await this.countAll(repo, list)
      const versions: RawVersion[] = list.map((v, k) => ({
        id: v.commit.id,
        at: iso(v.commit.authorTime),
        authors: [authorOf(v.commit)],
        reason: null,
        foundAtStartup: false,
        path: v.path,
        change: v.change,
        ...(v.from !== undefined ? { from: v.from } : {}),
        ...counts[k]!,
      }))
      return { versions, next }
    })
  }

  version(path: string, id: string) {
    return this.run(async (repo): Promise<VersionText | null> => {
      const gitPath = toGit(repo, path)
      if (!OID.test(id) || gitPath === null) return null
      const head = await resolveRef(repo.git, 'HEAD')
      if (head === null) return null
      const walk = this.walkOf(repo, head, gitPath)
      if (!walk.byId.has(id)) await this.extend(repo, walk, (v) => v?.commit.id === id)
      const v = walk.byId.get(id)
      if (!v) return null
      const specs = [v.before, v.after].filter((s): s is string => s !== null)
      const got = await readObjects(repo.git, specs, READ_TIMEOUT)
      const blob = (oid: string | null) => (oid === null ? null : got[specs.indexOf(oid)]?.toString('utf8') ?? null)
      return { path: v.path, id: v.commit.id, at: iso(v.commit.authorTime), text: blob(v.after), before: blob(v.before) }
    })
  }

  file(id: string, path: string) {
    return this.run(async (repo) => {
      const gitPath = toGit(repo, path)
      if (!OID.test(id) || gitPath === null) return null
      const [bytes] = await readObjects(repo.git, [`${id}:${gitPath}`], READ_TIMEOUT)
      // A file kept in Git LFS is only its pointer here: restoring it would break the file.
      return bytes && !isLfsPointer(bytes) ? bytes : null
    })
  }

  changes(page: { cursor?: string | null; limit: number; author?: string | null; canRead: (path: string, at: string) => boolean }) {
    return this.run(async (repo) => {
      const c = decodeCursor(page.cursor, isCursor)
      const start = c?.start ?? await resolveRef(repo.git, 'HEAD')
      if (start === null) return { changes: [], next: null }
      const skip = c?.skip ?? 0
      const found: { commit: LogCommit; files: Mapped[] }[] = []
      let scanned = 0
      let next: string | null = null
      const take = (commits: LogCommit[]): boolean => {
        for (const commit of commits) {
          if (found.length === page.limit || scanned >= MAX_SCAN) {
            next = encodeCursor({ start, skip: skip + scanned } satisfies Cursor)
            return true
          }
          scanned++
          // The first commit a shallow clone has: what it changed is unknown.
          if (commit.parents.length === 0 && repo.shallow.has(commit.id)) continue
          const authors = [authorOf(commit)]
          this.see(authors[0]!)
          if (!matchesAuthor(authors, page.author)) continue
          // Where a readable file came from is only said if that path is readable too.
          const at = iso(commit.authorTime)
          const files = mapFiles(repo, commit).filter((f) => page.canRead(f.path, at))
            .map((f) => (f.from !== undefined && !page.canRead(f.from, at) ? { ...f, from: undefined } : f))
          if (files.length) found.push({ commit, files })
        }
        return false
      }
      const parser = new LogParser()
      let stopped = false
      await repo.git.run(['log', ...LOG_ARGS, `--skip=${skip}`, '--end-of-options', start, ...(repo.prefix ? ['--', repo.prefix] : [])], {
        timeoutMs: LOG_TIMEOUT,
        onStdout: (chunk) => (stopped = take(parser.push(chunk))),
      })
      if (!stopped) take(parser.end())
      const flat = found.flatMap((f) => f.files)
      const counts = await this.countAll(repo, flat)
      let k = 0
      const changes: RawChange[] = found.map((f) => ({
        id: f.commit.id,
        at: iso(f.commit.authorTime),
        authors: [authorOf(f.commit)],
        reason: null,
        foundAtStartup: false,
        files: f.files.map((file) => ({ path: file.path, change: file.change, ...(file.from !== undefined ? { from: file.from } : {}), ...counts[k++]! })),
      }))
      return { changes, next }
    })
  }

  /**
   * Authors of the latest commits that touch the notes folder, and of every
   * change listed since: never a walk of the whole history.
   */
  authors() {
    return this.run(async (repo) => {
      const head = await resolveRef(repo.git, 'HEAD')
      if (head === null) return []
      if (this.authorsSeen.head !== head) {
        const scan = async (range: string[]) => {
          const { stdout } = await repo.git.run(['log', '-z', `-n${AUTHORS_SCAN}`, '--format=%aN%x1f%aE', '--end-of-options', ...range, ...(repo.prefix ? ['--', repo.prefix] : [])], { timeoutMs: AUTHORS_TIMEOUT })
          for (const rec of stdout.toString('utf8').split('\0')) {
            const [name, email] = rec.split('\x1f')
            if (name !== undefined && email !== undefined) this.see({ kind: 'git', name, email })
          }
        }
        try {
          // Only what's new since the last look (from the start if that commit is gone: a rewritten history).
          await scan(this.authorsSeen.head ? [head, `^${this.authorsSeen.head}`] : [head]).catch((err) => {
            if (this.authorsSeen.head === null || !(err instanceof GitError) || err.code === 'timeout') throw err
            return scan([head])
          })
          this.authorsSeen.head = head
        } catch (err) {
          // The list is a convenience for the filter: what is known already will do.
          if (!(err instanceof GitError)) throw err
          this.log(`history: listing authors: ${err.message}`)
        }
      }
      return [...this.authorsSeen.list.values()]
    })
  }

  // --- Walking a note's history ---------------------------------------------------

  private walkOf(repo: Repo, start: string, gitPath: string): Walk {
    const key = `${start}\0${gitPath}`
    let walk = this.walks.get(key)
    if (walk) this.walks.delete(key)
    else walk = { items: [], byId: new Map(), cur: gitPath, resume: { rev: start, path: gitPath, base: 0 }, done: false }
    this.walks.set(key, walk)
    if (this.walks.size > WALK_CACHE) this.walks.delete(this.walks.keys().next().value!)
    return walk
  }

  /**
   * Reads more of a note's commits (`git log --follow` from `start`, resuming
   * where the walk stands) until `enough` says so for one of them, the history
   * ends, or the walk reaches its bound.
   */
  private async extend(repo: Repo, walk: Walk, enough: (v: Version | null, index: number) => boolean) {
    if (walk.done) return
    const { rev, path, base } = walk.resume
    let known = walk.items.length - base
    const take = (commits: LogCommit[]): boolean => {
      for (const commit of commits) {
        if (known > 0) {
          // Read already; the same commit, since `rev` is fixed.
          known--
          continue
        }
        const v = this.stepOf(repo, commit, walk)
        walk.items.push(v)
        if (v) walk.byId.set(commit.id, v)
        if (!walk.done && walk.cur !== walk.resume.path) {
          // Moved here in this commit: git goes on with the old path, and so would a later read.
          const parent = commit.parents[0]
          if (parent) walk.resume = { rev: parent, path: walk.cur, base: walk.items.length }
          else walk.done = true
        }
        if (walk.items.length >= MAX_WALK) walk.done = true
        if (walk.done || enough(v, walk.items.length - 1)) return true
      }
      return false
    }
    const parser = new LogParser()
    let stopped = false
    await repo.git.run(['log', '--follow', ...LOG_ARGS, '--end-of-options', rev, '--', path], {
      timeoutMs: LOG_TIMEOUT,
      onStdout: (chunk) => (stopped = take(parser.push(chunk))),
    })
    if (!stopped) {
      take(parser.end())
      walk.done = true
    }
  }

  /** The note's version in one commit of its walk, and where the walk goes on. */
  private stepOf(repo: Repo, commit: LogCommit, walk: Walk): Version | null {
    // git lists only the followed file; if its idea of the path differs from ours (branches), git's wins.
    const f = commit.files.find((x) => x.path === walk.cur) ?? (commit.files.length === 1 ? commit.files[0] : undefined)
    if (!f) return null
    walk.cur = f.from ?? f.path
    // The first commit a shallow clone has: what it changed is unknown (its text is the next version's `before`).
    if (commit.parents.length === 0 && repo.shallow.has(commit.id)) { walk.done = true; return null }
    const path = fromGit(repo, f.path)
    if (path === null) { walk.done = true; return null }
    let before = isFileMode(f.oldMode) ? f.oldOid : null
    const after = isFileMode(f.newMode) ? f.newOid : null
    if (f.status === 'R') {
      const src = fromGit(repo, f.from!)
      if (src !== null) return before === null && after === null ? null : { commit, path, change: 'moved', from: src, before, after }
    }
    if (f.status === 'R' || f.status === 'C') {
      // Moved in from outside the notes folder, or a copy of another file: here it starts.
      walk.done = true
      before = null
    }
    if (before === null && after === null) return null
    return { commit, path, change: before === null ? 'created' : after === null ? 'deleted' : 'modified', before, after }
  }

  // --- Details ------------------------------------------------------------------------

  private see(a: AuthorRef) {
    const key = authorFilter(a)
    if (!this.authorsSeen.list.has(key)) this.authorsSeen.list.set(key, a)
  }

  /** Words added and removed for each file, between two blobs (text files only). */
  private async countAll(repo: Repo, files: { path: string; before: string | null; after: string | null }[]): Promise<{ added: number; removed: number }[]> {
    const want = new Set<string>()
    for (const f of files) {
      if (!isTextPath(f.path) || f.before === f.after || this.stats.has(`${f.before}:${f.after}`)) continue
      if (f.before) want.add(f.before)
      if (f.after) want.add(f.after)
    }
    const specs = [...want]
    const blobs = new Map<string, string>()
    const read = await readObjects(repo.git, specs, READ_TIMEOUT)
    specs.forEach((s, i) => blobs.set(s, read[i]?.toString('utf8') ?? ''))
    return files.map((f) => {
      if (!isTextPath(f.path) || f.before === f.after) return { added: 0, removed: 0 }
      const key = `${f.before}:${f.after}`
      let s = this.stats.get(key)
      if (!s) {
        s = wordStats(f.before ? blobs.get(f.before) ?? '' : '', f.after ? blobs.get(f.after) ?? '' : '')
        this.stats.set(key, s)
        if (this.stats.size > STATS_CACHE) this.stats.delete(this.stats.keys().next().value!)
      }
      return s
    })
  }
}

/** The directory holding a `.git` (folder, or file for worktrees and submodules) at or above `dir`, or null. */
export function repositoryOf(dir: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d
    if (dirname(d) === d) return null
  }
}

/**
 * git as vihko runs it on someone else's repository: nothing that writes or
 * takes a lock, nothing from outside (no lazy fetch in a partial clone, no
 * transport), nothing the repository could name to run. Discovery stops at
 * the work tree (never a repository further up), and `safe.directory` names
 * only that work tree. The repository's own settings that would change what
 * a log says (following a folder, hiding the first commit's files, another
 * encoding) are set back to git's defaults.
 */
function readOnlyGit(opts: { gitDir: string; workTree: string; binary?: string }): Git {
  return new Git({
    gitDir: opts.gitDir,
    workTree: opts.workTree,
    binary: opts.binary,
    flags: ['--no-optional-locks'],
    config: {
      'safe.directory': opts.workTree,
      'core.fsmonitor': 'false',
      'log.showSignature': 'false',
      'maintenance.auto': 'false',
      'protocol.allow': 'never',
      'log.follow': 'false',
      'log.showRoot': 'true',
      'diff.relative': 'false',
      'i18n.logOutputEncoding': 'UTF-8',
    },
    env: { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_CEILING_DIRECTORIES: dirname(opts.workTree) },
  })
}

/** A note's path in the repository; null if it can't have a history. */
function toGit(repo: Repo, path: string): string | null {
  if (!historyPath(path)) return null
  return repo.prefix ? `${repo.prefix}/${path}` : path
}

/** A repository path in the notes folder; null outside it, or for what vihko ignores. */
function fromGit(repo: Repo, path: string): string | null {
  const rel = repo.prefix ? (path.startsWith(repo.prefix + '/') ? path.slice(repo.prefix.length + 1) : null) : path
  return rel !== null && historyPath(rel) ? rel : null
}

/** A regular file: not a symbolic link (its blob is the target) nor a submodule (a commit). */
const isFileMode = (mode: string) => mode.startsWith('100')

interface Mapped { path: string; change: ChangeKind; from?: string; before: string | null; after: string | null }

/** A commit's files in the notes folder, as changes. */
function mapFiles(repo: Repo, c: LogCommit): Mapped[] {
  const out: Mapped[] = []
  for (const f of c.files) {
    const before = isFileMode(f.oldMode) ? f.oldOid : null
    const after = isFileMode(f.newMode) ? f.newOid : null
    const path = fromGit(repo, f.path)
    if (f.from !== undefined && f.status === 'R') {
      const src = fromGit(repo, f.from)
      if (path !== null && src !== null) { if (before !== null || after !== null) out.push({ path, change: 'moved', from: src, before, after }); continue }
      // Moved in from outside the notes folder, or out of it.
      if (path !== null && after !== null) out.push({ path, change: 'created', before: null, after })
      else if (src !== null && before !== null) out.push({ path: src, change: 'deleted', before, after: null })
      continue
    }
    const b = f.status === 'C' ? null : before
    if (path === null || (b === null && after === null)) continue
    out.push({ path, change: b === null ? 'created' : after === null ? 'deleted' : 'modified', before: b, after })
  }
  return out
}

const authorOf = (c: LogCommit): AuthorRef => ({ kind: 'git', name: c.name, email: c.email })

const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

function isLfsPointer(bytes: Uint8Array): boolean {
  return bytes.byteLength < 1024 && Buffer.from(bytes).toString('latin1').startsWith('version https://git-lfs.github.com/spec/')
}

/**
 * `git log -z --raw` with LOG_FORMAT, read as it arrives: each commit starts
 * with \x1e, so one is complete when the next one starts (or at the end). A
 * UTF-8 name never holds that byte.
 */
class LogParser {
  private rest: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): LogCommit[] {
    const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk
    const last = buf.lastIndexOf(0x1e)
    if (last <= 0) {
      this.rest = buf
      return []
    }
    this.rest = buf.subarray(last)
    return parseLog(buf.subarray(0, last))
  }

  end(): LogCommit[] {
    const out = parseLog(this.rest)
    this.rest = Buffer.alloc(0)
    return out
  }
}

function parseLog(buf: Buffer): LogCommit[] {
  const commits: LogCommit[] = []
  for (const rec of buf.toString('utf8').split('\x1e')) {
    const end = rec.indexOf('\x1f\0')
    if (end < 0) continue
    const [id, parents, at, name, email] = rec.slice(0, end).split('\x1f')
    let rest = rec.slice(end + 2)
    if (rest.startsWith('\n')) rest = rest.slice(1)
    const tokens = rest.split('\0')
    const files: LogFile[] = []
    for (let i = 0; i < tokens.length;) {
      const meta = tokens[i]!
      if (!meta.startsWith(':')) break
      const [oldMode = '', newMode = '', oldOid = '', newOid = '', status = 'M'] = meta.slice(1).split(' ')
      const two = status[0] === 'R' || status[0] === 'C'
      if (i + (two ? 2 : 1) >= tokens.length) break
      files.push({
        status: status[0]!,
        oldMode,
        newMode,
        oldOid: /^0+$/.test(oldOid) ? null : oldOid,
        newOid: /^0+$/.test(newOid) ? null : newOid,
        path: tokens[i + (two ? 2 : 1)]!,
        ...(two ? { from: tokens[i + 1]! } : {}),
      })
      i += two ? 3 : 2
    }
    if (id && OID.test(id)) commits.push({ id, parents: parents ? parents.split(' ') : [], authorTime: Number(at), name: name ?? '', email: email ?? '', files })
  }
  return commits
}
