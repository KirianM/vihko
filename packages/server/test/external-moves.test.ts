// Notes moved outside thoth (D-031.4): the alert, which follows the files,
// and «Update links», which runs the same rewrites as a thoth move. Nothing
// is rewritten on its own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Auth, ExternalMoves, Indexer, NoteService, Profiles, Watcher, Workspace, createApp, openIndex, openState, type Runtime } from '@thoth/server'
import { tempDir } from './_tmp.ts'

const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))

// --- The alert and «Update links» ------------------------------------------------

async function app(opts: { moveWaitMs?: number } = {}) {
  const dir = tempDir('thoth-xmove-app-')
  const notesDir = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  cpSync(VAULT, notesDir, { recursive: true })
  const index = openIndex(join(dir, 'index.db'))
  const state = openState(join(dir, 'state.db'))
  const auth = new Auth(state)
  const indexer = new Indexer({ notesDir, db: index })
  const externalMoves = new ExternalMoves({ stateDir, db: index, indexer })
  indexer.onMoves = (m) => externalMoves.record(m)
  const runtime: Runtime = { lastScan: null, rescan(o) { return (this.lastScan = indexer.scan(o)) } }
  const notes = new NoteService({ notesDir, stateDir, indexer, db: index })
  const a = createApp({ auth, profiles: new Profiles(state), workspace: new Workspace({ notesDir }), notes, index, indexer, notesDir, runtime, externalMoves, moveWaitMs: opts.moveWaitMs })
  await auth.createUser('noa', 'a-long-password', 'admin')
  runtime.rescan({})
  const login = await a.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'noa', password: 'a-long-password' }) })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await a.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json().catch(() => null) as any }
  }
  const moved = async () => ((await call('GET', '/api/alerts')).body.alerts as { code: string }[]).filter((x) => x.code === 'external_move') as any[]
  const read = (p: string) => readFileSync(join(notesDir, p), 'utf8')
  const dst = (src: string, raw: string) => (index.prepare('select status, dst_path from links where src_path = ? and raw = ?').get(src, raw) as { status: string; dst_path: string | null } | undefined)
  return { dir, notesDir, stateDir, index, indexer, runtime, externalMoves, notes, call, moved, read, dst }
}

test('the alert: which note moved where and how many links it left behind; nothing is rewritten on its own', async () => {
  const { notesDir, runtime, moved, read } = await app()
  const before = read('hogar/enlaces.md')
  renameSync(join(notesDir, 'hogar/Proxy.md'), join(notesDir, 'hogar/Hipervisor.md'))
  runtime.rescan({})
  const alerts = await moved()
  assert.equal(alerts.length, 1)
  assert.deepEqual(alerts[0].moves, [{ from: 'hogar/Proxy.md', to: 'hogar/Hipervisor.md' }])
  assert.deepEqual(alerts[0].actions, ['update_links'])
  // In hogar/enlaces.md: [[Proxy#Red]], [[Proxy#No existe]] and the Markdown one ([[gw]] still resolves by alias).
  assert.equal(alerts[0].links, 3)
  assert.equal(read('hogar/enlaces.md'), before, 'no link rewritten without asking')
})

test('«Update links»: preview, then the rewrite as a move would do it; no file moves and the alert goes', async () => {
  const { notesDir, runtime, moved, read, call, dst } = await app()
  renameSync(join(notesDir, 'hogar/Proxy.md'), join(notesDir, 'hogar/Hipervisor.md'))
  runtime.rescan({})
  const [alert] = await moved()
  const preview = await call('POST', `/api/external-moves/${alert.id}/relink`, { dryRun: true })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.dryRun, true)
  const changes = preview.body.relinked.flatMap((r: { changes: { before: string; after: string }[] }) => r.changes.map((x) => `${x.before} → ${x.after}`)).sort()
  assert.deepEqual(changes, [
    '[Proxy en Markdown](Proxy.md) → [Proxy en Markdown](Hipervisor.md)',
    '[[Proxy#No existe]] → [[Hipervisor#No existe]]',
    '[[Proxy#Red]] → [[Hipervisor#Red]]',
  ])
  assert.ok(read('hogar/enlaces.md').includes('[[Proxy#Red]]'), 'the preview writes nothing')

  const done = await call('POST', `/api/external-moves/${alert.id}/relink`, {})
  assert.equal(done.status, 200)
  assert.deepEqual(done.body.failed, [])
  const t = read('hogar/enlaces.md')
  assert.ok(t.includes('[[Hipervisor#Red]]') && t.includes('[Proxy en Markdown](Hipervisor.md)') && t.includes('[[gw]]'))
  assert.equal(dst('hogar/enlaces.md', '[[Hipervisor#Red]]')?.dst_path, 'hogar/Hipervisor.md')
  assert.ok(existsSync(join(notesDir, 'hogar/Hipervisor.md')) && !existsSync(join(notesDir, 'hogar/Proxy.md')), 'no file moved')
  assert.deepEqual(await moved(), [])
  assert.equal((await call('POST', `/api/external-moves/${alert.id}/relink`, {})).status, 404)
})

test("the moved note's own relative links are updated too, and its images only if they stayed", async () => {
  const { notesDir, runtime, moved, read, call } = await app()
  mkdirSync(join(notesDir, 'ux'))
  writeFileSync(join(notesDir, 'ux/propia.md'), '# Propia\n\n[la red](../hogar/Red.md) y ![img](../adjuntos/imagen.png) ![foto](foto.png)\n')
  writeFileSync(join(notesDir, 'ux/foto.png'), 'not really a png')
  runtime.rescan({})
  // The other tool moves the note and, with it, its picture.
  mkdirSync(join(notesDir, 'ux/sub'))
  renameSync(join(notesDir, 'ux/propia.md'), join(notesDir, 'ux/sub/propia.md'))
  renameSync(join(notesDir, 'ux/foto.png'), join(notesDir, 'ux/sub/foto.png'))
  runtime.rescan({})
  const [alert] = await moved()
  assert.equal(alert.links, 1, 'its own link no longer reaches Red')
  await call('POST', `/api/external-moves/${alert.id}/relink`, {})
  assert.ok(read('ux/sub/propia.md').endsWith('# Propia\n\n[la red](../../hogar/Red.md) y ![img](../../adjuntos/imagen.png) ![foto](foto.png)\n'))
})

test('the count follows the files: the other tool rewriting the links makes the alert go away', async () => {
  const { notesDir, runtime, moved, read } = await app()
  renameSync(join(notesDir, 'hogar/Proxy.md'), join(notesDir, 'hogar/Hipervisor.md'))
  runtime.rescan({})
  assert.equal((await moved())[0].links, 3)
  // The other tool fixes some links…
  writeFileSync(join(notesDir, 'hogar/enlaces.md'), read('hogar/enlaces.md').replace('[[Proxy#Red]]', '[[Hipervisor#Red]]').replace('(Proxy.md)', '(Hipervisor.md)'))
  runtime.rescan({})
  assert.equal((await moved())[0].links, 1)
  // …then the rest.
  writeFileSync(join(notesDir, 'hogar/enlaces.md'), read('hogar/enlaces.md').replaceAll('[[Proxy', '[[Hipervisor'))
  runtime.rescan({})
  assert.deepEqual(await moved(), [])
})

test('moving on, moving back, deleting: the pending move follows the note or goes', async () => {
  const { notesDir, runtime, moved } = await app()
  const mv = (a: string, b: string) => { renameSync(join(notesDir, a), join(notesDir, b)); runtime.rescan({}) }
  mv('hogar/Proxy.md', 'hogar/GW.md')
  mv('hogar/GW.md', 'hogar/Hipervisor.md')
  let alerts = await moved()
  assert.deepEqual(alerts.map((a) => a.moves), [[{ from: 'hogar/Proxy.md', to: 'hogar/Hipervisor.md' }]], 'a → b → c is a → c (nothing links to b)')
  mv('hogar/Hipervisor.md', 'hogar/Proxy.md')
  assert.deepEqual(await moved(), [], 'back where it was')
  mv('hogar/Proxy.md', 'hogar/Hipervisor.md')
  assert.equal((await moved()).length, 1)
  rmSync(join(notesDir, 'hogar/Hipervisor.md'))
  runtime.rescan({})
  alerts = await moved()
  assert.deepEqual(alerts, [], 'deleted: nothing to update')
})

test('pending moves survive a restart (state volume), and a group of moves is one alert', async () => {
  const { notesDir, stateDir, index, indexer, runtime, moved } = await app()
  renameSync(join(notesDir, 'proyectos'), join(notesDir, 'trabajo'))
  runtime.rescan({})
  const [alert] = await moved()
  assert.ok(alert.moves.length >= 5)
  assert.ok(alert.moves.every((m: { from: string; to: string }) => m.from.startsWith('proyectos/') && m.to === 'trabajo/' + m.from.slice('proyectos/'.length)))
  const again = new ExternalMoves({ stateDir, db: index, indexer })
  assert.deepEqual(again.pending().map((p) => p.id), [alert.id])
})

test('«Update links» in the background: a job, then the report', async () => {
  const { notesDir, runtime, moved, call, read } = await app({ moveWaitMs: 0 })
  renameSync(join(notesDir, 'hogar/Proxy.md'), join(notesDir, 'hogar/Hipervisor.md'))
  runtime.rescan({})
  const [alert] = await moved()
  const r = await call('POST', `/api/external-moves/${alert.id}/relink`, { background: true })
  let report = r.body
  if (r.status === 202) {
    assert.equal(r.body.job.kind, 'relink')
    for (let i = 0; i < 100; i++) {
      const j = await call('GET', `/api/move-jobs/${r.body.job.id}`)
      if (j.body.state === 'done') { report = j.body.report; break }
      await new Promise((ok) => setTimeout(ok, 20))
    }
  }
  assert.deepEqual(report.failed, [])
  assert.ok(read('hogar/enlaces.md').includes('[[Hipervisor#Red]]'))
  assert.deepEqual(await moved(), [])
})

test('the watcher: a note renamed on disk raises the alert', async () => {
  const { notesDir, index, indexer, moved } = await app()
  const w = new Watcher({ notesDir, indexer, db: index, debounceMs: 50, rescanMs: 60_000 })
  w.start()
  try {
    renameSync(join(notesDir, 'hogar/Red.md'), join(notesDir, 'hogar/Redes.md'))
    const start = Date.now()
    while ((await moved()).length === 0) {
      if (Date.now() - start > 5000) throw new Error('timeout: no alert')
      await new Promise((ok) => setTimeout(ok, 50))
    }
    assert.deepEqual((await moved())[0].moves, [{ from: 'hogar/Red.md', to: 'hogar/Redes.md' }])
  } finally {
    w.stop()
  }
})
