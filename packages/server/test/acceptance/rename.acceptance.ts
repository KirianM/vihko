// M1 «done when»: you can rename without breaking links.
//
// Renames and moves over the generated vault: the most linked note (to
// another folder, taking a name another note already has), that other note,
// and a note with an NFD name. Each time, the links of the whole vault are
// resolved from the files before and after (a fresh index each time, not the
// server's), and every link must keep its state and its destination. The
// files may only change in link text (and the `uid` vihko adds when it
// writes a note). A source note is open in an editor during the move. And
// the server's own index must end up equal to a rebuild.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { classifyPath, extract, readFrontmatter, setFrontmatterKey } from '@vihko/core'
import { Indexer, dumpIndex, openIndex } from '@vihko/server'
import { api, closeAll, connect, login } from '../_collab.ts'
import { inShared } from '../_permissions.ts'
import { PASSWORD, USER, cleanup, metric, startServer, timed, waitFor, workspace, type Server, type Workspace } from './_harness.ts'

interface LinkRow { src_path: string; ord: number; raw: string; status: string; dst_path: string | null; anchor_ok: number | null; candidates: string | null }

function freshIndex(ws: Workspace, name: string) {
  const file = join(ws.root, `${name}.db`)
  for (const s of ['', '-wal', '-shm']) rmSync(file + s, { force: true })
  const db = openIndex(file)
  new Indexer({ notesDir: ws.notesDir, db }).scan()
  return db
}

/** Every link in the vault, resolved from the files: `src\0ord` → row. */
function links(ws: Workspace): Map<string, LinkRow> {
  const db = freshIndex(ws, 'links')
  const rows = db.prepare('select src_path, ord, raw, status, dst_path, anchor_ok, candidates from links').all() as LinkRow[]
  db.close()
  return new Map(rows.map((r) => [`${r.src_path}\u0000${r.ord}`, r]))
}

function notesOnDisk(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const p of readdirSync(dir, { recursive: true }).map(String).sort()) {
    const rel = p.split('\\').join('/')
    if (classifyPath(rel) === 'note') out.set(rel, readFileSync(join(dir, rel), 'utf8'))
  }
  return out
}

/** The text with every link replaced by a mark, and without the uid vihko may add. */
function withoutLinks(text: string): string {
  let out = text
  for (const l of [...extract(text).links].sort((a, b) => b.from - a.from)) out = out.slice(0, l.from) + '\u0001' + out.slice(l.to)
  return out
}

async function checkedMove(srv: Server, cookie: string, ws: Workspace, from: string, to: string, openSource: boolean) {
  const before = links(ws)
  const filesBefore = notesOnDisk(ws.notesDir)
  const map = (p: string | null) => (p === from ? to : p)
  // A note that links to the moved one, open in an editor during the move.
  const source = openSource ? [...before.values()].find((l) => l.dst_path === from && l.src_path !== from)?.src_path : undefined
  const editor = source ? await connect(srv, cookie, source) : null

  const preview = await api(srv, cookie, 'POST', '/api/note/move', { from, to, dryRun: true })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  // As the UI does it: in the background. The request answers once the note
  // is in place (or with the report, if the rewrites end within a second).
  type Report = { relinked: { path: string; links: number }[]; shifted: { path: string; links: number; changes: { raw: string; code: string; after: { status: string; path?: string } }[] }[]; failed: unknown[]; aliasAdded: string | null; kept: unknown[] }
  const t0 = performance.now()
  const res = await api(srv, cookie, 'POST', '/api/note/move', { from, to, background: true })
  const answeredMs = performance.now() - t0
  assert.ok(res.status === 200 || res.status === 202, JSON.stringify(res.body))
  let report: Report
  if (res.status === 202) {
    const id = (res.body as { job: { id: string } }).job.id
    let job: { state: string; report?: Report } = { state: 'running' }
    await waitFor(async () => (job = (await api(srv, cookie, 'GET', `/api/move-jobs/${id}`)).body as typeof job).state !== 'running', 'the move job ends', 120_000)
    assert.equal(job.state, 'done', JSON.stringify(job))
    report = job.report!
  } else report = res.body as Report
  const ms = performance.now() - t0
  const rewritten = report.relinked.reduce((n, r) => n + r.links, 0)
  metric(`move ${from} → ${to}`, ms, 'ms', { answeredMs: Math.round(answeredMs), notesRewritten: report.relinked.length, linksRewritten: rewritten, kept: report.kept.length, failed: report.failed.length })
  assert.deepEqual(report.failed, [], 'every rewrite succeeded')
  assert.equal(report.aliasAdded, null, 'no alias safety net needed')
  assert.deepEqual(report.relinked.map((r) => r.path).sort(), (preview.body as typeof report).relinked.map((r) => r.path).sort(), 'the preview announced what was done')
  assert.deepEqual(report.shifted, (preview.body as typeof report).shifted, 'the preview announced the links it resolves without rewriting them')

  if (editor && source) {
    // The open note got its links rewritten live, and the file converges.
    const rewrites = report.relinked.some((r) => r.path === source)
    const file = join(ws.notesDir, source)
    await waitFor(() => readFileSync(file, 'utf8') === editor.text() && (!rewrites || editor.text() !== filesBefore.get(source)), 'open source flushed', 15_000)
    editor.close()
    closeAll()
  }

  // 1. Every link keeps its state and destination.
  const after = links(ws)
  const problems: string[] = []
  let ambiguousChanged = 0
  // Ambiguous before, and now resolved to the moved note, which became the closest candidate.
  const nowResolved: string[] = []
  for (const b of before.values()) {
    const a = after.get(`${map(b.src_path)}\u0000${b.ord}`)
    const where = `${b.src_path} ${b.raw}`
    if (!a) { problems.push(`${where}: gone`); continue }
    if (b.status === 'ambiguous' && a.status === 'resolved' && a.dst_path === to) nowResolved.push(`${where} → ${a.raw}`)
    else if (a.status !== b.status) problems.push(`${where}: ${b.status} → ${a.status} (${a.raw})`)
    else if (b.status === 'resolved' && (a.dst_path !== map(b.dst_path) || a.anchor_ok !== b.anchor_ok)) {
      problems.push(`${where}: ${b.dst_path}#${b.anchor_ok} → ${a.dst_path}#${a.anchor_ok} (${a.raw})`)
    } else if (b.status === 'ambiguous') {
      const mapped = (JSON.parse(b.candidates!) as string[]).map(map).sort()
      if (JSON.stringify(mapped) !== JSON.stringify((JSON.parse(a.candidates!) as string[]).sort())) ambiguousChanged++
    }
  }
  if (after.size !== before.size) problems.push(`${before.size} links before, ${after.size} after`)
  if (nowResolved.length) metric(`  ambiguous links now resolved to ${to}`, nowResolved.length, 'links', { e: nowResolved.slice(0, 3) })
  // D-019: none of them was resolved silently. The report lists each one, by source note.
  const announced = report.shifted.flatMap((g) => g.changes.filter((c) => c.code === 'resolves' && c.after.path === to).map((c) => `${g.path === to ? from : g.path} ${c.raw}`)).sort()
  assert.deepEqual(announced, nowResolved.map((l) => l.slice(0, l.indexOf(' → '))).sort(), 'every ambiguous link the move resolved was announced')
  if (ambiguousChanged) metric(`  ambiguous links with other candidates after moving ${from}`, ambiguousChanged, 'links')
  assert.deepEqual(problems.slice(0, 20), [], `${problems.length} links changed state or destination`)
  const toMoved = [...after.values()].filter((l) => l.dst_path === to).length
  assert.equal(toMoved, [...before.values()].filter((l) => l.dst_path === from).length + nowResolved.length, 'every backlink follows the note')

  // 2. The files only changed in link text (and a uid, when vihko wrote them).
  const filesAfter = notesOnDisk(ws.notesDir)
  const changed: string[] = []
  for (const [path, b] of filesBefore) {
    if (path === from) continue
    const a = filesAfter.get(path)!
    if (a === b) continue
    changed.push(path)
    const uid = readFrontmatter(a).data.uid
    const expected = readFrontmatter(b).error || readFrontmatter(b).data.uid !== undefined || uid === undefined ? withoutLinks(b) : withoutLinks(setFrontmatterKey(b, 'uid', String(uid)))
    assert.equal(withoutLinks(a), expected, `${path}: only its links changed`)
  }
  assert.deepEqual(changed.sort(), report.relinked.map((r) => r.path).filter((p) => p !== to).sort(), 'the files that changed are the ones the report lists')
  assert.ok(!filesAfter.has(from) && filesAfter.has(to))
  return { ambiguousChanged, nowResolved, rewritten, ms, answeredMs }
}

test('renaming heavily linked notes keeps every link of the vault', { timeout: 300_000 }, async () => {
  const ws = workspace('rename')
  let srv: Server | null = null
  try {
    srv = await startServer(ws.env)
    const cookie = await login(srv, { username: USER, password: PASSWORD })
    const { hub, hubTarget, trap } = ws.vault
    // The hub moves to another folder, to the name the trap already has.
    const r1 = await checkedMove(srv, cookie, ws, hub, hubTarget, true)
    assert.ok(r1.rewritten > 200, `the hub is heavily linked (${r1.rewritten} links rewritten)`)
    assert.ok(r1.answeredMs < 2_000, `the note is in place and the request answers in less than 2 s (${Math.round(r1.answeredMs)} ms)`)
    assert.ok(r1.ms < 10_000, `a rename that rewrites ${r1.rewritten} links ends in less than 10 s (${Math.round(r1.ms)} ms)`)
    // The trap is renamed in place: [[Diseño]] now has to keep reaching each of the two.
    await checkedMove(srv, cookie, ws, trap, trap.replace('Diseño', 'Pantallas y colores'), true)
    // A note with a decomposed (NFD) name, to a composed one.
    const people = inShared('personas/')
    const nfd = ws.vault.notes.find((p) => p !== p.normalize('NFC') && p.startsWith(people))!
    await checkedMove(srv, cookie, ws, nfd, `${people}Contactos/` + nfd.slice(people.length).normalize('NFC'), false)

    // The server's index, updated incrementally along the way, equals a rebuild.
    const expected = (() => { const db = freshIndex(ws, 'expected'); const d = dumpIndex(db); db.close(); return d })()
    let live = ''
    try {
      await waitFor(() => {
        const db = new Database(join(ws.stateDir, 'index.db'), { readonly: true })
        try { live = dumpIndex(db) } finally { db.close() }
        return live === expected
      }, 'server index = rebuild', 20_000)
    } catch {
      const a = live.split('\n'), b = expected.split('\n')
      const diff = a.filter((l) => !b.includes(l)).slice(0, 5).concat(['---'], b.filter((l) => !a.includes(l)).slice(0, 5))
      assert.fail(`the server's index differs from a rebuild:\n${diff.join('\n')}`)
    }
  } finally {
    closeAll()
    await srv?.stop()
    cleanup(ws)
  }
})
