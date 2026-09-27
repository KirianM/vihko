// Templates and the daily note (D-030).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFrontmatter } from '@thoth/core'
import { CONFIG, setup } from './_app.ts'

const TEMPLATE = `---
uid: 01TEMPLATEUIDTEMPLATEUID00
tags: [diario]
# kept as is
---
# {{title}}

{{date:DD/MM/YYYY}} · {{user}} · {{unknown}}
`


test('daily note: off until thoth.yaml declares a series', async () => {
  for (const config of [undefined, 'templates: Plantillas\n']) {
    const { admin } = await setup({ config })
    assert.deepEqual([(await admin('POST', '/api/daily')).status, (await admin('GET', '/api/daily')).body.error], [409, 'not_configured'])
  }
})

test('daily note: today in each person\'s timezone, created from the template, then opened', async () => {
  // 23:30 UTC on 24 September: the 25th in Madrid, the 24th in New York.
  const { notesDir, admin, member, users } = await setup({ config: CONFIG })
  await admin('PUT', '/api/profile', { timezone: 'Europe/Madrid' })
  await member('PUT', '/api/profile', { timezone: 'America/New_York' })

  assert.deepEqual((await admin('GET', '/api/daily')).body, { series: 'diario', path: `Diario/${users.admin.username}/2026-09-25.md`, exists: false })
  writeFileSync(join(notesDir, 'Plantillas', 'Diario.md'), TEMPLATE)
  const first = await admin('POST', '/api/daily')
  assert.deepEqual([first.status, first.body], [201, { series: 'diario', path: `Diario/${users.admin.username}/2026-09-25.md`, created: true }])
  const text = readFileSync(join(notesDir, `Diario/${users.admin.username}/2026-09-25.md`), 'utf8')
  const rendered = /^---\nuid: [0-9A-Z]{26}\ntags: \[diario\]\n# kept as is\n---\n# 2026-09-25\n\n25\/09\/2026 · (.+) · \{\{unknown\}\}\n$/.exec(text)
  assert.equal(rendered?.[1], users.admin.username, text)
  assert.notEqual(readFrontmatter(text).data.uid, '01TEMPLATEUIDTEMPLATEUID00', 'a copy never shares the template\'s identity')

  const again = await admin('POST', '/api/daily')
  assert.deepEqual([again.status, again.body.created, again.body.path], [200, false, `Diario/${users.admin.username}/2026-09-25.md`])
  assert.equal(readFileSync(join(notesDir, `Diario/${users.admin.username}/2026-09-25.md`), 'utf8'), text, 'never overwritten')

  assert.equal((await member('POST', '/api/daily')).body.path, `Diario/${users.member.username}/2026-09-24.md`, 'another timezone, another day')
  assert.equal((await member('POST', '/api/daily', { series: 'equipo' })).body.path, 'Equipo/2026-09-24.md', 'a shared series has no {user}')
  assert.equal(readFileSync(join(notesDir, 'Equipo/2026-09-24.md'), 'utf8').startsWith('---\nuid: '), true, 'no template: just the uid')
  assert.equal((await member('POST', '/api/daily', { series: 'nope' })).body.error, 'not_found')
})

test('daily note: the person\'s chosen series; without a timezone, UTC', async () => {
  const { admin, users } = await setup({ config: CONFIG, clock: { now: new Date('2026-09-24T23:30:00Z') } })
  assert.equal((await admin('GET', '/api/daily')).body.path, `Diario/${users.admin.username}/2026-09-24.md`, 'UTC while the browser hasn\'t said')
  await admin('PUT', '/api/profile', { dailySeries: 'equipo' })
  assert.equal((await admin('GET', '/api/daily')).body.path, 'Equipo/2026-09-24.md')
  await admin('PUT', '/api/profile', { dailySeries: 'gone' })
  assert.equal((await admin('GET', '/api/daily')).body.series, 'diario', 'a series thoth.yaml no longer has: the first one')
})

test('daily note: the day changes at the person\'s midnight', async () => {
  const clock = { now: new Date('2026-09-25T21:59:00Z') }
  const { admin, users } = await setup({ config: CONFIG, clock })
  await admin('PUT', '/api/profile', { timezone: 'Europe/Madrid' })
  assert.equal((await admin('GET', '/api/daily')).body.path, `Diario/${users.admin.username}/2026-09-25.md`)
  clock.now = new Date('2026-09-25T22:00:00Z')
  assert.equal((await admin('GET', '/api/daily')).body.path, `Diario/${users.admin.username}/2026-09-26.md`)
})

test('daily note: two at once create one note and both open it', async () => {
  const { notesDir, admin } = await setup({ config: CONFIG.replace('Diario/{user}', 'Compartido') })
  writeFileSync(join(notesDir, 'Plantillas', 'Diario.md'), TEMPLATE)
  const results = await Promise.all(Array.from({ length: 6 }, () => admin('POST', '/api/daily')))
  assert.deepEqual(new Set(results.map((r) => r.body.path)), new Set(['Compartido/2026-09-24.md']))
  assert.equal(results.filter((r) => r.body.created).length, 1, 'only one creates it')
  assert.ok(results.every((r) => r.status === 200 || r.status === 201))
})

test('daily note: a missing template gives an empty note and an alert', async () => {
  const { notesDir, admin } = await setup({ config: CONFIG })
  const alerts = (await admin('GET', '/api/alerts')).body.alerts
  assert.deepEqual(alerts.filter((a: { code: string }) => a.code === 'config_template_missing'), [{ code: 'config_template_missing', series: 'diario', template: 'Plantillas/Diario.md', actions: [] }])
  const r = await admin('POST', '/api/daily')
  assert.equal(r.status, 201)
  assert.match(readFileSync(join(notesDir, r.body.path), 'utf8'), /^---\nuid: \w+\n---\n$/)
})

