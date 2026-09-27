// Each person's profile: timezone and daily-note preferences (D-030).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONFIG, setup } from './_app.ts'

test('profiles: timezone and daily preferences, validated', async () => {
  const { admin, member } = await setup({ config: CONFIG })
  assert.deepEqual((await admin('GET', '/api/profile')).body, { timezone: null, dailySeries: null, openDailyOnStart: false })
  assert.deepEqual((await admin('PUT', '/api/profile', { timezone: 'Europe/Madrid' })).body, { timezone: 'Europe/Madrid', dailySeries: null, openDailyOnStart: false })
  assert.deepEqual((await admin('PUT', '/api/profile', { dailySeries: 'equipo', openDailyOnStart: true, role: 'admin' })).body, { timezone: 'Europe/Madrid', dailySeries: 'equipo', openDailyOnStart: true })
  for (const bad of [{ timezone: 'Mars/Base' }, { timezone: '+02:00' }, { dailySeries: '../x' }, { openDailyOnStart: 'yes' }]) {
    assert.deepEqual([(await admin('PUT', '/api/profile', bad)).status, (await admin('PUT', '/api/profile', bad)).body.error], [400, 'invalid'], JSON.stringify(bad))
  }
  assert.deepEqual((await member('GET', '/api/profile')).body.timezone, null, 'each person has their own')
})
