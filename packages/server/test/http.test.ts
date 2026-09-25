import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { Auth, Indexer, NoteService, SESSION_COOKIE, STATE_VERSION, createApp, ftsQuery, hashPassword, openIndex, openState, verifyPassword, type Runtime } from '@thoth/server'

const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))

async function setup(opts: { webDir?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'thoth-http-'))
  const notesDir = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  cpSync(VAULT, notesDir, { recursive: true })
  const index = openIndex(join(dir, 'index.db'))
  const state = openState(join(dir, 'state.db'))
  const auth = new Auth(state)
  const indexer = new Indexer({ notesDir, db: index })
  const runtime: Runtime = { lastScan: null, rescan(force) { return (this.lastScan = indexer.scan({ force })) } }
  runtime.rescan(false)
  const notes = new NoteService({ notesDir, stateDir, indexer, db: index })
  const app = createApp({ auth, notes, index, indexer, notesDir, runtime, webDir: opts.webDir })
  let cookie = ''
  const raw = (path: string) => app.request(path, { headers: { cookie } })
  const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const set = res.headers.get('set-cookie')
    if (set?.startsWith(SESSION_COOKIE + '=')) cookie = set.split(';')[0]!
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) as any }
  }
  return { dir, notesDir, auth, req, raw, runtime }
}

test('contraseñas: scrypt, verificación y rechazo', async () => {
  const h = await hashPassword('una contraseña larga')
  assert.match(h, /^scrypt\$32768\$8\$1\$/)
  assert.ok(await verifyPassword('una contraseña larga', h))
  assert.ok(!(await verifyPassword('otra', h)))
  assert.notEqual(await hashPassword('x'.repeat(12)), await hashPassword('x'.repeat(12)), 'sal aleatoria')
})

test('primer arranque: token de un solo uso para crear el admin', async () => {
  const { auth, req } = await setup()
  assert.deepEqual((await req('GET', '/api/setup')).body, { needed: true })
  const token = auth.setupToken()!
  const bad = await req('POST', '/api/setup', { token: 'malo', username: 'noa', password: 'contraseña-larga' })
  assert.deepEqual([bad.status, bad.body.error], [400, 'invalid_token'])
  const weak = await req('POST', '/api/setup', { token, username: 'noa', password: 'corta' })
  assert.deepEqual([weak.status, weak.body.error], [400, 'weak_password'])
  const ok = await req('POST', '/api/setup', { token, username: 'noa', password: 'contraseña-larga' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.user.role, 'admin')
  const again = await req('POST', '/api/setup', { token, username: 'otro', password: 'contraseña-larga' })
  assert.deepEqual([again.status, again.body.error], [409, 'already_setup'], 'el token se consume')
  assert.deepEqual((await req('GET', '/api/setup')).body, { needed: false })
})

test('todo exige sesión salvo la salud; login, sesión y logout', async () => {
  const { auth, req } = await setup()
  assert.deepEqual((await req('GET', '/api/health')).body, { ok: true })
  await auth.createUser('noa', 'contraseña-larga', 'admin')
  for (const p of ['/api/tree', '/api/note?path=Plan.md', '/api/search?q=plan', '/api/alerts', '/api/auth/me']) {
    assert.equal((await req('GET', p)).status, 401, p)
  }
  assert.equal((await req('POST', '/api/auth/login', { username: 'noa', password: 'mala-contraseña' })).status, 401)
  assert.equal((await req('POST', '/api/auth/login', { username: 'nadie', password: 'contraseña-larga' })).status, 401)
  const login = await req('POST', '/api/auth/login', { username: 'NOA', password: 'contraseña-larga' })
  assert.equal(login.status, 200, 'usuario sin distinguir mayúsculas')
  assert.match(login.headers.get('set-cookie')!, /HttpOnly/)
  assert.match(login.headers.get('set-cookie')!, /SameSite=Lax/)
  assert.doesNotMatch(login.headers.get('set-cookie')!, /Secure/, 'por HTTP en LAN la cookie no puede ser Secure')
  assert.equal((await req('GET', '/api/auth/me')).body.user.username, 'noa')
  await req('POST', '/api/auth/logout')
  assert.equal((await req('GET', '/api/auth/me')).status, 401)
})

test('notas por HTTP: leer, crear, escribir con If-Match, mover y borrar', async () => {
  const { auth, req } = await setup()
  await auth.createUser('noa', 'contraseña-larga', 'admin')
  await req('POST', '/api/auth/login', { username: 'noa', password: 'contraseña-larga' })

  const tree = await req('GET', '/api/tree')
  assert.ok(tree.body.notes.some((n: { path: string }) => n.path === 'Plan.md'))

  const plan = await req('GET', '/api/note?path=Plan.md')
  assert.equal(plan.status, 200)
  assert.equal(plan.headers.get('etag'), `"${plan.body.etag}"`)

  assert.equal((await req('PUT', '/api/note?path=Plan.md', { text: 'x' })).status, 428, 'sin If-Match no se sobrescribe')
  const stale = await req('PUT', '/api/note?path=Plan.md', { text: 'x' }, { 'if-match': '"sha256:viejo"' })
  assert.equal(stale.status, 412)
  assert.equal(stale.body.etag, plan.body.etag, 'el 412 devuelve el ETag actual')
  const put = await req('PUT', '/api/note?path=Plan.md', { text: '# Plan general\n\nNuevo.\n' }, { 'if-match': `"${plan.body.etag}"` })
  assert.equal(put.status, 200)

  assert.equal((await req('POST', '/api/note', { path: 'nueva.md', text: '# Nueva\n' })).status, 201)
  assert.equal((await req('POST', '/api/note', { path: 'nueva.md', text: '# Otra\n' })).status, 409)
  assert.equal((await req('GET', '/api/note?path=../fuera.md')).status, 400)
  assert.equal((await req('GET', '/api/note?path=no-existe.md')).status, 404)

  const dry = await req('POST', '/api/note/move', { from: 'hogar/Proxy.md', to: 'hogar/GW.md', dryRun: true })
  assert.ok(dry.body.relinked.length > 0)
  assert.equal((await req('POST', '/api/note/move', { from: 'hogar/Proxy.md', to: 'hogar/GW.md' })).status, 200)

  const del = await req('DELETE', '/api/note?path=nueva.md')
  assert.equal(del.status, 200)
  const trash = await req('GET', '/api/trash')
  assert.equal(trash.body.entries[0].path, 'nueva.md')
  assert.equal((await req('POST', `/api/trash/${del.body.id}/restore`, {})).status, 200)
})

test('enlaces, backlinks con contexto, búsqueda y alertas', async () => {
  const { auth, req } = await setup()
  await auth.createUser('noa', 'contraseña-larga', 'member')
  await req('POST', '/api/auth/login', { username: 'noa', password: 'contraseña-larga' })

  const links = await req('GET', '/api/note/links?path=diario/2026-09-24.md')
  const tareas = links.body.outgoing.find((l: { raw: string }) => l.raw === '[[Tareas]]')
  assert.equal(tareas.status, 'ambiguous')
  assert.deepEqual(tareas.candidates, ['proyectos/blog/Tareas.md', 'proyectos/thoth/Tareas.md'])

  const back = await req('GET', '/api/note/links?path=hogar/Proxy.md')
  assert.ok(back.body.backlinks.some((b: { path: string; context: string }) => b.path === 'hogar/enlaces.md' && b.context.includes('[[Proxy#Red]]')))

  const alias = await req('GET', '/api/search?q=hipervisor')
  assert.equal(alias.body.results[0]?.path, 'hogar/Proxy.md', 'los alias se buscan')
  const s = await req('GET', '/api/search?q=cafe')
  assert.ok(s.body.results.some((r: { path: string }) => r.path.normalize('NFC') === 'recetas/Café.md'))
  assert.ok(s.body.results[0].snippet.includes('\u0002'), 'resaltado con marcas, no HTML')
  assert.deepEqual((await req('GET', '/api/search?q=' + encodeURIComponent('" OR * NEAR('))).body.results, [], 'la sintaxis FTS5 del usuario no rompe nada')

  const alerts = await req('GET', '/api/alerts')
  assert.equal(alerts.body.syncConflicts.length, 1)
  assert.equal(alerts.body.uidConflicts[0].uid, '01J8X4M2K9QZ')

  assert.equal((await req('POST', '/api/admin/rescan', {})).status, 403, 'un member no es admin')
})

test('UI: estáticos, rutas de la aplicación a index.html y la API no cae en la UI', async () => {
  const webDir = mkdtempSync(join(tmpdir(), 'thoth-web-'))
  mkdirSync(join(webDir, 'assets'))
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>')
  writeFileSync(join(webDir, 'assets', 'app-abc123.js'), 'console.log(1)')
  const { auth, req, raw } = await setup({ webDir })
  const home = await raw('/')
  assert.equal(home.status, 200)
  assert.match(await home.text(), /id="root"/)
  assert.match(home.headers.get('content-security-policy')!, /default-src 'self'/)
  assert.equal(home.headers.get('cache-control'), 'no-cache')
  const deep = await raw('/cualquier/ruta?note=Plan.md')
  assert.equal(deep.status, 200)
  assert.match(await deep.text(), /id="root"/, 'las rutas de la aplicación sirven index.html')
  const asset = await raw('/assets/app-abc123.js')
  assert.equal(await asset.text(), 'console.log(1)')
  assert.match(asset.headers.get('cache-control')!, /immutable/)
  assert.equal((await req('GET', '/api/no-existe')).status, 401, 'la API sigue exigiendo sesión')
  await auth.createUser('noa', 'contraseña-larga', 'admin')
  await req('POST', '/api/auth/login', { username: 'noa', password: 'contraseña-larga' })
  const missing = await req('GET', '/api/no-existe')
  assert.deepEqual([missing.status, missing.body.error], [404, 'not_found'], 'una ruta de API desconocida no devuelve la UI')
})

test('CSRF: se rechaza una escritura desde otro origen', async () => {
  const { auth, req } = await setup()
  await auth.createUser('noa', 'contraseña-larga', 'admin')
  await req('POST', '/api/auth/login', { username: 'noa', password: 'contraseña-larga' })
  const r = await req('POST', '/api/note', { path: 'x.md', text: 'x' }, { origin: 'https://malicioso.example' })
  assert.equal(r.status, 403)
  const same = await req('POST', '/api/note', { path: 'x.md', text: 'x' }, { origin: 'http://localhost' })
  assert.equal(same.status, 201)
})

test('ftsQuery: términos entrecomillados y prefijo en el último', () => {
  assert.equal(ftsQuery('café con leche'), '"café" "con" "leche"*')
  assert.equal(ftsQuery('" OR *'), '"OR"*')
  assert.equal(ftsQuery('   '), null)
})

test('state.db: migraciones, copia antes de migrar y rechazo de versiones futuras', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thoth-state-'))
  const file = join(dir, 'state.db')
  openState(file).close()
  const raw = new Database(file)
  assert.equal(raw.pragma('user_version', { simple: true }), STATE_VERSION)
  raw.pragma(`user_version = ${STATE_VERSION + 1}`)
  raw.close()
  assert.throws(() => openState(file), /más nueva/)
  // Simula una base de una versión anterior con datos: debe copiarse antes de migrar.
  const old = join(dir, 'old.db')
  copyFileSync(file, old)
  const r = new Database(old)
  r.exec('drop table sessions; drop table users')
  r.pragma('user_version = 0')
  r.close()
  openState(old).close()
  assert.ok(!existsSync(old + '.bak-v0'), 'una base vacía (v0) no necesita copia')
})
