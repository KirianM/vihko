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
  // The member manages a folder of theirs, where the admin may only comment.
  const people = m.aFolder()
  const folder = `${people}/${member.username}/${m.aFolder()}`
  const NOTE = m.aNotePath(folder)
  const RULES = `permissions:
  "":
    grants: { ${yamlKey(admin.username)}: manage }
  ${yamlKey(`${people}/{user}`)}:
    grants: { "{user}": manage }
  ${yamlKey(folder)}:
    grants: { ${yamlKey(member.username)}: manage, ${yamlKey(admin.username)}: comment }
`
  // Two sentences the comments are anchored after, each ending in a word no other text has.
  const sentence = () => `${m.aSentence().slice(0, -1)} ${m.aUniqueWord()}.`
  const [first, second] = [sentence(), sentence()]
  // What each one comments, and when the member's comment was written (a comment's date, to the minute).
  const [suggestion, question, answer] = [m.aComment(), m.aComment(), m.aComment()]
  const when = m.faker.date.between({ from: '2020-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' }).toISOString().slice(0, 16) + 'Z'
  spawnSync(process.execPath, [CLI, 'user', 'create', member.username], { env: { ...process.env, ...env }, input: member.password })
  mkdirSync(join(notes, folder), { recursive: true })
  writeFileSync(join(notes, NOTE), `---\nuid: ${m.faker.string.ulid()}\n---\n# ${m.aHeading()}\n\n${first}\n\n${second}\n`)
  writeFileSync(join(notes, 'thoth.yaml'), RULES)
  const srv = await startServer({ ...env, THOTH_HISTORY_QUIET_SECONDS: '0.4' })
  try {
    const k = await login(srv)
    const l = await login(srv, member)
    const memberEditor = await connect(srv, l, NOTE)
    const adminEditor = await connect(srv, k, NOTE)
    const [memberTypes, adminTypes] = [m.aUniqueWord(), m.aUniqueWord()]
    typeLine(memberEditor, memberTypes)
    await waitFor(() => adminEditor.text().includes(memberTypes), 'the member\'s typing reaches the admin')
    typeLine(adminEditor, adminTypes)

    const text = adminEditor.text()
    const at = text.indexOf(first) + first.length
    const r = await api(srv, k, 'POST', '/api/note/comment', { path: NOTE, op: 'add', at, context: text.slice(at - 40, at), text: suggestion })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const comment = new RegExp(`<!-- @${literally(admin.username)} \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}Z · ${literally(suggestion)} -->`, 'u')
    await waitFor(() => memberEditor.text().includes(`${first}<!-- @${admin.username} `) && comment.test(memberEditor.text()), 'the comment reaches the member\'s editor')
    await waitFor(() => comment.test(adminEditor.text()), 'and the admin\'s own read-only copy')
    await waitFor(() => comment.test(readFileSync(join(notes, NOTE), 'utf8')), 'and the file')
    assert.ok(memberEditor.text().includes(memberTypes), 'merged with what they typed')

    // Resolving the member's thread isn't the admin's to do: nothing changes.
    memberEditor.doc.getText('md').insert(memberEditor.text().indexOf(second) + second.length, `<!-- @${member.username} ${when} · ${question} -->`)
    await waitFor(() => adminEditor.text().includes(question), 'the member\'s comment reaches the admin')
    const before = memberEditor.text()
    const thread = `${member.username}|${when}|${question}|0`
    const refused = await api(srv, k, 'POST', '/api/note/comment', { path: NOTE, op: 'resolve', thread })
    assert.equal(refused.status, 403)
    const replied = await api(srv, k, 'POST', '/api/note/comment', { path: NOTE, op: 'reply', thread, text: answer })
    assert.equal(replied.status, 200, JSON.stringify(replied.body))
    await waitFor(() => memberEditor.text().includes(`↳ ${answer}`), 'the reply reaches the member')
    assert.equal(memberEditor.text().replace(new RegExp(`\\n?<!-- @${literally(admin.username)} [^>]*↳ ${literally(answer)} -->`, 'u'), ''), before)

    await sleep(1500)
    assert.ok(!readFileSync(join(notes, NOTE), 'utf8').includes(adminTypes))
    assert.ok(!memberEditor.text().includes(adminTypes))
  } finally { closeAll(); await srv.stop() }
})
