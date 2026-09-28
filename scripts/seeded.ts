// Runs a command with the run's seed for the test data (test/seed.ts): the
// given VIHKO_TEST_SEED or a new one, printed before it starts and again if
// it fails. `npm run acceptance` and `npm run load` go through it, so every
// test process of the run draws the same data.
//
//   node scripts/seeded.ts <command> [args…]
import { spawnSync } from 'node:child_process'
import { seedLine, testSeed } from '../test/seed.ts'

const [cmd, ...args] = process.argv.slice(2)
if (!cmd) {
  console.error('usage: node scripts/seeded.ts <command> [args…]')
  process.exit(2)
}
const again = `npm run ${process.env.npm_lifecycle_event ?? '…'}`
const seed = testSeed()
console.log(seedLine(seed, again))
// Ctrl-C reaches the command too: this process waits for it.
process.on('SIGINT', () => {})
process.on('SIGTERM', () => {})
const run = spawnSync(cmd === 'node' ? process.execPath : cmd, args, { stdio: 'inherit' })
const code = run.status ?? 1
if (code !== 0) console.error(`\n${seedLine(seed, again)}`)
process.exit(code)
