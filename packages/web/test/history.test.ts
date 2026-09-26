import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { HistoryAuthor } from '../src/history/api.ts'
import { changeGroups, changeText, dayKey, dayLabel, filterOptions, groupByDay, reasonText, safeZone, shiftDay, uidOf } from '../src/history/format.ts'

/** The key and its values, so each test sees which text was asked for and with what. */
const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}${JSON.stringify(vars)}` : key)
const noa: HistoryAuthor = { kind: 'user', id: 'U1', name: 'noa', key: 'user:U1' }

test('the day of an instant is the one in the person\'s timezone', () => {
  const late = '2026-09-25T23:30:00Z'
  assert.equal(dayKey(late, 'UTC'), '2026-09-25')
  assert.equal(dayKey(late, 'Europe/Madrid'), '2026-09-26')
  assert.equal(dayKey(late, 'America/New_York'), '2026-09-25')
  assert.equal(safeZone('Not/AZone'), 'UTC')
  assert.equal(safeZone(null), 'UTC')
  assert.equal(safeZone('Europe/Madrid'), 'Europe/Madrid')
})

test('days before and after, across months and years', () => {
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28')
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31')
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01')
})

test('grouping by day keeps the order in which days first appear, and a day that comes back joins its group', () => {
  const items = ['2026-09-26T08:00:00Z', '2026-09-25T22:30:00Z', '2026-09-25T21:00:00Z', '2026-09-26T07:00:00Z', '2026-09-24T10:00:00Z']
  const groups = groupByDay(items, (x) => x, 'Europe/Madrid')
  assert.deepEqual(groups.map((g) => [g.key, g.items.length]), [['2026-09-26', 3], ['2026-09-25', 1], ['2026-09-24', 1]])
})

test('today, yesterday, or the date (with the year when it is another one)', () => {
  assert.equal(dayLabel(t, '2026-09-26', '2026-09-26', 'es'), 'history.today')
  assert.equal(dayLabel(t, '2026-09-25', '2026-09-26', 'es'), 'history.yesterday')
  assert.equal(dayLabel(t, '2026-09-24', '2026-09-26', 'es'), 'Jueves, 24 de septiembre')
  assert.equal(dayLabel(t, '2025-09-24', '2026-09-26', 'es'), 'Miércoles, 24 de septiembre de 2025')
  assert.equal(dayLabel(t, '2026-09-24', '2026-09-26', 'en'), 'Thursday, September 24')
})

test('changes of a diff: runs of edits, joined across a space on the same line, not across a line or a word', () => {
  const { group, count } = changeGroups([[0, 'a '], [-1, 'b'], [1, 'c'], [0, ' '], [1, 'd'], [0, '\n'], [1, 'e'], [0, ' x '], [-1, 'f']])
  assert.deepEqual(group, [-1, 0, 0, -1, 0, -1, 1, -1, 2])
  assert.equal(count, 3)
  assert.deepEqual(changeGroups([[0, 'same']]), { group: [-1], count: 0 })
  assert.deepEqual(changeGroups([]), { group: [], count: 0 })
})

test('the uid in a note\'s frontmatter, quoted or not; none without frontmatter', () => {
  assert.equal(uidOf('---\ntitle: A\nuid: 01ABC\n---\n# A\n'), '01ABC')
  assert.equal(uidOf('---\nuid: "01ABC"\n---\n'), '01ABC')
  assert.equal(uidOf('---\r\nuid: 01ABC\r\n---\r\n'), '01ABC')
  assert.equal(uidOf('# A\n\nuid: 01ABC\n'), null)
  assert.equal(uidOf('---\ntitle: A\n---\nuid: 01ABC\n'), null)
  assert.equal(uidOf(null), null)
})

test('what the system did, and for whom', () => {
  assert.equal(reasonText(t, { code: 'note_moved', from: 'a/Viaje.md', to: 'a/Roma.md', by: noa }), 'history.reason.renamed{"from":"Viaje","to":"Roma"}history.by{"name":"noa"}')
  assert.equal(reasonText(t, { code: 'note_moved', from: 'a/Viaje.md', to: 'b/c/Viaje.md', by: noa }), 'history.reason.moved{"name":"Viaje","to":"b / c / Viaje"}history.by{"name":"noa"}')
  assert.equal(reasonText(t, { code: 'folder_moved', from: 'a', to: 'b/a', by: null }), 'history.reason.folderMoved{"from":"a","to":"b/a"}')
  assert.equal(reasonText(t, { code: 'links_after_external_move', moves: [{ from: 'x.md', to: 'y/Nota.md' }], by: noa }), 'history.reason.externalMoveOne{"name":"Nota"}history.by{"name":"noa"}')
  assert.equal(reasonText(t, { code: 'links_after_external_move', moves: [{ from: 'x.md', to: 'y.md' }, { from: 'z.md', to: 'w.md' }] }), 'history.reason.externalMoveMany{"n":2}')
  const agent: HistoryAuthor = { kind: 'agent', id: 'K1', name: 'Claude', onBehalfOf: { id: 'U1', name: 'noa' }, key: 'agent:K1' }
  assert.equal(reasonText(t, { code: 'alias_added', alias: 'Viaje', from: 'Viaje.md', to: 'Roma.md', by: agent }), 'history.reason.alias{"alias":"Viaje","from":"Viaje"}history.by{"name":"history.agentPlain{\\"name\\":\\"Claude\\",\\"user\\":\\"noa\\"}"}')
  assert.equal(reasonText(t, { code: 'history_enabled' }), 'history.reason.historyEnabled')
  assert.equal(reasonText(t, { code: 'recovered' }), 'history.reason.recovered')
  // Restoring is said by the change itself; an unknown code says nothing.
  assert.equal(reasonText(t, { code: 'restored', id: 'c', at: '2026-09-25T10:05:00Z' }), null)
  assert.equal(reasonText(t, { code: 'something_new' }), null)
  assert.equal(reasonText(t, null), null)
})

test('what happened to the file: created, renamed or moved, deleted, restored (from which version, or from the trash)', () => {
  const date = (at: string) => `<${at}>`
  assert.equal(changeText(t, { change: 'modified', path: 'a.md', reason: null }, date), null)
  assert.equal(changeText(t, { change: 'created', path: 'a.md', reason: null }, date), 'history.change.created')
  assert.equal(changeText(t, { change: 'moved', path: 'a/Roma.md', from: 'a/Viaje.md', reason: null }, date), 'history.change.renamed{"from":"Viaje","to":"Roma"}')
  assert.equal(changeText(t, { change: 'moved', path: 'b/Viaje.md', from: 'a/Viaje.md', reason: null }, date), 'history.change.moved{"from":"a / Viaje","to":"b / Viaje"}')
  assert.equal(changeText(t, { change: 'restored', path: 'a.md', reason: { code: 'restored', id: 'c', at: 'T' } }, date), 'history.change.restoredFrom{"date":"<T>"}')
  assert.equal(changeText(t, { change: 'restored', path: 'a.md', reason: { code: 'trash_restored', id: 'x' } }, date), 'history.change.trashRestored')
  assert.equal(changeText(t, { change: 'deleted', path: 'a.md', reason: null }, date), 'history.change.deleted')
  // A revert is an edit that says which change it undid.
  assert.equal(changeText(t, { change: 'modified', path: 'a.md', reason: { code: 'reverted', id: 'c', at: 'T' } }, date), 'history.change.revertedFrom{"date":"<T>"}')
})

test('the author filter: people, agents (all of them too, when there are several), outside thoth, the system', () => {
  const authors: HistoryAuthor[] = [
    { kind: 'system', name: 'thoth', key: 'system' },
    { kind: 'external', name: '', key: 'external' },
    { kind: 'agent', id: 'K2', name: 'Otro', onBehalfOf: { id: 'U1', name: 'noa' }, key: 'agent:K2' },
    { kind: 'user', id: 'U2', name: 'ana', key: 'user:U2' },
    noa,
    noa,
  ]
  assert.deepEqual(filterOptions(t, authors).map((o) => o.key), ['user:U2', 'user:U1', 'agent:K2', 'external', 'system'])
  const more = [...authors, { kind: 'agent', id: 'K1', name: 'Claude', onBehalfOf: { id: 'U1', name: 'noa' }, key: 'agent:K1' } as HistoryAuthor]
  const options = filterOptions(t, more)
  assert.deepEqual(options.map((o) => o.key), ['user:U2', 'user:U1', 'agent:K1', 'agent:K2', 'agent', 'external', 'system'])
  assert.equal(options.find((o) => o.key === 'agent:K1')!.label, 'history.agent{"name":"Claude","user":"noa"}')
  assert.equal(options.find((o) => o.key === 'external')!.label, 'history.external')
})
