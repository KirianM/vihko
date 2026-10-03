// Each person's profile: timezone, daily-note preferences and the UI's language.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { LANGUAGES } from '@vihko/core'
import { CONFIG, DAILY, setup } from './_app.ts'
import { inShared } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

test('profiles: timezone and daily preferences, validated', async () => {
  const { admin, member } = await setup({ config: CONFIG })
  const zone = m.aTimeZone()
  const none = { timezone: null, dailySeries: null, onOpen: 'home', onOpenNote: null, openDailyOnStart: false, language: null, lastNote: null }
  assert.deepEqual((await admin('GET', '/api/profile')).body, none)
  assert.deepEqual((await admin('PUT', '/api/profile', { timezone: zone })).body, { ...none, timezone: zone })
  assert.deepEqual((await admin('PUT', '/api/profile', { dailySeries: DAILY.team.id, openDailyOnStart: true, role: 'admin' })).body, { ...none, timezone: zone, dailySeries: DAILY.team.id, onOpen: 'daily', openDailyOnStart: true })
  // Not a timezone, an offset instead of one, a path for a series id, a string for a boolean.
  for (const bad of [{ timezone: 'Mars/Base' }, { timezone: '+02:00' }, { dailySeries: '../x' }, { openDailyOnStart: 'yes' }]) {
    assert.deepEqual([(await admin('PUT', '/api/profile', bad)).status, (await admin('PUT', '/api/profile', bad)).body.error], [400, 'invalid'], JSON.stringify(bad))
  }
  assert.deepEqual((await member('GET', '/api/profile')).body.timezone, null, 'each person has their own')
})

test('profiles: the language of the UI, one of its translations or automatic (null)', async () => {
  const { admin, member, dir } = await setup({ config: CONFIG })
  const zone = m.aTimeZone()
  await admin('PUT', '/api/profile', { timezone: zone })
  const language = m.pick(LANGUAGES)
  const other = LANGUAGES.find((l) => l !== language)!
  const saved = await admin('PUT', '/api/profile', { language })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body, { timezone: zone, dailySeries: null, onOpen: 'home', onOpenNote: null, openDailyOnStart: false, language, lastNote: null }, 'only the language changes')
  assert.equal((await admin('GET', '/api/profile')).body.language, language)
  assert.equal((await member('GET', '/api/profile')).body.language, null, 'each person has their own; nobody chose = automatic')
  // Changing something else keeps it.
  assert.equal((await admin('PUT', '/api/profile', { openDailyOnStart: true })).body.language, language)
  assert.equal((await admin('PUT', '/api/profile', { language: other })).body.language, other)
  // A language the UI isn't translated into, a region, another type: refused, and nothing changes.
  for (const bad of [{ language: 'fr' }, { language: `${language}-${m.pick(['ES', 'US', 'GB'])}` }, { language: language.toUpperCase() }, { language: 1 }, { language: '' }]) {
    const r = await admin('PUT', '/api/profile', bad)
    assert.deepEqual([r.status, r.body.error], [400, 'invalid'], JSON.stringify(bad))
  }
  assert.equal((await admin('GET', '/api/profile')).body.language, other)
  // Back to automatic.
  assert.equal((await admin('PUT', '/api/profile', { language: null })).body.language, null)
  assert.equal((await admin('GET', '/api/profile')).body.language, null)
  // What the column holds is read through the same list: a value this version doesn't know (a
  // hand edit, a language only a later version has) is automatic, not an error.
  await admin('PUT', '/api/profile', { language })
  const db = new Database(join(dir, 'state.db'))
  try { db.prepare('update profiles set language = ?').run('xx') } finally { db.close() }
  assert.equal((await admin('GET', '/api/profile')).body.language, null)
})

test('profiles: «On opening» a note follows it when it is renamed or moved, alone or with its folder', async () => {
  const { admin, member } = await setup({ config: CONFIG })
  // testdata/vault's Plan.md (in the shared space), chosen by both.
  const note = inShared('Plan.md')
  for (const who of [admin, member]) assert.equal((await who('PUT', '/api/profile', { onOpen: 'note', onOpenNote: note })).status, 200)
  const [folder, renamed] = [m.aFolder(), `${m.aTitle()}.md`]
  const moved = inShared(`${folder}/${renamed}`)
  const r = await member('POST', '/api/note/move', { from: note, to: moved })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  for (const who of [admin, member]) assert.deepEqual(await who('GET', '/api/profile').then((x) => [x.body.onOpen, x.body.onOpenNote]), ['note', moved])
  // A dry run moves nothing, and changes nothing either.
  assert.equal((await member('POST', '/api/note/move', { from: moved, to: inShared(`${m.aTitle()}.md`), dryRun: true })).status, 200)
  assert.equal((await admin('GET', '/api/profile')).body.onOpenNote, moved)
  const other = m.aFolder()
  assert.equal((await admin('POST', '/api/folder/move', { from: inShared(folder), to: inShared(other) })).status, 200)
  for (const who of [admin, member]) assert.equal((await who('GET', '/api/profile')).body.onOpenNote, inShared(`${other}/${renamed}`))
})

test('profiles: «On opening»: home by default, the last note, today\'s, or a note the person reads', async () => {
  const { admin, member, users, dir } = await setup({ config: CONFIG })
  assert.equal((await admin('GET', '/api/profile')).body.onOpen, 'home')
  for (const onOpen of ['last', 'daily', 'home'] as const) {
    const r = await admin('PUT', '/api/profile', { onOpen })
    assert.deepEqual([r.status, r.body.onOpen, r.body.onOpenNote, r.body.openDailyOnStart], [200, onOpen, null, onOpen === 'daily'])
  }
  // A note: one they read, by its path; it stays while they choose it.
  const note = inShared('Plan.md')
  const chosen = await admin('PUT', '/api/profile', { onOpen: 'note', onOpenNote: note })
  assert.deepEqual([chosen.body.onOpen, chosen.body.onOpenNote], ['note', note])
  assert.equal((await admin('PUT', '/api/profile', { timezone: m.aTimeZone() })).body.onOpenNote, note)
  // Another choice forgets it.
  assert.equal((await admin('PUT', '/api/profile', { onOpen: 'last' })).body.onOpenNote, null)
  // What isn't valid: no note, not a note's path, an unknown choice.
  for (const bad of [{ onOpen: 'note' }, { onOpen: 'note', onOpenNote: '../x.md' }, { onOpen: 'note', onOpenNote: m.aFolder() }, { onOpen: 'tree' }, { onOpen: 1 }]) {
    const r = await admin('PUT', '/api/profile', bad)
    assert.deepEqual([r.status, r.body.error], [400, 'invalid'], JSON.stringify(bad))
  }
  // A note in someone else's own space: as missing.
  const theirs = `people/${users.member.username}/${m.aTitle()}.md`
  assert.equal((await admin('PUT', '/api/profile', { onOpen: 'note', onOpenNote: theirs })).status, 404)
  // One they could read once and can't now isn't shown: Home instead.
  const db = new Database(join(dir, 'state.db'))
  try { db.prepare("update profiles set on_open = 'note', on_open_note = ? where user_id = ?").run(theirs, users.admin.id) } finally { db.close() }
  const masked = (await admin('GET', '/api/profile')).body
  assert.deepEqual([masked.onOpen, masked.onOpenNote], ['home', null])
  // The switch it replaces still works: true is «daily», false turns «daily» back into home.
  assert.equal((await member('PUT', '/api/profile', { openDailyOnStart: true })).body.onOpen, 'daily')
  assert.equal((await member('PUT', '/api/profile', { openDailyOnStart: false })).body.onOpen, 'home')
})

/** A browser of one person: its cookies (the session and the device's), kept as a browser keeps them. */
function browser(app: Awaited<ReturnType<typeof setup>>['app'], who: { username: string; password: string }) {
  const jar = new Map<string, string>()
  const keep = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      // One under /api/auth (an earlier version's, removed) is another cookie: this jar keeps those of /api and above.
      if (/path=\/api\/auth/i.test(c)) continue
      const [pair] = c.split(';')
      const at = pair!.indexOf('=')
      const [name, value] = [pair!.slice(0, at), pair!.slice(at + 1)]
      if (value === '' || /max-age=0/i.test(c)) jar.delete(name)
      else jar.set(name, value)
    }
  }
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }, body: body === undefined ? undefined : JSON.stringify(body) })
    keep(res)
    return { status: res.status, body: await res.json().catch(() => null) as any }
  }
  return {
    send,
    signIn: async () => assert.equal((await send('POST', '/api/auth/login', { username: who.username, password: who.password })).status, 200),
    signOut: async () => assert.equal((await send('POST', '/api/auth/logout', {})).status, 200),
    cookies: () => new Map(jar),
  }
}

test('profiles: «On opening: Last note (on this device)» is kept in the account, per device: it outlives signing out, follows the note, and is never one the person can\'t read', async () => {
  const { app, users, member: asMember } = await setup({ config: CONFIG })
  const [laptop, phone] = [browser(app, users.admin), browser(app, users.admin)]
  await laptop.signIn()
  await phone.signIn()
  const [note, other] = [inShared('Plan.md'), `people/${users.admin.username}/${m.aTitle()}.md`]
  assert.equal((await laptop.send('POST', '/api/note', { path: other, text: `# ${m.aHeading()}\n` })).status, 201)
  assert.deepEqual((await laptop.send('PUT', '/api/profile/last-note', { path: note })).body, { lastNote: note })
  assert.equal((await phone.send('PUT', '/api/profile/last-note', { path: other })).status, 200)
  // Each device its own.
  assert.equal((await laptop.send('GET', '/api/profile')).body.lastNote, note)
  assert.equal((await phone.send('GET', '/api/profile')).body.lastNote, other)
  // Signing out and in again on the laptop: still there (the device keeps its id), and nothing of it in the browser but that id.
  const device = laptop.cookies().get('vihko_device')
  assert.ok(device)
  await laptop.signOut()
  assert.equal((await laptop.send('GET', '/api/profile')).status, 401)
  assert.ok([...laptop.cookies().values()].every((v) => !v.includes(note) && !v.includes(encodeURIComponent(note))))
  await laptop.signIn()
  assert.equal(laptop.cookies().get('vihko_device')!.split('.')[0], device.split('.')[0], 'the same device')
  assert.equal((await laptop.send('GET', '/api/profile')).body.lastNote, note)
  // Another browser, never used: none.
  const fresh = browser(app, users.admin)
  await fresh.signIn()
  assert.equal((await fresh.send('GET', '/api/profile')).body.lastNote, null)
  // The note moves: it follows.
  const moved = inShared(`${m.aFolder()}/${m.aTitle()}.md`)
  assert.equal((await asMember('POST', '/api/note/move', { from: note, to: moved })).status, 200)
  assert.equal((await laptop.send('GET', '/api/profile')).body.lastNote, moved)
  // One the person can't read: never recorded, and never given back (Home instead).
  const theirs = `people/${users.member.username}/${m.aTitle()}.md`
  assert.equal((await asMember('POST', '/api/note', { path: theirs, text: `# ${m.aHeading()}\n` })).status, 201)
  assert.equal((await laptop.send('PUT', '/api/profile/last-note', { path: theirs })).status, 404)
  for (const bad of [{ path: '../x.md' }, { path: m.aFolder() }, {}]) assert.equal((await laptop.send('PUT', '/api/profile/last-note', bad)).status, 400, JSON.stringify(bad))
  assert.equal((await laptop.send('GET', '/api/profile')).body.lastNote, moved)
  assert.equal((await laptop.send('DELETE', `/api/note?path=${encodeURIComponent(moved)}`)).status, 200)
  assert.equal((await laptop.send('GET', '/api/profile')).body.lastNote, null, 'deleted: Home')
})
