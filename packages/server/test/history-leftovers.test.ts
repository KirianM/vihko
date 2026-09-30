// What a git command killed half way leaves in the managed repository, and
// how the history comes back from it: removed at startup (the state volume
// locked, before any git command), and what the journal held reaches git,
// once. The kill in the middle of a real commit is in history-hub.test.ts
// (`history-importing`), the purge's side in history-purge.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { Git, removeCrashLeftovers } from '@vihko/server'
import { flakyGit, setup, who } from './_history.ts'
import { inShared } from './_permissions.ts'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
// A note of the fixed vault the setup copies (testdata/vault) into the shared space. The files a
// crash leaves in the repository are git's own names: they are the case.
const NOTE = inShared('hogar/Proxy.md')

test('what a crash leaves in the repository is removed, and nothing else: locks anywhere, fast-import\'s keep mark, temporary files, incomplete packs, crash reports, a dead gc\'s gc.pid', async () => {
  const h = await setup()
  await h.close()
  const gitDir = join(h.stateDir, 'history.git')
  const git = new Git({ gitDir })
  await git.run(['repack', '-a', '-d', '-q'])
  const packDir = join(gitDir, 'objects/pack')
  const pack = readdirSync(packDir).find((f) => f.endsWith('.pack'))!.replace(/\.pack$/, '')
  const put = (path: string, content = '') => {
    mkdirSync(join(gitDir, path, '..'), { recursive: true })
    writeFileSync(join(gitDir, path), content)
  }
  const expected: Record<string, string> = {
    'refs/heads/main.lock': 'lock',
    'refs/heads/sub/nested.lock': 'lock',
    'HEAD.lock': 'lock',
    'packed-refs.lock': 'lock',
    'config.lock': 'lock',
    'shallow.lock': 'lock',
    'index.lock': 'lock',
    'objects/info/commit-graph.lock': 'lock',
    'objects/pack/tmp_pack_Ab12Cd': 'temporary',
    'objects/pack/tmp_idx_Ab12Cd': 'temporary',
    'objects/pack/.tmp-4242-pack-0123abcd.pack': 'temporary',
    'objects/ab/tmp_obj_Zz9yX8': 'temporary',
    'objects/pack/pack-0123abcd.pack': 'incomplete_pack',
    'objects/pack/pack-0123abcd.rev': 'incomplete_pack',
    'fast_import_crash_4242': 'crash_report',
    'gc.pid': 'gc_pid',
  }
  for (const path of Object.keys(expected)) put(path, path === 'gc.pid' ? `999999999 ${hostname()}` : 'x')
  // A keep mark that isn't fast-import's is someone's decision: it stays.
  put(`objects/pack/${pack}.keep`, `${m.aSentence()}\n`)
  const logs: string[] = []
  const removed = removeCrashLeftovers(gitDir, (m) => logs.push(m))
  assert.deepEqual(Object.fromEntries(removed.map((l) => [l.path, l.kind]).sort()), Object.fromEntries(Object.entries(expected).sort()))
  for (const path of Object.keys(expected)) assert.ok(!existsSync(join(gitDir, path)), path)
  assert.ok(logs.includes('history: removed a stale git lock left by a crash: refs/heads/main.lock'), logs.join('\n'))
  assert.ok(existsSync(join(packDir, `${pack}.keep`)))
  // fast-import's own mark (what it leaves when killed before it moves the refs) goes.
  put(`objects/pack/${pack}.keep`, 'fast-import\n')
  assert.deepEqual(removeCrashLeftovers(gitDir), [{ path: `objects/pack/${pack}.keep`, kind: 'keep' }])
  // The repository itself is untouched, and whole.
  assert.ok(existsSync(join(packDir, `${pack}.pack`)) && existsSync(join(packDir, `${pack}.idx`)))
  await git.run(['fsck', '--no-dangling', '--no-progress'])
  assert.deepEqual(removeCrashLeftovers(gitDir), [], 'nothing left the second time')
  assert.deepEqual(removeCrashLeftovers(join(h.stateDir, 'no-repository')), [])
})

test('while a git gc that outlived vihko still runs, its locks are its own: nothing is removed until it ends', async () => {
  const h = await setup()
  await h.close()
  const gitDir = join(h.stateDir, 'history.git')
  // Any git process alive on this host stands for the gc gc.pid names.
  const gc = spawn('git', ['--git-dir', gitDir, 'cat-file', '--batch'], { stdio: ['pipe', 'ignore', 'ignore'] })
  try {
    writeFileSync(join(gitDir, 'gc.pid'), `${gc.pid} ${hostname()}`)
    writeFileSync(join(gitDir, 'packed-refs.lock'), '')
    const logs: string[] = []
    assert.deepEqual(removeCrashLeftovers(gitDir, (m) => logs.push(m)), [])
    assert.ok(existsSync(join(gitDir, 'packed-refs.lock')))
    assert.match(logs.join('\n'), new RegExp(`a git gc \\(pid ${gc.pid}\\) is still running`))
  } finally {
    const exited = new Promise((r) => gc.once('exit', r))
    gc.kill('SIGKILL')
    await exited
  }
  assert.deepEqual(removeCrashLeftovers(gitDir).map((l) => l.path).sort(), ['gc.pid', 'packed-refs.lock'])
})

test('stale locks from a kill -9 before startup (main.lock, index.lock, HEAD.lock): the history is available, and what the journal held reaches git once, with its authors', async () => {
  const dir = tempDir('vihko-git-')
  const { git, flag } = flakyGit(dir)
  // Long quiet time: the member's version is still open when vihko stops.
  const h = await setup({ git, quietMs: 60_000 })
  const [QUEUED, OPEN] = [m.aUniqueWord(), m.aUniqueWord()]
  let total: number
  try {
    total = (await h.changes()).changes.length
    // Git fails: the admin's version waits in the queue…
    writeFileSync(flag, '')
    await h.put(NOTE, (t) => t + `\n${QUEUED}\n`)
    h.history.recorder.closeAll()
    await h.history.recorder.settle()
    assert.equal((await h.admin('GET', '/api/history/status')).body.available, false)
    // …and the member's is open.
    await h.put(inShared('tags.md'), (t) => t + `${OPEN}\n`, 'member')
  } finally { await h.close() }
  const journal = readFileSync(join(h.stateDir, 'history/journal.json'), 'utf8')
  assert.ok(journal.includes(QUEUED) && journal.includes(OPEN), 'both in the journal')
  // What a kill -9 in the middle of a commit leaves behind.
  const gitDir = join(h.stateDir, 'history.git')
  const head = readFileSync(join(gitDir, 'refs/heads/main'), 'utf8')
  writeFileSync(join(gitDir, 'refs/heads/main.lock'), head)
  writeFileSync(join(gitDir, 'HEAD.lock'), 'ref: refs/heads/main\n')
  writeFileSync(join(gitDir, 'index.lock'), '')

  const again = await setup({ dir: h.dir })
  try {
    await again.settle()
    assert.deepEqual((await again.admin('GET', '/api/history/status')).body, { mode: 'managed', available: true, error: null })
    assert.ok(!(await again.admin('GET', '/api/alerts')).body.alerts.some((a: any) => a.code === 'history_unavailable'))
    const note = (await again.versions(NOTE)).versions
    assert.deepEqual(note.map(who), [`user:${again.users.admin.username}`, 'system'])
    assert.ok((await again.admin('GET', `/api/history/version?path=${again.q(NOTE)}&id=${note[0].id}`)).body.text.includes(QUEUED))
    const tags = (await again.versions(inShared('tags.md'))).versions
    assert.deepEqual(tags.map((v: any) => [who(v), v.foundAtStartup]), [[`user:${again.users.member.username}`, false], ['system', false]])
    assert.equal((await again.changes()).changes.length, total! + 2, 'each version once')
    for (const f of ['refs/heads/main.lock', 'HEAD.lock', 'index.lock']) {
      assert.ok(!existsSync(join(gitDir, f)), f)
      assert.ok(again.logs.includes(`history: removed a stale git lock left by a crash: ${f}`), again.logs.join('\n'))
    }
  } finally { await again.close() }
})
