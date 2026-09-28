// `npm test`: every package's tests (or the files given), with a temporary
// folder of their own as TMPDIR, which has to be empty when they finish. A
// test that leaves something behind fails the run, even if every test passed,
// and the folder is removed either way. Its own folder per run, so runs side
// by side (or other programs writing to /tmp) can't confuse the check.
// Every test process gets the run's seed for its data (test/seed.ts),
// printed first, so a failure can be run again with the same data.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedLine, testSeed } from '../test/seed.ts'

const files = process.argv.slice(2)
const seed = testSeed()
console.log(seedLine(seed, `npm test${files.length ? ` -- ${files.join(' ')}` : ''}`))
const root = mkdtempSync(join(tmpdir(), 'vihko-test-run-'))
// Ctrl-C reaches the tests too: this process waits for them and cleans up.
process.on('SIGINT', () => {})
process.on('SIGTERM', () => {})

let code = 1
try {
  const run = spawnSync(process.execPath, ['--test', '--test-force-exit', ...(files.length ? files : ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'])], {
    stdio: 'inherit',
    env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
  })
  code = run.status ?? 1
  if (code !== 0) console.error(`\n${seedLine(seed, `npm test${files.length ? ` -- ${files.join(' ')}` : ''}`)}`)
  const left = readdirSync(root)
  if (left.length > 0) {
    console.error(`\nThe tests left ${left.length} entries in their temporary folder (make them with tempDir() from test/_tmp.ts, which removes them):`)
    for (const name of left.sort()) console.error(`  ${name}`)
    code ||= 1
  }
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
}
process.exit(code)
