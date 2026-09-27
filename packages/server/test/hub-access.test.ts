// The collaboration hub under the folders' permissions (D-038), on a real
// server: opening a note needs `read`; with `read` or `comment` whatever the
// editor sends is dropped; when access changes with the note open, the
// editor is told and closed; a move doesn't name where the note went to
// someone who can't read it there.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { CLI, api, closeAll, connect, login, makeDirs, sleep, socket, startServer, typeLine, waitFor, open, type Srv } from './_collab.ts'

const RULES = `permissions:
  "":
    grants: { noa: manage }
  familia:
    grants: { laura: edit, noa: read }
  "personas/{user}":
    grants: { "{user}": manage }
`

async function loginAs(srv: Srv, username: string): Promise<string> {
  const r = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'a-long-password' }) })
  assert.equal(r.status, 200)
  return r.headers.get('set-cookie')!.split(';')[0]!
}

function prepare() {
  const { notes, env } = makeDirs()
  spawnSync(process.execPath, [CLI, 'user', 'create', 'laura'], { env: { ...process.env, ...env }, input: 'a-long-password' })
  mkdirSync(join(notes, 'familia'), { recursive: true })
  mkdirSync(join(notes, 'personas/laura'), { recursive: true })
  writeFileSync(join(notes, 'familia/compra.md'), '# Compra\n\nLeche.\n')
  writeFileSync(join(notes, 'personas/laura/diario.md'), '# Diario\n\nSecreto.\n')
  writeFileSync(join(notes, 'thoth.yaml'), RULES)
  return { notes, env }
}

/** Opens a note and says whether the hub let it in (synced) or refused it. */
async function tryOpen(srv: Srv, cookie: string, name: string): Promise<'synced' | 'refused'> {
  const ws = socket(srv, cookie)
  const provider = new HocuspocusProvider({ websocketProvider: ws, name, document: new Y.Doc(), token: '{}' })
  open.unshift(provider)
  let refused = false
  provider.on('authenticationFailed', () => { refused = true })
  provider.attach()
  await waitFor(() => refused || provider.isSynced, `the hub's answer for ${name}`)
  return refused ? 'refused' : 'synced'
}

test('opening a note needs read; with read only, what the editor sends is dropped', async () => {
  const { notes, env } = prepare()
  const srv = await startServer({ ...env, THOTH_HISTORY_QUIET_SECONDS: '0.4' })
  try {
    const k = await login(srv)
    const l = await loginAs(srv, 'laura')
    assert.equal(await tryOpen(srv, k, 'personas/laura/diario.md'), 'refused', 'the admin doesn\'t read what isn\'t granted')
    assert.equal(await tryOpen(srv, l, 'personas/laura/diario.md'), 'synced')
    assert.equal(await tryOpen(srv, k, 'personas/laura/nada.md'), 'refused')

    const reader = await connect(srv, k, 'familia/compra.md')
    const writer = await connect(srv, l, 'familia/compra.md')
    typeLine(reader, 'NOA-TYPED')
    typeLine(writer, 'LAURA-TYPED')
    await waitFor(() => readFileSync(join(notes, 'familia/compra.md'), 'utf8').includes('LAURA-TYPED'), 'Laura\'s typing on disk')
    await sleep(1500)
    assert.doesNotMatch(readFileSync(join(notes, 'familia/compra.md'), 'utf8'), /NOA-TYPED/)
    assert.doesNotMatch(writer.text(), /NOA-TYPED/, 'nor does it reach the others')
  } finally { closeAll(); await srv.stop() }
})

test('access changed with the note open: the editor is told and closed; a move names where it went only to those who can read it there', async () => {
  const { notes, env } = prepare()
  const srv = await startServer({ ...env, THOTH_HISTORY_QUIET_SECONDS: '0.4' })
  try {
    const k = await login(srv)
    const l = await loginAs(srv, 'laura')
    const laura = await connect(srv, l, 'familia/compra.md')
    const noa = await connect(srv, k, 'familia/compra.md')
    const got: { who: string; m: any }[] = []
    for (const [who, c] of [['laura', laura], ['noa', noa]] as const) c.provider.on('stateless', ({ payload }: { payload: string }) => got.push({ who, m: JSON.parse(payload) }))

    // The admin takes Laura down to read.
    const perm = await api(srv, k, 'GET', '/api/permissions?folder=familia')
    const put = await api(srv, k, 'PUT', '/api/permissions', { folder: 'familia', grants: { laura: 'read', noa: 'edit' }, ifMatch: perm.body.etag })
    assert.equal(put.status, 200, JSON.stringify(put.body))
    await waitFor(() => got.some((g) => g.who === 'laura' && g.m.type === 'thoth:access'), 'Laura is told')
    assert.deepEqual(got.filter((g) => g.m.type === 'thoth:access').map((g) => [g.who, g.m.access]).sort(), [['noa', 'edit'], ['laura', 'read']])
    // Reopened: she reads, and nothing she types goes in.
    const again = await connect(srv, l, 'familia/compra.md')
    typeLine(again, 'AFTER-DOWNGRADE')
    await sleep(1500)
    assert.doesNotMatch(readFileSync(join(notes, 'familia/compra.md'), 'utf8'), /AFTER-DOWNGRADE/)

    // Noa (edit now) moves it where Laura can't read: she's told it's gone, not where.
    const k2 = await connect(srv, k, 'familia/compra.md')
    const moved: { who: string; to: unknown }[] = []
    for (const [who, c] of [['laura', again], ['noa', k2]] as const) c.provider.on('stateless', ({ payload }: { payload: string }) => { const m = JSON.parse(payload); if (m.type === 'thoth:moved') moved.push({ who, to: m.to }) })
    const mv = await api(srv, k, 'POST', '/api/note/move', { from: 'familia/compra.md', to: 'personas/noa/compra.md' })
    assert.equal(mv.status, 200, JSON.stringify(mv.body))
    await waitFor(() => moved.length === 2, 'both editors told')
    assert.deepEqual(moved.sort((a, b) => a.who.localeCompare(b.who)), [{ who: 'noa', to: 'personas/noa/compra.md' }, { who: 'laura', to: null }])
  } finally { closeAll(); await srv.stop() }
})
