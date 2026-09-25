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
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { link, open, rename, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { contentHash } from '@thoth/core'

let counter = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
const tmpName = (file: string) => join(dirname(file), `.${basename(file)}.thoth-${process.pid}-${counter++}-${randomBytes(4).toString('hex')}`)

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
