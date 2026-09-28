// Who is using the state volume: the server while it runs, and command-line
// tools that must run with it stopped (`vihko history purge`). One at a time.
//
// The lock is an exclusive SQLite transaction on `<state>/vihko.lock`, held
// for as long as the process runs. SQLite's lock is the kernel's (fcntl): it
// goes away with the process however it ends, `kill -9` included, so there is
// no stale file to clean up and no PID to check (PIDs repeat across
// containers: in Docker, the server is always PID 1).
import Database from 'better-sqlite3'
import { join } from 'node:path'

export const LOCK_FILE = 'vihko.lock'

/** The state volume is in use by another process (a running server, or a tool that needs it stopped). */
export class StateInUseError extends Error {
  readonly code = 'state_in_use'
  constructor(file: string) {
    super(`the state folder is in use by another vihko process (${file}): is the server running?`)
  }
}

export interface StateLock {
  release(): void
}

/** Locks in force. Referenced here so a caller dropping its handle never lets the garbage collector close one (and release it). */
const held = new Set<Database.Database>()

/** Takes the state volume for this process. Throws a StateInUseError if another one has it. */
export function lockState(stateDir: string): StateLock {
  const file = join(stateDir, LOCK_FILE)
  const db = new Database(file, { timeout: 0 })
  try {
    db.exec('BEGIN EXCLUSIVE')
  } catch (err) {
    db.close()
    if ((err as { code?: string }).code === 'SQLITE_BUSY') throw new StateInUseError(file)
    throw err
  }
  held.add(db)
  return {
    release() {
      if (!held.delete(db)) return
      try { db.exec('ROLLBACK') } catch { /* closing releases it anyway */ }
      db.close()
    },
  }
}
