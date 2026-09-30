// vihko.yaml rewritten to the current format when vihko starts (D-042.6):
// the runner over a notes folder and a state volume, and a whole server
// started over an old file. The migrations are the tests' own: vihko has none
// yet.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isMap, isScalar, type Document, type Pair, type Scalar, type YAMLMap } from 'yaml'
import type { Alert, WorkspaceMigration } from '@vihko/core'
import { BACKUP_DIR, ConfigMigrations, KEEP_BACKUPS, Workspace, configFromEnv, start } from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

const topPair = (doc: Document, key: string) => (isMap(doc.contents) ? (doc.contents as YAMLMap).items.find((p) => isScalar(p.key) && p.key.value === key) as Pair<Scalar> | undefined : undefined)

/** A made-up format change: the series were once under `dailyNotes`, and are `daily` now. */
const renameSeries: WorkspaceMigration = {
  id: 'daily-notes-renamed',
  description: 'dailyNotes is now daily',
  version: 2,
  apply(doc) {
    const old = topPair(doc, 'dailyNotes')
    if (!old || topPair(doc, 'daily')) return false
    old.key.value = 'daily'
    return true
  },
}

const SERIES = m.anId()
const FOLDER = m.aFolder()
/** An old file written by hand: comments where the README puts them, and a key vihko doesn't know. */
const OLD = `# Workspace settings
dailyNotes:                 # the series
  ${SERIES}:
    folder: ${JSON.stringify(FOLDER)}   # shared
someday: { a: 1,   b: 2 }   # unknown
`
/** The same, only the key renamed (its line's spacing and comment stay) and the format's version added under the header. */
const NEW = OLD.replace('dailyNotes:', 'version: 2\ndaily:')

function setup(text: string | null = OLD) {
  const dir = tempDir('vihko-config-migrations-')
  const notesDir = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  mkdirSync(notesDir)
  mkdirSync(stateDir)
  const file = join(notesDir, 'vihko.yaml')
  if (text !== null) writeFileSync(file, text)
  const logs: string[] = []
  let clock = Date.parse('2026-09-28T10:00:00Z')
  const runner = (migrations: readonly WorkspaceMigration[] = [renameSeries]) =>
    new ConfigMigrations({ notesDir, stateDir, migrations, log: (msg) => logs.push(msg), now: () => new Date(clock += 60_000) })
  const backups = () => (existsSync(join(stateDir, BACKUP_DIR)) ? readdirSync(join(stateDir, BACKUP_DIR)).filter((n) => n.startsWith('vihko.yaml.')).sort() : [])
  /** Everything in the notes folder, recursively. */
  const notesFiles = () => readdirSync(notesDir, { recursive: true }).map(String).sort()
  return { notesDir, stateDir, file, logs, runner, backups, notesFiles }
}

const codes = (alerts: Alert[]) => alerts.map((a) => a.code)

test('an old file is rewritten once: the new form, every other byte kept, atomically, with the copy in the state volume and nowhere in the notes', async () => {
  const s = setup()
  const inode = statSync(s.file).ino
  const r = s.runner()
  assert.equal(await r.run(), 'migrated')
  assert.equal(readFileSync(s.file, 'utf8'), NEW)
  // A new file renamed into place, never the old one written over.
  assert.notEqual(statSync(s.file).ino, inode)
  assert.deepEqual(s.notesFiles(), ['vihko.yaml'])
  const [copy, ...more] = s.backups()
  assert.equal(more.length, 0)
  assert.equal(readFileSync(join(s.stateDir, BACKUP_DIR, copy!), 'utf8'), OLD)
  // The log and the admins' alert say which migration and where the copy is.
  assert.equal(s.logs.length, 1)
  assert.match(s.logs[0]!, new RegExp(`${renameSeries.id}.*${renameSeries.description}.*${copy!.replace(/\./g, '\\.')}`))
  const alerts = r.alerts()
  assert.equal(alerts.length, 1)
  const a = alerts[0]!
  assert.ok(a.code === 'config_migrated')
  assert.deepEqual(a.migrations, [{ id: renameSeries.id, description: renameSeries.description }])
  assert.equal(a.backup, `${BACKUP_DIR}/${copy}`)
  assert.equal(a.file, 'vihko.yaml')
  assert.deepEqual(a.actions, ['dismiss'])

  // The next start: nothing applies, nothing is written or copied, and the alert is still there until dismissed.
  const again = s.runner()
  const mtime = statSync(s.file).mtimeMs
  assert.equal(await again.run(), 'none')
  assert.equal(readFileSync(s.file, 'utf8'), NEW)
  assert.equal(statSync(s.file).mtimeMs, mtime)
  assert.deepEqual(s.backups(), [copy])
  assert.deepEqual(codes(again.alerts()), ['config_migrated'])
  assert.equal(again.dismiss(a.id), true)
  assert.equal(again.dismiss(a.id), false)
  assert.deepEqual(again.alerts(), [])
  assert.deepEqual(s.runner().alerts(), [], 'dismissed for good')
})

test('nothing to migrate: no write, no copy, no alert, no log (no file, a current one, or no migrations at all)', async () => {
  for (const [text, migrations] of [[null, [renameSeries]], [NEW, [renameSeries]], [OLD, []]] as const) {
    const s = setup(text)
    const before = text === null ? null : statSync(s.file)
    const r = s.runner(migrations)
    assert.equal(await r.run(), 'none')
    if (before) {
      assert.equal(readFileSync(s.file, 'utf8'), text)
      assert.equal(statSync(s.file).ino, before.ino)
      assert.equal(statSync(s.file).mtimeMs, before.mtimeMs)
    } else assert.equal(existsSync(s.file), false)
    assert.deepEqual(s.backups(), [])
    assert.deepEqual(r.alerts(), [])
    assert.deepEqual(s.logs, [])
  }
})

test('only the latest copies are kept', async () => {
  const s = setup()
  const made: string[] = []
  for (let i = 0; i < KEEP_BACKUPS + 3; i++) {
    writeFileSync(s.file, OLD)
    assert.equal(await s.runner().run(), 'migrated')
    made.push(s.backups().find((n) => !made.includes(n))!)
  }
  assert.deepEqual(s.backups(), made.slice(-KEEP_BACKUPS))
})

test('a file that isn\'t valid YAML is left alone: a log line, and the workspace\'s own alert says why', async () => {
  const s = setup('dailyNotes: [unclosed\n')
  const r = s.runner()
  assert.equal(await r.run(), 'skipped')
  assert.equal(readFileSync(s.file, 'utf8'), 'dailyNotes: [unclosed\n')
  assert.deepEqual(s.backups(), [])
  assert.equal(s.logs.length, 1)
  assert.match(s.logs[0]!, /isn't valid YAML/)
  assert.deepEqual(r.alerts(), [])
  assert.ok(new Workspace({ notesDir: s.notesDir }).status.errors.length > 0, 'config_invalid is raised')
})

test('a migration that throws: nothing written or copied, a log line and an alert until a start succeeds', async () => {
  const s = setup()
  const detail = m.aSentence()
  const throws: WorkspaceMigration = { id: 'throws', description: m.aSentence(), version: 2, apply: () => { throw new Error(detail) } }
  const r = s.runner([renameSeries, throws])
  assert.equal(await r.run(), 'failed')
  assert.equal(readFileSync(s.file, 'utf8'), OLD)
  assert.deepEqual(s.backups(), [])
  assert.deepEqual(s.notesFiles(), ['vihko.yaml'])
  assert.equal(s.logs.length, 1)
  assert.ok(s.logs[0]!.includes(throws.id) && s.logs[0]!.includes(detail), s.logs.join('\n'))
  assert.deepEqual(r.alerts(), [{ code: 'config_migration_failed', file: 'vihko.yaml', migration: { id: throws.id, description: throws.description }, detail, actions: [] }])
  // Fixed in the next version: that start rewrites the file, and the failure is gone.
  const fixed = s.runner()
  assert.equal(await fixed.run(), 'migrated')
  assert.deepEqual(codes(fixed.alerts()), ['config_migrated'])
})

test('a file that can\'t be written (a read-only notes folder): left as it was, no copy kept, and an alert', { skip: process.getuid?.() === 0 && 'root writes anywhere' }, async () => {
  const s = setup()
  chmodSync(s.notesDir, 0o555)
  try {
    const r = s.runner()
    assert.equal(await r.run(), 'failed')
    assert.equal(readFileSync(s.file, 'utf8'), OLD)
    assert.deepEqual(s.backups(), [])
    const [a] = r.alerts()
    assert.ok(a?.code === 'config_migration_failed' && a.migration === null && a.detail.length > 0, JSON.stringify(a))
  } finally {
    chmodSync(s.notesDir, 0o755)
  }
})

test('startup: the server applies the migrated file, and only the admin sees the alert until they dismiss it', async () => {
  const s = setup()
  const config = configFromEnv({ VIHKO_NOTES_DIR: s.notesDir, VIHKO_STATE_DIR: s.stateDir, VIHKO_HOST: '127.0.0.1', VIHKO_PORT: '0', VIHKO_WEB_DIR: join(s.stateDir, 'no-ui'), VIHKO_RESCAN_SECONDS: '3600' })
  const server = await start(config, { workspaceMigrations: [renameSeries] })
  try {
    assert.equal(readFileSync(s.file, 'utf8'), NEW)
    assert.deepEqual(server.workspace.config.daily.map((d) => d.id), [SERIES])
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
    assert.deepEqual((await as('admin', 'GET', '/api/workspace')).body.daily.map((d: { id: string }) => d.id), [SERIES])
    const migrated = ((await as('admin', 'GET', '/api/alerts')).body.alerts as Alert[]).filter((a) => a.code === 'config_migrated')
    assert.equal(migrated.length, 1)
    const a = migrated[0]!
    assert.ok(a.code === 'config_migrated')
    assert.deepEqual(a.migrations.map((x) => x.id), [renameSeries.id])
    assert.ok(existsSync(join(s.stateDir, a.backup)) && !relative(s.stateDir, join(s.stateDir, a.backup)).startsWith('..'))
    assert.deepEqual(((await as('member', 'GET', '/api/alerts')).body.alerts as Alert[]).filter((x) => x.code.startsWith('config_migrat')), [])
    assert.equal((await as('member', 'DELETE', `/api/admin/config-migrations/${a.id}`)).status, 403)
    assert.equal((await as('admin', 'DELETE', `/api/admin/config-migrations/${a.id}`)).status, 200)
    assert.equal((await as('admin', 'DELETE', `/api/admin/config-migrations/${a.id}`)).status, 404)
    assert.deepEqual(((await as('admin', 'GET', '/api/alerts')).body.alerts as Alert[]).filter((x) => x.code === 'config_migrated'), [])
  } finally {
    await server.stop()
  }
})
