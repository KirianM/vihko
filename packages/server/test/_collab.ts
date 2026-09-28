// Utilities shared by the collaboration tests (real server as a separate process).
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import WebSocket from 'ws'
import type * as Y from 'yjs'
import { openLineage } from '../../web/src/editor/lineage.ts'
import { tempDir } from './_tmp.ts'
import { mother, type NewUser } from '../../../test/mother.ts'

const m = mother(import.meta.url)

export const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))
export const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let nextPort = 21000 + Math.floor(Math.random() * 5000)

export async function waitFor(cond: () => boolean | Promise<boolean>, what: string, timeout = 10000) {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > timeout) throw new Error(`timeout: ${what}`)
    await sleep(40)
  }
}

export interface Srv { proc: ChildProcess; base: string; out: string[]; env: Record<string, string>; stop(signal?: NodeJS.Signals): Promise<void> }

/** The admin each state folder was made with (makeDirs), who `login` signs in. */
const admins = new Map<string, NewUser>()

/** A copy of the test vault and a state with a new admin (the mother's), who `login(srv)` signs in. */
export function makeDirs() {
  const dir = tempDir('thoth-hub-')
  const notes = join(dir, 'notes')
  cpSync(VAULT, notes, { recursive: true })
  const env = { THOTH_NOTES_DIR: notes, THOTH_STATE_DIR: join(dir, 'state'), THOTH_HOST: '127.0.0.1', THOTH_PORT: String(nextPort++) }
  const admin = m.aUser({ role: 'admin' })
  spawnSync(process.execPath, [CLI, 'user', 'create', admin.username, '--admin'], { env: { ...process.env, ...env }, input: admin.password })
  admins.set(env.THOTH_STATE_DIR, admin)
  return { notes, env, admin }
}

/** The admin of a server's state folder (made by makeDirs). */
export function adminOf(srv: { env: Record<string, string> }): NewUser {
  const admin = admins.get(srv.env.THOTH_STATE_DIR!)
  if (!admin) throw new Error(`no admin made for ${srv.env.THOTH_STATE_DIR}`)
  return admin
}

export async function startServer(env: Record<string, string>): Promise<Srv> {
  const proc = spawn(process.execPath, [CLI, 'serve'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  // A test that times out never reaches its cleanup: the server dies with the test process anyway.
  process.once('exit', () => { if (proc.exitCode === null) proc.kill('SIGKILL') })
  const out: string[] = []
  proc.stdout!.on('data', (d) => out.push(d.toString()))
  proc.stderr!.on('data', (d) => out.push(d.toString()))
  await waitFor(() => out.join('').includes('listening'), 'server startup')
  return {
    proc, out, env,
    base: `http://127.0.0.1:${env.THOTH_PORT}`,
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      if (proc.exitCode !== null) return
      const done = new Promise((r) => proc.once('exit', r))
      proc.kill(signal)
      await done
    },
  }
}

/** Signs in someone (the admin makeDirs made, by default): their session cookie. */
export async function login(srv: Srv, who: { username: string; password: string } = adminOf(srv)): Promise<string> {
  const r = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: who.username, password: who.password }) })
  assert.equal(r.status, 200)
  return r.headers.get('set-cookie')!.split(';')[0]!
}

export interface Client { doc: Y.Doc; text(): string; close(): void; provider: HocuspocusProvider }
export const open: { destroy(): void }[] = []

/** One WebSocket that several documents can share, as the web UI does. */
export function socket(srv: Srv, cookie: string): HocuspocusProviderWebsocket {
  class AuthedWS extends WebSocket {
    constructor(url: string, protocols?: string | string[]) { super(url, protocols, { headers: { cookie } }) }
  }
  const ws = new HocuspocusProviderWebsocket({ url: srv.base.replace('http', 'ws') + '/collab', WebSocketPolyfill: AuthedWS })
  open.push(ws) // otherwise it retries and keeps the process alive
  return ws
}

/**
 * Opens `name` on its own socket, or on `shared` (then `close` leaves the
 * socket open), as the web UI does: claiming its copy's generation on every
 * reconnection, with its own session address on the socket.
 */
export async function connect(srv: Srv, cookie: string, name: string, shared?: HocuspocusProviderWebsocket): Promise<Client> {
  const websocketProvider = shared ?? socket(srv, cookie)
  const { doc, provider } = openLineage(websocketProvider, name)
  open.unshift(provider) // providers before their socket
  await waitFor(() => provider.isSynced, `sync of ${name}`)
  return { doc, provider, text: () => doc.getText('md').toString(), close: () => { provider.destroy(); if (!shared) websocketProvider.destroy() } }
}
export const closeAll = () => { for (const p of open.splice(0)) p.destroy() }

export function typeLine(c: Client, token: string) {
  const t = c.doc.getText('md')
  const s = t.toString()
  const i = s.lastIndexOf('\n', s.length - 2) + 1
  t.insert(i, token + '\n')
}

export const api = async (srv: Srv, cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(srv.base + path, { method, headers: { 'content-type': 'application/json', cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) as any }
}

