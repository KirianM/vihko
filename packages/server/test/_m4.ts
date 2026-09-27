// The M4 scenario (m4-multiusuario.md §7), shared by the permission tests
// and the leak sweep: Noa (admin), Laura and Marta (members), the group
// `@familia` (Laura and Marta; until piece U brings groups, a stand-in
// `groupsOf`). Rules: the root is Noa's; `personas/{user}` → `manage`;
// `familia` → `@familia: edit`, `noa: edit`; `personas/laura/diario` with
// `ai: false`. The API with keys, the MCP server and the history, in process.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ApiKeys, Auth, History, Indexer, Integrations, NoteService, PermissionHolds, PermissionsEngine, Profiles, Workspace, createServer, mountMcp, openIndex, openState, stateDirectory, toolData, AccessPolicy, type Runtime } from '@thoth/server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { tempDir } from './_tmp.ts'

/** A 1×1 PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

export const RULES = `# Who reads what
permissions:
  "":
    grants: { noa: manage }
  familia:
    grants: { "@familia": edit, noa: edit }
  "personas/{user}":
    grants: { "{user}": manage }
  personas/laura/diario:
    ai: false
`

export const USERS = { noa: 'admin', laura: 'member', marta: 'member' } as const
export type Name = keyof typeof USERS

export interface M4Setup {
  files?: Record<string, string | Uint8Array>
  /** thoth.yaml (RULES by default). */
  config?: string
  /** Group memberships by user name (familia: laura and marta by default). */
  groups?: Record<string, Name[]>
}

export async function setup(opts: M4Setup = {}) {
  const dir = tempDir('thoth-m4-')
  const notesDir = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  mkdirSync(notesDir, { recursive: true })
  for (const [p, content] of Object.entries(opts.files ?? {})) {
    if (p.endsWith('/')) { mkdirSync(join(notesDir, p), { recursive: true }); continue }
    mkdirSync(dirname(join(notesDir, p)), { recursive: true })
    writeFileSync(join(notesDir, p), content)
  }
  writeFileSync(join(notesDir, 'thoth.yaml'), opts.config ?? RULES)
  const index = openIndex(join(dir, 'index.db'))
  const state = openState(join(dir, 'state.db'))
  const auth = new Auth(state)
  const profiles = new Profiles(state)
  const users = {} as Record<Name, Awaited<ReturnType<Auth['createUser']>>>
  for (const [name, role] of Object.entries(USERS)) users[name as Name] = await auth.createUser(name, 'a-long-password', role)
  const groupList: Record<string, Name[]> = { ...(opts.groups ?? { familia: ['laura', 'marta'] }) }
  const groups = {
    groupsOf: (id: string) => Object.entries(groupList).filter(([, m]) => m.some((n) => users[n].id === id)).map(([g]) => g),
    groups: () => Object.keys(groupList),
  }
  const workspace = new Workspace({ notesDir })
  const indexer = new Indexer({ notesDir, db: index })
  const runtime: Runtime = { lastScan: null, rescan(o) { return (this.lastScan = indexer.scan(o)) } }
  const permissions = new PermissionsEngine({ source: () => workspace.permissions, directory: stateDirectory(state, groups) })
  const holds = new PermissionHolds({ stateDir, engine: permissions })
  indexer.onMoves = (m) => holds.consider(m)
  runtime.rescan({})
  const keys = new ApiKeys(state)
  const integrations = new Integrations(state)
  const history = new History({
    notesDir, stateDir, config: () => workspace.config.history,
    quietMs: 100, maxOpenMs: 60_000, tickMs: 20, retryMs: 50,
    nameOf: (a) => (a.kind === 'user' ? auth.username(a.id) ?? a.id : a.kind === 'agent' ? keys.nameOf(a.id) ?? a.id : a.kind),
    log: () => {},
  })
  await history.open()
  await history.start()
  await history.recorder.settle()
  indexer.onApplied = (a) => history.recorder.observeIndexed(a)
  const notes = new NoteService({ notesDir, stateDir, indexer, db: index, history: history.recorder, attachments: () => workspace.config.attachments })
  const policy = new AccessPolicy({ index, permissions, holds })
  const { app, services } = createServer({
    auth, profiles, workspace, notes, index, indexer, notesDir, runtime, history, keys, integrations, policy, holds, groups,
    now: () => new Date('2026-09-27T10:00:00Z'),
    routes: (a, s) => { mountMcp(a, s, { auth, workspace, pollMs: 25 }) },
  })

  const cookies = {} as Record<Name, string>
  for (const name of Object.keys(users) as Name[]) {
    const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: 'a-long-password' }) })
    cookies[name] = res.headers.get('set-cookie')!.split(';')[0]!
  }

  interface Res { status: number; body: any; text: string; headers: Headers }
  const send = async (method: string, path: string, body: unknown, headers: Record<string, string>): Promise<Res> => {
    const raw = body instanceof Uint8Array
    const res = await app.request(path, {
      method,
      headers: { ...(raw ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : raw ? new Blob([new Uint8Array(body)]) : JSON.stringify(body),
    })
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8')
    let parsed: unknown = null
    try { parsed = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text, headers: res.headers }
  }
  const as = (user: Name) => (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    send(method, path, body, { cookie: cookies[user], ...headers })
  const withKey = (token: string) => (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    send(method, path, body, { authorization: `Bearer ${token}`, ...headers })
  const newKey = async (who: Name, input: Record<string, unknown>) => {
    const r = await as(who)('POST', '/api/keys', input)
    if (r.status !== 201) throw new Error(`key: ${r.status} ${r.text}`)
    return r.body as { key: { id: string }; token: string }
  }
  const enable = async () => {
    for (const s of [{ api: true }, { mcp: true }]) {
      const r = await as('noa')('PUT', '/api/admin/integrations', s)
      if (r.status !== 200) throw new Error(`switch: ${r.status} ${r.text}`)
    }
  }
  const mcp = async (token: string) => {
    const client = new Client({ name: 'thoth-tests', version: '1' })
    const transport = new StreamableHTTPClientTransport(new URL('http://thoth.test/mcp'), {
      fetch: (u, init) => Promise.resolve(app.request(String(u), init)),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
    await client.connect(transport)
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args }) as { content: { type: string; text: string }[]; isError?: boolean }
      const [first, ...rest] = r.content
      let data: any = null
      try { data = toolData(first?.text ?? 'null') } catch { data = first?.text }
      return { data, texts: rest.map((c) => c.text), error: r.isError === true, raw: JSON.stringify(r) }
    }
    return { client, call, close: () => client.close() }
  }
  const settle = async () => {
    history.recorder.closeAll()
    await history.recorder.settle()
  }
  const url = (path: string, params: Record<string, string> = {}) => {
    const q = new URLSearchParams(params).toString()
    return q ? `${path}?${q}` : path
  }
  const close = async () => {
    await history.close()
    index.close()
    state.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return {
    dir, notesDir, stateDir, index, app, services, auth, keys, history, notes, indexer, runtime, workspace, users, groupList, permissions, holds, policy,
    as, noa: as('noa'), laura: as('laura'), marta: as('marta'), withKey, newKey, enable, mcp, settle, url, close,
  }
}

/** The vault of the scenario: a shared folder, each person's own, Laura's diary and recipes, and notes that link across. */
export const FILES: Record<string, string | Uint8Array> = {
  'familia/compra.md': '---\ntags: [casa]\nuid: 01COMPRA000000000000000000\n---\n# Lista de la compra\n\nLeche. Ver [[tarta]] y [[2026-09-27]]. [[Plan]]\n\n![](foto.png)\n',
  'familia/foto.png': PNG,
  'personas/laura/diario/2026-09-27.md': '---\ntags: [casa, intimo]\n---\n# Diario de Laura\n\nSecreto Turmalina. Hablé de [[compra]].\n',
  'personas/laura/recetas/tarta.md': '---\nuid: 01TARTA0000000000000000000\n---\n# Tarta de Laura\n\nTarta Obsidiana. [[compra]]\n',
  'personas/laura/foto-laura.png': PNG,
  'personas/marta/notas.md': '# Notas de Marta\n\nPalabra Jade.\n',
  'personas/noa/plan.md': '# Plan de Noa\n\nProyecto Ónice. [[compra]]\n',
  'personas/noa/Plan.md': '# Otro Plan de Noa\n\nÓnice dos.\n',
  'personas/antigua/nota.md': '# De nadie\n\nPalabra Cuarzo.\n',
  'admin/ajustes.md': '# Ajustes del admin\n\nPalabra Berilo. [[compra]]\n',
  'Plan.md': '# Plan raíz\n\nPalabra Berilo raíz.\n',
}
