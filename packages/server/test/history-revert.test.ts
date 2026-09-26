// «Revert this change» as a three-way merge (history/revert.ts): what one
// version changed is undone on the note as it is now, and what was written
// since stays, unless it touches the same text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setFrontmatterKey } from '@thoth/core'
import type { Actor } from '@thoth/server'
import { applySplices } from '../src/edits.ts'
import { planRevert } from '../src/history/revert.ts'
import { contextAfter, contextBefore } from '../src/history/diff.ts'
import { setup, who } from './_history.ts'

/** Reverts on `current` what `version` changed from `before`. */
function revert(before: string, version: string, current: string) {
  const plan = planRevert(version, before, current)
  return { text: applySplices(current, plan.splices), plan }
}

const BEFORE = '# Plan\n\n## Storage\n\nWe keep notes in files.\nThe index is SQLite.\n\n## Sync\n\nNone yet.\n'
const AGENT = '# Plan\n\n## Storage\n\nWe keep notes in Postgres tables.\nThe index is Postgres too.\n\n## Sync\n\nNone yet.\n'

test('what the version changed goes; a paragraph written after it, right below, stays', () => {
  const now = AGENT.replace('Postgres too.\n\n', 'Postgres too.\n\nWhat about backups?\n\n')
  const { text, plan } = revert(BEFORE, AGENT, now)
  assert.equal(text, BEFORE.replace('SQLite.\n\n', 'SQLite.\n\nWhat about backups?\n\n'))
  assert.deepEqual(plan.counts, { reverted: 2, skipped: 0, already: 0 })
  assert.deepEqual(plan.reverted.map((p) => [p.removed, p.restored]), [['Postgres tables', 'files'], ['Postgres too', 'SQLite']])
  assert.equal(plan.reverted[0]!.before, 'We keep notes in ')
  assert.equal(plan.reverted[0]!.after, '.')
})

test('a whole line reverted comes with the lines around it that have text, never with nothing', () => {
  const version = BEFORE.replace('None yet.\n', 'None yet.\n\nAGENT: use Syncthing.\n')
  const { text, plan } = revert(BEFORE, version, version)
  assert.equal(text, BEFORE)
  assert.deepEqual(plan.reverted.map((p) => [p.before, p.removed, p.after]), [['None yet.\n', '\nAGENT: use Syncthing.\n', '']])
  // A line added in the middle: the line above and the one below.
  const middle = BEFORE.replace('We keep notes in files.\n', 'We keep notes in files.\nAGENT: in git too.\n')
  assert.deepEqual(revert(BEFORE, middle, middle).plan.reverted.map((p) => [p.before, p.after]), [['We keep notes in files.\n', 'The index is SQLite.']])
})

test('the text around a change: its own line, else the nearest line with something on it, within reach', () => {
  const t = 'Title\n\n\nBody line here.\nEnd'
  const at = t.indexOf('Body')
  assert.equal(contextBefore(t, at, 40), 'Title\n\n\n')
  assert.equal(contextBefore(t, at + 5, 40), 'Body ')
  assert.equal(contextBefore(t, at, 2), '', 'nothing with text within 2 characters')
  assert.equal(contextBefore(t, at, 3), 'tle\n\n\n')
  assert.equal(contextAfter(t, 5, 40), '\n\n\nBody line here.')
  assert.equal(contextAfter(t, at, 4), 'Body')
  assert.equal(contextAfter(t, t.length, 40), '')
  assert.equal(contextBefore(t, 0, 40), '')
})

test('a piece changed later is not reverted and is reported with its text; the rest is', () => {
  const now = AGENT.replace('Postgres tables', 'Postgres 17 tables')
  const { text, plan } = revert(BEFORE, AGENT, now)
  assert.equal(text, now.replace('The index is Postgres too.', 'The index is SQLite.'))
  assert.deepEqual(plan.counts, { reverted: 1, skipped: 1, already: 0 })
  assert.deepEqual(plan.skipped, [{ before: 'We keep notes in ', version: 'Postgres tables', previous: 'files', current: 'Postgres 17 tables', after: '.' }])
})

test('contiguous changes: next to it on the same line clashes; on the next line, both stay', () => {
  const before = 'Use cheap storage.\nBeta one.\n'
  const version = 'Use fast storage.\nBeta one.\n'
  // Right after the reverted word, on its line.
  const sameLine = revert(before, version, 'Use fast, durable storage.\nBeta one.\n')
  assert.equal(sameLine.text, 'Use fast, durable storage.\nBeta one.\n')
  assert.equal(sameLine.plan.counts.skipped, 1)
  assert.equal(sameLine.plan.skipped[0]!.current, 'fast, durable')
  // The line right below.
  const nextLine = revert(before, version, 'Use fast storage.\nBeta three.\n')
  assert.equal(nextLine.text, 'Use cheap storage.\nBeta three.\n')
  assert.equal(nextLine.plan.counts.skipped, 0)
  // A line the version added, and one written right after it.
  const added = revert('A\nC\n', 'A\nB\nC\n', 'A\nB\nD\nC\n')
  assert.equal(added.text, 'A\nD\nC\n')
  // Right before it, touching its first word.
  const touching = revert('Use cheap storage.\n', 'Use fast storage.\n', 'Use very fast storage.\n')
  assert.equal(touching.text, 'Use very fast storage.\n')
  assert.equal(touching.plan.counts.skipped, 1)
})

test('changes on lines a blank line apart are apart: a clash on one doesn\'t hold back the other', () => {
  // The history's diff shows these two as one change; reverting keeps them apart.
  const { text, plan } = revert('## Sync\n\nNothing yet.\n', '## Sync (v2)\n\nSyncthing yet.\n', '## Sync (v2)\n\nSyncthing2 yet.\n')
  assert.equal(text, '## Sync\n\nSyncthing2 yet.\n')
  assert.deepEqual(plan.counts, { reverted: 1, skipped: 1, already: 0 })
  assert.deepEqual(plan.skipped.map((s) => [s.version, s.previous, s.current]), [['Syncthing', 'Nothing', 'Syncthing2']])
})

test('a piece is what changed, cut where words end: never inside a word', () => {
  assert.deepEqual(revert('## Sync\n', '## Sync (v2)\n', '## Sync (v2)\n').plan.reverted.map((p) => [p.removed, p.restored]), [[' (v2)', '']])
  assert.deepEqual(revert('Sync now.\n', 'Syncthing now.\n', 'Syncthing now.\n').plan.reverted.map((p) => [p.removed, p.restored]), [['Syncthing', 'Sync']])
  // The next word changed later doesn't clash; the same word does.
  assert.equal(revert('Sync now.\n', 'Syncthing now.\n', 'Syncthing later.\n').text, 'Sync later.\n')
  assert.equal(revert('Sync now.\n', 'Syncthing now.\n', 'Syncthing2 now.\n').plan.counts.skipped, 1)
})

test('deletions: what the version deleted comes back, next to what was written after it', () => {
  // A paragraph deleted; something added at the end since.
  assert.equal(revert('A\nB\nC\n', 'A\nC\n', 'A\nC\nD\n').text, 'A\nB\nC\nD\n')
  // Something written since exactly where it was: the deleted text comes back first.
  assert.equal(revert('A\nB\nC\n', 'A\nC\n', 'A\nX\nC\n').text, 'A\nB\nX\nC\n')
  // Deleted inside a line, and written over since: that clashes.
  const inLine = revert('Use the fast disk.\n', 'Use the disk.\n', 'Use the old disk.\n')
  assert.equal(inLine.text, 'Use the old disk.\n')
  assert.equal(inLine.plan.counts.skipped, 1)
  assert.equal(inLine.plan.skipped[0]!.previous.trim(), 'fast', JSON.stringify(inLine.plan.skipped))
  // A version that only deleted a line that nobody touched since.
  assert.equal(revert('one\ntwo\nthree\n', 'one\nthree\n', 'zero\none\nthree\n').text, 'zero\none\ntwo\nthree\n')
  // A version that emptied the note; something written since.
  assert.equal(revert('A\nB\n', '', 'new\n').text, 'A\nB\nnew\n')
})

test('the frontmatter: keys the version added or changed go back, keys written since stay, and a uid the version gave the note is kept', () => {
  const before = '---\ntitle: Plan\n# a comment in the YAML\n---\nBody.\n'
  const edited = '---\ntitle: Plan v2\n# a comment in the YAML\nstatus: draft\n---\nBody.\n'
  const version = setFrontmatterKey(edited, 'uid', '01J0000000000000000000000A')
  const now = version.replace('title: Plan v2\n', 'title: Plan v2\ntags: [plan]\n')
  const { text, plan } = revert(before, version, now)
  assert.equal(text, now.replace('title: Plan v2', 'title: Plan').replace('status: draft\n', ''))
  assert.match(text, /^uid: 01J0000000000000000000000A$/m)
  assert.equal(plan.counts.skipped, 0)
  // A uid the note already had before the version isn't touched either.
  const withUid = setFrontmatterKey(before, 'uid', 'OLD')
  assert.equal(revert(withUid, withUid.replace('Body.', 'Body, longer.'), withUid.replace('Body.', 'Body, longer.')).text, withUid)
})

test('comments inside the note: the version\'s comment goes, a comment written after it elsewhere stays, a reply to it clashes', () => {
  const before = 'We use SQLite for the index.\nSecond line.\n'
  const version = 'We use Postgres for the index.<!-- @claude 2026-09-26T10:05Z · switched to Postgres -->\nSecond line.\n'
  const other = '<!-- @noa 2026-09-26T10:10Z · fine -->'
  const elsewhere = revert(before, version, version.replace('Second line.', `Second line.${other}`))
  assert.equal(elsewhere.text, `We use SQLite for the index.\nSecond line.${other}\n`)
  const reply = '<!-- @noa 2026-09-26T10:11Z · ↳ why? -->'
  const replied = revert(before, version, version.replace('Postgres -->', `Postgres -->${reply}`))
  assert.equal(replied.plan.counts.skipped, 1)
  assert.equal(replied.text, `We use SQLite for the index.<!-- @claude 2026-09-26T10:05Z · switched to Postgres -->${reply}\nSecond line.\n`)
  // A thread the version resolved (deleted) comes back if its sentence is still there.
  const thread = 'Keep backups.<!-- @noa 2026-09-25T09:00Z · daily? -->\n'
  assert.equal(revert(thread, 'Keep backups.\n', 'Keep backups.\nMore.\n').text, `${thread}More.\n`)
})

test('a change the note already undid is left alone; nothing to do means no splices', () => {
  const { plan } = revert(BEFORE, AGENT, BEFORE)
  assert.deepEqual(plan.splices, [])
  assert.deepEqual(plan.counts, { reverted: 0, skipped: 0, already: 2 })
  // Undone already, with a paragraph written right after the changed line: nothing clashes.
  const now = BEFORE.replace('SQLite.\n', 'SQLite.\n\nWhat about backups?\n')
  assert.deepEqual(revert(BEFORE, AGENT, now).plan.counts, { reverted: 0, skipped: 0, already: 2 })
  // A version that changed nothing in the text (a move).
  assert.deepEqual(revert(BEFORE, BEFORE, BEFORE + 'x\n').plan.counts, { reverted: 0, skipped: 0, already: 0 })
})

test('reverting a revert brings the change back, with what was written since', () => {
  const afterPerson = AGENT.replace('None yet.', 'None yet. Maybe later.')
  const reverted = revert(BEFORE, AGENT, afterPerson).text
  assert.equal(reverted, BEFORE.replace('None yet.', 'None yet. Maybe later.'))
  const later = reverted + 'Last line.\n'
  assert.equal(revert(afterPerson, reverted, later).text, afterPerson + 'Last line.\n')
})

test('splices are exact and apart: applied one after another they give the merged text', () => {
  const before = Array.from({ length: 50 }, (_, i) => `line ${i} with some words`).join('\n') + '\n'
  const version = before.replace(/line (\d*[05]) /g, 'LINE $1 ')
  // A word next to a reverted one (a space between) doesn't clash; the same word does.
  const now = version.replace('line 3 ', 'line three ').replace('LINE 10 ', 'LINE ten ').replace('LINE 20 ', 'LINES 20 ')
  const { text, plan } = revert(before, version, now)
  assert.equal(text, before.replace('line 3 ', 'line three ').replace('line 10 ', 'line ten ').replace('line 20 ', 'LINES 20 '))
  assert.equal(plan.counts.skipped, 1)
  assert.equal(plan.counts.reverted, 9)
  assert.deepEqual(plan.skipped.map((s) => [s.version, s.previous, s.current]), [['LINE', 'line', 'LINES']])
  for (let i = 1; i < plan.splices.length; i++) assert.ok(plan.splices[i]!.at < plan.splices[i - 1]!.at, 'from the last one')
})

test('long texts with little in common take bounded time, and a big piece is shortened in the report', () => {
  const words = (seed: number, n: number) => {
    let x = seed
    const out: string[] = []
    for (let i = 0; i < n; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff
      out.push(`w${x % 50_000}`)
      if (i % 12 === 11) out.push('\n')
    }
    return out.join(' ')
  }
  const before = words(1, 60_000)
  const version = words(2, 60_000)
  const now = version + '\nWritten after.\n'
  const started = performance.now()
  const { text, plan } = revert(before, version, now)
  const ms = performance.now() - started
  assert.ok(ms < 5_000, `took ${Math.round(ms)} ms`)
  // Too different to go word by word: one piece, the whole text; what was appended after stays.
  assert.equal(text, before + '\nWritten after.\n')
  assert.deepEqual(plan.counts, { reverted: 1, skipped: 0, already: 0 })
  assert.equal(plan.reverted[0]!.removed.length, 1_001)
  assert.equal(plan.reverted[0]!.removed[500], '…')
  // Many small pieces: the report lists the first 100, the counts have them all.
  const many = Array.from({ length: 300 }, (_, i) => `item ${i} a`).join('\n') + '\n'
  const manyChanged = many.replace(/ a$/gm, ' b')
  const r = revert(many, manyChanged, manyChanged)
  assert.equal(r.text, many)
  assert.equal(r.plan.counts.reverted, 300)
  assert.equal(r.plan.reverted.length, 100)
})

// --- Through the API, with the history recording -----------------------------------

const PLAN = 'proyectos/plan.md'

/** A note written by an agent (one version), then by the person (another), both in git. */
async function agentThenPerson(person: (t: string) => string) {
  const h = await setup({ files: { [PLAN]: BEFORE } })
  const agent: Actor = { kind: 'agent', id: 'key-1', onBehalfOf: h.ids.noa }
  await h.notes.edit(PLAN, (t) => t.replace('files.', 'Postgres tables.').replace('SQLite.', 'Postgres too.'), { actor: agent })
  await h.put(PLAN, person)
  await h.settle()
  const { versions } = await h.versions(PLAN)
  assert.deepEqual(versions.map(who), ['user:noa', 'agent', 'system'])
  const read = () => readFileSync(join(h.notesDir, PLAN), 'utf8')
  return { h, agentVersion: versions[1], read }
}

test('API: the preview writes nothing; reverting the agent\'s version keeps what the person wrote after it, as a version of the person\'s with the reason `reverted`', async () => {
  const { h, agentVersion, read } = await agentThenPerson((t) => t.replace('Postgres too.\n\n', 'Postgres too.\n\nWhat about backups?\n\n'))
  try {
    const before = read()
    const preview = await h.noa('POST', '/api/history/revert', { path: PLAN, id: agentVersion.id, dryRun: true })
    assert.equal(preview.status, 200, JSON.stringify(preview.body))
    assert.equal(preview.body.dryRun, true)
    assert.equal(preview.body.changed, false)
    assert.deepEqual(preview.body.counts, { reverted: 2, skipped: 0, already: 0 })
    assert.deepEqual(preview.body.reverted.map((p: any) => p.removed), ['Postgres tables', 'Postgres too'])
    await h.settle()
    assert.equal(read(), before, 'the preview writes nothing')
    assert.equal((await h.versions(PLAN)).versions.length, 3)

    const r = await h.noa('POST', '/api/history/revert', { path: PLAN, id: agentVersion.id })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.changed, true)
    const text = read()
    assert.ok(text.includes('We keep notes in files.\nThe index is SQLite.\n\nWhat about backups?\n'), text)
    assert.match(text, /^uid: /m, 'the uid the agent\'s write added stays')
    assert.equal(r.headers.get('etag'), `"${r.body.etag}"`)
    await h.settle()
    const { versions } = await h.versions(PLAN)
    assert.deepEqual(versions.map(who), ['user:noa', 'user:noa', 'agent', 'system'])
    assert.deepEqual(versions[0].reason, { code: 'reverted', id: agentVersion.id, at: agentVersion.at })
    assert.equal(versions[0].change, 'modified')
    const [change] = (await h.changes()).changes
    assert.deepEqual(change.reason, { code: 'reverted', id: agentVersion.id, at: agentVersion.at })
    assert.deepEqual(change.files.map((f: any) => f.path), [PLAN])

    // Reverting the revert brings the agent's change back, with the person's paragraph.
    const again = await h.noa('POST', '/api/history/revert', { path: PLAN, id: versions[0].id })
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.equal(read(), before)
    await h.settle()
    assert.deepEqual((await h.versions(PLAN)).versions[0].reason, { code: 'reverted', id: versions[0].id, at: versions[0].at })
  } finally { await h.close() }
})

test('API: a clash is reported in the preview and not applied; the rest is', async () => {
  const { h, agentVersion, read } = await agentThenPerson((t) => t.replace('Postgres tables', 'Postgres 17 tables'))
  try {
    const preview = await h.noa('POST', '/api/history/revert', { path: PLAN, id: agentVersion.id, dryRun: true })
    assert.deepEqual(preview.body.counts, { reverted: 1, skipped: 1, already: 0 })
    assert.deepEqual(preview.body.skipped, [{ before: 'We keep notes in ', version: 'Postgres tables', previous: 'files', current: 'Postgres 17 tables', after: '.' }])
    const r = await h.noa('POST', '/api/history/revert', { path: PLAN, id: agentVersion.id })
    assert.deepEqual(r.body.counts, { reverted: 1, skipped: 1, already: 0 })
    assert.ok(read().includes('We keep notes in Postgres 17 tables.\nThe index is SQLite.\n'), read())
    // Nothing left to revert: no write, no version.
    await h.settle()
    const n = (await h.versions(PLAN)).versions.length
    const none = await h.noa('POST', '/api/history/revert', { path: PLAN, id: agentVersion.id })
    assert.equal(none.status, 200)
    assert.equal(none.body.changed, false)
    assert.deepEqual(none.body.counts, { reverted: 0, skipped: 1, already: 1 })
    await h.settle()
    assert.equal((await h.versions(PLAN)).versions.length, n)
  } finally { await h.close() }
})

test('API: errors as codes: a creation or a deletion is not revertible, a stale ifMatch, an unknown version, a note that cannot be read', async () => {
  const h = await setup({ files: { [PLAN]: BEFORE }, canRead: (_u, p) => p !== 'privado/secreto.md' })
  try {
    const created = await h.noa('POST', '/api/note', { path: 'nueva.md', text: '# Nueva\n' })
    assert.equal(created.status, 201)
    await h.put('nueva.md', (t) => t + 'más\n')
    await h.settle()
    const { versions } = await h.versions('nueva.md')
    const creation = versions.at(-1)
    assert.equal(creation.change, 'created')
    const r1 = await h.noa('POST', '/api/history/revert', { path: 'nueva.md', id: creation.id })
    assert.deepEqual([r1.status, r1.body.error], [409, 'not_revertible'])

    const stale = await h.noa('POST', '/api/history/revert', { path: 'nueva.md', id: versions[0].id, ifMatch: 'sha256:0' })
    assert.equal(stale.status, 412)
    assert.equal(stale.body.error, 'precondition_failed')
    const fresh = await h.noa('GET', `/api/note?path=${h.q('nueva.md')}`)
    const ok = await h.noa('POST', '/api/history/revert', { path: 'nueva.md', id: versions[0].id, dryRun: true }, { 'if-match': `"${fresh.body.etag}"` })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))

    const del = await h.noa('DELETE', `/api/note?path=${h.q(PLAN)}`)
    assert.equal(del.status, 200)
    await h.settle()
    const gone = (await h.versions(PLAN)).versions[0]
    assert.equal(gone.change, 'deleted')
    const r2 = await h.noa('POST', '/api/history/revert', { path: PLAN, id: gone.id })
    assert.deepEqual([r2.status, r2.body.error], [409, 'not_revertible'])

    const unknown = await h.noa('POST', '/api/history/revert', { path: 'nueva.md', id: '0'.repeat(40) })
    assert.equal(unknown.status, 404)
    assert.equal((await h.noa('POST', '/api/history/revert', { path: 'nueva.md' })).status, 400)
    const hidden = await h.noa('POST', '/api/history/revert', { path: 'privado/secreto.md', id: versions[0].id })
    assert.deepEqual([hidden.status, hidden.body.error], [404, 'not_found'])
  } finally { await h.close() }
})
