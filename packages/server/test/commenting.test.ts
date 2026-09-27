// Commenting with `comment` (D-038.5), in process: the server writes the
// comment, a reply or a resolved thread of one's own, and nothing else; with
// `edit`, anyone's thread; with `read`, nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FILES, RULES, setup } from './_m4.ts'

const TARTA = 'personas/laura/recetas/tarta.md'
const CODE = 'personas/laura/recetas/codigo.md'
const DIARY = 'personas/laura/diario/2026-09-27.md'
// Laura shares her recipes with Noa to comment and with Marta to read (the spec's scenario 2).
const SHARED = RULES + '  personas/laura/recetas:\n    grants: { laura: manage, noa: comment, marta: read }\n'
const WHEN = '2026-09-27T10:00Z'

/** The comment request for right after `after` in the note as it is now. */
function addAfter(text: string, after: string, comment: string, path = TARTA) {
  const at = text.indexOf(after) + after.length
  return { path, op: 'add', at, context: text.slice(Math.max(0, at - 80), at), text: comment }
}

test('with comment, a person adds comments, replies and resolves their own threads; the server writes exactly that, and nothing else', async () => {
  const h = await setup({ files: { ...FILES, [CODE]: '# Código\n\n```\nuno dos\n```\n\nFin.\n' }, config: SHARED })
  try {
    const file = (p = TARTA) => readFileSync(join(h.notesDir, p), 'utf8')
    const q = (p: string) => `/api/note?path=${encodeURIComponent(p)}`
    // What each one may do, as the note says.
    assert.equal((await h.noa('GET', q(TARTA))).body.level, 'comment')
    assert.equal((await h.marta('GET', q(TARTA))).body.level, 'read')
    assert.equal((await h.laura('GET', q(TARTA))).body.level, 'manage')

    // Noa can't edit or see the history (D-034 3.5), but he comments.
    const cur = await h.noa('GET', q(TARTA))
    assert.equal((await h.noa('PUT', q(TARTA), { text: 'x' }, { 'if-match': `"${cur.body.etag}"` })).status, 403)
    assert.equal((await h.noa('GET', `/api/history/versions?path=${encodeURIComponent(TARTA)}`)).status, 403)
    const before = file()
    let r = await h.noa('POST', '/api/note/comment', addAfter(before, 'Tarta Obsidiana.', 'Con menos azúcar --> mejor'))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(file(), before.replace('Tarta Obsidiana.', `Tarta Obsidiana.<!-- @noa ${WHEN} · Con menos azúcar -- > mejor -->`))
    assert.equal(r.body.etag, `sha256:${(await import('node:crypto')).createHash('sha256').update(file()).digest('hex')}`)

    // Laura (manage) comments the title; Noa replies to her, can't resolve it, and resolves his own.
    r = await h.laura('POST', '/api/note/comment', addAfter(file(), '# Tarta de Laura', '¿Le cambio el nombre?'))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const threads = async () => (await h.laura('GET', `/api/note/comments?path=${encodeURIComponent(TARTA)}`)).body.threads as { id: string }[]
    const lauras = (await threads()).find((t) => t.id.startsWith('laura|'))!.id
    const kirians = (await threads()).find((t) => t.id.startsWith('noa|'))!.id
    r = await h.noa('POST', '/api/note/comment', { path: TARTA, op: 'reply', thread: lauras, text: 'Sí' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(file().includes(`# Tarta de Laura<!-- @laura ${WHEN} · ¿Le cambio el nombre? -->\n<!-- @noa ${WHEN} · ↳ Sí -->`), file())
    const withBoth = file()
    r = await h.noa('POST', '/api/note/comment', { path: TARTA, op: 'resolve', thread: lauras })
    assert.equal(r.status, 403, 'only whoever started a thread, or someone who can edit, resolves it')
    assert.equal(file(), withBoth)
    r = await h.noa('POST', '/api/note/comment', { path: TARTA, op: 'resolve', thread: kirians })
    assert.equal(r.status, 200)
    assert.ok(!file().includes('menos azúcar') && file().includes('Tarta Obsidiana. [[compra]]'))
    // With edit, anyone's.
    r = await h.laura('POST', '/api/note/comment', { path: TARTA, op: 'resolve', thread: lauras })
    assert.equal(r.status, 200)
    assert.equal(file(), before)

    // With read, nothing; where it can't see, it doesn't exist.
    assert.equal((await h.marta('POST', '/api/note/comment', addAfter(file(), 'Tarta Obsidiana.', 'Hola'))).status, 403)
    assert.equal((await h.marta('POST', '/api/note/comment', addAfter(file(DIARY), 'Secreto Turmalina.', 'Hola', DIARY))).status, 404)
    // Only a comment: not in the frontmatter, not inside code, not where the text isn't any more.
    assert.equal((await h.noa('POST', '/api/note/comment', addAfter(file(), 'uid: 01TARTA', 'x'))).status, 400)
    const code = file(CODE)
    assert.equal((await h.noa('POST', '/api/note/comment', addAfter(code, 'uno', 'x', CODE))).status, 400)
    assert.equal((await h.noa('POST', '/api/note/comment', { path: TARTA, op: 'add', at: 10, context: 'no está en la nota', text: 'x' })).status, 412)
    assert.equal((await h.noa('POST', '/api/note/comment', { path: TARTA, op: 'add', at: 10, context: '', text: '   ' })).status, 400)
    assert.equal((await h.noa('POST', '/api/note/comment', { path: TARTA, op: 'edit', text: 'x' })).status, 400)
    assert.equal(file(CODE), code)
    assert.equal(file(), before)

    // Each comment is a version by whoever wrote it (Laura sees the history).
    await h.settle()
    const versions = (await h.laura('GET', `/api/history/versions?path=${encodeURIComponent(TARTA)}`)).body.versions as { authors: { name: string }[] }[]
    assert.ok(versions.some((v) => v.authors.map((a) => a.name).join() === 'noa'), JSON.stringify(versions))
  } finally { await h.close() }
})

test('with comment, one\'s own thread with replies from other people isn\'t theirs to resolve (D-040 3.7); with only their own, it is', async () => {
  const h = await setup({ files: FILES, config: SHARED })
  try {
    const file = () => readFileSync(join(h.notesDir, TARTA), 'utf8')
    const threads = async () => (await h.noa('GET', `/api/note/comments?path=${encodeURIComponent(TARTA)}`)).body.threads as { id: string }[]
    // Two threads of Noa's: Laura replies to one, he replies to the other himself.
    let r = await h.noa('POST', '/api/note/comment', addAfter(file(), '# Tarta de Laura', '¿Con canela?'))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    r = await h.noa('POST', '/api/note/comment', addAfter(file(), 'Tarta Obsidiana.', '¿Cuántos huevos?'))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const [canela, huevos] = (await threads()).map((t) => t.id)
    assert.ok(canela && huevos)
    assert.equal((await h.laura('POST', '/api/note/comment', { path: TARTA, op: 'reply', thread: canela, text: 'Mejor no' })).status, 200)
    assert.equal((await h.noa('POST', '/api/note/comment', { path: TARTA, op: 'reply', thread: huevos, text: 'Tres, creo' })).status, 200)

    // With her reply in it, resolving would take her words out of the note: forbidden, nothing written.
    const before = file()
    r = await h.noa('POST', '/api/note/comment', { path: TARTA, op: 'resolve', thread: canela })
    assert.deepEqual([r.status, r.body.error], [403, 'forbidden'])
    assert.equal(file(), before)
    // Only his own replies: as before.
    r = await h.noa('POST', '/api/note/comment', { path: TARTA, op: 'resolve', thread: huevos })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(!file().includes('huevos') && !file().includes('Tres, creo'))
    // Someone who can edit resolves it, replies and all.
    r = await h.laura('POST', '/api/note/comment', { path: TARTA, op: 'resolve', thread: canela })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(!file().includes('canela') && !file().includes('Mejor no'))
  } finally { await h.close() }
})
