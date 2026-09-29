// Pinning an ambiguous link (D-031.2): one occurrence is rewritten to the
// shortest form that leads to the chosen candidate, alias and anchor kept,
// and only when asked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LinkIndex, extract, readFrontmatter } from '@vihko/core'
import { Indexer, NoteError, NoteService, openIndex, rewriteLink, type Actor } from '@vihko/server'
import { setup as appSetup } from './_app.ts'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))
const me: Actor = { kind: 'user', id: m.faker.string.ulid() }

function setup() {
  const dir = tempDir('vihko-pin-')
  const notesDir = join(dir, 'notes')
  cpSync(VAULT, notesDir, { recursive: true })
  const db = openIndex(join(dir, 'index.db'))
  const indexer = new Indexer({ notesDir, db })
  indexer.scan()
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db })
  const body = (p: string) => { const t = readFileSync(join(notesDir, p), 'utf8'); return t.slice(readFrontmatter(t).bodyStart) }
  const write = (p: string, text: string) => { mkdirSync(join(notesDir, p, '..'), { recursive: true }); writeFileSync(join(notesDir, p), text); indexer.indexPaths([p]) }
  const status = (src: string, raw: string) => db.prepare('select status, dst_path from links where src_path = ? and raw = ? order by ord').all(src, raw) as { status: string; dst_path: string | null }[]
  return { notesDir, db, indexer, notes, body, write, status }
}

// --- The rewrite -----------------------------------------------------------

/** Three notes named alike: two in folders named alike under different parents, one elsewhere; and a note that links. */
const T = m.aTitle()
const HEADING = m.aHeading()
const [TOP, SUB, OTHER_SUB, OTHER_TOP] = [m.aFolder(), m.aFolder(), m.aFolder(), m.aFolder()]
const SOURCE = m.aNotePath(m.aFolder())
const index = () => {
  const i = new LinkIndex()
  for (const path of [`${TOP}/${SUB}/${T}.md`, `${TOP}/${OTHER_SUB}/${T}.md`, `${OTHER_TOP}/${SUB}/${T}.md`, SOURCE]) i.set({ path, headings: [HEADING] })
  return i
}
const linkIn = (text: string) => extract(text).links[0]!

test('the rewrite: the shortest suffix that leads to the chosen note, alias and anchor kept', () => {
  const i = index()
  const alias = m.aHeading()
  const chosen = `${TOP}/${OTHER_SUB}/${T}.md`
  assert.equal(rewriteLink(linkIn(`[[${T}]]`), SOURCE, chosen, i), `[[${OTHER_SUB}/${T}]]`)
  assert.equal(rewriteLink(linkIn(`[[${T}|${alias}]]`), SOURCE, chosen, i), `[[${OTHER_SUB}/${T}|${alias}]]`)
  assert.equal(rewriteLink(linkIn(`[[${T}#${HEADING}]]`), SOURCE, chosen, i), `[[${OTHER_SUB}/${T}#${HEADING}]]`)
  // The spaces inside the brackets stay where they were.
  assert.equal(rewriteLink(linkIn(`[[ ${T} #${HEADING}| ${alias} ]]`), SOURCE, chosen, i), `[[ ${OTHER_SUB}/${T} #${HEADING}| ${alias} ]]`)
  assert.equal(rewriteLink(linkIn(`![[${T}]]`), SOURCE, chosen, i), `![[${OTHER_SUB}/${T}]]`)
  // `${SUB}/${T}` is still ambiguous (under both tops): one more folder.
  assert.equal(rewriteLink(linkIn(`[[${T}]]`), SOURCE, `${TOP}/${SUB}/${T}.md`, i), `[[${TOP}/${SUB}/${T}]]`)
})

test('the rewrite: the absolute path when no suffix reaches the note from there', () => {
  const i = new LinkIndex()
  const [a, b] = [m.aFolder(), m.aFolder()]
  for (const path of [`${T}.md`, `${a}/${T}.md`, `${a}/${b}/${T}.md`]) i.set({ path })
  // From a/, [[T]] is a/T.md: the root one is only reached from the root.
  const alias = m.aHeading()
  assert.equal(rewriteLink(linkIn(`[[${T}|${alias}]]`), m.aNotePath(a), `${T}.md`, i), `[[/${T}|${alias}]]`)
})

// --- The note service ----------------------------------------------------------
// Over the test vault: its two notes named Tareas (one per project) are the ambiguity; the note that links is the mother's.

test('pinning rewrites only the occurrence asked for, and the index then resolves it', async () => {
  const { notes, body, write, status } = setup()
  const source = m.aNotePath(m.aFolder())
  const [heading, first, between, alias] = [m.aHeading(), m.aWord(), m.aWord(), m.aHeading()]
  const text = `# ${heading}\n\n${first} [[Tareas]] ${between} [[Tareas|${alias}]] ${between} [[Tareas]].\n`
  write(source, text)
  assert.deepEqual(status(source, '[[Tareas]]').map((s) => s.status), ['ambiguous', 'ambiguous'])
  const second = text.lastIndexOf('[[Tareas]]')
  const r = await notes.pinLink(source, { raw: '[[Tareas]]', at: second + 1 }, 'proyectos/blog/Tareas.md', { actor: me })
  assert.equal(r.raw, '[[blog/Tareas]]')
  assert.equal(body(source), `# ${heading}\n\n${first} [[Tareas]] ${between} [[Tareas|${alias}]] ${between} [[blog/Tareas]].\n`)
  assert.deepEqual(status(source, '[[blog/Tareas]]'), [{ status: 'resolved', dst_path: 'proyectos/blog/Tareas.md' }])
  assert.deepEqual(status(source, '[[Tareas]]').map((s) => s.status), ['ambiguous'])
  // The first one, without a position; the alias stays.
  const aliased = await notes.pinLink(source, { raw: `[[Tareas|${alias}]]` }, 'proyectos/vihko/Tareas.md', { actor: me })
  assert.equal(aliased.raw, `[[vihko/Tareas|${alias}]]`)
  assert.ok(body(source).includes(` [[vihko/Tareas|${alias}]] ${between} [[blog/Tareas]].`))
})

test("pinning is refused for a note that isn't a candidate or a link that isn't there, and is a no-op once it leads there", async () => {
  const { notes, body, write, notesDir } = setup()
  const source = m.aNotePath(m.aFolder())
  write(source, `# ${m.aHeading()}\n\n[[Tareas]] ${m.aWord()} [[Plan]]\n`)
  const before = readFileSync(join(notesDir, source), 'utf8')
  await assert.rejects(notes.pinLink(source, { raw: '[[Tareas]]' }, 'Plan.md', { actor: me }), (e: NoteError) => e.code === 'edit_mismatch')
  await assert.rejects(notes.pinLink(source, { raw: `[[${m.aTitle()}]]` }, 'Plan.md', { actor: me }), (e: NoteError) => e.code === 'edit_mismatch')
  // [[Plan]] resolves (the root one): it isn't ambiguous, so nothing to pin elsewhere.
  await assert.rejects(notes.pinLink(source, { raw: '[[Plan]]' }, 'proyectos/blog/Plan.md', { actor: me }), (e: NoteError) => e.code === 'edit_mismatch')
  assert.equal(readFileSync(join(notesDir, source), 'utf8'), before, 'nothing written')
  await notes.pinLink(source, { raw: '[[Tareas]]' }, 'proyectos/vihko/Tareas.md', { actor: me })
  const pinned = body(source)
  // Asking again (another tab) for the same destination: it already leads there.
  const again = await notes.pinLink(source, { raw: '[[vihko/Tareas]]' }, 'proyectos/vihko/Tareas.md', { actor: me })
  assert.equal(again.raw, '[[vihko/Tareas]]')
  assert.equal(body(source), pinned)
})

// --- HTTP -----------------------------------------------------------------------

// Over the vault's diary note, whose [[Tareas]] is ambiguous.
test('HTTP: the links carry where they are and their candidates\' titles; pinning goes through the API', async () => {
  const { admin, notesDir } = await appSetup()
  const links = await admin('GET', '/api/note/links?path=diario/2026-09-24.md')
  const tareas = links.body.outgoing.find((l: { raw: string }) => l.raw === '[[Tareas]]')
  assert.equal(tareas.status, 'ambiguous')
  assert.equal(typeof tareas.posFrom, 'number')
  assert.deepEqual(links.body.titles, { 'proyectos/blog/Tareas.md': 'Tareas de blog', 'proyectos/vihko/Tareas.md': 'Tareas de vihko' })

  const r = await admin('POST', '/api/note/link/pin', { path: 'diario/2026-09-24.md', raw: '[[Tareas]]', at: tareas.posFrom, target: 'proyectos/vihko/Tareas.md' })
  assert.equal(r.status, 200)
  assert.equal(r.body.raw, '[[vihko/Tareas]]')
  assert.ok(readFileSync(join(notesDir, 'diario/2026-09-24.md'), 'utf8').includes('- [[vihko/Tareas]] es ambiguo'))
  const bad = await admin('POST', '/api/note/link/pin', { path: 'diario/2026-09-24.md', raw: '[[Tareas]]', target: 'proyectos/vihko/Tareas.md' })
  assert.equal(bad.status, 409)
  assert.equal(bad.body.error, 'edit_mismatch')
  const invalid = await admin('POST', '/api/note/link/pin', { path: 'diario/2026-09-24.md', raw: '[[Tareas]]', at: 'x', target: m.aNotePath() })
  assert.equal(invalid.status, 400)
})
