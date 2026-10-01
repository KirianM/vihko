// The system's git binary, as the history uses it: always
// asynchronous (never a synchronous spawn on a write's path), with an isolated
// environment (no system or user configuration, no hooks, no automatic gc),
// NUL-separated outputs, and a time limit on every call.
//
// vihko hands git the contents itself (`fast-import`) instead of letting it
// walk the notes folder: what is stored is exactly what vihko wrote or read,
// and git never stats thousands of files on a network filesystem.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Writable } from 'node:stream'

export type GitErrorCode = 'missing' | 'failed' | 'timeout'

/** A git call that failed: the binary isn't there, it exited with an error, or it ran out of time. */
export class GitError extends Error {
  readonly code: GitErrorCode
  constructor(code: GitErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface GitOptions {
  /** The repository (bare): `--git-dir`. */
  gitDir: string
  /** Its work tree, for a repository that has one: `--work-tree`, and where git runs. */
  workTree?: string
  /** Options before the command (`--no-optional-locks`). */
  flags?: string[]
  /** The binary (`git` from the PATH by default). */
  binary?: string
  /** Settings passed with `-c` besides the fixed ones. */
  config?: Record<string, string>
  /** Extra environment (tests). */
  env?: Record<string, string>
}

export interface RunOptions {
  /** What goes to stdin: bytes, or a function that writes them (it's closed afterwards). */
  input?: string | Uint8Array | ((stdin: Writable) => Promise<void>)
  timeoutMs?: number
  /** Exit codes that aren't an error (0 always is). */
  ok?: number[]
  /** Without `--git-dir` (to create the repository, or to let git find it from `cwd`). */
  bare?: boolean
  /** Where git runs for this call (the work tree by default). */
  cwd?: string
  /**
   * Takes the output as it arrives instead of collecting it (`stdout` is then
   * empty). Returning true stops git there: a reader that has what it needs.
   */
  onStdout?: (chunk: Buffer) => boolean | void
  /** Stops git (as a timeout does), and the call fails. */
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT = 60_000
/** A git asked to stop (SIGTERM, so it removes its lock files) gets this long before a SIGKILL. */
const STOP_GRACE = 5000

/** One operation at a time: each runs when the previous one has finished, whatever its outcome. */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.catch(() => {})
    return next
  }
}

export class Git {
  readonly gitDir: string
  readonly workTree: string | undefined
  private binary: string
  private prefix: string[]
  private env: Record<string, string>

  constructor(opts: GitOptions) {
    this.gitDir = opts.gitDir
    this.workTree = opts.workTree
    this.binary = opts.binary ?? 'git'
    const config: Record<string, string> = {
      'core.hooksPath': '/dev/null',
      'core.quotePath': 'false',
      'gc.auto': '0',
      // Only this repository, never a wildcard: it is vihko's own, in the state volume.
      'safe.directory': opts.gitDir,
      'core.fsync': 'committed',
      'core.fsyncMethod': 'fsync',
      ...opts.config,
    }
    this.prefix = [...Object.entries(config).flatMap(([k, v]) => ['-c', `${k}=${v}`]), ...(opts.flags ?? [])]
    // Nothing inherited that could point git elsewhere (GIT_DIR, GIT_INDEX_FILE…).
    this.env = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME ?? '/nonexistent',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
      TZ: 'UTC',
      ...opts.env,
    }
  }

  /** Runs one git command and resolves with its output. Rejects with a GitError. */
  run(args: string[], opts: RunOptions = {}): Promise<{ code: number; stdout: Buffer }> {
    const repo = opts.bare ? [] : ['--literal-pathspecs', `--git-dir=${this.gitDir}`, ...(this.workTree ? [`--work-tree=${this.workTree}`] : [])]
    const full = [...this.prefix, ...repo, ...args]
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (err: Error | null, value?: { code: number; stdout: Buffer }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) reject(err)
        else resolve(value!)
      }
      const child = spawn(this.binary, full, { env: this.env, stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd ?? this.workTree })
      const out: Buffer[] = []
      const err: Buffer[] = []
      let errBytes = 0
      /** The reader had enough (or failed taking the output): git is stopped, and that isn't git failing. */
      let stopped: { error: unknown } | null = null
      const take = opts.onStdout
      child.stdout.on('data', (d: Buffer) => {
        if (stopped) return
        if (!take) { out.push(d); return }
        let enough: boolean | void = false
        try { enough = take(d) } catch (e) { stopped = { error: e } }
        if (enough === true) stopped = { error: null }
        if (stopped) child.kill('SIGKILL')
      })
      child.stderr.on('data', (d: Buffer) => { if (errBytes < 16_384) { err.push(d); errBytes += d.length } })
      // SIGTERM first: git removes its lock files on it, and a SIGKILL would leave them behind.
      const stop = () => {
        child.kill('SIGTERM')
        setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, STOP_GRACE).unref()
      }
      const timer = setTimeout(() => {
        stop()
        done(new GitError('timeout', `git ${args[0]} took longer than ${opts.timeoutMs ?? DEFAULT_TIMEOUT} ms`))
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT)
      // The call ends when git has: whoever stops it can wait until no git is left.
      if (opts.signal) {
        const signal = opts.signal
        if (signal.aborted) stop()
        else {
          signal.addEventListener('abort', stop, { once: true })
          child.once('close', () => signal.removeEventListener('abort', stop))
        }
      }
      child.on('error', (e: NodeJS.ErrnoException) => {
        done(new GitError(e.code === 'ENOENT' ? 'missing' : 'failed', e.code === 'ENOENT' ? `${this.binary} not found` : `git ${args[0]}: ${e.message}`))
      })
      let inputError: unknown = null
      child.on('close', (code, signal) => {
        if (stopped) {
          const e = stopped.error
          return e === null ? done(null, { code: 0, stdout: Buffer.alloc(0) }) : done(e instanceof Error ? e : new Error(String(e)))
        }
        const c = code ?? -1
        if ((c === 0 || opts.ok?.includes(c)) && inputError === null) return done(null, { code: c, stdout: Buffer.concat(out) })
        const msg = Buffer.concat(err).toString('utf8').trim()
        // Our own failure writing (not git closing its input on us) is the reason.
        const pipe = ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'].includes((inputError as NodeJS.ErrnoException | null)?.code ?? '')
        if (inputError !== null && (c === 0 || !pipe)) {
          return done(new GitError('failed', `writing to git ${args[0]}: ${inputError instanceof Error ? inputError.message : String(inputError)}`))
        }
        done(new GitError('failed', `git ${args[0]} exited with ${signal ?? c}${msg ? `: ${msg}` : ''}`))
      })
      // A child that died early closes its stdin: its exit code and stderr say why (through `close`).
      child.stdin.on('error', () => {})
      const input = opts.input
      if (input === undefined) child.stdin.end()
      else if (typeof input === 'function') {
        input(child.stdin).then(() => child.stdin.end(), (e) => { inputError = e; child.stdin.destroy() })
      } else child.stdin.end(input)
    })
  }

  /** Removes the reports fast-import leaves in the repository when it fails. */
  cleanCrashReports() {
    try {
      for (const f of readdirSync(this.gitDir)) if (f.startsWith('fast_import_crash_')) rmSync(join(this.gitDir, f), { force: true })
    } catch { /* nothing to clean */ }
  }
}

/** The id git gives these contents as a blob (SHA-1 of `blob <size>\0<bytes>`). */
export function blobOid(content: string | Uint8Array): string {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
}

/** Writes to a stream, waiting when it asks to. */
export async function write(stream: Writable, chunk: string | Uint8Array): Promise<void> {
  if (stream.destroyed || stream.writableEnded) throw Object.assign(new Error('the stream is closed'), { code: 'ERR_STREAM_DESTROYED' })
  if (!stream.write(chunk)) await new Promise<void>((resolve, reject) => {
    const off = () => { stream.off('drain', onDrain); stream.off('error', onError); stream.off('close', onClose) }
    const onDrain = () => { off(); resolve() }
    const onError = (e: Error) => { off(); reject(e) }
    const onClose = () => { off(); reject(Object.assign(new Error('the stream closed'), { code: 'ERR_STREAM_DESTROYED' })) }
    stream.once('drain', onDrain)
    stream.once('error', onError)
    stream.once('close', onClose)
  })
}

// --- fast-import ---------------------------------------------------------------

export type FastOp =
  /** Writes a file; `data` null leaves this op out (its content is no longer there). */
  | { op: 'M'; path: string; data: () => Promise<Uint8Array | null> | Uint8Array | null }
  | { op: 'D'; path: string }
  /** Renames a file or a whole folder. */
  | { op: 'R'; from: string; to: string }

export interface FastCommit {
  author: { name: string; email: string }
  /** Seconds since the epoch. */
  authorTime: number
  committerTime: number
  message: string
  ops: FastOp[]
}

/** A path as fast-import reads it: always quoted, C style (the name bytes as they are). */
export function quotePath(path: string): string {
  return '"' + path.replace(/[\\"\u0000-\u001f\u007f]/g, (c) => {
    if (c === '\\') return '\\\\'
    if (c === '"') return '\\"'
    if (c === '\n') return '\\n'
    if (c === '\t') return '\\t'
    return '\\' + c.charCodeAt(0).toString(8).padStart(3, '0')
  }) + '"'
}

const ident = (s: string) => s.replace(/[<>\n\r\u0000]/g, '').trim() || 'unknown'

/**
 * Appends `commits` to `ref`, the first one on top of `parent` (null: a new
 * branch). One fast-import run: the ref moves only when the whole stream has
 * been read (`done`), so a process killed half way changes nothing. Resolves
 * with the new commits' ids, in order.
 */
export async function fastImport(git: Git, ref: string, parent: string | null, commits: FastCommit[], timeoutMs = 300_000): Promise<string[]> {
  if (commits.length === 0) return []
  const { stdout } = await git.run(['fast-import', '--quiet', '--done'], {
    timeoutMs,
    input: async (stdin) => {
      for (let i = 0; i < commits.length; i++) {
        const c = commits[i]!
        const msg = Buffer.from(c.message, 'utf8')
        await write(stdin, `commit ${ref}\nmark :${i + 1}\n`
          + `author ${ident(c.author.name)} <${ident(c.author.email)}> ${Math.floor(c.authorTime)} +0000\n`
          + `committer vihko <vihko@vihko.invalid> ${Math.floor(c.committerTime)} +0000\n`
          + `data ${msg.byteLength}\n`)
        await write(stdin, msg)
        await write(stdin, '\n')
        if (i === 0 && parent) await write(stdin, `from ${parent}\n`)
        for (const op of c.ops) {
          if (op.op === 'D') await write(stdin, `D ${quotePath(op.path)}\n`)
          else if (op.op === 'R') await write(stdin, `R ${quotePath(op.from)} ${quotePath(op.to)}\n`)
          else {
            const data = await op.data()
            if (data === null) continue
            await write(stdin, `M 100644 inline ${quotePath(op.path)}\ndata ${data.byteLength}\n`)
            await write(stdin, data)
            await write(stdin, '\n')
          }
        }
        await write(stdin, '\n')
      }
      for (let i = 0; i < commits.length; i++) await write(stdin, `get-mark :${i + 1}\n`)
      await write(stdin, 'done\n')
    },
  }).catch((err) => {
    git.cleanCrashReports()
    throw err
  })
  const ids = stdout.toString('latin1').split('\n').filter((l) => /^[0-9a-f]{40}$/.test(l))
  if (ids.length !== commits.length) throw new GitError('failed', `fast-import returned ${ids.length} commit ids for ${commits.length} commits`)
  return ids
}

// --- Reading --------------------------------------------------------------------

/** A file a commit touched, as `git log --raw --no-renames` lists it. */
export interface RawFile {
  status: 'A' | 'M' | 'D' | 'T'
  oldOid: string | null
  newOid: string | null
  path: string
}

export interface LogCommit {
  id: string
  parent: string | null
  /** Seconds. */
  authorTime: number
  commitTime: number
  message: string
  files: RawFile[]
}

const ZERO = /^0+$/

/** The format `parseLog` reads, for `git log -z --raw --no-renames --no-abbrev`. */
export const LOG_FORMAT = '--format=%x1e%H%x1f%P%x1f%at%x1f%ct%x1f%B%x1f'

export function parseLog(out: Buffer): LogCommit[] {
  const text = out.toString('utf8')
  const commits: LogCommit[] = []
  for (const rec of text.split('\x1e').slice(1)) {
    const end = rec.indexOf('\x1f\0')
    if (end < 0) continue
    const [id, parents, at, ct, message] = rec.slice(0, end).split('\x1f')
    let rest = rec.slice(end + 2)
    if (rest.startsWith('\n')) rest = rest.slice(1)
    const files: RawFile[] = []
    const tokens = rest.split('\0')
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const meta = tokens[i]!
      if (!meta.startsWith(':')) break
      const [, , oldOid, newOid, status] = meta.slice(1).split(' ')
      files.push({
        status: (status?.[0] ?? 'M') as RawFile['status'],
        oldOid: oldOid && !ZERO.test(oldOid) ? oldOid : null,
        newOid: newOid && !ZERO.test(newOid) ? newOid : null,
        path: tokens[i + 1]!,
      })
    }
    commits.push({ id: id!, parent: parents ? parents.split(' ')[0]! : null, authorTime: Number(at), commitTime: Number(ct), message: message ?? '', files })
  }
  return commits
}

/**
 * Contents of objects (`<oid>` or `<commit>:<path>`), in order; null for one
 * that doesn't exist. One `cat-file --batch` for all of them.
 */
export async function readObjects(git: Git, specs: readonly string[], timeoutMs = 60_000): Promise<(Buffer | null)[]> {
  if (specs.length === 0) return []
  // One line each: a spec with a line break (or a NUL) would be read as another one. Those aren't there.
  const broken = (s: string) => /[\n\0]/.test(s)
  if (specs.some(broken)) {
    const ok = specs.filter((s) => !broken(s))
    const got = await readObjects(git, ok, timeoutMs)
    return specs.map((s) => (broken(s) ? null : got[ok.indexOf(s)]!))
  }
  const { stdout } = await git.run(['cat-file', '--batch'], { input: specs.map((s) => s + '\n').join(''), timeoutMs })
  const out: (Buffer | null)[] = []
  let p = 0
  for (let i = 0; i < specs.length; i++) {
    const nl = stdout.indexOf(10, p)
    if (nl < 0) throw new GitError('failed', 'cat-file: truncated output')
    const line = stdout.toString('utf8', p, nl)
    p = nl + 1
    const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\w+) (\d+)$/.exec(line) // SHA-1 or SHA-256 ids
    if (!m) { out.push(null); continue } // `<spec> missing` (or ambiguous)
    const size = Number(m[3])
    out.push(m[2] === 'blob' ? stdout.subarray(p, p + size) : null)
    p += size + 1
  }
  return out
}

/** The files of a tree (a commit's), path → blob id. */
export async function readTree(git: Git, rev: string): Promise<Map<string, string>> {
  const { stdout } = await git.run(['ls-tree', '-r', '-z', '--full-tree', rev])
  const tree = new Map<string, string>()
  for (const entry of stdout.toString('utf8').split('\0')) {
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    const [, type, oid] = entry.slice(0, tab).split(' ')
    if (type === 'blob') tree.set(entry.slice(tab + 1), oid!)
  }
  return tree
}

/** The commit a ref points to, or null if it doesn't exist yet. */
export async function resolveRef(git: Git, ref: string): Promise<string | null> {
  const { code, stdout } = await git.run(['rev-parse', '--verify', '-q', `${ref}^{commit}`], { ok: [1] })
  return code === 0 ? stdout.toString('latin1').trim() : null
}
