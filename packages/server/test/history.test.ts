import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Actor } from '@thoth/server'
import { flakyGit, setup, sleep, who } from './_history.ts'

const NOTE = 'hogar/Proxy.md'

test('the history starts with the whole folder as one system version', async () => {
  const h = await setup()
  try {
    const { changes } = await h.changes()
    assert.equal(changes.length, 1)
    const [first] = changes
    assert.deepEqual(first.reason, { code: 'history_enabled' })
    assert.equal(who(first), 'system')
    const paths = first.files.map((f: any) => f.path)
    for (const p of [NOTE, 'adjuntos/imagen.png', 'adjuntos/tablero.canvas', 'proyectos/thoth/Plan.sync-conflict-20260924-120000-ABCDEFG.md']) assert.ok(paths.includes(p), p)
    for (const p of paths) assert.ok(!p.split('/').some((s: string) => s.startsWith('.')) && !p.endsWith('~'), `ignored file in the history: ${p}`)
    assert.ok(first.files.every((f: any) => f.change === 'created'))
    assert.deepEqual(await h.noa('GET', '/api/history/status').then((r) => r.body), { mode: 'managed', available: true, error: null })
  } finally { await h.close() }
})

test('writes in a row by the same user are one version; another actor closes it first, with the text from before', async () => {
  const h = await setup()
  try {
    await h.put(NOTE, (t) => t + '\nuno\n')
    await h.put(NOTE, (t) => t + 'dos\n')
    const open = await h.versions(NOTE)
    assert.deepEqual(open.pending.authors.map((a: any) => a.name), ['noa'], 'the edits are still an open version')
    const agent: Actor = { kind: 'agent', id: 'key-1', onBehalfOf: h.ids.ana }
    await h.notes.edit(NOTE, (t) => t + 'del agente\n', { actor: agent })
    await h.settle()
    const { versions } = await h.versions(NOTE)
    assert.deepEqual(versions.map(who), ['agent', 'user:noa', 'system'])
    assert.deepEqual(versions[0].authors[0], { kind: 'agent', id: 'key-1', name: 'key-1', onBehalfOf: { id: h.ids.ana, name: 'ana' }, key: 'agent:key-1' })
    // «The version right before the agent» is what the user left.
    const before = await h.noa('GET', `/api/history/version?path=${h.q(NOTE)}&id=${versions[1].id}`)
    assert.ok(before.body.text.endsWith('uno\ndos\n') && !before.body.text.includes('del agente'))
    assert.equal(versions[1].added, 2 + 3, 'two words, and the uid (key, colon, value) the first write added')
  } finally { await h.close() }
})

test('an open version closes after the quiet time, or at the maximum time while writes go on', async () => {
  const h = await setup({ quietMs: 200, maxOpenMs: 900 })
  try {
    await h.put(NOTE, (t) => t + '\nuno\n')
    await sleep(500)
    await h.history.recorder.settle()
    assert.equal((await h.versions(NOTE)).versions.length, 2, 'closed after 200 ms without changes')
    const t0 = Date.now()
    while (Date.now() - t0 < 1500) { await h.put(NOTE, (t) => t + 'x\n'); await sleep(100) }
    await h.history.recorder.settle()
    const n = (await h.versions(NOTE)).versions.length
    assert.ok(n >= 3, `a new version at most every 900 ms while writes go on (${n} versions)`)
  } finally { await h.close() }
})

test('an external change closes what was pending and is its own version; thoth\'s own writes never look external', async () => {
  const h = await setup()
  try {
    await h.put(NOTE, (t) => t + '\nde noa\n')
    // The indexer sees thoth's own write, as the watcher and the rescan would.
    h.indexer.indexPaths([NOTE], { detectMoves: true })
    h.indexer.scan()
    const file = join(h.notesDir, NOTE)
    writeFileSync(file, readFileSync(file, 'utf8') + 'de fuera\n')
    h.indexer.indexPaths([NOTE], { detectMoves: true })
    await h.settle()
    const { versions } = await h.versions(NOTE)
    assert.deepEqual(versions.map(who), ['external', 'user:noa', 'system'])
    assert.equal(versions[0].foundAtStartup, false)
    const mine = await h.noa('GET', `/api/history/version?path=${h.q(NOTE)}&id=${versions[1].id}`)
    assert.ok(mine.body.text.endsWith('de noa\n'), 'the pending version keeps its own text')
    // A cold write that reads a content the history doesn't know records it first as external.
    writeFileSync(file, readFileSync(file, 'utf8') + 'otra vez de fuera\n')
    await h.put(NOTE, (t) => t + 'y noa\n')
    await h.settle()
    assert.deepEqual((await h.versions(NOTE)).versions.slice(0, 3).map(who), ['user:noa', 'external', 'external'])
  } finally { await h.close() }
})

test('a rename is a move by whoever did it, and its link rewrites one system commit at once; the history follows moves in a row', async () => {
  const h = await setup()
  try {
    const r = await h.noa('POST', '/api/note/move', { from: NOTE, to: 'hogar/GW.md' })
    assert.equal(r.status, 200)
    await h.history.recorder.settle() // no closeAll: system operations don't wait
    const { changes } = await h.changes()
    assert.equal(changes[0].reason.code, 'note_moved')
    assert.deepEqual(changes[0].reason.by, { kind: 'user', id: h.ids.noa, name: 'noa', key: `user:${h.ids.noa}` })
    assert.equal(who(changes[0]), 'system')
    assert.deepEqual(changes[0].files.map((f: any) => [f.path, f.change]), [['hogar/enlaces.md', 'modified']])
    assert.deepEqual(changes[1].files.map((f: any) => [f.path, f.change, f.from]), [['hogar/GW.md', 'moved', NOTE]])
    assert.equal(who(changes[1]), 'user:noa')
    await h.noa('POST', '/api/note/move', { from: 'hogar/GW.md', to: 'infra/Hipervisor.md' })
    await h.put('infra/Hipervisor.md', (t) => t + '\ndespués\n')
    await h.settle()
    const { versions } = await h.versions('infra/Hipervisor.md')
    assert.deepEqual(versions.map((v: any) => [v.change, v.path, v.from ?? null]), [
      ['modified', 'infra/Hipervisor.md', null],
      ['moved', 'infra/Hipervisor.md', 'hogar/GW.md'],
      ['moved', 'hogar/GW.md', NOTE],
      ['created', NOTE, null],
    ])
    // A version of the note before its moves, by the note's current path.
    const old = await h.noa('GET', `/api/history/version?path=${h.q('infra/Hipervisor.md')}&id=${versions[3].id}`)
    assert.equal(old.body.path, NOTE)
    assert.ok(old.body.text.startsWith('---'))
  } finally { await h.close() }
})

test('a folder moved: the history of its notes follows it', async () => {
  const h = await setup()
  try {
    const r = await h.noa('POST', '/api/folder/move', { from: 'hogar', to: 'infra/hogar' })
    assert.equal(r.status, 200)
    await h.settle()
    const { versions } = await h.versions('infra/hogar/Proxy.md')
    assert.deepEqual(versions.map((v: any) => [v.change, v.path, v.from ?? null]).slice(0, 2), [
      ['moved', 'infra/hogar/Proxy.md', NOTE],
      ['created', NOTE, null],
    ])
    const { changes } = await h.changes()
    const move = changes.find((c: any) => c.files.some((f: any) => f.change === 'moved'))
    assert.ok(move.files.some((f: any) => f.path === 'infra/hogar/Firewall.md' && f.from === 'hogar/Firewall.md'))
  } finally { await h.close() }
})

test('a note moved outside thoth is a move by external', async () => {
  const h = await setup()
  try {
    // The name as it is on disk (NFC or NFD, whatever the copy kept).
    const from = 'recetas/' + readdirSync(join(h.notesDir, 'recetas')).find((f) => f.normalize('NFC') === 'índice.md')!
    renameSync(join(h.notesDir, from), join(h.notesDir, 'recetas/Índice general.md'))
    h.indexer.indexPaths([from, 'recetas/Índice general.md'], { detectMoves: true })
    await h.settle()
    const { versions } = await h.versions('recetas/Índice general.md')
    assert.equal(versions[0].change, 'moved')
    assert.equal(who(versions[0]), 'external')
    assert.equal(versions[0].from.normalize('NFC'), 'recetas/índice.md')
  } finally { await h.close() }
})

test('files that aren\'t notes come from the watcher; a folder of them renamed with another tool is a move', async () => {
  const h = await setup()
  try {
    writeFileSync(join(h.notesDir, 'adjuntos/nueva.png'), 'PNGDATA')
    await h.history.recorder.observePaths(['adjuntos/nueva.png'])
    renameSync(join(h.notesDir, 'adjuntos'), join(h.notesDir, 'media'))
    await h.history.recorder.observePaths(['adjuntos', 'media'])
    await h.settle()
    const { changes } = await h.changes()
    assert.deepEqual(changes[1].files.map((f: any) => [f.path, f.change]), [['adjuntos/nueva.png', 'created']])
    assert.equal(who(changes[1]), 'external')
    assert.deepEqual(changes[0].files.map((f: any) => [f.path, f.change, f.from]).sort(), [
      ['media/imagen.png', 'moved', 'adjuntos/imagen.png'],
      ['media/nueva.png', 'moved', 'adjuntos/nueva.png'],
      ['media/tablero.canvas', 'moved', 'adjuntos/tablero.canvas'],
    ])
    // Seen again (a late event): nothing new.
    await h.history.recorder.observePaths(['media/imagen.png', 'adjuntos/imagen.png'])
    await h.settle()
    assert.equal((await h.changes()).changes.length, changes.length)
  } finally { await h.close() }
})

test('files over the size limit stay out of the history, with an alert', async () => {
  const big = Buffer.alloc(3000, 1)
  const h = await setup({ config: 'history:\n  maxFileSize: 0.002\n', files: { 'adjuntos/grande.bin': big } })
  try {
    const { changes } = await h.changes()
    const paths = changes[0].files.map((f: any) => f.path)
    assert.ok(!paths.includes('adjuntos/grande.bin'))
    assert.ok(paths.includes('adjuntos/imagen.png'))
    const alerts = (await h.noa('GET', '/api/alerts')).body.alerts
    const a = alerts.find((x: any) => x.code === 'history_files_too_large')
    assert.deepEqual(a, { code: 'history_files_too_large', paths: ['adjuntos/grande.bin'], limitMb: 0, actions: [] })
    // A note written over the limit by thoth doesn't enter either.
    await h.put(NOTE, (t) => t + 'x'.repeat(3000))
    await h.settle()
    assert.equal((await h.versions(NOTE)).versions.length, 1)
    // A larger limit in thoth.yaml: the list follows it at once.
    writeFileSync(join(h.notesDir, 'thoth.yaml'), 'history:\n  maxFileSize: 1\n')
    h.workspace.reload()
    await h.history.configure()
    assert.ok(!(await h.noa('GET', '/api/alerts')).body.alerts.some((x: any) => x.code === 'history_files_too_large'))
  } finally { await h.close() }
})

test('restoring a version brings back the images it linked that are gone, never over another file', async () => {
  const text = '# Con imágenes\n\n![](a.png) ![](b.png) ![](c.png) ![](https://example.com/x.png)\n'
  const h = await setup({ files: { 'fotos/nota.md': text, 'fotos/a.png': 'AAAA', 'fotos/b.png': 'BBBB' } })
  try {
    const first = (await h.versions('fotos/nota.md')).versions[0]
    await h.put('fotos/nota.md', () => '# Sin imágenes\n')
    unlinkSync(join(h.notesDir, 'fotos/a.png'))
    writeFileSync(join(h.notesDir, 'fotos/b.png'), 'otra imagen')
    await h.history.recorder.observePaths(['fotos/a.png', 'fotos/b.png'])
    await h.settle()
    const r = await h.noa('POST', '/api/history/restore', { path: 'fotos/nota.md', id: first.id })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.images, { restored: ['fotos/a.png'], missing: [{ path: 'fotos/b.png', reason: 'exists' }, { path: 'fotos/c.png', reason: 'not_in_history' }] })
    assert.equal(readFileSync(join(h.notesDir, 'fotos/a.png'), 'utf8'), 'AAAA')
    assert.equal(readFileSync(join(h.notesDir, 'fotos/b.png'), 'utf8'), 'otra imagen', 'never overwritten')
    assert.ok(readFileSync(join(h.notesDir, 'fotos/nota.md'), 'utf8').includes('![](a.png)'))
    assert.equal(r.headers.get('etag'), `"${r.body.etag}"`)
    await h.settle()
    const { changes } = await h.changes()
    assert.deepEqual(changes[0].reason, { code: 'restored', id: first.id, at: first.at })
    assert.deepEqual(changes[0].files.map((f: any) => [f.path, f.change]).sort(), [['fotos/a.png', 'created'], ['fotos/nota.md', 'restored']])
    assert.equal(who(changes[0]), 'user:noa')
    const { versions } = await h.versions('fotos/nota.md')
    assert.equal(versions[0].change, 'restored')
    // A stale If-Match is refused, and nothing is written.
    const stale = await h.noa('POST', '/api/history/restore', { path: 'fotos/nota.md', id: first.id, ifMatch: 'sha256:0' })
    assert.equal(stale.status, 412)
  } finally { await h.close() }
})

test('a deleted note shows its deletion and comes back by restoring an earlier version', async () => {
  const h = await setup()
  try {
    const del = await h.noa('DELETE', `/api/note?path=${h.q('Plan.md')}`)
    assert.equal(del.status, 200)
    await h.settle()
    const { versions } = await h.versions('Plan.md')
    assert.deepEqual(versions.map((v: any) => [v.change, who(v)]), [['deleted', 'user:noa'], ['created', 'system']])
    const gone = await h.noa('GET', `/api/history/version?path=${h.q('Plan.md')}&id=${versions[0].id}`)
    assert.equal(gone.body.text, null)
    assert.equal((await h.noa('POST', '/api/history/restore', { path: 'Plan.md', id: versions[0].id })).status, 400, 'a deletion has no text to restore')
    const r = await h.noa('POST', '/api/history/restore', { path: 'Plan.md', id: versions[1].id })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(existsSync(join(h.notesDir, 'Plan.md')))
    await h.settle()
    assert.equal((await h.versions('Plan.md')).versions[0].change, 'restored')
    // From the trash is a version too.
    const del2 = await h.noa('DELETE', `/api/note?path=${h.q('tags.md')}`)
    await h.noa('POST', `/api/trash/${del2.body.id}/restore`, {})
    await h.settle()
    const tags = (await h.versions('tags.md')).versions
    assert.deepEqual(tags.slice(0, 2).map((v: any) => [v.change, v.reason?.code ?? null]), [['restored', 'trash_restored'], ['deleted', null]])
  } finally { await h.close() }
})

test('diffs by words against the previous version, the current text or another version', async () => {
  const h = await setup()
  try {
    await h.put('tags.md', () => 'uno dos tres\n')
    await h.settle()
    await h.put('tags.md', () => 'uno cuatro tres\n')
    await h.settle()
    const { versions } = await h.versions('tags.md')
    const d = await h.noa('GET', `/api/history/diff?path=tags.md&id=${versions[0].id}`)
    // thoth gave the note a uid in its first write: the frontmatter is the same in both.
    const fm = d.body.ops[0][1] as string
    assert.match(fm, /^---\nuid: \w+\n---\nuno $/)
    assert.deepEqual(d.body.ops, [[0, fm], [-1, 'dos'], [1, 'cuatro'], [0, ' tres\n']])
    assert.equal(d.body.added, 1)
    assert.equal(d.body.removed, 1)
    await h.put('tags.md', (t) => t.replace(/uno .*\n$/, 'cinco\n'))
    const cur = await h.noa('GET', `/api/history/diff?path=tags.md&id=${versions[1].id}&against=current`)
    assert.deepEqual(cur.body.ops.slice(1), [[-1, 'cinco'], [1, 'uno dos tres'], [0, '\n']], 'what the version has that the current text doesn\'t is inserted')
    const other = await h.noa('GET', `/api/history/diff?path=tags.md&id=${versions[0].id}&against=${versions[1].id}`)
    assert.deepEqual(other.body.ops, d.body.ops)
    assert.equal((await h.noa('GET', `/api/history/diff?path=tags.md&id=${'0'.repeat(40)}`)).status, 404)
  } finally { await h.close() }
})

test('versions come in pages', async () => {
  const h = await setup()
  try {
    for (let i = 0; i < 5; i++) { await h.put('tags.md', (t) => t + `línea ${i}\n`); await h.settle() }
    const a = await h.versions('tags.md', '&limit=2')
    assert.equal(a.versions.length, 2)
    assert.ok(a.next)
    const b = await h.versions('tags.md', `&limit=2&cursor=${a.next}`)
    const c = await h.versions('tags.md', `&limit=2&cursor=${b.next}`)
    assert.equal(c.next, null)
    const all = [...a.versions, ...b.versions, ...c.versions].map((v: any) => v.id)
    assert.equal(all.length, 6)
    assert.equal(new Set(all).size, 6)
    assert.equal((await h.noa('GET', '/api/history/versions?path=tags.md&cursor=nonsense')).status, 400)
  } finally { await h.close() }
})

test('«Recent changes» filters file by file with the permission check, and by author', async () => {
  const canRead = (_u: unknown, path: string) => !path.startsWith('privado/')
  const h = await setup({ canRead })
  try {
    await h.put('privado/sin-ia.md', (t) => t + 'secreto\n')
    await h.settle()
    await h.put('tags.md', (t) => t + 'visible\n', 'ana')
    await h.settle()
    const { changes, authors } = await h.changes()
    assert.equal(changes.length, 2, 'the change with only a private file is left out')
    assert.ok(changes.every((c: any) => c.files.every((f: any) => !f.path.startsWith('privado/'))))
    assert.deepEqual(authors.map((a: any) => a.key).sort(), ['system', `user:${h.ids.ana}`, `user:${h.ids.noa}`].sort())
    assert.equal((await h.noa('GET', `/api/history/versions?path=${h.q('privado/sin-ia.md')}`)).status, 404)
    const byAna = await h.changes(`&author=user:${h.ids.ana}`)
    assert.deepEqual(byAna.changes.map((c: any) => who(c)), ['user:ana'])
    assert.deepEqual((await h.changes('&author=system')).changes.map((c: any) => c.reason.code), ['history_enabled'])
    const page = await h.noa('GET', '/api/history/changes?limit=1')
    assert.equal(page.body.changes.length, 1)
    const rest = await h.noa('GET', `/api/history/changes?limit=5&cursor=${page.body.next}`)
    assert.deepEqual(rest.body.changes.map((c: any) => c.id), changes.slice(1).map((c: any) => c.id))
    assert.equal(rest.body.next, null)
  } finally { await h.close() }
})

test('a failing git never blocks a write: it is reported, and the history catches up when git is back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'thoth-git-'))
  const { git, flag } = flakyGit(dir)
  const h = await setup({ git })
  try {
    writeFileSync(flag, '')
    await h.put(NOTE, (t) => t + '\ncon git roto\n')
    h.history.recorder.closeAll()
    await sleep(200)
    const status = (await h.noa('GET', '/api/history/status')).body
    assert.equal(status.available, false)
    assert.equal(status.error.code, 'git_failed')
    const alert = (await h.noa('GET', '/api/alerts')).body.alerts.find((a: any) => a.code === 'history_unavailable')
    assert.match(alert.detail, /simulated failure/)
    assert.ok(readFileSync(join(h.notesDir, NOTE), 'utf8').includes('con git roto'), 'the note was written')
    rmSync(flag)
    await sleep(300)
    await h.history.recorder.settle()
    assert.equal((await h.noa('GET', '/api/history/status')).body.available, true)
    assert.deepEqual((await h.versions(NOTE)).versions.map(who), ['user:noa', 'system'])
    assert.ok(!(await h.noa('GET', '/api/alerts')).body.alerts.some((a: any) => a.code === 'history_unavailable'))
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('thoth.yaml turns the history off and on: nothing recorded meanwhile is attributed', async () => {
  const h = await setup()
  try {
    writeFileSync(join(h.notesDir, 'thoth.yaml'), 'history:\n  mode: off\n')
    h.workspace.reload()
    await h.history.configure()
    assert.deepEqual((await h.noa('GET', '/api/history/status')).body, { mode: 'off', available: false, error: null })
    assert.equal((await h.noa('GET', `/api/history/versions?path=${h.q(NOTE)}`)).body.error, 'history_off')
    await h.put(NOTE, (t) => t + '\ncon el historial apagado\n')
    writeFileSync(join(h.notesDir, 'thoth.yaml'), 'history:\n  mode: managed\n')
    h.workspace.reload()
    await h.history.configure()
    await h.settle()
    const { changes } = await h.changes()
    assert.deepEqual(changes[0].reason, { code: 'history_resumed' })
    assert.equal(who(changes[0]), 'system')
    assert.deepEqual(changes[0].files.map((f: any) => f.path).sort(), [NOTE, 'thoth.yaml'])
    assert.equal(changes.length, 2)
  } finally { await h.close() }
})

test('unmanaged mode without a repository says so', async () => {
  const h = await setup({ config: 'history:\n  mode: unmanaged\n' })
  try {
    const s = (await h.noa('GET', '/api/history/status')).body
    assert.equal(s.mode, 'unmanaged')
    assert.equal(s.available, false)
    // The test vault lives in a temporary folder with no git above it.
    assert.equal(s.error.code, 'history_no_repository')
    assert.ok((await h.noa('GET', '/api/alerts')).body.alerts.some((a: any) => a.code === 'history_no_repository'))
    assert.equal((await h.noa('GET', `/api/history/versions?path=${h.q(NOTE)}`)).body.error, 'history_unmanaged_unavailable')
  } finally { await h.close() }
})

test('changes made while thoth was stopped are external, found at startup; what the journal left pending keeps its authors', async () => {
  const h = await setup()
  await h.settle()
  // Something pending when thoth stops (closing doesn't commit it: the journal keeps it).
  await h.put(NOTE, (t) => t + '\nantes de parar\n')
  await h.close()
  const file = join(h.notesDir, NOTE)
  writeFileSync(file, readFileSync(file, 'utf8') + 'con thoth parado\n')
  writeFileSync(join(h.notesDir, 'tags.md'), 'reescrita fuera\n')
  rmSync(join(h.notesDir, 'codigo.md'))
  const again = await setup({ dir: h.dir })
  try {
    await again.settle()
    const { versions } = await again.versions(NOTE)
    assert.deepEqual(versions.map((v: any) => [who(v), v.foundAtStartup]), [['external', true], ['user:noa', false], ['system', false]])
    const pending = await again.noa('GET', `/api/history/version?path=${again.q(NOTE)}&id=${versions[1].id}`)
    assert.ok(pending.body.text.endsWith('antes de parar\n'), 'the pending version keeps its text from the journal')
    const { changes } = await again.changes()
    const startup = changes.find((c: any) => c.foundAtStartup)
    assert.deepEqual(startup.files.map((f: any) => `${f.path} ${f.change}`).sort(), ['codigo.md deleted', `${NOTE} modified`, 'tags.md modified'])
  } finally { await again.close() }
})

test('a file whose mtime is older than its last version is dated at that version, not before', async () => {
  const h = await setup()
  try {
    await h.settle()
    const file = join(h.notesDir, 'tags.md')
    writeFileSync(file, 'cambiada fuera\n')
    const old = new Date('2020-01-01T00:00:00Z')
    utimesSync(file, old, old)
    h.indexer.indexPaths(['tags.md'], { detectMoves: true })
    await h.settle()
    const { versions } = await h.versions('tags.md')
    assert.equal(who(versions[0]), 'external')
    assert.ok(Date.parse(versions[0].at) >= Date.parse(versions[1].at), 'bounded by the previous version')
    assert.ok(statSync(file).mtimeMs < Date.parse(versions[1].at))
  } finally { await h.close() }
})
