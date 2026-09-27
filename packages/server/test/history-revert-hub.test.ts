// «Revert this change» on an open note, on a real server: the revert reaches
// every editor as exact changes, without taking what someone is typing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { EVERYONE } from './_permissions.ts'
import { join } from 'node:path'
import { CLI, api, closeAll, connect, login, makeDirs, startServer, typeLine, waitFor, type Srv } from './_collab.ts'

const NOTE = 'hogar/Proxy.md'
const q = encodeURIComponent
const FAST = { THOTH_HISTORY_QUIET_SECONDS: '0.4', THOTH_HISTORY_MAX_SECONDS: '30' }

async function loginAs(srv: Srv, username: string): Promise<string> {
  const r = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'a-long-password' }) })
  assert.equal(r.status, 200)
  return r.headers.get('set-cookie')!.split(';')[0]!
}

async function versionsOf(srv: Srv, cookie: string, path: string) {
  const r = await api(srv, cookie, 'GET', `/api/history/versions?path=${q(path)}`)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body as { versions: any[]; pending: any }
}

const names = (v: { authors: { kind: string; name: string }[] }) => v.authors.map((a) => (a.kind === 'user' ? a.name : a.kind)).join(',')

test('reverting on an open note: both editors get it at once, and what was typed after the version, and while reverting, stays', async () => {
  const { notes, env } = makeDirs()
  spawnSync(process.execPath, [CLI, 'user', 'create', 'ana'], { env: { ...process.env, ...env }, input: 'a-long-password' })
  // ana edits everything, as before M4 (_permissions.ts).
  writeFileSync(join(notes, 'thoth.yaml'), EVERYONE)
  const srv = await startServer({ ...env, ...FAST })
  try {
    const k = await login(srv)
    const a = await loginAs(srv, 'ana')
    const ck = await connect(srv, k, NOTE)
    const ca = await connect(srv, a, NOTE)
    // «The agent»: a write through the API while the note is open.
    const edit = await api(srv, a, 'POST', '/api/note/edit', { path: NOTE, ops: [{ op: 'find_replace', find: '## Red\n', replace: '## Red\n\nAGENT-PARAGRAPH on vmbr0.\n' }] })
    assert.equal(edit.status, 200, JSON.stringify(edit.body))
    await waitFor(() => ck.text().includes('AGENT-PARAGRAPH'), 'the write reaches the editor')
    typeLine(ck, 'PERSON-1')
    await waitFor(async () => (await versionsOf(srv, k, NOTE)).versions.some((v: any) => names(v) === 'noa'), 'the typed version closes', 15_000)
    const { versions } = await versionsOf(srv, k, NOTE)
    const agent = versions.find((v: any) => names(v) === 'ana')
    assert.ok(agent, JSON.stringify(versions.map(names)))

    const preview = await api(srv, k, 'POST', '/api/history/revert', { path: NOTE, id: agent.id, dryRun: true })
    assert.equal(preview.status, 200, JSON.stringify(preview.body))
    assert.deepEqual(preview.body.counts, { reverted: 1, skipped: 0, already: 0 })
    // Typed right before the revert, above the agent's paragraph, not flushed
    // yet: the revert is planned on the editors' text, not the file's.
    const md = ca.doc.getText('md')
    md.insert(md.toString().indexOf('# Proxy'), 'PERSON-2\n')
    const r = await api(srv, k, 'POST', '/api/history/revert', { path: NOTE, id: agent.id })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.changed, true)
    for (const c of [ck, ca]) {
      await waitFor(() => !c.text().includes('AGENT-PARAGRAPH'), 'the revert reaches both editors')
      assert.ok(c.text().endsWith('---\nPERSON-2\n# Proxy\n\n## Red\n\nPERSON-1\n## Almacenamiento\n'), c.text())
    }
    assert.equal(ck.text(), ca.text())
    await waitFor(() => { const t = readFileSync(join(notes, NOTE), 'utf8'); return !t.includes('AGENT-PARAGRAPH') && t.includes('PERSON-2') }, 'flushed')
    await waitFor(async () => (await versionsOf(srv, k, NOTE)).versions[0]?.reason?.code === 'reverted', 'the revert\'s version')
    const after = await versionsOf(srv, k, NOTE)
    assert.equal(names(after.versions[0]), 'noa')
    assert.deepEqual(after.versions[0].reason, { code: 'reverted', id: agent.id, at: agent.at })

    // Reverting the revert, still open: the agent's paragraph comes back for both.
    const back = await api(srv, k, 'POST', '/api/history/revert', { path: NOTE, id: after.versions[0].id })
    assert.equal(back.status, 200, JSON.stringify(back.body))
    for (const c of [ck, ca]) await waitFor(() => c.text().includes('AGENT-PARAGRAPH on vmbr0.'), 'the agent\'s paragraph is back')
    assert.ok(ck.text().includes('PERSON-1\n') && ck.text().includes('PERSON-2\n'))
  } finally { closeAll(); await srv.stop() }
})
