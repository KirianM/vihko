// vihko's version: one source (the root package.json), the same in every
// workspace package and in the lockfile; what the CLI prints.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../src/version.ts'

const ROOT = new URL('../../../', import.meta.url)
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
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

test('the CLI prints it alone, for scripts: vihko --version, vihko version', () => {
  for (const arg of ['--version', 'version']) {
    const r = spawnSync(process.execPath, ['--no-experimental-webstorage', CLI, arg], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, `${VERSION}\n`, arg)
  }
})
