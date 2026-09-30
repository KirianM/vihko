// Leak tests (m3 §3, D-014): a key limited to one folder, with a note
// `ai: false` inside it, another with a frontmatter that can't be read, a
// folder holding only a hidden note, and notes outside that link to the
// visible one and mention the hidden ones. Every route a key may call
// (http/routes.ts) is walked, several ways each, and no response or error
// may carry a path, a title, a fragment, a tag or a count of what the key
// can't see (unless the request itself named it). A key route with no
// scenario here fails the test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROUTES, type DenyReason } from '@vihko/server'
import { PNG, setup } from './_agents.ts'
import { CONFIG, DIR, FILES, HIDDEN, NAME, PATH, SERIES, SUB, TAG, WORD, historyToHide, leaked } from './_leaks.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** A note and an image nobody has, in the key's folder; where a note from a template would go. */
const NOWHERE = m.aNotePath(DIR.key)
const NO_IMAGE = `${DIR.key}/${m.aTitle()}.png`
const FROM_TEMPLATE = m.aNotePath(DIR.key)
/** SQLite's order of folder paths (binary: UTF-8 bytes). */
const binary = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))

/** `deny`: the request names a hidden note, and is told so (403 `agent_denied`, with this reason). */
interface Call { method: string; path: string; body?: unknown; headers?: Record<string, string>; expect?: number; deny?: DenyReason }

const AI = 'ai_false' as const
const OUT = 'outside_key_folders' as const
/** What a call expects: a status, or a denial for that reason. */
const expect = (e: number | DenyReason): Pick<Call, 'expect' | 'deny'> => (typeof e === 'number' ? { expect: e } : { expect: 403, deny: e })

test('a key limited to a folder sees nothing of what it can\'t read, through any route', async () => {
  const h = await setup({ files: FILES, config: CONFIG })
  try {
    const { secret: secretIds, revealed, visible: visibleIds } = await historyToHide(h)

    await h.enableApi()
    const { token } = await h.newKey({ name: m.aKeyName(), canWrite: true, folders: [DIR.key] })
    const key = h.withKey(token)
    const q = (path: string, params: Record<string, string>) => h.url(path, params)
    const note = (path: string) => q('/api/note', { path })

    /** Every route a key may call, and how it's walked. */
    const scenarios: Record<string, Call[]> = {
      'GET /api/note': [[PATH.visible, 200], [PATH.secret, AI], [PATH.broken, AI], [PATH.onlyHidden, AI], [PATH.otherRenamed, OUT], [PATH.other, 404], [NOWHERE, 404]]
        .map(([p, e]) => ({ method: 'GET', path: note(p as string), ...expect(e as number | DenyReason) })),
      'GET /api/note/links': [[PATH.visible, 200], [PATH.secret, AI], [PATH.dupA, 200], [PATH.other, 404], [PATH.outsideDup, OUT]]
        .map(([p, e]) => ({ method: 'GET', path: q('/api/note/links', { path: p as string }), ...expect(e as number | DenyReason) })),
      'GET /api/note/headings': [{ method: 'GET', path: q('/api/note/headings', { path: PATH.visible }), expect: 200 }, { method: 'GET', path: q('/api/note/headings', { path: PATH.secret }), ...expect(AI) }],
      'GET /api/note/comments': [{ method: 'GET', path: q('/api/note/comments', { path: PATH.visible }), expect: 200 }, { method: 'GET', path: q('/api/note/comments', { path: PATH.broken }), ...expect(AI) }],
      'GET /api/search': [WORD.secret, WORD.other, WORD.broken, WORD.onlyHidden, WORD.revealed, WORD.moving, TAG.shared, `tag:${TAG.shared}`, `tag:${TAG.hidden}`, `path:"${DIR.outside}"`, `path:"${DIR.key}"`, NAME.dup, WORD.visible, NAME.visible]
        .map((s) => ({ method: 'GET', path: q('/api/search', { q: s }), expect: 200 })),
      'GET /api/tree': [{ method: 'GET', path: '/api/tree', expect: 200 }],
      'GET /api/tags': [{ method: 'GET', path: '/api/tags', expect: 200 }],
      // The daily note's path comes from vihko.yaml, not from the key: one that doesn't exist outside its folders is not_found, without the path (a hidden one that exists: daily-agents.test.ts).
      'GET /api/daily': [{ method: 'GET', path: '/api/daily', expect: 200 }, { method: 'GET', path: q('/api/daily', { series: SERIES.outside }), expect: 404 }],
      // Files that aren't notes stay not_found.
      'GET /api/file': [[PATH.photo, 200], [PATH.hiddenPhoto, 404], [PATH.outsideImage, 404], [NO_IMAGE, 404]]
        .map(([p, s]) => ({ method: 'GET', path: q('/api/file', { path: p as string }), expect: s as number })),
      'GET /api/history/status': [{ method: 'GET', path: '/api/history/status', expect: 200 }],
      'GET /api/history/versions': [[PATH.visible, 200], [PATH.secret, AI], [PATH.revealed, 200], [PATH.movedIn, 200], [PATH.other, 404], [PATH.otherRenamed, OUT], [PATH.broken, AI]]
        .map(([p, e]) => ({ method: 'GET', path: q('/api/history/versions', { path: p as string }), ...expect(e as number | DenyReason) })),
      'GET /api/history/version': [
        { method: 'GET', path: q('/api/history/version', { path: PATH.visible, id: visibleIds[0]! }), expect: 200 },
        { method: 'GET', path: q('/api/history/version', { path: PATH.secret, id: secretIds[0]! }), ...expect(AI) },
        // A version from when a note it can see now was hidden: still doesn't exist.
        { method: 'GET', path: q('/api/history/version', { path: PATH.revealed, id: revealed.at(-1)! }), expect: 404 },
        { method: 'GET', path: q('/api/history/version', { path: PATH.revealed, id: revealed[0]! }), expect: 200 },
      ],
      'GET /api/history/diff': [
        { method: 'GET', path: q('/api/history/diff', { path: PATH.revealed, id: revealed[0]! }), expect: 200 },
        { method: 'GET', path: q('/api/history/diff', { path: PATH.revealed, id: revealed[0]!, against: revealed.at(-1)! }), expect: 404 },
        { method: 'GET', path: q('/api/history/diff', { path: PATH.revealed, id: revealed.at(-1)! }), expect: 404 },
        { method: 'GET', path: q('/api/history/diff', { path: PATH.secret, id: secretIds[0]! }), ...expect(AI) },
        { method: 'GET', path: q('/api/history/diff', { path: PATH.visible, id: visibleIds[0]!, against: 'current' }), expect: 200 },
      ],
      'GET /api/history/changes': [{ method: 'GET', path: q('/api/history/changes', { limit: '50' }), expect: 200 }],
      'GET /api/history/resolved': [{ method: 'GET', path: q('/api/history/resolved', { path: PATH.visible }), expect: 200 }, { method: 'GET', path: q('/api/history/resolved', { path: PATH.secret }), ...expect(AI) }],

      'POST /api/note': [
        { method: 'POST', path: '/api/note', body: { path: PATH.secret, text: m.aSentence() }, ...expect(AI) },
        { method: 'POST', path: '/api/note', body: { path: PATH.broken, text: m.aSentence() }, ...expect(AI) },
        { method: 'POST', path: '/api/note', body: { path: PATH.outsideDup, text: m.aSentence() }, ...expect(OUT) },
        // No note there: out of its folders, it isn't anywhere it can write.
        { method: 'POST', path: '/api/note', body: { path: m.aNotePath(DIR.outside), text: m.aSentence() }, expect: 404 },
        { method: 'POST', path: '/api/note', body: { path: FROM_TEMPLATE, template: PATH.template }, ...expect(OUT) },
        { method: 'POST', path: '/api/note', body: { path: FROM_TEMPLATE, template: PATH.secret }, ...expect(AI) },
        { method: 'POST', path: '/api/note', body: { path: m.aNotePath(DIR.key), text: `# ${m.aHeading()}\n` }, expect: 201 },
      ],
      'PUT /api/note': [
        { method: 'PUT', path: note(PATH.secret), body: { text: m.aSentence() }, headers: { 'if-match': '"sha256:x"' }, ...expect(AI) },
        { method: 'PUT', path: note(PATH.secret), body: { text: m.aSentence() }, headers: { 'if-none-match': '*' }, ...expect(AI) },
        { method: 'PUT', path: note(PATH.other), body: { text: m.aSentence() }, headers: { 'if-none-match': '*' }, expect: 404 },
        { method: 'PUT', path: note(m.aNotePath(DIR.key)), body: { text: `# ${m.aHeading()}\n` }, headers: { 'if-none-match': '*' }, expect: 201 },
      ],
      'POST /api/note/edit': [
        { method: 'POST', path: '/api/note/edit', body: { path: PATH.secret, ops: [{ op: 'append', text: m.aSentence() }] }, ...expect(AI) },
        { method: 'POST', path: '/api/note/edit', body: { path: PATH.broken, ops: [{ op: 'append', text: m.aSentence() }], dryRun: true }, ...expect(AI) },
        { method: 'POST', path: '/api/note/edit', body: { path: PATH.other, ops: [{ op: 'append', text: m.aSentence() }] }, expect: 404 },
        { method: 'POST', path: '/api/note/edit', body: { path: PATH.otherRenamed, ops: [{ op: 'append', text: m.aSentence() }] }, ...expect(OUT) },
      ],
      'POST /api/note/move': [
        { method: 'POST', path: '/api/note/move', body: { from: PATH.visible, to: m.aNotePath(DIR.key), dryRun: true }, expect: 200 },
        { method: 'POST', path: '/api/note/move', body: { from: PATH.visible, to: m.aNotePath(DIR.outside) }, expect: 404 },
        { method: 'POST', path: '/api/note/move', body: { from: PATH.secret, to: m.aNotePath(DIR.key) }, ...expect(AI) },
        { method: 'POST', path: '/api/note/move', body: { from: PATH.dupA, to: PATH.secret }, ...expect(AI) },
      ],
      'DELETE /api/note': [
        { method: 'DELETE', path: note(PATH.secret), ...expect(AI) },
        { method: 'DELETE', path: note(PATH.otherRenamed), ...expect(OUT) },
      ],
      'POST /api/daily': [
        { method: 'POST', path: '/api/daily', body: { series: SERIES.outside }, expect: 404 },
        { method: 'POST', path: '/api/daily', body: {}, expect: 201 },
      ],
      'POST /api/attachments': [
        { method: 'POST', path: q('/api/attachments', { note: PATH.secret }), body: PNG, ...expect(AI) },
        { method: 'POST', path: q('/api/attachments', { note: PATH.other }), body: PNG, expect: 404 },
      ],
      'POST /api/history/restore': [
        { method: 'POST', path: '/api/history/restore', body: { path: PATH.secret, id: secretIds.at(-1) }, ...expect(AI) },
        { method: 'POST', path: '/api/history/restore', body: { path: PATH.revealed, id: revealed.at(-1) }, expect: 404 },
      ],
      'POST /api/history/revert': [
        { method: 'POST', path: '/api/history/revert', body: { path: PATH.secret, id: secretIds[0] }, ...expect(AI) },
        // A version it can't see can't be reverted; the one where the note became visible reads as its creation.
        { method: 'POST', path: '/api/history/revert', body: { path: PATH.revealed, id: revealed.at(-1) }, expect: 404 },
        { method: 'POST', path: '/api/history/revert', body: { path: PATH.revealed, id: revealed[0], dryRun: true }, expect: 409 },
      ],
    }

    const keyRoutes = Object.entries(ROUTES).filter(([, c]) => c === 'read' || c === 'write').map(([r]) => r)
    assert.deepEqual(keyRoutes.filter((r) => !(r in scenarios)), [], 'every route a key may call has its leak scenarios')

    const hiddenBefore = HIDDEN.map((p) => readFileSync(join(h.notesDir, p), 'utf8'))
    const responses: Record<string, { status: number; text: string }[]> = {}
    for (const route of keyRoutes) {
      for (const call of scenarios[route]!) {
        const r = await key(call.method, call.path, call.body, call.headers)
        // The query as the server reads it (form encoding: a space is `+`).
        const asked = decodeURIComponent(call.path.replace(/\+/g, ' ')) + JSON.stringify(call.body ?? '')
        const shown = r.text + JSON.stringify([...r.headers.entries()])
        assert.deepEqual(leaked(shown, asked), [], `${route} ${call.path} ${JSON.stringify(call.body ?? '')} → ${r.status} ${r.text.slice(0, 400)}`)
        const where = `${route} ${call.path} ${JSON.stringify(call.body ?? '')}: ${r.text.slice(0, 300)}`
        if (call.expect !== undefined) assert.equal(r.status, call.expect, where)
        // What can't be seen is `not_found`, never `forbidden`; a hidden note the request named, `agent_denied` with its reason and nothing else.
        if (r.status === 404) assert.equal(r.body?.error, 'not_found', where)
        if (r.status === 403) {
          assert.ok(call.deny, `${where}: denied without naming a hidden note`)
          assert.ok(HIDDEN.some((p) => asked.includes(p)), `${where}: denied, but it named no hidden note`)
          assert.deepEqual(Object.keys(r.body).sort(), ['error', 'message', 'reason'], where)
          assert.deepEqual([r.body.error, r.body.reason], ['agent_denied', call.deny], where)
        } else assert.equal(call.deny, undefined, `${where}: expected a denial`)
        ;(responses[route] ??= []).push({ status: r.status, text: r.text })
      }
    }

    // Every write over a hidden note was denied and wrote nothing.
    assert.deepEqual(HIDDEN.map((p) => readFileSync(join(h.notesDir, p), 'utf8')), hiddenBefore)

    // Counts: only what the key can read counts.
    const tags = JSON.parse(responses['GET /api/tags']![0]!.text).tags as { tag: string; count: number; total: number }[]
    assert.deepEqual(tags.find((t) => t.tag === TAG.shared), { tag: TAG.shared, count: 1, total: 1 })
    const adminTags = (await h.admin('GET', '/api/tags')).body.tags as { tag: string; count: number }[]
    assert.equal(adminTags.find((t) => t.tag === TAG.shared)!.count, 3, 'the UI still sees everything')
    const byTag = (await key('GET', q('/api/search', { q: `tag:${TAG.shared}` }))).body.results
    assert.deepEqual(byTag.map((r: { path: string }) => r.path), [PATH.visible])

    // Links: to an invisible note, just text; an ambiguous one keeps what the key sees.
    const links = JSON.parse(responses['GET /api/note/links']![0]!.text)
    const out = Object.fromEntries(links.outgoing.map((l: { raw: string }) => [l.raw, l]))
    const [toSecret, toRenamed, toDup] = [`[[${NAME.secret}]]`, `[[${NAME.otherRenamed}]]`, `[[${NAME.dup}]]`]
    assert.deepEqual([out[toSecret].status, out[toSecret].dstPath, out[toRenamed].status, out[toRenamed].dstPath], ['no_access', null, 'no_access', null])
    assert.deepEqual([out[toDup].status, out[toDup].candidates], ['ambiguous', [PATH.dupA, PATH.dupB].sort()])
    assert.deepEqual(links.backlinks, [], 'the notes that link to it are all hidden or outside')

    // The tree: no hidden note, no folder that only holds hidden notes, nothing outside.
    const tree = JSON.parse(responses['GET /api/tree']![0]!.text)
    assert.deepEqual(tree.notes.map((n: { path: string }) => n.path).sort(), [PATH.dupA, PATH.dupB, PATH.movedIn, PATH.revealed, PATH.visible].sort())
    // The folders on the way to the key's (`spaces`, the space) show too.
    const space = DIR.key.slice(0, DIR.key.lastIndexOf('/'))
    assert.deepEqual(tree.folders, ['spaces', space, DIR.key, `${DIR.key}/${SUB.a}`, `${DIR.key}/${SUB.b}`].sort(binary))

    // A note hidden once: its history starts where the key could see it.
    const rev = JSON.parse(responses['GET /api/history/versions']![2]!.text).versions
    assert.deepEqual(rev.map((v: { change: string }) => v.change), ['created'])
    const moved = JSON.parse(responses['GET /api/history/versions']![3]!.text).versions
    assert.deepEqual(moved.map((v: { change: string; from?: string }) => [v.change, v.from]), [['moved', undefined]])

    // The move's preview says there are links in notes it can't see, not which or how many.
    const preview = JSON.parse(responses['POST /api/note/move']![0]!.text)
    assert.equal(preview.hidden, true)
    assert.deepEqual(preview.relinked.map((r: { path: string }) => r.path), [])

    // The daily note came out without the template the key can't read.
    const daily = readFileSync(join(h.notesDir, PATH.daily), 'utf8')
    assert.ok(!daily.includes(WORD.template), daily)

    // The link rewritten by a move it can't see: the version is there, the paths of that move aren't.
    const visibleVersions = JSON.parse(responses['GET /api/history/versions']![0]!.text).versions
    const relinked = visibleVersions.find((v: { reason: { code?: string } | null }) => v.reason?.code === 'note_moved')
    assert.deepEqual([relinked.reason.from, relinked.reason.to, relinked.reason.by.name], [null, null, h.users.admin.username])

    // «Recent changes»: only files it can see, and only their authors.
    const changes = JSON.parse(responses['GET /api/history/changes']![0]!.text)
    const files = changes.changes.flatMap((c: { files: { path: string }[] }) => c.files.map((f) => f.path))
    assert.ok(files.includes(PATH.visible))
    assert.ok(files.every((f: string) => f.startsWith(`${DIR.key}/`) && ![PATH.secret, PATH.broken].includes(f)), files.join(', '))
  } finally { await h.close() }
})

test('the filter in the query and the one for a path agree, note by note', async () => {
  const h = await setup({ files: FILES, config: CONFIG })
  try {
    const { token } = await h.newKey({ name: m.aKeyName(), folders: [DIR.key] })
    const principal = h.keys.authenticate(token, 'api')!
    const access = h.services.policy.for(principal)
    const w = access.notesWhere('n')
    const all = (h.services.scoped(h.services.policy.for({ kind: 'user', user: h.users.admin })).tree().notes).map((n) => n.path)
    const listed = new Set((h.services.scoped(access).tree().notes).map((n) => n.path))
    const viaSql = new Set((h.index.prepare(`select path from notes n where ${w.sql}`).all(...w.params) as { path: string }[]).map((r) => r.path))
    for (const p of all) {
      assert.equal(listed.has(p), access.canRead(p), p)
      assert.equal(viaSql.has(p), access.canRead(p), p)
    }
    assert.deepEqual([...listed].sort(), [PATH.dupA, PATH.dupB, PATH.visible].sort())
    assert.ok(all.length > listed.size)
  } finally { await h.close() }
})
