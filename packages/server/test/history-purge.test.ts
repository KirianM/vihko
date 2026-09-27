// `thoth history purge`, from the command line with thoth stopped: a path or
// one version's content out of the managed history, and out of the
// repository's objects; everything else as it was; the lock against a
// running server; and a purge killed half way.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Git } from '@thoth/server'
import { CLI, makeDirs, startServer } from './_collab.ts'
import { setup, who } from './_history.ts'
import { mother } from '../../../test/mother.ts'

const NOTE = 'hogar/Proxy.md'
const m = mother(import.meta.url)
/** What is purged: text nothing else in the history has. */
const SECRET = m.aSecret()
const PENDING = m.aSecret()
const OTHER_SECRET = m.aSecret()
const V1_SECRET = m.aSecret()
const M_SECRET = m.aSecret()
const SHARED_SECRET = m.aSecret()

const repo = (stateDir: string) => new Git({ gitDir: join(stateDir, 'history.git') })

/** Every object in the repository, reachable or not, with its contents. */
async function objects(stateDir: string): Promise<string> {
  return (await repo(stateDir).run(['cat-file', '--batch-all-objects', '--batch'])).stdout.toString('latin1')
}

/** The history's commits, newest first: id, author with date, message. */
async function commits(stateDir: string): Promise<{ id: string; author: string; message: string }[]> {
  const { stdout } = await repo(stateDir).run(['log', '--date=raw', '--format=%H%x1f%an <%ae> %ad%x1f%B%x1e', 'refs/heads/main'])
  return stdout.toString('utf8').split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [id, author, message] = r.split('\x1f') as [string, string, string]
    return { id, author, message }
  })
}

async function head(stateDir: string): Promise<string> {
  return (await repo(stateDir).run(['rev-parse', 'refs/heads/main'])).stdout.toString('latin1').trim()
}

function purge(env: Record<string, string>, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, 'history', 'purge', ...args], { env: { ...process.env, ...env, ...extra }, encoding: 'utf8', timeout: 120_000 })
  return { status: r.status, signal: r.signal, out: r.stdout + r.stderr }
}

const envOf = (h: { notesDir: string; stateDir: string }) => ({ THOTH_NOTES_DIR: h.notesDir, THOTH_STATE_DIR: h.stateDir })

test('purging a path: gone from every version, the journal and the repository; the rest keeps its authors, dates, trailers and moves', async () => {
  const h = await setup({ quietMs: 60_000, files: { 'secretos/clave.md': '# Clave\n' } })
  let history: unknown[]
  try {
    await h.put('secretos/clave.md', (t) => t + `${SECRET}\n`)
    await h.settle()
    await h.put(NOTE, (t) => t + '\nprimera\n')
    await h.settle()
    const v1 = (await h.versions(NOTE)).versions[0]
    await h.put(NOTE, (t) => t + 'segunda\n')
    await h.settle()
    assert.equal((await h.admin('POST', '/api/history/restore', { path: NOTE, id: v1.id })).status, 200)
    await h.settle()
    assert.equal((await h.admin('POST', '/api/note/move', { from: NOTE, to: 'infra/GW.md' })).status, 200)
    await h.settle()
    history = (await h.versions('infra/GW.md')).versions.map((v) => [v.change, v.path, v.from ?? null, who(v), v.at, v.reason?.code ?? null])
    // Still open when thoth stops: only in the journal.
    await h.put('secretos/clave.md', (t) => t + `${PENDING}\n`)
    assert.ok(readFileSync(join(h.stateDir, 'history/journal.json'), 'utf8').includes(PENDING))
  } finally { await h.close() }
  const before = await commits(h.stateDir)
  assert.ok((await objects(h.stateDir)).includes(SECRET))

  const dry = purge(envOf(h), ['secretos', '--dry-run'])
  assert.equal(dry.status, 0, dry.out)
  assert.match(dry.out, /Dry run: nothing is changed/)
  assert.match(dry.out, /created\s+secretos\/clave\.md/)
  assert.match(dry.out, /modified\s+secretos\/clave\.md/)
  assert.deepEqual(await commits(h.stateDir), before, 'a dry run changes nothing')

  const run = purge(envOf(h), ['secretos/'])
  assert.equal(run.status, 0, run.out)
  assert.match(run.out, /Removed 2 file versions of secretos in 2 commits, and rewrote \d+ commits \(1 left empty: dropped\)/)
  assert.match(run.out, /open version/)
  assert.match(run.out, /warning: secretos\/clave\.md is still in the notes folder/)

  // Nothing of it anywhere in the repository, nor in the recorder's files.
  const all = await objects(h.stateDir)
  assert.ok(!all.includes(SECRET) && !all.includes(PENDING), 'no object holds the purged content')
  assert.ok(!readFileSync(join(h.stateDir, 'history/journal.json'), 'utf8').includes(PENDING))
  assert.ok(!readFileSync(join(h.stateDir, 'history/files.json'), 'utf8').includes('secretos/'))
  const after = await commits(h.stateDir)
  const { stdout: touched } = await repo(h.stateDir).run(['log', '--format=%H', 'refs/heads/main', '--', 'secretos'])
  assert.equal(touched.toString().trim(), '', 'no version has the folder')

  // Every other commit as it was: author, date and message, with a restore pointing to the new id of its version.
  const kept = before.filter((c) => c.message.split('\n')[0] !== 'Edit secretos/clave.md')
  assert.equal(after.length, kept.length)
  const renamed = new Map(kept.map((c, i) => [c.id, after[i]!.id]))
  for (let i = 0; i < kept.length; i++) {
    assert.equal(after[i]!.author, kept[i]!.author)
    assert.equal(after[i]!.message, kept[i]!.message.replace(/\b[0-9a-f]{40}\b/g, (id) => renamed.get(id) ?? id))
  }
  const restore = after.find((c) => c.message.includes('Thoth-Restored-From'))!
  const from = /Thoth-Restored-From: ([0-9a-f]{40})/.exec(restore.message)![1]!
  assert.ok(after.some((c) => c.id === from) && !before.some((c) => c.id === from), 'the restored version is the rewritten one')

  // thoth starts again: what is still on disk isn't recorded as a change made while it was stopped.
  const again = await setup({ dir: h.dir })
  try {
    assert.equal((await again.changes()).changes.length, after.length)
    assert.deepEqual((await again.versions('infra/GW.md')).versions.map((v) => [v.change, v.path, v.from ?? null, who(v), v.at, v.reason?.code ?? null]), history!)
    const secret = await again.versions('secretos/clave.md')
    assert.deepEqual([secret.versions.length, secret.pending], [0, null])
    // Its next version brings it back, as the command warned.
    await again.put('secretos/clave.md', (t) => t + 'nueva línea\n')
    await again.settle()
    const [v] = (await again.versions('secretos/clave.md')).versions
    assert.deepEqual([v.change, who(v)], ['created', `user:${again.users.admin.username}`])
    const text = (await again.admin('GET', `/api/history/version?path=${again.q('secretos/clave.md')}&id=${v.id}`)).body.text
    assert.ok(text.includes(PENDING))
  } finally { await again.close() }
})

test('purging one version: only its content goes, from that version and wherever the file still holds it', async () => {
  const h = await setup({ files: { 'notas/n.md': 'uno\n', 'notas/m.md': 'tres\n' } })
  let n: any[]
  let m: any[]
  let total: number
  try {
    await h.put('notas/n.md', () => `uno\n${V1_SECRET}\n`)
    await h.settle()
    await h.put('notas/n.md', () => 'uno\ndos\n')
    await h.settle()
    // The last version of m.md is the one purged: the file still holds it.
    await h.put('notas/m.md', () => `tres\n${M_SECRET}\n`)
    await h.settle()
    n = (await h.versions('notas/n.md')).versions
    m = (await h.versions('notas/m.md')).versions
    total = (await h.changes()).changes.length
  } finally { await h.close() }

  const r1 = purge(envOf(h), ['notas/n.md', '--version', n[1].id.slice(0, 12)])
  assert.equal(r1.status, 0, r1.out)
  assert.match(r1.out, /Removed 1 file version of the content of notas\/n\.md in [0-9a-f]{10} in 1 commit, and rewrote 3 commits \(1 left empty: dropped\)/)
  assert.doesNotMatch(r1.out, /^warning:/m, 'what the file holds now is already a version')
  // Rewritten by the first purge: the version has another id now.
  const { stdout } = await repo(h.stateDir).run(['log', '-1', '--format=%H', 'refs/heads/main', '--', 'notas/m.md'])
  const last = stdout.toString().trim()
  assert.notEqual(last, m![0].id)
  assert.match(purge(envOf(h), ['notas/m.md', `--version=${m![0].id}`]).out, /error \(not_found\)/)
  const r2 = purge(envOf(h), ['notas/m.md', `--version=${last}`])
  assert.equal(r2.status, 0, r2.out)
  assert.match(r2.out, /warning: notas\/m\.md is still in the notes folder/)
  const all = await objects(h.stateDir)
  assert.ok(!all.includes(V1_SECRET) && !all.includes(M_SECRET))

  const again = await setup({ dir: h.dir })
  try {
    assert.equal((await again.changes()).changes.length, total! - 2, 'both commits held only that content: dropped')
    const nv = (await again.versions('notas/n.md')).versions
    assert.deepEqual(nv.map((v) => [v.change, v.at]), [[n[0].change, n[0].at], [n[2].change, n[2].at]])
    const diff = async (against: string) => (await again.admin('GET', `/api/history/diff?path=${again.q('notas/n.md')}&id=${nv[0].id}&against=${against}`)).body
    const previous = await diff('previous')
    assert.deepEqual(previous, await diff(nv[1].id), 'the next version now follows the one before the purged one')
    assert.ok(!JSON.stringify(previous.ops).includes(V1_SECRET))
    // m.md: the version before, and nothing recorded at startup for what the file still holds.
    const mv = await again.versions('notas/m.md')
    assert.deepEqual([mv.versions.length, mv.pending], [1, null])
    await again.put('notas/m.md', (t) => t + 'cuatro\n')
    await again.settle()
    const [v] = (await again.versions('notas/m.md')).versions
    assert.deepEqual([v.change, who(v)], ['modified', `user:${again.users.admin.username}`])
  } finally { await again.close() }
})

test('a purged note that was moved or copied: the report says where the same content stays, and no move trailer names it', async () => {
  const h = await setup({ files: { 'viejo.md': `# Nota\n${SHARED_SECRET}\n`, 'copia.md': `# Nota\n${SHARED_SECRET}\n` } })
  try {
    assert.equal((await h.admin('POST', '/api/note/move', { from: 'viejo.md', to: 'nuevo.md' })).status, 200)
    await h.settle()
  } finally { await h.close() }
  const moves = async () => (await commits(h.stateDir)).flatMap((c) => c.message.split('\n').filter((l) => l.startsWith('Thoth-Move:')))
  assert.deepEqual(await moves(), ['Thoth-Move: viejo.md\tnuevo.md'])
  const r = purge(envOf(h), ['nuevo.md'])
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /^note: before a move, it was viejo\.md/m)
  assert.deepEqual(await moves(), [], 'the move to a path that is gone')
  // The copy has the same content as viejo.md had before the move.
  const copy = purge(envOf(h), ['copia.md'])
  assert.equal(copy.status, 0, copy.out)
  assert.match(copy.out, /^warning: the same content is also in the history under viejo\.md; it stays stored there/m)
  assert.ok((await objects(h.stateDir)).includes(SHARED_SECRET), 'still stored under the other path, as reported')
})

test('the purge refuses while thoth runs (and a second server refuses too), in unmanaged mode, and with bad input; a kill -9 frees the lock', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    // Listening comes after the history started.
    const running = purge(env, [NOTE])
    assert.equal(running.status, 1, running.out)
    assert.match(running.out, /error \(state_in_use\)/)
    assert.equal(purge(env, [NOTE, '--dry-run']).status, 0, 'a dry run only reads: it works with thoth running')
    const second = spawnSync(process.execPath, [CLI, 'serve'], { env: { ...process.env, ...env, THOTH_PORT: String(Number(env.THOTH_PORT) + 1) }, encoding: 'utf8', timeout: 30_000 })
    assert.equal(second.status, 1, second.stdout + second.stderr)
    assert.match(second.stderr, /state_in_use/)
  } finally { await srv.stop('SIGKILL') }

  writeFileSync(join(notes, 'thoth.yaml'), 'history:\n  mode: unmanaged\n')
  const unmanaged = purge(env, [NOTE])
  assert.equal(unmanaged.status, 1)
  assert.match(unmanaged.out, /error \(history_unmanaged\)/)
  rmSync(join(notes, 'thoth.yaml'))

  for (const [args, code] of [
    [['--version', '--output=/tmp/x', NOTE], 'invalid_version'],
    [['../fuera.md'], 'invalid_path'],
    [['/etc/passwd'], 'invalid_path'],
    [[NOTE, '--version', 'abcdef1234'], 'not_found'],
  ] as const) {
    const r = purge(env, [...args])
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, new RegExp(`error \\(${code}\\)`), r.out)
  }
  assert.equal(purge(env, []).status, 2)
  assert.equal(purge(env, [NOTE, 'otra.md']).status, 2)
  const id = (await commits(env.THOTH_STATE_DIR)).at(-1)!.id
  const other = purge(env, ['no-existe.md', '--version', id])
  assert.match(other.out, /error \(not_a_version\)/)

  // After the kill -9 the lock is free: the purge runs.
  const ok = purge(env, [NOTE])
  assert.equal(ok.status, 0, ok.out)
})

test('what a crash left in the repository goes before a purge: fast-import\'s keep mark would keep what it purges, and a stale lock would fail it', async () => {
  const h = await setup({ files: { 'secretos/clave.md': `# Clave\n${SECRET}\n`, 'otro/clave.md': `# Otra\n${OTHER_SECRET}\n` } })
  await h.close()
  const env = envOf(h)
  const gitDir = join(h.stateDir, 'history.git')
  // Everything in one pack, with the mark fast-import leaves when it is killed before moving the refs.
  await repo(h.stateDir).run(['repack', '-a', '-d', '-q'])
  const pack = readdirSync(join(gitDir, 'objects/pack')).find((f) => f.endsWith('.pack'))!
  const keep = `objects/pack/${pack.replace(/\.pack$/, '.keep')}`
  writeFileSync(join(gitDir, keep), 'fast-import\n')
  const first = purge(env, ['secretos'])
  assert.equal(first.status, 0, first.out)
  assert.ok(!(await objects(h.stateDir)).includes(SECRET), 'no pack keeps what was purged')
  assert.ok(first.out.includes(`note: removed the keep mark of a fast-import left by a crash: ${keep}\n`), first.out)

  // The locks a kill -9 leaves in the middle of a commit.
  writeFileSync(join(gitDir, 'refs/heads/main.lock'), `${await head(h.stateDir)}\n`)
  writeFileSync(join(gitDir, 'HEAD.lock'), 'ref: refs/heads/main\n')
  const second = purge(env, ['otro'])
  assert.equal(second.status, 0, second.out)
  assert.match(second.out, /^note: removed a stale git lock left by a crash: refs\/heads\/main\.lock$/m)
  assert.match(second.out, /^note: removed a stale git lock left by a crash: HEAD\.lock$/m)
  assert.ok(!(await objects(h.stateDir)).includes(OTHER_SECRET))
  // A dry run may run next to thoth: it touches nothing.
  writeFileSync(join(gitDir, 'packed-refs.lock'), '')
  assert.equal(purge(env, [NOTE, '--dry-run']).status, 0)
  assert.ok(existsSync(join(gitDir, 'packed-refs.lock')))
})

test('a purge killed half way leaves the history as it was, or finished but not compacted; running it again completes it', async () => {
  const h = await setup({ files: { 'secretos/clave.md': `# Clave\n${SECRET}\n` } })
  try {
    for (let i = 0; i < 3; i++) {
      await h.put(NOTE, (t) => t + `línea ${i}\n`)
      await h.settle()
    }
  } finally { await h.close() }
  const env = envOf(h)
  const original = await head(h.stateDir)
  for (const point of ['purge-importing', 'purge-imported']) {
    const r = purge(env, ['secretos'], { THOTH_TEST_CRASH_AT: point })
    assert.equal(r.signal, 'SIGKILL', `${point}: ${r.out}`)
    assert.equal(await head(h.stateDir), original, `${point}: the history as it was`)
    assert.ok((await objects(h.stateDir)).includes(SECRET))
  }
  const moved = purge(env, ['secretos'], { THOTH_TEST_CRASH_AT: 'purge-moved' })
  assert.equal(moved.signal, 'SIGKILL', moved.out)
  assert.notEqual(await head(h.stateDir), original, 'the history moved in one step')
  assert.ok((await objects(h.stateDir)).includes(SECRET), 'but it was not compacted yet')
  const rewritten = await commits(h.stateDir)

  const again = purge(env, ['secretos'])
  assert.equal(again.status, 0, again.out)
  assert.match(again.out, /Nothing of secretos is in the history/)
  assert.deepEqual(await commits(h.stateDir), rewritten)
  assert.ok(!(await objects(h.stateDir)).includes(SECRET), 'compacted')
  assert.equal(rewritten.length, 4)
})
