// Leak tests for the MCP server (m3 §3 and §5), over the same scenario as the
// HTTP API's (leaks.test.ts): a key limited to `proyectos/` that can write,
// with hidden notes inside and notes outside that mention them. Every tool
// the key gets is called, several ways each, and no result or error (nor the
// server's instructions) may carry a path, a title, a fragment, a tag or a
// count of what the key can't see, unless the call itself named it. A tool
// with no scenario here fails the test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setup } from './_agents.ts'
import { CONFIG, FILES, historyToHide, leaked } from './_leaks.ts'

test('a key limited to proyectos/ sees nothing of what it can\'t read, through any MCP tool', async () => {
  // The workspace's guide for agents is a hidden note: it isn't served either.
  const h = await setup({ files: FILES, config: CONFIG + 'mcp:\n  instructions: proyectos/secreto\n' })
  try {
    const { secret, revealed, visible } = await historyToHide(h)
    await h.enableMcp()
    const c = await h.mcp((await h.newKey({ name: 'Leak test', canWrite: true, folders: ['proyectos'] })).token)
    assert.deepEqual(leaked(c.client.getInstructions() ?? '', ''), [], 'the instructions')
    const etag = (await c.call('get_note', { path: 'proyectos/visible.md' })).data.etag as string

    type Call = { args: Record<string, unknown>; ok?: boolean; error?: string }
    const paths = (list: [string, boolean][], extra: Record<string, unknown> = {}): Call[] => list.map(([p, ok]) => ({ args: { path: p, ...extra }, ...(ok ? { ok } : { error: 'not_found' }) }))
    /** Every tool the key has, and how it's called. */
    const scenarios: Record<string, Call[]> = {
      search: ['zafiro', 'esmeralda', 'rubí', 'escondida', 'ámbar', 'cuarzo', 'compartida', 'tag:compartida', 'tag:clave-oculta', 'path:fuera', 'path:proyectos', 'dup', 'turquesa', 'visible']
        .map((q) => ({ args: { query: q }, ok: true })),
      get_note: paths([['proyectos/visible.md', true], ['proyectos/secreto.md', false], ['proyectos/roto.md', false], ['proyectos/solo-oculta/escondida.md', false], ['fuera/otra-nueva.md', false], ['proyectos/nada.md', false]]),
      list_folder: [
        { args: { folder: '' }, ok: true }, { args: { folder: '', recursive: true }, ok: true }, { args: { folder: 'proyectos', recursive: true }, ok: true },
        { args: { folder: 'fuera' }, error: 'not_found' }, { args: { folder: 'proyectos/solo-oculta' }, error: 'not_found' },
      ],
      related: paths([['proyectos/visible.md', true], ['proyectos/a/dup.md', true], ['proyectos/secreto.md', false], ['fuera/otra-nueva.md', false]]),
      resolve_link: [
        // Links the note has: as get_note gives them.
        ...['[[secreto]]', '[[otra-nueva]]', '[[dup]]'].map((link) => ({ args: { from: 'proyectos/visible.md', link }, ok: true })),
        // Anything else: only over what it can see.
        ...['fuera/dup', 'escondida', 'plantilla', '[[/fuera/plantilla]]', 'Otra Esmeralda', '[x](../fuera/mudanza.md)'].map((link) => ({ args: { from: 'proyectos/visible.md', link }, ok: true })),
        { args: { from: 'proyectos/secreto.md', link: 'visible' }, error: 'not_found' },
      ],
      changes_since: [
        { args: { path: 'proyectos/visible.md', since: etag }, ok: true },
        { args: { path: 'proyectos/visible.md', since: visible.at(-1) }, ok: true },
        { args: { path: 'proyectos/revelada.md', since: revealed[0] }, ok: true },
        { args: { path: 'proyectos/revelada.md', since: revealed.at(-1) }, error: 'not_found' },
        { args: { path: 'proyectos/secreto.md', since: 'sha256:x' }, error: 'not_found' },
        { args: { path: 'proyectos/secreto.md', since: secret[0] }, error: 'not_found' },
      ],
      history: [
        { args: { path: 'proyectos/visible.md' }, ok: true },
        { args: { path: 'proyectos/visible.md', version: visible[0], include_text: true }, ok: true },
        { args: { path: 'proyectos/revelada.md' }, ok: true },
        { args: { path: 'proyectos/mudanza.md' }, ok: true },
        { args: { path: 'proyectos/revelada.md', version: revealed.at(-1) }, error: 'not_found' },
        { args: { path: 'proyectos/secreto.md' }, error: 'not_found' },
        { args: { path: 'fuera/otra-nueva.md' }, error: 'not_found' },
      ],
      daily_note: [{ args: {}, ok: true }, { args: { series: 'ajena' }, error: 'not_found' }],
      create_note: [
        { args: { path: 'proyectos/secreto.md', text: 'x' }, error: 'not_found' },
        { args: { path: 'proyectos/roto.md', text: 'x' }, error: 'not_found' },
        { args: { path: 'fuera/nueva.md', text: 'x' }, error: 'not_found' },
        { args: { path: 'proyectos/de-plantilla.md', template: 'fuera/plantilla.md' }, error: 'not_found' },
        { args: { path: 'proyectos/de-plantilla.md', template: 'proyectos/secreto.md' }, error: 'not_found' },
        { args: { path: 'proyectos/nueva.md', text: '# Nueva\n' }, ok: true },
      ],
      edit_note: [
        { args: { path: 'proyectos/secreto.md', operations: [{ op: 'append', text: 'x' }] }, error: 'not_found' },
        { args: { path: 'proyectos/roto.md', operations: [{ op: 'append', text: 'x' }], dry_run: true }, error: 'not_found' },
        { args: { path: 'fuera/otra-nueva.md', operations: [{ op: 'append', text: 'x' }] }, error: 'not_found' },
        { args: { path: 'proyectos/visible.md', operations: [{ op: 'append', text: 'x' }], dry_run: true }, ok: true },
      ],
      move: [
        { args: { from: 'proyectos/visible.md', to: 'proyectos/renombrada.md', dry_run: true }, ok: true },
        { args: { from: 'proyectos/visible.md', to: 'fuera/v.md' }, error: 'not_found' },
        { args: { from: 'proyectos/secreto.md', to: 'proyectos/s2.md' }, error: 'not_found' },
        { args: { from: 'proyectos/a/dup.md', to: 'proyectos/secreto.md' }, error: 'not_found' },
      ],
      delete: paths([['proyectos/secreto.md', false], ['fuera/otra-nueva.md', false], ['proyectos/roto.md', false]]),
      revert_change: [
        { args: { path: 'proyectos/secreto.md', version: secret[0] }, error: 'not_found' },
        { args: { path: 'proyectos/revelada.md', version: revealed.at(-1) }, error: 'not_found' },
        // The version where it became visible reads as its creation: nothing to revert.
        { args: { path: 'proyectos/revelada.md', version: revealed[0], dry_run: true }, error: 'not_revertible' },
      ],
    }

    const tools = (await c.client.listTools()).tools.map((t) => t.name).sort()
    assert.deepEqual(tools.filter((t) => !(t in scenarios)), [], 'every tool has its leak scenarios')
    const results: Record<string, { data: any; texts: string[] }[]> = {}
    for (const tool of tools) {
      for (const call of scenarios[tool]!) {
        const r = await c.call(tool, call.args)
        const where = `${tool} ${JSON.stringify(call.args)} → ${r.raw.slice(0, 500)}`
        assert.deepEqual(leaked(r.raw, JSON.stringify(call.args)), [], where)
        if (call.ok) assert.equal(r.error, false, where)
        if (call.error) assert.equal(r.data?.error, call.error, where)
        // What it can't see is `not_found`, never `forbidden`.
        assert.notEqual(r.data?.error, 'forbidden', where)
        ;(results[tool] ??= []).push({ data: r.data, texts: r.texts })
      }
    }

    // Search: only what it can read counts.
    const byTag = results.search![7]!.data.results.map((r: { path: string }) => r.path)
    assert.deepEqual(byTag, ['proyectos/visible.md'])
    // Folders: nothing outside, no folder that only holds hidden notes.
    assert.deepEqual(results.list_folder![0]!.data.entries, [{ kind: 'folder', path: 'proyectos' }])
    const everything = results.list_folder![1]!.data.entries.map((e: { path: string }) => e.path)
    assert.ok(everything.includes('proyectos/visible.md') && !everything.some((p: string) => p.includes('secreto') || p.includes('solo-oculta')), everything.join())
    // Links in the note: to a hidden note, just text; an ambiguous one keeps what it sees.
    const out = Object.fromEntries(results.get_note![0]!.data.links.outgoing.map((l: { link: string }) => [l.link, l]))
    assert.deepEqual([out['[[secreto]]'].status, out['[[secreto]]'].path, out['[[otra-nueva]]'].status], [null, null, null])
    assert.deepEqual(out['[[dup]]'].candidates, ['proyectos/a/dup.md', 'proyectos/b/dup.md'])
    assert.deepEqual(results.get_note![0]!.data.links.incoming, [])
    // resolve_link over arbitrary names can't tell a hidden note from none.
    const probes = results.resolve_link!.slice(3, 9).map((r) => r.data.status)
    assert.deepEqual(probes, ['missing', 'missing', 'missing', 'missing', 'missing', 'missing'])
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
