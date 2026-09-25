// Shared setup for the thoth.yaml, profile and daily-note tests: a copy of the
// test vault, two users signed in and an adjustable clock.
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Auth, Indexer, NoteService, Profiles, Workspace, createApp, openIndex, openState, type Runtime } from '@thoth/server'

const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))

export const CONFIG = `# Workspace settings
templates: Plantillas
daily:
  diario:
    label: Diario
    folder: Diario/{user}
    template: Plantillas/Diario
  equipo:
    folder: Equipo
attachments:
  folder: Adjuntos
`


export async function setup(opts: { config?: string; clock?: { now: Date } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'thoth-daily-'))
  const notesDir = join(dir, 'notes')
  cpSync(VAULT, notesDir, { recursive: true })
  mkdirSync(join(notesDir, 'Plantillas'))
  if (opts.config !== undefined) writeFileSync(join(notesDir, 'thoth.yaml'), opts.config)
  const index = openIndex(join(dir, 'index.db'))
  const state = openState(join(dir, 'state.db'))
  const auth = new Auth(state)
  const profiles = new Profiles(state)
  const workspace = new Workspace({ notesDir })
  const indexer = new Indexer({ notesDir, db: index })
  const runtime: Runtime = { lastScan: null, rescan(o) { return (this.lastScan = indexer.scan(o)) } }
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db: index, attachmentsFolder: () => workspace.config.attachments.folder })
  const clock = opts.clock ?? { now: new Date('2026-09-24T23:30:00Z') }
  const app = createApp({ auth, profiles, workspace, notes, index, indexer, notesDir, runtime, now: () => clock.now })
  const users = { noa: await auth.createUser('noa', 'a-long-password', 'admin'), ana: await auth.createUser('ana', 'a-long-password', 'member') }
  runtime.rescan({})
  const cookies: Record<string, string> = {}
  for (const name of Object.keys(users)) {
    const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: 'a-long-password' }) })
    cookies[name] = res.headers.get('set-cookie')!.split(';')[0]!
  }
  const as = (user: keyof typeof users) => async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie: cookies[user]! }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json().catch(() => null) as any }
  }
  return { dir, notesDir, app, workspace, profiles, users, clock, runtime, noa: as('noa'), ana: as('ana') }
}

