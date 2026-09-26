// Leak tests (m3 §3, D-014): a key limited to `proyectos/`, with a note
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
import { ROUTES } from '@thoth/server'
import { PNG, setup } from './_agents.ts'

const FILES: Record<string, string | Uint8Array> = {
  'proyectos/visible.md': '---\ntitle: Plan visible\ntags: [compartida]\n---\n# Plan visible\n\nEnlaza a [[secreto]], a [[otra]] y a [[dup]]. Palabra: turquesa.\n\n![foto](foto.png)\n',
  'proyectos/secreto.md': '---\nai: false\ntags: [compartida, clave-oculta]\n---\n# Título Zafiro\n\nZafiro escondido. Enlaza a [[visible]].\n\n![](oculta.png)\n',
  'proyectos/roto.md': '---\ntitle: [roto\n---\n# Rubí\n\nrubí junto a [[visible]]\n',
  'proyectos/a/dup.md': '# Dup A\n',
  'proyectos/b/dup.md': '# Dup B\n',
  'proyectos/solo-oculta/escondida.md': '---\nai: no\n---\n# Escondida\n',
  'proyectos/revelada.md': '---\nai: false\n---\n# Revelada\n\nÁmbar guardado.\n',
  'proyectos/foto.png': PNG,
  'proyectos/oculta.png': PNG,
  'fuera/otra.md': '---\ntags: [compartida, clave-oculta]\n---\n# Otra Esmeralda\n\nEsmeralda. Sabe de zafiro. Enlaza a [[visible]] y a [[secreto]].\n\n![](imagen.png)\n',
  'fuera/dup.md': '# Dup de fuera\n',
  'fuera/mudanza.md': '# Mudanza\n\nCuarzo de antes.\n',
  'fuera/plantilla.md': '# Plantilla\n\nÓpalo en la plantilla.\n',
  'fuera/imagen.png': PNG,
}

const CONFIG = `daily:
  agenda:
    folder: proyectos/diario
    template: fuera/plantilla
  ajena:
    folder: fuera/diario
`

/**
 * What must never reach the key: the hidden notes' paths, titles and words,
 * the tag only they carry, the folder outside and whatever is in it.
 */
const MARKERS = [
  'proyectos/secreto.md', 'Zafiro', 'zafiro', 'clave-oculta', 'oculta.png',
  'proyectos/roto.md', 'Rubí', 'rubí',
  'solo-oculta', 'Escondida',
  'Ámbar', 'ámbar',
  'fuera', 'Esmeralda', 'esmeralda', 'Dup de fuera', 'imagen.png', 'Cuarzo', 'Ópalo',
]

interface Call { method: string; path: string; body?: unknown; headers?: Record<string, string>; expect?: number }

test('a key limited to proyectos/ sees nothing of what it can\'t read, through any route', async () => {
  const h = await setup({ files: FILES, config: CONFIG })
  try {
    // History with something to hide: edits to hidden notes and outside,
    // a note that was hidden and isn't any more, one that came from outside.
    const put = async (path: string, edit: (t: string) => string) => {
      const cur = await h.noa('GET', h.url('/api/note', { path }))
      const r = await h.noa('PUT', h.url('/api/note', { path }), { text: edit(cur.body.text) }, { 'if-match': `"${cur.body.etag}"` })
      assert.equal(r.status, 200, `${path}: ${r.text}`)
      await h.settle()
    }
    await put('proyectos/secreto.md', (t) => t + 'Más zafiro.\n')
    await put('fuera/otra.md', (t) => t + 'Más esmeralda.\n')
    await put('proyectos/revelada.md', () => '---\nai: true\n---\n# Revelada\n\nYa es pública.\n')
    await put('proyectos/visible.md', (t) => t + 'Otra línea.\n')
    // Written outside, then brought in: what it said outside stays there.
    await put('fuera/mudanza.md', (t) => t.replace('Cuarzo de antes.', 'Texto de ahora.'))
    assert.equal((await h.noa('POST', '/api/note/move', { from: 'fuera/mudanza.md', to: 'proyectos/mudanza.md' })).status, 200)
    // A note outside, renamed: the system rewrites the visible note's link to it.
    assert.equal((await h.noa('POST', '/api/note/move', { from: 'fuera/otra.md', to: 'fuera/otra-nueva.md' })).status, 200)
    await h.settle()
    assert.match(readFileSync(join(h.notesDir, 'proyectos/visible.md'), 'utf8'), /\[\[otra-nueva\]\]/)
    const idsOf = async (path: string) => ((await h.noa('GET', h.url('/api/history/versions', { path }))).body.versions as { id: string }[]).map((v) => v.id)
    const secretIds = await idsOf('proyectos/secreto.md')
    const revealed = await idsOf('proyectos/revelada.md')
    const visibleIds = await idsOf('proyectos/visible.md')
    assert.ok(secretIds.length >= 2 && revealed.length >= 2 && visibleIds.length >= 2)

    await h.enableApi()
    const { token } = await h.newKey({ name: 'Leak test', canWrite: true, folders: ['proyectos'] })
    const key = h.withKey(token)
    const q = (path: string, params: Record<string, string>) => h.url(path, params)
    const note = (path: string) => q('/api/note', { path })

    /** Every route a key may call, and how it's walked. */
    const scenarios: Record<string, Call[]> = {
      'GET /api/note': ['proyectos/visible.md', 'proyectos/secreto.md', 'proyectos/roto.md', 'proyectos/solo-oculta/escondida.md', 'fuera/otra.md', 'proyectos/nada.md']
        .map((p) => ({ method: 'GET', path: note(p), expect: p === 'proyectos/visible.md' ? 200 : 404 })),
      'GET /api/note/links': ['proyectos/visible.md', 'proyectos/secreto.md', 'proyectos/a/dup.md', 'fuera/otra.md']
        .map((p) => ({ method: 'GET', path: q('/api/note/links', { path: p }), expect: p.startsWith('proyectos/') && p !== 'proyectos/secreto.md' ? 200 : 404 })),
      'GET /api/note/headings': [{ method: 'GET', path: q('/api/note/headings', { path: 'proyectos/visible.md' }), expect: 200 }, { method: 'GET', path: q('/api/note/headings', { path: 'proyectos/secreto.md' }), expect: 404 }],
      'GET /api/note/comments': [{ method: 'GET', path: q('/api/note/comments', { path: 'proyectos/visible.md' }), expect: 200 }, { method: 'GET', path: q('/api/note/comments', { path: 'proyectos/roto.md' }), expect: 404 }],
      'GET /api/search': ['zafiro', 'esmeralda', 'rubí', 'escondida', 'ámbar', 'cuarzo', 'compartida', 'tag:compartida', 'tag:clave-oculta', 'path:fuera', 'path:proyectos', 'dup', 'turquesa', 'visible']
        .map((s) => ({ method: 'GET', path: q('/api/search', { q: s }), expect: 200 })),
      'GET /api/tree': [{ method: 'GET', path: '/api/tree', expect: 200 }],
      'GET /api/tags': [{ method: 'GET', path: '/api/tags', expect: 200 }],
      'GET /api/daily': [{ method: 'GET', path: '/api/daily', expect: 200 }, { method: 'GET', path: q('/api/daily', { series: 'ajena' }), expect: 404 }],
      'GET /api/file': [['proyectos/foto.png', 200], ['proyectos/oculta.png', 404], ['fuera/imagen.png', 404], ['proyectos/nada.png', 404]]
        .map(([p, s]) => ({ method: 'GET', path: q('/api/file', { path: p as string }), expect: s as number })),
      'GET /api/history/status': [{ method: 'GET', path: '/api/history/status', expect: 200 }],
      'GET /api/history/versions': [['proyectos/visible.md', 200], ['proyectos/secreto.md', 404], ['proyectos/revelada.md', 200], ['proyectos/mudanza.md', 200], ['fuera/otra.md', 404], ['proyectos/roto.md', 404]]
        .map(([p, s]) => ({ method: 'GET', path: q('/api/history/versions', { path: p as string }), expect: s as number })),
      'GET /api/history/version': [
        { method: 'GET', path: q('/api/history/version', { path: 'proyectos/visible.md', id: visibleIds[0]! }), expect: 200 },
        { method: 'GET', path: q('/api/history/version', { path: 'proyectos/secreto.md', id: secretIds[0]! }), expect: 404 },
        { method: 'GET', path: q('/api/history/version', { path: 'proyectos/revelada.md', id: revealed.at(-1)! }), expect: 404 },
        { method: 'GET', path: q('/api/history/version', { path: 'proyectos/revelada.md', id: revealed[0]! }), expect: 200 },
      ],
      'GET /api/history/diff': [
        { method: 'GET', path: q('/api/history/diff', { path: 'proyectos/revelada.md', id: revealed[0]! }), expect: 200 },
        { method: 'GET', path: q('/api/history/diff', { path: 'proyectos/revelada.md', id: revealed[0]!, against: revealed.at(-1)! }), expect: 404 },
        { method: 'GET', path: q('/api/history/diff', { path: 'proyectos/revelada.md', id: revealed.at(-1)! }), expect: 404 },
        { method: 'GET', path: q('/api/history/diff', { path: 'proyectos/secreto.md', id: secretIds[0]! }), expect: 404 },
        { method: 'GET', path: q('/api/history/diff', { path: 'proyectos/visible.md', id: visibleIds[0]!, against: 'current' }), expect: 200 },
      ],
      'GET /api/history/changes': [{ method: 'GET', path: q('/api/history/changes', { limit: '50' }), expect: 200 }],
      'GET /api/history/resolved': [{ method: 'GET', path: q('/api/history/resolved', { path: 'proyectos/visible.md' }), expect: 200 }, { method: 'GET', path: q('/api/history/resolved', { path: 'proyectos/secreto.md' }), expect: 404 }],

      'POST /api/note': [
        { method: 'POST', path: '/api/note', body: { path: 'proyectos/secreto.md', text: 'x' }, expect: 404 },
        { method: 'POST', path: '/api/note', body: { path: 'proyectos/roto.md', text: 'x' }, expect: 404 },
        { method: 'POST', path: '/api/note', body: { path: 'fuera/nueva.md', text: 'x' }, expect: 404 },
        { method: 'POST', path: '/api/note', body: { path: 'proyectos/de-plantilla.md', template: 'fuera/plantilla.md' }, expect: 404 },
        { method: 'POST', path: '/api/note', body: { path: 'proyectos/de-plantilla.md', template: 'proyectos/secreto.md' }, expect: 404 },
        { method: 'POST', path: '/api/note', body: { path: 'proyectos/nueva.md', text: '# Nueva\n' }, expect: 201 },
      ],
      'PUT /api/note': [
        { method: 'PUT', path: note('proyectos/secreto.md'), body: { text: 'x' }, headers: { 'if-match': '"sha256:x"' }, expect: 404 },
        { method: 'PUT', path: note('proyectos/secreto.md'), body: { text: 'x' }, headers: { 'if-none-match': '*' }, expect: 404 },
        { method: 'PUT', path: note('fuera/otra.md'), body: { text: 'x' }, headers: { 'if-none-match': '*' }, expect: 404 },
        { method: 'PUT', path: note('proyectos/creada.md'), body: { text: '# Creada\n' }, headers: { 'if-none-match': '*' }, expect: 201 },
      ],
      'POST /api/note/edit': [
        { method: 'POST', path: '/api/note/edit', body: { path: 'proyectos/secreto.md', ops: [{ op: 'append', text: 'x' }] }, expect: 404 },
        { method: 'POST', path: '/api/note/edit', body: { path: 'proyectos/roto.md', ops: [{ op: 'append', text: 'x' }], dryRun: true }, expect: 404 },
        { method: 'POST', path: '/api/note/edit', body: { path: 'fuera/otra.md', ops: [{ op: 'append', text: 'x' }] }, expect: 404 },
      ],
      'POST /api/note/move': [
        { method: 'POST', path: '/api/note/move', body: { from: 'proyectos/visible.md', to: 'proyectos/renombrada.md', dryRun: true }, expect: 200 },
        { method: 'POST', path: '/api/note/move', body: { from: 'proyectos/visible.md', to: 'fuera/v.md' }, expect: 404 },
        { method: 'POST', path: '/api/note/move', body: { from: 'proyectos/secreto.md', to: 'proyectos/s2.md' }, expect: 404 },
        { method: 'POST', path: '/api/note/move', body: { from: 'proyectos/a/dup.md', to: 'proyectos/secreto.md' }, expect: 404 },
      ],
      'DELETE /api/note': [
        { method: 'DELETE', path: note('proyectos/secreto.md'), expect: 404 },
        { method: 'DELETE', path: note('fuera/otra-nueva.md'), expect: 404 },
      ],
      'POST /api/daily': [
        { method: 'POST', path: '/api/daily', body: { series: 'ajena' }, expect: 404 },
        { method: 'POST', path: '/api/daily', body: {}, expect: 201 },
      ],
      'POST /api/attachments': [
        { method: 'POST', path: q('/api/attachments', { note: 'proyectos/secreto.md' }), body: PNG, expect: 404 },
        { method: 'POST', path: q('/api/attachments', { note: 'fuera/otra.md' }), body: PNG, expect: 404 },
      ],
      'POST /api/history/restore': [
        { method: 'POST', path: '/api/history/restore', body: { path: 'proyectos/secreto.md', id: secretIds.at(-1) }, expect: 404 },
        { method: 'POST', path: '/api/history/restore', body: { path: 'proyectos/revelada.md', id: revealed.at(-1) }, expect: 404 },
      ],
      'POST /api/history/revert': [
        { method: 'POST', path: '/api/history/revert', body: { path: 'proyectos/secreto.md', id: secretIds[0] }, expect: 404 },
      ],
    }

    const keyRoutes = Object.entries(ROUTES).filter(([, c]) => c === 'read' || c === 'write').map(([r]) => r)
    assert.deepEqual(keyRoutes.filter((r) => !(r in scenarios)), [], 'every route a key may call has its leak scenarios')

    const responses: Record<string, { status: number; text: string }[]> = {}
    for (const route of keyRoutes) {
      for (const call of scenarios[route]!) {
        const r = await key(call.method, call.path, call.body, call.headers)
        const asked = decodeURIComponent(call.path) + JSON.stringify(call.body ?? '')
        const shown = r.text + JSON.stringify([...r.headers.entries()])
        const leaked = MARKERS.filter((m) => shown.includes(m) && !asked.includes(m))
        assert.deepEqual(leaked, [], `${route} ${call.path} ${JSON.stringify(call.body ?? '')} → ${r.status} ${r.text.slice(0, 400)}`)
        if (call.expect !== undefined) assert.equal(r.status, call.expect, `${route} ${call.path} ${JSON.stringify(call.body ?? '')}: ${r.text.slice(0, 300)}`)
        // What can't be seen is `not_found`, never `forbidden`.
        if (r.status === 404) assert.equal(r.body?.error, 'not_found', r.text)
        assert.notEqual(r.status, 403, `${route}: never forbidden for a note`)
        ;(responses[route] ??= []).push({ status: r.status, text: r.text })
      }
    }

    // Counts: only what the key can read counts.
    const tags = JSON.parse(responses['GET /api/tags']![0]!.text).tags as { tag: string; count: number; total: number }[]
    assert.deepEqual(tags.find((t) => t.tag === 'compartida'), { tag: 'compartida', count: 1, total: 1 })
    const adminTags = (await h.noa('GET', '/api/tags')).body.tags as { tag: string; count: number }[]
    assert.equal(adminTags.find((t) => t.tag === 'compartida')!.count, 3, 'the UI still sees everything')
    const byTag = (await key('GET', q('/api/search', { q: 'tag:compartida' }))).body.results
    assert.deepEqual(byTag.map((r: { path: string }) => r.path), ['proyectos/visible.md'])

    // Links: to an invisible note, just text; an ambiguous one keeps what the key sees.
    const links = JSON.parse(responses['GET /api/note/links']![0]!.text)
    const out = Object.fromEntries(links.outgoing.map((l: { raw: string }) => [l.raw, l]))
    assert.deepEqual([out['[[secreto]]'].status, out['[[secreto]]'].dst_path, out['[[otra-nueva]]'].status], [null, null, null])
    assert.deepEqual([out['[[dup]]'].status, out['[[dup]]'].candidates], ['ambiguous', ['proyectos/a/dup.md', 'proyectos/b/dup.md']])
    assert.deepEqual(links.backlinks, [], 'the notes that link to it are all hidden or outside')

    // The tree: no hidden note, no folder that only holds hidden notes, nothing outside.
    const tree = JSON.parse(responses['GET /api/tree']![0]!.text)
    assert.deepEqual(tree.notes.map((n: { path: string }) => n.path).sort(), ['proyectos/a/dup.md', 'proyectos/b/dup.md', 'proyectos/mudanza.md', 'proyectos/revelada.md', 'proyectos/visible.md'])
    assert.deepEqual(tree.folders, ['proyectos', 'proyectos/a', 'proyectos/b'])

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
    const daily = readFileSync(join(h.notesDir, 'proyectos/diario/2026-09-26.md'), 'utf8')
    assert.doesNotMatch(daily, /Ópalo/)

    // The link rewritten by a move it can't see: the version is there, the paths of that move aren't.
    const visibleVersions = JSON.parse(responses['GET /api/history/versions']![0]!.text).versions
    const relinked = visibleVersions.find((v: { reason: { code?: string } | null }) => v.reason?.code === 'note_moved')
    assert.deepEqual([relinked.reason.from, relinked.reason.to, relinked.reason.by.name], [null, null, 'noa'])

    // «Recent changes»: only files it can see, and only their authors.
    const changes = JSON.parse(responses['GET /api/history/changes']![0]!.text)
    const files = changes.changes.flatMap((c: { files: { path: string }[] }) => c.files.map((f) => f.path))
    assert.ok(files.includes('proyectos/visible.md'))
    assert.ok(files.every((f: string) => f.startsWith('proyectos/') && !['proyectos/secreto.md', 'proyectos/roto.md'].includes(f)), files.join(', '))
  } finally { await h.close() }
})

test('the filter in the query and the one for a path agree, note by note', async () => {
  const h = await setup({ files: FILES, config: CONFIG })
  try {
    const { token } = await h.newKey({ name: 'x', folders: ['proyectos'] })
    const principal = h.keys.authenticate(token, 'api')!
    const access = h.services.policy.for(principal)
    const w = access.notesWhere('n')
    const all = (h.services.scoped(h.services.policy.for({ kind: 'user', user: h.users.noa })).tree().notes).map((n) => n.path)
    const listed = new Set((h.services.scoped(access).tree().notes).map((n) => n.path))
    const viaSql = new Set((h.index.prepare(`select path from notes n where ${w.sql}`).all(...w.params) as { path: string }[]).map((r) => r.path))
    for (const p of all) {
      assert.equal(listed.has(p), access.canRead(p), p)
      assert.equal(viaSql.has(p), access.canRead(p), p)
    }
    assert.deepEqual([...listed].sort(), ['proyectos/a/dup.md', 'proyectos/b/dup.md', 'proyectos/visible.md'])
    assert.ok(all.length > listed.size)
  } finally { await h.close() }
})
