// vihko's version: one source (the root package.json), the same in every
// workspace package and in the lockfile.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { VERSION } from '../src/version.ts'

const ROOT = new URL('../../../', import.meta.url)
const json = (path: string) => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'))

// Semantic Versioning 2.0.0, with its pre-release and build parts.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

test('the version is the root package.json\'s, a semantic version', () => {
  assert.equal(VERSION, json('package.json').version)
  assert.match(VERSION, SEMVER)
})

test('every workspace package and the lockfile carry the root\'s version', () => {
  const lock = json('package-lock.json')
  assert.equal(lock.version, VERSION, 'package-lock.json')
  assert.equal(lock.packages[''].version, VERSION, 'package-lock.json, the root')
  const packages = readdirSync(new URL('packages/', ROOT), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  assert.ok(packages.length > 0)
  for (const p of packages) {
    assert.equal(json(`packages/${p}/package.json`).version, VERSION, `packages/${p}/package.json`)
    assert.equal(lock.packages[`packages/${p}`].version, VERSION, `package-lock.json, packages/${p}`)
  }
})
