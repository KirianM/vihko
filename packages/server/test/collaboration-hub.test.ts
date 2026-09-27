// Commenting on an open note (D-038.5), on a real server: the comment of
// someone with `comment` (whose editor is read-only) reaches the document the
// others are editing, merged with their typing, and the file; one refused
// touches nothing. Their typing never goes in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLI, api, closeAll, connect, login, makeDirs, sleep, startServer, typeLine, waitFor, type Srv } from './_collab.ts'

const NOTE = 'personas/laura/recetas/tarta.md'
const RULES = `permissions:
  "":
    grants: { noa: manage }
  "personas/{user}":
    grants: { "{user}": manage }
  personas/laura/recetas:
    grants: { laura: manage, noa: comment }
`

async function loginAs(srv: Srv, username: string): Promise<string> {
  const r = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'a-long-password' }) })
  assert.equal(r.status, 200)
  return r.headers.get('set-cookie')!.split(';')[0]!
}

test('a comment by someone who may only comment reaches the open document and the file; their typing never does', async () => {
  const { notes, env } = makeDirs()
  spawnSync(process.execPath, [CLI, 'user', 'create', 'laura'], { env: { ...process.env, ...env }, input: 'a-long-password' })
  mkdirSync(join(notes, 'personas/laura/recetas'), { recursive: true })
  writeFileSync(join(notes, NOTE), '---\nuid: 01TARTA0000000000000000000\n---\n# Tarta\n\nCon manzana.\n\nAl horno.\n')
  writeFileSync(join(notes, 'thoth.yaml'), RULES)
  const srv = await startServer({ ...env, THOTH_HISTORY_QUIET_SECONDS: '0.4' })
  try {
    const k = await login(srv)
    const l = await loginAs(srv, 'laura')
    const laura = await connect(srv, l, NOTE)
    const noa = await connect(srv, k, NOTE)
    typeLine(laura, 'LAURA-TYPES')
    await waitFor(() => noa.text().includes('LAURA-TYPES'), 'Laura\'s typing reaches Noa')
    typeLine(noa, 'NOA-TYPES')

    const text = noa.text()
    const at = text.indexOf('Con manzana.') + 'Con manzana.'.length
    const r = await api(srv, k, 'POST', '/api/note/comment', { path: NOTE, op: 'add', at, context: text.slice(at - 40, at), text: 'Mejor pera' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const comment = /<!-- @noa \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z · Mejor pera -->/
    await waitFor(() => laura.text().includes('Con manzana.<!-- @noa') && comment.test(laura.text()), 'the comment reaches Laura\'s editor')
    await waitFor(() => comment.test(noa.text()), 'and Noa\'s own read-only copy')
    await waitFor(() => comment.test(readFileSync(join(notes, NOTE), 'utf8')), 'and the file')
    assert.ok(laura.text().includes('LAURA-TYPES'), 'merged with what she typed')

    // Resolving Laura's thread isn't his to do: nothing changes.
    laura.doc.getText('md').insert(laura.text().indexOf('Al horno.') + 'Al horno.'.length, '<!-- @laura 2026-09-27T10:00Z · ¿Cuánto rato? -->')
    await waitFor(() => noa.text().includes('¿Cuánto rato?'), 'Laura\'s comment reaches Noa')
    const before = laura.text()
    const refused = await api(srv, k, 'POST', '/api/note/comment', { path: NOTE, op: 'resolve', thread: 'laura|2026-09-27T10:00Z|¿Cuánto rato?|0' })
    assert.equal(refused.status, 403)
    const replied = await api(srv, k, 'POST', '/api/note/comment', { path: NOTE, op: 'reply', thread: 'laura|2026-09-27T10:00Z|¿Cuánto rato?|0', text: 'Cuarenta minutos' })
    assert.equal(replied.status, 200, JSON.stringify(replied.body))
    await waitFor(() => laura.text().includes('↳ Cuarenta minutos'), 'the reply reaches Laura')
    assert.equal(laura.text().replace(/\n?<!-- @noa [^>]*↳ Cuarenta minutos -->/, ''), before)

    await sleep(1500)
    assert.doesNotMatch(readFileSync(join(notes, NOTE), 'utf8'), /NOA-TYPES/)
    assert.doesNotMatch(laura.text(), /NOA-TYPES/)
  } finally { closeAll(); await srv.stop() }
})
