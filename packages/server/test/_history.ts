// Shared setup for the history tests that run in-process: a copy of the test
// vault in the shared space (_permissions.ts SHARED), the recorder with short timings, the note service and the API, two
// users signed in: an admin and a member (new ones for every folder, _people.ts). The collaboration hub isn't here (history-hub.test.ts runs
// a real server for what the editor does).
import { chmodSync, cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Auth, History, Indexer, NoteService, Profiles, Workspace, createApp, openIndex, openState, type Runtime } from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { SHARED, withEveryone } from './_permissions.ts'
import { byNames, create, newPeople, type ByNames, type Person } from './_people.ts'

export const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The people of each folder a setup made: a restart (`dir`) signs the same ones in. */
const peopleOf = new Map<string, { admin: Person; member: Person }>()

export interface HistorySetup {
  /** Before anything starts: files to add to the vault copy (a function of the people's usernames when they name them). */
  files?: ByNames<Record<string, string | Uint8Array>>
  /** vihko.yaml (a function of the people's usernames when it names them). */
  config?: ByNames<string>
  git?: string
  /** Reuse a folder from an earlier setup (a restart). */
  dir?: string
  quietMs?: number
  maxOpenMs?: number
  /** Commits waiting for git before the oldest are merged. */
  queueMax?: number
  /** Commits between two `git gc --auto`. */
  gcEvery?: number
  /** Before anything starts, once the files are there (the user's own git repository, say). */
  prepare?: (dirs: { dir: string; notesDir: string }) => void
  /** The history's clock (ms): when its versions say they were made. */
  now?: () => number
}

export async function setup(opts: HistorySetup = {}) {
  const fresh = opts.dir === undefined
  const dir = opts.dir ?? tempDir('vihko-history-')
  const notesDir = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  const people = fresh ? newPeople() : peopleOf.get(dir)!
  const names = { admin: people.admin.username, member: people.member.username }
  if (fresh) {
    cpSync(VAULT, join(notesDir, SHARED), { recursive: true })
    for (const [p, content] of Object.entries(byNames(opts.files ?? {}, names))) {
      mkdirSync(join(notesDir, p, '..'), { recursive: true })
      writeFileSync(join(notesDir, p), content)
    }
    // Both users see everything unless the test brings its own permissions (_permissions.ts).
    writeFileSync(join(notesDir, 'vihko.yaml'), withEveryone(opts.config === undefined ? undefined : byNames(opts.config, names), names.admin, names.member))
    opts.prepare?.({ dir, notesDir })
  }
  const index = openIndex(join(dir, 'index.db'))
  const state = openState(join(dir, 'state.db'))
  const auth = new Auth(state)
  const users = fresh ? { admin: await create(auth, people.admin), member: await create(auth, people.member) } : peopleOf.get(dir)!
  peopleOf.set(dir, users)
  const workspace = new Workspace({ notesDir })
  const indexer = new Indexer({ notesDir, db: index })
  const runtime: Runtime = { lastScan: null, rescan(o) { return (this.lastScan = indexer.scan(o)) } }
  runtime.rescan({})
  const logs: string[] = []
  const history = new History({
    notesDir, stateDir, config: () => workspace.config.history, git: opts.git,
    quietMs: opts.quietMs ?? 150, maxOpenMs: opts.maxOpenMs ?? 60_000, tickMs: 20, retryMs: 50, queueMax: opts.queueMax, gcEvery: opts.gcEvery, now: opts.now,
    nameOf: (a) => (a.kind === 'user' ? auth.username(a.id) ?? a.id : a.kind), log: (m) => logs.push(m),
  })
  await history.open()
  await history.start()
  // The first commit (or the startup sweep) leaves start() queued: a test reading the history right away must find it.
  await history.recorder.settle()
  indexer.onApplied = (a) => history.recorder.observeIndexed(a)
  const notes = new NoteService({ notesDir, stateDir, indexer, db: index, history: history.recorder, attachments: () => workspace.config.attachments })
  const app = createApp({ auth, profiles: new Profiles(state), workspace, notes, index, indexer, notesDir, runtime, history })
  type Role = keyof typeof users
  const cookies = {} as Record<Role, string>
  for (const role of Object.keys(users) as Role[]) {
    const { username, password } = users[role]
    const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })
    cookies[role] = res.headers.get('set-cookie')!.split(';')[0]!
  }
  const as = (user: Role) => async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie: cookies[user], ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json().catch(() => null) as any, headers: res.headers }
  }
  const admin = as('admin')
  const ids = { admin: users.admin.id, member: users.member.id }
  const q = (s: string) => encodeURIComponent(s)
  /** Everything open becomes a version and reaches git. */
  const settle = async () => {
    history.recorder.closeAll()
    await history.recorder.settle()
  }
  const versions = async (path: string, extra = '') => {
    const r = await admin('GET', `/api/history/versions?path=${q(path)}${extra}`)
    if (r.status !== 200) throw new Error(`versions of ${path}: ${r.status} ${JSON.stringify(r.body)}`)
    return r.body as { versions: any[]; next: string | null; pending: any; excluded: boolean }
  }
  const changes = async (extra = '', who: Role = 'admin') => {
    const r = await as(who)('GET', `/api/history/changes?limit=100${extra}`)
    if (r.status !== 200) throw new Error(`changes: ${r.status} ${JSON.stringify(r.body)}`)
    return r.body as { changes: any[]; next: string | null; authors: any[] }
  }
  const put = async (path: string, edit: (t: string) => string, who: Role = 'admin') => {
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
  return { dir, notesDir, stateDir, app, history, notes, indexer, workspace, auth, state, users, ids, logs, admin, member: as('member'), settle, versions, changes, put, close, q }
}

/** A git that fails while `flag` exists (a broken repository, a full disk…). */
export function flakyGit(dir: string): { git: string; flag: string } {
  const flag = join(dir, 'git-broken')
  const git = join(dir, 'git-wrapper.sh')
  writeFileSync(git, `#!/bin/sh\nif [ -e '${flag}' ]; then echo 'simulated failure' >&2; exit 1; fi\nexec git "$@"\n`)
  chmodSync(git, 0o755)
  return { git, flag }
}

/** Author kinds and names of a version, for short asserts: `user:<name>`, `system`, `external`. */
export const who = (v: { authors: { kind: string; name: string }[] }) => v.authors.map((a) => (a.kind === 'user' ? `user:${a.name}` : a.kind)).join(',')
