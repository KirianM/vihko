// What a git command killed half way leaves in the managed repository
// (`<state>/history.git`), and its removal.
//
// git takes a lock file (`<name>.lock`) for every file it rewrites, and
// removes it once it's done, or when it fails, or on SIGTERM. A kill -9 in
// between (of thoth's container, say, while a version is being committed)
// leaves it there, and from then on every write to that file fails
// ("Unable to create '…/refs/heads/main.lock': File exists"): the history
// stays unavailable after the restart, and nothing more reaches git.
//
// Only thoth writes to this repository, and only while it holds the state
// volume's lock (lock.ts): the server, or `thoth history purge`. The git
// processes it starts end with it (the recorder's `gc` runs in the
// foreground and is stopped on close), except when it is killed outside a
// container. So once that lock is taken, and before the first git command,
// whatever git left in the repository belongs to a process that is gone:
//
// - Lock files, anywhere: `refs/heads/main.lock` and `HEAD.lock` (a commit
//   of the history), `packed-refs.lock`, `config.lock`, `shallow.lock`,
//   `index.lock`, `objects/info/commit-graph.lock`… Nothing else ends in
//   `.lock`: git forbids it in ref names.
// - The `.keep` fast-import puts on its pack until the refs are updated (its
//   content is `fast-import`). Left behind, git never repacks that pack, and
//   the purge's `gc --prune=now` would leave in it what was purged.
// - Temporary files under `objects/` (`tmp_*`, `.tmp-*`: a pack, its index
//   or an object being written), and packs without their `.idx`: git puts
//   the index in place last, and ignores a pack without one.
// - fast-import's crash reports (`fast_import_crash_<pid>`: fast-import dies
//   writing one when thoth is killed while it feeds it), and the `gc.pid` of
//   a gc that is gone.
//
// A `git gc` that outlived a thoth killed outside a container may still be
// running: while `gc.pid` names a git process alive on this host (git's own
// rule), nothing is removed. Its locks are its own, and it removes them.
//
// Only thoth's own repository: the user's (unmanaged mode) is never touched.
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

export type LeftoverKind = 'lock' | 'keep' | 'temporary' | 'incomplete_pack' | 'crash_report' | 'gc_pid'

/** A file a crash left in the repository, relative to it. */
export interface Leftover {
  path: string
  kind: LeftoverKind
}

const WHAT: Record<LeftoverKind, string> = {
  lock: 'a stale git lock',
  keep: 'the keep mark of a fast-import',
  temporary: 'a git temporary file',
  incomplete_pack: 'part of an incomplete pack',
  crash_report: 'a fast-import crash report',
  gc_pid: 'the gc.pid of a gc that is gone',
}

/** For the log: «removed a stale git lock left by a crash: refs/heads/main.lock». */
export const describeLeftover = (l: Leftover) => `removed ${WHAT[l.kind]} left by a crash: ${l.path}`

/**
 * Removes what a crash left in the repository at `gitDir`. Only with the
 * state volume locked, before any git command runs on it. Returns what was
 * removed (and says it through `log`); nothing if the repository doesn't
 * exist yet, or a gc may still be running on it.
 */
export function removeCrashLeftovers(gitDir: string, log: (msg: string) => void = () => {}): Leftover[] {
  if (!isDir(gitDir)) return []
  const gc = liveGc(gitDir)
  if (gc !== null) {
    log(`history: a git gc (pid ${gc}) is still running on ${gitDir}: what a crash left there is left to it`)
    return []
  }
  const found: Leftover[] = []
  collect(gitDir, '', found)
  const removed: Leftover[] = []
  for (const l of found) {
    try {
      rmSync(join(gitDir, l.path), { force: true })
      removed.push(l)
      log(`history: ${describeLeftover(l)}`)
    } catch (err) {
      log(`history: couldn't remove ${l.path}, left by a crash: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return removed
}

function collect(gitDir: string, rel: string, out: Leftover[]) {
  let entries
  try { entries = readdirSync(join(gitDir, rel), { withFileTypes: true }) } catch { return }
  const names = new Set(entries.map((e) => e.name))
  for (const e of entries) {
    const path = rel ? `${rel}/${e.name}` : e.name
    // Never through a symbolic link: only what is in the repository itself.
    if (e.isDirectory()) { collect(gitDir, path, out); continue }
    if (!e.isFile()) continue
    const kind = kindOf(gitDir, rel, e.name, names)
    if (kind) out.push({ path, kind })
  }
}

function kindOf(gitDir: string, dir: string, name: string, siblings: Set<string>): LeftoverKind | null {
  if (name.endsWith('.lock')) return 'lock'
  if (dir === '') {
    if (name.startsWith('fast_import_crash_')) return 'crash_report'
    if (name === 'gc.pid') return 'gc_pid' // not a live gc's: removeCrashLeftovers checked
    return null
  }
  if (dir !== 'objects' && !dir.startsWith('objects/')) return null
  if (name.startsWith('tmp_') || name.startsWith('.tmp-')) return 'temporary'
  if (dir !== 'objects/pack') return null
  const pack = /^(pack-[0-9a-f]+)\.([a-z]+)$/.exec(name)
  if (!pack || pack[2] === 'idx') return null
  if (!siblings.has(`${pack[1]}.idx`)) return 'incomplete_pack'
  if (pack[2] === 'keep') {
    try {
      if (readFileSync(join(gitDir, dir, name), 'utf8').trim() === 'fast-import') return 'keep'
    } catch { /* gone */ }
  }
  return null
}

/**
 * The PID of a `git gc` that may still be running on the repository, by
 * git's own rule (builtin/gc.c): `gc.pid` written less than 12 hours ago, on
 * this host, by a process that is alive. Where /proc tells, that process
 * must be git: a PID reused by something else (in a new container) isn't a gc.
 */
function liveGc(gitDir: string): number | null {
  const file = join(gitDir, 'gc.pid')
  let text: string
  let mtimeMs: number
  try {
    text = readFileSync(file, 'utf8')
    mtimeMs = statSync(file).mtimeMs
  } catch { return null }
  const m = /^(\d+) (\S+)/.exec(text)
  if (!m || Date.now() - mtimeMs > 12 * 3600_000 || m[2] !== hostname()) return null
  const pid = Number(m[1])
  if (pid === process.pid) return null
  try {
    process.kill(pid, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return null
  }
  try {
    if (!readFileSync(`/proc/${pid}/comm`, 'utf8').startsWith('git')) return null
  } catch {
    if (existsSync('/proc/self/comm')) return null // gone meanwhile
  }
  return pid
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}
