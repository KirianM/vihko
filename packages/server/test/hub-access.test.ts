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
import { yamlKey } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

// The admin edits the root, not manages it: whoever manages it keeps
// managing the shared folder whatever its grants say (D-040 3.5), and they have to read it only.
const rules = (admin: string, member: string, shared: string, people: string) => `permissions:
  "":
    grants: { ${yamlKey(admin)}: edit }
  ${yamlKey(shared)}:
    grants: { ${yamlKey(member)}: edit, ${yamlKey(admin)}: read }
  ${yamlKey(`${people}/{user}`)}:
    grants: { "{user}": manage }
`
const note = () => `# ${m.aHeading()}\n\n${m.aSentence()}\n`

/** A server's folders with its admin and a member: a shared note, and a note in the member's own folder. */
function prepare() {
  const { notes, env, admin } = makeDirs()
  const member = m.aUser()
  const [shared, people] = [m.aFolder(), m.aFolder()]
  const own = `${people}/${member.username}`
  const list = m.aNotePath(shared)
  const diary = m.aNotePath(own)
  spawnSync(process.execPath, [CLI, 'user', 'create', member.username], { env: { ...process.env, ...env }, input: member.password })
  mkdirSync(join(notes, shared), { recursive: true })
  mkdirSync(join(notes, own), { recursive: true })
  writeFileSync(join(notes, list), note())
  writeFileSync(join(notes, diary), note())
  writeFileSync(join(notes, 'vihko.yaml'), rules(admin.username, member.username, shared, people))
  return { notes, env, admin, member, shared, people, own, list, diary }
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
  const { notes, env, member, own, list, diary } = prepare()
  const srv = await startServer({ ...env, VIHKO_HISTORY_QUIET_SECONDS: '0.4' })
  try {
    const k = await login(srv)
    const l = await login(srv, member)
    assert.equal(await tryOpen(srv, k, diary), 'refused', 'the admin doesn\'t read what isn\'t granted')
    assert.equal(await tryOpen(srv, l, diary), 'synced')
    assert.equal(await tryOpen(srv, k, m.aNotePath(own)), 'refused')

    const reader = await connect(srv, k, list)
    const writer = await connect(srv, l, list)
    const [readerTyped, writerTyped] = [m.aUniqueWord(), m.aUniqueWord()]
    typeLine(reader, readerTyped)
    typeLine(writer, writerTyped)
    await waitFor(() => readFileSync(join(notes, list), 'utf8').includes(writerTyped), 'the member\'s typing on disk')
    await sleep(1500)
    assert.ok(!readFileSync(join(notes, list), 'utf8').includes(readerTyped))
    assert.ok(!writer.text().includes(readerTyped), 'nor does it reach the others')
  } finally { closeAll(); await srv.stop() }
})

test('access changed with the note open: the editor is told and closed; a move names where it went only to those who can read it there', async () => {
  const { notes, env, admin, member, shared, people, list } = prepare()
  const srv = await startServer({ ...env, VIHKO_HISTORY_QUIET_SECONDS: '0.4' })
  try {
    const k = await login(srv)
    const l = await login(srv, member)
    const memberEditor = await connect(srv, l, list)
    const adminEditor = await connect(srv, k, list)
    const got: { who: string; m: any }[] = []
    for (const [who, c] of [['member', memberEditor], ['admin', adminEditor]] as const) c.provider.on('stateless', ({ payload }: { payload: string }) => got.push({ who, m: JSON.parse(payload) }))

    // The admin takes the member down to read.
    const perm = await api(srv, k, 'GET', `/api/permissions?folder=${encodeURIComponent(shared)}`)
    const put = await api(srv, k, 'PUT', '/api/permissions', { folder: shared, grants: { [member.username]: 'read', [admin.username]: 'edit' }, ifMatch: perm.body.etag })
    assert.equal(put.status, 200, JSON.stringify(put.body))
    await waitFor(() => got.some((g) => g.who === 'member' && g.m.type === 'vihko:access'), 'the member is told')
    assert.deepEqual(got.filter((g) => g.m.type === 'vihko:access').map((g) => [g.who, g.m.access]).sort(), [['admin', 'edit'], ['member', 'read']])
    // Reopened: they read, and nothing they type goes in.
    const again = await connect(srv, l, list)
    const afterDowngrade = m.aUniqueWord()
    typeLine(again, afterDowngrade)
    await sleep(1500)
    assert.ok(!readFileSync(join(notes, list), 'utf8').includes(afterDowngrade))

    // The admin (edit now) moves it where the member can't read: they're told it's gone, not where.
    const k2 = await connect(srv, k, list)
    const moved: { who: string; to: unknown }[] = []
    for (const [who, c] of [['member', again], ['admin', k2]] as const) c.provider.on('stateless', ({ payload }: { payload: string }) => { const m = JSON.parse(payload); if (m.type === 'vihko:moved') moved.push({ who, to: m.to }) })
    const to = m.aNotePath(`${people}/${admin.username}`)
    const mv = await api(srv, k, 'POST', '/api/note/move', { from: list, to })
    assert.equal(mv.status, 200, JSON.stringify(mv.body))
    await waitFor(() => moved.length === 2, 'both editors told')
    assert.deepEqual(moved.sort((a, b) => a.who.localeCompare(b.who)), [{ who: 'admin', to }, { who: 'member', to: null }])
  } finally { closeAll(); await srv.stop() }
})
