// Each person's profile: timezone and daily-note preferences (D-030).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONFIG, DAILY, setup } from './_app.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

test('profiles: timezone and daily preferences, validated', async () => {
  const { admin, member } = await setup({ config: CONFIG })
  const zone = m.aTimeZone()
  assert.deepEqual((await admin('GET', '/api/profile')).body, { timezone: null, dailySeries: null, openDailyOnStart: false })
  assert.deepEqual((await admin('PUT', '/api/profile', { timezone: zone })).body, { timezone: zone, dailySeries: null, openDailyOnStart: false })
  assert.deepEqual((await admin('PUT', '/api/profile', { dailySeries: DAILY.team.id, openDailyOnStart: true, role: 'admin' })).body, { timezone: zone, dailySeries: DAILY.team.id, openDailyOnStart: true })
  // Not a timezone, an offset instead of one, a path for a series id, a string for a boolean.
  for (const bad of [{ timezone: 'Mars/Base' }, { timezone: '+02:00' }, { dailySeries: '../x' }, { openDailyOnStart: 'yes' }]) {
    assert.deepEqual([(await admin('PUT', '/api/profile', bad)).status, (await admin('PUT', '/api/profile', bad)).body.error], [400, 'invalid'], JSON.stringify(bad))
  }
  assert.deepEqual((await member('GET', '/api/profile')).body.timezone, null, 'each person has their own')
})
