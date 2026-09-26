// Shared setup for the agent tests (keys over HTTP, the access filter and the
// leak tests): a small vault built for them, the history (managed, short
// timings), the API with keys, and two users signed in: noa (admin) and
// ana (member).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ApiKeys, Auth, History, Indexer, Integrations, NoteService, Profiles, Workspace, createServer, openIndex, openState, type Runtime } from '@thoth/server'

/** A 1×1 PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

export interface AgentSetup {
  files?: Record<string, string | Uint8Array>
  config?: string
  /** Locked off by the server's administrator (THOTH_INTEGRATIONS=off). */
  locked?: boolean
  now?: Date
}

export async function setup(opts: AgentSetup = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'thoth-agents-'))
  const notesDir = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  mkdirSync(notesDir, { recursive: true })
  for (const [p, content] of Object.entries(opts.files ?? {})) {
    if (p.endsWith('/')) { mkdirSync(join(notesDir, p), { recursive: true }); continue }
    mkdirSync(dirname(join(notesDir, p)), { recursive: true })
    writeFileSync(join(notesDir, p), content)
  }
  if (opts.config !== undefined) writeFileSync(join(notesDir, 'thoth.yaml'), opts.config)
  const index = openIndex(join(dir, 'index.db'))
  const state = openState(join(dir, 'state.db'))
  const auth = new Auth(state)
  const profiles = new Profiles(state)
  const users = { noa: await auth.createUser('noa', 'a-long-password', 'admin'), ana: await auth.createUser('ana', 'a-long-password', 'member') }
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
  const { app, services } = createServer({ auth, profiles, workspace, notes, index, indexer, notesDir, runtime, history, keys, integrations, now: () => clock.now })

  const cookies: Record<string, string> = {}
  for (const name of Object.keys(users)) {
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
    const buf = Buffer.from(await res.arrayBuffer())
    const text = buf.toString('utf8')
    let parsed: unknown = null
    try { parsed = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text, headers: res.headers }
  }
  /** A request with a user's session. */
  const as = (user: keyof typeof users) => (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    send(method, path, body, { cookie: cookies[user]!, ...headers })
  /** A request with a key (and no cookie, unless given). */
  const withKey = (token: string) => (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    send(method, path, body, { authorization: `Bearer ${token}`, ...headers })

  const noa = as('noa')
  /** A key of noa's, created through the API. */
  const newKey = async (input: Record<string, unknown>, who: keyof typeof users = 'noa') => {
    const r = await as(who)('POST', '/api/keys', input)
    if (r.status !== 201) throw new Error(`key: ${r.status} ${r.text}`)
    return r.body as { key: { id: string }; token: string }
  }
  const enableApi = async () => {
    const r = await noa('PUT', '/api/admin/integrations', { api: true })
    if (r.status !== 200) throw new Error(`switch: ${r.status} ${r.text}`)
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
  const close = async () => {
    await history.close()
    index.close()
    state.close()
  }
  return { dir, notesDir, index, app, services, cookies, auth, keys, integrations, history, notes, indexer, runtime, workspace, users, clock, as, noa, ana: as('ana'), withKey, newKey, enableApi, settle, url, close }
}
