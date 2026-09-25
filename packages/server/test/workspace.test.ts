// thoth.yaml: read at start, reloaded on change, errors as alerts (D-011, D-014).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SESSION_COOKIE } from '@thoth/server'
import { CONFIG, setup } from './_app.ts'

test('workspace: read at start, reloaded on change; an invalid file keeps the last good one', async () => {
  const { notesDir, workspace, noa } = await setup({ config: CONFIG })
  assert.deepEqual(workspace.config.daily.map((s) => s.id), ['diario', 'equipo'])
  assert.deepEqual((await noa('GET', '/api/workspace')).body.templates, 'Plantillas')
  assert.equal(workspace.reload(), false, 'unchanged file: nothing to do')

  writeFileSync(join(notesDir, 'thoth.yaml'), CONFIG.replace('templates:', 'templtes:'))
  assert.equal(workspace.reload(), true)
  assert.deepEqual(workspace.config.daily.map((s) => s.id), ['diario', 'equipo'], 'the last good config stays in force')
  const alerts = (await noa('GET', '/api/alerts')).body.alerts.filter((a: { code: string }) => a.code === 'config_invalid')
  assert.deepEqual(alerts, [{ code: 'config_invalid', file: 'thoth.yaml', fallback: 'last_good', actions: [], errors: [{ code: 'unknown_key', at: 'templtes', line: 2, detail: null }] }])

  writeFileSync(join(notesDir, 'thoth.yaml'), 'daily:\n  otra:\n    folder: Otra\n')
  assert.equal(workspace.reload(), true)
  assert.deepEqual(workspace.config.daily.map((s) => s.id), ['otra'])
  assert.equal((await noa('GET', '/api/alerts')).body.alerts.some((a: { code: string }) => a.code === 'config_invalid'), false, 'fixed: the alert goes away')

  rmSync(join(notesDir, 'thoth.yaml'))
  workspace.reload()
  assert.deepEqual(workspace.config.daily, [], 'deleting the file turns everything off')
})

test('workspace: invalid from the start means nothing configured; never served as a file', async () => {
  const { workspace, noa } = await setup({ config: 'daily: [\n' })
  assert.deepEqual(workspace.config.daily, [])
  const alert = (await noa('GET', '/api/alerts')).body.alerts.find((a: { code: string }) => a.code === 'config_invalid')
  assert.equal(alert.fallback, 'none')
  assert.equal(alert.errors[0].code, 'yaml')
  assert.equal((await noa('GET', '/api/file?path=thoth.yaml')).status, 404)
  assert.equal((await noa('GET', '/api/tree')).body.notes.some((n: { path: string }) => n.path === 'thoth.yaml'), false, 'not a note')
})

test('workspace: an unreadable file is an alert, not a crash', { skip: process.getuid?.() === 0 }, async () => {
  const { notesDir, workspace } = await setup({ config: CONFIG })
  chmodSync(join(notesDir, 'thoth.yaml'), 0o000)
  try {
    workspace.reload()
    assert.equal(workspace.status.errors[0]?.code, 'unreadable')
    assert.equal(workspace.config.daily.length, 2)
  } finally {
    chmodSync(join(notesDir, 'thoth.yaml'), 0o644)
  }
})

test('attachments: thoth.yaml can send new images to a fixed folder', async () => {
  const { app } = await setup({ config: CONFIG })
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'noa', password: 'a-long-password' }) })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  assert.ok(cookie.startsWith(SESSION_COOKIE))
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  const res = await app.request('/api/attachments?note=hogar/Proxy.md', { method: 'POST', headers: { cookie, 'content-type': 'image/png' }, body: png })
  const body = await res.json() as { path: string; src: string }
  assert.equal(res.status, 201)
  assert.match(body.path, /^Adjuntos\/Proxy-\d{4}-\d{2}-\d{2}-\d{4}\.png$/)
  assert.equal(body.src, `../${body.path}`, 'linked relative to the note')
})
