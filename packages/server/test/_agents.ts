// Shared setup for the agent tests (keys over HTTP, the access filter and the
// leak tests): a small vault built for them, the history (managed, short
// timings), the API with keys, and two users signed in: an admin and a
// member (new ones every time, _people.ts).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ApiKeys, Auth, History, Indexer, Integrations, NoteService, Profiles, Workspace, createServer, mountMcp, openIndex, openState, toolData, type ClientMetadataFetcher, type Runtime } from '@vihko/server'
import { Client, StreamableHTTPClientTransport, type VersionNegotiationMode } from '@modelcontextprotocol/client'
import { tempDir } from './_tmp.ts'
import { withEveryone } from './_permissions.ts'
import { byNames, create, newPeople, type ByNames } from './_people.ts'

/** A 1×1 PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

export interface AgentSetup {
  /** Files to add (a function of the people's usernames when their paths or texts name them). */
  files?: ByNames<Record<string, string | Uint8Array>>
  /** vihko.yaml (a function of the people's usernames when it names them). */
  config?: ByNames<string>
  /** Locked off by the server's administrator (VIHKO_INTEGRATIONS=off). */
  locked?: boolean
  now?: Date
  /** VIHKO_PUBLIC_URL: with it, OAuth for the MCP server (while it's on). */
  publicUrl?: string
  /** A stand-in for the built UI (one index.html), for the pages the UI serves. */
  ui?: boolean
  /** Fetches OAuth clients' metadata documents (tests that reach a local HTTPS server). */
  clientMetadata?: ClientMetadataFetcher
}

export async function setup(opts: AgentSetup = {}) {
  const dir = tempDir('vihko-agents-')
  const notesDir = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  mkdirSync(notesDir, { recursive: true })
  const people = newPeople()
  const names = { admin: people.admin.username, member: people.member.username }
  for (const [p, content] of Object.entries(byNames(opts.files ?? {}, names))) {
    if (p.endsWith('/')) { mkdirSync(join(notesDir, p), { recursive: true }); continue }
    mkdirSync(dirname(join(notesDir, p)), { recursive: true })
    writeFileSync(join(notesDir, p), content)
  }
  // Both users see everything unless the test brings its own permissions (_permissions.ts).
  writeFileSync(join(notesDir, 'vihko.yaml'), withEveryone(opts.config === undefined ? undefined : byNames(opts.config, names), names.admin, names.member))
  const index = openIndex(join(dir, 'index.db'))
  const state = openState(join(dir, 'state.db'))
  const auth = new Auth(state)
  const profiles = new Profiles(state)
  const users = { admin: await create(auth, people.admin), member: await create(auth, people.member) }
  const workspace = new Workspace({ notesDir })
  const indexer = new Indexer({ notesDir, db: index })
  const runtime: Runtime = { lastScan: null, rescan(o) { return (this.lastScan = indexer.scan(o)) } }
  runtime.rescan({})
  const keys = new ApiKeys(state)
  const integrations = new Integrations(state, { locked: opts.locked })
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
  const clock = { now: opts.now ?? new Date('2026-09-26T10:00:00Z') }
  let webDir: string | undefined
  if (opts.ui) {
    webDir = join(dir, 'web')
    mkdirSync(webDir)
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>')
  }
  const { app, services } = createServer({
    auth, profiles, workspace, notes, index, indexer, notesDir, runtime, history, keys, integrations, now: () => clock.now, publicUrl: opts.publicUrl ?? null, webDir, clientMetadata: opts.clientMetadata,
    routes: (a, s) => { mountMcp(a, s, { auth, workspace, pollMs: 25 }) },
  })

  const cookies = {} as Record<keyof typeof users, string>
  for (const role of Object.keys(users) as (keyof typeof users)[]) {
    const { username, password } = users[role]
    const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })
    cookies[role] = res.headers.get('set-cookie')!.split(';')[0]!
  }

  interface Res { status: number; body: any; text: string; headers: Headers }
  const send = async (method: string, path: string, body: unknown, headers: Record<string, string>): Promise<Res> => {
    const raw = body instanceof Uint8Array
    const res = await app.request(path, {
      method,
      headers: { ...(raw ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : raw ? new Blob([new Uint8Array(body)]) : JSON.stringify(body),
    })
    const buf = Buffer.from(await res.arrayBuffer())
    const text = buf.toString('utf8')
    let parsed: unknown = null
    try { parsed = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text, headers: res.headers }
  }
  /** A request with a user's session. */
  const as = (user: keyof typeof users) => (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    send(method, path, body, { cookie: cookies[user], ...headers })
  /** A request with a key (and no cookie, unless given). */
  const withKey = (token: string) => (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    send(method, path, body, { authorization: `Bearer ${token}`, ...headers })

  const admin = as('admin')
  /** A key of the admin's (or `who`'s), created through the API. */
  const newKey = async (input: Record<string, unknown>, who: keyof typeof users = 'admin') => {
    const r = await as(who)('POST', '/api/keys', { confirm: users[who].password, ...input })
    if (r.status !== 201) throw new Error(`key: ${r.status} ${r.text}`)
    return r.body as { key: { id: string }; token: string }
  }
  const enableApi = async () => {
    const r = await admin('PUT', '/api/admin/integrations', { api: true })
    if (r.status !== 200) throw new Error(`switch: ${r.status} ${r.text}`)
  }
  const enableMcp = async (on = true) => {
    const r = await admin('PUT', '/api/admin/integrations', { mcp: on })
    if (r.status !== 200) throw new Error(`switch: ${r.status} ${r.text}`)
  }
  /**
   * The SDK's client, connected with a key to this app's /mcp (in process:
   * its requests go to the app, not the network). `mode`: the protocol era.
   */
  const mcp = async (token: string, mode: VersionNegotiationMode = 'auto') => {
    const client = new Client({ name: 'vihko-tests', version: '1' }, { versionNegotiation: { mode } })
    const transport = new StreamableHTTPClientTransport(new URL('http://vihko.test/mcp'), {
      fetch: (u, init) => Promise.resolve(app.request(String(u), init)),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
    await client.connect(transport)
    /** A tool's result: its JSON data (the first block, `head` as it came), the note texts after it, and whether it's an error. */
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args }) as { content: { type: string; text: string }[]; isError?: boolean }
      const [first, ...rest] = r.content
      let data: any = null
      try { data = toolData(first?.text ?? 'null') } catch { data = first?.text }
      return { data, head: first?.text ?? '', texts: rest.map((c) => c.text), error: r.isError === true, raw: JSON.stringify(r) }
    }
    return { client, call, close: () => client.close() }
  }
  /** Everything open becomes a version and reaches git. */
  const settle = async () => {
    history.recorder.closeAll()
    await history.recorder.settle()
  }
  const url = (path: string, params: Record<string, string> = {}) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) q.set(k, v)
    const s = q.toString()
    return s ? `${path}?${s}` : path
  }
  /** Stops everything and removes the folder (a test run shouldn't leave its vault in /tmp). */
  const close = async () => {
    await history.close()
    index.close()
    state.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return { dir, notesDir, index, app, services, cookies, auth, keys, integrations, history, notes, indexer, runtime, workspace, users, clock, as, admin, member: as('member'), withKey, newKey, enableApi, enableMcp, mcp, settle, url, close }
}
