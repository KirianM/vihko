import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchSeries, patternPeriod, patternTokens, seriesNeighbors, seriesPath, type Series } from '@thoth/core'
import { mother } from '../../../test/mother.ts'

// The people whose personal series the tests follow.
const m = mother(import.meta.url)
const USER = m.aUsername()
const OTHER = m.aUsername()
// The series' folders (any names do).
const DIARY = m.aFolder()
const WEEKS = m.aFolder()
const ELSEWHERE = m.aFolder()

const series = (folder: string, name: string): Series => {
  const period = patternPeriod(patternTokens(`${folder}/${name}`).tokens)
  assert.ok(period, `${folder}/${name}`)
  return { id: 'x', label: null, folder, name, template: null, period }
}
const day = (year: number, month: number, d: number) => ({ year, month, day: d })

test('series: the period comes from the tokens', () => {
  const period = (p: string) => patternPeriod(patternTokens(p).tokens)
  assert.equal(period(`${DIARY}/{YYYY}-{MM}-{DD}`), 'day')
  assert.equal(period(`${DIARY}/{YYYY}/{MM}/{DD}`), 'day')
  assert.equal(period(`${WEEKS}/{GGGG}-W{WW}`), 'week')
  assert.equal(period('Meses/{YYYY}-{MM}'), 'month')
  assert.equal(period('Años/{YYYY}'), 'year')
  assert.equal(period(`${DIARY}/{MM}-{DD}`), null, 'no year: one note would be reused every year')
  assert.equal(period(`${WEEKS}/{YYYY}-W{WW}`), null, 'weeks need the ISO week year')
  assert.equal(period('Mix/{GGGG}-{WW}-{DD}'), null)
  assert.equal(period(`${DIARY}/hoy`), null)
  assert.deepEqual(patternTokens('{user}/{YYYY}-{mm}-{Q}').unknown, ['mm', 'Q'])
})

test('series: the path of a date, personal or shared', () => {
  const personal = series(`${DIARY}/{user}`, '{YYYY}-{MM}-{DD}')
  assert.equal(seriesPath(personal, day(2026, 9, 25), USER), `${DIARY}/${USER}/2026-09-25.md`)
  const shared = series('', '{YYYY}-{MM}-{DD}')
  assert.equal(seriesPath(shared, day(2026, 9, 5), USER), '2026-09-05.md')
  const weekly = series(WEEKS, '{GGGG}-W{WW}')
  assert.equal(seriesPath(weekly, day(2027, 1, 2), USER), `${WEEKS}/2026-W53.md`, 'the last days of the year can belong to the next or the previous ISO year')
  assert.equal(seriesPath(weekly, day(2024, 12, 30), USER), `${WEEKS}/2025-W01.md`)
  assert.equal(seriesPath(series('M', '{YYYY}-{MM}'), day(2026, 9, 25), 'x'), 'M/2026-09.md')
})

test('series: a path belongs to the series only if the pattern gives exactly it', () => {
  const s = series(`${DIARY}/{user}`, '{YYYY}-{MM}-{DD}')
  assert.deepEqual(matchSeries(s, `${DIARY}/${USER}/2026-09-25.md`), { date: day(2026, 9, 25), user: USER })
  for (const p of [`${DIARY}/${USER}/2026-02-31.md`, `${DIARY}/${USER}/2026-9-25.md`, `${DIARY}/${USER}/2026-09-25 copia.md`, `${DIARY}/2026-09-25.md`, `${ELSEWHERE}/${USER}/2026-09-25.md`, `${DIARY}/${USER}/sub/2026-09-25.md`]) {
    assert.equal(matchSeries(s, p), null, p)
  }
  const weekly = series(WEEKS, '{GGGG}-W{WW}')
  assert.deepEqual(matchSeries(weekly, `${WEEKS}/2026-W39.md`), { date: day(2026, 9, 21), user: null })
  assert.equal(matchSeries(weekly, `${WEEKS}/2025-W53.md`), null, '2025 has no week 53')
  const repeated = series(`${DIARY}/{YYYY}`, '{YYYY}-{MM}-{DD}')
  assert.deepEqual(matchSeries(repeated, `${DIARY}/2026/2026-09-25.md`)?.date, day(2026, 9, 25))
  assert.equal(matchSeries(repeated, `${DIARY}/2025/2026-09-25.md`), null, 'the same token with two values')
  const literal = series('Log (x)', '[{YYYY}.{MM}.{DD}]')
  assert.deepEqual(matchSeries(literal, 'Log (x)/[2026.09.25].md')?.date, day(2026, 9, 25), 'regex characters in the pattern are literal')
})

test('series: previous and next are the nearest notes that exist, for the same person', () => {
  const s = series(`${DIARY}/{user}`, '{YYYY}-{MM}-{DD}')
  const NOT_A_DAY = m.aNotePath()
  const paths = [
    `${DIARY}/${USER}/2026-09-20.md`, `${DIARY}/${USER}/2026-09-24.md`, `${DIARY}/${USER}/2026-09-25.md`, `${DIARY}/${USER}/2026-10-02.md`,
    `${DIARY}/${OTHER}/2026-09-23.md`, `${DIARY}/${OTHER}/2026-09-26.md`, `${DIARY}/${USER}/${m.aTitle()}.md`, NOT_A_DAY,
  ]
  assert.deepEqual(seriesNeighbors(s, paths, `${DIARY}/${USER}/2026-09-25.md`), { prev: `${DIARY}/${USER}/2026-09-24.md`, next: `${DIARY}/${USER}/2026-10-02.md` })
  assert.deepEqual(seriesNeighbors(s, paths, `${DIARY}/${USER}/2026-09-20.md`), { prev: null, next: `${DIARY}/${USER}/2026-09-24.md` })
  assert.deepEqual(seriesNeighbors(s, paths, `${DIARY}/${OTHER}/2026-09-26.md`), { prev: `${DIARY}/${OTHER}/2026-09-23.md`, next: null })
  assert.equal(seriesNeighbors(s, paths, NOT_A_DAY), null)
})
