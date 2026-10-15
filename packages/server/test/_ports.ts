// Ports for the servers the tests start. Below the system's range for
// outgoing connections (32768 and up on Linux, 49152 on others), where a
// client socket of another test could hold a port while its server is down
// for a restart. Each port is claimed in a folder the whole `npm test` run
// shares (VIHKO_TEST_PORTS_DIR, from scripts/test.ts), so test files running
// side by side never get the same one; a port is kept for the run, as a
// server that restarts needs it again.
import { openSync, closeSync } from 'node:fs'
import { join } from 'node:path'

const FIRST = 20000
const COUNT = 6000 // up to 26000, where the acceptance tests' ports begin

/** A port no other test of this run has. */
export function claimPort(): number {
  const dir = process.env.VIHKO_TEST_PORTS_DIR
  for (let tries = 0; tries < 1000; tries++) {
    const port = FIRST + Math.floor(Math.random() * COUNT)
    if (!dir) return port
    try {
      closeSync(openSync(join(dir, String(port)), 'wx'))
      return port
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error(`no free test port left in ${FIRST}-${FIRST + COUNT - 1}`)
}
