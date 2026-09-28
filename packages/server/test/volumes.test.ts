// vihko runs as one user (in Docker, VIHKO_UID:VIHKO_GID) and must write to
// both folders. One it can't write stops the start with a line that says who
// owns it, who vihko runs as and the exact fix, never a SQLite stack trace.
//
// A folder that belongs to another user can't be made without root, so two
// kinds of test: real folders closed to their own owner (mode 555), which
// access(2) refuses like any other, and a VolumeSystem that plays the owner
// and the errors of the cases a real folder can't reach.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, statSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OWNERSHIP_GUIDE, StartupError, checkVolumes, volumeProblems, prepareStateDir, rootWarning, start, configFromEnv, type VolumeSystem } from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const ME = `${process.getuid!()}:${process.getgid!()}`
// Root writes anywhere, mode or not: the real-folder tests mean nothing as root.
const asRoot = process.getuid!() === 0 ? 'root ignores the folder modes' : false

/** A folder closed to everyone, its owner included (reopened at the end, so it can be removed). */
function closedFolder(t: { after(fn: () => void): void }, parent = tempDir('vihko-volumes-')): string {
  const dir = join(parent, m.aFolder())
  mkdirSync(dir)
  chmodSync(dir, 0o555)
  t.after(() => chmodSync(dir, 0o700))
  return dir
}

/** A user id that isn't vihko's, nor root's. */
function anotherId(not: number): number {
  let id = m.anInt(1001, 60_000)
  while (id === not) id = m.anInt(1001, 60_000)
  return id
}

/** Folders as `owners` says, as vihko running as `uid:gid`; `refuse` is access(2)'s answer for a folder vihko can't write. */
function playedSystem(uid: number, gid: number, owners: Record<string, { uid: number; gid: number; mode: number }>, refuse = 'EACCES'): VolumeSystem & { chmods: string[] } {
  const chmods: string[] = []
  const errno = (code: string) => Object.assign(new Error(code), { code })
  return {
    uid, gid, chmods,
    mkdir: () => {},
    stat: (path) => {
      const o = owners[path]
      if (!o) throw errno('ENOENT')
      return { ...o, isDirectory: () => true }
    },
    access: (path) => {
      const o = owners[path]!
      const bits = o.uid === uid ? (o.mode >> 6) & 7 : o.gid === gid ? (o.mode >> 3) & 7 : o.mode & 7
      if ((bits & 3) !== 3) throw errno(refuse)
    },
    chmod: (path) => {
      if (owners[path]!.uid !== uid) throw errno('EPERM')
      chmods.push(path)
    },
  }
}

test('folders: vihko\'s own, open to it, pass; a missing state folder is created closed', () => {
  const dir = tempDir('vihko-volumes-')
  const notesDir = join(dir, m.aFolder())
  mkdirSync(notesDir)
  const stateDir = join(dir, m.aFolder(), m.aFolder())
  assert.deepEqual(volumeProblems({ notesDir, stateDir }), [])
  assert.equal(statSync(stateDir).mode & 0o777, 0o700)
})

test('folders: a missing notes folder stops the start (an unmounted share would look empty)', () => {
  const dir = tempDir('vihko-volumes-')
  const notesDir = join(dir, m.aFolder())
  const problems = volumeProblems({ notesDir, stateDir: join(dir, m.aFolder()) })
  assert.deepEqual(problems, [`the notes folder ${notesDir} doesn't exist: create it, or check the notes volume in compose.yaml (VIHKO_NOTES_DIR outside Docker)`])
})

test('folders: ones vihko can\'t write say so, one line each, with its user, the owner, the mode and the fix', { skip: asRoot }, (t) => {
  const notesDir = closedFolder(t)
  const stateDir = closedFolder(t)
  const problems = volumeProblems({ notesDir, stateDir })
  assert.deepEqual(problems, [
    `vihko can't write to the notes folder ${notesDir}: it belongs to ${ME} (mode 555) and vihko runs as ${ME}. Fix: chmod u+rwx the notes folder on the host (on NFS, check how the export maps users); see ${OWNERSHIP_GUIDE}`,
    `vihko can't write to the state folder ${stateDir}: it belongs to ${ME} (mode 555) and vihko runs as ${ME}. Fix: chmod u+rwx the state folder on the host; see ${OWNERSHIP_GUIDE}`,
  ])
  assert.throws(() => checkVolumes({ notesDir, stateDir }), (err) => err instanceof StartupError && err.lines.length === 2)
})

test('folders: a state folder that can\'t be created, because its parent is closed, says so', { skip: asRoot }, (t) => {
  const stateDir = join(closedFolder(t), m.aFolder())
  assert.deepEqual(volumeProblems({ stateDir }), [
    `the state folder ${stateDir} doesn't exist and vihko, running as ${ME}, can't create it (EACCES): create it owned by ${ME}; see ${OWNERSHIP_GUIDE}`,
  ])
})

test('folders: a state folder root made (mkdir as root): chown it to vihko\'s user, never run vihko as root', () => {
  const uid = anotherId(0)
  const gid = anotherId(0)
  const stateDir = `/${m.aFolder()}/${m.aFolder()}`
  const sys = playedSystem(uid, gid, { [stateDir]: { uid: 0, gid: 0, mode: 0o755 } })
  assert.deepEqual(volumeProblems({ stateDir }, sys), [
    `vihko can't write to the state folder ${stateDir}: it belongs to 0:0 (mode 755) and vihko runs as ${uid}:${gid}. Fix: chown -R ${uid}:${gid} the state volume's folder on the host (./state next to the example compose.yaml); see ${OWNERSHIP_GUIDE}`,
  ])
})

test('folders: a state folder of another user: chown it, or run vihko as that user if it owns the notes', () => {
  const uid = anotherId(0)
  const gid = anotherId(0)
  const owner = anotherId(uid)
  const group = anotherId(gid)
  const stateDir = `/${m.aFolder()}`
  const sys = playedSystem(uid, gid, { [stateDir]: { uid: owner, gid: group, mode: 0o700 } })
  const [line] = volumeProblems({ stateDir }, sys)
  assert.equal(line, `vihko can't write to the state folder ${stateDir}: it belongs to ${owner}:${group} (mode 700) and vihko runs as ${uid}:${gid}. Fix: chown -R ${uid}:${gid} the state volume's folder on the host (./state next to the example compose.yaml), or, if ${owner}:${group} owns your notes, set VIHKO_UID=${owner} and VIHKO_GID=${group} in .env next to compose.yaml; see ${OWNERSHIP_GUIDE}`)
})

test('folders: notes of another user: run vihko as their owner, and give it the state too', () => {
  const uid = anotherId(0)
  const gid = anotherId(0)
  const owner = anotherId(uid)
  const group = anotherId(gid)
  const notesDir = `/${m.aFolder()}`
  const stateDir = `/${m.aFolder()}`
  const sys = playedSystem(uid, gid, { [notesDir]: { uid: owner, gid: group, mode: 0o755 }, [stateDir]: { uid, gid, mode: 0o700 } })
  assert.deepEqual(volumeProblems({ notesDir, stateDir }, sys), [
    `vihko can't write to the notes folder ${notesDir}: it belongs to ${owner}:${group} (mode 755) and vihko runs as ${uid}:${gid}. Fix: run vihko as the owner of your notes, VIHKO_UID=${owner} and VIHKO_GID=${group} in .env next to compose.yaml, and chown -R ${owner}:${group} the state volume's folder on the host (./state next to the example compose.yaml); see ${OWNERSHIP_GUIDE}`,
  ])
})

test('folders: notes root made: the owner of the notes in .env first (NFS), or chown', () => {
  const uid = anotherId(0)
  const gid = anotherId(0)
  const notesDir = `/${m.aFolder()}`
  const stateDir = `/${m.aFolder()}`
  const sys = playedSystem(uid, gid, { [notesDir]: { uid: 0, gid: 0, mode: 0o755 }, [stateDir]: { uid, gid, mode: 0o700 } })
  assert.deepEqual(volumeProblems({ notesDir, stateDir }, sys), [
    `vihko can't write to the notes folder ${notesDir}: it belongs to 0:0 (mode 755) and vihko runs as ${uid}:${gid}. Fix: set VIHKO_UID and VIHKO_GID in .env next to compose.yaml to the user that owns your notes (on NFS, one the export lets write), or chown -R ${uid}:${gid} the notes volume's folder on the host (./notes next to the example compose.yaml); see ${OWNERSHIP_GUIDE}`,
  ])
})

test('folders: a read-only mount says to remove :ro, whoever owns it', () => {
  const uid = anotherId(0)
  const gid = anotherId(0)
  const notesDir = `/${m.aFolder()}`
  const stateDir = `/${m.aFolder()}`
  const sys = playedSystem(uid, gid, { [notesDir]: { uid, gid, mode: 0o555 }, [stateDir]: { uid, gid, mode: 0o555 } }, 'EROFS')
  assert.deepEqual(volumeProblems({ notesDir, stateDir }, sys), [
    `vihko can't write to the notes folder ${notesDir}: it's mounted read-only. Remove :ro from the notes volume in compose.yaml`,
    `vihko can't write to the state folder ${stateDir}: it's mounted read-only. Remove :ro from the state volume in compose.yaml`,
  ])
})

test('state folder: open, writable, but another user\'s: the warning says whose it is and who vihko is, not only that it is readable', () => {
  const uid = anotherId(0)
  const gid = anotherId(0)
  const stateDir = `/${m.aFolder()}`
  const sys = playedSystem(uid, gid, { [stateDir]: { uid: 0, gid: 0, mode: 0o777 } })
  assert.deepEqual(volumeProblems({ stateDir }, sys), [], 'it can write: it starts')
  const said: string[] = []
  prepareStateDir(stateDir, (msg) => said.push(msg), sys)
  assert.deepEqual(said, [
    `the state folder ${stateDir} belongs to 0:0, not to the user vihko runs as (${uid}:${gid}), so vihko can't close it to other users of this system (mode 777). Fix: chown -R ${uid}:${gid} the state volume's folder on the host (./state next to the example compose.yaml); see ${OWNERSHIP_GUIDE}`,
  ])
  assert.deepEqual(sys.chmods, [])
})

test('state folder: its own, open: closed without a word', () => {
  const uid = anotherId(0)
  const gid = anotherId(0)
  const stateDir = `/${m.aFolder()}`
  const sys = playedSystem(uid, gid, { [stateDir]: { uid, gid, mode: 0o755 } })
  const said: string[] = []
  prepareStateDir(stateDir, (msg) => said.push(msg), sys)
  assert.deepEqual(said, [])
  assert.deepEqual(sys.chmods, [stateDir])
})

test('as root, vihko starts and says it doesn\'t need to be; as anyone else, nothing', () => {
  const gid = m.anInt(0, 60_000)
  assert.equal(rootWarning(playedSystem(0, gid, {})), `vihko runs as root (0:${gid}), which it doesn't need: give the notes and state folders to an ordinary user and set VIHKO_UID and VIHKO_GID in .env to that user; see ${OWNERSHIP_GUIDE}`)
  assert.equal(rootWarning(playedSystem(anotherId(0), gid, {})), null)
})

test('start: a state folder vihko can\'t write stops it before anything is opened in it', { skip: asRoot }, async (t) => {
  const dir = tempDir('vihko-volumes-')
  const notesDir = join(dir, m.aFolder())
  mkdirSync(notesDir)
  const stateDir = closedFolder(t, dir)
  const config = configFromEnv({ VIHKO_NOTES_DIR: notesDir, VIHKO_STATE_DIR: stateDir, VIHKO_HOST: '127.0.0.1', VIHKO_PORT: '0', VIHKO_WEB_DIR: join(dir, m.aFolder()) })
  await assert.rejects(start(config), (err) => err instanceof StartupError && err.lines.length === 1 && err.lines[0]!.startsWith(`vihko can't write to the state folder ${stateDir}:`))
})

/** `vihko serve` until it exits by itself: its output, and its exit code. */
function serveOnce(env: Record<string, string>) {
  const r = spawnSync(process.execPath, ['--no-experimental-webstorage', CLI, 'serve'], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', VIHKO_HOST: '127.0.0.1', VIHKO_PORT: '0', ...env },
    encoding: 'utf8', timeout: 30_000,
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

test('vihko serve: a folder it can\'t write is one line in the log and a non-zero exit, without a stack trace', { skip: asRoot }, (t) => {
  const dir = tempDir('vihko-volumes-')
  const notesDir = join(dir, m.aFolder())
  mkdirSync(notesDir)
  const stateDir = closedFolder(t, dir)
  const r = serveOnce({ VIHKO_NOTES_DIR: notesDir, VIHKO_STATE_DIR: stateDir, VIHKO_WEB_DIR: join(dir, m.aFolder()) })
  assert.equal(r.code, 1)
  assert.match(r.out, /^\[vihko\] vihko \S+\n$/, 'only its version before')
  assert.deepEqual(r.err.split('\n').filter(Boolean), [
    `[vihko] vihko can't write to the state folder ${stateDir}: it belongs to ${ME} (mode 555) and vihko runs as ${ME}. Fix: chmod u+rwx the state folder on the host; see ${OWNERSHIP_GUIDE}`,
  ])
})

test('vihko serve: a port another program holds is one line too', async () => {
  const dir = tempDir('vihko-volumes-')
  const notesDir = join(dir, m.aFolder())
  mkdirSync(notesDir)
  const holder = createServer()
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve))
  const port = (holder.address() as AddressInfo).port
  try {
    const r = await serveUntilExit({ VIHKO_NOTES_DIR: notesDir, VIHKO_STATE_DIR: join(dir, m.aFolder()), VIHKO_WEB_DIR: join(dir, m.aFolder()), VIHKO_PORT: String(port) })
    assert.equal(r.code, 1)
    assert.deepEqual(r.err.split('\n').filter(Boolean), [`[vihko] port ${port} on 127.0.0.1 is in use by another program: stop it, or choose another port with VIHKO_PORT`])
  } finally {
    holder.close()
  }
})

/** Like serveOnce, without blocking this process (it holds the port the server tries). */
function serveUntilExit(env: Record<string, string>): Promise<{ code: number | null; err: string }> {
  const p = spawn(process.execPath, ['--no-experimental-webstorage', CLI, 'serve'], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', VIHKO_HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  p.stderr.on('data', (d: Buffer) => { err += d.toString('utf8') })
  const timer = setTimeout(() => p.kill('SIGKILL'), 30_000)
  return new Promise((resolve) => p.once('exit', (code) => { clearTimeout(timer); resolve({ code, err }) }))
}

test('vihko serve: a variable it can\'t use is one line too, naming it', () => {
  const dir = tempDir('vihko-volumes-')
  const port = m.aWord()
  const r = serveOnce({ VIHKO_NOTES_DIR: dir, VIHKO_STATE_DIR: join(dir, m.aFolder()), VIHKO_PORT: port })
  assert.equal(r.code, 1)
  assert.deepEqual(r.err.split('\n').filter(Boolean), [`[vihko] VIHKO_PORT: expected a port number (0-65535), not "${port}"`])
})
