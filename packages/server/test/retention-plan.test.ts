// What the history's retention takes out (history/retention.ts
// `planRetention`), on histories built by hand: a deleted note followed back
// through its moves (a file's and a folder's) and through being restored; a
// name used again by another note; a trash entry whose folder moved after
// the deletion; and, always, the same files at the head afterwards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { planRetention, type RetentionRequest } from '@vihko/server'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const DAY = 86_400_000
const T0 = Date.now() - 1000 * DAY

type File = { status: string; mode: string; oldOid: string | null; newOid: string | null; path: string }
type Commit = { id: string; parent: string | null; author: string; committer: string; message: string; files: File[] }

/** A history written step by step: each step is a commit at `day` days after T0. */
function history() {
  const commits: Commit[] = []
  const tree = new Map<string, string>()
  const oid = () => createHash('sha1').update(m.aSentence()).digest('hex')
  const commit = (day: number, changes: { path: string; to: 'write' | 'delete' }[], trailers: string[] = []) => {
    const files: File[] = changes.map(({ path, to }) => {
      const was = tree.get(path) ?? null
      const now = to === 'write' ? oid() : null
      if (now) tree.set(path, now)
      else tree.delete(path)
      return { status: now === null ? 'D' : was === null ? 'A' : 'M', mode: '100644', oldOid: was, newOid: now, path }
    })
    const at = Math.floor((T0 + day * DAY) / 1000)
    const id = createHash('sha1').update(`${commits.length}`).digest('hex')
    commits.push({ id, parent: commits.at(-1)?.id ?? null, author: `someone <x@users.vihko.invalid> ${at} +0000`, committer: `vihko <vihko@vihko.invalid> ${at} +0000`, message: `Change\n\n${trailers.map((t) => t + '\n').join('')}`, files })
    return T0 + day * DAY
  }
  const move = (day: number, from: string, to: string) => {
    const content = tree.get(from)!
    tree.delete(from)
    tree.set(to, content)
    const at = Math.floor((T0 + day * DAY) / 1000)
    commits.push({
      id: createHash('sha1').update(`${commits.length}`).digest('hex'), parent: commits.at(-1)?.id ?? null,
      author: `someone <x@users.vihko.invalid> ${at} +0000`, committer: `vihko <vihko@vihko.invalid> ${at} +0000`,
      message: `Move\n\nVihko-Move: ${from}\t${to}\n`,
      files: [{ status: 'D', mode: '100644', oldOid: content, newOid: null, path: from }, { status: 'A', mode: '100644', oldOid: null, newOid: content, path: to }],
    })
  }
  return { commits, tree, commit, move }
}

/** The plan applied: the files at the head, and each path's versions left (oldest first: A, M, D). */
function apply(commits: Commit[], req: RetentionRequest) {
  const plan = planRetention(commits, req)
  const tree = new Map<string, string>()
  const kept = new Map<string, string[]>()
  const keep = (p: string, s: string) => kept.set(p, [...(kept.get(p) ?? []), s])
  for (const c of commits.slice(0, plan.first < 0 ? commits.length : plan.first)) for (const f of c.files) {
    if (f.newOid) tree.set(f.path, f.newOid)
    else tree.delete(f.path)
    keep(f.path, f.status)
  }
  for (const b of plan.built) for (const op of b.ops) {
    if (op.op === 'M') { keep(op.path, tree.has(op.path) ? 'M' : 'A'); tree.set(op.path, op.oid) } else if (tree.has(op.path)) { keep(op.path, 'D'); tree.delete(op.path) }
  }
  return { plan, tree, kept }
}

const path = () => `spaces/${m.aSpaceFolder()}/${m.aNotePath(m.aFolder())}`

test('versions older than the cutoff go, except each file\'s at the cutoff; a name used again keeps its new life', () => {
  const h = history()
  const [a, b, gone] = [path(), path(), path()]
  h.commit(0, [{ path: a, to: 'write' }, { path: b, to: 'write' }, { path: gone, to: 'write' }])
  h.commit(10, [{ path: a, to: 'write' }])
  h.commit(20, [{ path: gone, to: 'delete' }])
  h.commit(30, [{ path: b, to: 'write' }])
  h.commit(500, [{ path: gone, to: 'write' }])
  h.commit(600, [{ path: b, to: 'write' }])
  const { plan, tree, kept } = apply(h.commits, { cutoff: T0 + 100 * DAY, keep: [], drop: [] })
  assert.deepEqual(tree, h.tree, 'the same files at the head')
  assert.deepEqual(kept.get(a), ['A'], 'unchanged since: its current version alone')
  assert.deepEqual(kept.get(b), ['A', 'M'], 'its version at the cutoff, and the newer one')
  assert.deepEqual(kept.get(gone), ['A'], 'deleted before the cutoff: only the new note of that name')
  assert.equal(plan.versions, 3, 'the three first versions (a deletion is no version)')
  assert.equal(plan.commits, 2, 'the commits left with nothing go')
})

test('a note in the trash keeps every version however old; an emptied one loses them all, through its moves and its restores', () => {
  const h = history()
  const [trashed, first, second, third, other] = [path(), path(), path(), path(), path()]
  h.commit(0, [{ path: trashed, to: 'write' }, { path: first, to: 'write' }, { path: other, to: 'write' }])
  h.commit(5, [{ path: trashed, to: 'write' }, { path: first, to: 'write' }])
  const trashedAt = h.commit(6, [{ path: trashed, to: 'delete' }])
  h.move(7, first, second)
  // Deleted, and brought back from the trash.
  h.commit(8, [{ path: second, to: 'delete' }])
  h.commit(9, [{ path: second, to: 'write' }])
  h.commits.at(-1)!.message += `Vihko-Reason: {"code":"trash_restored","id":"${m.faker.string.ulid()}"}\n`
  h.move(10, second, third)
  h.commit(11, [{ path: third, to: 'write' }, { path: other, to: 'write' }])
  const emptiedAt = h.commit(12, [{ path: third, to: 'delete' }])
  h.commit(900, [{ path: other, to: 'write' }])
  const { tree, kept, plan } = apply(h.commits, {
    cutoff: T0 + 100 * DAY,
    keep: [{ path: trashed, deletedAt: trashedAt }],
    drop: [{ path: third, deletedAt: emptiedAt }],
  })
  assert.deepEqual(tree, h.tree)
  assert.deepEqual(kept.get(trashed), ['A', 'M', 'D'])
  for (const p of [first, second, third]) assert.equal(kept.get(p), undefined, p)
  assert.deepEqual(kept.get(other), ['A', 'M'])
  // Move trailers stay only where what they moved stays.
  assert.ok(plan.built.every((b) => !b.keepMove(first, second) || b.ops.some((o) => o.path === second)))
})

test('an emptied note is found where it was deleted, when its folder moved afterwards; and it goes even newer than the cutoff', () => {
  const h = history()
  const folder = `spaces/${m.aSpaceFolder()}/${m.aFolder()}`
  const name = `${m.aUniqueWord()}.md`
  const stays = `${folder}/${m.aUniqueWord()}.md`
  const moved = `spaces/${m.aSpaceFolder()}/${m.aFolder()}`
  h.commit(0, [{ path: `${folder}/${name}`, to: 'write' }, { path: stays, to: 'write' }])
  h.commit(1, [{ path: `${folder}/${name}`, to: 'write' }])
  const deletedAt = h.commit(2, [{ path: `${folder}/${name}`, to: 'delete' }])
  // The folder moves; the trash entry's path follows it (folderRefs.ts), the history doesn't hold the deleted note there.
  h.move(3, stays, `${moved}/${stays.slice(folder.length + 1)}`)
  h.commits.at(-1)!.message = `Move\n\nVihko-Move: ${folder}\t${moved}\n`
  const { tree, kept } = apply(h.commits, { cutoff: null, keep: [], drop: [{ path: `${moved}/${name}`, deletedAt }] })
  assert.deepEqual(tree, h.tree)
  assert.equal(kept.get(`${folder}/${name}`), undefined)
  assert.deepEqual(kept.get(stays), ['A', 'D'])
})

test('nothing to take out: no commit is rewritten', () => {
  const h = history()
  const a = path()
  h.commit(0, [{ path: a, to: 'write' }])
  h.commit(1, [{ path: a, to: 'write' }])
  assert.equal(planRetention(h.commits, { cutoff: T0 - DAY, keep: [], drop: [] }).first, -1)
  assert.equal(planRetention(h.commits, { cutoff: null, keep: [], drop: [{ path: path(), deletedAt: T0 }] }).first, -1)
})
