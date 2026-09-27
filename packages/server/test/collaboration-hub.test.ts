// Commenting on an open note (D-038.5), on a real server: the comment of
// someone with `comment` (whose editor is read-only) reaches the document the
// others are editing, merged with their typing, and the file; one refused
// touches nothing. Their typing never goes in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLI, api, closeAll, connect, login, makeDirs, sleep, startServer, typeLine, waitFor } from './_collab.ts'
import { yamlKey } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** `text` for a regular expression that matches it literally. */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

test('a comment by someone who may only comment reaches the open document and the file; their typing never does', async () => {
  const { notes, env, admin } = makeDirs()
  const member = m.aUser()
  // The member manages their recipes, the admin may only comment there.
  const NOTE = `personas/${member.username}/recetas/tarta.md`
  const RULES = `permissions:
  "":
    grants: { ${yamlKey(admin.username)}: manage }
  "personas/{user}":
    grants: { "{user}": manage }
  ${yamlKey(`personas/${member.username}/recetas`)}:
    grants: { ${yamlKey(member.username)}: manage, ${yamlKey(admin.username)}: comment }
`
  spawnSync(process.execPath, [CLI, 'user', 'create', member.username], { env: { ...process.env, ...env }, input: member.password })
  mkdirSync(join(notes, `personas/${member.username}/recetas`), { recursive: true })
  writeFileSync(join(notes, NOTE), '---\nuid: 01TARTA0000000000000000000\n---\n# Tarta\n\nCon manzana.\n\nAl horno.\n')
  writeFileSync(join(notes, 'thoth.yaml'), RULES)
  const srv = await startServer({ ...env, THOTH_HISTORY_QUIET_SECONDS: '0.4' })
  try {
    const k = await login(srv)
    const l = await login(srv, member)
    const memberEditor = await connect(srv, l, NOTE)
    const adminEditor = await connect(srv, k, NOTE)
    typeLine(memberEditor, 'MEMBER-TYPES')
    await waitFor(() => adminEditor.text().includes('MEMBER-TYPES'), 'the member\'s typing reaches the admin')
    typeLine(adminEditor, 'ADMIN-TYPES')

    const text = adminEditor.text()
    const at = text.indexOf('Con manzana.') + 'Con manzana.'.length
    const r = await api(srv, k, 'POST', '/api/note/comment', { path: NOTE, op: 'add', at, context: text.slice(at - 40, at), text: 'Mejor pera' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const comment = new RegExp(`<!-- @${literally(admin.username)} \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}Z · Mejor pera -->`, 'u')
    await waitFor(() => memberEditor.text().includes(`Con manzana.<!-- @${admin.username} `) && comment.test(memberEditor.text()), 'the comment reaches the member\'s editor')
    await waitFor(() => comment.test(adminEditor.text()), 'and the admin\'s own read-only copy')
    await waitFor(() => comment.test(readFileSync(join(notes, NOTE), 'utf8')), 'and the file')
    assert.ok(memberEditor.text().includes('MEMBER-TYPES'), 'merged with what they typed')

    // Resolving the member's thread isn't the admin's to do: nothing changes.
    memberEditor.doc.getText('md').insert(memberEditor.text().indexOf('Al horno.') + 'Al horno.'.length, `<!-- @${member.username} 2026-09-27T10:00Z · ¿Cuánto rato? -->`)
    await waitFor(() => adminEditor.text().includes('¿Cuánto rato?'), 'the member\'s comment reaches the admin')
    const before = memberEditor.text()
    const thread = `${member.username}|2026-09-27T10:00Z|¿Cuánto rato?|0`
    const refused = await api(srv, k, 'POST', '/api/note/comment', { path: NOTE, op: 'resolve', thread })
    assert.equal(refused.status, 403)
    const replied = await api(srv, k, 'POST', '/api/note/comment', { path: NOTE, op: 'reply', thread, text: 'Cuarenta minutos' })
    assert.equal(replied.status, 200, JSON.stringify(replied.body))
    await waitFor(() => memberEditor.text().includes('↳ Cuarenta minutos'), 'the reply reaches the member')
    assert.equal(memberEditor.text().replace(new RegExp(`\\n?<!-- @${literally(admin.username)} [^>]*↳ Cuarenta minutos -->`, 'u'), ''), before)

    await sleep(1500)
    assert.doesNotMatch(readFileSync(join(notes, NOTE), 'utf8'), /ADMIN-TYPES/)
    assert.doesNotMatch(memberEditor.text(), /ADMIN-TYPES/)
  } finally { closeAll(); await srv.stop() }
})
