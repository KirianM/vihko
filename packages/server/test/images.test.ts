// Images in notes (D-028): storage next to the note, limits and serving files
// from the notes folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Auth, Indexer, NoteService, SESSION_COOKIE, attachmentPath, createApp, openIndex, openState, sniffImage,
  type Runtime,
} from '@thoth/server'

const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))

// Only the signatures matter to thoth: it never decodes the image.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46])
const GIF = new TextEncoder().encode('GIF89a\x01\x00\x01\x00')
const WEBP = new TextEncoder().encode('RIFF\x10\x00\x00\x00WEBPVP8 ')
const AVIF = Uint8Array.from([0, 0, 0, 0x1c, ...new TextEncoder().encode('ftypmif1\0\0\0\0mif1avifmiaf')])
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

async function setup(opts: { maxImageBytes?: number; webDir?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'thoth-images-'))
  const notesDir = join(dir, 'notes')
  cpSync(VAULT, notesDir, { recursive: true })
  const index = openIndex(join(dir, 'index.db'))
  const auth = new Auth(openState(join(dir, 'state.db')))
  const indexer = new Indexer({ notesDir, db: index })
  const runtime: Runtime = { lastScan: null, rescan(o) { return (this.lastScan = indexer.scan(o)) } }
  runtime.rescan({})
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db: index, maxImageBytes: opts.maxImageBytes })
  const app = createApp({ auth, notes, index, indexer, notesDir, runtime, webDir: opts.webDir })
  await auth.createUser('noa', 'a-long-password', 'member')
  const login = await app.request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'noa', password: 'a-long-password' }),
  })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  assert.ok(cookie.startsWith(SESSION_COOKIE + '='))
  const upload = async (note: string, bytes: Uint8Array<ArrayBuffer>) => {
    const res = await app.request(`/api/attachments?note=${encodeURIComponent(note)}`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body: bytes })
    return { status: res.status, body: await res.json() as any }
  }
  const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers: { cookie, ...headers } })
  return { notesDir, app, upload, get }
}

test('names: next to the note, from its name and the UTC time, with a suffix for taken names', () => {
  const now = new Date('2026-09-25T10:12:59Z')
  assert.equal(attachmentPath('proyectos/thoth/plan.md', 'png', now), 'proyectos/thoth/plan-2026-09-25-1012.png')
  assert.equal(attachmentPath('Plan.md', 'jpg', now), 'Plan-2026-09-25-1012.jpg')
  assert.equal(attachmentPath('a/Mi nota.md', 'webp', now, 3), 'a/Mi nota-2026-09-25-1012-3.webp')
  assert.equal(attachmentPath('x.md', 'png', new Date('2026-01-02T23:05:00+02:00')), 'x-2026-01-02-2105.png', 'UTC, not local time')
})

test('types are detected from the bytes; SVG and anything else is refused', () => {
  assert.deepEqual([PNG, JPEG, GIF, WEBP, AVIF].map((b) => sniffImage(b)?.ext), ['png', 'jpg', 'gif', 'webp', 'avif'])
  for (const b of [SVG, new TextEncoder().encode('%PDF-1.7'), new Uint8Array()]) assert.equal(sniffImage(b), null)
})

test('upload: stored next to the note, never overwrites, and the note is untouched', async () => {
  const { notesDir, upload } = await setup()
  const before = readFileSync(join(notesDir, 'proyectos/thoth/notas.md'), 'utf8')
  const a = await upload('proyectos/thoth/notas.md', PNG)
  assert.equal(a.status, 201)
  assert.match(a.body.path, /^proyectos\/thoth\/notas-\d{4}-\d{2}-\d{2}-\d{4}\.png$/)
  assert.equal(a.body.src, a.body.path.slice('proyectos/thoth/'.length))
  assert.deepEqual(readFileSync(join(notesDir, a.body.path)), Buffer.from(PNG))

  // Same minute: a suffix. A file someone else put there first is kept as is.
  const taken = a.body.path.replace(/\.png$/, '-2.png')
  writeFileSync(join(notesDir, taken), 'someone else')
  const b = await upload('proyectos/thoth/notas.md', PNG)
  assert.equal(b.body.path, a.body.path.replace(/\.png$/, '-3.png'))
  assert.equal(readFileSync(join(notesDir, taken), 'utf8'), 'someone else')
  assert.equal(readFileSync(join(notesDir, 'proyectos/thoth/notas.md'), 'utf8'), before)
  assert.ok(!readdirSync(join(notesDir, 'proyectos/thoth')).some((f) => f.includes('.thoth-')), 'no temp files left')

  const root = await upload('Plan.md', JPEG)
  assert.match(root.body.path, /^Plan-.*\.jpg$/)
  assert.equal(root.body.src, root.body.path)
})

test('upload limits: type, size, note that exists and a valid path', async () => {
  const { notesDir, upload } = await setup({ maxImageBytes: 64 })
  const svg = await upload('Plan.md', new TextEncoder().encode('<svg/>'))
  assert.deepEqual([svg.status, svg.body.error], [415, 'unsupported_type'])
  const big = new Uint8Array(65)
  big.set(PNG)
  const tooBig = await upload('Plan.md', big)
  assert.deepEqual([tooBig.status, tooBig.body.error], [413, 'too_large'])
  const missing = await upload('no-existe.md', PNG)
  assert.deepEqual([missing.status, missing.body.error], [404, 'not_found'])
  for (const bad of ['../fuera.md', '/Plan.md', 'adjuntos/imagen.png', '.obsidian/x.md']) {
    const r = await upload(bad, PNG)
    assert.deepEqual([r.status, r.body.error], [400, 'invalid_path'], bad)
  }
  assert.ok(!existsSync(join(notesDir, '..', 'fuera.md')))
})

test('serving files: type, nosniff, revalidation, and the same path rules as notes', async () => {
  const { notesDir, app, get, upload } = await setup()
  const up = await upload('Plan.md', PNG)
  const res = await get(`/api/file?path=${encodeURIComponent(up.body.path)}`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('cache-control'), 'private, no-cache')
  assert.match(res.headers.get('content-security-policy')!, /sandbox/)
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG)
  const etag = res.headers.get('etag')!
  assert.equal((await get(`/api/file?path=${encodeURIComponent(up.body.path)}`, { 'if-none-match': etag })).status, 304)

  writeFileSync(join(notesDir, 'dibujo.svg'), SVG)
  const svg = await get('/api/file?path=dibujo.svg')
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml')
  assert.match(svg.headers.get('content-security-policy')!, /default-src 'none'.*sandbox/, 'an SVG opened on its own runs nothing')
  const canvas = await get('/api/file?path=adjuntos/tablero.canvas')
  assert.equal(canvas.headers.get('content-type'), 'application/octet-stream')
  assert.match(canvas.headers.get('content-disposition')!, /^attachment/)

  mkdirSync(join(notesDir, '.oculta'))
  writeFileSync(join(notesDir, '.oculta/x.png'), PNG)
  const outside = mkdtempSync(join(tmpdir(), 'thoth-outside-'))
  writeFileSync(join(outside, 'secret.png'), PNG)
  symlinkSync(outside, join(notesDir, 'enlace'))
  const status = async (p: string) => (await get(`/api/file?path=${encodeURIComponent(p)}`)).status
  for (const p of ['../x.png', '/etc/passwd', 'a/../../x.png', 'a//b.png', '']) assert.equal(await status(p), 400, p)
  for (const p of ['Plan.md', '.oculta/x.png', 'enlace/secret.png', 'no-existe.png', 'adjuntos']) assert.equal(await status(p), 404, p)
  assert.equal((await app.request(`/api/file?path=${encodeURIComponent(up.body.path)}`)).status, 401, 'needs a session')
})
