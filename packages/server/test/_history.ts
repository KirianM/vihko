// Shared setup for the history tests that run in-process: a copy of the test
// vault, the recorder with short timings, the note service and the API, two
// users signed in. The collaboration hub isn't here (history-hub.test.ts runs
// a real server for what the editor does).
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Auth, History, Indexer, NoteService, Profiles, Workspace, createApp, openIndex, openState, type Runtime, type User } from '@thoth/server'

export const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface HistorySetup {
  /** Before anything starts: files to add to the vault copy. */
  files?: Record<string, string | Uint8Array>
  config?: string
  git?: string
  canRead?: (user: User, path: string) => boolean
  /** Reuse a folder from an earlier setup (a restart). */
  dir?: string
  quietMs?: number
  maxOpenMs?: number
  /** Commits waiting for git before the oldest are merged. */
  queueMax?: number
  /** Before anything starts, once the files are there (the user's own git repository, say). */
  prepare?: (dirs: { dir: string; notesDir: string }) => void
}

export async function setup(opts: HistorySetup = {}) {
  const fresh = opts.dir === undefined
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'thoth-history-'))
  const notesDir = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  if (fresh) {
    cpSync(VAULT, notesDir, { recursive: true })
    for (const [p, content] of Object.entries(opts.files ?? {})) {
      mkdirSync(join(notesDir, p, '..'), { recursive: true })
      writeFileSync(join(notesDir, p), content)
    }
    if (opts.config !== undefined) writeFileSync(join(notesDir, 'thoth.yaml'), opts.config)
    opts.prepare?.({ dir, notesDir })
  }
  const index = openIndex(join(dir, 'index.db'))
  const state = openState(join(dir, 'state.db'))
  const auth = new Auth(state)
  const users = fresh
    ? { noa: await auth.createUser('noa', 'a-long-password', 'admin'), ana: await auth.createUser('ana', 'a-long-password', 'member') }
    : null
  const workspace = new Workspace({ notesDir })
  const indexer = new Indexer({ notesDir, db: index })
  const runtime: Runtime = { lastScan: null, rescan(o) { return (this.lastScan = indexer.scan(o)) } }
  runtime.rescan({})
  const logs: string[] = []
  const history = new History({
    notesDir, stateDir, config: () => workspace.config.history, git: opts.git,
    quietMs: opts.quietMs ?? 150, maxOpenMs: opts.maxOpenMs ?? 60_000, tickMs: 20, retryMs: 50, queueMax: opts.queueMax,
    nameOf: (a) => (a.kind === 'user' ? auth.username(a.id) ?? a.id : a.kind), log: (m) => logs.push(m),
  })
  await history.open()
  await history.start()
  // The first commit (or the startup sweep) leaves start() queued: a test reading the history right away must find it.
  await history.recorder.settle()
  indexer.onApplied = (a) => history.recorder.observeIndexed(a)
  const notes = new NoteService({ notesDir, stateDir, indexer, db: index, history: history.recorder, attachments: () => workspace.config.attachments })
  const app = createApp({ auth, profiles: new Profiles(state), workspace, notes, index, indexer, notesDir, runtime, history, canRead: opts.canRead })
  const cookies: Record<string, string> = {}
  for (const name of ['noa', 'ana']) {
    const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: 'a-long-password' }) })
    cookies[name] = res.headers.get('set-cookie')!.split(';')[0]!
  }
  const as = (user: 'noa' | 'ana') => async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie: cookies[user]!, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json().catch(() => null) as any, headers: res.headers }
  }
  const noa = as('noa')
  const ids = { noa: users?.noa.id ?? idOf(state, 'noa'), ana: users?.ana.id ?? idOf(state, 'ana') }
  const q = (s: string) => encodeURIComponent(s)
  /** Everything open becomes a version and reaches git. */
  const settle = async () => {
    history.recorder.closeAll()
    await history.recorder.settle()
  }
  const versions = async (path: string, extra = '') => {
    const r = await noa('GET', `/api/history/versions?path=${q(path)}${extra}`)
    if (r.status !== 200) throw new Error(`versions of ${path}: ${r.status} ${JSON.stringify(r.body)}`)
    return r.body as { versions: any[]; next: string | null; pending: any; excluded: boolean }
  }
  const changes = async (extra = '', who: 'noa' | 'ana' = 'noa') => {
    const r = await as(who)('GET', `/api/history/changes?limit=100${extra}`)
    if (r.status !== 200) throw new Error(`changes: ${r.status} ${JSON.stringify(r.body)}`)
    return r.body as { changes: any[]; next: string | null; authors: any[] }
  }
  const put = async (path: string, edit: (t: string) => string, who: 'noa' | 'ana' = 'noa') => {
    const cur = await as(who)('GET', `/api/note?path=${q(path)}`)
    const r = await as(who)('PUT', `/api/note?path=${q(path)}`, { text: edit(cur.body.text) }, { 'if-match': `"${cur.body.etag}"` })
    if (r.status !== 200) throw new Error(`put ${path}: ${r.status} ${JSON.stringify(r.body)}`)
    return r.body
  }
  const close = async () => {
    await history.close()
    index.close()
    state.close()
  }
  return { dir, notesDir, stateDir, app, history, notes, indexer, workspace, auth, ids, logs, noa, ana: as('ana'), settle, versions, changes, put, close, q }
}

function idOf(state: ReturnType<typeof openState>, username: string): string {
  return (state.prepare('select id from users where username = ?').get(username) as { id: string }).id
}

/** A git that fails while `flag` exists (a broken repository, a full disk…). */
export function flakyGit(dir: string): { git: string; flag: string } {
  const flag = join(dir, 'git-broken')
  const git = join(dir, 'git-wrapper.sh')
  writeFileSync(git, `#!/bin/sh\nif [ -e '${flag}' ]; then echo 'simulated failure' >&2; exit 1; fi\nexec git "$@"\n`)
  chmodSync(git, 0o755)
  return { git, flag }
}

/** Author kinds and names of a version, for short asserts: `user:noa`, `system`, `external`. */
export const who = (v: { authors: { kind: string; name: string }[] }) => v.authors.map((a) => (a.kind === 'user' ? `user:${a.name}` : a.kind)).join(',')
