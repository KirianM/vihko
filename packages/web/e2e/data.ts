// Where the test servers keep their data, and the seed of the test data
// (test/seed.ts) when the servers run elsewhere. env.ts imports this first,
// before anything draws a value: with E2E_BASE_URL and no VIHKO_TEST_SEED,
// the seed is the one serve.ts wrote beside its data, so the specs draw the
// same people the server was started with.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SEED_VARIABLE } from '../../../test/seed.ts'

/** Inside .data/ (git-ignored): this way the Playwright Docker image sees it by mounting the repo. */
export const E2E_DIR = process.env.E2E_DIR ?? fileURLToPath(new URL('../../../.data/e2e', import.meta.url))
/** The file serve.ts writes its seed to. */
export const SEED_FILE = E2E_DIR + '/seed'

if (process.env.E2E_BASE_URL && !process.env[SEED_VARIABLE]) {
  try { process.env[SEED_VARIABLE] = readFileSync(SEED_FILE, 'utf8').trim() } catch { /* not written: a seed of our own */ }
}
