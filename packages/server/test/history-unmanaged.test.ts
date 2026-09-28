// Unmanaged mode: the history is the user's own git repository, read and never
// written (docs: M2 specification, §7).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseThreads, resolveThread } from '@vihko/core'
import { setup, sleep } from './_history.ts'
import { AUTHOR, CO_AUTHOR, gitEnv, snapshot, userGit } from './_userGit.ts'
import { yamlKey } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'
import { tempDir } from './_tmp.ts'

// The setup copies the fixed vault (testdata/vault): its notes (tags.md,
// hogar/Proxy.md, privado/, recetas/ with its Unicode names) are the vault's.
// What the tests write and the notes they make are the mother's; commit
// messages are the steps' labels.
const m = mother(import.meta.url)
const UNMANAGED = 'history:\n  mode: unmanaged\n'
/** One word per line or name where a count of words or a Markdown destination depends on it. */
const word = () => m.aUniqueWord()

/** The text without its first comment thread, as resolving it in the editor leaves it. */
function resolveIn(text: string): string {
  const c = resolveThread(text, parseThreads(text)[0]!)
  return text.slice(0, c.from) + c.insert + text.slice(c.to)
}

const cursorOf = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

test('unmanaged mode reads the user\'s own git: their commits are the versions, by their authors, and moves follow git', async () => {
  const folder = m.aFolder()
  const NOTE = m.aNotePath(folder)
  const FIRST = m.aNotePath()
  const OUTSIDE = `${m.aTitle()}.md`
  const [w1, w2, w3, w4, w5] = [word(), word(), word(), word(), word()]
  const c: Record<string, { id: string; at: string }> = {}
  let repo!: ReturnType<typeof userGit>
  const h = await setup({
    // Nobody reads privado/ (nobody manages the root: whoever did would reach it, D-040 3.5).
    config: ({ admin, member }) => UNMANAGED + `permissions:\n  "": { grants: { ${yamlKey(admin)}: edit, ${yamlKey(member)}: edit } }\n  privado: { grants: {} }\n`,
    files: { [FIRST]: `${w1} ${w2} ${w3}\n` },
    // The notes folder is one folder of a larger repository.
    prepare: ({ dir, notesDir }) => {
      repo = userGit(dir)
      // Their settings don't change what vihko reads.
      for (const [k, v] of [['log.follow', 'true'], ['log.showRoot', 'false'], ['diff.renames', 'false'], ['i18n.logOutputEncoding', 'ISO-8859-1'], ['core.abbrev', '7']]) repo.run(['config', k!, v!])
      writeFileSync(join(dir, '.gitignore'), '/state/\n/*.db*\n')
      writeFileSync(join(dir, OUTSIDE), `${m.aSentence()}\n`)
      c.first = repo.commit('Initial')
      writeFileSync(join(notesDir, FIRST), `${w1} ${w2} ${w3} ${w4}\n`)
      writeFileSync(join(dir, OUTSIDE), `${m.aSentence()}\n`)
      c.edit = repo.commit('Edit', CO_AUTHOR)
      mkdirSync(join(notesDir, folder))
      repo.run(['mv', `notes/${FIRST}`, `notes/${NOTE}`])
      c.move = repo.commit('Move')
      writeFileSync(join(notesDir, NOTE), `${w1} ${w2} ${w3} ${w4} ${w5}\n`)
      c.after = repo.commit('After the move', CO_AUTHOR)
      writeFileSync(join(dir, OUTSIDE), `${m.aSentence()}\n`)
      c.outside = repo.commit('Only outside the notes folder', CO_AUTHOR)
      writeFileSync(join(notesDir, 'privado/sin-ia.md'), `${m.aSentence()}\n`)
      c.private = repo.commit('Only a private note', CO_AUTHOR)
    },
  })
  try {
    assert.deepEqual((await h.admin('GET', '/api/history/status')).body, { mode: 'unmanaged', available: true, error: null })
    const { versions, pending } = await h.versions(NOTE)
    assert.equal(pending, null, 'only commits are versions')
    assert.deepEqual(versions.map((v: any) => [v.id, v.change, v.path, v.from ?? null, v.authors[0].name, v.at]), [
      [c.after!.id, 'modified', NOTE, null, CO_AUTHOR.name, c.after!.at],
      [c.move!.id, 'moved', NOTE, FIRST, AUTHOR.name, c.move!.at],
      [c.edit!.id, 'modified', FIRST, null, CO_AUTHOR.name, c.edit!.at],
      [c.first!.id, 'created', FIRST, null, AUTHOR.name, c.first!.at],
    ])
    assert.deepEqual(versions[0].authors, [{ kind: 'git', id: CO_AUTHOR.email, name: CO_AUTHOR.name, key: `git:${CO_AUTHOR.email}` }])
    assert.ok(versions.every((v: any) => v.reason === null && v.foundAtStartup === false))
    assert.deepEqual(versions.map((v: any) => [v.added, v.removed]), [[1, 0], [0, 0], [1, 0], [3, 0]])

    // A version's text, and the note's text right before it, where it was then.
    const moved = await h.admin('GET', `/api/history/version?path=${h.q(NOTE)}&id=${c.move!.id}`)
    assert.deepEqual(moved.body, { path: NOTE, id: c.move!.id, at: c.move!.at, text: `${w1} ${w2} ${w3} ${w4}\n` })
    const oldest = await h.admin('GET', `/api/history/version?path=${h.q(NOTE)}&id=${c.first!.id}`)
    assert.deepEqual([oldest.body.path, oldest.body.text], [FIRST, `${w1} ${w2} ${w3}\n`])
    const d = await h.admin('GET', `/api/history/diff?path=${h.q(NOTE)}&id=${c.after!.id}`)
    assert.deepEqual([d.body.added, d.body.removed], [1, 0])
    assert.ok(d.body.ops.some(([op, s]: [number, string]) => op === 1 && s.includes(w5)))
    assert.equal((await h.admin('GET', `/api/history/version?path=${h.q(NOTE)}&id=${c.outside!.id}`)).status, 404, 'a commit that doesn\'t touch the note isn\'t one of its versions')

    // «Recent changes»: their git log, the notes folder only, file by file through the permission check.
    const { changes, authors } = await h.changes()
    assert.deepEqual(changes.map((ch: any) => ch.id), [c.after!.id, c.move!.id, c.edit!.id, c.first!.id], 'commits with nothing readable in the notes folder are left out')
    assert.deepEqual(changes[1].files, [{ path: NOTE, change: 'moved', from: FIRST, added: 0, removed: 0 }])
    assert.deepEqual(changes[2].files.map((f: any) => f.path), [FIRST])
    const first = changes[3].files.map((f: any) => f.path)
    // vihko.yaml isn't served to anyone (it holds the permissions), not even its history.
    assert.ok(first.includes('hogar/Proxy.md') && !first.includes('vihko.yaml') && !first.includes('privado/sin-ia.md'))
    for (const p of first) assert.ok(!p.split('/').some((s: string) => s.startsWith('.')) && !p.endsWith('~'), `a file vihko ignores is listed: ${p}`)
    assert.ok(changes[3].files.every((f: any) => f.change === 'created'))
    assert.deepEqual(authors.map((a: any) => a.key).sort(), [`git:${AUTHOR.email}`, `git:${CO_AUTHOR.email}`].sort())
    assert.deepEqual((await h.changes(`&author=git:${CO_AUTHOR.email}`)).changes.map((ch: any) => ch.id), [c.after!.id, c.edit!.id])
    assert.equal((await h.changes('&author=git')).changes.length, 4)
    assert.equal((await h.admin('GET', `/api/history/versions?path=${h.q('privado/sin-ia.md')}`)).status, 404)

    // What vihko writes is a change without a commit for their git, until they commit it.
    await h.put(NOTE, (t) => t + `${m.aSentence()}\n`)
    assert.equal((await h.versions(NOTE)).versions.length, 4)
    assert.equal(h.history.recorder.headId, null, 'nothing is recorded in a managed repository')
    const committed = repo.commit('Commit what vihko wrote', CO_AUTHOR)
    assert.deepEqual((await h.versions(NOTE)).versions.map((v: any) => v.id).slice(0, 2), [committed.id, c.after!.id])
  } finally { await h.close() }
})

test('unmanaged mode never writes to the user\'s repository: .git is byte for byte the same after reading all of it and restoring', async () => {
  const c: Record<string, { id: string; at: string }> = {}
  let repo!: ReturnType<typeof userGit>
  let before: Record<string, string> = {}
  const folder = m.aFolder()
  const path = m.aNotePath(folder)
  const image = `${word()}.png`
  const bytes = m.aSecret()
  const h = await setup({
    config: UNMANAGED,
    files: { [path]: `# ${m.aHeading()}\n\n![](${image})\n`, [`${folder}/${image}`]: bytes },
    prepare: ({ notesDir }) => {
      repo = userGit(notesDir)
      c.first = repo.commit('Initial')
      writeFileSync(join(notesDir, path), `# ${m.aHeading()}\n`)
      rmSync(join(notesDir, folder, image))
      c.second = repo.commit('Drop the image', CO_AUTHOR)
      // A lock of the user's own git (their editor is committing): never taken for a crash's, as in vihko's own repository.
      writeFileSync(join(notesDir, '.git/index.lock'), '')
      // Before vihko starts: looking for the repository mustn't write to it either.
      before = snapshot(join(notesDir, '.git'))
    },
  })
  try {
    assert.equal((await h.admin('GET', '/api/history/status')).body.available, true)
    assert.deepEqual((await h.admin('GET', '/api/alerts')).body.alerts.filter((a: any) => a.code.startsWith('history_')), [])
    const page = await h.versions(path, '&limit=1')
    const rest = await h.versions(path, `&limit=1&cursor=${page.next}`)
    assert.deepEqual([...page.versions, ...rest.versions].map((v: any) => v.id), [c.second!.id, c.first!.id])
    for (const against of ['previous', 'current', c.second!.id]) {
      assert.equal((await h.admin('GET', `/api/history/diff?path=${h.q(path)}&id=${c.first!.id}&against=${against}`)).status, 200)
    }
    await h.changes()
    await h.changes(`&author=git:${CO_AUTHOR.email}`)
    await h.admin('GET', `/api/history/changes?limit=1&cursor=${(await h.admin('GET', '/api/history/changes?limit=1')).body.next}`)

    // Restoring writes through the core, and brings back the image that version linked.
    const r = await h.admin('POST', '/api/history/restore', { path, id: c.first!.id })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.images, { restored: [`${folder}/${image}`], missing: [] })
    assert.equal(readFileSync(join(h.notesDir, folder, image), 'utf8'), bytes)
    assert.ok(readFileSync(join(h.notesDir, path), 'utf8').includes(`![](${image})`))

    // To managed and back: the managed history lives in the state volume.
    for (const mode of ['managed', 'unmanaged']) {
      writeFileSync(join(h.notesDir, 'vihko.yaml'), `history:\n  mode: ${mode}\n`)
      h.workspace.reload()
      await h.history.configure()
      await h.settle()
      await h.versions(path)
    }

    assert.deepEqual(snapshot(join(h.notesDir, '.git')), before)
    // For their git, the restore is a change without a commit.
    assert.equal(repo.head(), c.second!.id)
    // -z: paths as they are (without it, git quotes names with spaces or accents).
    const status = repo.run(['--no-optional-locks', 'status', '--porcelain', '-z']).split('\0')
    assert.ok(status.includes(` M ${path}`), status.join('\n'))
    assert.ok(status.includes(`?? ${folder}/${image}`), status.join('\n'))
  } finally { await h.close() }
})

test('pages in unmanaged mode follow moves across pages and stay the same while the user commits', async () => {
  const ids: string[] = []
  let repo!: ReturnType<typeof userGit>
  let notes = ''
  const series = m.aNotePath()
  const movedTo = m.aFolder()
  const path = `${movedTo}/${series}`
  const h = await setup({
    config: UNMANAGED,
    files: { [series]: `${m.aSentence()}\n` },
    prepare: ({ notesDir }) => {
      notes = notesDir
      repo = userGit(notesDir)
      ids.unshift(repo.commit('v0').id)
      for (let i = 1; i <= 3; i++) {
        writeFileSync(join(notesDir, series), `${m.aSentence()}\n`)
        ids.unshift(repo.commit(`v${i}`, i % 2 ? CO_AUTHOR : AUTHOR).id)
        writeFileSync(join(notesDir, 'tags.md'), `${m.aSentence()}\n`)
        repo.commit(`other ${i}`)
      }
      mkdirSync(join(notesDir, movedTo))
      repo.run(['mv', series, path])
      ids.unshift(repo.commit('move').id)
      for (let i = 4; i <= 5; i++) {
        writeFileSync(join(notesDir, path), `${m.aSentence()}\n`)
        ids.unshift(repo.commit(`v${i}`).id)
      }
    },
  })
  try {
    const seen: any[] = []
    let next: string | null = null
    let pages = 0
    do {
      const page = await h.versions(path, `&limit=2${next ? `&cursor=${next}` : ''}`)
      assert.ok(page.versions.length <= 2)
      seen.push(...page.versions)
      next = page.next
      // The user commits while the pages are read: the listing goes on where it started.
      if (pages++ === 0) {
        writeFileSync(join(notes, path), `${m.aSentence()}\n`)
        repo.commit('while reading', CO_AUTHOR)
      }
    } while (next)
    assert.deepEqual(seen.map((v) => v.id), ids)
    assert.equal(pages, 4)
    assert.deepEqual(seen.filter((v) => v.change === 'moved').map((v) => [v.from, v.path]), [[series, path]])
    assert.equal(seen.at(-1).change, 'created')
    // A new first page has it.
    assert.equal((await h.versions(path, '&limit=2')).versions[0].authors[0].name, CO_AUTHOR.name)

    // «Recent changes» pages the same way.
    const all: string[] = []
    let cursor: string | null = null
    do {
      const r = await h.admin('GET', `/api/history/changes?limit=3${cursor ? `&cursor=${cursor}` : ''}`)
      all.push(...r.body.changes.map((ch: any) => ch.id))
      cursor = r.body.next
      if (all.length === 3) {
        writeFileSync(join(notes, 'tags.md'), `${m.aSentence()}\n`)
        repo.commit('also while reading')
      }
    } while (cursor)
    assert.equal(all.length, 11)
    assert.equal(new Set(all).size, 11)
    assert.equal(all[0], repo.run(['rev-parse', 'HEAD~1']).trim(), 'pages go on from where the listing started')

    // A cursor is data, never a git option.
    for (const bad of [cursorOf({ start: '--output=/tmp/vihko-pwned', skip: 0 }), cursorOf({ start: ids[0], skip: -1 }), 'nonsense']) {
      assert.equal((await h.admin('GET', `/api/history/changes?cursor=${bad}`)).status, 400)
      assert.equal((await h.admin('GET', `/api/history/versions?path=${h.q(path)}&cursor=${bad}`)).status, 400)
    }
    assert.ok(!existsSync('/tmp/vihko-pwned'))
  } finally { await h.close() }
})

test('unmanaged mode: a repository without commits, then a detached HEAD', async () => {
  let repo!: ReturnType<typeof userGit>
  const h = await setup({ config: UNMANAGED, prepare: ({ notesDir }) => { repo = userGit(notesDir) } })
  try {
    assert.deepEqual((await h.admin('GET', '/api/history/status')).body, { mode: 'unmanaged', available: true, error: null })
    assert.deepEqual((await h.versions('tags.md')).versions, [])
    assert.deepEqual(await h.changes(), { changes: [], next: null, authors: [] })
    const first = repo.commit('Initial')
    writeFileSync(join(h.notesDir, 'tags.md'), `${m.aSentence()}\n`)
    const second = repo.commit('Second', CO_AUTHOR)
    assert.deepEqual((await h.versions('tags.md')).versions.map((v: any) => v.id), [second.id, first.id])
    repo.run(['checkout', '-q', '--detach', 'HEAD~1'])
    assert.deepEqual((await h.versions('tags.md')).versions.map((v: any) => v.id), [first.id], 'what HEAD reaches')
    assert.deepEqual((await h.changes()).changes.map((ch: any) => ch.id), [first.id])
  } finally { await h.close() }
})

test('resolved comments in unmanaged mode: a commit of the user that removes a thread, by that commit\'s author', async () => {
  const NOTE = m.aNotePath(m.aFolder())
  const commenter = m.aUsername()
  const said = m.aComment()
  const K = `<!-- @${commenter} 2026-09-24T08:12Z · ${said} -->`
  const TEXT = `# ${m.aHeading()}\n\n${m.aSentence()}${K}\n\n${m.aSentence()}\n`
  let repo!: ReturnType<typeof userGit>
  const h = await setup({
    config: UNMANAGED,
    files: { [NOTE]: TEXT },
    prepare: ({ notesDir }) => {
      repo = userGit(notesDir, { since: Date.now() - 3_600_000 })
      repo.commit('Initial')
    },
  })
  const resolved = async () => {
    const q = new URLSearchParams()
    q.set('path', NOTE)
    const r = await h.admin('GET', `/api/history/resolved?${q}`)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return r.body as { threads: any[]; complete: boolean }
  }
  try {
    // Resolved in the file (as the editor leaves it), not committed: nothing to recover from yet.
    writeFileSync(join(h.notesDir, NOTE), resolveIn(TEXT))
    assert.deepEqual(await resolved(), { threads: [], complete: true })
    const c = repo.commit('Resolve the thread', CO_AUTHOR)
    const { threads, complete } = await resolved()
    assert.equal(complete, true)
    assert.deepEqual(threads.map((t) => [t.id, t.version, t.resolvedAt, t.reopenable]), [[`${commenter}|2026-09-24T08:12Z|${said}`, c.id, c.at, true]])
    assert.deepEqual(threads[0].resolvedBy, [{ kind: 'git', id: CO_AUTHOR.email, name: CO_AUTHOR.name, key: `git:${CO_AUTHOR.email}` }])
  } finally { await h.close() }
})

test('unmanaged mode reads a repository with SHA-256 object ids', async () => {
  const c: { id: string; at: string }[] = []
  const note = m.aNotePath()
  const image = `${word()}.png`
  const h = await setup({
    config: UNMANAGED,
    prepare: ({ notesDir }) => {
      execFileSync('git', ['init', '-q', '--object-format=sha256', notesDir], { env: gitEnv() })
      const repo = userGit(notesDir)
      c.push(repo.commit('Initial'))
      writeFileSync(join(notesDir, note), `![](${image})\n`)
      writeFileSync(join(notesDir, image), m.aSecret())
      c.push(repo.commit('With an image', CO_AUTHOR))
      rmSync(join(notesDir, image))
      writeFileSync(join(notesDir, note), `${m.aSentence()}\n`)
      c.push(repo.commit('Without it'))
    },
  })
  try {
    const { versions } = await h.versions(note)
    assert.deepEqual(versions.map((v: any) => [v.id.length, v.change]), [[64, 'modified'], [64, 'created']])
    const v = await h.admin('GET', `/api/history/version?path=${h.q(note)}&id=${c[1]!.id}`)
    assert.equal(v.body.text, `![](${image})\n`)
    const r = await h.admin('POST', '/api/history/restore', { path: note, id: c[1]!.id })
    assert.deepEqual(r.body.images, { restored: [image], missing: [] })
    assert.equal((await h.changes()).changes.length, 3)
  } finally { await h.close() }
})

test('unmanaged mode: a shallow clone\'s history ends where the clone does', async () => {
  const c: string[] = []
  const series = m.aNotePath()
  const texts = Array.from({ length: 4 }, word)
  const h = await setup({
    prepare: ({ dir, notesDir }) => {
      const origin = join(dir, 'origin')
      mkdirSync(origin)
      const repo = userGit(origin)
      writeFileSync(join(origin, 'vihko.yaml'), UNMANAGED)
      for (let i = 1; i <= 4; i++) {
        writeFileSync(join(origin, series), `${texts[i - 1]}\n`)
        c.push(repo.commit(`v${i}`).id)
      }
      rmSync(notesDir, { recursive: true })
      execFileSync('git', ['clone', '-q', '--depth', '2', `file://${origin}`, notesDir], { env: gitEnv() })
    },
  })
  try {
    assert.equal((await h.admin('GET', '/api/history/status')).body.available, true)
    const { versions } = await h.versions(series)
    assert.deepEqual(versions.map((v: any) => [v.id, v.change]), [[c[3], 'modified']], 'the commit the clone starts at is not a version: what it changed is unknown')
    const v = await h.admin('GET', `/api/history/version?path=${h.q(series)}&id=${c[3]}`)
    assert.equal(v.body.text, `${texts[3]}\n`)
    const d = await h.admin('GET', `/api/history/diff?path=${h.q(series)}&id=${c[3]}`)
    assert.deepEqual([d.body.added, d.body.removed], [1, 1], 'against the text the clone starts with')
    assert.deepEqual((await h.changes()).changes.map((ch: any) => ch.id), [c[3]])
  } finally { await h.close() }
})

test('unmanaged mode: submodules are left out, files in Git LFS show their pointer and never break a restore, names keep their Unicode and spaces', async () => {
  const c: Record<string, { id: string; at: string }> = {}
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n'
  let cafe = ''
  // Names in .gitattributes and a Markdown destination: one word each.
  const folder = word()
  const note = `${folder}/${word()}.md`
  const image = `${word()}.png`
  const lfsNote = `${word()}.md`
  const submodule = word()
  const h = await setup({
    config: UNMANAGED,
    files: { [note]: `![](${image})\n`, [`${folder}/${image}`]: pointer, [lfsNote]: pointer },
    prepare: ({ notesDir }) => {
      const repo = userGit(notesDir)
      writeFileSync(join(notesDir, '.gitattributes'), `*.png filter=lfs diff=lfs merge=lfs -text\n${lfsNote} filter=lfs diff=lfs merge=lfs -text\n`)
      c.first = repo.commit('Initial')
      // A submodule (not checked out): only its commit is in the tree.
      mkdirSync(join(notesDir, submodule))
      repo.run(['update-index', '--add', '--cacheinfo', `160000,${c.first.id},${submodule}`])
      c.submodule = repo.commit('Add a submodule', AUTHOR, { add: false })
      rmSync(join(notesDir, folder, image))
      writeFileSync(join(notesDir, note), `${m.aSentence()}\n`)
      // As it is on disk (NFD).
      cafe = `recetas/${readdirSync(join(notesDir, 'recetas')).find((n) => n.normalize('NFC') === 'Café.md')!}`
      writeFileSync(join(notesDir, cafe), `${m.aSentence()}\n`)
      writeFileSync(join(notesDir, 'recetas/Notas de reunión (2026).md'), `${m.aSentence()}\n`)
      c.last = repo.commit('Drop the image, edit the recipes', CO_AUTHOR)
    },
  })
  try {
    const { changes } = await h.changes()
    assert.deepEqual(changes.map((ch: any) => ch.id), [c.last!.id, c.first!.id], 'a commit that only adds a submodule has nothing to show')
    assert.ok(changes.every((ch: any) => ch.files.every((f: any) => f.path !== submodule)))
    assert.deepEqual(changes[0].files.map((f: any) => [f.path, f.change]).sort(), [
      [note, 'modified'], [`${folder}/${image}`, 'deleted'], [cafe, 'modified'], ['recetas/Notas de reunión (2026).md', 'modified'],
    ].sort())
    for (const p of [cafe, 'recetas/Notas de reunión (2026).md']) {
      assert.deepEqual((await h.versions(p)).versions.map((v: any) => [v.path, v.change]), [[p, 'modified'], [p, 'created']])
    }
    // A note kept in LFS: its versions are the pointer (git has nothing else).
    const lfsVersion = (await h.versions(lfsNote)).versions[0]
    const text = (await h.admin('GET', `/api/history/version?path=${h.q(lfsNote)}&id=${lfsVersion.id}`)).body.text
    assert.ok(text.startsWith('version https://git-lfs.github.com/spec/v1'))
    // An image kept in LFS isn't brought back as its pointer.
    const r = await h.admin('POST', '/api/history/restore', { path: note, id: c.first!.id })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.images, { restored: [], missing: [{ path: `${folder}/${image}`, reason: 'not_in_history' }] })
    assert.ok(!existsSync(join(h.notesDir, folder, image)))
  } finally { await h.close() }
})

test('unmanaged mode reads a repository another user owns, naming only its path; a git that fails is reported', async () => {
  const tools = tempDir('vihko-git-')
  const flag = join(tools, 'git-broken')
  const git = join(tools, 'git-foreign-owner.sh')
  // Every repository looks owned by someone else (as on an NFS export mapped to `nobody`).
  writeFileSync(git, `#!/bin/sh\nif [ -e '${flag}' ]; then echo 'simulated failure' >&2; exit 128; fi\nGIT_TEST_ASSUME_DIFFERENT_OWNER=1 exec git "$@"\n`)
  chmodSync(git, 0o755)
  let first = ''
  const h = await setup({
    config: UNMANAGED,
    git,
    prepare: ({ notesDir }) => { first = userGit(notesDir).commit('Initial').id },
  })
  try {
    // The simulation holds: without its path in `safe.directory`, git refuses the repository.
    assert.throws(() => execFileSync(git, ['-C', h.notesDir, 'rev-parse', '--show-toplevel'], { env: gitEnv(), stdio: 'pipe' }), /dubious ownership/)
    assert.deepEqual((await h.admin('GET', '/api/history/status')).body, { mode: 'unmanaged', available: true, error: null })
    assert.deepEqual((await h.versions('tags.md')).versions.map((v: any) => v.id), [first])

    writeFileSync(flag, '')
    assert.equal((await h.admin('GET', '/api/history/versions?path=tags.md')).status, 503)
    const failed = await h.admin('GET', '/api/history/versions?path=tags.md')
    assert.deepEqual([failed.status, failed.body.error], [503, 'history_unavailable'])
    const status = (await h.admin('GET', '/api/history/status')).body
    assert.deepEqual([status.available, status.error.code], [false, 'git_failed'])
    const alert = (await h.admin('GET', '/api/alerts')).body.alerts.find((a: any) => a.code === 'history_unavailable')
    assert.match(alert.detail, /simulated failure/)

    rmSync(flag)
    assert.deepEqual((await h.versions('tags.md')).versions.map((v: any) => v.id), [first], 'the next read looks again')
    assert.equal((await h.admin('GET', '/api/history/status')).body.available, true)
  } finally { await h.close(); rmSync(tools, { recursive: true, force: true }) }
})

test('switching modes live keeps the managed history and the user\'s git apart', async () => {
  const NOTE = 'hogar/Proxy.md'
  let repo!: ReturnType<typeof userGit>
  let initial = ''
  let before: Record<string, string> = {}
  const h = await setup({
    prepare: ({ notesDir }) => {
      repo = userGit(notesDir)
      initial = repo.commit('Initial').id
      before = snapshot(join(notesDir, '.git'))
    },
  })
  const mode = async (to: string) => {
    writeFileSync(join(h.notesDir, 'vihko.yaml'), `history:\n  mode: ${to}\n`)
    h.workspace.reload()
    await h.history.configure()
    await h.settle()
  }
  try {
    // Managed by default, even with a repository in the folder.
    await h.put(NOTE, (t) => t + `\n${m.aSentence()}\n`)
    await h.settle()
    assert.deepEqual((await h.versions(NOTE)).versions.map((v: any) => v.authors[0].kind), ['user', 'system'])
    await mode('unmanaged')
    const managedHead = h.history.recorder.headId
    assert.deepEqual((await h.versions(NOTE)).versions.map((v: any) => [v.id, v.authors[0].kind]), [[initial, 'git']])
    await h.put(NOTE, (t) => t + `${m.aSentence()}\n`)
    await sleep(50)
    await h.settle()
    assert.equal(h.history.recorder.headId, managedHead, 'nothing is recorded meanwhile')
    await mode('off')
    assert.equal((await h.admin('GET', `/api/history/versions?path=${h.q(NOTE)}`)).body.error, 'history_off')
    await mode('managed')
    const { versions } = await h.versions(NOTE)
    assert.deepEqual(versions.map((v: any) => [v.authors[0].kind, v.reason?.code ?? null]), [['system', 'history_resumed'], ['user', null], ['system', 'history_enabled']])
    assert.ok(!(await h.changes()).authors.some((a: any) => a.kind === 'git'), 'the user\'s commits never enter the managed history')
    assert.equal(repo.head(), initial)
    assert.deepEqual(snapshot(join(h.notesDir, '.git')), before)
  } finally { await h.close() }
})
