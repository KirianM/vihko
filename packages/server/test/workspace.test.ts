// vihko.yaml: read at start, reloaded on change, errors as alerts (D-011, D-014).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SESSION_COOKIE } from '@vihko/server'
import { CONFIG, DAILY, setup } from './_app.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const SERIES = [DAILY.own.id, DAILY.team.id]
/** `text` for a regular expression that matches it literally. */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

test('workspace: read at start, reloaded on change; an invalid file keeps the last good one', async () => {
  const { notesDir, workspace, admin } = await setup({ config: CONFIG })
  assert.deepEqual(workspace.config.daily.map((s) => s.id), SERIES)
  assert.deepEqual((await admin('GET', '/api/workspace')).body.templates, DAILY.templates)
  assert.equal(workspace.reload(), false, 'unchanged file: nothing to do')

  const configAlerts = async () => (await admin('GET', '/api/alerts')).body.alerts.filter((a: { code: string }) => a.code === 'config_invalid' || a.code === 'config_warnings')

  // An unknown key is left out with a warning; the rest applies.
  writeFileSync(join(notesDir, 'vihko.yaml'), CONFIG.replace('templates:', 'templtes:'))
  assert.equal(workspace.reload(), true)
  assert.equal(workspace.config.templates, null, 'the misspelt setting is not applied')
  assert.deepEqual(workspace.config.daily.map((s) => s.id), SERIES, 'the rest is')
  assert.deepEqual(await configAlerts(), [{ code: 'config_warnings', file: 'vihko.yaml', actions: [], warnings: [{ code: 'unknown_key', at: 'templtes', line: 2, detail: null }] }])

  // A wrong value in a known key: the last good config stays in force.
  writeFileSync(join(notesDir, 'vihko.yaml'), CONFIG.replace(`folder: ${JSON.stringify(DAILY.team.folder)}`, `folder: ${JSON.stringify(`../${DAILY.team.folder}`)}`))
  assert.equal(workspace.reload(), true)
  assert.equal(workspace.config.templates, null)
  assert.deepEqual(workspace.config.daily.map((s) => s.id), SERIES, 'the last good config stays in force')
  assert.deepEqual(await configAlerts(), [
    { code: 'config_invalid', file: 'vihko.yaml', fallback: 'last_good', actions: [], errors: [{ code: 'invalid_path', at: `daily.${DAILY.team.id}.folder`, line: 9, detail: null }] },
    { code: 'config_warnings', file: 'vihko.yaml', actions: [], warnings: [{ code: 'unknown_key', at: 'templtes', line: 2, detail: null }] },
  ], 'the warnings are those of the configuration in force')

  const other = m.anId()
  writeFileSync(join(notesDir, 'vihko.yaml'), `daily:\n  ${other}:\n    folder: ${JSON.stringify(m.aFolder())}\n`)
  assert.equal(workspace.reload(), true)
  assert.deepEqual(workspace.config.daily.map((s) => s.id), [other])
  assert.deepEqual(await configAlerts(), [], 'fixed: the alerts go away')

  rmSync(join(notesDir, 'vihko.yaml'))
  workspace.reload()
  assert.deepEqual(workspace.config.daily, [], 'deleting the file turns everything off')
})

test('workspace: invalid from the start means nothing configured; never served as a file', async () => {
  const { workspace, admin } = await setup({ config: 'daily: [\n' })
  assert.deepEqual(workspace.config.daily, [])
  const alert = (await admin('GET', '/api/alerts')).body.alerts.find((a: { code: string }) => a.code === 'config_invalid')
  assert.equal(alert.fallback, 'none')
  assert.equal(alert.errors[0].code, 'yaml')
  assert.equal((await admin('GET', '/api/file?path=vihko.yaml')).status, 404)
  assert.equal((await admin('GET', '/api/tree')).body.notes.some((n: { path: string }) => n.path === 'vihko.yaml'), false, 'not a note')
})

test('workspace: an unreadable file is an alert, not a crash', { skip: process.getuid?.() === 0 }, async () => {
  const { notesDir, workspace } = await setup({ config: CONFIG })
  chmodSync(join(notesDir, 'vihko.yaml'), 0o000)
  try {
    workspace.reload()
    assert.equal(workspace.status.errors[0]?.code, 'unreadable')
    assert.equal(workspace.config.daily.length, 2)
  } finally {
    chmodSync(join(notesDir, 'vihko.yaml'), 0o644)
  }
})

test('attachments: vihko.yaml can send new images to a fixed folder', async () => {
  const { app, users } = await setup({ config: CONFIG })
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: users.admin.username, password: users.admin.password }) })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  assert.ok(cookie.startsWith(SESSION_COOKIE))
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  const res = await app.request('/api/attachments?note=hogar/Proxy.md', { method: 'POST', headers: { cookie, 'content-type': 'image/png' }, body: png })
  const body = await res.json() as { path: string; src: string }
  assert.equal(res.status, 201)
  assert.match(body.path, new RegExp(`^${literally(DAILY.attachments)}/Proxy-\\d{4}-\\d{2}-\\d{2}-\\d{4}\\.png$`, 'u'))
  assert.equal(body.src, `../${body.path}`, 'linked relative to the note')
})
