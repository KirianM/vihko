// Writes aimed at what the writer can't see (spec §3.1, §3.4, §8.2.3): the
// permissions are asked before the disk, so creating, moving, renaming or
// restoring onto a hidden place answers exactly as onto one that doesn't
// exist (never 409 for something hidden), and nothing on the disk changes.
// Where the writer can write, they see everything (grants only add), so an
// `exists` there is honest. Also each row of the leak table (§3.4) that is
// about writes, and the per-note images case that opened access in 1.0 (§8.3).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADMIN, DIR, FILES as BASE, GROUP, MEMBER, OTHER, PATH, PNG, RULES, home, setup } from './_m4.ts'
import { yamlKey } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** A folder of the other member's space shared with the member (edit), and one of theirs that isn't, with a note in it. */
const LOOSE_DIR = `${home(OTHER.username)}/${m.aFolder()}`
const PRIVATE_DIR = `${home(OTHER.username)}/${m.aFolder()}`
const PRIVATE = `${PRIVATE_DIR}/${m.aTitle()}.md`
/** The member's own folder and a note in it, to move and restore from. */
const MINE_DIR = `${home(MEMBER.username)}/${m.aFolder()}`
const FILES = { ...BASE, [PRIVATE]: `# ${m.aHeading()}\n\n${m.aSentence()}\n`, [`${LOOSE_DIR}/${m.aTitle()}.md`]: `# ${m.aHeading()}\n` }
const CONFIG = RULES + `  ${yamlKey(LOOSE_DIR)}:\n    grants: { ${yamlKey(MEMBER.username)}: edit }\n`

/** Every file under the notes folder with its bytes: what must not change when a write is refused. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rel of readdirSync(root, { recursive: true }).map(String).sort()) {
    const abs = join(root, rel)
    if (rel.startsWith('.') || rel.includes('/.')) continue
    out[rel] = statSync(abs).isDirectory() ? '/' : readFileSync(abs).toString('base64')
  }
  return out
}

/** A response with every mention of `names` replaced (the path the request itself named): what must be the same for hidden and missing. */
const shape = (r: { status: number; text: string }, names: string[]) => {
  let t = r.text
  for (const n of [...names].sort((a, b) => b.length - a.length)) t = t.split(n).join('<asked>')
  return `${r.status} ${t}`
}

test('writes onto what the writer can’t see answer as onto what doesn’t exist, and change nothing', async () => {
  const h = await setup({ files: FILES, config: CONFIG })
  try {
    await h.enable()
    const key = await h.newKey('member', { name: m.aKeyName(), canWrite: true })
    const c = await h.mcp(key.token)
    // The member's own note to move, and one in the trash to restore.
    const mine = m.aNotePath(MINE_DIR)
    const mineDir = `${MINE_DIR}/${m.aFolder()}`
    assert.equal((await h.member('POST', '/api/note', { path: mine, text: `# ${m.aHeading()}\n` })).status, 201)
    assert.equal((await h.member('POST', '/api/folder', { path: mineDir })).status, 201)
    const trashed = m.aNotePath(MINE_DIR)
    assert.equal((await h.member('POST', '/api/note', { path: trashed, text: `# ${m.aHeading()}\n` })).status, 201)
    assert.equal((await h.member('DELETE', h.url('/api/note', { path: trashed }))).status, 200)
    const trashId = ((await h.member('GET', '/api/trash')).body.entries as { id: string; path: string }[]).find((e) => e.path === trashed)!.id

    /** Pairs of a hidden existing note and a hidden missing one, in the same folder: in another space; in the unshared part of a space with a shared folder next to it. */
    const pairs: [string, string, string][] = [
      ['another space', PATH.settings, m.aNotePath(DIR.admin)],
      ['another space, a case variant', PATH.settings.replace(/[^/]+\.md$/, (n) => n.toUpperCase().replace(/\.MD$/, '.md')), m.aNotePath(DIR.admin)],
      ['unshared part of a personal space', PRIVATE, m.aNotePath(PRIVATE_DIR)],
      ['a personal space’s root', PATH.otherNotes, m.aNotePath(home(OTHER.username))],
      ['a person folder of nobody', PATH.nobodyNote, m.aNotePath(PATH.nobodyNote.slice(0, PATH.nobodyNote.lastIndexOf('/')))],
    ]
    const before = snapshot(h.notesDir)
    const yaml = readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8')
    // Each operation, as a function of the target note path (its folder: the path without `.md`).
    const folderOf = (p: string) => p.replace(/\.md$/, '')
    const ops: [string, (p: string) => Promise<{ status: number; text: string }>][] = [
      ['POST /api/note', (p) => h.member('POST', '/api/note', { path: p, text: m.aSentence() })],
      ['PUT /api/note If-None-Match', (p) => h.member('PUT', h.url('/api/note', { path: p }), { text: m.aSentence() }, { 'if-none-match': '*' })],
      ['POST /api/folder', (p) => h.member('POST', '/api/folder', { path: folderOf(p) })],
      ['POST /api/note/move (dry run)', (p) => h.member('POST', '/api/note/move', { from: mine, to: p, dryRun: true })],
      ['POST /api/note/move', (p) => h.member('POST', '/api/note/move', { from: mine, to: p })],
      ['POST /api/folder/move (dry run)', (p) => h.member('POST', '/api/folder/move', { from: mineDir, to: folderOf(p), dryRun: true })],
      ['POST /api/folder/move', (p) => h.member('POST', '/api/folder/move', { from: mineDir, to: folderOf(p) })],
      ['POST /api/trash/:id/restore', (p) => h.member('POST', `/api/trash/${trashId}/restore`, { to: p })],
      ['POST /api/attachments', (p) => h.member('POST', h.url('/api/attachments', { note: p }), PNG)],
      ['MCP create_note', async (p) => { const r = await c.call('create_note', { path: p, text: m.aSentence() }); return { status: r.error ? 400 : 200, text: r.raw } }],
      ['MCP move', async (p) => { const r = await c.call('move', { from: mine, to: p }); return { status: r.error ? 400 : 200, text: r.raw } }],
      ['MCP attach_image', async (p) => { const r = await c.call('attach_image', { note: p, data: PNG.toString('base64') }); return { status: r.error ? 400 : 200, text: r.raw } }],
    ]
    for (const [where, hidden, missing] of pairs) {
      for (const [op, run] of ops) {
        const a = await run(hidden)
        const b = await run(missing)
        const at = `${op} onto ${where}: ${a.status} ${a.text.slice(0, 200)} / ${b.status} ${b.text.slice(0, 200)}`
        assert.equal(shape(a, [hidden, folderOf(hidden)]), shape(b, [missing, folderOf(missing)]), at)
        assert.notEqual(a.status, 409, at)
        assert.ok(!a.text.includes('exists') && !a.text.includes('forbidden'), at)
      }
    }
    // Nothing changed on the disk, nor in vihko.yaml (the member's own note and folder are where they were).
    assert.deepEqual(snapshot(h.notesDir), before)
    assert.equal(readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8'), yaml)

    // Where the member writes, they see everything: `exists` is honest (row 1, 2, 10).
    const shared = `${LOOSE_DIR}/${m.aTitle()}.md`
    assert.equal((await h.other('POST', '/api/note', { path: shared, text: `# ${m.aHeading()}\n` })).status, 201)
    assert.deepEqual([(await h.member('POST', '/api/note', { path: shared, text: '' })).status, (await h.member('POST', '/api/note/move', { from: mine, to: PATH.list })).status], [409, 409])
    const sub = `${LOOSE_DIR}/${m.aFolder()}`
    assert.equal((await h.other('POST', '/api/folder', { path: sub })).status, 201)
    assert.equal((await h.member('POST', '/api/folder', { path: sub })).status, 409)
    // The folder they received itself sits where they don't see: making it again is not_found, as anywhere there.
    assert.equal((await h.member('POST', '/api/folder', { path: LOOSE_DIR })).status, 404)
    await c.close()
  } finally { await h.close() }
})

test('nothing is created outside a space, nor a space as a folder, before the disk is looked at (rows 5, 8)', async () => {
  const h = await setup({ files: FILES, config: CONFIG })
  try {
    for (const path of [`${m.aTitle()}.md`, `people/${m.aTitle()}.md`, `spaces/${m.aTitle()}.md`, `${m.aFolder()}/${m.aTitle()}.md`, PATH.rootPlan]) {
      for (const who of [h.admin, h.member]) {
        const r = await who('POST', '/api/note', { path, text: m.aSentence() })
        assert.deepEqual([r.status, r.body.error], [400, 'outside_space'], path)
      }
    }
    for (const path of [`people/${m.aUsername()}`, `people/${OTHER.username}`, `spaces/${m.aSpaceFolder()}`, 'people', 'spaces']) {
      assert.deepEqual([(await h.admin('POST', '/api/folder', { path })).body.error], ['space_root'], path)
    }
    assert.equal((await h.admin('POST', '/api/folder', { path: `${m.aFolder()}/${m.aFolder()}` })).body.error, 'outside_space')
    // A space's root is never renamed, moved or deleted as a folder; a personal one never deleted.
    for (const path of ['people', 'spaces', home(MEMBER.username)]) assert.equal((await h.member('DELETE', h.url('/api/folder', { path }))).body.error, 'space_root', path)
    assert.equal((await h.admin('POST', '/api/folder/move', { from: DIR.shared, to: `spaces/${m.aSpaceFolder()}` })).body.error, 'space_root')
    assert.equal((await h.member('POST', '/api/folder/move', { from: MINE_DIR, to: `spaces/${m.aSpaceFolder()}` })).body.error, 'space_root')
    assert.equal((await h.member('POST', '/api/note/move', { from: PATH.cake, to: `${m.aTitle()}.md` })).body.error, 'outside_space')
  } finally { await h.close() }
})

test('deleting and renaming folders: the manager is told all it holds; a received folder stays its owner’s to order (rows 5, 11)', async () => {
  const received = `${DIR.admin}/${m.aFolder()}`
  const config = CONFIG + `  ${yamlKey(received)}:\n    grants: { ${yamlKey(MEMBER.username)}: manage }\n`
  const inReceived = m.aNotePath(received)
  const h = await setup({ files: { ...FILES, [inReceived]: `# ${m.aHeading()}\n` }, config })
  try {
    // The member manages the folder the admin shares, but it's in the admin's space: not theirs to rename, move or delete (D-056.6).
    assert.deepEqual([(await h.member('DELETE', h.url('/api/folder', { path: received }))).body.error], ['forbidden'])
    assert.deepEqual([(await h.member('POST', '/api/folder/move', { from: received, to: `${MINE_DIR}/${m.aFolder()}` })).body.error], ['forbidden'])
    // Inside it, theirs to order: a subfolder is created, renamed and deleted.
    const sub = `${received}/${m.aFolder()}`
    const renamed = `${received}/${m.aFolder()}`
    assert.equal((await h.member('POST', '/api/folder', { path: sub })).status, 201)
    assert.equal((await h.member('POST', '/api/folder/move', { from: sub, to: renamed })).status, 200)
    assert.equal((await h.member('DELETE', h.url('/api/folder', { path: renamed }))).status, 200)
    // Where they only edit: a folder that isn't there is not_found, one that is, forbidden (row 11: the same as before only for what they see).
    assert.deepEqual([(await h.member('DELETE', h.url('/api/folder', { path: `${LOOSE_DIR}/${m.aFolder()}` }))).status], [404])
    assert.deepEqual([(await h.member('DELETE', h.url('/api/folder', { path: LOOSE_DIR }))).status], [403])
    // Not empty: what it holds, with nothing hidden or counted apart (row 5: no `locked`).
    const full = await h.admin('DELETE', h.url('/api/folder', { path: received }))
    assert.deepEqual([full.status, full.body.error, full.body.contents.notes.total, 'locked' in full.body.contents], [409, 'not_empty', 1, false])
  } finally { await h.close() }
})

test('deleting a shared space: its notes go to the trash, which its managers keep once the space is gone (spec §3.5)', async () => {
  const h = await setup({ files: FILES, config: CONFIG })
  try {
    const r = await h.admin('DELETE', h.url('/api/folder', { path: DIR.shared, trash: 'true' }))
    assert.equal(r.status, 200, r.text)
    assert.ok(!existsSync(join(h.notesDir, DIR.shared)))
    assert.ok(!readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8').includes(DIR.shared), 'its rule is gone')
    // The admin managed it: they still see its entries; the member only edited it: not any more.
    const entries = (await h.admin('GET', '/api/trash')).body.entries as { id: string; path: string; space: string | null; managers?: unknown }[]
    const list = entries.find((e) => e.path === PATH.list)!
    assert.equal(list.space, DIR.shared)
    assert.equal(list.managers, undefined, 'who managed it is kept, never shown')
    assert.deepEqual(((await h.member('GET', '/api/trash')).body.entries as { path: string }[]).filter((e) => e.path.startsWith(DIR.shared + '/')), [])
    // The member can't restore what they don't see, not even into their own space.
    assert.equal((await h.member('POST', `/api/trash/${list.id}/restore`, { to: m.aNotePath(MINE_DIR) })).status, 404)
    // Back where it was: that space is gone (not_found); somewhere the admin writes: restored.
    assert.equal((await h.admin('POST', `/api/trash/${list.id}/restore`, {})).status, 404)
    const to = m.aNotePath(home(ADMIN.username))
    assert.equal((await h.admin('POST', `/api/trash/${list.id}/restore`, { to })).status, 200)
    assert.ok(existsSync(join(h.notesDir, to)))
    // A personal space isn't deleted as a folder, not even by its owner.
    assert.equal((await h.member('DELETE', h.url('/api/folder', { path: home(MEMBER.username), trash: 'true' }))).body.error, 'space_root')
  } finally { await h.close() }
})

test('grants written for a folder that doesn’t exist: kept (their managers are told), gone when vihko creates it, in force when it appears from outside (row 4, spec §1.2)', async () => {
  const [ghost, ghost2, outside] = [`${DIR.admin}/${m.aFolder()}`, `${DIR.admin}/${m.aFolder()}`, `${DIR.admin}/${m.aFolder()}`]
  const grant = (f: string) => `  ${yamlKey(f)}:\n    grants: { ${yamlKey(MEMBER.username)}: read }\n`
  const h = await setup({ files: FILES, config: CONFIG + grant(ghost) + grant(ghost2) + grant(outside) })
  try {
    const missing = (who: typeof h.admin) => who('GET', '/api/alerts').then((r) => (r.body.alerts as { code: string; folders?: string[] }[]).find((a) => a.code === 'missing_folder')?.folders ?? [])
    // To whoever manages the space they're in (the admin, as its manager), never to someone who can't manage it.
    assert.deepEqual((await missing(h.admin)).sort(), [ghost, ghost2, outside].sort())
    assert.deepEqual(await missing(h.member), [])
    // Created from vihko: the forgotten grant goes first.
    assert.equal((await h.admin('POST', '/api/folder', { path: ghost })).status, 201)
    const note = m.aNotePath(`${ghost2}/${m.aFolder()}`)
    assert.equal((await h.admin('POST', '/api/note', { path: note, text: `# ${m.aHeading()}\n` })).status, 201)
    const yaml = readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8')
    assert.ok(!yaml.includes(ghost + ':') && !yaml.includes(`${ghost2}:`), yaml)
    assert.equal((await h.member('GET', h.url('/api/note', { path: note }))).status, 404)
    // Made on the disk: the grant applies (whoever writes on the disk already sees it all).
    const there = m.aNotePath(outside)
    mkdirSync(join(h.notesDir, outside))
    writeFileSync(join(h.notesDir, there), `# ${m.aHeading()}\n`)
    h.runtime.rescan({})
    assert.equal((await h.member('GET', h.url('/api/note', { path: there }))).status, 200)
  } finally { await h.close() }
})

test('a note moved outside vihko to where more people would read it is held: nobody reads it; its name is the only thing it takes (rows 5, 7, spec §2.7)', async () => {
  const h = await setup({ files: FILES, config: CONFIG })
  try {
    // Someone with the disk moves the admin's note into the shared space, which the group reads.
    const dir = `${DIR.shared}/${m.aFolder()}`
    const moved = `${dir}/${PATH.settings.slice(PATH.settings.lastIndexOf('/') + 1)}`
    mkdirSync(join(h.notesDir, dir))
    renameSync(join(h.notesDir, PATH.settings), join(h.notesDir, moved))
    h.runtime.rescan({})
    assert.ok(h.holds.held(moved))
    assert.equal((await h.member('GET', h.url('/api/note', { path: moved }))).status, 404)
    assert.equal((await h.admin('GET', h.url('/api/note', { path: moved }))).status, 404, 'nobody reads it, not even who read it before')
    // The one residue (row 7): its name is taken, and says so, nothing more.
    const taken = await h.member('POST', '/api/note', { path: moved, text: m.aSentence() })
    assert.deepEqual([taken.status, taken.body.error], [409, 'exists'])
    // Only whoever could have made the move from vihko is told, and releases it.
    const held = async (who: typeof h.admin) => ((await who('GET', '/api/alerts')).body.alerts as { code: string; id: string; folder: string; notes: number }[]).filter((a) => a.code === 'permissions_held')
    assert.deepEqual(await held(h.member), [])
    const [alert] = await held(h.admin)
    assert.deepEqual([alert!.folder, alert!.notes], [DIR.admin, 1])
    assert.equal((await h.member('POST', `/api/permissions/holds/${alert!.id}`, { action: 'release' })).status, 404)
    // A folder holding it isn't deleted meanwhile (row 5: without saying what or how many).
    const del = await h.admin('DELETE', h.url('/api/folder', { path: dir, trash: 'true' }))
    assert.deepEqual([del.status, del.body.error], [409, 'held_inside'])
    assert.ok(!del.text.includes(moved.slice(dir.length + 1)))
    assert.equal((await h.admin('POST', `/api/permissions/holds/${alert!.id}`, { action: 'release' })).status, 200)
    assert.equal((await h.member('GET', h.url('/api/note', { path: moved }))).status, 200)
  } finally { await h.close() }
})

test('a daily series where the person can’t read: not_found, whether today’s note exists or not (row 12)', async () => {
  const series = m.anId()
  const folder = `${DIR.admin}/${m.aFolder()}`
  const h = await setup({ files: FILES, config: `daily:\n  ${series}:\n    folder: ${JSON.stringify(folder)}\n` + CONFIG })
  try {
    const before = await h.member('GET', h.url('/api/daily', { series }))
    assert.equal((await h.admin('POST', '/api/daily', { series })).status, 201)
    const after = await h.member('GET', h.url('/api/daily', { series }))
    assert.deepEqual([before.status, after.status], [404, 404])
    assert.equal(before.text, after.text)
    assert.ok(!after.text.includes(folder))
  } finally { await h.close() }
})

test('per-note images: the folder of images moves with its note and its grants, counts in the audience, and no image lands where the writer can’t write (spec §3.8, §8.3)', async () => {
  // The group is the member alone here: the other is outside the shared space, and reads only the images a grant gives them.
  const folder = `${DIR.shared}/${m.aFolder()}`
  const note = m.aNotePath(folder)
  const assets = note.replace(/\.md$/, '.assets')
  const image = `${assets}/${m.aUniqueWord()}.png`
  const config = `attachments:\n  mode: per-note\n` + RULES + `  ${yamlKey(assets)}:\n    grants: { ${yamlKey(OTHER.username)}: read }\n`
  const h = await setup({ files: { ...BASE, [note]: `# ${m.aHeading()}\n\n![](${image.slice(folder.length + 1).replace(/ /g, '%20')})\n`, [image]: PNG }, config, groups: { [GROUP]: ['member'] } })
  try {
    assert.equal((await h.other('GET', h.url('/api/file', { path: image }))).status, 200, 'the grant on its folder of images reaches the other')
    assert.equal((await h.other('GET', h.url('/api/note', { path: note }))).status, 404)
    // Moving it to the member's own space: the preview says whose it becomes, and who stops seeing it (the admin); the other keeps its images.
    const mine = m.aNotePath(home(MEMBER.username))
    const preview = (await h.member('POST', '/api/note/move', { from: note, to: mine, dryRun: true })).body
    assert.deepEqual(preview.audience.owner, { before: { kind: 'shared', path: DIR.shared, name: DIR.shared.replace(/^spaces\/(.*)-[a-z0-9]{6}$/, '$1') }, after: { kind: 'personal', owner: MEMBER.username } })
    assert.deepEqual(preview.audience.users.lose.map((u: { username: string }) => u.username), [ADMIN.username])
    assert.deepEqual(preview.audience.users.gain, [])
    // Renamed: its folder of images goes with it, and its grants with the folder.
    const renamed = m.aNotePath(folder)
    const r = await h.member('POST', '/api/note/move', { from: note, to: renamed })
    assert.equal(r.status, 200, r.text)
    const newAssets = renamed.replace(/\.md$/, '.assets')
    const yaml = readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8')
    assert.ok(yaml.includes(newAssets) && !yaml.includes(`${assets}:`) && !yaml.includes(`"${assets}"`), yaml)
    assert.equal((await h.other('GET', h.url('/api/file', { path: `${newAssets}/${image.slice(assets.length + 1)}` }))).status, 200)
    // A person uploading an image: where it lands is checked for them too (their note's folder of images: theirs to write).
    assert.equal((await h.member('POST', h.url('/api/attachments', { note: renamed }), PNG)).status, 201)
  } finally { await h.close() }
})

test('images go only where the writer may write: an attachments folder they can’t write refuses the upload, and nothing lands there (spec §3.8)', async () => {
  // The attachments folder is each space's own (spec §1.6): for a note of the
  // folder the other member shares with the member, it's in the other's space,
  // outside what they share.
  const dropbox = m.aFolder()
  const config = `attachments:\n  mode: folder\n  folder: ${JSON.stringify(dropbox)}\n` + CONFIG
  const note = `${LOOSE_DIR}/${m.aTitle()}.md`
  const h = await setup({ files: { ...FILES, [note]: `# ${m.aHeading()}\n` }, config })
  try {
    const before = snapshot(h.notesDir)
    const r = await h.member('POST', h.url('/api/attachments', { note }), PNG)
    assert.deepEqual([r.status, r.body.error], [403, 'forbidden'])
    assert.deepEqual(snapshot(h.notesDir), before)
    const own = await h.other('POST', h.url('/api/attachments', { note }), PNG)
    assert.equal(own.status, 201, own.text)
    assert.ok(own.body.path.startsWith(`${home(OTHER.username)}/${dropbox}/`), own.body.path)
  } finally { await h.close() }
})
