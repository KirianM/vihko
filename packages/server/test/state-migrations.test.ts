// state.db migrated when vihko starts: the admins are told, from which
// version to which and where the copy is, until one of them dismisses it
// (like vihko.yaml's rewrites, config-migrations.test.ts). A new database is
// no news. The old database is built as users.test.ts builds one: a current
// one with the tables and columns of later versions taken away.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { Alert } from '@vihko/core'
import { Profiles, STATE_VERSION, configFromEnv, dismissStateMigration, openState, start, stateMigrationAlerts, stateMigrations } from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** A state.db as version 5 left it (before groups, second factors, notices, languages and pins). */
function version5(file: string) {
  openState(file).close()
  const raw = new Database(file)
  raw.exec(`drop table pins; drop table notices; drop table recovery_codes; drop table two_factor; drop table user_links; drop table group_members; drop table user_groups;
    alter table users drop column deleted_at; alter table sessions drop column user_agent; alter table profiles drop column language;
    alter table profiles drop column on_open; alter table profiles drop column on_open_note;`)
  raw.pragma('user_version = 5')
  raw.close()
}

const aTime = () => new Date(Date.UTC(2026, 0, 1) + m.anInt(0, 3_000_000_000_000))

test('state.db: a migration of an existing database is recorded, with its copy; a new one is not; dismissing removes it', () => {
  const dir = tempDir('vihko-state-migrations-')
  const fresh = openState(join(dir, 'fresh.db'))
  assert.deepEqual(stateMigrations(fresh), [], 'a new database is no news')
  fresh.close()

  const file = join(dir, 'state.db')
  version5(file)
  const at = aTime()
  const db = openState(file, { now: () => at })
  const [r, ...more] = stateMigrations(db)
  assert.deepEqual(more, [])
  assert.ok(r)
  assert.deepEqual({ ...r, id: '' }, { id: '', from: 5, to: STATE_VERSION, at: at.toISOString(), backup: 'state.db.bak-v5' })
  assert.ok(existsSync(join(dir, r.backup)), 'the backup is where the alert says, in the same folder')
  assert.deepEqual(stateMigrationAlerts(db), [{ code: 'state_migrated', id: r.id, file: 'state.db', from: 5, to: STATE_VERSION, backup: 'state.db.bak-v5', at: at.toISOString(), actions: ['dismiss'] }])
  db.close()

  // Opened again (the server after a CLI command did the migration): still there, and nothing new.
  const again = openState(file)
  assert.deepEqual(stateMigrations(again).map((x) => x.id), [r.id])
  assert.equal(dismissStateMigration(again, m.anId()), false)
  assert.equal(dismissStateMigration(again, r.id), true)
  assert.equal(dismissStateMigration(again, r.id), false)
  assert.deepEqual(stateMigrationAlerts(again), [])
  again.close()
})

test('state.db: the copy put back (a rollback) takes the record away with it', () => {
  const dir = tempDir('vihko-state-migrations-')
  const file = join(dir, 'state.db')
  version5(file)
  openState(file).close()
  const copy = new Database(join(dir, 'state.db.bak-v5'), { readonly: true })
  assert.equal(copy.pragma('user_version', { simple: true }), 5)
  assert.equal((copy.prepare("select count(*) as n from settings where key like 'state.%'").get() as { n: number }).n, 0)
  copy.close()
  // Put back as the guide says: vihko opens it at version 5 again, with nothing to tell of before.
  const back = openState(join(dir, 'state.db.bak-v5'))
  assert.deepEqual(stateMigrations(back).map((r) => [r.from, r.to]), [[5, STATE_VERSION]], 'only the migration it goes through now')
  back.close()
})

test('startup: the server over an older state.db tells only the admin, until they dismiss it', async () => {
  const dir = tempDir('vihko-state-migrations-')
  const notesDir = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  mkdirSync(notesDir)
  mkdirSync(stateDir)
  version5(join(stateDir, 'state.db'))
  const logs: string[] = []
  const log = console.log
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')) }
  const config = configFromEnv({ VIHKO_NOTES_DIR: notesDir, VIHKO_STATE_DIR: stateDir, VIHKO_HOST: '127.0.0.1', VIHKO_PORT: '0', VIHKO_WEB_DIR: join(stateDir, 'no-ui'), VIHKO_RESCAN_SECONDS: '3600' })
  let server: Awaited<ReturnType<typeof start>>
  try {
    server = await start(config)
  } finally {
    console.log = log
  }
  try {
    assert.ok(logs.some((l) => l.includes(`state.db migrated from version 5 to ${STATE_VERSION}`)), logs.join('\n'))
    const people = { admin: m.aUser({ role: 'admin' }), member: m.aUser({ role: 'member' }) }
    const cookies: Record<string, string> = {}
    for (const [role, u] of Object.entries(people)) {
      await server.auth.createUser(u.username, u.password, u.role)
      const res = await server.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u.username, password: u.password }) })
      assert.equal(res.status, 200)
      cookies[role] = res.headers.get('set-cookie')!.split(';')[0]!
    }
    const as = async (role: keyof typeof people, method: string, path: string) => {
      const res = await server.app.request(path, { method, headers: { cookie: cookies[role]! } })
      return { status: res.status, body: await res.json() as any }
    }
    const migrated = ((await as('admin', 'GET', '/api/alerts')).body.alerts as Alert[]).filter((a) => a.code === 'state_migrated')
    assert.equal(migrated.length, 1)
    const a = migrated[0]!
    assert.ok(a.code === 'state_migrated')
    assert.deepEqual([a.file, a.from, a.to, a.backup], ['state.db', 5, STATE_VERSION, 'state.db.bak-v5'])
    assert.ok(existsSync(join(stateDir, a.backup)), 'the path is the one in the state volume')
    assert.deepEqual(((await as('member', 'GET', '/api/alerts')).body.alerts as Alert[]).filter((x) => x.code === 'state_migrated'), [])
    assert.equal((await as('member', 'DELETE', `/api/admin/state-migrations/${a.id}`)).status, 403)
    assert.equal((await as('admin', 'DELETE', `/api/admin/state-migrations/${a.id}`)).status, 200)
    assert.equal((await as('admin', 'DELETE', `/api/admin/state-migrations/${a.id}`)).status, 404)
    assert.deepEqual(((await as('admin', 'GET', '/api/alerts')).body.alerts as Alert[]).filter((x) => x.code === 'state_migrated'), [])
  } finally {
    await server.stop()
  }
})

test('startup: a new state volume raises no alert', async () => {
  const dir = tempDir('vihko-state-migrations-')
  const notesDir = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  mkdirSync(notesDir)
  const config = configFromEnv({ VIHKO_NOTES_DIR: notesDir, VIHKO_STATE_DIR: stateDir, VIHKO_HOST: '127.0.0.1', VIHKO_PORT: '0', VIHKO_WEB_DIR: join(dir, 'no-ui'), VIHKO_RESCAN_SECONDS: '3600' })
  const server = await start(config)
  try {
    assert.deepEqual(stateMigrationAlerts(server.auth.state), [])
  } finally {
    await server.stop()
  }
})

test('state.db: «Open today\'s note on start» of version 10 carries over as «On opening: today\'s note»', () => {
  const dir = tempDir('vihko-state-onopen-')
  const file = join(dir, 'state.db')
  openState(file).close()
  const raw = new Database(file)
  raw.exec('alter table profiles drop column on_open; alter table profiles drop column on_open_note;')
  const [daily, plain] = [m.aUsername(), m.aUsername()]
  for (const [id, name] of [['01A', daily], ['01B', plain]]) raw.prepare("insert into users (id, username, password_hash, role, created_at) values (?, ?, 'x', 'member', '2026-01-01T00:00:00Z')").run(id, name)
  raw.prepare('insert into profiles (user_id, open_daily) values (?, ?), (?, ?)').run('01A', 1, '01B', 0)
  raw.pragma('user_version = 10')
  raw.close()
  const db = openState(file)
  const profiles = new Profiles(db)
  assert.deepEqual([profiles.get('01A').onOpen, profiles.get('01B').onOpen], ['daily', 'home'])
  db.close()
})
