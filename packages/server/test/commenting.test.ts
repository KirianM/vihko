// Commenting with `comment` (D-038.5), in process: the server writes the
// comment, a reply or a resolved thread of one's own, and nothing else; with
// `edit`, anyone's thread; with `read`, nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ADMIN, FILES, MEMBER, NAME, OTHER, PATH, RULES, UID, WORD, setup } from './_m4.ts'
import { yamlKey } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const [admin, member] = [ADMIN.username, MEMBER.username]
const CAKE = PATH.cake
const RECIPES = dirname(CAKE)
/** A note of the recipes with a code block (`INSIDE` is in it). */
const CODE = m.aNotePath(RECIPES)
const INSIDE = m.aUniqueWord()
// The member shares their recipes with the admin to comment and with the other member to read (the spec's scenario 2).
const SHARED = RULES + `  ${yamlKey(RECIPES)}:\n    grants: { ${yamlKey(member)}: manage, ${yamlKey(admin)}: comment, ${yamlKey(OTHER.username)}: read }\n`
// The setup's fixed clock, as a comment's date.
const WHEN = '2026-09-27T10:00Z'
/** A sentence of the recipe's text, which comments go after. */
const SENTENCE = `${WORD.cake}.`

/** The comment request for right after `after` in the note as it is now. */
function addAfter(text: string, after: string, comment: string, path = CAKE) {
  const at = text.indexOf(after) + after.length
  return { path, op: 'add', at, context: text.slice(Math.max(0, at - 80), at), text: comment }
}

/** The note's first heading line (its title). */
const titleOf = (text: string) => /^# .*$/m.exec(text)![0]

test('with comment, a person adds comments, replies and resolves their own threads; the server writes exactly that, and nothing else', async () => {
  const h = await setup({ files: { ...FILES, [CODE]: `# ${m.aHeading()}\n\n\`\`\`\n${INSIDE} ${m.aWord()}\n\`\`\`\n\n${m.aSentence()}\n` }, config: SHARED })
  try {
    const file = (p = CAKE) => readFileSync(join(h.notesDir, p), 'utf8')
    const q = (p: string) => `/api/note?path=${encodeURIComponent(p)}`
    // What each one may do, as the note says.
    assert.equal((await h.admin('GET', q(CAKE))).body.level, 'comment')
    assert.equal((await h.other('GET', q(CAKE))).body.level, 'read')
    assert.equal((await h.member('GET', q(CAKE))).body.level, 'manage')

    // The admin can't edit or see the history (D-034 3.5), but comments.
    const cur = await h.admin('GET', q(CAKE))
    assert.equal((await h.admin('PUT', q(CAKE), { text: m.aSentence() }, { 'if-match': `"${cur.body.etag}"` })).status, 403)
    assert.equal((await h.admin('GET', `/api/history/versions?path=${encodeURIComponent(CAKE)}`)).status, 403)
    const before = file()
    // A `-->` in the text would end the HTML comment: it's written `-- >`.
    const [left, right] = [m.aSentence().slice(0, -1), m.aUniqueWord()]
    let r = await h.admin('POST', '/api/note/comment', addAfter(before, SENTENCE, `${left} --> ${right}`))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(file(), before.replace(SENTENCE, `${SENTENCE}<!-- @${admin} ${WHEN} · ${left} -- > ${right} -->`))
    assert.equal(r.body.etag, `sha256:${(await import('node:crypto')).createHash('sha256').update(file()).digest('hex')}`)

    // The member (manage) comments the title; the admin replies, can't resolve it, and resolves their own.
    const title = titleOf(before)
    const [question, answer] = [m.aComment(), m.aComment()]
    r = await h.member('POST', '/api/note/comment', addAfter(file(), title, question))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const threads = async () => (await h.member('GET', `/api/note/comments?path=${encodeURIComponent(CAKE)}`)).body.threads as { id: string }[]
    const members = (await threads()).find((t) => t.id.startsWith(`${member}|`))!.id
    const admins = (await threads()).find((t) => t.id.startsWith(`${admin}|`))!.id
    r = await h.admin('POST', '/api/note/comment', { path: CAKE, op: 'reply', thread: members, text: answer })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(file().includes(`${title}<!-- @${member} ${WHEN} · ${question} -->\n<!-- @${admin} ${WHEN} · ↳ ${answer} -->`), file())
    const withBoth = file()
    r = await h.admin('POST', '/api/note/comment', { path: CAKE, op: 'resolve', thread: members })
    assert.equal(r.status, 403, 'only whoever started a thread, or someone who can edit, resolves it')
    assert.equal(file(), withBoth)
    r = await h.admin('POST', '/api/note/comment', { path: CAKE, op: 'resolve', thread: admins })
    assert.equal(r.status, 200)
    assert.ok(!file().includes(right) && file().includes(`${SENTENCE} [[${NAME.list}]]`))
    // With edit, anyone's.
    r = await h.member('POST', '/api/note/comment', { path: CAKE, op: 'resolve', thread: members })
    assert.equal(r.status, 200)
    assert.equal(file(), before)

    // With read, nothing; where it can't see, it doesn't exist.
    assert.equal((await h.other('POST', '/api/note/comment', addAfter(file(), SENTENCE, m.aComment()))).status, 403)
    assert.equal((await h.other('POST', '/api/note/comment', addAfter(file(PATH.diary), `${WORD.diary}.`, m.aComment(), PATH.diary))).status, 404)
    // Only a comment: not in the frontmatter, not inside code, not where the text isn't any more.
    assert.equal((await h.admin('POST', '/api/note/comment', addAfter(file(), `uid: ${UID.cake}`, m.aComment()))).status, 400)
    const code = file(CODE)
    assert.equal((await h.admin('POST', '/api/note/comment', addAfter(code, INSIDE, m.aComment(), CODE))).status, 400)
    assert.equal((await h.admin('POST', '/api/note/comment', { path: CAKE, op: 'add', at: 10, context: m.aUniqueWord(), text: m.aComment() })).status, 412)
    assert.equal((await h.admin('POST', '/api/note/comment', { path: CAKE, op: 'add', at: 10, context: '', text: '   ' })).status, 400)
    assert.equal((await h.admin('POST', '/api/note/comment', { path: CAKE, op: 'edit', text: m.aComment() })).status, 400)
    assert.equal(file(CODE), code)
    assert.equal(file(), before)

    // Each comment is a version by whoever wrote it (the member sees the history).
    await h.settle()
    const versions = (await h.member('GET', `/api/history/versions?path=${encodeURIComponent(CAKE)}`)).body.versions as { authors: { name: string }[] }[]
    assert.ok(versions.some((v) => v.authors.map((a) => a.name).join() === admin), JSON.stringify(versions))
  } finally { await h.close() }
})

test('with comment, one\'s own thread with replies from other people isn\'t theirs to resolve (D-040 3.7); with only their own, it is', async () => {
  const h = await setup({ files: FILES, config: SHARED })
  try {
    const file = () => readFileSync(join(h.notesDir, CAKE), 'utf8')
    const threads = async () => (await h.admin('GET', `/api/note/comments?path=${encodeURIComponent(CAKE)}`)).body.threads as { id: string }[]
    const [first, second, theirReply, ownReply] = [m.aComment(), m.aComment(), m.aComment(), m.aComment()]
    // Two threads of the admin's: the member replies to one, the admin to the other.
    let r = await h.admin('POST', '/api/note/comment', addAfter(file(), titleOf(file()), first))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    r = await h.admin('POST', '/api/note/comment', addAfter(file(), SENTENCE, second))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const [replied, own] = (await threads()).map((t) => t.id)
    assert.ok(replied && own)
    assert.equal((await h.member('POST', '/api/note/comment', { path: CAKE, op: 'reply', thread: replied, text: theirReply })).status, 200)
    assert.equal((await h.admin('POST', '/api/note/comment', { path: CAKE, op: 'reply', thread: own, text: ownReply })).status, 200)

    // With the member's reply in it, resolving would take their words out of the note: forbidden, nothing written.
    const before = file()
    r = await h.admin('POST', '/api/note/comment', { path: CAKE, op: 'resolve', thread: replied })
    assert.deepEqual([r.status, r.body.error], [403, 'forbidden'])
    assert.equal(file(), before)
    // Only their own replies: as before.
    r = await h.admin('POST', '/api/note/comment', { path: CAKE, op: 'resolve', thread: own })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(!file().includes(second) && !file().includes(ownReply))
    // Someone who can edit resolves it, replies and all.
    r = await h.member('POST', '/api/note/comment', { path: CAKE, op: 'resolve', thread: replied })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(!file().includes(first) && !file().includes(theirReply))
  } finally { await h.close() }
})
