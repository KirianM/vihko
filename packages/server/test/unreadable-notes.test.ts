// A note vihko can't read on the disk (no permission, an I/O error): it
// stopped vihko from starting, and every later rescan. Now it's left as the
// index had it, and the admins are told, with its path only where they read it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Alert } from '@vihko/core'
import { configFromEnv, start } from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

test('vihko starts with an unreadable note, and only the admin is told where it is', { skip: process.getuid?.() === 0 }, async () => {
  const dir = tempDir('vihko-unreadable-')
  const notesDir = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  const people = { admin: m.aUser({ role: 'admin' }), member: m.aUser({ role: 'member' }) }
  // One in the admin's own space, one in the member's: the admin manages, but doesn't read, the member's.
  const mine = m.aNotePath(`people/${people.admin.username}/${m.aFolder()}`)
  const theirs = m.aNotePath(`people/${people.member.username}`)
  const readable = m.aNotePath(`people/${people.admin.username}`)
  mkdirSync(notesDir)
  mkdirSync(stateDir)
  const config = configFromEnv({ VIHKO_NOTES_DIR: notesDir, VIHKO_STATE_DIR: stateDir, VIHKO_HOST: '127.0.0.1', VIHKO_PORT: '0', VIHKO_WEB_DIR: join(stateDir, 'no-ui'), VIHKO_RESCAN_SECONDS: '3600' })
  // The people first (their folders), then their notes, then vihko starts again over them.
  const first = await start(config)
  for (const u of Object.values(people)) await first.auth.createUser(u.username, u.password, u.role)
  await first.stop()
  for (const p of [mine, theirs, readable]) {
    mkdirSync(join(notesDir, dirname(p)), { recursive: true })
    writeFileSync(join(notesDir, p), `# ${m.aSentence()}\n`)
  }
  chmodSync(join(notesDir, mine), 0o000)
  chmodSync(join(notesDir, theirs), 0o000)
  const server = await start(config)
  try {
    const cookies: Record<string, string> = {}
    for (const [role, u] of Object.entries(people)) {
      const res = await server.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u.username, password: u.password }) })
      cookies[role] = res.headers.get('set-cookie')!.split(';')[0]!
    }
    const as = async (role: keyof typeof people, method: string, path: string, body?: unknown) => {
      const res = await server.app.request(path, { method, headers: { cookie: cookies[role]!, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: res.status, body: await res.json() as any }
    }
    const alerts = async (role: keyof typeof people) => ((await as(role, 'GET', '/api/alerts')).body.alerts as Alert[]).filter((a) => a.code === 'unreadable_notes')
    // A rescan goes through it too.
    const rescan = await as('admin', 'POST', '/api/admin/rescan', {})
    assert.equal(rescan.status, 200)
    const [a, ...more] = await alerts('admin')
    assert.equal(more.length, 0)
    assert.deepEqual(a, { code: 'unreadable_notes', paths: [mine], elsewhere: [`people/${people.member.username}`], actions: [] })
    assert.deepEqual(await alerts('member'), [])
    // The rest is indexed.
    const tree = (await as('admin', 'GET', '/api/tree')).body
    assert.ok(tree.notes.some((n: { path: string }) => n.path === readable))
    // Readable again: the alert goes at the next scan.
    chmodSync(join(notesDir, mine), 0o644)
    chmodSync(join(notesDir, theirs), 0o644)
    await as('admin', 'POST', '/api/admin/rescan', {})
    assert.deepEqual(await alerts('admin'), [])
  } finally {
    chmodSync(join(notesDir, mine), 0o644)
    chmodSync(join(notesDir, theirs), 0o644)
    await server.stop()
  }
})
