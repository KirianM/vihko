// Safe write protocol for the notes folder: a synced temp file written outside
// the race window, a hash re-check right before the rename, a hard link to
// rescue in-place writes that land in the window, and stable reads against
// editors that truncate and rewrite.
//
// The calls that change the folder are asynchronous: on a network filesystem
// every create, link, rename, unlink and fsync is a round trip to the server
// (5–10 ms each over NFS), and sync calls would line them all up on the event
// loop. Async, the rewrites of a big rename overlap theirs; a per-file lock
// keeps each hash check and its rename together, as the sync version did by
// construction. Reads stay sync: they are served from the client's cache in
// well under a millisecond, and going through the thread pool made a big
// rename on local disk slower (2.1 → 2.7 s) for nothing on NFS.
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs'
import { link, open, rename, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { contentHash } from '@vihko/core'

let counter = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A folder's entries as last listed (NFC), with what tells whether it changed since. */
const listed = new Map<string, { key: string; names: Set<string> }>()

/** The names in a folder (NFC), from the cache while the folder is unchanged; null if it isn't a folder. */
function namesIn(dir: string, fresh = false): Set<string> | null {
  let st: ReturnType<typeof statSync>
  try { st = statSync(dir) } catch { return null }
  if (!st.isDirectory()) return null
  const key = `${st.ino}:${st.mtimeMs}:${st.ctimeMs}`
  const known = listed.get(dir)
  if (!fresh && known?.key === key) return known.names
  let names: Set<string>
  try { names = new Set(readdirSync(dir).map((n) => n.normalize('NFC'))) } catch { return null }
  if (listed.size > 2000) listed.clear()
  listed.set(dir, { key, names })
  return names
}

/** Whether each notes root ignores case, once told; while it can't be told, when it was last looked at. */
const rootCase = new Map<string, boolean | number>()
/** How long an undecided root waits before its names are looked at again. */
const UNDECIDED_MS = 10_000

const otherCase = (name: string) => name.replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))

/**
 * Whether the filesystem of `root` ignores case: true or false once told,
 * null while it can't be. Told once, from a name at the root with ASCII
 * letters: whether it also opens with each letter's case swapped. Read only.
 * An undecided root (none of its names has such letters) is looked at again
 * every few seconds. Per-folder case-insensitivity under a case-sensitive
 * root (ext4's `chattr +F` on a subfolder) isn't seen: unsupported.
 */
export function rootIgnoresCase(root: string): boolean | null {
  const known = rootCase.get(root)
  if (typeof known === 'boolean') return known
  if (known !== undefined && Date.now() - known < UNDECIDED_MS) return null
  let names: string[]
  try { names = readdirSync(root) } catch { return null }
  const all = new Set(names)
  for (const name of names) {
    const other = otherCase(name)
    if (other === name || all.has(other)) continue
    let opens = true
    try { lstatSync(join(root, other)) } catch { opens = false }
    rootCase.set(root, opens)
    return opens
  }
  rootCase.set(root, Date.now())
  return null
}

/**
 * Whether `rel` (a `/`-separated path under `root`) is spelled as the disk
 * spells what exists of it: each part that exists is listed in its folder
 * under that very name (compared in NFC: disks may hold NFD). A part that
 * doesn't exist yet (a new note's) passes. On a case-insensitive filesystem
 * (macOS or Windows folders shared into a container, SMB, some NFS
 * datasets) `People/noa/diary.md` also opens `people/noa/diary.md`, while
 * the permissions, which go by the path as written, would judge another
 * folder: such a path doesn't exist for vihko.
 *
 * On a root known to be case-sensitive (rootIgnoresCase) every spelling is
 * its own path, and nothing is looked at: no cost, on NFS either. Only a
 * case-insensitive root, or one not told yet, has its folders listed.
 */
export function spelledAsOnDisk(root: string, rel: string): boolean {
  if (rootIgnoresCase(root) === false) return true
  let dir = root
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue
    const names = namesIn(dir)
    // Nothing further exists: the rest will be made with this spelling.
    if (names === null) return true
    const name = part.normalize('NFC')
    if (!names.has(name)) {
      try { lstatSync(join(dir, part)) } catch { return true }
      // It exists: listed under another spelling, unless it was made since the folder was listed.
      if (!namesIn(dir, true)?.has(name)) return false
    }
    dir = join(dir, part)
  }
  return true
}

/**
 * `rel` as the disk spells what exists of it, when some part of it exists
 * under another spelling (a case-insensitive filesystem: `Recetas` where
 * `recetas` is): the path up to and including the first such part, spelled
 * as the disk has it. Null when every part that exists is spelled as given
 * (spelledAsOnDisk). For an honest `exists` where the person sees the whole
 * folder.
 */
export function diskSpelling(root: string, rel: string): string | null {
  if (spelledAsOnDisk(root, rel)) return null
  let dir = root
  const out: string[] = []
  for (const part of rel.split('/')) {
    const names = namesIn(dir, true)
    if (names === null) return null
    const name = part.normalize('NFC')
    if (!names.has(name)) {
      const fold = name.toLowerCase()
      const other = [...names].find((n) => n.toLowerCase() === fold)
      return other === undefined ? null : [...out, other].join('/')
    }
    out.push(name)
    dir = join(dir, part)
  }
  return null
}

/** The notes root as the filesystem names it, once found (a root that is itself a link, or a mount, is fine). */
const realRoots = new Map<string, string>()

/**
 * Whether `rel` (a path under `root`, with `/`) names its file without going
 * through a symbolic link: no segment of it, the last one included, is one.
 * The part that doesn't exist yet (a note about to be created) has none.
 *
 * vihko never follows a link in the notes folder. Its walks skip them, so
 * they are in no tree or index; and followed, a link would read or write
 * outside the folder (the state volume, any file of the server), or in a
 * folder whose permissions aren't those of the path that names it.
 */
export function linkFree(root: string, rel: string): boolean {
  let base = realRoots.get(root)
  if (base === undefined) {
    try { base = realpathSync.native(root) } catch { return false }
    realRoots.set(root, base)
  }
  for (let p = rel; ;) {
    const abs = p ? join(root, p) : root
    try {
      return realpathSync.native(abs) === (p ? join(base, p) : base)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || !p) return false
      // Something is there that leads nowhere: a link to a missing target.
      try { lstatSync(abs); return false } catch { /* not there: its parent decides */ }
      const slash = p.lastIndexOf('/')
      p = slash === -1 ? '' : p.slice(0, slash)
    }
  }
}

/**
 * Whether vihko follows `rel` under `root`: the one check at every door that
 * takes a path. Never through a symbolic link (linkFree), and on a
 * case-insensitive root only as the disk spells each name (spelledAsOnDisk).
 * A path it doesn't follow isn't there for vihko.
 */
export function followable(root: string, rel: string): boolean {
  return linkFree(root, rel) && spelledAsOnDisk(root, rel)
}

/** Whether `rel` is a regular file that vihko follows (see followable). */
export function isPlainFile(root: string, rel: string): boolean {
  try {
    return lstatSync(join(root, rel)).isFile() && followable(root, rel)
  } catch {
    return false
  }
}

/** File contents, or null if it doesn't exist. */
export function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Reads a file that another process may be writing to: only accepted once two
 * consecutive reads match. If it looks like a mass truncation relative to
 * `reference`, more stability is required.
 */
export async function readStable(file: string, reference?: string | null, gap = 60): Promise<string | null> {
  let a = readText(file)
  for (let i = 0; i < 20; i++) {
    const suspicious = reference != null && a !== null && a.length < reference.length / 2
    await sleep(suspicious ? gap * 5 : gap)
    const b = readText(file)
    if (a === b) return a
    a = b
  }
  return a
}

function fsyncDir(dir: string) {
  const fd = openSync(dir, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

async function fsyncDirAsync(dir: string) {
  const fh = await open(dir, 'r')
  try { await fh.sync() } finally { await fh.close() }
}

// pid + counter alone repeat after a crash in a container (always pid 1, counter
// back at 0) and meet the leftovers of the killed process: the random part avoids it.
const tmpName = (file: string) => join(dirname(file), `.${basename(file)}.vihko-${process.pid}-${counter++}-${randomBytes(4).toString('hex')}`)

/** writeTmp without blocking the event loop. */
async function writeTmpAsync(file: string, data: string): Promise<string> {
  const tmp = tmpName(file)
  const fh = await open(tmp, 'wx')
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  return tmp
}

/**
 * Runs `fn` with `file` to itself within this process: two writes to the same
 * file never interleave their hash check and their rename.
 */
const locks = new Map<string, Promise<unknown>>()
async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(file) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => {})
  locks.set(file, tail)
  try {
    return await run
  } finally {
    if (locks.get(file) === tail) locks.delete(file)
  }
}

/** Writes and syncs a hidden temp file in the same directory (the indexer ignores it). */
export function writeTmp(file: string, data: string | Uint8Array): string {
  const tmp = tmpName(file)
  const fd = openSync(tmp, 'wx')
  try {
    if (typeof data === 'string') writeSync(fd, data)
    else for (let at = 0; at < data.byteLength;) at += writeSync(fd, data, at)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return tmp
}

/**
 * Creates `file` with `data` only if nothing is there: written to a synced temp
 * file first and then hard-linked into place, so it is never seen half written
 * and never replaces an existing file. false if the name is taken.
 */
export function createFile(file: string, data: Uint8Array): boolean {
  const tmp = writeTmp(file, data)
  try {
    try {
      linkSync(tmp, file)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw err
    }
    fsyncDir(dirname(file))
    return true
  } finally {
    rmSync(tmp, { force: true })
  }
}

/**
 * Gives an existing file a second name, `to`, only if nothing is there: a hard
 * link, so it appears whole and the original stays untouched until the caller
 * removes it. false if the name is taken.
 */
export function linkNew(from: string, to: string): boolean {
  try {
    linkSync(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
  fsyncDir(dirname(to))
  return true
}

export type CommitResult =
  | { ok: true }
  /** The file didn't have the expected hash: nothing was written. */
  | { ok: false; current: string | null }

export type ReplaceResult =
  /** The file didn't have the expected hash: nothing was written. `current` is what's there. */
  | { replaced: false; current: string | null }
  /**
   * Written. `rescued` is what an editor wrote in place during the rename
   * window and our rename overwrote (null if nothing): the caller decides what to do.
   */
  | { replaced: true; rescued: string | null }

/**
 * Replaces `file` with `text` if its current content has `expectedHash`, or
 * creates it if `expectedHash` is null and it doesn't exist. Before the rename,
 * a hard link to the previous file is made to rescue in-place writes that land
 * in the window.
 */
export async function replaceText(file: string, text: string, expectedHash: string | null): Promise<ReplaceResult> {
  const tmp = await writeTmpAsync(file, text)
  let placed = false
  try {
    if (expectedHash === null) {
      try {
        await link(tmp, file) // link() fails if the target already exists: create without overwriting
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { replaced: false, current: readText(file) }
        throw err
      }
      await fsyncDirAsync(dirname(file))
      return { replaced: true, rescued: null }
    }
    const prev = tmp + '.prev'
    const swapped = await withFileLock(file, async () => {
      const before = readText(file)
      if (before === null || contentHash(before) !== expectedHash) return { current: before }
      await link(file, prev)
      try {
        await rename(tmp, file)
      } catch (err) {
        await rm(prev, { force: true })
        throw err
      }
      placed = true
      await fsyncDirAsync(dirname(file))
      return null
    })
    if (swapped !== null) return { replaced: false, current: swapped.current }
    const old = await readStable(prev) // the editor may keep writing to the old inode
    await rm(prev, { force: true })
    return { replaced: true, rescued: old !== null && contentHash(old) !== expectedHash ? old : null }
  } finally {
    // After the rename the temp name is gone: removing it would be one more round trip for nothing.
    if (!placed) await rm(tmp, { force: true })
  }
}

/**
 * Like replaceText, but if an editor wrote during the window, its version is
 * restored and reported as a conflict: for one-off writes (API) that can't merge.
 */
export async function commitText(file: string, text: string, expectedHash: string | null): Promise<CommitResult> {
  const r = await replaceText(file, text, expectedHash)
  if (!r.replaced) return { ok: false, current: r.current }
  if (r.rescued !== null) {
    const restore = await writeTmpAsync(file, r.rescued)
    await rename(restore, file)
    await fsyncDirAsync(dirname(file))
    return { ok: false, current: r.rescued }
  }
  return { ok: true }
}
