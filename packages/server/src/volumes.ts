// The two folders vihko writes to, checked before anything is opened: the
// notes folder and the state folder. vihko runs as one user (in Docker, the
// `user:` of compose.yaml, VIHKO_UID:VIHKO_GID); a folder that user can't
// write stops the start with one line per folder that says who owns it and
// the exact fix, instead of a SQLite or EACCES stack trace later on.
//
// The file system is reached through a VolumeSystem so the tests can play
// another owner, which a test can't create without root.
import { accessSync, chmodSync, constants, mkdirSync, statSync } from 'node:fs'

/** Where the fixes are explained. */
export const OWNERSHIP_GUIDE = 'guide/install.md, "The user and file ownership"'

/** What the checks need from the system. */
export interface VolumeSystem {
  /** The user and group vihko runs as (undefined where the platform has none). */
  uid: number | undefined
  gid: number | undefined
  mkdir(path: string, mode: number): void
  stat(path: string): { uid: number; gid: number; mode: number; isDirectory(): boolean }
  /** Throws (EACCES, EROFS…) unless this process can create and delete entries in the folder. */
  access(path: string): void
  chmod(path: string, mode: number): void
}

export const hostSystem: VolumeSystem = {
  uid: process.getuid?.(),
  gid: process.getgid?.(),
  mkdir: (path, mode) => { mkdirSync(path, { recursive: true, mode }) },
  stat: (path) => statSync(path),
  // access(2) asks the file system itself: an NFS server's own rules (squashed
  // users, ACLs) and a read-only mount answer too, not only the mode bits.
  access: (path) => accessSync(path, constants.W_OK | constants.X_OK),
  chmod: (path, mode) => chmodSync(path, mode),
}

/** vihko can't start: one line per problem, meant for the log as they are, without a stack trace. */
export class StartupError extends Error {
  readonly code = 'startup'
  readonly lines: readonly string[]
  constructor(lines: readonly string[]) {
    super(lines.join('\n'))
    this.lines = lines
  }
}

type Which = 'notes' | 'state'

const ids = (uid: number | undefined, gid: number | undefined) => `${uid}:${gid}`
const octal = (mode: number) => (mode & 0o777).toString(8)
const codeOf = (err: unknown) => (err as NodeJS.ErrnoException).code ?? (err as Error).message

/**
 * What stops vihko from writing to its folders, one line each (none: it can).
 * The state folder is created if it's missing (closed, 0700); the notes
 * folder must exist, since an empty one where the notes should be (a share
 * not mounted yet) is worse than not starting.
 */
export function volumeProblems(dirs: { notesDir?: string; stateDir: string }, sys: VolumeSystem = hostSystem): string[] {
  const problems: string[] = []
  if (dirs.notesDir !== undefined) {
    const p = folderProblem('notes', dirs.notesDir, sys)
    if (p) problems.push(p)
  }
  const p = folderProblem('state', dirs.stateDir, sys)
  if (p) problems.push(p)
  return problems
}

/** Throws a StartupError with every problem found. */
export function checkVolumes(dirs: { notesDir?: string; stateDir: string }, sys: VolumeSystem = hostSystem): void {
  const problems = volumeProblems(dirs, sys)
  if (problems.length) throw new StartupError(problems)
}

function folderProblem(which: Which, dir: string, sys: VolumeSystem): string | null {
  const what = `the ${which} folder ${dir}`
  const me = ids(sys.uid, sys.gid)
  let st: ReturnType<VolumeSystem['stat']>
  try {
    st = sys.stat(dir)
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') return `vihko can't read ${what} (${codeOf(err)}), running as ${me}: check the folder and its parents on the host; see ${OWNERSHIP_GUIDE}`
    if (which === 'notes') return `${what} doesn't exist: create it, or check the notes volume in compose.yaml (VIHKO_NOTES_DIR outside Docker)`
    try {
      sys.mkdir(dir, 0o700)
      return null
    } catch (mkErr) {
      return `${what} doesn't exist and vihko, running as ${me}, can't create it (${codeOf(mkErr)}): create it owned by ${me}; see ${OWNERSHIP_GUIDE}`
    }
  }
  if (!st.isDirectory()) return `${what} is not a folder: the ${which} volume must be a folder`
  try {
    sys.access(dir)
    return null
  } catch (err) {
    return notWritable(which, dir, st, codeOf(err), sys)
  }
}

function notWritable(which: Which, dir: string, st: { uid: number; gid: number; mode: number }, code: string, sys: VolumeSystem): string {
  const what = `the ${which} folder ${dir}`
  if (code === 'EROFS') return `vihko can't write to ${what}: it's mounted read-only. Remove :ro from the ${which} volume in compose.yaml`
  if (sys.uid === undefined) return `vihko can't write to ${what} (${code}); see ${OWNERSHIP_GUIDE}`
  const me = ids(sys.uid, sys.gid)
  const owner = ids(st.uid, st.gid)
  const head = `vihko can't write to ${what}: it belongs to ${owner} (mode ${octal(st.mode)}) and vihko runs as ${me}.`
  const guide = `; see ${OWNERSHIP_GUIDE}`
  if (st.uid === sys.uid) {
    // Its own folder, closed to itself (or an NFS export that maps it to someone else).
    return `${head} Fix: chmod u+rwx the ${which} folder on the host${which === 'notes' ? ' (on NFS, check how the export maps users)' : ''}${guide}`
  }
  const byRoot = st.uid === 0
  if (which === 'state') {
    // The state belongs to whoever owns the notes: vihko's user, once VIHKO_UID/VIHKO_GID are right.
    return `${head} Fix: ${chown(me, 'state')}${byRoot ? '' : `, or, if ${owner} owns your notes, set VIHKO_UID=${st.uid} and VIHKO_GID=${st.gid} in .env next to compose.yaml`}${guide}`
  }
  if (byRoot) {
    return `${head} Fix: set VIHKO_UID and VIHKO_GID in .env next to compose.yaml to the user that owns your notes (on NFS, one the export lets write), or ${chown(me, 'notes')}${guide}`
  }
  return `${head} Fix: run vihko as the owner of your notes, VIHKO_UID=${st.uid} and VIHKO_GID=${st.gid} in .env next to compose.yaml, and ${chown(owner, 'state')}${guide}`
}

/** The host's side of a fix: vihko only knows the folder inside the container. */
const chown = (owner: string, which: Which) => `chown -R ${owner} the ${which} volume's folder on the host (./${which} next to the example compose.yaml)`

/**
 * A line for the log when vihko runs as root, which it never needs (null
 * otherwise): what `.env` says after a quick start run as root without
 * giving the folders to an ordinary user.
 */
export function rootWarning(sys: VolumeSystem = hostSystem): string | null {
  if (sys.uid !== 0) return null
  return `vihko runs as root (${ids(sys.uid, sys.gid)}), which it doesn't need: give the notes and state folders to an ordinary user and set VIHKO_UID and VIHKO_GID in .env to that user; see ${OWNERSHIP_GUIDE}`
}

/**
 * The state folder closed to other users of the system: it holds state.db
 * (password hashes, second-factor secrets), the whole history of every note
 * (personal folders too), the trash and the editors' recovery logs, and
 * vihko's permissions don't reach a shell on the host. Only the folder:
 * nothing gets past it, whatever the files' own modes (and copies taken with
 * `cp -p` or `tar -p` keep them). One it can't change (another owner) is
 * said, not fatal. Created if missing; one vihko can't write is
 * checkVolumes's to report, before this runs.
 */
export function prepareStateDir(stateDir: string, log: (msg: string) => void = () => {}, sys: VolumeSystem = hostSystem): void {
  sys.mkdir(stateDir, 0o700)
  const st = sys.stat(stateDir)
  const mode = st.mode & 0o777
  if ((mode & 0o077) === 0) return
  try {
    sys.chmod(stateDir, mode & 0o700)
  } catch (err) {
    if (sys.uid !== undefined && st.uid !== sys.uid) {
      const me = ids(sys.uid, sys.gid)
      log(`the state folder ${stateDir} belongs to ${ids(st.uid, st.gid)}, not to the user vihko runs as (${me}), so vihko can't close it to other users of this system (mode ${octal(mode)}). Fix: ${chown(me, 'state')}; see ${OWNERSHIP_GUIDE}`)
    } else {
      log(`the state folder ${stateDir} can be read by other users of this system (mode ${octal(mode)}), and vihko can't change it: ${(err as Error).message}`)
    }
  }
}
