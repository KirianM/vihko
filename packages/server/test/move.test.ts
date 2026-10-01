import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { markdownDest, readFrontmatter } from '@vihko/core'
import { Indexer, NoteError, NoteService, dumpIndex, openIndex, type Actor } from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

// Over a copy of the test vault: its notes and links are the fixture; the new names are the mother's.
const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))
/** A new name with a space in it (a Markdown link escapes it), and one without. */
const spaced = () => `${m.aTitle()} ${m.aWord()}`
const token = () => m.aUniqueWord()
const me: Actor = { kind: 'user', id: m.faker.string.ulid() }

function setup() {
  const dir = tempDir('vihko-move-')
  const notesDir = join(dir, 'notes')
  cpSync(VAULT, notesDir, { recursive: true })
  const db = openIndex(join(dir, 'index.db'))
  const indexer = new Indexer({ notesDir, db })
  indexer.scan()
  const notes = new NoteService({ notesDir, stateDir: join(dir, 'state'), indexer, db })
  const body = (p: string) => { const t = readFileSync(join(notesDir, p), 'utf8'); return t.slice(readFrontmatter(t).bodyStart) }
  const dst = (src: string, raw: string) => (db.prepare('select dst_path from links where src_path = ? and raw = ?').get(src, raw) as { dst_path: string } | undefined)?.dst_path
  return { dir, notesDir, db, indexer, notes, body, dst }
}

test('renaming rewrites wikilinks (with an anchor) and Markdown links, and leaves the still-valid ones alone', async () => {
  const { notes, body, dst } = setup()
  const name = spaced()
  const r = await notes.move('hogar/Proxy.md', `hogar/${name}.md`, { actor: me })
  assert.deepEqual(r.failed, [])
  const t = body('hogar/enlaces.md')
  assert.ok(t.includes('- [[gw]] resuelve por alias'), "the alias still works: it's left alone")
  assert.ok(t.includes(`[[${name}#Red]]`))
  assert.ok(t.includes(`[[${name}#No existe]]`))
  const escaped = name.replaceAll(' ', '%20')
  assert.ok(t.includes(`[Proxy en Markdown](${escaped}.md)`))
  assert.equal(dst('hogar/enlaces.md', `[[${name}#Red]]`), `hogar/${name}.md`)
  assert.equal(dst('hogar/enlaces.md', `[Proxy en Markdown](${escaped}.md)`), `hogar/${name}.md`)
})

test('renaming to a name a Markdown link must encode: the rewritten links still resolve, in both forms', async () => {
  // The names are the case under test: brackets, parentheses, `#`, `?` and spaces in a destination.
  for (const name of ['a (1)', 'x#y', 'ñ [b]', 'q?']) {
    const { notes, body, dst, db } = setup()
    const r = await notes.move('hogar/Proxy.md', `hogar/${name}.md`, { actor: me })
    assert.deepEqual(r.failed, [])
    const links = db.prepare("select raw, dst_path from links where src_path = 'hogar/enlaces.md' and kind = 'markdown'").all() as { raw: string; dst_path: string | null }[]
    const toIt = links.filter((l) => l.dst_path === `hogar/${name}.md`)
    assert.ok(toIt.length > 0, `${name}: ${JSON.stringify(links)}`)
    assert.ok(body('hogar/enlaces.md').includes(`[Proxy en Markdown](${markdownDest(name)}.md)`), name)
    // And it moves on from there, to another folder: still found.
    const to = `${token()}/${name}.md`
    await notes.move(`hogar/${name}.md`, to, { actor: me })
    assert.equal(dst('hogar/enlaces.md', `[Proxy en Markdown](../${markdownDest(to)})`), to, `${name}: ${body('hogar/enlaces.md')}`)
  }
})

test('a Markdown link in <…> keeps that form, its anchor and its title when rewritten', async () => {
  const { notes, body, dst, indexer, notesDir } = setup()
  const src = m.aNotePath(m.aFolder())
  const [label, title] = [m.aWord(), m.aWord()]
  mkdirSync(join(notesDir, src, '..'), { recursive: true })
  writeFileSync(join(notesDir, src), `${m.aSentence()} [${label}](<../hogar/Proxy.md#Red> "${title}")\n`)
  indexer.indexPaths([src])
  // A name to encode (the case under test).
  await notes.move('hogar/Proxy.md', 'hogar/a (1).md', { actor: me })
  const raw = `[${label}](<../hogar/a%20%281%29.md#Red> "${title}")`
  assert.ok(body(src).includes(raw), body(src))
  assert.equal(dst(src, raw), 'hogar/a (1).md')
})

test('moving to another folder uses the shortest unambiguous suffix and keeps visible text and embeds', async () => {
  const { notes, body, dst } = setup()
  const archive = token()
  await notes.move('proyectos/vihko/Plan.md', `${archive}/Plan.md`, { actor: me })
  const t = body('proyectos/vihko/notas.md')
  // From proyectos/vihko/, [[Plan]] would now go to proyectos/blog/Plan.md: it needs disambiguating.
  assert.ok(t.includes(`- [[${archive}/Plan]] resuelve`))
  assert.ok(t.includes(`- [[${archive}/Plan|el plan]]`))
  assert.ok(t.includes(`- ![[${archive}/Plan]]`))
  assert.equal(dst('proyectos/vihko/notas.md', `[[${archive}/Plan|el plan]]`), `${archive}/Plan.md`)
  assert.ok(body('hogar/enlaces.md').includes(`[Plan de vihko](../${archive}/Plan.md)`))
})

test('a rename doesn\'t "steal" links from other notes; an absolute path is used if needed', async () => {
  const { notes, body, dst } = setup()
  // [[Plan]] in diario/ resolves to the root Plan.md. Bringing a Plan.md into diario/ would make it point there instead.
  const r = await notes.move('proyectos/blog/Plan.md', 'diario/Plan.md', { actor: me })
  assert.ok(r.relinked.some((x) => x.path === 'diario/2026-09-24.md'))
  assert.ok(body('diario/2026-09-24.md').includes('- [[/Plan]] resuelve'), 'the root is only reached with an absolute path')
  assert.equal(dst('diario/2026-09-24.md', '[[/Plan]]'), 'Plan.md')
  // [[proyectos/blog/Plan]] and [[blog/Plan]] pointed to the moved note: they switch to the shortest form.
  assert.ok(body('diario/2026-09-24.md').includes('- [[Plan]] ruta parcial'))
  assert.ok(body('diario/2026-09-24.md').includes('- [[Plan]] sufijo de ruta'))
  assert.equal(dst('diario/2026-09-24.md', '[[Plan]]'), 'diario/Plan.md')
})

test("the moved note's own links keep pointing to the same thing", async () => {
  const { notes, body, dst } = setup()
  const name = spaced()
  const to = `${m.aFolder()}/${name}.md`
  await notes.move('proyectos/vihko/notas.md', to, { actor: me })
  const t = body(to)
  assert.ok(t.includes('- [[proyectos/vihko/Plan]] resuelve') || t.includes('- [[vihko/Plan]] resuelve'), t)
  assert.ok(t.includes(`- [[${name}]] enlace a sí misma`))
  assert.equal(dst(to, `[[${name}]]`), to)
})

test('the preview details every link that changes and those that keep working untouched', async () => {
  const { notes } = setup()
  const name = spaced()
  const r = await notes.move('hogar/Proxy.md', `hogar/${name}.md`, { actor: me, dryRun: true })
  const enlaces = r.relinked.find((x) => x.path === 'hogar/enlaces.md')!
  assert.deepEqual(enlaces.changes, [
    { before: '[[Proxy#Red]]', after: `[[${name}#Red]]`, kind: 'link', to: `hogar/${name}.md` },
    { before: '[[Proxy#No existe]]', after: `[[${name}#No existe]]`, kind: 'link', to: `hogar/${name}.md` },
    { before: '[Proxy en Markdown](Proxy.md)', after: `[Proxy en Markdown](${name.replaceAll(' ', '%20')}.md)`, kind: 'link', to: `hogar/${name}.md` },
  ])
  assert.equal(enlaces.links, enlaces.changes.length)
  assert.deepEqual(r.kept.filter((k) => k.path === 'hogar/enlaces.md'), [{ path: 'hogar/enlaces.md', raw: '[[gw]]', via: 'alias' }])
  // Moving without renaming: links by name keep working.
  const moved = await notes.move('hogar/Proxy.md', `${m.aFolder()}/Proxy.md`, { actor: me, dryRun: true })
  assert.ok(moved.kept.some((k) => k.raw === '[[Proxy#Red]]' && k.via === 'path'))
  assert.ok(!moved.relinked.some((x) => x.changes.some((c) => c.before === '[[Proxy#Red]]')))
})

test('dryRun changes nothing; an existing destination and a stale if_match are rejected', async () => {
  const { notesDir, db, notes } = setup()
  const snapshot = dumpIndex(db)
  const to = m.aNotePath('hogar')
  const r = await notes.move('hogar/Proxy.md', to, { actor: me, dryRun: true })
  assert.equal(r.dryRun, true)
  assert.ok(r.relinked.some((x) => x.path === 'hogar/enlaces.md'))
  assert.ok(existsSync(join(notesDir, 'hogar/Proxy.md')) && !existsSync(join(notesDir, to)))
  assert.equal(dumpIndex(db), snapshot)
  await assert.rejects(notes.move('hogar/Proxy.md', '../fuera.md', { actor: me, dryRun: true }), (e: NoteError) => e.code === 'invalid_path')
  await assert.rejects(notes.move('hogar/Proxy.md', 'hogar/Red.md', { actor: me }), (e: NoteError) => e.code === 'exists')
  await assert.rejects(notes.move('hogar/Proxy.md', m.aNotePath(), { actor: me, ifMatch: 'sha256:bad' }), (e: NoteError) => e.code === 'precondition_failed')
})

test('if a rewrite fails, the old name is kept as an alias', { skip: process.getuid?.() === 0 }, async () => {
  const { notesDir, indexer, notes, dst } = setup()
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const [folder, locked, target, renamed] = [m.aFolder(), m.aFolder(), m.aTitle(), m.aTitle()]
  const [from, to, linking] = [`${folder}/${target}.md`, `${folder}/${renamed}.md`, m.aNotePath(locked)]
  mkdirSync(join(notesDir, folder))
  mkdirSync(join(notesDir, locked))
  writeFileSync(join(notesDir, from), `# ${target}\n`)
  writeFileSync(join(notesDir, linking), `[[${target}]]\n`)
  indexer.scan()
  chmodSync(join(notesDir, locked), 0o555)
  try {
    const r = await notes.move(from, to, { actor: me })
    assert.deepEqual(r.failed.map((f) => [f.path, f.error]), [[linking, 'internal']])
    assert.equal(r.aliasAdded, target)
    assert.deepEqual(readFrontmatter(readFileSync(join(notesDir, to), 'utf8')).data.aliases, [target])
    assert.equal(readFileSync(join(notesDir, linking), 'utf8'), `[[${target}]]\n`)
    assert.equal(dst(linking, `[[${target}]]`), to, 'the unrewritten link still resolves via the alias')
  } finally {
    chmodSync(join(notesDir, locked), 0o755)
  }
})

test('with links.aliases off, a failed rewrite adds no alias: it would save nothing', { skip: process.getuid?.() === 0 }, async () => {
  const { notesDir, indexer, notes, dst } = setup()
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const [folder, locked, target, renamed] = [m.aFolder(), m.aFolder(), m.aTitle(), m.aTitle()]
  const [from, to, linking] = [`${folder}/${target}.md`, `${folder}/${renamed}.md`, m.aNotePath(locked)]
  mkdirSync(join(notesDir, folder))
  mkdirSync(join(notesDir, locked))
  writeFileSync(join(notesDir, from), `# ${target}\n`)
  writeFileSync(join(notesDir, linking), `[[${target}]]\n`)
  indexer.scan()
  indexer.setLinkAliases(false)
  chmodSync(join(notesDir, locked), 0o555)
  try {
    const r = await notes.move(from, to, { actor: me })
    assert.deepEqual(r.failed.map((f) => [f.path, f.error]), [[linking, 'internal']], 'the failure is still reported')
    assert.equal(r.aliasAdded, null)
    assert.equal(readFrontmatter(readFileSync(join(notesDir, to), 'utf8')).data.aliases, undefined, 'no alias added')
    assert.equal(dst(linking, `[[${target}]]`), null, 'the link left behind is broken')
  } finally {
    chmodSync(join(notesDir, locked), 0o755)
  }
})

test("if the source can't be removed, the note isn't left duplicated", { skip: process.getuid?.() === 0 }, async () => {
  const { notesDir, notes } = setup()
  chmodSync(join(notesDir, 'recetas'), 0o555)
  try {
    const to = m.aNotePath(m.aFolder())
    await assert.rejects(notes.move('recetas/Notas de reunión (2026).md', to, { actor: me }))
    assert.ok(!existsSync(join(notesDir, to)))
    assert.ok(existsSync(join(notesDir, 'recetas/Notas de reunión (2026).md')))
  } finally {
    chmodSync(join(notesDir, 'recetas'), 0o755)
  }
})

test('a move says when the note is in place, counts its rewrites, and moves run one at a time', async () => {
  const { notes } = setup()
  const events: string[] = []
  const hooks = (name: string) => ({
    onMoved: (n: number) => { events.push(`${name} moved (${n} to rewrite)`) },
    onProgress: (done: number, total: number) => { if (done === total) events.push(`${name} ${done}/${total}`) },
  })
  const [a, b] = await Promise.all([
    notes.move('hogar/Proxy.md', m.aNotePath('hogar'), { actor: me, ...hooks('a') }).then((r) => { events.push('a done'); return r }),
    // To `blog`, the name a vault note's partial link already uses: one rewrite, as counted below.
    notes.moveFolder('proyectos/blog', 'blog', { actor: me, ...hooks('b') }).then((r) => { events.push('b done'); return r }),
  ])
  assert.deepEqual([a.failed, b.failed], [[], []])
  assert.deepEqual(events, ['a moved (1 to rewrite)', 'a 1/1', 'a done', 'b moved (1 to rewrite)', 'b 1/1', 'b done'])
})
