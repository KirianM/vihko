// Leak tests for the MCP server (m3 §3 and §5), over the same scenario as the
// HTTP API's (leaks.test.ts): a key limited to `proyectos/` that can write,
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
import { setup } from './_agents.ts'
import type { DenyReason } from '@thoth/server'
import { CONFIG, FILES, HIDDEN, historyToHide, leaked } from './_leaks.ts'

test('a key limited to proyectos/ sees nothing of what it can\'t read, through any MCP tool', async () => {
  // The workspace's guide for agents is a hidden note: it isn't served either.
  const h = await setup({ files: FILES, config: CONFIG + 'mcp:\n  instructions: proyectos/secreto\n' })
  try {
    const { secret, revealed, visible } = await historyToHide(h)
    await h.enableMcp()
    const c = await h.mcp((await h.newKey({ name: 'Leak test', canWrite: true, folders: ['proyectos'] })).token)
    assert.deepEqual(leaked(c.client.getInstructions() ?? '', ''), [], 'the instructions')
    const etag = (await c.call('get_note', { path: 'proyectos/visible.md' })).data.etag as string

    /** `deny`: the call names a hidden note, and is told so (`agent_denied`, with this reason). */
    type Call = { args: Record<string, unknown>; ok?: boolean; error?: string; deny?: DenyReason }
    const AI = { error: 'agent_denied', deny: 'ai_false' as const }
    const OUT = { error: 'agent_denied', deny: 'outside_key_folders' as const }
    const NONE = { error: 'not_found' }
    const uidOf = (p: string) => /^uid: (.+)$/m.exec(readFileSync(join(h.notesDir, p), 'utf8'))?.[1]
    const secretUid = uidOf('proyectos/secreto.md')
    assert.ok(secretUid, 'the hidden note has a uid (its first write gave it one)')
    /** Every tool the key has, and how it's called. */
    const scenarios: Record<string, Call[]> = {
      search: ['zafiro', 'esmeralda', 'rubí', 'escondida', 'ámbar', 'cuarzo', 'compartida', 'tag:compartida', 'tag:clave-oculta', 'path:fuera', 'path:proyectos', 'dup', 'turquesa', 'visible']
        .map((q) => ({ args: { query: q }, ok: true })),
      get_note: [
        { args: { path: 'proyectos/visible.md' }, ok: true },
        { args: { path: 'proyectos/secreto.md' }, ...AI }, { args: { path: 'proyectos/roto.md' }, ...AI }, { args: { path: 'proyectos/solo-oculta/escondida.md' }, ...AI },
        { args: { path: 'fuera/otra-nueva.md' }, ...OUT }, { args: { path: 'proyectos/nada.md' }, ...NONE },
        // By its uid: denied, without its path.
        { args: { uid: secretUid }, ...AI }, { args: { uid: 'NOSUCHUID' }, ...NONE },
      ],
      list_folder: [
        { args: { folder: '' }, ok: true }, { args: { folder: '', recursive: true }, ok: true }, { args: { folder: 'proyectos', recursive: true }, ok: true },
        { args: { folder: 'fuera' }, ...NONE }, { args: { folder: 'proyectos/solo-oculta' }, ...NONE },
      ],
      related: [{ args: { path: 'proyectos/visible.md' }, ok: true }, { args: { path: 'proyectos/a/dup.md' }, ok: true }, { args: { path: 'proyectos/secreto.md' }, ...AI }, { args: { path: 'fuera/otra-nueva.md' }, ...OUT }],
      resolve_link: [
        // Links the note has, then names it asks about: to a hidden note, `no_access` with the reason, never its path.
        ...['[[secreto]]', '[[otra-nueva]]', '[[dup]]', 'fuera/dup', 'escondida', 'plantilla', '[[/fuera/plantilla]]', 'Otra Esmeralda', '[x](../fuera/mudanza.md)']
          .map((link) => ({ args: { from: 'proyectos/visible.md', link }, ok: true })),
        { args: { from: 'proyectos/secreto.md', link: 'visible' }, ...AI },
      ],
      changes_since: [
        { args: { path: 'proyectos/visible.md', since: etag }, ok: true },
        { args: { path: 'proyectos/visible.md', since: visible.at(-1) }, ok: true },
        { args: { path: 'proyectos/revelada.md', since: revealed[0] }, ok: true },
        // A version from when the note was hidden: still doesn't exist.
        { args: { path: 'proyectos/revelada.md', since: revealed.at(-1) }, ...NONE },
        { args: { path: 'proyectos/secreto.md', since: 'sha256:x' }, ...AI },
        { args: { path: 'proyectos/secreto.md', since: secret[0] }, ...AI },
      ],
      history: [
        { args: { path: 'proyectos/visible.md' }, ok: true },
        { args: { path: 'proyectos/visible.md', version: visible[0], include_text: true }, ok: true },
        { args: { path: 'proyectos/revelada.md' }, ok: true },
        { args: { path: 'proyectos/mudanza.md' }, ok: true },
        { args: { path: 'proyectos/revelada.md', version: revealed.at(-1) }, ...NONE },
        { args: { path: 'proyectos/secreto.md' }, ...AI },
        { args: { path: 'fuera/otra-nueva.md' }, ...OUT },
      ],
      // The daily note's path comes from thoth.yaml, not from the agent.
      daily_note: [{ args: {}, ok: true }, { args: { series: 'ajena' }, ...NONE }],
      create_note: [
        { args: { path: 'proyectos/secreto.md', text: 'x' }, ...AI },
        { args: { path: 'proyectos/roto.md', text: 'x' }, ...AI },
        { args: { path: 'fuera/dup.md', text: 'x' }, ...OUT },
        { args: { path: 'fuera/nueva.md', text: 'x' }, ...NONE },
        { args: { path: 'proyectos/de-plantilla.md', template: 'fuera/plantilla.md' }, ...OUT },
        { args: { path: 'proyectos/de-plantilla.md', template: 'proyectos/secreto.md' }, ...AI },
        { args: { path: 'proyectos/nueva.md', text: '# Nueva\n' }, ok: true },
      ],
      edit_note: [
        { args: { path: 'proyectos/secreto.md', operations: [{ op: 'append', text: 'x' }] }, ...AI },
        { args: { path: 'proyectos/roto.md', operations: [{ op: 'append', text: 'x' }], dry_run: true }, ...AI },
        { args: { path: 'fuera/otra-nueva.md', operations: [{ op: 'append', text: 'x' }] }, ...OUT },
        { args: { path: 'proyectos/visible.md', operations: [{ op: 'append', text: 'x' }], dry_run: true }, ok: true },
      ],
      move: [
        { args: { from: 'proyectos/visible.md', to: 'proyectos/renombrada.md', dry_run: true }, ok: true },
        { args: { from: 'proyectos/visible.md', to: 'fuera/v.md' }, ...NONE },
        { args: { from: 'proyectos/secreto.md', to: 'proyectos/s2.md' }, ...AI },
        { args: { from: 'proyectos/a/dup.md', to: 'proyectos/secreto.md' }, ...AI },
      ],
      delete: [{ args: { path: 'proyectos/secreto.md' }, ...AI }, { args: { path: 'fuera/otra-nueva.md' }, ...OUT }, { args: { path: 'proyectos/roto.md' }, ...AI }],
      revert_change: [
        { args: { path: 'proyectos/secreto.md', version: secret[0] }, ...AI },
        { args: { path: 'proyectos/revelada.md', version: revealed.at(-1) }, ...NONE },
        // The version where it became visible reads as its creation: nothing to revert.
        { args: { path: 'proyectos/revelada.md', version: revealed[0], dry_run: true }, error: 'not_revertible' },
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
    assert.ok(!existsSync(join(h.notesDir, 'proyectos/de-plantilla.md')))

    // Search: only what it can read counts.
    const byTag = results.search![7]!.data.results.map((r: { path: string }) => r.path)
    assert.deepEqual(byTag, ['proyectos/visible.md'])
    // Folders: nothing outside, no folder that only holds hidden notes.
    assert.deepEqual(results.list_folder![0]!.data.entries, [{ kind: 'folder', path: 'proyectos' }])
    const everything = results.list_folder![1]!.data.entries.map((e: { path: string }) => e.path)
    assert.ok(everything.includes('proyectos/visible.md') && !everything.some((p: string) => p.includes('secreto') || p.includes('solo-oculta')), everything.join())
    // Links in the note: to a hidden note, `no_access` without where; an ambiguous one keeps what it sees.
    const out = Object.fromEntries(results.get_note![0]!.data.links.outgoing.map((l: { link: string }) => [l.link, l]))
    assert.deepEqual([out['[[secreto]]'].status, out['[[secreto]]'].path, out['[[otra-nueva]]'].status, out['[[otra-nueva]]'].path], ['no_access', null, 'no_access', null])
    assert.deepEqual(out['[[dup]]'].candidates, ['proyectos/a/dup.md', 'proyectos/b/dup.md'])
    assert.deepEqual(results.get_note![0]!.data.links.incoming, [])
    // resolve_link: a hidden note is `no_access` with its reason, never its path; a name nobody has is missing.
    const resolved = results.resolve_link!.slice(0, 9).map((r) => [r.data.status, r.data.reason ?? null, r.data.path])
    assert.deepEqual(resolved, [
      ['no_access', 'ai_false', null], ['no_access', 'outside_key_folders', null], ['ambiguous', null, null],
      ['no_access', 'outside_key_folders', null], ['no_access', 'ai_false', null], ['no_access', 'outside_key_folders', null], ['no_access', 'outside_key_folders', null],
      ['missing', null, null], ['missing', null, null],
    ])
    assert.deepEqual(results.resolve_link![2]!.data.candidates.map((x: { path: string }) => x.path), ['proyectos/a/dup.md', 'proyectos/b/dup.md'])
    // A note hidden once: its history starts where the key could see it.
    assert.deepEqual(results.history![2]!.data.versions.map((v: { change: string }) => v.change), ['created'])
    assert.deepEqual(results.history![3]!.data.versions.map((v: { change: string; from?: string }) => [v.change, v.from]), [['moved', undefined]])
    // The move's preview: links in notes it can't see, without which or how many.
    assert.equal(results.move![0]!.data.hidden, true)
    // Today's note came out without the template the key can't read.
    assert.doesNotMatch(readFileSync(join(h.notesDir, 'proyectos/diario/2026-09-26.md'), 'utf8'), /Ópalo/)
    await c.close()
  } finally { await h.close() }
})
