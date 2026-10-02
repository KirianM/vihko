// A vihko on the spaces layout for the tests of spaces and people: an
// empty notes folder with `people/` and `spaces/`, an admin, a
// member and another member (each with their personal folder, made when
// they're created), a group of the two members, and the API with keys and
// the MCP server, all in process, under the spaces model. Everything the
// mother's; files and vihko.yaml as each test writes them.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ApiKeys, Auth, Indexer, Integrations, NoteService, NoteSettingsStore, Profiles, Users, Workspace, createServer, mountMcp, openIndex, openState, toolData, type Runtime } from '@vihko/server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

export type Name = 'admin' | 'member' | 'other'

export interface SpacesSetup {
  /** Files to write before anything starts (a path ending in `/` is a folder). */
  files?: Record<string, string | Uint8Array> | ((names: Record<Name, string>) => Record<string, string | Uint8Array>)
  /** vihko.yaml (none by default: a new installation writes none). */
  config?: string | ((names: Record<Name, string>) => string)
  /** Whether to make the group of the two members (yes by default). */
  group?: boolean
}

export async function setup(opts: SpacesSetup = {}) {
  const dir = tempDir('vihko-spaces-')
  const notesDir = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  mkdirSync(notesDir, { recursive: true })
  const state = openState(join(dir, 'state.db'))
  const index = openIndex(join(dir, 'index.db'))
  const auth = new Auth(state, { notesDir })
  auth.personalFolders!.ensureLayout()
  const people = { admin: m.aUser({ role: 'admin' }), member: m.aUser({ role: 'member' }), other: m.aUser({ role: 'member' }) }
  const names = { admin: people.admin.username, member: people.member.username, other: people.other.username }
  const files = typeof opts.files === 'function' ? opts.files(names) : opts.files ?? {}
  for (const [p, content] of Object.entries(files)) {
    if (p.endsWith('/')) { mkdirSync(join(notesDir, p), { recursive: true }); continue }
    mkdirSync(dirname(join(notesDir, p)), { recursive: true })
    writeFileSync(join(notesDir, p), content)
  }
  const config = typeof opts.config === 'function' ? opts.config(names) : opts.config
  if (config !== undefined) writeFileSync(join(notesDir, 'vihko.yaml'), config)
  const users = new Users(auth)
  const created = {} as Record<Name, { id: string; username: string; password: string }>
  for (const [role, u] of Object.entries(people) as [Name, typeof people.admin][]) {
    created[role] = { ...(await auth.createUser(u.username, u.password, u.role)), password: u.password }
  }
  const group = m.aGroupName()
  if (opts.group !== false) {
    const g = users.createGroup(group)
    users.addMember(g.id, created.member.id)
    users.addMember(g.id, created.other.id)
  }
  const profiles = new Profiles(state)
  const workspace = new Workspace({ notesDir })
  const indexer = new Indexer({ notesDir, db: index })
  const runtime: Runtime = { lastScan: null, rescan(o) { return (this.lastScan = indexer.scan(o)) } }
  runtime.rescan({})
  const keys = new ApiKeys(state)
  const integrations = new Integrations(state)
  // As main.ts: a space's note settings say where its new images go.
  const noteSettings = new NoteSettingsStore({ notesDir })
  const notes = new NoteService({ notesDir, stateDir, indexer, db: index, attachments: (p) => (p ? noteSettings.attachmentsFor(p) : null) ?? workspace.config.attachments })
  const clock = { now: new Date('2026-09-30T10:00:00Z') }
  /** How many times open editors would have been checked again (the hub's `recheckAccess`). */
  const rechecks = { n: 0 }
  const { app, services } = createServer({
    confirmWindowMs: 0,
    auth, profiles, workspace, notes, index, indexer, notesDir, runtime, keys, integrations, users, permissionsModel: 'spaces', noteSettings,
    now: () => clock.now, onPermissionsChanged: () => { rechecks.n++ },
    routes: (a, s) => { mountMcp(a, s, { auth, workspace, pollMs: 25 }) },
  })

  const cookies = {} as Record<Name, string>
  const login = async (who: Name) => {
    const { username, password } = created[who]
    const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })
    if (res.status !== 200) throw new Error(`login ${who}: ${res.status}`)
    cookies[who] = res.headers.get('set-cookie')!.split(';')[0]!
  }
  for (const who of Object.keys(created) as Name[]) await login(who)

  interface Res { status: number; body: any; text: string }
  const send = async (method: string, path: string, body: unknown, headers: Record<string, string>): Promise<Res> => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8')
    let parsed: unknown = null
    try { parsed = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text }
  }
  const as = (who: Name) => (method: string, path: string, body?: unknown) => send(method, path, body, { cookie: cookies[who] })
  const withKey = (token: string) => (method: string, path: string, body?: unknown) => send(method, path, body, { authorization: `Bearer ${token}` })
  /** The admin turns on the API, the MCP server and members' keys. */
  const enable = async () => {
    for (const s of [{ api: true }, { mcp: true }, { membersCanCreateKeys: true }]) {
      const r = await as('admin')('PUT', '/api/admin/integrations', s)
      if (r.status !== 200) throw new Error(`switch: ${r.status} ${r.text}`)
    }
  }
  const newKey = async (who: Name, input: Record<string, unknown>) => {
    const r = await as(who)('POST', '/api/keys', { confirm: created[who].password, ...input })
    if (r.status !== 201) throw new Error(`key: ${r.status} ${r.text}`)
    return r.body as { key: { id: string }; token: string }
  }
  const mcp = async (token: string) => {
    const client = new Client({ name: 'vihko-tests', version: '1' })
    const transport = new StreamableHTTPClientTransport(new URL('http://vihko.test/mcp'), {
      fetch: (u, init) => Promise.resolve(app.request(String(u), init)),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
    await client.connect(transport)
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args }) as { content: { type: string; text: string }[]; isError?: boolean }
      const [first] = r.content
      let data: any = null
      try { data = toolData(first?.text ?? 'null') } catch { data = first?.text }
      return { data, error: r.isError === true, raw: JSON.stringify(r) }
    }
    return { client, call, instructions: () => client.getInstructions() ?? '', close: () => client.close() }
  }
  /** Writes a file of the notes folder and indexes it. */
  const write = (path: string, content: string | Uint8Array) => {
    mkdirSync(dirname(join(notesDir, path)), { recursive: true })
    writeFileSync(join(notesDir, path), content)
    indexer.indexPaths([path])
  }
  /** Sets one folder's rule in vihko.yaml, as the admin would through vihko. */
  const rule = (folder: string, value: { grants?: Record<string, string> | null; ai?: false | null; name?: string | null }) =>
    services.permissionsFile.setRule(folder, { grants: (value.grants ?? null) as any, ai: value.ai ?? null, ...(value.name !== undefined ? { name: value.name } : {}) }, { actor: { kind: 'user', id: created.admin.id } })
  const close = () => {
    index.close()
    state.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return {
    dir, notesDir, stateDir, state, index, app, services, auth, users, keys, indexer, notes, workspace, runtime, clock, rechecks, group, names, created,
    as, admin: as('admin'), member: as('member'), other: as('other'), withKey, enable, newKey, mcp, write, rule, login, close,
    /** The session cookie of `who` (a request that streams, GET /api/events). */
    cookie: (who: Name) => cookies[who],
    home: (who: Name) => `people/${names[who]}`,
  }
}

export type Spaces = Awaited<ReturnType<typeof setup>>
