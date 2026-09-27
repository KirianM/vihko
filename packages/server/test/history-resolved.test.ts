// Comment threads resolved from a note, from its history (D-032.5): through the
// API over the managed history, and the walk itself over a reader made up here
// (the 30-day window, what is still open, and how much it reads).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseThreads, reopener, resolveThread, type Change } from '@thoth/core'
import { wordStats, type AuthorRef, type HistoryReader, type RawVersion } from '@thoth/server'
import { ResolvedThreads } from '../src/history/resolved.ts'
import { setup } from './_history.ts'
import { yamlKey } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** Who wrote the comments in the note's text (names in the text, not the setup's users). */
const WRITER = m.aUsername()
const REPLIER = m.aUsername()

const NOTE = m.aNotePath(m.aFolder())
/** The two sentences comments hang from, and what the comments say. */
const [FIRST, SECOND] = [m.aSentence(), m.aSentence()]
const [SAID, REPLIED, ASKED] = [m.aComment(), m.aComment(), m.aComment()]
const K = `<!-- @${WRITER} 2026-09-24T08:12Z · ${SAID} -->`
const R = `<!-- @${REPLIER} 2026-09-24T08:15Z · ↳ ${REPLIED} -->`
const OTHER = `<!-- @${REPLIER} 2026-09-25T10:00Z · ${ASKED} -->`
const TEXT = `# ${m.aHeading()}\n\n${FIRST}${K}\n${R}\n\n${SECOND}${OTHER}\n`

const apply = (doc: string, c: Change) => doc.slice(0, c.from) + c.insert + doc.slice(c.to)
/** The text without its thread `i`, as resolving it in the editor leaves it. */
const without = (i: number) => (text: string) => apply(text, resolveThread(text, parseThreads(text)[i]!))

type Setup = Awaited<ReturnType<typeof setup>>
async function resolvedOf(h: Setup, path: string) {
  const q = new URLSearchParams()
  q.set('path', path)
  const r = await h.admin('GET', `/api/history/resolved?${q}`)
  if (r.status !== 200) throw new Error(`resolved of ${path}: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body as { threads: any[]; complete: boolean }
}
const names = (t: { resolvedBy: { name: string }[] }) => t.resolvedBy.map((a) => a.name)

test('a resolved thread is listed at once, whole, by whoever resolved it; once a version, with that version', async () => {
  const h = await setup({ files: { [NOTE]: TEXT }, quietMs: 60_000 })
  try {
    assert.deepEqual(await resolvedOf(h, NOTE), { threads: [], complete: true })
    await h.put(NOTE, without(0), 'member')
    // Not a version yet: what is open is compared with the newest version.
    const open = (await resolvedOf(h, NOTE)).threads
    assert.equal(open.length, 1)
    const [t] = open
    assert.equal(t.id, `${WRITER}|2026-09-24T08:12Z|${SAID}`)
    assert.deepEqual(t.comments, [
      { author: WRITER, date: '2026-09-24T08:12Z', text: SAID, reply: false },
      { author: REPLIER, date: '2026-09-24T08:15Z', text: REPLIED, reply: true },
    ])
    assert.equal(t.anchor, FIRST)
    assert.equal(t.place.removed, `${K}\n${R}`)
    assert.equal(t.version, null)
    assert.deepEqual(names(t), [h.users.member.username])
    assert.ok(Date.now() - Date.parse(t.resolvedAt) < 10_000)
    assert.equal(t.reopenable, true)
    await h.settle()
    const { versions } = await h.versions(NOTE)
    const [closed] = (await resolvedOf(h, NOTE)).threads
    assert.equal(closed.version, versions[0].id)
    assert.equal(closed.resolvedAt, versions[0].at)
    assert.deepEqual(closed.resolvedBy, [{ kind: 'user', id: h.ids.member, name: h.users.member.username, key: `user:${h.ids.member}` }])
  } finally { await h.close() }
})

test('reopened, it is no longer resolved; resolved again, it is listed once, by the last one', async () => {
  const h = await setup({ files: { [NOTE]: TEXT } })
  try {
    await h.put(NOTE, without(0), 'member')
    await h.settle()
    const [t] = (await resolvedOf(h, NOTE)).threads
    // What the editor does to reopen it, here as a write of the note.
    await h.put(NOTE, (text) => apply(text, reopener(text)(t)!))
    await h.settle()
    assert.ok((await h.admin('GET', `/api/note?path=${h.q(NOTE)}`)).body.text.endsWith(TEXT.slice(TEXT.indexOf('\n'))), 'back where it was')
    assert.deepEqual((await resolvedOf(h, NOTE)).threads, [])
    await h.put(NOTE, without(0))
    await h.settle()
    const again = (await resolvedOf(h, NOTE)).threads
    assert.equal(again.length, 1)
    assert.deepEqual(names(again[0]), [h.users.admin.username])
    assert.equal(again[0].version, (await h.versions(NOTE)).versions[0].id)
  } finally { await h.close() }
})

test('a thread whose text was deleted can be read but not reopened; a reply more is not a resolution', async () => {
  const h = await setup({ files: { [NOTE]: TEXT } })
  try {
    await h.put(NOTE, (text) => text.replace(`${SECOND}${OTHER}\n`, ''), 'member')
    await h.put(NOTE, (text) => text.replace(R, `${R}\n<!-- @${WRITER} 2026-09-24T09:00Z · ↳ ${m.aComment()} -->`))
    await h.settle()
    const { threads } = await resolvedOf(h, NOTE)
    assert.deepEqual(threads.map((t) => [t.anchor, names(t), t.reopenable]), [[SECOND, [h.users.member.username], false]])
  } finally { await h.close() }
})

test('the resolved threads follow the note when it moves', async () => {
  const h = await setup({ files: { [NOTE]: TEXT } })
  const moved = m.aNotePath(m.aFolder())
  try {
    await h.put(NOTE, without(0), 'member')
    await h.settle()
    assert.equal((await h.admin('POST', '/api/note/move', { from: NOTE, to: moved })).status, 200)
    await h.put(moved, without(0))
    await h.settle()
    const { threads } = await resolvedOf(h, moved)
    assert.deepEqual(threads.map((t) => [t.anchor, names(t), t.reopenable]), [
      [SECOND, [h.users.admin.username], true],
      [FIRST, [h.users.member.username], true],
    ])
  } finally { await h.close() }
})

test('the same permission check as the rest of the history, and its errors', async () => {
  // Nobody reads privado/ (the fixed vault's): its history doesn't exist for anyone. (Nobody manages the root: whoever did would reach it, D-040 3.5.)
  const h = await setup({ files: { [NOTE]: TEXT }, config: ({ admin, member }) => `permissions:\n  "": { grants: { ${yamlKey(admin)}: edit, ${yamlKey(member)}: edit } }\n  privado: { grants: {} }\n` })
  try {
    assert.equal((await h.admin('GET', `/api/history/resolved?path=${h.q('privado/sin-ia.md')}`)).status, 404)
    assert.equal((await h.admin('GET', '/api/history/resolved?path=..%2Fx.md')).status, 400)
  } finally { await h.close() }
  const off = await setup({ files: { [NOTE]: TEXT }, config: 'history:\n  mode: off\n' })
  try {
    const r = await off.admin('GET', `/api/history/resolved?path=${off.q(NOTE)}`)
    assert.deepEqual([r.status, r.body.error], [409, 'history_off'])
  } finally { await off.close() }
})

// --- The walk, over a reader made up here -------------------------------------------------

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 26, 12)
/** The note the made-up reader holds, and its numbered sentences, each with a numbered comment. */
const WALKED = m.aNotePath()
const [PHRASE, SAYS] = [m.aTitle(), m.aWord()]
const anchor = (n: number) => `${PHRASE} ${n}.`
const thread = (n: number) => `${anchor(n)}<!-- @${REPLIER} 2026-08-01T10:00Z · ${SAYS} ${n} -->\n\n`
const drop = (text: string, n: number) => text.replace(`<!-- @${REPLIER} 2026-08-01T10:00Z · ${SAYS} ${n} -->`, '')

/** A note's history, newest first: each version's text; the one before it is the next one's. */
function madeUp(list: { id: string; at: number; text: string | null; by?: AuthorRef }[]) {
  const reads = new Map<string, number>()
  const versions: RawVersion[] = list.map((v, i) => {
    const before = list[i + 1]?.text ?? null
    return {
      id: v.id, at: new Date(v.at).toISOString(), authors: [v.by ?? { kind: 'external' }], reason: null, foundAtStartup: false, path: WALKED,
      change: before === null ? 'created' : v.text === null ? 'deleted' : 'modified',
      ...wordStats(before ?? '', v.text ?? ''),
    }
  })
  const reader: HistoryReader = {
    async versions(_path, page) {
      const start = page.cursor ? Number(page.cursor) : 0
      const end = start + page.limit
      return { versions: versions.slice(start, end), next: end < versions.length ? String(end) : null }
    },
    async version(_path, id) {
      reads.set(id, (reads.get(id) ?? 0) + 1)
      const i = list.findIndex((v) => v.id === id)
      if (i === -1) return null
      return { path: WALKED, id, at: versions[i]!.at, text: list[i]!.text, before: list[i + 1]?.text ?? null }
    },
    async file() { return null },
    async changes() { return { changes: [], next: null } },
    async authors() { return [] },
  }
  return { reader, reads }
}

test('the walk: the last 30 days only, what came back is not resolved, and each version is read once however often it is asked', async () => {
  const t0 = thread(1) + thread(2) + thread(3)
  const t1 = drop(t0, 3)
  const t2 = drop(t1, 1)
  const t3 = t1 + `${m.aSentence()}\n`
  const t4 = drop(t3, 2)
  const resolver: AuthorRef = { kind: 'user', id: 'u-1' }
  const { reader, reads } = madeUp([
    { id: 'v4', at: NOW - 1 * DAY, text: t4, by: resolver }, // resolves 2
    { id: 'v3', at: NOW - 10 * DAY, text: t3 }, // 1 comes back, and more text: nothing removed
    { id: 'v2', at: NOW - 20 * DAY, text: t2 }, // resolves 1
    { id: 'v1', at: NOW - 40 * DAY, text: t1 }, // resolves 3, too long ago
    { id: 'v0', at: NOW - 50 * DAY, text: t0 },
  ])
  const resolved = new ResolvedThreads({ now: () => NOW })
  for (let i = 0; i < 3; i++) {
    const r = await resolved.list(reader, WALKED, { current: t4, pending: null })
    assert.equal(r.complete, true)
    assert.deepEqual(r.threads.map((t) => [t.anchor, t.version, t.resolvedBy, t.reopenable]), [[anchor(2), 'v4', [resolver], true]])
  }
  assert.deepEqual(Object.fromEntries(reads), { v4: 1, v2: 1 }, 'never v3 (it removed nothing) nor what is older than 30 days')
})

test('the walk: what is still open counts, by whoever has it open; without anything open, only versions', async () => {
  const t0 = thread(1) + thread(2)
  const t1 = t0 + `${m.aSentence()}\n`
  const { reader, reads } = madeUp([{ id: 'v1', at: NOW - DAY, text: t1 }, { id: 'v0', at: NOW - 2 * DAY, text: t0 }])
  const resolved = new ResolvedThreads({ now: () => NOW })
  const typing: AuthorRef = { kind: 'user', id: 'u-2' }
  const open = await resolved.list(reader, WALKED, { current: drop(t1, 1), pending: [typing] })
  assert.deepEqual(open.threads.map((t) => [t.anchor, t.version, t.resolvedBy, t.resolvedAt]), [[anchor(1), null, [typing], new Date(NOW).toISOString()]])
  // A change that isn't a version (the notes folder's git: not committed) doesn't count.
  assert.deepEqual((await resolved.list(reader, WALKED, { current: drop(t1, 1), pending: null })).threads, [])
  assert.deepEqual(Object.fromEntries(reads), { v1: 1 })
})

test('the walk: a long history is read over several requests, never too much in one', async () => {
  const n = 260
  const list: { id: string; at: number; text: string }[] = []
  let text = Array.from({ length: n }, (_, i) => thread(i)).join('')
  list.push({ id: 'created', at: NOW - 29 * DAY, text })
  for (let i = 0; i < n; i++) {
    text = drop(text, i)
    list.unshift({ id: `r${i}`, at: NOW - 28 * DAY + i * 60_000, text })
  }
  const { reader, reads } = madeUp(list)
  const resolved = new ResolvedThreads({ now: () => NOW })
  const first = await resolved.list(reader, WALKED, { current: text, pending: null })
  assert.equal(first.complete, false)
  assert.ok(first.threads.length >= 1 && first.threads.length <= 200, `${first.threads.length} in the first request`)
  let last = first
  for (let i = 0; i < 5 && !last.complete; i++) last = await resolved.list(reader, WALKED, { current: text, pending: null })
  assert.equal(last.complete, true)
  assert.equal(last.threads.length, n)
  assert.equal(last.threads[0]!.anchor, anchor(n - 1), 'newest first')
  assert.ok([...reads.values()].every((c) => c === 1), 'no version read twice')
})
