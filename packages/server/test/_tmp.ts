// Temporary folders for the tests: every one is removed when the test file's
// process ends, whether its tests passed, failed or threw, so a run leaves
// nothing behind in the system's temporary folder (they once used up the
// inodes of /tmp). Removed at exit rather than in an `after` hook: by then
// no watcher, database or history queue of a test can still be writing in
// them. `npm test` (scripts/test.ts) checks that nothing is left.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const made: string[] = []

/** A new folder in the system's temporary folder, named `<prefix>XXXXXX`, removed at exit. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  if (made.length === 0) process.once('exit', removeTempDirs)
  made.push(dir)
  return dir
}

/** Removes every folder made so far (at exit on its own; a test may call it earlier). */
export function removeTempDirs() {
  for (const dir of made.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch { /* the check in npm test reports it */ }
  }
}
