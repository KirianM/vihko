import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { markdownParser } from '@vihko/core/syntax'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/** Walks the relative imports from a file and returns every specifier. */
function imports(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return []
  seen.add(file)
  const text = readFileSync(file, 'utf8')
  const specs = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!)
  return specs.flatMap((s) => (s.startsWith('.') ? [s, ...imports(join(dirname(file), s), seen)] : [s]))
}

test('@vihko/core/syntax is browser-safe: no Node modules', () => {
  const specs = imports(join(SRC, 'syntax.ts'))
  assert.deepEqual(specs.filter((s) => s.startsWith('node:')), [])
})

test('@vihko/core/syntax recognizes wikilinks and tags', () => {
  const names = new Set<string>()
  markdownParser.parse(`[[${m.aTitle()}]] y #${m.aTag()}`).iterate({ enter: (n) => { names.add(n.name) } })
  assert.ok(names.has('WikiLink') && names.has('Tag'))
})
