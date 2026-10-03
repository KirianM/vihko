// The shared spaces of 0.1.0-rc.1 and rc.2 (`spaces/<readable>-<id>/`, their
// name in vihko.yaml) renamed to their names when vihko starts
// (legacySpaces.ts): as a folder renamed from vihko, keys, pins and the trash
// following; left as they are, with an alert for the admins, when the name
// is taken; and never a folder vihko didn't name that way.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { readablePart, rulesInFile } from '@vihko/core'
import { FolderRefs, legacyTarget, renameLegacySpaces } from '@vihko/server'
import { setup, type Spaces } from './_spacesApp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

const run = (h: Spaces) => renameLegacySpaces({ notesDir: h.notesDir, file: h.services.permissionsFile, notes: h.notes, refs: new FolderRefs({ state: h.state, stateDir: h.stateDir }), indexer: h.indexer })
const rules = (h: Spaces) => rulesInFile(readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8'))
const alertsOf = async (h: Spaces) => ((await h.admin('GET', '/api/alerts')).body.alerts as { code: string }[]).filter((a) => a.code === 'space_not_renamed')

test('a space of rc.1 or rc.2 takes its name as its folder, with its notes, rules, keys, pins and trash', async () => {
  const name = m.aSpaceName()
  const legacy = `spaces/${m.aLegacySpaceFolder(name)}`
  const sub = `${legacy}/${m.aFolder()}`
  const [a, b] = [`${legacy}/${m.aTitle()}.md`, `${sub}/${m.aTitle()}.md`]
  const bName = b.slice(b.lastIndexOf('/') + 1, -3)
  const h = await setup({
    files: { [a]: `# ${m.aHeading()}\n\n[[${bName}]]\n`, [b]: `# ${m.aHeading()}\n` },
    config: (n) => `# the space of the family\npermissions:\n  ${legacy}:\n    name: ${JSON.stringify(name)}\n    grants: { ${n.member}: manage, ${n.other}: edit }\n  ${sub}:\n    ai: false\n`,
  })
  try {
    await h.enable()
    const key = await h.newKey('other', { name: m.aKeyName(), canWrite: false, folders: [sub] })
    h.state.prepare('insert or replace into pins (user_id, path, created_at) values (?, ?, ?)').run(h.created.other.id, sub, new Date().toISOString())
    const trashed = `${sub}/${m.aTitle()}.md`
    h.write(trashed, m.aParagraph())
    const entry = await h.notes.delete(trashed, { actor: { kind: 'user', id: h.created.member.id } })
    // Before: the space goes by its folder, and nobody is told anything yet.
    assert.deepEqual((await h.other('GET', '/api/spaces')).body.spaces.map((s: any) => s.path), [legacy])
    assert.deepEqual(await alertsOf(h), [{ code: 'space_not_renamed', path: legacy, name: legacy.slice('spaces/'.length), wanted: name, actions: [] }])

    const to = `spaces/${name}`
    const moved = (p: string) => to + p.slice(legacy.length)
    assert.deepEqual(await run(h), { renamed: [{ from: legacy, to }], left: [] })
    assert.ok(!existsSync(join(h.notesDir, legacy)) && existsSync(join(h.notesDir, moved(a))) && existsSync(join(h.notesDir, moved(b))))
    // Its rules at the new folder, `name` gone; the rest of the file (its comment) as it was.
    const now = rules(h)
    assert.deepEqual(now.get(to), { grants: { [h.names.member]: 'manage', [h.names.other]: 'edit' }, ai: null })
    assert.deepEqual(now.get(moved(sub)), { grants: null, ai: false })
    assert.ok(![...now.keys()].some((k) => k.startsWith(legacy)))
    assert.ok(readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8').startsWith('# the space of the family\n'))
    // Its members see it by its name; its links still lead where they did.
    assert.deepEqual((await h.other('GET', '/api/spaces')).body.spaces.map((s: any) => [s.path, s.name]), [[to, name]])
    const out = (await h.member('GET', `/api/note/links?path=${encodeURIComponent(moved(a))}`)).body.outgoing as { status: string; dstPath: string | null }[]
    assert.deepEqual(out.map((l) => [l.status, l.dstPath]), [['resolved', moved(b)]])
    // Keys, pins and the trash follow.
    assert.deepEqual(h.state.prepare('select folders from api_keys where id = ?').get(key.key.id), { folders: JSON.stringify([moved(sub)]) })
    assert.deepEqual(h.state.prepare('select path from pins where user_id = ?').all(h.created.other.id), [{ path: moved(sub) }])
    assert.equal(JSON.parse(readFileSync(join(h.stateDir, 'trash', entry.id, 'meta.json'), 'utf8')).path, moved(trashed))
    assert.deepEqual(await alertsOf(h), [])
    // Once is enough: the next start finds nothing to do.
    assert.deepEqual(await run(h), { renamed: [], left: [] })
  } finally {
    h.close()
  }
})

test('the history says which name the space took to whoever reads the space, and nothing to whoever reads only a folder inside it', async () => {
  const name = m.aSpaceName()
  const legacy = `spaces/${m.aLegacySpaceFolder(name)}`
  const sub = `${legacy}/${m.aFolder()}`
  const [a, b] = [`${legacy}/${m.aTitle()}.md`, `${sub}/${m.aTitle()}.md`]
  const h = await setup({
    history: true,
    files: { [a]: `# ${m.aHeading()}\n`, [b]: `# ${m.aHeading()}\n` },
    // The member manages the space; the other member edits only a folder inside it.
    config: (n) => `permissions:\n  ${legacy}:\n    name: ${JSON.stringify(name)}\n    grants: { ${n.member}: manage }\n  ${sub}:\n    grants: { ${n.other}: edit }\n`,
  })
  try {
    const to = `spaces/${name}`
    const moved = (p: string) => to + p.slice(legacy.length)
    assert.deepEqual(await run(h), { renamed: [{ from: legacy, to }], left: [] })
    await h.settle()
    const renamedIn = async (who: 'member' | 'other') => {
      const r = await h[who]('GET', '/api/history/changes')
      assert.equal(r.status, 200, r.text)
      return (r.body.changes as { reason: Record<string, unknown> | null }[]).filter((c) => c.reason?.code === 'space_renamed').map((c) => c.reason)
    }
    // Whoever reads the space: its name now, and the folder it had.
    const member = await renamedIn('member')
    assert.ok(member.length > 0, 'the member sees the rename')
    for (const r of member) assert.deepEqual(r, { code: 'space_renamed', from: legacy, to })
    const versions = await h.member('GET', `/api/history/versions?path=${encodeURIComponent(moved(a))}`)
    assert.deepEqual(versions.body.versions.map((v: any) => v.reason).filter((r: any) => r?.code === 'space_renamed'), [{ code: 'space_renamed', from: legacy, to }])
    // Whoever reads only a folder inside it sees the change to their note, and no space named.
    const other = await renamedIn('other')
    assert.ok(other.length > 0, 'the other member sees the change to their note')
    for (const r of other) assert.deepEqual(r, { code: 'space_renamed', from: null, to: null })
    const theirs = await h.other('GET', `/api/history/versions?path=${encodeURIComponent(moved(b))}`)
    assert.deepEqual(theirs.body.versions.map((v: any) => v.reason).filter((r: any) => r?.code === 'space_renamed'), [{ code: 'space_renamed', from: null, to: null }])
  } finally {
    await h.close()
  }
})

test('a name another space or folder has, in any case, leaves the space as it is, with an alert, until a later start can', async () => {
  const name = m.aSpaceName()
  const [first, second] = [`spaces/${m.aLegacySpaceFolder(name)}`, `spaces/${m.aLegacySpaceFolder(name)}`]
  const taken = m.aSpaceName()
  const blocked = `spaces/${m.aLegacySpaceFolder(taken)}`
  const h = await setup({
    files: { [`${first}/${m.aTitle()}.md`]: m.aParagraph(), [`${second}/${m.aTitle()}.md`]: m.aParagraph(), [`${blocked}/${m.aTitle()}.md`]: m.aParagraph(), [`spaces/${taken.toUpperCase()}/`]: '' },
    // Two spaces of rc.2 with one name (names weren't unique then), and one whose name a folder made on the disk has.
    config: (n) => `permissions:\n${[first, second, blocked].map((p, i) => `  ${p}:\n    name: ${JSON.stringify(i === 1 ? name.toLowerCase() : i === 2 ? taken : name)}\n    grants: { ${n.member}: manage }\n`).join('')}`,
  })
  try {
    const r = await run(h)
    assert.deepEqual(r.renamed, [{ from: first, to: `spaces/${name}` }])
    assert.deepEqual(r.left.sort((x, y) => x.path.localeCompare(y.path)), [{ path: second, wanted: name.toLowerCase() }, { path: blocked, wanted: taken }].sort((x, y) => x.path.localeCompare(y.path)))
    // Those left keep their folder, their members and their name in vihko.yaml (the next start tries again).
    for (const p of [second, blocked]) assert.ok(existsSync(join(h.notesDir, p)), p)
    assert.equal(rules(h).get(second)?.name, name.toLowerCase())
    assert.equal((await h.member('GET', '/api/spaces')).body.spaces.length, 3)
    // The admins are told, by the space's name now and the one it couldn't take; nobody else.
    const told = await alertsOf(h)
    assert.deepEqual(told.map((a: any) => [a.path, a.wanted]).sort(), [[second, name.toLowerCase()], [blocked, taken]].sort())
    assert.deepEqual(((await h.member('GET', '/api/alerts')).body.alerts as { code: string }[]).filter((a) => a.code === 'space_not_renamed'), [])
    // The folder on the disk goes: the next start renames that one.
    rmdirSync(join(h.notesDir, `spaces/${taken.toUpperCase()}`))
    const again = await run(h)
    assert.deepEqual(again.renamed, [{ from: blocked, to: `spaces/${taken}` }])
    assert.deepEqual((await alertsOf(h)).map((a: any) => a.path), [second])
  } finally {
    h.close()
  }
})

test('a name that is the folder already only loses `name`; one that can\'t be a folder\'s gives way to the readable part', async () => {
  const same = m.aSpaceName()
  const bad = `${m.aSpaceName()}/${m.aWord()}`
  const badFolder = m.aLegacySpaceFolder(bad)
  const h = await setup({
    files: { [`spaces/${same}/${m.aTitle()}.md`]: m.aParagraph(), [`spaces/${badFolder}/${m.aTitle()}.md`]: m.aParagraph() },
    config: (n) => `permissions:\n  spaces/${same}:\n    name: ${JSON.stringify(same)}\n    grants: { ${n.member}: manage }\n  spaces/${badFolder}:\n    name: ${JSON.stringify(bad)}\n    grants: { ${n.member}: manage }\n`,
  })
  try {
    const readable = readablePart(bad)
    assert.equal(legacyTarget(bad, badFolder), readable)
    assert.equal(legacyTarget(same, same), same)
    const r = await run(h)
    assert.deepEqual(r, { renamed: [{ from: `spaces/${badFolder}`, to: `spaces/${readable}` }], left: [] })
    assert.deepEqual(rules(h).get(`spaces/${same}`), { grants: { [h.names.member]: 'manage' }, ai: null })
    assert.deepEqual(rules(h).get(`spaces/${readable}`), { grants: { [h.names.member]: 'manage' }, ai: null })
  } finally {
    h.close()
  }
})

test('a folder vihko didn\'t name that way is never touched, whatever its name looks like', async () => {
  // A space made now whose name ends like an old id (`notas-equipo`), and one made on the disk.
  const lookalike = m.aLegacySpaceFolder()
  const plain = m.aSpaceName()
  const h = await setup({
    files: { [`spaces/${lookalike}/${m.aTitle()}.md`]: m.aParagraph(), [`spaces/${plain}/`]: '' },
    config: (n) => `permissions:\n  spaces/${lookalike}:\n    grants: { ${n.member}: manage }\n`,
  })
  try {
    const before = readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8')
    assert.deepEqual(await run(h), { renamed: [], left: [] })
    assert.equal(readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8'), before)
    assert.deepEqual(readdirSync(join(h.notesDir, 'spaces')).sort(), [lookalike, plain].sort())
    mkdirSync(join(h.notesDir, 'spaces', `.${m.aWord()}`))
    assert.deepEqual(await alertsOf(h), [])
  } finally {
    h.close()
  }
})
