// Images in notes: storage next to the note, limits, serving files
// from the notes folder and downloading a copy from a URL.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AdminSettings, Auth, IMAGES_PER_USER, Indexer, NoteService, Profiles, SESSION_COOKIE, VERSION, Workspace, attachmentPath, createApp, fetchImage, isPublicAddress, openIndex, openState, sniffImage,
  type ExternalImages, type FetchImageOptions, type Runtime,
} from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))

// Only the signatures matter to vihko: it never decodes the image.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46])
const GIF = new TextEncoder().encode('GIF89a\x01\x00\x01\x00')
const WEBP = new TextEncoder().encode('RIFF\x10\x00\x00\x00WEBPVP8 ')
const AVIF = Uint8Array.from([0, 0, 0, 0x1c, ...new TextEncoder().encode('ftypmif1\0\0\0\0mif1avifmiaf')])
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

async function setup(opts: { maxImageBytes?: number; webDir?: string; externalImages?: ExternalImages; role?: 'admin' | 'member'; fetchTesting?: FetchImageOptions['testing'] } = {}) {
  const dir = tempDir('vihko-images-')
  const notesDir = join(dir, 'notes')
  const user = m.aUser({ role: opts.role ?? 'admin' })
  // The vault in the user's own space, which they manage whatever their role: no grants needed.
  const home = `people/${user.username}`
  cpSync(VAULT, join(notesDir, home), { recursive: true })
  /** A path of the vault, as the notes folder has it. */
  const v = (path: string) => (path === '' ? home : `${home}/${path}`)
  const index = openIndex(join(dir, 'index.db'))
  const state = openState(join(dir, 'state.db'))
  const auth = new Auth(state)
  const indexer = new Indexer({ notesDir, db: index })
  const runtime: Runtime = { lastScan: null, rescan(o) { return (this.lastScan = indexer.scan(o)) } }
  runtime.rescan({})
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db: index, maxImageBytes: opts.maxImageBytes })
  const app = createApp({ auth, profiles: new Profiles(state), workspace: new Workspace({ notesDir }), notes, index, indexer, notesDir, runtime, webDir: opts.webDir, externalImages: opts.externalImages, imageFetchTesting: opts.fetchTesting })
  await auth.createUser(user.username, user.password, user.role)
  const login = await app.request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user.username, password: user.password }),
  })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  assert.ok(cookie.startsWith(SESSION_COOKIE + '='))
  const upload = async (note: string, bytes: Uint8Array<ArrayBuffer>) => {
    const res = await app.request(`/api/attachments?note=${encodeURIComponent(note)}`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body: bytes })
    return { status: res.status, body: await res.json() as any }
  }
  const post = async (path: string, body: unknown) => {
    const res = await app.request(path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as any }
  }
  const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers: { cookie, ...headers } })
  return { notesDir, app, upload, post, get, v, settings: new AdminSettings(state) }
}

/** A local HTTP server for the URL downloads; routes by path. */
async function origin(routes: Record<string, (res: import('node:http').ServerResponse) => void>): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const path = req.url ?? ''
    const route = Object.hasOwn(routes, path) ? routes[path] : undefined
    if (route) route(res)
    else { res.statusCode = 404; res.end() }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}

test('names: next to the note, from its name and the UTC time, with a suffix for taken names', () => {
  const now = new Date('2026-09-25T10:12:59Z')
  const [dir, name, other, rootName] = [m.aFolderPath(2), m.aTitle(), m.aTitle(), m.aTitle()]
  const fixed = m.aFolderPath(2)
  assert.equal(attachmentPath(`${dir}/${name}.md`, 'png', now), `${dir}/${name}-2026-09-25-1012.png`)
  assert.equal(attachmentPath(`${rootName}.md`, 'jpg', now), `${rootName}-2026-09-25-1012.jpg`)
  assert.equal(attachmentPath(`${dir}/${other}.md`, 'webp', now, 3), `${dir}/${other}-2026-09-25-1012-3.webp`)
  assert.equal(attachmentPath(`${name}.md`, 'png', new Date('2026-01-02T23:05:00+02:00')), `${name}-2026-01-02-2105.png`, 'UTC, not local time')
  assert.equal(attachmentPath(`${dir}/${other}.md`, 'png', now, 2, { folder: fixed }), `${fixed}/${other}-2026-09-25-1012-2.png`, 'a fixed folder from vihko.yaml')
  assert.equal(attachmentPath(`${dir}/${other}.md`, 'png', now, 1, { folder: null, perNote: '.assets' }), `${dir}/${other}.assets/2026-09-25-1012.png`, 'the note\'s own folder')
  assert.equal(attachmentPath(`${rootName}.md`, 'png', now, 2, { folder: null, perNote: '_files' }), `${rootName}_files/2026-09-25-1012-2.png`)
})

test('types are detected from the bytes; SVG and anything else is refused', () => {
  assert.deepEqual([PNG, JPEG, GIF, WEBP, AVIF].map((b) => sniffImage(b)?.ext), ['png', 'jpg', 'gif', 'webp', 'avif'])
  for (const b of [SVG, new TextEncoder().encode('%PDF-1.7'), new Uint8Array()]) assert.equal(sniffImage(b), null)
})

// From here on, over a copy of the test vault: its notes are where images go.
test('upload: stored next to the note, never overwrites, and the note is untouched', async () => {
  const { notesDir, upload, v } = await setup()
  const notas = v('proyectos/vihko/notas.md')
  const before = readFileSync(join(notesDir, notas), 'utf8')
  const a = await upload(notas, PNG)
  assert.equal(a.status, 201)
  assert.ok(a.body.path.startsWith(v('proyectos/vihko/')), a.body.path)
  assert.match(a.body.path.slice(v('proyectos/vihko/').length), /^notas-\d{4}-\d{2}-\d{2}-\d{4}\.png$/)
  assert.equal(a.body.src, a.body.path.slice(v('proyectos/vihko/').length))
  assert.deepEqual(readFileSync(join(notesDir, a.body.path)), Buffer.from(PNG))

  // Same minute: a suffix. A file someone else put there first is kept as is.
  const taken = a.body.path.replace(/\.png$/, '-2.png')
  writeFileSync(join(notesDir, taken), 'someone else')
  const b = await upload(notas, PNG)
  assert.equal(b.body.path, a.body.path.replace(/\.png$/, '-3.png'))
  assert.equal(readFileSync(join(notesDir, taken), 'utf8'), 'someone else')
  assert.equal(readFileSync(join(notesDir, notas), 'utf8'), before)
  assert.ok(!readdirSync(join(notesDir, v('proyectos/vihko'))).some((f) => f.includes('.vihko-')), 'no temp files left')

  const root = await upload(v('Plan.md'), JPEG)
  assert.ok(root.body.path.startsWith(v('Plan-')) && root.body.path.endsWith('.jpg'), root.body.path)
  assert.equal(root.body.src, root.body.path.slice(v('').length + 1))
})

test('upload limits: type, size, note that exists and a valid path', async () => {
  const { notesDir, upload, v } = await setup({ maxImageBytes: 64 })
  const svg = await upload(v('Plan.md'), new TextEncoder().encode('<svg/>'))
  assert.deepEqual([svg.status, svg.body.error], [415, 'unsupported_type'])
  const big = new Uint8Array(65)
  big.set(PNG)
  const tooBig = await upload(v('Plan.md'), big)
  assert.deepEqual([tooBig.status, tooBig.body.error], [413, 'too_large'])
  const missing = await upload(m.aNotePath(v('')), PNG)
  assert.deepEqual([missing.status, missing.body.error], [404, 'not_found'])
  for (const bad of ['../fuera.md', '/Plan.md', 'adjuntos/imagen.png', '.obsidian/x.md']) {
    const r = await upload(bad, PNG)
    assert.deepEqual([r.status, r.body.error], [400, 'invalid_path'], bad)
  }
  assert.ok(!existsSync(join(notesDir, '..', 'fuera.md')))
})

test('serving files: type, nosniff, revalidation, and the same path rules as notes', async () => {
  const { notesDir, app, get, upload, v } = await setup()
  const up = await upload(v('Plan.md'), PNG)
  const res = await get(`/api/file?path=${encodeURIComponent(up.body.path)}`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('cache-control'), 'private, no-cache')
  assert.match(res.headers.get('content-security-policy')!, /sandbox/)
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG)
  const etag = res.headers.get('etag')!
  assert.equal((await get(`/api/file?path=${encodeURIComponent(up.body.path)}`, { 'if-none-match': etag })).status, 304)

  const drawing = v(`${m.aTitle()}.svg`)
  writeFileSync(join(notesDir, drawing), SVG)
  const svg = await get(`/api/file?path=${encodeURIComponent(drawing)}`)
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml')
  assert.match(svg.headers.get('content-security-policy')!, /default-src 'none'.*sandbox/, 'an SVG opened on its own runs nothing')
  const canvas = await get(`/api/file?path=${encodeURIComponent(v('adjuntos/tablero.canvas'))}`)
  assert.equal(canvas.headers.get('content-type'), 'application/octet-stream')
  assert.match(canvas.headers.get('content-disposition')!, /^attachment/)

  const hidden = v(`.${m.aFolder()}`)
  const [secret, link] = [`${m.aTitle()}.png`, v(m.aFolder())]
  mkdirSync(join(notesDir, hidden))
  writeFileSync(join(notesDir, hidden, 'x.png'), PNG)
  const outside = tempDir('vihko-outside-')
  writeFileSync(join(outside, secret), PNG)
  symlinkSync(outside, join(notesDir, link))
  const status = async (p: string) => (await get(`/api/file?path=${encodeURIComponent(p)}`)).status
  for (const p of ['../x.png', '/etc/passwd', 'a/../../x.png', 'a//b.png', '']) assert.equal(await status(p), 400, p)
  for (const p of [v('Plan.md'), `${hidden}/x.png`, `${link}/${secret}`, v(`${m.aTitle()}.png`), v('adjuntos')]) assert.equal(await status(p), 404, p)
  assert.equal((await app.request(`/api/file?path=${encodeURIComponent(up.body.path)}`)).status, 401, 'needs a session')
})

test('only a few images are received at once per person: beyond that, 429 and nothing is read', async () => {
  const held: import('node:http').ServerResponse[] = []
  const { url, server } = await origin({ '/held.png': (res) => { held.push(res) } })
  try {
    const { post, upload, v, settings } = await setup()
    // The test's origin is on this machine: the local network has to be allowed.
    settings.set({ membersLocalDownloads: true })
    const plan = v('Plan.md')
    const waiting = Array.from({ length: IMAGES_PER_USER }, () => post('/api/attachments/fetch', { note: plan, url: `${url}/held.png` }))
    const start = Date.now()
    while (held.length < IMAGES_PER_USER) {
      if (Date.now() - start > 5000) throw new Error('the downloads never reached the origin')
      await new Promise((r) => setTimeout(r, 20))
    }
    const more = await post('/api/attachments/fetch', { note: plan, url: `${url}/held.png` })
    assert.deepEqual([more.status, more.body.error], [429, 'busy'])
    const up = await upload(plan, new Uint8Array(PNG))
    assert.deepEqual([up.status, up.body.error], [429, 'busy'], 'an upload waits its turn as well')
    assert.equal(held.length, IMAGES_PER_USER, 'nothing more was asked of the origin')
    for (const res of held) { res.setHeader('content-type', 'image/png'); res.end(PNG) }
    for (const r of await Promise.all(waiting)) assert.equal(r.status, 201)
    // Once they're in, the slots are free again.
    assert.equal((await upload(plan, new Uint8Array(PNG))).status, 201)
  } finally {
    server.close()
  }
})

test('by URL: a copy is downloaded and stored like an upload, following a few redirects', async () => {
  const { url, server } = await origin({
    '/chart.png': (res) => { res.setHeader('content-type', 'image/png'); res.end(PNG) },
    '/moved': (res) => { res.statusCode = 302; res.setHeader('location', '/chart.png'); res.end() },
    '/loop': (res) => { res.statusCode = 302; res.setHeader('location', '/loop'); res.end() },
    '/page': (res) => { res.setHeader('content-type', 'text/html'); res.end('<html>') },
    '/fake.png': (res) => { res.setHeader('content-type', 'image/png'); res.end('<html>') },
    '/drawing.svg': (res) => { res.setHeader('content-type', 'image/svg+xml'); res.end(SVG) },
    '/big': (res) => { res.setHeader('content-type', 'image/png'); res.end(Buffer.concat([PNG, Buffer.alloc(100)])) },
    '/big-chunked': (res) => { res.setHeader('content-type', 'image/png'); res.write(PNG); res.write(Buffer.alloc(60)); res.end(Buffer.alloc(60)) },
    '/gone': (res) => { res.statusCode = 404; res.end() },
    '/slow': () => { /* never answers */ },
  })
  try {
    const { notesDir, post, v, settings } = await setup({ maxImageBytes: 100 })
    // The test's origin is on this machine: the local network has to be allowed.
    settings.set({ membersLocalDownloads: true })
    const ok = await post('/api/attachments/fetch', { note: v('Plan.md'), url: `${url}/moved` })
    assert.equal(ok.status, 201)
    assert.ok(ok.body.path.startsWith(v('Plan-')) && ok.body.path.endsWith('.png'), ok.body.path)
    assert.deepEqual(readFileSync(join(notesDir, ok.body.path)), Buffer.from(PNG))

    const code = async (u: string) => { const r = await post('/api/attachments/fetch', { note: v('Plan.md'), url: u }); return [r.status, r.body.error] }
    assert.deepEqual(await code(`${url}/loop`), [502, 'fetch_failed'])
    assert.deepEqual(await code(`${url}/gone`), [502, 'fetch_failed'])
    assert.deepEqual(await code(`${url}/page`), [415, 'unsupported_type'])
    assert.deepEqual(await code(`${url}/fake.png`), [415, 'unsupported_type'], 'the declared type is not enough')
    assert.deepEqual(await code(`${url}/drawing.svg`), [415, 'unsupported_type'])
    assert.deepEqual(await code(`${url}/big`), [413, 'too_large'])
    assert.deepEqual(await code(`${url}/big-chunked`), [413, 'too_large'], 'the cap holds without a Content-Length')
    for (const bad of ['file:///etc/passwd', 'ftp://h/x.png', 'no es una url', `http://user:pw@127.0.0.1/x.png`]) assert.deepEqual(await code(bad), [400, 'invalid'], bad)
    const noNote = await post('/api/attachments/fetch', { note: m.aNotePath(v('')), url: `${url}/chart.png` })
    assert.deepEqual([noNote.status, noNote.body.error], [404, 'not_found'])

    await assert.rejects(fetchImage(`${url}/slow`, { maxBytes: 100, timeoutMs: 200 }), (e: Error & { code?: string }) => e.code === 'fetch_failed' && /timed out/.test(e.message))
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test('by URL, a failure answers in general words: the host, port, status and system error go to the log only', async (t) => {
  const { url, server } = await origin({
    '/gone': (res) => { res.statusCode = 404; res.end() },
    '/page': (res) => { res.setHeader('content-type', 'text/html'); res.end('<html>') },
  })
  const logged = t.mock.method(console, 'error', () => {})
  try {
    const { post, v, settings } = await setup({ role: m.faker.helpers.arrayElement(['admin', 'member'] as const) })
    settings.set({ membersLocalDownloads: true })
    const { host, port } = new URL(url)
    // Nothing listens on the discard port: the connection is refused.
    const refused = 'http://127.0.0.1:9/x.png'
    const cases: [string, number, string, RegExp][] = [
      [`${url}/gone`, 502, 'fetch_failed', /404/],
      [`${url}/page`, 415, 'unsupported_type', /text\/html/],
      [refused, 502, 'fetch_failed', /ECONNREFUSED|127\.0\.0\.1:9/],
    ]
    const messages = new Set<string>()
    for (const [u, status, code, detail] of cases) {
      logged.mock.resetCalls()
      const r = await post('/api/attachments/fetch', { note: v('Plan.md'), url: u })
      assert.deepEqual([r.status, r.body.error], [status, code], u)
      const said = JSON.stringify(r.body)
      for (const leak of [host, port, '127.0.0.1', ':9', detail]) assert.ok(typeof leak === 'string' ? !said.includes(leak) : !leak.test(said), `${said} tells ${leak}`)
      const log = logged.mock.calls.map((c) => c.arguments.join(' ')).join('\n')
      assert.match(log, detail, 'the detail is in the server log')
      if (code === 'fetch_failed') messages.add(r.body.message)
    }
    assert.equal(messages.size, 1, 'a page that isn\'t there and a port that refuses answer the same')

    settings.set({ membersLocalDownloads: false })
    const blocked = await post('/api/attachments/fetch', { note: v('Plan.md'), url: `${url}/gone` })
    assert.deepEqual([blocked.status, blocked.body.error], [403, 'private_address'])
    assert.ok(!JSON.stringify(blocked.body).includes(host), 'the address isn\'t repeated back')
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test('by URL, a member: only public addresses (also after DNS and redirects), unless the admin opens the local network', async () => {
  const { url, server } = await origin({
    '/chart.png': (res) => { res.setHeader('content-type', 'image/png'); res.end(PNG) },
    '/to-private': (res) => { res.statusCode = 302; res.setHeader('location', 'http://10.1.2.3/chart.png'); res.end() },
    '/to-intranet': (res) => { res.statusCode = 302; res.setHeader('location', `http://intranet.example:${port}/chart.png`); res.end() },
    '/to-public': (res) => { res.statusCode = 302; res.setHeader('location', `http://images.example:${port}/chart.png`); res.end() },
  })
  const port = new URL(url).port
  // Names resolve here, not in DNS; 127.0.0.1 stands for a public address (the connection really goes there).
  const names: Record<string, { address: string; family: number }[]> = {
    'images.example': [{ address: '127.0.0.1', family: 4 }],
    'intranet.example': [{ address: '192.168.1.20', family: 4 }],
    'mixed.example': [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.7', family: 4 }],
    'v6.example': [{ address: 'fd00::7', family: 6 }],
  }
  const testing: FetchImageOptions['testing'] = {
    resolve: async (h) => names[h] ?? [],
    isPublic: (ip) => ip === '127.0.0.1' || isPublicAddress(ip),
  }
  try {
    const member = await setup({ role: 'member', fetchTesting: testing })
    const code = async (u: string) => { const r = await member.post('/api/attachments/fetch', { note: member.v('Plan.md'), url: u }); return [r.status, r.body.error] }
    const ok = await member.post('/api/attachments/fetch', { note: member.v('Plan.md'), url: `http://images.example:${port}/chart.png` })
    assert.equal(ok.status, 201, 'a public address: downloaded, from the address that was checked')
    for (const u of [
      `http://intranet.example:${port}/chart.png`, `http://mixed.example:${port}/chart.png`, `http://v6.example:${port}/chart.png`,
      `http://images.example:${port}/to-private`, `http://images.example:${port}/to-intranet`,
      'http://10.0.0.1/x.png', 'http://[::1]/x.png', 'http://169.254.169.254/latest/meta-data', 'http://[::ffff:192.168.0.1]/x.png',
    ]) assert.deepEqual(await code(u), [403, 'private_address'], u)
    assert.equal((await member.post('/api/attachments/fetch', { note: member.v('Plan.md'), url: `http://images.example:${port}/to-public` })).status, 201, 'a redirect to a public address is followed')

    // Without the test's resolver: the system's, and loopback is not public.
    const plain = await setup({ role: 'member' })
    assert.deepEqual([(await plain.post('/api/attachments/fetch', { note: plain.v('Plan.md'), url: `http://localhost:${port}/chart.png` })).body.error], ['private_address'])
    assert.deepEqual([(await plain.post('/api/attachments/fetch', { note: plain.v('Plan.md'), url: `${url}/chart.png` })).body.error], ['private_address'])
    assert.deepEqual([(await plain.post('/api/attachments/fetch', { note: plain.v('Plan.md'), url: `http://0x7f000001:${port}/chart.png` })).body.error], ['private_address'], 'another way of writing 127.0.0.1')
    // The admin lets members reach the local network.
    plain.settings.set({ membersLocalDownloads: true })
    assert.equal((await plain.post('/api/attachments/fetch', { note: plain.v('Plan.md'), url: `${url}/chart.png` })).status, 201)
    plain.settings.set({ membersLocalDownloads: false })
    assert.equal((await plain.post('/api/attachments/fetch', { note: plain.v('Plan.md'), url: `${url}/chart.png` })).status, 403)
    // The vihko admin is held to the same setting: their account can't probe the network either.
    const admin = await setup({ role: 'admin' })
    assert.deepEqual([(await admin.post('/api/attachments/fetch', { note: admin.v('Plan.md'), url: `${url}/chart.png` })).body.error], ['private_address'])
    admin.settings.set({ membersLocalDownloads: true })
    assert.equal((await admin.post('/api/attachments/fetch', { note: admin.v('Plan.md'), url: `${url}/chart.png` })).status, 201)

    await assert.rejects(fetchImage(`${url}/chart.png`, { maxBytes: 100, publicOnly: true }), (e: Error & { code?: string }) => e.code === 'private_address')
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test('external images: exposed to the UI, and the UI CSP follows the setting', async () => {
  const webDir = tempDir('vihko-web-')
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>')
  // `ask` loads them when the reader asks: the page may load them.
  for (const [setting, allowed] of [['allow', true], ['ask', true], ['block', false]] as const) {
    const { get } = await setup({ webDir, externalImages: setting, maxImageBytes: 1234 })
    assert.deepEqual(await (await get('/api/config')).json(), { externalImages: setting, maxImageBytes: 1234, secretsEncrypted: false, version: VERSION })
    const csp = (await get('/')).headers.get('content-security-policy')!
    const img = /img-src ([^;]*)/.exec(csp)![1]!
    assert.equal(img.includes('https:'), allowed, csp)
    assert.match(csp, /connect-src 'self'/, 'the UI itself still only talks to its server')
  }
})
