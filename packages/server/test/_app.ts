// Shared setup for the vihko.yaml, profile and daily-note tests: a copy of the
// test vault in the shared space (_permissions.ts SHARED), two users signed in
// (an admin and a member) and an adjustable clock.
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Auth, Indexer, NoteService, Profiles, Workspace, createApp, openIndex, openState, type Runtime } from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { SHARED, inShared, withEveryone } from './_permissions.ts'
import { byNames, create, newPeople, type ByNames } from './_people.ts'
import { mother } from '../../../test/mother.ts'

const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))
const m = mother(import.meta.url)

/**
 * The workspace of the daily-note tests (CONFIG), its names the mother's: a
 * folder for templates (where the series' template is), a series of one's
 * own (in a folder per person, with a template) and a shared one, and the
 * attachments folder (relative to each note's space).
 */
export const DAILY = {
  templates: inShared(m.aFolder()),
  own: { id: m.anId(), label: m.aHeading(), folder: inShared(m.aFolder()), template: m.aTitle() },
  team: { id: m.anId(), folder: inShared(m.aFolder()) },
  attachments: m.aFolder(),
}

export const CONFIG = `# Workspace settings
daily:
  ${DAILY.own.id}:
    label: ${JSON.stringify(DAILY.own.label)}
    folder: ${JSON.stringify(`${DAILY.own.folder}/{user}`)}
    template: ${JSON.stringify(`${DAILY.templates}/${DAILY.own.template}`)}
  ${DAILY.team.id}:
    folder: ${JSON.stringify(DAILY.team.folder)}
attachments:
  folder: ${JSON.stringify(DAILY.attachments)}
`


export async function setup(opts: { config?: ByNames<string>; clock?: { now: Date }; moveWaitMs?: number } = {}) {
  const dir = tempDir('vihko-daily-')
  const notesDir = join(dir, 'notes')
  cpSync(VAULT, join(notesDir, SHARED), { recursive: true })
  mkdirSync(join(notesDir, DAILY.templates))
  const people = newPeople()
  const names = { admin: people.admin.username, member: people.member.username }
  // Both users see everything unless the test brings its own permissions (_permissions.ts).
  writeFileSync(join(notesDir, 'vihko.yaml'), withEveryone(opts.config === undefined ? undefined : byNames(opts.config, names), names.admin, names.member))
  const index = openIndex(join(dir, 'index.db'))
  const state = openState(join(dir, 'state.db'))
  const auth = new Auth(state)
  const profiles = new Profiles(state)
  const workspace = new Workspace({ notesDir })
  const indexer = new Indexer({ notesDir, db: index })
  const runtime: Runtime = { lastScan: null, rescan(o) { return (this.lastScan = indexer.scan(o)) } }
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db: index, attachments: () => workspace.config.attachments })
  const clock = opts.clock ?? { now: new Date('2026-09-24T23:30:00Z') }
  const app = createApp({ auth, profiles, workspace, notes, index, indexer, notesDir, runtime, now: () => clock.now, moveWaitMs: opts.moveWaitMs })
  const users = { admin: await create(auth, people.admin), member: await create(auth, people.member) }
  runtime.rescan({})
  const cookies = {} as Record<keyof typeof users, string>
  for (const role of Object.keys(users) as (keyof typeof users)[]) {
    const { username, password } = users[role]
    const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })
    cookies[role] = res.headers.get('set-cookie')!.split(';')[0]!
  }
  const as = (user: keyof typeof users) => async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie: cookies[user] }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json().catch(() => null) as any }
  }
  return { dir, notesDir, app, workspace, profiles, users, clock, runtime, admin: as('admin'), member: as('member') }
}
