// The repository is public: what it says is said in plain words, never by
// the number of a decision or a proposal kept elsewhere («D-0NN», «P-0NN»),
// which nobody outside can read. A guard over every text file of the
// checkout (code, tests, guides, the changelog, the workflows), so that one
// isn't brought back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** What isn't the project's own text: dependencies, builds, local data, git itself. */
const SKIP = new Set(['node_modules', '.git', 'dist', '.data', 'test-results', 'playwright-report'])
const TEXT = /\.(?:ts|tsx|mts|mjs|js|json|md|ya?ml|css|html|txt|sh)$|^(?:Dockerfile|\.[a-z]+ignore|\.npmrc|\.nvmrc)$/
/** «D-», «P-», then a number with a leading 0 (written in parts, so that this file isn't one). */
const REFERENCE = new RegExp(`\\b[${'D'}${'P'}]-0\\d{2}\\b`)

function* files(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* files(p)
    else if (e.isFile() && TEXT.test(e.name)) yield p
  }
}

test('no file of the repository cites an internal decision or proposal by its number', () => {
  const found: string[] = []
  for (const file of files(ROOT)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => { if (REFERENCE.test(line)) found.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`) })
  }
  assert.deepEqual(found, [], 'say the reason in plain words instead')
})
