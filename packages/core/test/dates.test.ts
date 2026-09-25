import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addDays, canonicalTimeZone, civilNow, formatDate, isValidDate, isoWeek, isoWeekStart } from '@thoth/core'

test('timezones: IANA names only', () => {
  assert.equal(canonicalTimeZone('Europe/Madrid'), 'Europe/Madrid')
  assert.equal(canonicalTimeZone('UTC'), 'UTC')
  assert.equal(canonicalTimeZone('America/Argentina/Buenos_Aires'), 'America/Argentina/Buenos_Aires')
  for (const bad of ['', 'Mars/Olympus', '+02:00', 'Europe/../etc', 42, null, undefined]) assert.equal(canonicalTimeZone(bad), null, String(bad))
})

test('today depends on the person\'s timezone, never on the server\'s', () => {
  const saved = process.env.TZ
  try {
    // 23:30 UTC on 24 September: already the 25th in Madrid, still the 24th in New York.
    const instant = new Date('2026-09-24T23:30:00Z')
    for (const serverTz of ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
      process.env.TZ = serverTz
      assert.deepEqual(civilNow('Europe/Madrid', instant), { year: 2026, month: 9, day: 25, hour: 1, minute: 30 }, serverTz)
      assert.deepEqual(civilNow('America/New_York', instant), { year: 2026, month: 9, day: 24, hour: 19, minute: 30 }, serverTz)
      assert.deepEqual(civilNow('UTC', instant), { year: 2026, month: 9, day: 24, hour: 23, minute: 30 }, serverTz)
    }
  } finally {
    if (saved === undefined) delete process.env.TZ
    else process.env.TZ = saved
  }
})

test('day boundaries: midnight, daylight saving and the year change', () => {
  // Exactly midnight in Madrid (summer, UTC+2) is the new day at 00:00.
  assert.deepEqual(civilNow('Europe/Madrid', new Date('2026-09-24T22:00:00Z')), { year: 2026, month: 9, day: 25, hour: 0, minute: 0 })
  assert.deepEqual(civilNow('Europe/Madrid', new Date('2026-09-24T21:59:00Z')), { year: 2026, month: 9, day: 24, hour: 23, minute: 59 })
  // After the October change Madrid is UTC+1: 22:30 UTC is still the same day.
  assert.deepEqual(civilNow('Europe/Madrid', new Date('2026-10-26T22:30:00Z')), { year: 2026, month: 10, day: 26, hour: 23, minute: 30 })
  // New Year in Tokyo while it's still the old year in UTC.
  assert.deepEqual(civilNow('Asia/Tokyo', new Date('2026-12-31T15:00:00Z')), { year: 2027, month: 1, day: 1, hour: 0, minute: 0 })
  // UTC+14 and UTC-11 are never on the same date.
  const at = new Date('2026-09-25T12:00:00Z')
  assert.notEqual(civilNow('Pacific/Kiritimati', at).day, civilNow('Pacific/Pago_Pago', at).day)
})

test('civil date arithmetic', () => {
  assert.deepEqual(addDays({ year: 2026, month: 12, day: 31 }, 1), { year: 2027, month: 1, day: 1 })
  assert.deepEqual(addDays({ year: 2028, month: 3, day: 1 }, -1), { year: 2028, month: 2, day: 29 })
  assert.ok(isValidDate({ year: 2028, month: 2, day: 29 }))
  assert.ok(!isValidDate({ year: 2026, month: 2, day: 29 }))
  assert.ok(!isValidDate({ year: 2026, month: 13, day: 1 }))
})

test('ISO weeks: the Thursday decides the year', () => {
  assert.deepEqual(isoWeek({ year: 2026, month: 9, day: 25 }), { year: 2026, week: 39 })
  assert.deepEqual(isoWeek({ year: 2026, month: 12, day: 31 }), { year: 2026, week: 53 })
  assert.deepEqual(isoWeek({ year: 2027, month: 1, day: 3 }), { year: 2026, week: 53 })
  assert.deepEqual(isoWeek({ year: 2024, month: 12, day: 30 }), { year: 2025, week: 1 })
  assert.deepEqual(isoWeekStart(2025, 1), { year: 2024, month: 12, day: 30 })
  assert.deepEqual(isoWeekStart(2026, 39), { year: 2026, month: 9, day: 21 })
  assert.equal(isoWeekStart(2025, 53), null, '2025 has 52 weeks')
  assert.equal(isoWeekStart(2025, 0), null)
})

test('date formats: tokens, literals in brackets, the rest as is', () => {
  const dt = { year: 2026, month: 9, day: 5, hour: 8, minute: 7 }
  assert.equal(formatDate('YYYY-MM-DD', dt), '2026-09-05')
  assert.equal(formatDate('D/M/YY HH:mm', dt), '5/9/26 08:07')
  assert.equal(formatDate('GGGG-[W]WW', dt), '2026-W36')
  assert.equal(formatDate('[Diario] YYYY', dt), 'Diario 2026')
  assert.equal(formatDate('[Week] W', dt), 'Week 36')
  assert.equal(formatDate('Week W', dt), '36eek 36', 'a capital letter outside brackets can be a token, like in Moment')
  assert.equal(formatDate('', dt), '')
})
