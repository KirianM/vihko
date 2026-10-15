// `/api/file` decides the permission from the path alone, before it touches
// the disk: a path one can't read answers as one that doesn't exist, without
// a single filesystem call for it, so neither the answer nor the time it takes
// tells whether something is there.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { posix } from 'node:path'
import { PATH, setup, FILES } from './_m4.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** The fs calls that take a path, wrapped to record each path they are given while `fn` runs. */
async function fsCalls<T>(fn: () => Promise<T>): Promise<{ result: T; paths: string[] }> {
  const names = ['lstatSync', 'statSync', 'readFileSync', 'readdirSync', 'existsSync', 'accessSync', 'openSync', 'realpathSync'] as const
  const fsx = fs as unknown as Record<string, ((...a: unknown[]) => unknown) & { native?: (...a: unknown[]) => unknown }>
  const saved = names.map((n) => [n, fsx[n]!] as const)
  const paths: string[] = []
  const spy = (orig: (...a: unknown[]) => unknown) => function (this: unknown, ...a: unknown[]) {
    paths.push(String(a[0]))
    return orig.apply(this, a)
  }
  for (const [n, orig] of saved) {
    const s = spy(orig) as (typeof fsx)[string]
    if (orig.native) s.native = spy(orig.native)
    fsx[n] = s
  }
  syncBuiltinESMExports()
  try {
    return { result: await fn(), paths }
  } finally {
    for (const [n, orig] of saved) fsx[n] = orig
    syncBuiltinESMExports()
  }
}

test('a file one can\'t read answers as a missing one, without touching the disk for it', async () => {
  const h = await setup({ files: FILES })
  try {
    // The admin can't read the member's personal space: one file there exists, the other doesn't.
    const existing = PATH.memberPhoto
    const missing = posix.join(posix.dirname(existing), `${m.aUniqueWord()}.png`)
    const folder = posix.dirname(existing)
    const asked = async (path: string) => {
      const { result: r, paths } = await fsCalls(() => h.admin('GET', h.url('/api/file', { path })))
      const touched = paths.filter((p) => p.includes(folder))
      return { status: r.status, text: r.text.replaceAll(JSON.stringify(path).slice(1, -1), '<path>'), touched }
    }
    const a = await asked(existing)
    const b = await asked(missing)
    assert.equal(a.status, 404)
    assert.deepEqual(JSON.parse(a.text).error, 'not_found')
    assert.deepEqual([a.status, a.text], [b.status, b.text], 'denied and missing answer alike')
    assert.deepEqual(a.touched, [], 'no filesystem call for a path the caller can\'t read')
    assert.deepEqual(b.touched, [], 'no filesystem call for a path the caller can\'t read')

    // Whoever may read it is served it (so the spy did watch the disk).
    const { result: own, paths } = await fsCalls(() => h.member('GET', h.url('/api/file', { path: existing })))
    assert.equal(own.status, 200)
    assert.ok(paths.some((p) => p.includes(folder)), 'a readable file is read from the disk')
  } finally { await h.close() }
})
