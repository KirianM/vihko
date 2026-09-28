// The seed of a test run. Every test process of one run draws its data from
// the same seed (THOTH_TEST_SEED), so a failure can be reproduced by running
// again with it: `THOTH_TEST_SEED=<n> npm test`. The entry points (npm test,
// the acceptance suite, Playwright and its servers, scripts/ci.ts) choose it
// once, print it and hand it down in the environment; a test file run on its
// own chooses one for itself. No imports but Node's: the Playwright
// configurations and the scripts load it.
import { randomInt } from 'node:crypto'

export const SEED_VARIABLE = 'THOTH_TEST_SEED'

/** A seed from the variable's text; throws on anything but a non-negative integer. */
export function parseSeed(text: string): number {
  if (!/^\d{1,15}$/.test(text.trim())) throw new Error(`${SEED_VARIABLE} must be a non-negative integer, not ${JSON.stringify(text)}`)
  return Number(text.trim())
}

/**
 * This run's seed: THOTH_TEST_SEED, or a new one, which is then put in this
 * process's environment so that everything it starts gets the same one.
 */
export function testSeed(): number {
  const given = process.env[SEED_VARIABLE]
  if (given !== undefined && given !== '') return parseSeed(given)
  const seed = randomInt(1, 2 ** 31)
  process.env[SEED_VARIABLE] = String(seed)
  return seed
}

/** The line an entry point prints, with the command that repeats the run's data. */
export function seedLine(seed: number, command: string): string {
  return `test data seed: ${seed} (to reproduce: ${SEED_VARIABLE}=${seed} ${command})`
}
