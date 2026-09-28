// Notes folders on a case-insensitive filesystem (a macOS or Windows folder
// shared into the container, an SMB share, some NFS datasets): there
// `People/noa/diary.md` opens `people/noa/diary.md`, while the permissions go
// by the path as written. A path spelled otherwise than the disk spells it
// doesn't exist for vihko, through any door: the API, the files, the history
// and the collaboration hub.
//
// Linux only offers such a folder to root, or inside a user namespace: this
// file runs itself again under `unshare`, on a tmpfs mounted with `casefold`
// and a folder marked case-insensitive (`chattr +F`). Where that can't be
// done, it's skipped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentHash } from '@vihko/core'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const INSIDE = process.env.VIHKO_TEST_CASEFOLD === '1'

if (!INSIDE) {
  test('on a case-insensitive notes folder, a path spelled otherwise than the disk doesn\'t exist for vihko', (t) => {
    const mount = tempDir('vihko-casefold-')
    // $0: the mount point; the folder in it is case-insensitive, and so is everything made under it.
    const prepare = 'mount -t tmpfs -o casefold tmpfs "$0" && mkdir "$0/tmp" && chattr +F "$0/tmp"'
    const probe = spawnSync('unshare', ['-rm', 'sh', '-c', `${prepare} && mkdir "$0/tmp/a" && test -d "$0/tmp/A"`, mount], { encoding: 'utf8' })
    if (probe.status !== 0) {
      t.skip(`no case-insensitive folder to test on (unshare, tmpfs with casefold, chattr): ${(probe.stderr || probe.error?.message || '').trim()}`)
      return
    }
    // A run of its own: without the test runner's context, which would make it report to this one instead.
    const { NODE_TEST_CONTEXT: _, ...env } = process.env
    const run = spawnSync('unshare', ['-rm', 'sh', '-c', `${prepare} && TMPDIR="$0/tmp" exec "$1" --test --test-force-exit "$2"`, mount, process.execPath, fileURLToPath(import.meta.url)], {
      encoding: 'utf8',
      env: { ...env, VIHKO_TEST_CASEFOLD: '1' },
      timeout: 240_000,
    })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    assert.match(run.stdout, /pass [1-9]/, 'the tests inside ran')
    assert.match(run.stdout, /fail 0/)
  })
} else {
  const m = mother(import.meta.url)
  // Imported here: only the run inside the namespace builds the scenario.
  const { DIR, FILES, MEMBER, PATH, WORD, home, setup } = await import('./_m4.ts')
  const { rootIgnoresCase } = await import('@vihko/server')
  /** The same path with the people's folder spelled in capitals: on this disk, the same file. */
  const alias = (path: string) => {
    const other = path.replace(DIR.people, DIR.people.toUpperCase())
    assert.notEqual(other, path, 'the folder name has letters with capitals')
    return other
  }
  const own = home(MEMBER.username)

  test('the admin, who manages the root, reads and writes nothing of a personal folder by spelling it otherwise', async () => {
    const h = await setup({ files: FILES })
    try {
      assert.ok(existsSync(join(h.notesDir, alias(PATH.cake))), 'the disk opens the other spelling')
      const q = (path: string, params: Record<string, string>) => h.url(path, params)
      const cakeBefore = readFileSync(join(h.notesDir, PATH.cake), 'utf8')

      // Reading, as a note, a file, its links or headings, or its history against the note now.
      for (const [route, params] of [
        ['/api/note', { path: alias(PATH.cake) }],
        ['/api/note/links', { path: alias(PATH.cake) }],
        ['/api/note/headings', { path: alias(PATH.cake) }],
        ['/api/note/comments', { path: alias(PATH.cake) }],
        ['/api/file', { path: alias(PATH.memberPhoto) }],
      ] as const) {
        const r = await h.admin('GET', q(route, params))
        assert.equal(r.status, 404, `${route} ${r.text}`)
        assert.ok(!r.text.includes(WORD.cake), r.text)
      }
      // The member, whose folder it is, reads it as the disk spells it.
      assert.equal((await h.member('GET', q('/api/note', { path: PATH.cake }))).status, 200)

      // Writing: over it, a new note beside it, a folder in it, a note moved into it.
      const put = await h.admin('PUT', q('/api/note', { path: alias(PATH.cake) }), { text: m.aSentence() }, { 'if-match': `"${contentHash(cakeBefore)}"` })
      assert.equal(put.status, 404, put.text)
      const created = `${alias(own)}/${m.aTitle()}.md`
      assert.equal((await h.admin('POST', '/api/note', { path: created, text: m.aSentence() })).status, 404)
      assert.equal((await h.admin('PUT', q('/api/note', { path: created }), { text: m.aSentence() }, { 'if-none-match': '*' })).status, 404)
      assert.equal((await h.admin('POST', '/api/folder', { path: `${alias(own)}/${m.aFolder()}` })).status, 404)
      const moved = await h.admin('POST', '/api/note/move', { from: PATH.settings, to: `${alias(own)}/${m.aTitle()}.md` })
      assert.equal(moved.status, 404, moved.text)
      assert.equal(readFileSync(join(h.notesDir, PATH.cake), 'utf8'), cakeBefore)
      assert.ok(existsSync(join(h.notesDir, PATH.settings)), 'nothing moved')

      // Told once, from the root: this folder ignores case.
      assert.equal(rootIgnoresCase(h.notesDir), true)

      // What reports another spelling (a watcher, a sync tool's rename) indexes and versions nothing under it.
      const others = [alias(PATH.cake), alias(PATH.memberPhoto)]
      h.indexer.indexPaths(others, { detectMoves: true })
      h.indexer.indexFolders([alias(own)])
      await h.history.recorder.observePaths(others)
      await h.settle()
      const found = await h.admin('GET', q('/api/search', { q: WORD.cake }))
      assert.deepEqual(found.body.results, [], 'nothing of the personal folder is searchable')
      const tree = await h.admin('GET', '/api/tree')
      assert.ok(!tree.text.includes(DIR.people.toUpperCase()), 'no folder under the other spelling')
      const { changes } = await h.history.reader().changes({ limit: 200, canRead: () => true })
      for (const p of others) assert.ok(!changes.some((c) => c.files.some((f) => f.path === p)), p)

      // vihko.yaml, spelled otherwise, is still nobody's.
      for (const who of ['admin', 'member'] as const) {
        assert.equal((await h.as(who)('GET', q('/api/file', { path: 'VIHKO.yaml' }))).status, 404, who)
      }
    } finally { await h.close() }
  })

  test('the collaboration hub opens nothing of a personal folder spelled otherwise', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const Y = await import('yjs')
    const { HocuspocusProvider } = await import('@hocuspocus/provider')
    const { CLI, closeAll, login, makeDirs, open, socket, startServer, waitFor } = await import('./_collab.ts')
    const { yamlKey } = await import('./_permissions.ts')
    const { notes, env, admin } = makeDirs()
    const member = m.aUser()
    spawnSync(process.execPath, [CLI, 'user', 'create', member.username], { env: { ...process.env, ...env }, input: member.password })
    const people = m.aFolder()
    const diary = m.aNotePath(`${people}/${member.username}`)
    const word = m.aUniqueWord()
    mkdirSync(join(notes, people, member.username), { recursive: true })
    writeFileSync(join(notes, diary), `# ${m.aHeading()}\n\n${word}\n`)
    writeFileSync(join(notes, 'vihko.yaml'), `permissions:\n  "":\n    grants: { ${yamlKey(admin.username)}: manage }\n  ${yamlKey(`${people}/{user}`)}:\n    grants: { "{user}": manage }\n`)
    const other = diary.replace(people, people.toUpperCase())
    assert.notEqual(other, diary)
    // A port of the range these tests may use.
    const srv = await startServer({ ...env, VIHKO_PORT: String(42300 + Math.floor(Math.random() * 100)) })
    try {
      const cookie = await login(srv)
      const provider = new HocuspocusProvider({ websocketProvider: socket(srv, cookie), name: other, document: new Y.Doc(), token: '{}' })
      open.unshift(provider)
      let refused = false
      provider.on('authenticationFailed', () => { refused = true })
      provider.attach()
      await waitFor(() => refused || provider.isSynced, 'the hub\'s answer')
      assert.equal(refused, true, 'refused, as a note that isn\'t there')
      assert.ok(!provider.document.getText('md').toString().includes(word))
    } finally { closeAll(); await srv.stop() }
  })
}
