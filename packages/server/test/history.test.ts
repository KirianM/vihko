import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Actor } from '@vihko/server'
import { flakyGit, setup, sleep, who } from './_history.ts'
import { yamlKey } from './_permissions.ts'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** A user as `who()` shows them. */
const user = (p: { username: string }) => `user:${p.username}`

// The setup copies testdata/vault: its notes (this one, tags.md, codigo.md,
// Plan.md, hogar/, recetas/, adjuntos/, privado/…) are the fixed vault's. What
// the tests write, and the notes and folders they make, are the mother's.
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
    for (const p of [NOTE, 'adjuntos/imagen.png', 'adjuntos/tablero.canvas', 'proyectos/vihko/Plan.sync-conflict-20260924-120000-ABCDEFG.md']) assert.ok(paths.includes(p), p)
    for (const p of paths) assert.ok(!p.split('/').some((s: string) => s.startsWith('.')) && !p.endsWith('~'), `ignored file in the history: ${p}`)
    assert.ok(first.files.every((f: any) => f.change === 'created'))
    assert.deepEqual(await h.admin('GET', '/api/history/status').then((r) => r.body), { mode: 'managed', available: true, error: null })
  } finally { await h.close() }
})

test('writes in a row by the same user are one version; another actor closes it first, with the text from before', async () => {
  // A quiet time no pause under load reaches: only the agent's write (and `settle`) closes what is open.
  const h = await setup({ quietMs: 600_000 })
  try {
    const [one, two, byAgent] = [m.aUniqueWord(), m.aUniqueWord(), m.aSentence()]
    await h.put(NOTE, (t) => t + `\n${one}\n`)
    await h.put(NOTE, (t) => t + `${two}\n`)
    const open = await h.versions(NOTE)
    assert.deepEqual(open.pending.authors.map((a: any) => a.name), [h.users.admin.username], 'the edits are still an open version')
    const keyId = m.anId()
    const agent: Actor = { kind: 'agent', id: keyId, onBehalfOf: h.ids.member }
    await h.notes.edit(NOTE, (t) => t + `${byAgent}\n`, { actor: agent })
    await h.settle()
    const { versions } = await h.versions(NOTE)
    assert.deepEqual(versions.map(who), ['agent', user(h.users.admin), 'system'])
    assert.deepEqual(versions[0].authors[0], { kind: 'agent', id: keyId, name: keyId, onBehalfOf: { id: h.ids.member, name: h.users.member.username }, key: `agent:${keyId}` })
    // «The version right before the agent» is what the user left.
    const before = await h.admin('GET', `/api/history/version?path=${h.q(NOTE)}&id=${versions[1].id}`)
    assert.ok(before.body.text.endsWith(`${one}\n${two}\n`) && !before.body.text.includes(byAgent))
    assert.equal(versions[1].added, 2 + 3, 'two words, and the uid (key, colon, value) the first write added')
  } finally { await h.close() }
})

test('an open version closes after the quiet time, or at the maximum time while writes go on', async () => {
  const h = await setup({ quietMs: 200, maxOpenMs: 900 })
  try {
    await h.put(NOTE, (t) => t + `\n${m.aWord()}\n`)
    await sleep(500)
    await h.history.recorder.settle()
    assert.equal((await h.versions(NOTE)).versions.length, 2, 'closed after 200 ms without changes')
    const t0 = Date.now()
    while (Date.now() - t0 < 1500) { await h.put(NOTE, (t) => t + `${m.aWord()}\n`); await sleep(100) }
    await h.history.recorder.settle()
    const n = (await h.versions(NOTE)).versions.length
    assert.ok(n >= 3, `a new version at most every 900 ms while writes go on (${n} versions)`)
  } finally { await h.close() }
})

test('an external change closes what was pending; external changes in a row are one version, which a write of vihko\'s closes first; vihko\'s own writes never look external', async () => {
  // A long quiet time: the external version must still be open when it's looked at.
  const h = await setup({ quietMs: 10_000 })
  const [admin1, outside1, outside2, admin2, outside3, admin3] = [m.aSentence(), m.aSentence(), m.aSentence(), m.aSentence(), m.aSentence(), m.aSentence()]
  try {
    await h.put(NOTE, (t) => t + `\n${admin1}\n`)
    // The indexer sees vihko's own write, as the watcher and the rescan would.
    h.indexer.indexPaths([NOTE], { detectMoves: true })
    h.indexer.scan()
    const file = join(h.notesDir, NOTE)
    writeFileSync(file, readFileSync(file, 'utf8') + `${outside1}\n`)
    h.indexer.indexPaths([NOTE], { detectMoves: true })
    // An editor that saves on every pause: the next save joins the same version.
    writeFileSync(file, readFileSync(file, 'utf8') + `${outside2}\n`)
    h.indexer.indexPaths([NOTE], { detectMoves: true })
    await h.history.recorder.settle()
    const open = await h.versions(NOTE)
    assert.deepEqual(open.versions.map(who), [user(h.users.admin), 'system'], 'what the admin had pending closed before the external change')
    assert.deepEqual(open.pending.authors.map((a: any) => a.kind), ['external'])
    const mine = await h.admin('GET', `/api/history/version?path=${h.q(NOTE)}&id=${open.versions[0].id}`)
    assert.ok(mine.body.text.endsWith(`${admin1}\n`), 'the pending version keeps its own text')
    // vihko writing the file closes the external version first, with both saves in it.
    await h.put(NOTE, (t) => t + `${admin2}\n`)
    await h.settle()
    let { versions } = await h.versions(NOTE)
    assert.deepEqual(versions.map(who), [user(h.users.admin), 'external', user(h.users.admin), 'system'])
    assert.equal(versions[1].foundAtStartup, false)
    const ext = await h.admin('GET', `/api/history/version?path=${h.q(NOTE)}&id=${versions[1].id}`)
    assert.ok(ext.body.text.endsWith(`${outside1}\n${outside2}\n`), 'the external version is the text right before vihko\'s write')
    // A cold write that reads a content the history doesn't know records it first as external.
    writeFileSync(file, readFileSync(file, 'utf8') + `${outside3}\n`)
    await h.put(NOTE, (t) => t + `${admin3}\n`)
    await h.settle()
    versions = (await h.versions(NOTE)).versions
    assert.deepEqual(versions.slice(0, 3).map(who), [user(h.users.admin), 'external', user(h.users.admin)])
    const read = await h.admin('GET', `/api/history/version?path=${h.q(NOTE)}&id=${versions[1].id}`)
    assert.ok(read.body.text.endsWith(`${outside3}\n`) && !read.body.text.includes(admin3))
  } finally { await h.close() }
})

test('external versions close after the quiet time; several files closing together are one commit, dated at their last change', async () => {
  const h = await setup()
  try {
    // Whole seconds after the history's first commit (the floor of these dates) and before now.
    const first = Math.ceil(Date.now() / 1000)
    while (Date.now() < (first + 1) * 1000 + 50) await sleep(50)
    const tags = join(h.notesDir, 'tags.md')
    const code = join(h.notesDir, 'codigo.md')
    const [save1, save2] = [m.aSentence(), m.aSentence()]
    writeFileSync(tags, `${save1}\n`)
    utimesSync(tags, first, first)
    writeFileSync(code, `${m.aSentence()}\n`)
    utimesSync(code, first, first)
    h.indexer.indexPaths(['tags.md', 'codigo.md'], { detectMoves: true })
    writeFileSync(tags, `${save2}\n`)
    utimesSync(tags, first + 1, first + 1)
    h.indexer.indexPaths(['tags.md'], { detectMoves: true })
    // No closeAll: the quiet time (150 ms here) closes them.
    await sleep(400)
    await h.history.recorder.settle()
    const { changes } = await h.changes()
    assert.equal(who(changes[0]), 'external')
    assert.deepEqual(changes[0].files.map((f: any) => f.path).sort(), ['codigo.md', 'tags.md'], 'one commit for both files')
    assert.equal(changes[0].at, new Date((first + 1) * 1000).toISOString(), 'the last change\'s mtime')
    const { versions } = await h.versions('tags.md')
    assert.deepEqual(versions.map(who), ['external', 'system'], 'both saves are one version')
    const v = await h.admin('GET', `/api/history/version?path=tags.md&id=${versions[0].id}`)
    assert.equal(v.body.text, `${save2}\n`)
  } finally { await h.close() }
})

test('a rename is a move by whoever did it, and its link rewrites one system commit at once; the history follows moves in a row', async () => {
  const h = await setup()
  const renamed = m.aNotePath('hogar')
  const moved = m.aNotePath(m.aFolder())
  try {
    const r = await h.admin('POST', '/api/note/move', { from: NOTE, to: renamed })
    assert.equal(r.status, 200)
    await h.history.recorder.settle() // no closeAll: system operations don't wait
    const { changes } = await h.changes()
    assert.equal(changes[0].reason.code, 'note_moved')
    assert.deepEqual(changes[0].reason.by, { kind: 'user', id: h.ids.admin, name: h.users.admin.username, key: `user:${h.ids.admin}` })
    assert.equal(who(changes[0]), 'system')
    assert.deepEqual(changes[0].files.map((f: any) => [f.path, f.change]), [['hogar/enlaces.md', 'modified']])
    assert.deepEqual(changes[1].files.map((f: any) => [f.path, f.change, f.from]), [[renamed, 'moved', NOTE]])
    assert.equal(who(changes[1]), user(h.users.admin))
    await h.admin('POST', '/api/note/move', { from: renamed, to: moved })
    await h.put(moved, (t) => t + `\n${m.aSentence()}\n`)
    await h.settle()
    const { versions } = await h.versions(moved)
    assert.deepEqual(versions.map((v: any) => [v.change, v.path, v.from ?? null]), [
      ['modified', moved, null],
      ['moved', moved, renamed],
      ['moved', renamed, NOTE],
      ['created', NOTE, null],
    ])
    // A version of the note before its moves, by the note's current path.
    const old = await h.admin('GET', `/api/history/version?path=${h.q(moved)}&id=${versions[3].id}`)
    assert.equal(old.body.path, NOTE)
    assert.ok(old.body.text.startsWith('---'))
  } finally { await h.close() }
})

test('a folder moved: the history of its notes follows it', async () => {
  const h = await setup()
  try {
    const to = `${m.aFolder()}/hogar`
    const r = await h.admin('POST', '/api/folder/move', { from: 'hogar', to })
    assert.equal(r.status, 200)
    await h.settle()
    const { versions } = await h.versions(`${to}/Proxy.md`)
    assert.deepEqual(versions.map((v: any) => [v.change, v.path, v.from ?? null]).slice(0, 2), [
      ['moved', `${to}/Proxy.md`, NOTE],
      ['created', NOTE, null],
    ])
    const { changes } = await h.changes()
    const move = changes.find((c: any) => c.files.some((f: any) => f.change === 'moved'))
    assert.ok(move.files.some((f: any) => f.path === `${to}/Firewall.md` && f.from === 'hogar/Firewall.md'))
  } finally { await h.close() }
})

test('a note moved outside vihko is a move by external', async () => {
  const h = await setup()
  try {
    // The name as it is on disk (NFC or NFD, whatever the copy kept).
    const from = 'recetas/' + readdirSync(join(h.notesDir, 'recetas')).find((f) => f.normalize('NFC') === 'índice.md')!
    const to = m.aNotePath('recetas')
    renameSync(join(h.notesDir, from), join(h.notesDir, to))
    h.indexer.indexPaths([from, to], { detectMoves: true })
    await h.settle()
    const { versions } = await h.versions(to)
    assert.equal(versions[0].change, 'moved')
    assert.equal(who(versions[0]), 'external')
    assert.equal(versions[0].from.normalize('NFC'), 'recetas/índice.md')
  } finally { await h.close() }
})

test('files that aren\'t notes come from the watcher; a folder of them renamed with another tool is a move', async () => {
  const h = await setup()
  try {
    const image = `${m.aTitle()}.png`
    const media = m.aFolder()
    writeFileSync(join(h.notesDir, 'adjuntos', image), m.aSecret())
    await h.history.recorder.observePaths([`adjuntos/${image}`])
    renameSync(join(h.notesDir, 'adjuntos'), join(h.notesDir, media))
    await h.history.recorder.observePaths(['adjuntos', media])
    await h.settle()
    const { changes } = await h.changes()
    assert.deepEqual(changes[1].files.map((f: any) => [f.path, f.change]), [[`adjuntos/${image}`, 'created']])
    assert.equal(who(changes[1]), 'external')
    assert.deepEqual(changes[0].files.map((f: any) => [f.path, f.change, f.from]).sort(), [
      [`${media}/imagen.png`, 'moved', 'adjuntos/imagen.png'],
      [`${media}/${image}`, 'moved', `adjuntos/${image}`],
      [`${media}/tablero.canvas`, 'moved', 'adjuntos/tablero.canvas'],
    ].sort())
    // Seen again (a late event): nothing new.
    await h.history.recorder.observePaths([`${media}/imagen.png`, 'adjuntos/imagen.png'])
    await h.settle()
    assert.equal((await h.changes()).changes.length, changes.length)
  } finally { await h.close() }
})

test('files over the size limit stay out of the history, with an alert', async () => {
  const big = Buffer.alloc(3000, 1)
  const bigPath = `adjuntos/${m.aTitle()}.bin`
  const h = await setup({ config: 'history:\n  maxFileSize: 0.002\n', files: { [bigPath]: big } })
  try {
    const { changes } = await h.changes()
    const paths = changes[0].files.map((f: any) => f.path)
    assert.ok(!paths.includes(bigPath))
    assert.ok(paths.includes('adjuntos/imagen.png'))
    const alerts = (await h.admin('GET', '/api/alerts')).body.alerts
    const a = alerts.find((x: any) => x.code === 'history_files_too_large')
    assert.deepEqual(a, { code: 'history_files_too_large', paths: [bigPath], limitMb: 0, actions: [] })
    // A note written over the limit by vihko doesn't enter either.
    await h.put(NOTE, (t) => t + 'x'.repeat(3000))
    await h.settle()
    assert.equal((await h.versions(NOTE)).versions.length, 1)
    // A larger limit in vihko.yaml: the list follows it at once.
    writeFileSync(join(h.notesDir, 'vihko.yaml'), 'history:\n  maxFileSize: 1\n')
    h.workspace.reload()
    await h.history.configure()
    assert.ok(!(await h.admin('GET', '/api/alerts')).body.alerts.some((x: any) => x.code === 'history_files_too_large'))
  } finally { await h.close() }
})

test('history.exclude keeps files out of the history without hiding them; a move across it leaves or enters the history', async () => {
  const library = m.aFolder()
  const drafts = m.aFolder()
  const BOOK = m.aNotePath(library)
  const PDF = `adjuntos/${m.aTitle()}.pdf`
  const DRAFT = m.aNotePath(drafts)
  const back = m.aNotePath('hogar')
  const config = `history:\n  exclude:\n    - ${JSON.stringify(`${library}/**`)}\n    - "**/*.pdf"\n`
  const h = await setup({ config, files: { [BOOK]: `# ${m.aHeading()}\n`, [PDF]: m.aSecret(), [DRAFT]: `# ${m.aHeading()}\n` } })
  try {
    const first = (await h.changes()).changes.at(-1)
    const paths = first.files.map((f: any) => f.path)
    assert.ok(paths.includes(DRAFT) && paths.includes(NOTE))
    assert.ok(!paths.includes(BOOK) && !paths.includes(PDF), 'excluded files never enter')
    // Not hidden from vihko: read, edited and indexed as ever.
    assert.equal((await h.admin('GET', `/api/note?path=${h.q(BOOK)}`)).status, 200)
    await h.put(BOOK, (t) => t + `${m.aSentence()}\n`)
    writeFileSync(join(h.notesDir, PDF), m.aSecret())
    await h.history.recorder.observePaths([PDF])
    writeFileSync(join(h.notesDir, BOOK), `# ${m.aHeading()}\n${m.aSentence()}\n`)
    h.indexer.indexPaths([BOOK], { detectMoves: true })
    await h.settle()
    assert.equal((await h.changes()).changes.length, 1, 'nothing recorded for excluded files')
    const excluded = await h.versions(BOOK)
    assert.deepEqual([excluded.versions.length, excluded.pending, excluded.excluded], [0, null, true])
    assert.equal((await h.versions(NOTE)).excluded, false)

    // A note moved into an excluded folder leaves the history; moved out, it enters with its content.
    assert.equal((await h.admin('POST', '/api/note/move', { from: NOTE, to: `${library}/Proxy.md` })).status, 200)
    await h.settle()
    let { changes } = await h.changes()
    const left = changes.find((c: any) => c.files.some((f: any) => f.path === NOTE))
    assert.deepEqual(left.files.map((f: any) => [f.path, f.change]), [[NOTE, 'deleted']])
    assert.equal(who(left), user(h.users.admin))
    assert.equal((await h.admin('POST', '/api/note/move', { from: `${library}/Proxy.md`, to: back })).status, 200)
    await h.settle()
    changes = (await h.changes()).changes
    const entered = changes.find((c: any) => c.files.some((f: any) => f.path === back))
    assert.deepEqual(entered.files.map((f: any) => [f.path, f.change]), [[back, 'created']])
    assert.equal(who(entered), user(h.users.admin))
    const v = (await h.versions(back)).versions[0]
    assert.ok((await h.admin('GET', `/api/history/version?path=${h.q(back)}&id=${v.id}`)).body.text.includes('Proxy'))
    // A folder moved into an excluded one: its files leave the history, by whoever moved it.
    const inFolder = [...(await h.history.recorder.git.run(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'recetas'])).stdout.toString().trim().split('\n')]
    assert.equal((await h.admin('POST', '/api/folder/move', { from: 'recetas', to: `${library}/recetas` })).status, 200)
    await h.settle()
    changes = (await h.changes()).changes
    const folder = changes.find((c: any) => c.files.some((f: any) => f.path.startsWith('recetas/')))
    assert.deepEqual(folder.files.map((f: any) => [f.path, f.change]).sort(), inFolder.map((p) => [p, 'deleted']).sort())
    assert.equal(who(folder), user(h.users.admin))

    // A new pattern applies at once; what the history holds stays.
    writeFileSync(join(h.notesDir, 'vihko.yaml'), config + `    - ${JSON.stringify(drafts)}\n`)
    h.workspace.reload()
    await h.history.configure()
    const before = (await h.versions(DRAFT)).versions.length
    await h.put(DRAFT, (t) => t + `${m.aSentence()}\n`)
    await h.settle()
    const secret = await h.versions(DRAFT)
    assert.equal(secret.versions.length, before, 'no new version, the old ones stay')
    assert.equal(secret.excluded, true)

    // An invalid pattern is a configuration error: the last valid list stays in force.
    writeFileSync(join(h.notesDir, 'vihko.yaml'), `history:\n  exclude:\n    - ${JSON.stringify(`/${drafts}`)}\n`)
    h.workspace.reload()
    await h.history.configure()
    assert.deepEqual(h.workspace.status.errors.map((e) => [e.code, e.at, e.detail]), [['invalid_pattern', 'history.exclude.0', `/${drafts}`]])
    assert.equal((await h.versions(DRAFT)).excluded, true)

    // Without the patterns, what is on disk enters the history at once.
    writeFileSync(join(h.notesDir, 'vihko.yaml'), '')
    h.workspace.reload()
    await h.history.configure()
    await h.settle()
    const now = (await h.changes()).changes[0]
    assert.equal(who(now), 'external')
    assert.deepEqual(now.files.map((f: any) => [f.path, f.change]).sort(), [
      // (vihko.yaml changed too: its versions aren't listed to anyone, D-038.)
      [PDF, 'created'], [BOOK, 'created'], [DRAFT, 'modified'],
      ...inFolder.map((p) => [`${library}/${p}`, 'created']),
    ].sort())
  } finally { await h.close() }
})

test('history.exclude at startup: an excluded file changed while vihko was stopped is not recorded', async () => {
  const excluded = m.aFolder()
  const [diary, added] = [m.aNotePath(excluded), m.aNotePath(excluded)]
  const heading = `# ${m.aHeading()}\n`
  const config = `history:\n  exclude: ${JSON.stringify(excluded)}\n`
  const h = await setup({ config, files: { [diary]: heading } })
  const n = (await h.changes()).changes.length
  await h.close()
  writeFileSync(join(h.notesDir, diary), `${heading}${m.aSentence()}\n`)
  writeFileSync(join(h.notesDir, added), `# ${m.aHeading()}\n`)
  const again = await setup({ dir: h.dir })
  try {
    assert.equal((await again.changes()).changes.length, n)
  } finally { await again.close() }
})

test('restoring a version brings back the images it linked that are gone, never over another file', async () => {
  // Image names are one word: a Markdown destination has no spaces.
  const [a, b, c] = [`${m.aUniqueWord()}.png`, `${m.aUniqueWord()}.png`, `${m.aUniqueWord()}.png`]
  const folder = m.aFolder()
  const NOTE_WITH = m.aNotePath(folder)
  const [A, B, B2] = [m.aSecret(), m.aSecret(), m.aSecret()]
  // An external image (a URL) is never restored nor reported.
  const text = `# ${m.aHeading()}\n\n![](${a}) ![](${b}) ![](${c}) ![](https://${m.aHost()}/x.png)\n`
  const h = await setup({ files: { [NOTE_WITH]: text, [`${folder}/${a}`]: A, [`${folder}/${b}`]: B } })
  try {
    const first = (await h.versions(NOTE_WITH)).versions[0]
    await h.put(NOTE_WITH, () => `# ${m.aHeading()}\n`)
    unlinkSync(join(h.notesDir, `${folder}/${a}`))
    writeFileSync(join(h.notesDir, `${folder}/${b}`), B2)
    await h.history.recorder.observePaths([`${folder}/${a}`, `${folder}/${b}`])
    await h.settle()
    const r = await h.admin('POST', '/api/history/restore', { path: NOTE_WITH, id: first.id })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.images, { restored: [`${folder}/${a}`], missing: [{ path: `${folder}/${b}`, reason: 'exists' }, { path: `${folder}/${c}`, reason: 'not_in_history' }] })
    assert.equal(readFileSync(join(h.notesDir, `${folder}/${a}`), 'utf8'), A)
    assert.equal(readFileSync(join(h.notesDir, `${folder}/${b}`), 'utf8'), B2, 'never overwritten')
    assert.ok(readFileSync(join(h.notesDir, NOTE_WITH), 'utf8').includes(`![](${a})`))
    assert.equal(r.headers.get('etag'), `"${r.body.etag}"`)
    await h.settle()
    const { changes } = await h.changes()
    assert.deepEqual(changes[0].reason, { code: 'restored', id: first.id, at: first.at })
    assert.deepEqual(changes[0].files.map((f: any) => [f.path, f.change]).sort(), [[`${folder}/${a}`, 'created'], [NOTE_WITH, 'restored']].sort())
    assert.equal(who(changes[0]), user(h.users.admin))
    const { versions } = await h.versions(NOTE_WITH)
    assert.equal(versions[0].change, 'restored')
    // A stale If-Match is refused, and nothing is written.
    const stale = await h.admin('POST', '/api/history/restore', { path: NOTE_WITH, id: first.id, ifMatch: 'sha256:0' })
    assert.equal(stale.status, 412)
  } finally { await h.close() }
})

test('a deleted note shows its deletion and comes back by restoring an earlier version', async () => {
  const h = await setup()
  try {
    const del = await h.admin('DELETE', `/api/note?path=${h.q('Plan.md')}`)
    assert.equal(del.status, 200)
    await h.settle()
    const { versions } = await h.versions('Plan.md')
    assert.deepEqual(versions.map((v: any) => [v.change, who(v)]), [['deleted', user(h.users.admin)], ['created', 'system']])
    const gone = await h.admin('GET', `/api/history/version?path=${h.q('Plan.md')}&id=${versions[0].id}`)
    assert.equal(gone.body.text, null)
    assert.equal((await h.admin('POST', '/api/history/restore', { path: 'Plan.md', id: versions[0].id })).status, 400, 'a deletion has no text to restore')
    const r = await h.admin('POST', '/api/history/restore', { path: 'Plan.md', id: versions[1].id })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(existsSync(join(h.notesDir, 'Plan.md')))
    await h.settle()
    assert.equal((await h.versions('Plan.md')).versions[0].change, 'restored')
    // From the trash is a version too.
    const del2 = await h.admin('DELETE', `/api/note?path=${h.q('tags.md')}`)
    await h.admin('POST', `/api/trash/${del2.body.id}/restore`, {})
    await h.settle()
    const tags = (await h.versions('tags.md')).versions
    assert.deepEqual(tags.slice(0, 2).map((v: any) => [v.change, v.reason?.code ?? null]), [['restored', 'trash_restored'], ['deleted', null]])
  } finally { await h.close() }
})

test('diffs by words against the previous version, the current text or another version', async () => {
  const h = await setup()
  try {
    const [w1, w2, w3, w4, w5] = [m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord()]
    await h.put('tags.md', () => `${w1} ${w2} ${w3}\n`)
    await h.settle()
    await h.put('tags.md', () => `${w1} ${w4} ${w3}\n`)
    await h.settle()
    const { versions } = await h.versions('tags.md')
    const d = await h.admin('GET', `/api/history/diff?path=tags.md&id=${versions[0].id}`)
    // vihko gave the note a uid in its first write: the frontmatter is the same in both.
    const fm = d.body.ops[0][1] as string
    assert.match(fm, new RegExp(`^---\\nuid: \\w+\\n---\\n${w1} $`))
    assert.deepEqual(d.body.ops, [[0, fm], [-1, w2], [1, w4], [0, ` ${w3}\n`]])
    assert.equal(d.body.added, 1)
    assert.equal(d.body.removed, 1)
    await h.put('tags.md', (t) => t.replace(new RegExp(`${w1} .*\\n$`), `${w5}\n`))
    const cur = await h.admin('GET', `/api/history/diff?path=tags.md&id=${versions[1].id}&against=current`)
    assert.deepEqual(cur.body.ops.slice(1), [[-1, w5], [1, `${w1} ${w2} ${w3}`], [0, '\n']], 'what the version has that the current text doesn\'t is inserted')
    const other = await h.admin('GET', `/api/history/diff?path=tags.md&id=${versions[0].id}&against=${versions[1].id}`)
    assert.deepEqual(other.body.ops, d.body.ops)
    assert.equal((await h.admin('GET', `/api/history/diff?path=tags.md&id=${'0'.repeat(40)}`)).status, 404)
  } finally { await h.close() }
})

test('versions come in pages', async () => {
  const h = await setup()
  try {
    for (let i = 0; i < 5; i++) { await h.put('tags.md', (t) => t + `${m.aSentence()}\n`); await h.settle() }
    const a = await h.versions('tags.md', '&limit=2')
    assert.equal(a.versions.length, 2)
    assert.ok(a.next)
    const b = await h.versions('tags.md', `&limit=2&cursor=${a.next}`)
    const c = await h.versions('tags.md', `&limit=2&cursor=${b.next}`)
    assert.equal(c.next, null)
    const all = [...a.versions, ...b.versions, ...c.versions].map((v: any) => v.id)
    assert.equal(all.length, 6)
    assert.equal(new Set(all).size, 6)
    assert.equal((await h.admin('GET', '/api/history/versions?path=tags.md&cursor=nonsense')).status, 400)
    // A cursor is data, never a git option.
    const out = join(h.dir, 'written-by-git')
    const cursor = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url')
    assert.equal((await h.admin('GET', `/api/history/versions?path=tags.md&cursor=${cursor({ rev: `--output=${out}`, path: 'tags.md' })}`)).status, 400)
    assert.equal((await h.admin('GET', `/api/history/changes?cursor=${cursor({ rev: `--output=${out}` })}`)).status, 400)
    assert.ok(!existsSync(out))
  } finally { await h.close() }
})

test('«Recent changes» filters file by file with the permission check, and by author', async () => {
  // privado/ is the admin's alone: the member edits everything else.
  const h = await setup({ config: ({ admin, member }) => `permissions:\n  "": { grants: { ${yamlKey(admin)}: manage, ${yamlKey(member)}: edit } }\n  privado: { grants: { ${yamlKey(admin)}: manage } }\n` })
  try {
    await h.put('privado/sin-ia.md', (t) => t + `${m.aSentence()}\n`)
    await h.settle()
    await h.put('tags.md', (t) => t + `${m.aSentence()}\n`, 'member')
    await h.settle()
    const { changes, authors } = await h.changes('', 'member')
    assert.equal(changes.length, 2, 'the change with only a private file is left out')
    assert.ok(changes.every((c: any) => c.files.every((f: any) => !f.path.startsWith('privado/'))))
    assert.deepEqual(authors.map((a: any) => a.key).sort(), ['system', `user:${h.ids.member}`, `user:${h.ids.admin}`].sort())
    assert.equal((await h.member('GET', `/api/history/versions?path=${h.q('privado/sin-ia.md')}`)).status, 404)
    const byMember = await h.changes(`&author=user:${h.ids.member}`, 'member')
    assert.deepEqual(byMember.changes.map((c: any) => who(c)), [user(h.users.member)])
    assert.deepEqual((await h.changes('&author=system', 'member')).changes.map((c: any) => c.reason.code), ['history_enabled'])
    // A note moved out of a folder the user can't read: where it was isn't said.
    const outOfIt = m.aNotePath()
    await h.admin('POST', '/api/note/move', { from: 'privado/sin-ia.md', to: outOfIt })
    await h.settle()
    const all = (await h.changes('', 'member')).changes
    const moved = all[0].files.find((f: any) => f.path === outOfIt)
    assert.equal(moved.change, 'moved')
    assert.equal(moved.from, undefined)
    const page = await h.member('GET', '/api/history/changes?limit=1')
    assert.deepEqual(page.body.changes.map((c: any) => c.id), [all[0].id])
    const rest = await h.member('GET', `/api/history/changes?limit=5&cursor=${page.body.next}`)
    assert.deepEqual(rest.body.changes.map((c: any) => c.id), all.slice(1).map((c: any) => c.id))
    assert.equal(rest.body.next, null)
  } finally { await h.close() }
})

test('a failing git never blocks a write: it is reported, and the history catches up when git is back', async () => {
  const dir = tempDir('vihko-git-')
  const { git, flag } = flakyGit(dir)
  const h = await setup({ git })
  try {
    writeFileSync(flag, '')
    const written = m.aSentence()
    await h.put(NOTE, (t) => t + `\n${written}\n`)
    h.history.recorder.closeAll()
    await sleep(200)
    const status = (await h.admin('GET', '/api/history/status')).body
    assert.equal(status.available, false)
    assert.equal(status.error.code, 'git_failed')
    // Why, as a code: what git said stays on the server (the log, the admin's alert).
    for (const body of [status, (await h.member('GET', '/api/history/status')).body]) {
      assert.doesNotMatch(JSON.stringify(body), /simulated failure|exited with|git /)
    }
    const alert = (await h.admin('GET', '/api/alerts')).body.alerts.find((a: any) => a.code === 'history_unavailable')
    assert.match(alert.detail, /simulated failure/)
    assert.ok(readFileSync(join(h.notesDir, NOTE), 'utf8').includes(written), 'the note was written')
    rmSync(flag)
    await sleep(300)
    await h.history.recorder.settle()
    assert.equal((await h.admin('GET', '/api/history/status')).body.available, true)
    assert.deepEqual((await h.versions(NOTE)).versions.map(who), [user(h.users.admin), 'system'])
    assert.ok(!(await h.admin('GET', '/api/alerts')).body.alerts.some((a: any) => a.code === 'history_unavailable'))
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('the history\'s git gc runs in the foreground and ends with vihko: closing stops it, so no git outlives the state volume\'s lock', async () => {
  const dir = tempDir('vihko-git-')
  const git = join(dir, 'git-gc.sh')
  const seen = join(dir, 'gc-args')
  // A gc that would run for a minute (the wrapper becomes it: its PID is the child's).
  writeFileSync(git, `#!/bin/sh\ncase " $* " in *" gc "*) echo "$$ $*" > '${seen}'; exec sleep 60;; esac\nexec git "$@"\n`)
  chmodSync(git, 0o755)
  // The first commit is enough for a gc.
  const h = await setup({ git, gcEvery: 1 })
  let pid = 0
  try {
    const t0 = Date.now()
    while (!existsSync(seen)) { if (Date.now() - t0 > 10_000) throw new Error('timeout: the gc'); await sleep(20) }
    const [first, ...args] = readFileSync(seen, 'utf8').trim().split(' ')
    pid = Number(first)
    assert.ok(args.includes('gc.autoDetach=false'), args.join(' '))
  } finally {
    const t0 = Date.now()
    await h.close()
    assert.ok(Date.now() - t0 < 4000, `closing took ${Date.now() - t0} ms`)
  }
  assert.throws(() => process.kill(pid, 0), 'the gc is gone once closing is done')
})

test('git failing so long that the queue reaches its cap: the oldest versions merge into later ones, keeping contents and authors, with an alert while it lasts', async () => {
  const dir = tempDir('vihko-git-')
  const { git, flag } = flakyGit(dir)
  const h = await setup({ git, queueMax: 2 })
  const until = async (cond: () => Promise<boolean>, what: string) => {
    const t0 = Date.now()
    while (!(await cond())) { if (Date.now() - t0 > 15_000) throw new Error(`timeout: ${what}`); await sleep(50) }
  }
  const merged = async () => (await h.admin('GET', '/api/alerts')).body.alerts.find((a: any) => a.code === 'history_versions_merged') ?? null
  const gitBack = async () => {
    rmSync(flag)
    await until(async () => (await h.admin('GET', '/api/history/status')).body.available, 'git back')
    await h.history.recorder.settle()
  }
  const version = async (path: string) => {
    const [v] = (await h.versions(path)).versions
    return { who: who(v), text: (await h.admin('GET', `/api/history/version?path=${h.q(path)}&id=${v.id}`)).body.text as string, id: v.id }
  }
  try {
    const t0 = Date.now()
    writeFileSync(flag, '')
    const [byAdmin, byMember, byMemberAfter, k1, a1, k2] = [m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord()]
    // Three versions for a queue of two: the admin's of the note goes into the member's next one of the same note.
    await h.put(NOTE, (t) => t + `\n${byAdmin}\n`)
    h.history.recorder.closeAll()
    await h.put('tags.md', (t) => t + `${byMember}\n`, 'member')
    h.history.recorder.closeAll()
    await h.put(NOTE, (t) => t + `${byMemberAfter}\n`, 'member')
    h.history.recorder.closeAll()
    await until(async () => (await merged()) !== null, 'the alert')
    const alert = await merged()
    assert.deepEqual(alert, { code: 'history_versions_merged', versions: 1, since: alert.since, actions: [] })
    assert.ok(Date.parse(alert.since) >= t0 - 1000 && Date.parse(alert.since) <= Date.now())
    assert.ok(readFileSync(join(h.notesDir, NOTE), 'utf8').includes(byMemberAfter), 'notes are written all the same')
    await gitBack()
    assert.equal(await merged(), null, 'gone once everything is in git')
    assert.deepEqual((await h.versions(NOTE)).versions.map(who), [`${user(h.users.member)},${user(h.users.admin)}`, 'system'], 'one version with both authors')
    assert.ok((await version(NOTE)).text.endsWith(`${byAdmin}\n${byMemberAfter}\n`))
    assert.deepEqual((await h.versions('tags.md')).versions.map(who), [user(h.users.member), 'system'], 'another file keeps its own author')

    // Nothing written again: a version goes into a later one by the same author, with its own content.
    writeFileSync(flag, '')
    await h.put('codigo.md', (t) => t + `${k1}\n`)
    h.history.recorder.closeAll()
    await h.put('Plan.md', (t) => t + `${a1}\n`, 'member')
    h.history.recorder.closeAll()
    await h.put('tags.md', (t) => t + `${k2}\n`)
    h.history.recorder.closeAll()
    await until(async () => (await merged())?.versions === 1, 'the alert again')
    await gitBack()
    const { changes } = await h.changes()
    assert.deepEqual(changes.slice(0, 2).map((c: any) => [who(c), c.files.map((f: any) => f.path).sort()]), [
      [user(h.users.admin), ['codigo.md', 'tags.md']],
      [user(h.users.member), ['Plan.md']],
    ])
    assert.ok((await version('codigo.md')).text.endsWith(`${k1}\n`))
    assert.ok(h.logs.some((l) => /merging the oldest/.test(l)))
    assert.ok(!h.logs.some((l) => /dropped/.test(l)))
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('vihko.yaml turns the history off and on: nothing recorded meanwhile is attributed', async () => {
  const h = await setup()
  try {
    writeFileSync(join(h.notesDir, 'vihko.yaml'), 'history:\n  mode: off\n')
    h.workspace.reload()
    await h.history.configure()
    assert.deepEqual((await h.admin('GET', '/api/history/status')).body, { mode: 'off', available: false, error: null })
    assert.equal((await h.admin('GET', `/api/history/versions?path=${h.q(NOTE)}`)).body.error, 'history_off')
    await h.put(NOTE, (t) => t + `\n${m.aSentence()}\n`)
    writeFileSync(join(h.notesDir, 'vihko.yaml'), 'history:\n  mode: managed\n')
    h.workspace.reload()
    await h.history.configure()
    await h.settle()
    const { changes } = await h.changes()
    assert.deepEqual(changes[0].reason, { code: 'history_resumed' })
    assert.equal(who(changes[0]), 'system')
    // vihko.yaml is in that version too, but it isn't listed to anyone (it holds the permissions, D-038).
    assert.deepEqual(changes[0].files.map((f: any) => f.path).sort(), [NOTE])
    assert.equal(changes.length, 2)
  } finally { await h.close() }
})

test('unmanaged mode without a repository says so', async () => {
  const h = await setup({ config: 'history:\n  mode: unmanaged\n' })
  try {
    const s = (await h.admin('GET', '/api/history/status')).body
    assert.equal(s.mode, 'unmanaged')
    assert.equal(s.available, false)
    // The test vault lives in a temporary folder with no git above it.
    assert.equal(s.error.code, 'history_no_repository')
    assert.ok((await h.admin('GET', '/api/alerts')).body.alerts.some((a: any) => a.code === 'history_no_repository'))
    // There is nothing to read: the status and the alert say why.
    const r = await h.admin('GET', `/api/history/versions?path=${h.q(NOTE)}`)
    assert.deepEqual([r.status, r.body.error], [503, 'history_unavailable'])
  } finally { await h.close() }
})

test('changes made while vihko was stopped are external, found at startup; what the journal left pending keeps its authors', async () => {
  const h = await setup()
  await h.settle()
  const pendingText = m.aSentence()
  // Something pending when vihko stops (closing doesn't commit it: the journal keeps it).
  await h.put(NOTE, (t) => t + `\n${pendingText}\n`)
  await h.close()
  const file = join(h.notesDir, NOTE)
  writeFileSync(file, readFileSync(file, 'utf8') + `${m.aSentence()}\n`)
  writeFileSync(join(h.notesDir, 'tags.md'), `${m.aSentence()}\n`)
  rmSync(join(h.notesDir, 'codigo.md'))
  const again = await setup({ dir: h.dir })
  try {
    await again.settle()
    const { versions } = await again.versions(NOTE)
    assert.deepEqual(versions.map((v: any) => [who(v), v.foundAtStartup]), [['external', true], [user(again.users.admin), false], ['system', false]])
    const pending = await again.admin('GET', `/api/history/version?path=${again.q(NOTE)}&id=${versions[1].id}`)
    assert.ok(pending.body.text.endsWith(`${pendingText}\n`), 'the pending version keeps its text from the journal')
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
    writeFileSync(file, `${m.aSentence()}\n`)
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

test('someone who starts typing where another was closes the open version first, with the text from before; whoever was writing goes on with them', async () => {
  const h = await setup({ quietMs: 600_000 })
  try {
    const r = h.history.recorder
    const admin: Actor = { kind: 'user', id: h.ids.admin }
    const member: Actor = { kind: 'user', id: h.ids.member }
    const t0 = readFileSync(join(h.notesDir, NOTE), 'utf8')
    const [k1, k2, a1, k3] = [`${m.aUniqueWord()}\n`, `${m.aUniqueWord()}\n`, `${m.aUniqueWord()}\n`, `${m.aUniqueWord()}\n`]
    r.typing(NOTE, admin)
    r.flushing(NOTE, t0 + k1)
    r.typing(NOTE, admin) // typed again, not flushed yet
    assert.equal(r.startsVersion(NOTE, admin), false)
    assert.equal(r.startsVersion(NOTE, member), true)
    // The member's first change: what the admin had, flushed or not, closes as the admin's version.
    r.typing(NOTE, member, t0 + k1 + k2)
    r.flushing(NOTE, t0 + k1 + k2 + a1)
    assert.equal(r.startsVersion(NOTE, admin), false, 'the admin was already writing: they go on in the member\'s version')
    r.typing(NOTE, admin, t0 + k1 + k2 + a1)
    r.flushing(NOTE, t0 + k1 + k2 + a1 + k3)
    await h.settle()
    const { versions } = await h.versions(NOTE)
    assert.deepEqual(versions.map(who), [`${user(h.users.member)},${user(h.users.admin)}`, user(h.users.admin), 'system'])
    const text = async (id: string) => (await h.admin('GET', `/api/history/version?path=${h.q(NOTE)}&id=${id}`)).body.text as string
    assert.equal(await text(versions[1].id), t0 + k1 + k2)
    assert.equal(await text(versions[0].id), t0 + k1 + k2 + a1 + k3)
  } finally { await h.close() }
})
