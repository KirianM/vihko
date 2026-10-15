// Notes folders on a case-insensitive filesystem (a macOS or Windows folder
// shared into the container, an SMB share, some NFS datasets): there
// `people/noa/Diary/x.md` opens `people/noa/diary/x.md`, while the permissions
// go by the path as written. A path spelled otherwise than the disk spells it
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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
  const { PNG, setup } = await import('./_agents.ts')
  const { sharedSpace, yamlKey } = await import('./_permissions.ts')
  const { rootIgnoresCase } = await import('@vihko/server')
  // The member's private folder in their space, and the same name in capitals:
  // on this disk, the same folder. The admin is granted the other spelling (a
  // grant for a folder that doesn't exist is kept): that grant must
  // never reach the folder the disk has.
  const DIARY = m.aFolder()
  const ALIAS = DIARY.toUpperCase()
  const WORD = m.aUniqueWord()
  const [DAY, PHOTO] = [m.aTitle(), m.aTitle()]
  const paths = (member: string) => {
    const dir = `people/${member}/${DIARY}`
    const aliasDir = `people/${member}/${ALIAS}`
    return { dir, aliasDir, day: `${dir}/${DAY}.md`, photo: `${dir}/${PHOTO}.png`, alias: (p: string) => aliasDir + p.slice(dir.length) }
  }
  /** vihko.yaml: the usual shared space, and the admin granted the member's folder under the other spelling. */
  const config = (n: { admin: string; member: string }) =>
    `${sharedSpace({ [n.admin]: 'manage', [n.member]: 'edit' })}  ${yamlKey(paths(n.member).aliasDir)}:\n    grants: { ${yamlKey(n.admin)}: edit }\n`

  test('a grant for a folder spelled otherwise than the disk reaches nothing of it, for reading or writing', async () => {
    assert.notEqual(ALIAS, DIARY, 'the folder name has letters with capitals')
    const h = await setup({ config, files: (n) => ({ [paths(n.member).day]: `# ${m.aHeading()}\n\n${WORD}\n`, [paths(n.member).photo]: PNG }) })
    try {
      const P = paths(h.users.member.username)
      assert.ok(existsSync(join(h.notesDir, P.alias(P.day))), 'the disk opens the other spelling')
      const q = (path: string, params: Record<string, string>) => h.url(path, params)
      const dayBefore = readFileSync(join(h.notesDir, P.day), 'utf8')

      // Reading, as a note, a file, its links or headings, or its comments.
      for (const [route, params] of [
        ['/api/note', { path: P.alias(P.day) }],
        ['/api/note/links', { path: P.alias(P.day) }],
        ['/api/note/headings', { path: P.alias(P.day) }],
        ['/api/note/comments', { path: P.alias(P.day) }],
        ['/api/file', { path: P.alias(P.photo) }],
      ] as const) {
        const r = await h.admin('GET', q(route, params))
        assert.equal(r.status, 404, `${route} ${r.text}`)
        assert.ok(!r.text.includes(WORD), r.text)
      }
      // The member, whose folder it is, reads it as the disk spells it.
      assert.equal((await h.member('GET', q('/api/note', { path: P.day }))).status, 200)

      // Writing: over it, a new note beside it, a folder in it, a note moved into it. Never
      // `exists` either: that would name the folder the disk has, which the admin doesn't see.
      const put = await h.admin('PUT', q('/api/note', { path: P.alias(P.day) }), { text: m.aSentence() }, { 'if-match': `"${contentHash(dayBefore)}"` })
      assert.equal(put.status, 404, put.text)
      const created = `${P.aliasDir}/${m.aTitle()}.md`
      const configBefore = readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8')
      for (const [what, send] of [
        ['folder', () => h.admin('POST', '/api/folder', { path: `${P.aliasDir}/${m.aFolder()}` })],
        ['create', () => h.admin('POST', '/api/note', { path: created, text: m.aSentence() })],
        ['put if-none-match', () => h.admin('PUT', q('/api/note', { path: created }), { text: m.aSentence() }, { 'if-none-match': '*' })],
      ] as const) {
        const r = await send()
        assert.equal(r.status, 404, `${what}: ${r.text}`)
        assert.ok(!r.text.includes(`/${DIARY}`), `${what}: ${r.text}`)
        // A write refused changes nothing on the disk: vihko.yaml neither (its grant stays, for a folder that may yet come).
        assert.equal(readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8'), configBefore, what)
      }
      const settings = m.aNotePath(`people/${h.users.admin.username}`)
      assert.equal((await h.admin('POST', '/api/note', { path: settings, text: m.aSentence() })).status, 201)
      const moved = await h.admin('POST', '/api/note/move', { from: settings, to: `${P.aliasDir}/${m.aTitle()}.md` })
      assert.equal(moved.status, 404, moved.text)
      assert.ok(!moved.text.includes(`/${DIARY}`), moved.text)
      assert.equal(readFileSync(join(h.notesDir, P.day), 'utf8'), dayBefore)
      assert.ok(existsSync(join(h.notesDir, settings)), 'nothing moved')

      // Told once, from the root: this folder ignores case.
      assert.equal(rootIgnoresCase(h.notesDir), true)

      // What reports another spelling (a watcher, a sync tool's rename) indexes and versions nothing under it.
      const others = [P.alias(P.day), P.alias(P.photo)]
      h.indexer.indexPaths(others, { detectMoves: true })
      h.indexer.indexFolders([P.aliasDir])
      await h.history.recorder.observePaths(others)
      await h.settle()
      const found = await h.admin('GET', q('/api/search', { q: WORD }))
      assert.deepEqual(found.body.results, [], 'nothing of the member\'s folder is searchable by the admin')
      const tree = await h.admin('GET', '/api/tree')
      assert.ok(!tree.text.includes(ALIAS) && !tree.text.includes(`/${DIARY}`), 'no folder of the member\'s, under either spelling')
      const { changes } = await h.history.reader().changes({ limit: 200, canRead: () => true })
      for (const p of others) assert.ok(!changes.some((c) => c.files.some((f) => f.path === p)), p)

      // vihko.yaml, spelled otherwise, is still nobody's.
      for (const who of ['admin', 'member'] as const) {
        assert.equal((await h.as(who)('GET', q('/api/file', { path: 'VIHKO.yaml' }))).status, 404, who)
      }
    } finally { await h.close() }
  })

  test('where someone sees the whole folder, a name taken under another spelling is `exists`, with the disk\'s spelling', async () => {
    const h = await setup({ config, files: (n) => ({ [paths(n.member).day]: `# ${m.aHeading()}\n` }) })
    try {
      const P = paths(h.users.member.username)
      const got = []
      for (const [what, r] of [
        ['note', await h.member('POST', '/api/note', { path: `${P.aliasDir}/${m.aTitle()}.md`, text: m.aSentence() })],
        ['folder', await h.member('POST', '/api/folder', { path: P.aliasDir })],
        ['subfolder', await h.member('POST', '/api/folder', { path: `${P.aliasDir}/${m.aFolder()}` })],
      ] as const) got.push([what, r.status, r.body.error, r.body.path])
      assert.deepEqual(got, [['note', 409, 'exists', P.dir], ['folder', 409, 'exists', P.dir], ['subfolder', 409, 'exists', P.dir]])
      assert.deepEqual(readdirSync(join(h.notesDir, `people/${h.users.member.username}`)), [DIARY], 'nothing made')
    } finally { await h.close() }
  })

  test('the collaboration hub opens nothing of a folder spelled otherwise', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const Y = await import('yjs')
    const { HocuspocusProvider } = await import('@hocuspocus/provider')
    const { CLI, closeAll, login, makeDirs, open, socket, startServer, waitFor } = await import('./_collab.ts')
    const { notes, env, admin } = makeDirs()
    const member = m.aUser()
    spawnSync(process.execPath, [CLI, 'user', 'create', member.username], { env: { ...process.env, ...env }, input: member.password })
    const P = paths(member.username)
    const word = m.aUniqueWord()
    mkdirSync(join(notes, P.dir), { recursive: true })
    writeFileSync(join(notes, P.day), `# ${m.aHeading()}\n\n${word}\n`)
    writeFileSync(join(notes, 'vihko.yaml'), config({ admin: admin.username, member: member.username }))
    const srv = await startServer(env)
    try {
      const cookie = await login(srv)
      const provider = new HocuspocusProvider({ websocketProvider: socket(srv, cookie), name: P.alias(P.day), document: new Y.Doc(), token: '{}' })
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
