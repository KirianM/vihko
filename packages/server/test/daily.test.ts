// Templates and the daily note (D-030).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFrontmatter } from '@vihko/core'
import { CONFIG, DAILY, setup } from './_app.ts'
import { inShared } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** The template of the own series (DAILY.own.template), with a uid and a tag of its own and a comment. */
const TEMPLATE_UID = m.faker.string.ulid()
const TEMPLATE_TAG = m.aTag()
const TEMPLATE = `---
uid: ${TEMPLATE_UID}
tags: [${TEMPLATE_TAG}]
# kept as is
---
# {{title}}

{{date:DD/MM/YYYY}} · {{user}} · {{unknown}}
`
const templateFile = (notesDir: string) => join(notesDir, DAILY.templates, `${DAILY.own.template}.md`)
/** Paths of the own series (a folder per person) and of the shared one. */
const own = (username: string, day: string) => `${DAILY.own.folder}/${username}/${day}.md`
const team = (day: string) => `${DAILY.team.folder}/${day}.md`

/** The civil day of an instant in a timezone, `YYYY-MM-DD`. */
const dayIn = (timeZone: string, at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
/** A timezone (any the mother gives) where `at` falls on `day`. */
function zoneWhere(day: string, at: Date): string {
  for (let i = 0; i < 2000; i++) {
    const zone = m.aTimeZone()
    if (dayIn(zone, at) === day) return zone
  }
  throw new Error(`no timezone where ${at.toISOString()} is ${day}`)
}

test('daily note: off until vihko.yaml declares a series', async () => {
  for (const config of [undefined, `templates: ${JSON.stringify(DAILY.templates)}\n`]) {
    const { admin } = await setup({ config })
    assert.deepEqual([(await admin('POST', '/api/daily')).status, (await admin('GET', '/api/daily')).body.error], [409, 'not_configured'])
  }
})

test('daily note: today in each person\'s timezone, created from the template, then opened', async () => {
  // 23:30 UTC on 24 September (the setup's clock): the 25th somewhere east, still the 24th somewhere west.
  const now = new Date('2026-09-24T23:30:00Z')
  const { notesDir, admin, member, users } = await setup({ config: CONFIG, clock: { now } })
  await admin('PUT', '/api/profile', { timezone: zoneWhere('2026-09-25', now) })
  await member('PUT', '/api/profile', { timezone: zoneWhere('2026-09-24', now) })
  const path = own(users.admin.username, '2026-09-25')

  assert.deepEqual((await admin('GET', '/api/daily')).body, { series: DAILY.own.id, path, exists: false })
  writeFileSync(templateFile(notesDir), TEMPLATE)
  const first = await admin('POST', '/api/daily')
  assert.deepEqual([first.status, first.body], [201, { series: DAILY.own.id, path, created: true }])
  const text = readFileSync(join(notesDir, path), 'utf8')
  const uid = String(readFrontmatter(text).data.uid)
  assert.match(uid, /^[0-9A-Z]{26}$/)
  assert.notEqual(uid, TEMPLATE_UID, 'a copy never shares the template\'s identity')
  assert.equal(text, `---\nuid: ${uid}\ntags: [${TEMPLATE_TAG}]\n# kept as is\n---\n# 2026-09-25\n\n25/09/2026 · ${users.admin.username} · {{unknown}}\n`)

  const again = await admin('POST', '/api/daily')
  assert.deepEqual([again.status, again.body.created, again.body.path], [200, false, path])
  assert.equal(readFileSync(join(notesDir, path), 'utf8'), text, 'never overwritten')

  assert.equal((await member('POST', '/api/daily')).body.path, own(users.member.username, '2026-09-24'), 'another timezone, another day')
  assert.equal((await member('POST', '/api/daily', { series: DAILY.team.id })).body.path, team('2026-09-24'), 'a shared series has no {user}')
  assert.equal(readFileSync(join(notesDir, team('2026-09-24')), 'utf8').startsWith('---\nuid: '), true, 'no template: just the uid')
  assert.equal((await member('POST', '/api/daily', { series: m.anId() })).body.error, 'not_found')
})

test('daily note: the person\'s chosen series; without a timezone, UTC', async () => {
  const { admin, users } = await setup({ config: CONFIG, clock: { now: new Date('2026-09-24T23:30:00Z') } })
  assert.equal((await admin('GET', '/api/daily')).body.path, own(users.admin.username, '2026-09-24'), 'UTC while the browser hasn\'t said')
  await admin('PUT', '/api/profile', { dailySeries: DAILY.team.id })
  assert.equal((await admin('GET', '/api/daily')).body.path, team('2026-09-24'))
  await admin('PUT', '/api/profile', { dailySeries: m.anId() })
  assert.equal((await admin('GET', '/api/daily')).body.series, DAILY.own.id, 'a series vihko.yaml no longer has: the first one')
})

test('daily note: the day changes at the person\'s midnight', async () => {
  // The minute the person's day turns, some time after the 25th begins in UTC.
  const zone = m.aTimeZone()
  let midnight = Date.parse('2026-09-25T00:00:00Z')
  while (dayIn(zone, new Date(midnight - 60_000)) === dayIn(zone, new Date(midnight))) midnight += 60_000
  const clock = { now: new Date(midnight - 60_000) }
  const { admin, users } = await setup({ config: CONFIG, clock })
  await admin('PUT', '/api/profile', { timezone: zone })
  const before = dayIn(zone, clock.now)
  assert.equal((await admin('GET', '/api/daily')).body.path, own(users.admin.username, before), zone)
  clock.now = new Date(midnight)
  const after = dayIn(zone, clock.now)
  assert.notEqual(after, before)
  assert.equal((await admin('GET', '/api/daily')).body.path, own(users.admin.username, after), zone)
})

test('daily note: two at once create one note and both open it', async () => {
  const shared = inShared(m.aFolder())
  const { notesDir, admin } = await setup({ config: CONFIG.replace(JSON.stringify(`${DAILY.own.folder}/{user}`), JSON.stringify(shared)) })
  writeFileSync(templateFile(notesDir), TEMPLATE)
  const results = await Promise.all(Array.from({ length: 6 }, () => admin('POST', '/api/daily')))
  assert.deepEqual(new Set(results.map((r) => r.body.path)), new Set([`${shared}/2026-09-24.md`]))
  assert.equal(results.filter((r) => r.body.created).length, 1, 'only one creates it')
  assert.ok(results.every((r) => r.status === 200 || r.status === 201))
})

test('daily note: a missing template gives an empty note and an alert', async () => {
  const { notesDir, admin } = await setup({ config: CONFIG })
  const alerts = (await admin('GET', '/api/alerts')).body.alerts
  assert.deepEqual(alerts.filter((a: { code: string }) => a.code === 'config_template_missing'), [{ code: 'config_template_missing', series: DAILY.own.id, template: `${DAILY.templates}/${DAILY.own.template}.md`, actions: [] }])
  const r = await admin('POST', '/api/daily')
  assert.equal(r.status, 201)
  assert.match(readFileSync(join(notesDir, r.body.path), 'utf8'), /^---\nuid: \w+\n---\n$/)
})
