// Where the acceptance server keeps its data, and the seed of the test data
// (test/seed.ts) when it runs elsewhere: env.ts imports this first, so with
// ACC_BASE_URL and no VIHKO_TEST_SEED the specs draw from the seed serve.ts
// wrote beside its data (the people it was started with).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SEED_VARIABLE } from '../../../test/seed.ts'

/** Inside .data/ (git-ignored): the Playwright Docker image sees it by mounting the repo. */
export const ACC_DIR = process.env.ACC_DIR ?? fileURLToPath(new URL('../../../.data/acceptance', import.meta.url))
/** The file serve.ts writes its seed to. */
export const SEED_FILE = ACC_DIR + '/seed'

if (process.env.ACC_BASE_URL && !process.env[SEED_VARIABLE]) {
  try { process.env[SEED_VARIABLE] = readFileSync(SEED_FILE, 'utf8').trim() } catch { /* not written: a seed of our own */ }
}
