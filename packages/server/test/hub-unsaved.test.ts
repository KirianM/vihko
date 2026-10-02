// An open note vihko can't save: its folder refuses writes (permissions, a
// full disk), or the state volume refuses its recovery log. Nobody goes on
// typing into text that isn't on the disk: it turns read-only for every
// editor, who is told why, the admin gets an alert, and once the disk takes
// writes again the note saves what it held and is writable again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { openLineage } from '../../web/src/editor/lineage.ts'
import { api, closeAll, connect, login, makeDirs, open, sleep, socket, startServer, typeLine, waitFor, type Client } from './_collab.ts'
import { inShared } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const NOTE = inShared('hogar/Proxy.md')
// Permissions don't stop root: there is nothing to see as root.
const asRoot = process.getuid?.() === 0

/** What a client hears from the hub, by type. */
function listen(c: Pick<Client, 'provider'>) {
  const got: { type: string; [k: string]: unknown }[] = []
  c.provider.on('stateless', ({ payload }: { payload: string }) => got.push(JSON.parse(payload)))
  return { got, has: (type: string) => got.some((g) => g.type === type), last: (type: string) => got.findLast((g) => g.type === type) }
}

const unsavedAlerts = async (srv: Parameters<typeof api>[0], cookie: string) =>
  ((await api(srv, cookie, 'GET', '/api/alerts')).body.alerts as { code: string }[]).filter((a) => a.code === 'note_not_saved')

for (const where of ['the note\'s folder', 'the state volume'] as const) {
  test(`${where} refuses writes: the note turns read-only for its editors and the admin is told; once it can, it saves and is writable again`, { skip: asRoot }, async () => {
    const { notes, env } = makeDirs()
    const srv = await startServer({ ...env, VIHKO_TEST_SAVE_RETRY_MS: '300' })
    const file = join(notes, NOTE)
    const locked = where === 'the note\'s folder' ? dirname(file) : join(env.VIHKO_STATE_DIR!, 'collab')
    const [held, refused, after] = [m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord()]
    try {
      const cookie = await login(srv)
      const a = await connect(srv, cookie, NOTE)
      const b = await connect(srv, cookie, NOTE)
      const [ha, hb] = [listen(a), listen(b)]
      chmodSync(locked, 0o555)
      typeLine(a, held)
      await waitFor(() => ha.has('vihko:save-failed') && hb.has('vihko:save-failed'), 'both editors told')
      assert.deepEqual(ha.last('vihko:save-failed'), { type: 'vihko:save-failed', path: NOTE, reason: 'write_denied' })
      if (where === 'the note\'s folder') assert.ok(!readFileSync(file, 'utf8').includes(held), 'not on the disk')

      // Read-only: what an editor sends now goes nowhere, and an agent's or the API's write is refused.
      typeLine(b, refused)
      await sleep(800)
      const w = await api(srv, cookie, 'POST', '/api/note/edit', { path: NOTE, ops: [{ op: 'append', text: `${m.aUniqueWord()}\n` }] })
      assert.equal(w.status, 500)
      const alerts = await unsavedAlerts(srv, cookie)
      assert.deepEqual(alerts, [{ code: 'note_not_saved', path: NOTE, space: NOTE.split('/').slice(0, 2).join('/'), reason: 'write_denied', volume: where === 'the note\'s folder' ? 'notes' : 'state', actions: [] }])
      // Someone who opens it meanwhile is told at once, and can't write either.
      const opened = openLineage(socket(srv, cookie), NOTE)
      open.unshift(opened.provider)
      const hc = listen(opened)
      await waitFor(() => opened.provider.isSynced, 'opened')
      const c: Client = { doc: opened.doc, provider: opened.provider, text: () => opened.text.toString(), close: () => opened.destroy() }
      await waitFor(() => hc.has('vihko:save-failed'), 'a new editor is told')

      chmodSync(locked, 0o755)
      await waitFor(() => ha.has('vihko:save-resumed') && hb.has('vihko:save-resumed') && hc.has('vihko:save-resumed'), 'everyone told it saves again', 15_000)
      await waitFor(() => readFileSync(file, 'utf8').includes(`${held}\n`), 'what it held is saved')
      assert.ok(!readFileSync(file, 'utf8').includes(refused), 'what was refused never went in')
      assert.ok(!a.text().includes(refused), 'nor reached the others')
      assert.deepEqual(await unsavedAlerts(srv, cookie), [], 'the alert goes')
      typeLine(c, after)
      await waitFor(() => readFileSync(file, 'utf8').includes(`${after}\n`), 'writable again')
    } finally {
      chmodSync(locked, 0o755)
      closeAll()
      await srv.stop()
    }
  })
}

test('a note that can\'t be saved stays in memory when its editors leave, and is saved once it can', { skip: asRoot }, async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer({ ...env, VIHKO_TEST_SAVE_RETRY_MS: '300' })
  const file = join(notes, NOTE)
  const held = m.aUniqueWord()
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    const ha = listen(a)
    chmodSync(dirname(file), 0o555)
    typeLine(a, held)
    await waitFor(() => ha.has('vihko:save-failed'), 'told')
    a.close()
    await sleep(1500)
    assert.equal((await unsavedAlerts(srv, cookie)).length, 1, 'still open in the hub')
    chmodSync(dirname(file), 0o755)
    await waitFor(() => readFileSync(file, 'utf8').includes(`${held}\n`), 'saved once it can', 15_000)
    await waitFor(async () => (await unsavedAlerts(srv, cookie)).length === 0, 'the alert goes')
  } finally {
    chmodSync(dirname(file), 0o755)
    closeAll()
    await srv.stop()
  }
})
