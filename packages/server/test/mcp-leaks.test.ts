// Leak tests for the MCP server, over the same scenario as the
// HTTP API's (leaks.test.ts): a key limited to one folder that can write,
// with hidden notes inside and notes outside that mention them. Every tool
// the key gets is called, several ways each, and no result or error (nor the
// server's instructions) may carry a path, a title, a fragment, a tag or a
// count of what the key can't see, unless the call itself named it. A call
// that names a hidden note is told so (`agent_denied`, with the reason and
// nothing else), and only such a call. A tool with no scenario here fails
// the test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG, setup } from './_agents.ts'
import type { DenyReason } from '@vihko/server'
import { CONFIG, DIR, FIELD, FILES, HIDDEN, NAME, OTHER_HEADING, PATH, SERIES, SUB, TAG, WORD, historyToHide, leaked } from './_leaks.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** A note nobody has, in the key's folder; where a note from a template would go. */
const NOWHERE = m.aNotePath(DIR.key)
const FROM_TEMPLATE = m.aNotePath(DIR.key)
/** An image to attach, in base64. */
const IMAGE = PNG.toString('base64')

test('a key limited to a folder sees nothing of what it can\'t read, through any MCP tool', async () => {
  // The workspace's guide for agents is a hidden note: it isn't served either.
  const h = await setup({ files: FILES, config: CONFIG + `mcp:\n  instructions: ${JSON.stringify(PATH.secret.replace(/\.md$/, ''))}\n` })
  try {
    const { secret, revealed, visible } = await historyToHide(h)
    await h.enableMcp()
    const c = await h.mcp((await h.newKey({ name: m.aKeyName(), canWrite: true, folders: [DIR.key] })).token)
    assert.deepEqual(leaked(c.client.getInstructions() ?? '', ''), [], 'the instructions')
    const etag = (await c.call('get_note', { path: PATH.visible })).data.etag as string

    /** `deny`: the call names a hidden note, and is told so (`agent_denied`, with this reason). */
    type Call = { args: Record<string, unknown>; ok?: boolean; error?: string; deny?: DenyReason }
    const AI = { error: 'agent_denied', deny: 'ai_false' as const }
    const OUT = { error: 'agent_denied', deny: 'outside_key_folders' as const }
    const NONE = { error: 'not_found' }
    const uidOf = (p: string) => /^uid: (.+)$/m.exec(readFileSync(join(h.notesDir, p), 'utf8'))?.[1]
    const secretUid = uidOf(PATH.secret)
    assert.ok(secretUid, 'the hidden note has a uid (its first write gave it one)')
    /** Every tool the key has, and how it's called. */
    const scenarios: Record<string, Call[]> = {
      search: [WORD.secret, WORD.other, WORD.broken, WORD.onlyHidden, WORD.revealed, WORD.moving, TAG.shared, `tag:${TAG.shared}`, `tag:${TAG.hidden}`, `path:"${DIR.outside}"`, `path:"${DIR.key}"`, NAME.dup, WORD.visible, NAME.visible, `${FIELD.key}:${FIELD.value}`, `has:${FIELD.key}`, `-has:${FIELD.key}`, `prop:${FIELD.key}=${FIELD.value}`, 'template:true', `has:template`]
        .map((q) => ({ args: { query: q }, ok: true })),
      get_note: [
        { args: { path: PATH.visible }, ok: true },
        { args: { path: PATH.secret }, ...AI }, { args: { path: PATH.broken }, ...AI }, { args: { path: PATH.onlyHidden }, ...AI },
        { args: { path: PATH.otherRenamed }, ...OUT }, { args: { path: NOWHERE }, ...NONE },
        // By its uid: denied, without its path.
        { args: { uid: secretUid }, ...AI }, { args: { uid: m.faker.string.ulid() }, ...NONE },
      ],
      list_folder: [
        { args: { folder: '' }, ok: true }, { args: { folder: '', recursive: true }, ok: true }, { args: { folder: DIR.key, recursive: true }, ok: true },
        { args: { folder: DIR.outside }, ...NONE }, { args: { folder: `${DIR.key}/${SUB.onlyHidden}` }, ...NONE },
      ],
      related: [{ args: { path: PATH.visible }, ok: true }, { args: { path: PATH.dupA }, ok: true }, { args: { path: PATH.secret }, ...AI }, { args: { path: PATH.otherRenamed }, ...OUT }],
      resolve_link: [
        // Links the note has, then names it asks about: to a hidden note, `no_access` with the reason, never its path.
        // (The heading of a note is no note's name; a Markdown link's spaces are written %20.)
        ...[`[[${NAME.secret}]]`, `[[${NAME.otherRenamed}]]`, `[[${NAME.dup}]]`, `${DIR.outside}/${NAME.dup}`, NAME.onlyHidden, NAME.template, `[[/${DIR.outside}/${NAME.template}]]`, OTHER_HEADING, `[x](../${PATH.moving.replace(/ /g, '%20')})`]
          .map((link) => ({ args: { from: PATH.visible, link }, ok: true })),
        { args: { from: PATH.secret, link: NAME.visible }, ...AI },
      ],
      changes_since: [
        { args: { path: PATH.visible, since: etag }, ok: true },
        { args: { path: PATH.visible, since: visible.at(-1) }, ok: true },
        { args: { path: PATH.revealed, since: revealed[0] }, ok: true },
        // A version from when the note was hidden: still doesn't exist.
        { args: { path: PATH.revealed, since: revealed.at(-1) }, ...NONE },
        { args: { path: PATH.secret, since: 'sha256:x' }, ...AI },
        { args: { path: PATH.secret, since: secret[0] }, ...AI },
      ],
      history: [
        { args: { path: PATH.visible }, ok: true },
        { args: { path: PATH.visible, version: visible[0], include_text: true }, ok: true },
        { args: { path: PATH.revealed }, ok: true },
        { args: { path: PATH.movedIn }, ok: true },
        { args: { path: PATH.revealed, version: revealed.at(-1) }, ...NONE },
        { args: { path: PATH.secret }, ...AI },
        { args: { path: PATH.otherRenamed }, ...OUT },
      ],
      // The daily note's path comes from vihko.yaml, not from the agent (a hidden one that exists: daily-agents.test.ts).
      daily_note: [{ args: {}, ok: true }, { args: { series: SERIES.outside }, ...NONE }],
      create_note: [
        { args: { path: PATH.secret, text: m.aSentence() }, ...AI },
        { args: { path: PATH.broken, text: m.aSentence() }, ...AI },
        { args: { path: PATH.outsideDup, text: m.aSentence() }, ...OUT },
        { args: { path: m.aNotePath(DIR.outside), text: m.aSentence() }, ...NONE },
        { args: { path: FROM_TEMPLATE, template: PATH.template }, ...OUT },
        { args: { path: FROM_TEMPLATE, template: PATH.secret }, ...AI },
        { args: { path: m.aNotePath(DIR.key), text: `# ${m.aHeading()}\n` }, ok: true },
      ],
      edit_note: [
        { args: { path: PATH.secret, operations: [{ op: 'append', text: m.aSentence() }] }, ...AI },
        { args: { path: PATH.broken, operations: [{ op: 'append', text: m.aSentence() }], dry_run: true }, ...AI },
        { args: { path: PATH.otherRenamed, operations: [{ op: 'append', text: m.aSentence() }] }, ...OUT },
        { args: { path: PATH.visible, operations: [{ op: 'append', text: m.aSentence() }], dry_run: true }, ok: true },
      ],
      move: [
        { args: { from: PATH.visible, to: m.aNotePath(DIR.key), dry_run: true }, ok: true },
        { args: { from: PATH.visible, to: m.aNotePath(DIR.outside) }, ...NONE },
        { args: { from: PATH.secret, to: m.aNotePath(DIR.key) }, ...AI },
        { args: { from: PATH.dupA, to: PATH.secret }, ...AI },
      ],
      delete: [{ args: { path: PATH.secret }, ...AI }, { args: { path: PATH.otherRenamed }, ...OUT }, { args: { path: PATH.broken }, ...AI }],
      attach_image: [
        { args: { note: PATH.secret, data: IMAGE }, ...AI },
        { args: { note: PATH.broken, data: IMAGE }, ...AI },
        { args: { note: PATH.otherRenamed, data: IMAGE }, ...OUT },
        { args: { note: m.aNotePath(DIR.outside), data: IMAGE }, ...NONE },
        { args: { note: NOWHERE, data: IMAGE }, ...NONE },
        { args: { note: PATH.visible, data: IMAGE }, ok: true },
      ],
      revert_change: [
        { args: { path: PATH.secret, version: secret[0] }, ...AI },
        { args: { path: PATH.revealed, version: revealed.at(-1) }, ...NONE },
        // The version where it became visible reads as its creation: nothing to revert.
        { args: { path: PATH.revealed, version: revealed[0], dry_run: true }, error: 'not_revertible' },
      ],
    }

    const hiddenBefore = HIDDEN.map((p) => readFileSync(join(h.notesDir, p), 'utf8'))
    const tools = (await c.client.listTools()).tools.map((t) => t.name).sort()
    assert.deepEqual(tools.filter((t) => !(t in scenarios)), [], 'every tool has its leak scenarios')
    const results: Record<string, { data: any; texts: string[] }[]> = {}
    for (const tool of tools) {
      for (const call of scenarios[tool]!) {
        const r = await c.call(tool, call.args)
        const asked = JSON.stringify(call.args)
        const where = `${tool} ${asked} → ${r.raw.slice(0, 500)}`
        assert.deepEqual(leaked(r.raw, asked), [], where)
        if (call.ok) assert.equal(r.error, false, where)
        if (call.error) assert.equal(r.data?.error, call.error, where)
        // A denial only where the call named a hidden note, with its reason and nothing else; never `forbidden`.
        if (r.data?.error === 'agent_denied') {
          assert.equal(r.data.reason, call.deny, where)
          assert.ok(HIDDEN.some((p) => asked.includes(p)) || asked.includes(secretUid!), `${where}: denied, but it named no hidden note`)
          assert.deepEqual(Object.keys(r.data).sort(), ['error', 'message', 'reason'], where)
          assert.equal(r.texts.length, 0, where)
        }
        assert.notEqual(r.data?.error, 'forbidden', where)
        ;(results[tool] ??= []).push({ data: r.data, texts: r.texts })
      }
    }
    assert.deepEqual(HIDDEN.map((p) => readFileSync(join(h.notesDir, p), 'utf8')), hiddenBefore, 'no write over a hidden note went through')
    assert.ok(!existsSync(join(h.notesDir, FROM_TEMPLATE)))

    // Search: only what it can read counts.
    const byTag = results.search![7]!.data.results.map((r: { path: string }) => r.path)
    assert.deepEqual(byTag, [PATH.visible])
    // Folders: nothing outside, no folder that only holds hidden notes.
    // At the top, only folders on the way to its folder (which ones is how the root lists spaces).
    const top = results.list_folder![0]!.data.entries as { kind: string; path: string }[]
    assert.ok(top.length > 0 && top.every((e) => e.kind === 'folder' && (e.path === DIR.key || DIR.key.startsWith(e.path + '/'))), JSON.stringify(top))
    const everything = results.list_folder![1]!.data.entries.map((e: { path: string }) => e.path)
    assert.ok(everything.includes(PATH.visible) && !everything.some((p: string) => p === PATH.secret || p.includes(SUB.onlyHidden)), everything.join())
    // Links in the note: to a hidden note, `no_access` without where; an ambiguous one keeps what it sees.
    const out = Object.fromEntries(results.get_note![0]!.data.links.outgoing.map((l: { link: string }) => [l.link, l]))
    const [toSecret, toRenamed, toDup] = [`[[${NAME.secret}]]`, `[[${NAME.otherRenamed}]]`, `[[${NAME.dup}]]`]
    assert.deepEqual([out[toSecret].status, out[toSecret].path, out[toRenamed].status, out[toRenamed].path], ['no_access', null, 'no_access', null])
    assert.deepEqual(out[toDup].candidates, [PATH.dupA, PATH.dupB].sort())
    assert.deepEqual(results.get_note![0]!.data.links.incoming, [])
    // resolve_link: a hidden note is `no_access` with its reason, never its path; a name nobody has is missing.
    const resolved = results.resolve_link!.slice(0, 9).map((r) => [r.data.status, r.data.reason ?? null, r.data.path])
    assert.deepEqual(resolved, [
      ['no_access', 'ai_false', null], ['no_access', 'outside_key_folders', null], ['ambiguous', null, null],
      ['no_access', 'outside_key_folders', null], ['no_access', 'ai_false', null], ['no_access', 'outside_key_folders', null], ['no_access', 'outside_key_folders', null],
      ['missing', null, null], ['missing', null, null],
    ])
    assert.deepEqual(results.resolve_link![2]!.data.candidates.map((x: { path: string }) => x.path), [PATH.dupA, PATH.dupB].sort())
    // A note hidden once: its history starts where the key could see it.
    assert.deepEqual(results.history![2]!.data.versions.map((v: { change: string }) => v.change), ['created'])
    assert.deepEqual(results.history![3]!.data.versions.map((v: { change: string; from?: string }) => [v.change, v.from]), [['moved', undefined]])
    // The move's preview: links in notes it can't see, without which or how many.
    assert.equal(results.move![0]!.data.hidden, true)
    // Today's note came out without the template the key can't read.
    assert.ok(!readFileSync(join(h.notesDir, PATH.daily), 'utf8').includes(WORD.template))
    await c.close()
  } finally { await h.close() }
})
