// Images over MCP (D-048): `attach_image` stores one as `POST /api/attachments`
// does, through the same scoped operation, so the same rules hold (the key's
// folders, `ai: false`, a note it can write, the size limit, the type told by
// the bytes, the images received at once), and answers the link to write.
// The SDK's client over the app, as in mcp.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { IMAGES_PER_USER, MAX_MCP_BODY } from '@vihko/server'
import { PNG, setup } from './_agents.ts'
import { inShared } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** The key's folder: a note whose name has a space (its images' names too), and one hidden from agents; another folder and a note there. */
const DIR = inShared(m.aFolder())
const PLAN = `${DIR}/${m.aUniqueWord()} ${m.aUniqueWord()}.md`
const HIDDEN = m.aNotePath(DIR)
const OUT_DIR = inShared(m.aFolder())
const OUTSIDE = m.aNotePath(OUT_DIR)
const FILES = {
  [PLAN]: `# ${m.aHeading()}\n\n${m.aSentence()}\n`,
  [HIDDEN]: `---\nai: false\n---\n# ${m.aHeading()}\n\n${m.aSentence()}\n`,
  [OUTSIDE]: `# ${m.aHeading()}\n\n${m.aSentence()}\n`,
}
const IMAGE = PNG.toString('base64')

/** Every file in the notes folder but vihko's own (vihko.yaml, dot folders). */
const listing = (notesDir: string) => readdirSync(notesDir, { recursive: true }).map(String).filter((p) => !p.startsWith('.') && p !== 'vihko.yaml').sort()

test('attach_image: a key that writes stores an image for a note in its folders; the link it answers, appended, makes the note use it', async () => {
  const h = await setup({ files: FILES })
  try {
    await h.enableMcp()
    await h.enableApi()
    const name = m.aKeyName()
    const { key, token } = await h.newKey({ name, canWrite: true, folders: [DIR] })
    const c = await h.mcp(token)
    const alt = m.aSentence()
    const up = await c.call('attach_image', { note: PLAN, data: IMAGE, mime_type: 'image/png', alt })
    assert.equal(up.error, false, up.raw)
    assert.deepEqual(Object.keys(up.data).sort(), ['markdown', 'path', 'src'])
    assert.ok(up.data.path.startsWith(`${DIR}/`) && up.data.path.endsWith('.png'), up.data.path)
    assert.deepEqual(readFileSync(join(h.notesDir, up.data.path)), PNG)
    // `src` is a path (with the note's space); `markdown`, the link with it escaped and the alt text.
    assert.ok(up.data.src.includes(' '), up.data.src)
    assert.equal(up.data.markdown, `![${alt}](${up.data.src.replaceAll(' ', '%20')})`)
    const file = h.url('/api/file', { path: up.data.path })
    assert.equal((await h.withKey(token)('GET', file)).status, 404, 'no note uses it yet')

    const add = await c.call('edit_note', { path: PLAN, operations: [{ op: 'append', text: up.data.markdown }] })
    assert.equal(add.error, false, add.raw)
    await h.settle()
    assert.equal((await h.withKey(token)('GET', file)).status, 200, 'a note it can read uses it now')

    // Stored as the agent's, through MCP, on behalf of its person.
    const changes = await h.history.reader().changes({ limit: 20, canRead: () => true })
    const stored = changes.changes.find((ch) => ch.files.some((f) => f.path === up.data.path))
    assert.ok(stored, 'the upload is in the history')
    assert.deepEqual(stored.authors, [{ kind: 'agent', id: key.id, onBehalfOf: h.users.admin.id, via: 'mcp' }])

    // Other names for the fields, as the other tools take them, and the image as a data: URI.
    const again = await c.call('attach_image', { path: PLAN, image: `data:image/png;base64,${IMAGE}`, mimeType: 'image/png' })
    assert.equal(again.error, false, again.raw)
    assert.notEqual(again.data.path, up.data.path, 'never over another image')
    assert.equal(again.data.markdown, `![](${again.data.src.replaceAll(' ', '%20')})`)

    // Deleting the note takes the image only it uses to the trash with it (the other one no note uses: it stays).
    const del = await c.call('delete', { path: PLAN })
    assert.equal(del.error, false, del.raw)
    assert.deepEqual(del.data.images, [up.data.path])
    await c.close()
  } finally { await h.close() }
})

test('attach_image: only for keys that write; outside the key\'s folders, hidden from agents, not base64, not an image, too large or too many at once: an error, and nothing stored', async () => {
  const limit = PNG.length + m.anInt(256, 1024)
  const h = await setup({ files: FILES, maxImageBytes: limit })
  try {
    await h.enableMcp()
    await h.enableApi()
    const ro = await h.mcp((await h.newKey({ name: m.aKeyName(), folders: [DIR] })).token)
    assert.ok(!(await ro.client.listTools()).tools.some((t) => t.name === 'attach_image'))
    assert.equal(JSON.parse(((await ro.client.callTool({ name: 'attach_image', arguments: { note: PLAN, data: IMAGE } })) as { isError?: boolean; content: { text: string }[] }).content[0]!.text).error, 'forbidden', 'a read-only key: forbidden, in vihko\'s JSON')
    await ro.close()

    const c = await h.mcp((await h.newKey({ name: m.aKeyName(), canWrite: true, folders: [DIR] })).token)
    const before = listing(h.notesDir)
    const fails = async (args: Record<string, unknown>, error: string, reason?: string) => {
      const r = await c.call('attach_image', args)
      const where = `${JSON.stringify(args).slice(0, 200)} → ${r.raw.slice(0, 400)}`
      assert.deepEqual([r.error, r.data?.error], [true, error], where)
      if (reason) assert.deepEqual([r.data.reason, Object.keys(r.data).sort()], [reason, ['error', 'message', 'reason']], where)
      assert.deepEqual(listing(h.notesDir), before, `${where}: nothing stored`)
      return r.data as { error: string; message: string }
    }

    await fails({ note: OUTSIDE, data: IMAGE }, 'agent_denied', 'outside_key_folders')
    await fails({ note: HIDDEN, data: IMAGE }, 'agent_denied', 'ai_false')
    await fails({ note: m.aNotePath(DIR), data: IMAGE }, 'not_found')
    // Base64 in any other alphabet, with characters it doesn't have, or padded wrong (the cases under test).
    for (const data of [`${IMAGE}!`, IMAGE.replace(/[+/]/g, '-').replace(/=+$/, '') + '-_', 'QUJD=', 'Q', '====']) {
      const e = await fails({ note: PLAN, data }, 'invalid')
      assert.match(e.message, /base64/)
    }
    await fails({ note: PLAN, data: Buffer.from(m.aParagraph()).subarray(0, limit).toString('base64'), mime_type: 'image/png' }, 'unsupported_type')
    // An SVG says it is an image, and vihko doesn't store one.
    await fails({ note: PLAN, data: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><text>${m.aWord()}</text></svg>`).toString('base64'), mime_type: 'image/svg+xml' }, 'unsupported_type')
    const big = Buffer.concat([PNG, Buffer.alloc(limit - PNG.length + 1)])
    const tooLarge = await fails({ note: PLAN, data: big.toString('base64') }, 'too_large')
    assert.ok(tooLarge.message.includes(String(big.length)) && tooLarge.message.includes(String(limit)), tooLarge.message)

    // Images received at once count the API's and MCP's together, for the person the key acts for.
    const held = Array.from({ length: IMAGES_PER_USER }, () => h.services.imageSlots.take(h.users.admin.id)!)
    assert.ok(held.every(Boolean))
    await fails({ note: PLAN, data: IMAGE }, 'busy')
    const upload = await h.admin('POST', h.url('/api/attachments', { note: PLAN }), new Uint8Array(PNG))
    assert.deepEqual([upload.status, upload.body.error], [429, 'busy'])
    for (const release of held) release()
    const ok = await c.call('attach_image', { note: PLAN, data: IMAGE })
    assert.equal(ok.error, false, ok.raw)
    await c.close()
  } finally { await h.close() }
})

test('the MCP request limit is vihko\'s own, 4 MiB: an image of about 3 MB fits in one, a request over it is 413 whatever VIHKO_MAX_IMAGE_MB says', async () => {
  const h = await setup({ files: FILES, maxImageBytes: 20 * 1024 * 1024 })
  try {
    assert.equal(MAX_MCP_BODY, 4 * 1024 * 1024)
    await h.enableMcp()
    const { token } = await h.newKey({ name: m.aKeyName(), canWrite: true, folders: [DIR] })
    const before = listing(h.notesDir)
    const post = (body: string) => h.app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body,
    })
    const call = (data: string) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'attach_image', arguments: { note: PLAN, data } } })
    // Bytes that aren't an image, as big as fits: the request is read, and the tool answers.
    const envelope = call('').length
    const fits = Buffer.alloc(Math.floor((MAX_MCP_BODY - envelope) * 3 / 4) - 3, 1).toString('base64')
    assert.ok(Buffer.from(fits, 'base64').length > 3_000_000, 'about 3 MB of bytes')
    const read = await post(call(fits))
    assert.equal(read.status, 200)
    assert.match(await read.text(), /unsupported_type/)
    // One byte over the limit: refused before any tool runs.
    const over = await post(call(fits + 'A'.repeat(MAX_MCP_BODY - call(fits).length + 1)))
    assert.equal(over.status, 413)
    assert.deepEqual(listing(h.notesDir), before, 'nothing stored')
  } finally { await h.close() }
})
