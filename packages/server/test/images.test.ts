// Images in notes (D-028): storage next to the note and limits.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

async function setup(opts: { maxImageBytes?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'thoth-images-'))
  const notesDir = join(dir, 'notes')
  cpSync(VAULT, notesDir, { recursive: true })
  const index = openIndex(join(dir, 'index.db'))
  const auth = new Auth(openState(join(dir, 'state.db')))
  const indexer = new Indexer({ notesDir, db: index })
  const runtime: Runtime = { lastScan: null, rescan(o) { return (this.lastScan = indexer.scan(o)) } }
  runtime.rescan({})
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db: index, maxImageBytes: opts.maxImageBytes })
  const app = createApp({ auth, notes, index, indexer, notesDir, runtime })
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
  return { notesDir, upload }
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
