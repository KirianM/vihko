// The trash screen's routes (http/trash.ts): what each person sees in the
// trash and what it takes (only of what they see, and only since they could
// read there), restoring (onto a taken name too), deleting for good (a
// shared space's managers, a personal space's owner; members restore but
// never destroy; confirmed at the moment), emptying it, deleted spaces as one
// entry each, and the retention's date.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setup, type Name, type Spaces } from './_spacesApp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const q = encodeURIComponent

interface Listed { id: string; path: string; kind?: string; files?: { path: string }[]; space: string | null; bytes: number; canRestore: boolean; canDelete: boolean; expiresAt: string | null; deletedSpace?: string; deletedBy: { kind: string; name: string } }
interface ListedSpace { id: string; path: string; name: string; entries: number; bytes: number | null; canRestore: boolean; canDelete: boolean; expiresAt: string | null }
interface View { entries: Listed[]; spaces: ListedSpace[]; bytes: number; retentionDays: number | null }

async function trash(h: Spaces, who: Name): Promise<View> {
  const r = await h.as(who)('GET', '/api/trash')
  assert.equal(r.status, 200, r.text)
  return r.body as View
}

/** A shared space created through the API by `who`, with `members`. */
async function newSpace(h: Spaces, who: Name, members: Record<string, string> = {}) {
  const name = m.aSpaceName()
  const r = await h.as(who)('POST', '/api/spaces', { name, members })
  assert.equal(r.status, 201, r.text)
  return { name, path: r.body.space.path as string }
}

/** A note written at `path`, then deleted by `who`: its trash entry's id and the bytes of its text. */
async function deleted(h: Spaces, who: Name, path: string) {
  const text = `# ${m.aHeading()}\n\n${m.aParagraph()}\n`
  h.write(path, text)
  const r = await h.as(who)('DELETE', `/api/note?path=${q(path)}`)
  assert.equal(r.status, 200, r.text)
  return { id: r.body.id as string, bytes: Buffer.byteLength(text) }
}

test('each person sees what was deleted where they edit, with its size and who deleted it; a reader, or someone else, nothing of it, its size included', async () => {
  const h = await setup()
  try {
    // The member manages a space the other edits and the admin reads.
    const s = await newSpace(h, 'member', { [h.names.other]: 'edit', [h.names.admin]: 'read' })
    const shared = await deleted(h, 'other', `${s.path}/${m.aTitle()}.md`)
    const own = await deleted(h, 'member', `${h.home('member')}/${m.aTitle()}.md`)

    const member = await trash(h, 'member')
    assert.deepEqual(member.entries.map((e) => e.id).sort(), [shared.id, own.id].sort())
    const e = member.entries.find((x) => x.id === shared.id)!
    assert.deepEqual([e.space, e.bytes, e.canRestore, e.canDelete, e.deletedBy.kind, e.deletedBy.name], [s.path, shared.bytes, true, true, 'user', h.names.other])
    assert.equal(member.bytes, shared.bytes + own.bytes)
    assert.equal(member.retentionDays, null)
    assert.equal(e.expiresAt, null, 'nothing leaves the trash on its own while the retention is off')

    // Whoever edits there restores it, but doesn't destroy it.
    const other = await trash(h, 'other')
    assert.deepEqual(other.entries.map((x) => [x.id, x.canRestore, x.canDelete]), [[shared.id, true, false]])
    assert.equal(other.bytes, shared.bytes, 'only the size of what they see')

    // A reader sees nothing of it: not the entry, not its size.
    const admin = await trash(h, 'admin')
    assert.deepEqual([admin.entries, admin.spaces, admin.bytes], [[], [], 0])
    const text = (await h.admin('GET', '/api/trash')).text
    assert.ok(!text.includes(own.id) && !text.includes(shared.id))
  } finally {
    await h.close()
  }
})

test('sharing a folder doesn\'t share what was deleted there before: neither the entry nor its size', async () => {
  const h = await setup()
  try {
    const before = `${h.home('member')}/${m.aFolder()}`
    const after = `${h.home('member')}/${m.aFolder()}`
    // Shared an hour ago, by the app's clock: what is deleted now is after it.
    h.clock.now = new Date(Date.now() - 3_600_000)
    await h.rule(after, { grants: { [h.names.other]: 'edit' } })
    const seen = await deleted(h, 'member', `${after}/${m.aTitle()}.md`)
    const unseen = await deleted(h, 'member', `${before}/${m.aTitle()}.md`)
    // Shared an hour from now: what was deleted there before stays the owner's alone.
    h.clock.now = new Date(Date.now() + 3_600_000)
    await h.rule(before, { grants: { [h.names.other]: 'edit' } })

    const other = await trash(h, 'other')
    assert.deepEqual(other.entries.map((e) => e.id), [seen.id])
    assert.equal(other.bytes, seen.bytes)
    // Nor can they restore or delete it by its id.
    assert.equal((await h.other('POST', `/api/trash/${unseen.id}/restore`, {})).status, 404)
    assert.equal((await h.other('DELETE', `/api/trash/${unseen.id}`, { confirm: h.created.other.password })).status, 404)
    assert.ok(existsSync(join(h.stateDir, 'trash', unseen.id, 'meta.json')))
    assert.equal((await trash(h, 'member')).entries.length, 2)
  } finally {
    await h.close()
  }
})

test('an entry seen in part counts only the files seen, and only who sees all of it deletes it', async () => {
  const h = await setup()
  try {
    // The member's folder, with a subfolder shared with the other; a file in each.
    const folder = `${h.home('member')}/${m.aFolder()}`
    const sub = `${folder}/${m.aFolder()}`
    await h.rule(sub, { grants: { [h.names.other]: 'edit' } })
    const mine = Buffer.from(m.aParagraph())
    const theirs = Buffer.from(m.aParagraph() + m.aParagraph())
    h.write(`${folder}/${m.aWord()}.bin`, mine)
    h.write(`${sub}/${m.aWord()}.bin`, theirs)
    await h.notes.trashFolder(folder, { kind: 'user', id: h.created.member.id })

    const files = (await trash(h, 'member')).entries.find((e) => e.kind === 'files')!
    assert.equal(files.files!.length, 2)
    assert.equal(files.bytes, mine.length + theirs.length)
    assert.equal(files.canDelete, true)

    const part = (await trash(h, 'other')).entries.find((e) => e.id === files.id)!
    assert.deepEqual([part.files!.length, part.bytes, part.canDelete], [1, theirs.length, false])
    assert.equal((await h.other('DELETE', `/api/trash/${files.id}`, { confirm: h.created.other.password })).status, 403)
  } finally {
    await h.close()
  }
})

test('deleting for good: a shared space\'s managers, a personal space\'s owner; members restore but never destroy; always confirmed', async () => {
  const h = await setup()
  try {
    const s = await newSpace(h, 'member', { [h.names.other]: 'edit' })
    const a = await deleted(h, 'other', `${s.path}/${m.aTitle()}.md`)
    const b = await deleted(h, 'other', `${s.path}/${m.aTitle()}.md`)

    // A member who edits: forbidden (they see it), and nothing goes.
    const refused = await h.other('DELETE', `/api/trash/${a.id}`, { confirm: h.created.other.password })
    assert.deepEqual([refused.status, refused.body.error], [403, 'forbidden'])
    const emptied = await h.other('POST', '/api/trash/empty', { confirm: h.created.other.password })
    assert.deepEqual(emptied.body, { entries: 0, spaces: 0, bytes: 0, kept: 2 })
    assert.equal((await trash(h, 'other')).entries.length, 2)

    // Its manager: confirmed at the moment, or nothing goes.
    const unconfirmed = await h.member('DELETE', `/api/trash/${a.id}`, {})
    assert.deepEqual([unconfirmed.status, unconfirmed.body.error], [400, 'confirmation_required'])
    const wrong = await h.member('DELETE', `/api/trash/${a.id}`, { confirm: m.aPassword() })
    assert.equal(wrong.status, 403)
    assert.ok(existsSync(join(h.stateDir, 'trash', a.id)))
    const done = await h.member('DELETE', `/api/trash/${a.id}`, { confirm: h.created.member.password })
    assert.equal(done.status, 200, done.text)
    assert.deepEqual(done.body, { entries: 1, bytes: a.bytes })
    assert.ok(!existsSync(join(h.stateDir, 'trash', a.id)))
    assert.deepEqual((await trash(h, 'other')).entries.map((e) => e.id), [b.id])
    assert.equal((await h.member('POST', `/api/trash/${a.id}/restore`, {})).status, 404)

    // A personal space: its owner alone, whoever else manages a folder of it.
    const folder = `${h.home('other')}/${m.aFolder()}`
    await h.rule(folder, { grants: { [h.names.member]: 'manage' } })
    const p = await deleted(h, 'member', `${folder}/${m.aTitle()}.md`)
    assert.deepEqual((await trash(h, 'member')).entries.filter((e) => e.id === p.id).map((e) => e.canDelete), [false])
    assert.equal((await h.member('DELETE', `/api/trash/${p.id}`, { confirm: h.created.member.password })).status, 403)
    assert.deepEqual((await trash(h, 'other')).entries.filter((e) => e.id === p.id).map((e) => e.canDelete), [true])
    // Someone who doesn't see it: as one that isn't there.
    assert.equal((await h.admin('DELETE', `/api/trash/${p.id}`, { confirm: h.created.admin.password })).status, 404)
    assert.equal((await h.other('DELETE', `/api/trash/${p.id}`, { confirm: h.created.other.password })).status, 200)
  } finally {
    await h.close()
  }
})

test('emptying the trash takes what the person may delete, in one space if they ask; what they may only restore stays', async () => {
  const h = await setup()
  try {
    const s = await newSpace(h, 'member', { [h.names.other]: 'edit' })
    const t = await newSpace(h, 'other', { [h.names.member]: 'edit' })
    const inS = await deleted(h, 'other', `${s.path}/${m.aTitle()}.md`)
    const inT = await deleted(h, 'member', `${t.path}/${m.aTitle()}.md`)
    const own = await deleted(h, 'member', `${h.home('member')}/${m.aTitle()}.md`)

    const preview = await h.member('POST', '/api/trash/empty', { dryRun: true })
    assert.deepEqual(preview.body, { entries: 2, spaces: 0, bytes: inS.bytes + own.bytes, kept: 1 })
    // One space: only its entries.
    const one = await h.member('POST', '/api/trash/empty', { space: s.path, confirm: h.created.member.password })
    assert.deepEqual(one.body, { entries: 1, spaces: 0, bytes: inS.bytes, kept: 0 })
    assert.deepEqual((await trash(h, 'member')).entries.map((e) => e.id).sort(), [inT.id, own.id].sort())
    // The rest: their own, never what someone else manages.
    const rest = await h.member('POST', '/api/trash/empty', { confirm: h.created.member.password })
    assert.deepEqual(rest.body, { entries: 1, spaces: 0, bytes: own.bytes, kept: 1 })
    assert.deepEqual((await trash(h, 'member')).entries.map((e) => e.id), [inT.id])
    assert.deepEqual((await trash(h, 'other')).entries.map((e) => e.id), [inT.id])
  } finally {
    await h.close()
  }
})

test('a deleted space is one entry: who managed it restores or deletes it whole; the admin restores it without its size; nobody else sees it', async () => {
  const h = await setup()
  try {
    const s = await newSpace(h, 'member', { [h.names.other]: 'edit' })
    const texts = [m.aParagraph(), m.aParagraph()]
    for (const text of texts) h.write(`${s.path}/${m.aTitle()}.md`, text)
    const del = await h.member('DELETE', `/api/spaces?path=${q(s.path)}&trash=true`)
    assert.equal(del.status, 200, del.text)
    const id = del.body.deleted as string

    const member = await trash(h, 'member')
    assert.deepEqual(member.spaces.map((d) => [d.id, d.path, d.entries, d.bytes, d.canRestore, d.canDelete]), [[id, s.path, 2, texts.reduce((n, x) => n + Buffer.byteLength(x), 0), true, true]])
    assert.ok(member.entries.length === 2 && member.entries.every((e) => e.deletedSpace === id), 'its entries say whose they are')

    const admin = await trash(h, 'admin')
    assert.deepEqual(admin.spaces.map((d) => [d.id, d.entries, d.bytes, d.canRestore, d.canDelete]), [[id, 2, null, true, false]])
    assert.deepEqual([admin.entries, admin.bytes], [[], 0])
    assert.ok(!texts.some((x) => JSON.stringify(admin).includes(x)))
    const other = await trash(h, 'other')
    assert.deepEqual([other.entries, other.spaces], [[], []])

    // The admin may restore it, never destroy it; a member of it doesn't see it.
    assert.equal((await h.admin('DELETE', `/api/spaces/deleted/${id}`, { confirm: h.created.admin.password })).status, 403)
    assert.equal((await h.other('DELETE', `/api/spaces/deleted/${id}`, { confirm: h.created.other.password })).status, 404)
    assert.deepEqual((await h.admin('POST', '/api/trash/empty', { confirm: h.created.admin.password })).body, { entries: 0, spaces: 0, bytes: 0, kept: 1 })

    // Restored whole from the trash, and deleted again, then for good.
    assert.equal((await h.member('POST', '/api/spaces/restore', { id })).status, 200)
    assert.deepEqual((await trash(h, 'member')).spaces, [])
    const again = (await h.member('DELETE', `/api/spaces?path=${q(s.path)}&trash=true`)).body.deleted as string
    const unconfirmed = await h.member('DELETE', `/api/spaces/deleted/${again}`, {})
    assert.equal(unconfirmed.body.error, 'confirmation_required')
    const gone = await h.member('DELETE', `/api/spaces/deleted/${again}`, { confirm: h.created.member.password })
    assert.equal(gone.status, 200, gone.text)
    assert.equal(gone.body.entries, 2)
    assert.deepEqual(await trash(h, 'member'), { entries: [], spaces: [], bytes: 0, retentionDays: null })
    assert.equal((await h.member('POST', '/api/spaces/restore', { id: again })).status, 404)
    assert.deepEqual(h.notes.trash(), [])
  } finally {
    await h.close()
  }
})

test('restoring onto a taken name is `exists`, and nothing changes; under another name, or in another place, it comes back', async () => {
  const h = await setup()
  try {
    const s = await newSpace(h, 'member', { [h.names.other]: 'edit' })
    const path = `${s.path}/${m.aTitle()}.md`
    const gone = await deleted(h, 'other', path)
    const taken = m.aParagraph()
    h.write(path, taken)

    const r = await h.other('POST', `/api/trash/${gone.id}/restore`, {})
    assert.deepEqual([r.status, r.body.error], [409, 'exists'])
    assert.equal(readFileSync(join(h.notesDir, path), 'utf8'), taken)
    // Another name next to it.
    const renamed = `${s.path}/${m.aTitle()}.md`
    const back = await h.other('POST', `/api/trash/${gone.id}/restore`, { to: renamed })
    assert.equal(back.status, 200, back.text)
    assert.equal(back.body.path, renamed)
    // Another place: where they may write, never where they can't.
    const again = await deleted(h, 'other', renamed)
    const away = `${s.path}/${m.aFolder()}/${m.aTitle()}.md`
    assert.equal((await h.other('POST', `/api/trash/${again.id}/restore`, { to: `${h.home('member')}/${m.aTitle()}.md` })).status, 404)
    assert.equal((await h.other('POST', `/api/trash/${again.id}/restore`, { to: 7 })).status, 400)
    const there = await h.other('POST', `/api/trash/${again.id}/restore`, { to: away })
    assert.equal(there.status, 200, there.text)
    assert.ok(existsSync(join(h.notesDir, away)))
  } finally {
    await h.close()
  }
})

test('with the retention on, each entry says when it goes; deleting it for good then takes its history at the next run, as the retention does', async () => {
  const h = await setup({ history: true })
  try {
    const confirm = h.created.admin.password
    const days = m.anInt(1, 90)
    assert.equal((await h.admin('PUT', '/api/admin/settings', { trashRetentionDays: days, historyRetentionDays: 3650, confirm })).status, 200)
    const path = `${h.home('member')}/${m.aTitle()}.md`
    const gone = await deleted(h, 'member', path)
    await h.settle()
    const view = await trash(h, 'member')
    assert.equal(view.retentionDays, days)
    const e = view.entries[0]!
    const deletedAt = JSON.parse(readFileSync(join(h.stateDir, 'trash', gone.id, 'meta.json'), 'utf8')).deletedAt as string
    assert.equal(e.expiresAt, new Date(Date.parse(deletedAt) + days * 86_400_000).toISOString())

    assert.equal((await h.member('DELETE', `/api/trash/${gone.id}`, { confirm: h.created.member.password })).status, 200)
    const state = JSON.parse(readFileSync(join(h.stateDir, 'retention.json'), 'utf8')) as { emptied: { path: string }[] }
    assert.deepEqual(state.emptied.map((d) => d.path), [path])
  } finally {
    await h.close()
  }
})
