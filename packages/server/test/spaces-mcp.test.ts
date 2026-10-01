// Agents under the spaces model (D-056.14, spec §6.2; piece S): the MCP
// server's instructions tell the agent the person's own space and the spaces
// and folders they reach (each with its path, and a space's id and name),
// within the key; `list_folder("")` lists those roots with what kind of space
// each is; and the path schemas give an example in the person's own space.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setup, type Name, type Spaces } from './_spacesApp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

async function newSpace(h: Spaces, who: Name, members?: Record<string, string>) {
  const name = m.aSpaceName()
  const r = await h.as(who)('POST', '/api/spaces', { name, ...(members ? { members } : {}) })
  assert.equal(r.status, 201, r.text)
  return { name, path: r.body.space.path as string, id: r.body.space.id as string }
}

const literally = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('instructions: the person\'s own space, the spaces they belong to and what others share with them, each with its path', async () => {
  const h = await setup()
  try {
    await h.enable()
    const home = await newSpace(h, 'member', { [`@${h.group}`]: 'edit' })
    const hidden = await newSpace(h, 'admin')
    const trips = `${h.home('admin')}/${m.aFolder()}`
    mkdirSync(join(h.notesDir, trips))
    await h.rule(trips, { grants: { [h.names.member]: 'comment' } })
    const c = await h.mcp((await h.newKey('member', { name: m.aKeyName(), canWrite: true })).token)
    try {
      const text = c.instructions()
      assert.match(text, new RegExp(`The person you act for is ${literally(h.names.member)}\\. Their personal space is "${literally(h.home('member'))}/"`))
      assert.ok(text.includes(`"${home.path}" (id ${home.id}, named ${JSON.stringify(home.name)}, manage)`), text)
      assert.ok(text.includes(`"${trips}" (comment, from ${h.names.admin})`), text)
      assert.match(text, /A name never reaches another space/)
      assert.match(text, /Moving a note to another space changes who can see it and whose it is/)
      assert.match(text, /can't read don't exist for you: naming one answers `not_found`/)
      assert.ok(!text.includes(hidden.path) && !text.includes(hidden.name), 'nothing the person doesn\'t reach')
      // The schemas: an example in the person's own space.
      const tools = await c.client.listTools()
      const read = tools.tools.find((t) => t.name === 'get_note')!
      assert.ok(JSON.stringify(read.inputSchema).includes(`people/${h.names.member}/projects/plan.md`))
    } finally {
      await c.close()
    }
  } finally {
    h.close()
  }
})

test('instructions: a workspace guide with `{user}` in its path is each person\'s own (D-056.28)', async () => {
  const h = await setup()
  try {
    await h.enable()
    const name = `${m.aTitle()}.md`
    const words = { member: m.aUniqueWord(), other: m.aUniqueWord() }
    for (const who of ['member', 'other'] as const) h.write(`${h.home(who)}/${name}`, `# ${m.aHeading()}\n\n${m.aSentence()} ${words[who]}.\n`)
    const yaml = join(h.notesDir, 'vihko.yaml')
    writeFileSync(yaml, `${existsSync(yaml) ? readFileSync(yaml, 'utf8') : ''}mcp:\n  instructions: ${JSON.stringify(`people/{user}/${name}`)}\n`)
    h.workspace.reload()
    for (const [who, theirs] of [['member', 'other'], ['other', 'member']] as const) {
      const c = await h.mcp((await h.newKey(who, { name: m.aKeyName() })).token)
      try {
        const text = c.instructions()
        assert.ok(text.includes(words[who]), `${who}: their own guide`)
        assert.ok(!text.includes(words[theirs]), `${who}: never someone else's`)
      } finally {
        await c.close()
      }
    }
  } finally {
    h.close()
  }
})

test('instructions: a key limited to one space names only it, and a long list stops at 20 with how many more', async () => {
  const h = await setup()
  try {
    await h.enable()
    const spaces = []
    for (let i = 0; i < 21; i++) spaces.push(await newSpace(h, 'other'))
    const limited = await h.mcp((await h.newKey('other', { name: m.aKeyName(), canWrite: false, folders: [spaces[0]!.path] })).token)
    try {
      const text = limited.instructions()
      assert.match(text, new RegExp(`This key doesn't reach their personal space \\("${literally(h.home('other'))}/"\\)`))
      assert.ok(text.includes(spaces[0]!.path))
      for (const s of spaces.slice(1)) assert.ok(!text.includes(s.path), s.path)
    } finally {
      await limited.close()
    }
    const all = await h.mcp((await h.newKey('other', { name: m.aKeyName(), canWrite: false })).token)
    try {
      const text = all.instructions()
      assert.equal(spaces.filter((s) => text.includes(s.path)).length, 20)
      assert.match(text, /And 1 more: list_folder with folder "" lists them all/)
      const listed = await all.call('list_folder', { folder: '', limit: 500 })
      assert.equal(listed.data.entries.filter((e: any) => e.space?.kind === 'shared').length, 21)
    } finally {
      await all.close()
    }
  } finally {
    h.close()
  }
})

test('list_folder(""): the roots the person reaches, each with its kind of space; recursive, what is under them', async () => {
  const h = await setup()
  try {
    await h.enable()
    const home = await newSpace(h, 'admin', { [`@${h.group}`]: 'read' })
    const trips = `${h.home('admin')}/${m.aFolder()}`
    const recipes = `${home.path}/${m.aFolder()}`
    mkdirSync(join(h.notesDir, trips))
    await h.rule(trips, { grants: { [h.names.other]: 'edit' } })
    const own = `${h.home('other')}/${m.aTitle()}.md`
    const inHome = `${recipes}/${m.aTitle()}.md`
    const secret = `${h.home('admin')}/${m.aTitle()}.md`
    h.write(own, m.aParagraph())
    h.write(inHome, m.aParagraph())
    h.write(secret, m.aParagraph())
    const c = await h.mcp((await h.newKey('other', { name: m.aKeyName(), canWrite: false })).token)
    try {
      const top = await c.call('list_folder', { folder: '' })
      assert.equal(top.error, false, top.raw)
      assert.deepEqual(top.data.entries, [
        { kind: 'folder', path: h.home('other'), space: { kind: 'personal' } },
        { kind: 'folder', path: home.path, space: { kind: 'shared', id: home.id, name: home.name, level: 'read' } },
        { kind: 'folder', path: trips, space: { kind: 'received', level: 'edit', owner: h.names.admin } },
      ])
      const deep = await c.call('list_folder', { folder: '', recursive: true, limit: 500 })
      const paths = deep.data.entries.map((e: { path: string }) => e.path)
      for (const p of [own, inHome, recipes]) assert.ok(paths.includes(p), p)
      assert.ok(!deep.raw.includes(secret), 'nothing of the admin\'s own')
    } finally {
      await c.close()
    }
  } finally {
    h.close()
  }
})
