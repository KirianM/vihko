// The M3 «done when» (m3 §9, points 1 to 6), against a running server
// (a process, or the Docker image): an agent with a key that writes in
// `proyectos/` creates `proyectos/plan.md` over MCP (both in the shared
// space the vault is in, _permissions.ts SHARED); a person opens it in the
// editor and adds to it; the agent sees that with changes_since and folds it
// in with edit_note and if_match while the note is still open, and the editor
// gets it live, with the agent's presence; the history shows the agent's
// versions and the person's; «Revert this change» on the agent's version
// leaves what the person wrote; and nothing hidden from the key (`ai: false`,
// or outside its folders) shows in any answer, except the denial when the
// agent names such a note itself.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { toolData } from '@vihko/server'
import type * as Y from 'yjs'
import { api, closeAll, connect, waitFor, type Srv } from '../_collab.ts'
import { SHARED, inShared } from '../_permissions.ts'

/** The folder the agent's key reaches, and one of the vault's outside it. */
const PROJECTS = inShared('proyectos')
const OUTSIDE = inShared('fuera-m3')
const PLAN = `${PROJECTS}/plan.md`
/** Words only the hidden notes have: no answer to the agent may carry them. */
const SECRETS = ['ZAFIRO', 'Presupuesto secreto', 'Esmeralda']

const HIDDEN_NOTES: Record<string, string> = {
  [`${PROJECTS}/m3-oculta.md`]: '---\nai: false\n---\n# Presupuesto secreto\n\nCifra ZAFIRO.\n',
  [`${OUTSIDE}/nota.md`]: '# Esmeralda\n\nTambién ZAFIRO aquí, fuera de proyectos.\n',
  [`${PROJECTS}/m3-contexto.md`]: '# Contexto\n\nVer [[m3-oculta]] y [[fuera-m3/nota]].\n',
}

/** The Yjs client ids of the text items holding `needle`. */
function clientsOf(doc: Y.Doc, needle: string): Set<number> {
  const out = new Set<number>()
  let item = (doc.getText('md') as unknown as { _start: { id: { client: number }; content: { str?: string }; deleted: boolean; right: unknown } | null })._start
  while (item) {
    const s = item.content.str
    if (!item.deleted && s && (needle.includes(s) || s.includes(needle))) out.add(item.id.client)
    item = item.right as typeof item
  }
  return out
}

/** `cookie`: the session of `user` (their username and password: creating a key asks for it). */
export async function m3DoneWhen(opts: { srv: Srv; cookie: string; user: { username: string; password: string }; notesDir: string }) {
  const { srv, cookie, notesDir } = opts
  const name = opts.user.username
  for (const [p, text] of Object.entries(HIDDEN_NOTES)) {
    mkdirSync(dirname(join(notesDir, p)), { recursive: true })
    writeFileSync(join(notesDir, p), text)
  }
  await waitFor(async () => (await api(srv, cookie, 'GET', '/api/search?q=ZAFIRO')).body.results.length === 2, 'the hidden notes are indexed', 60_000)
  assert.equal((await api(srv, cookie, 'PUT', '/api/admin/integrations', { mcp: true })).status, 200)
  const created = await api(srv, cookie, 'POST', '/api/keys', { name: 'Claude Code', canWrite: true, folders: [PROJECTS], confirm: opts.user.password })
  assert.equal(created.status, 201)

  const client = new Client({ name: 'acceptance', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${created.body.token}` } } }))
  /** Every answer the agent got, whole, to look for what it must never see. */
  const answers: string[] = []
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean }
    answers.push(JSON.stringify(r))
    return { data: toolData(r.content[0]!.text) as any, texts: r.content.slice(1).map((c) => c.text), error: r.isError === true }
  }

  // 1. The agent writes a plan.
  const plan = await call('create_note', { path: PLAN, text: '# Plan\n\n## Tareas\n\n- migrar el servidor\n- revisar copias\n\n## Riesgos\n\n- ninguno conocido\n' })
  assert.equal(plan.error, false, JSON.stringify(plan.data))

  // 2. The person opens it and adds to it.
  const editor = await connect(srv, cookie, PLAN)
  const presence: { client: number; state: any }[] = []
  const awareness = editor.provider.awareness!
  awareness.on('change', ({ added, updated }: { added: number[]; updated: number[] }) => {
    for (const c of [...added, ...updated]) presence.push({ client: c, state: awareness.getStates().get(c) })
  })
  const md = editor.doc.getText('md')
  md.insert(md.toString().indexOf('- revisar copias\n'), '- PERSONA: primero la base de datos\n')

  // 3. The agent sees the change (waiting for it if it isn't there yet) and folds it in, the note still open.
  const seen = await call('changes_since', { path: PLAN, since: plan.data.etag, wait_seconds: 20 })
  assert.equal(seen.data.changed, true, JSON.stringify(seen.data))
  assert.ok(seen.data.changes.some((c: { added: string }) => c.added.includes('PERSONA: primero la base de datos')), JSON.stringify(seen.data.changes))
  const folded = await call('edit_note', {
    path: PLAN, if_match: seen.data.etag,
    operations: [{ op: 'find_replace', find: '- PERSONA: primero la base de datos', replace: '- PERSONA: primero la base de datos (hecho: fase 1, antes de migrar)' }],
  })
  assert.equal(folded.error, false, JSON.stringify(folded.data))
  // The editor gets it live, with the agent present, and the text it wrote is the agent's.
  await waitFor(() => editor.text().includes('(hecho: fase 1, antes de migrar)'), 'the agent\'s edit reaches the editor')
  const agent = presence.find((p) => p.state?.agent)
  assert.ok(agent, 'the agent is present in the editor')
  assert.deepEqual(agent.state, { agent: { name: 'Claude Code', onBehalfOf: name, via: 'mcp' } })
  assert.deepEqual([...clientsOf(editor.doc, ' (hecho: fase 1, antes de migrar)')], [agent.client])
  assert.ok(editor.text().includes('- PERSONA: primero la base de datos (hecho: fase 1, antes de migrar)\n- revisar copias\n'), editor.text())
  editor.close()
  closeAll()

  // 4. The history shows the agent's versions and the person's.
  let versions: any[] = []
  await waitFor(async () => (versions = (await call('history', { path: PLAN })).data.versions).length >= 3, 'three versions of the plan', 60_000)
  const who = versions.map((v) => v.authors.map((a: any) => `${a.name}${a.via ? `/${a.via}` : ''}`).join())
  assert.deepEqual(who.slice(0, 3), ['Claude Code/mcp', name, 'Claude Code/mcp'])
  const ui = await api(srv, cookie, 'GET', `/api/history/versions?path=${encodeURIComponent(PLAN)}`)
  assert.deepEqual(ui.body.versions[0].authors[0], { kind: 'agent', id: created.body.key.id, name: 'Claude Code', onBehalfOf: { id: ui.body.versions[0].authors[0].onBehalfOf.id, name }, via: 'mcp', key: `agent:${created.body.key.id}` })

  // 5. «Revert this change» on the agent's version leaves what the person wrote.
  const agentVersion = ui.body.versions[0].id as string
  const preview = await api(srv, cookie, 'POST', '/api/history/revert', { path: PLAN, id: agentVersion, dryRun: true })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.deepEqual([preview.body.counts.reverted > 0, preview.body.counts.skipped], [true, 0], JSON.stringify(preview.body))
  const reverted = await api(srv, cookie, 'POST', '/api/history/revert', { path: PLAN, id: agentVersion })
  assert.equal(reverted.status, 200, JSON.stringify(reverted.body))
  assert.equal(reverted.body.changed, true)
  const after = (await api(srv, cookie, 'GET', `/api/note?path=${encodeURIComponent(PLAN)}`)).body.text as string
  assert.ok(!after.includes('(hecho: fase 1'), `the agent's change is undone: ${after}`)
  assert.ok(after.includes('- PERSONA: primero la base de datos\n- revisar copias\n'), `the person's line stays: ${after}`)
  assert.ok(after.includes('- migrar el servidor\n'), `the agent's first version stays: ${after}`)
  // A version of its own, by the person, saying which change it undid.
  await waitFor(async () => {
    const v = (await api(srv, cookie, 'GET', `/api/history/versions?path=${encodeURIComponent(PLAN)}`)).body.versions[0]
    return v.id !== agentVersion && v.authors[0].name === name && v.reason?.code === 'reverted' && v.reason.id === agentVersion
  }, 'the revert is a version by the person', 60_000)

  // 6. Nothing hidden from the key, in any tool: not listed, not found, only denied when it names one.
  assert.deepEqual((await call('search', { query: 'ZAFIRO' })).data.results, [])
  assert.deepEqual((await call('search', { query: `tag:nada path:"${OUTSIDE}"` })).data.results, [])
  // The space lists only the way to the key's folder.
  const space = (await call('list_folder', { folder: SHARED })).data.entries.map((e: { path: string }) => e.path)
  assert.deepEqual(space, [PROJECTS])
  const all = (await call('list_folder', { folder: PROJECTS, recursive: true, limit: 500 })).data
  assert.ok(!all.entries.some((e: { path: string }) => e.path === `${PROJECTS}/m3-oculta.md`))
  const ctx = await call('get_note', { path: `${PROJECTS}/m3-contexto.md` })
  assert.deepEqual(ctx.data.links.outgoing.map((l: any) => [l.status, l.path]), [['no_access', null], ['no_access', null]])
  await call('related', { path: `${PROJECTS}/m3-contexto.md` })
  for (const [path, reason] of [[`${PROJECTS}/m3-oculta.md`, 'ai_false'], [`${OUTSIDE}/nota.md`, 'outside_key_folders']] as const) {
    const r = await call('get_note', { path })
    assert.deepEqual([r.data.error, r.data.reason], ['agent_denied', reason], path)
    assert.equal((await call('changes_since', { path, since: 'sha256:x' })).data.error, 'agent_denied')
    assert.equal((await call('history', { path })).data.error, 'agent_denied')
    assert.equal((await call('create_note', { path, text: 'reemplazo' })).data.error, 'agent_denied')
  }
  assert.equal((await call('resolve_link', { from: `${PROJECTS}/m3-contexto.md`, link: 'm3-oculta' })).data.status, 'no_access')
  await call('daily_note', {}).catch(() => {})
  const leaked = SECRETS.filter((s) => answers.some((a) => a.includes(s)))
  assert.deepEqual(leaked, [], 'nothing hidden reached the agent')
  assert.ok(!(client.getInstructions() ?? '').includes('ZAFIRO'))
  await client.close()
}
