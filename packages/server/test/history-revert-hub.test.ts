// «Revert this change» on an open note, on a real server: the revert reaches
// every editor as exact changes, without taking what someone is typing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { everyone, inShared } from './_permissions.ts'
import { CLI, api, closeAll, connect, login, makeDirs, startServer, typeLine, waitFor, type Srv } from './_collab.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** The agent's paragraph, and what the people type: nothing else in the note has them. */
const AGENT_PARAGRAPH = `${m.aUniqueWord()} ${m.aSentence()}`
const [PERSON_1, PERSON_2] = [m.aUniqueWord(), m.aUniqueWord()]

// The setup copies the fixed vault (testdata/vault): this note and its
// headings («# Proxy», «## Red», «## Almacenamiento») are the vault's. What
// the agent and the people write is the mother's.
const NOTE = inShared('hogar/Proxy.md')
const q = encodeURIComponent
const FAST = { VIHKO_HISTORY_QUIET_SECONDS: '0.4', VIHKO_HISTORY_MAX_SECONDS: '30' }

async function versionsOf(srv: Srv, cookie: string, path: string) {
  const r = await api(srv, cookie, 'GET', `/api/history/versions?path=${q(path)}`)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body as { versions: any[]; pending: any }
}

const names = (v: { authors: { kind: string; name: string }[] }) => v.authors.map((a) => (a.kind === 'user' ? a.name : a.kind)).join(',')

test('reverting on an open note: both editors get it at once, and what was typed after the version, and while reverting, stays', async () => {
  const { notes, env, admin } = makeDirs()
  const member = m.aUser({ role: 'member' })
  spawnSync(process.execPath, [CLI, 'user', 'create', member.username], { env: { ...process.env, ...env }, input: member.password })
  // The member edits everything, as before M4 (_permissions.ts).
  writeFileSync(join(notes, 'vihko.yaml'), everyone(admin.username, member.username))
  const srv = await startServer({ ...env, ...FAST })
  try {
    const k = await login(srv)
    const a = await login(srv, member)
    const ck = await connect(srv, k, NOTE)
    const ca = await connect(srv, a, NOTE)
    // «The agent»: a write through the API while the note is open.
    const edit = await api(srv, a, 'POST', '/api/note/edit', { path: NOTE, ops: [{ op: 'find_replace', find: '## Red\n', replace: `## Red\n\n${AGENT_PARAGRAPH}\n` }] })
    assert.equal(edit.status, 200, JSON.stringify(edit.body))
    await waitFor(() => ck.text().includes(AGENT_PARAGRAPH), 'the write reaches the editor')
    typeLine(ck, PERSON_1)
    await waitFor(async () => (await versionsOf(srv, k, NOTE)).versions.some((v: any) => names(v) === admin.username), 'the typed version closes', 15_000)
    const { versions } = await versionsOf(srv, k, NOTE)
    const agent = versions.find((v: any) => names(v) === member.username)
    assert.ok(agent, JSON.stringify(versions.map(names)))

    const preview = await api(srv, k, 'POST', '/api/history/revert', { path: NOTE, id: agent.id, dryRun: true })
    assert.equal(preview.status, 200, JSON.stringify(preview.body))
    assert.deepEqual(preview.body.counts, { reverted: 1, skipped: 0, already: 0 })
    // Typed right before the revert, above the agent's paragraph, not flushed
    // yet: the revert is planned on the editors' text, not the file's.
    const md = ca.doc.getText('md')
    md.insert(md.toString().indexOf('# Proxy'), `${PERSON_2}\n`)
    const r = await api(srv, k, 'POST', '/api/history/revert', { path: NOTE, id: agent.id })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.changed, true)
    for (const c of [ck, ca]) {
      await waitFor(() => !c.text().includes(AGENT_PARAGRAPH), 'the revert reaches both editors')
      assert.ok(c.text().endsWith(`---\n${PERSON_2}\n# Proxy\n\n## Red\n\n${PERSON_1}\n## Almacenamiento\n`), c.text())
    }
    assert.equal(ck.text(), ca.text())
    await waitFor(() => { const t = readFileSync(join(notes, NOTE), 'utf8'); return !t.includes(AGENT_PARAGRAPH) && t.includes(PERSON_2) }, 'flushed')
    await waitFor(async () => (await versionsOf(srv, k, NOTE)).versions[0]?.reason?.code === 'reverted', 'the revert\'s version')
    const after = await versionsOf(srv, k, NOTE)
    assert.equal(names(after.versions[0]), admin.username)
    assert.deepEqual(after.versions[0].reason, { code: 'reverted', id: agent.id, at: agent.at })

    // Reverting the revert, still open: the agent's paragraph comes back for both.
    const back = await api(srv, k, 'POST', '/api/history/revert', { path: NOTE, id: after.versions[0].id })
    assert.equal(back.status, 200, JSON.stringify(back.body))
    for (const c of [ck, ca]) await waitFor(() => c.text().includes(AGENT_PARAGRAPH), 'the agent\'s paragraph is back')
    assert.ok(ck.text().includes(`${PERSON_1}\n`) && ck.text().includes(`${PERSON_2}\n`))
  } finally { closeAll(); await srv.stop() }
})
