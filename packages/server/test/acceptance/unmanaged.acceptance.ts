// M2, unmanaged mode: the generated 1,000-note vault as the user's own git
// repository, with a long history (commits by three people, a third of them
// on one note, and renames), read through the API of the real server. What
// it costs on this disk (ACCEPTANCE_DIR on NFS measures NFS): starting, a
// note's versions (one edited often, and one only created, whose whole
// history git walks), a renamed note, «Recent changes» page after page, a
// diff; and a restore that leaves the repository byte for byte as it was.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { api, login } from '../_collab.ts'
import { AUTHOR, CO_AUTHOR, snapshot, userGit } from '../_userGit.ts'
import { mother } from '../../../../test/mother.ts'
import { rng } from './_vault.ts'
import { NOTES, PASSWORD, SEED, USER, cleanup, metric, startServer, timed, workspace, type Server } from './_harness.ts'

const COMMITS = Number(process.env.ACCEPTANCE_GIT_COMMITS ?? 2000)
const m = mother(import.meta.url)
/** A third author of the user's commits. */
const THIRD_AUTHOR = { name: m.aDisplayName(), email: m.anEmail() }
const q = encodeURIComponent

test(`unmanaged history over ${NOTES} notes and ${COMMITS} commits of the user's own git`, { timeout: 600_000 }, async () => {
  const ws = workspace('unmanaged')
  let srv: Server | null = null
  try {
    // Their repository: the vault, then their commits (fast-import: one pack, as after a gc).
    writeFileSync(join(ws.notesDir, 'vihko.yaml'), 'history:\n  mode: unmanaged\n')
    const repo = userGit(ws.notesDir)
    const r = rng(SEED)
    const files = readdirSync(ws.notesDir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && !relative(ws.notesDir, e.parentPath).split('/').includes('.git'))
      .map((e) => relative(ws.notesDir, join(e.parentPath, e.name)))
    const text = new Map(files.map((f) => [f, readFileSync(join(ws.notesDir, f))]))
    const editable = [...ws.vault.editable]
    const hot = editable.shift()!
    const untouched = ws.vault.notes.find((n) => !ws.vault.editable.includes(n) && n !== ws.vault.hub)!
    const quote = (p: string) => '"' + p.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    const parts: Buffer[] = []
    let clock = Date.parse('2024-01-01T00:00:00Z') / 1000
    const commit = (who: { name: string; email: string }, message: string) => {
      clock += 3600
      parts.push(Buffer.from(`commit refs/heads/main\nauthor ${who.name} <${who.email}> ${clock} +0000\ncommitter ${who.name} <${who.email}> ${clock} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`))
    }
    const write = (path: string, bytes: Buffer) => parts.push(Buffer.from(`M 100644 inline ${quote(path)}\ndata ${bytes.length}\n`), bytes, Buffer.from('\n'))
    commit(AUTHOR, 'Initial')
    for (const f of files) write(f, text.get(f)!)
    parts.push(Buffer.from('\n'))
    let hotVersions = 1
    const renamed: { from: string; to: string }[] = []
    for (let i = 1; i <= COMMITS; i++) {
      const who = r.pick([AUTHOR, CO_AUTHOR, THIRD_AUTHOR])
      if (i % 100 === 0) {
        const from = editable.splice(r.int(editable.length), 1)[0]!
        const to = from.replace(/\.md$/, ` (movida ${i}).md`)
        commit(who, `Rename ${i}`)
        parts.push(Buffer.from(`R ${quote(from)} ${quote(to)}\n\n`))
        text.set(to, text.get(from)!)
        editable.push(to)
        renamed.push({ from, to })
        continue
      }
      const touched = new Set<string>()
      if (r.chance(0.33)) touched.add(hot)
      const k = 1 + r.int(3)
      while (touched.size < k) touched.add(r.pick(editable))
      if (touched.has(hot)) hotVersions++
      commit(who, `Edit ${i}`)
      for (const f of touched) {
        const b = Buffer.concat([text.get(f)!, Buffer.from(`\nlínea ${i} de ${who.name}\n`)])
        text.set(f, b)
        write(f, b)
      }
      parts.push(Buffer.from('\n'))
    }
    const [, importMs] = await timed(async () => repo.run(['fast-import', '--quiet'], {}, Buffer.concat(parts)))
    // The work tree as the last commit left the notes this test reads.
    writeFileSync(join(ws.notesDir, hot), text.get(hot)!)
    const head = repo.head()
    const before = snapshot(join(ws.notesDir, '.git'))
    metric('unmanaged: user repository imported', importMs, 'ms', { commits: COMMITS + 1, files: files.length })

    srv = await startServer(ws.env)
    const cookie = await login(srv, { username: USER, password: PASSWORD })
    metric('unmanaged: cold start', srv.listeningMs, 'ms')
    assert.deepEqual((await api(srv, cookie, 'GET', '/api/history/status')).body, { mode: 'unmanaged', available: true, error: null })
    const get = async (path: string) => {
      const res = await api(srv!, cookie, 'GET', path)
      assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.body)}`)
      return res.body
    }
    const within = (ms: number, what: string) => assert.ok(ms < 10_000, `${what} took ${Math.round(ms)} ms`)

    // A note edited in a third of the commits: page after page.
    const [p1, p1Ms] = await timed(() => get(`/api/history/versions?path=${q(hot)}&limit=50`))
    const [p2, p2Ms] = await timed(() => get(`/api/history/versions?path=${q(hot)}&limit=50&cursor=${p1.next}`))
    assert.equal(p1.versions.length, 50)
    assert.equal(new Set([...p1.versions, ...p2.versions].map((v: any) => v.id)).size, p1.versions.length + p2.versions.length)
    assert.ok(p1.versions.every((v: any) => v.authors[0].kind === 'git'))
    metric('unmanaged: versions of a busy note, first page', p1Ms, 'ms', { secondPageMs: Math.round(p2Ms), versions: hotVersions })
    within(p1Ms, 'versions p1')

    // A note only created: git walks the whole history to answer.
    const [whole, wholeMs] = await timed(() => get(`/api/history/versions?path=${q(untouched)}&limit=50`))
    assert.deepEqual(whole.versions.map((v: any) => v.change), ['created'])
    metric('unmanaged: versions of a note never edited (the whole history walked)', wholeMs, 'ms', { commits: COMMITS + 1 })
    within(wholeMs, 'the whole walk')

    // A renamed note: its versions go on past the move.
    const moved = renamed.at(-1)!
    const mv = await get(`/api/history/versions?path=${q(moved.to)}&limit=200`)
    const at = mv.versions.findIndex((v: any) => v.change === 'moved')
    assert.ok(at >= 0 && mv.versions[at].from === moved.from && at < mv.versions.length - 1 && mv.versions.at(-1).change === 'created', JSON.stringify(mv.versions.map((v: any) => [v.change, v.path])))

    // «Recent changes», five pages.
    const pages: number[] = []
    let cursor: string | null = null
    const seen = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const [page, ms] = await timed(() => get(`/api/history/changes?limit=50${cursor ? `&cursor=${cursor}` : ''}`))
      for (const c of page.changes) seen.add(c.id)
      pages.push(ms)
      cursor = page.next
    }
    assert.equal(seen.size, 250)
    metric('unmanaged: recent changes, first page', pages[0]!, 'ms', { pages2to5Ms: pages.slice(1).map(Math.round) })
    for (const ms of pages) within(ms, 'a page of changes')

    const [, diffMs] = await timed(() => get(`/api/history/diff?path=${q(hot)}&id=${p1.versions[0].id}`))
    metric('unmanaged: diff of a version', diffMs, 'ms')

    // Undone: the version at the end of the first page comes back, uncommitted for their git.
    const target = p1.versions.at(-1)
    const lastLine = async (id: string) => (await get(`/api/history/version?path=${q(hot)}&id=${id}`)).text.trimEnd().split('\n').at(-1) as string
    const [older, newest] = [await lastLine(target.id), await lastLine(p1.versions[0].id)]
    const res = await api(srv, cookie, 'POST', '/api/history/restore', { path: hot, id: target.id })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const restored = readFileSync(join(ws.notesDir, hot), 'utf8')
    assert.ok(restored.trimEnd().endsWith(older) && !restored.includes(newest), 'back to that version')
    assert.equal(repo.head(), head)
    assert.deepEqual(snapshot(join(ws.notesDir, '.git')), before, 'vihko never writes to their repository')
  } finally {
    await srv?.stop()
    cleanup(ws)
  }
})
