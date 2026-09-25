import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { posix } from 'node:path'
import { LinkIndex, extract, joinPath, shortestTarget, type Resolution } from '@thoth/core'

const ROOT = fileURLToPath(new URL('../../../testdata/vault/', import.meta.url))

/** Loads the vault's notes. The ignore filter is provisional: the indexer will do it. */
function loadVault() {
  const index = new LinkIndex()
  const texts = new Map<string, string>()
  for (const e of readdirSync(ROOT, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    const path = (e.parentPath.slice(ROOT.length) + '/' + e.name).replace(/^\//, '')
    if (path.split('/').some((s) => s.startsWith('.')) || path.includes('.sync-conflict-')) continue
    const text = readFileSync(ROOT + path, 'utf8')
    const x = extract(text)
    const aliases = x.frontmatter.data.aliases
    index.set({ path, aliases: Array.isArray(aliases) ? aliases.map(String) : [], headings: x.headings.map((h) => h.text) })
    texts.set(path, text)
  }
  return { index, texts }
}

const { index, texts } = loadVault()

/** Resolves every link in a note, indexed by its literal text. */
function resolveAll(source: string): Map<string, Resolution> {
  const out = new Map<string, Resolution>()
  for (const l of extract(texts.get(source)!).links) out.set(l.raw, index.resolve(source, l))
  return out
}

const ok = (path: string, anchor: 'ok' | 'missing' | null = null) => ({ status: 'resolved', path, anchor })
function assertResolves(r: Resolution | undefined, expected: { status: string; path?: string; anchor?: string | null; candidates?: string[] }) {
  assert.ok(r, 'link not found in the note')
  const { via: _via, ...rest } = r as Resolution & { via?: string }
  assert.deepEqual(rest, expected)
}

test('same folder, uppercase, display text, embed and self-reference', () => {
  const r = resolveAll('proyectos/thoth/notas.md')
  for (const raw of ['[[Plan]]', '[[plan]]', '[[Plan|el plan]]', '![[Plan]]']) assertResolves(r.get(raw), ok('proyectos/thoth/Plan.md'))
  assertResolves(r.get('[[notas]]'), ok('proyectos/thoth/notas.md'))
})

test('tie-break by depth and real ambiguity', () => {
  const r = resolveAll('diario/2026-09-24.md')
  assertResolves(r.get('[[Plan]]'), ok('Plan.md'))
  assertResolves(r.get('[[Tareas]]'), { status: 'ambiguous', candidates: ['proyectos/blog/Tareas.md', 'proyectos/thoth/Tareas.md'] })
  assertResolves(r.get('[[proyectos/blog/Plan]]'), ok('proyectos/blog/Plan.md'))
  assertResolves(r.get('[[blog/Plan]]'), ok('proyectos/blog/Plan.md'))
})

test('unicode NFC against an NFD filename, and names with spaces', () => {
  const r = resolveAll('recetas/índice.md')
  const cafe = [...texts.keys()].find((p) => p.normalize('NFC') === 'recetas/Café.md')!
  assert.notEqual(cafe, 'recetas/Café.md', 'the vault file must be in NFD')
  assertResolves(r.get('[[Café]]'), ok(cafe))
  assertResolves(r.get('[[CAFÉ]]'), ok(cafe))
  assertResolves(r.get('[[Notas de reunión (2026)]]'), ok('recetas/Notas de reunión (2026).md'))
})

test('alias, name priority, anchors, broken links and relative Markdown', () => {
  const r = resolveAll('hogar/enlaces.md')
  const gw = r.get('[[gw]]')!
  assertResolves(gw, ok('hogar/Proxy.md'))
  assert.equal((gw as { via: string }).via, 'alias')
  assertResolves(r.get('[[Red]]'), ok('hogar/Red.md'))
  assertResolves(r.get('[[Proxy#Red]]'), ok('hogar/Proxy.md', 'ok'))
  assertResolves(r.get('[[Proxy#No existe]]'), ok('hogar/Proxy.md', 'missing'))
  assertResolves(r.get('[[Nota que no existe]]'), { status: 'missing' })
  assertResolves(r.get('[Proxy en Markdown](Proxy.md)'), ok('hogar/Proxy.md'))
  assertResolves(r.get('[Plan de thoth](../proyectos/thoth/Plan.md)'), ok('proyectos/thoth/Plan.md'))
  assertResolves(r.get('[roto](no-existe.md)'), { status: 'missing' })
})

test('from the root and from another folder, the root Plan.md wins', () => {
  assertResolves(resolveAll('codigo.md').get('[[Plan]]'), ok('Plan.md'))
  assertResolves(resolveAll('frontmatter/bom-crlf.md').get('[[Plan]]'), ok('Plan.md'))
})

test('incremental: affected keys allow re-resolving only what is needed', () => {
  const idx = new LinkIndex()
  idx.set({ path: 'a/Nota.md' })
  const link = { kind: 'wiki' as const, target: 'Nota', anchor: null }
  assertResolves(idx.resolve('b/x.md', link), ok('a/Nota.md'))
  const affected = idx.set({ path: 'c/Nota.md' })
  assert.ok(affected.has(LinkIndex.keyOf('b/x.md', link)!), 'creating another "Nota" affects [[Nota]] links')
  assertResolves(idx.resolve('b/x.md', link), { status: 'ambiguous', candidates: ['a/Nota.md', 'c/Nota.md'] })
  idx.delete('a/Nota.md')
  assertResolves(idx.resolve('b/x.md', link), ok('c/Nota.md'))
  const renamed = idx.set({ path: 'c/Nota.md', aliases: ['alias'] })
  assert.ok(renamed.has('alias'))
})

test('[[/path]] is an exact path from the root', () => {
  const idx = new LinkIndex()
  idx.set({ path: 'Plan.md' })
  idx.set({ path: 'diario/Plan.md' })
  const r = (target: string) => idx.resolve('diario/hoy.md', { kind: 'wiki', target, anchor: null })
  assertResolves(r('Plan'), ok('diario/Plan.md'))
  assertResolves(r('/Plan'), ok('Plan.md'))
  assertResolves(r('/diario/Plan'), ok('diario/Plan.md'))
  assertResolves(r('/Plan/x'), { status: 'missing' })
  assertResolves(r('/iario/Plan'), { status: 'missing' }, )
})

test('joinPath matches posix.join for relative note paths', () => {
  const cases: [string, string][] = [
    ['', 'Nota.md'], ['a', 'Nota.md'], ['a/b', '../Nota.md'], ['a', '../../Nota.md'], ['', '../x.md'],
    ['a/b', './c/../d.md'], ['a', '/x.md'], ['a//b', 'c.md'], ['a/b', '../../..'],
  ]
  for (const [dir, rel] of cases) assert.equal(joinPath(dir, rel), posix.join(dir, rel), `${dir} + ${rel}`)
})

test('shortestTarget: the name, a longer suffix if ambiguous, the absolute path if unreachable', () => {
  // From the vault: three Plan.md (root, proyectos/blog, proyectos/thoth).
  assert.equal(shortestTarget(index, 'hogar/enlaces.md', 'Plan.md'), 'Plan')
  assert.equal(shortestTarget(index, 'hogar/enlaces.md', 'proyectos/blog/Plan.md'), 'blog/Plan')
  assert.equal(shortestTarget(index, 'proyectos/blog/Tareas.md', 'proyectos/blog/Plan.md'), 'Plan')
  assert.equal(shortestTarget(index, 'proyectos/blog/Tareas.md', 'proyectos/thoth/Plan.md'), 'thoth/Plan')
  // The root Plan.md loses by proximity to blog/Plan.md and has no longer suffix.
  assert.equal(shortestTarget(index, 'proyectos/blog/Tareas.md', 'Plan.md'), '/Plan')
  assert.equal(shortestTarget(index, 'Plan.md', 'hogar/Proxy.md'), 'Proxy')
  // An alias with the same text as another note's name does not shadow the name.
  const idx = new LinkIndex()
  idx.set({ path: 'a/Nota.md', aliases: ['Otra'] })
  idx.set({ path: 'b/Otra.md' })
  assert.equal(shortestTarget(idx, 'x.md', 'b/Otra.md'), 'Otra')
})
