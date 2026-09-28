// M1 «done when»: a change made with another editor shows up live.
//
// Notes open in editors (live documents) are changed by writing their files
// directly, the two ways editors save: a new file renamed over the old one,
// and a rewrite in place. The change must reach the editor, exactly, and
// stay. Also with someone typing in the note at that moment, and for a
// closed note (it must be findable).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { api, closeAll, connect, login, socket, typeLine } from '../_collab.ts'
import { PASSWORD, USER, cleanup, metric, percentile, sleep, startServer, waitFor, workspace, type Server } from './_harness.ts'

function saveAtomically(file: string, text: string) {
  const tmp = join(dirname(file), `.${basename(file)}.ext-${process.pid}`)
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

test('changes made with another editor show up live', { timeout: 300_000 }, async () => {
  const ws = workspace('external')
  let srv: Server | null = null
  try {
    srv = await startServer(ws.env)
    const cookie = await login(srv, { username: USER, password: PASSWORD })
    const shared = socket(srv, cookie) // one WebSocket for every open note, as the web UI does
    const notes = ws.vault.editable.slice(0, 12)
    const editors = await Promise.all(notes.map((p) => connect(srv!, cookie, p, shared)))
    const latency: number[] = []

    // 1. One change per note, alternating how the file is saved.
    for (const [i, path] of notes.entries()) {
      const file = join(ws.notesDir, path)
      const editor = editors[i]!
      const current = readFileSync(file, 'utf8')
      const changed = current.replace(/^# (.*)$/m, (_, t: string) => `# ${t} (edited outside ${i})`) + `\nEXTERNAL-${i}\n`
      const t0 = performance.now()
      if (i % 2 === 0) saveAtomically(file, changed)
      else writeFileSync(file, changed)
      await waitFor(() => editor.text() === changed, `${path}: the change reaches the editor exactly`, 10_000)
      latency.push(performance.now() - t0)
    }
    metric('external change → open editor p50', percentile(latency, 50), 'ms', { p95: Math.round(percentile(latency, 95)), max: Math.round(Math.max(...latency)), notes: latency.length })
    await sleep(2500) // several flush periods: nothing flushed back may undo or duplicate it
    for (const [i, path] of notes.entries()) {
      const text = readFileSync(join(ws.notesDir, path), 'utf8')
      assert.equal(editors[i]!.text(), text, `${path}: editor and file agree`)
      assert.equal(text.split('\n').filter((l) => l === `EXTERNAL-${i}`).length, 1, `${path}: once`)
    }

    // 2. Someone types while another editor saves over an older version of the note.
    const busy = editors[0]!
    const file = join(ws.notesDir, notes[0]!)
    const typed: string[] = []
    let stop = false
    const typing = (async () => {
      for (let n = 0; !stop; n++) { typeLine(busy, `TYPED-${n}`); typed.push(`TYPED-${n}`); await sleep(20 + Math.random() * 40) }
    })()
    const external: string[] = []
    for (let k = 0; k < 6; k++) {
      const old = readFileSync(file, 'utf8')
      await sleep(150 + Math.random() * 300) // the other editor holds an old copy while typing goes on
      const line = `SAVED-OUTSIDE-${k}`
      const next = old + line + '\n'
      if (k % 2 === 0) saveAtomically(file, next)
      else writeFileSync(file, next)
      external.push(line)
      await sleep(400 + Math.random() * 600)
    }
    stop = true
    await typing
    await waitFor(() => { const t = busy.text(); return external.every((l) => t.includes(l)) && readFileSync(file, 'utf8') === t }, 'convergence', 15_000)
    const lines = busy.text().split('\n')
    const wrong = [...typed, ...external].filter((l) => lines.filter((x) => x === l).length !== 1)
    assert.deepEqual(wrong, [], 'every typed and every saved line exactly once')
    assert.ok(typed.length > 30, `typing happened (${typed.length} lines)`)

    for (const e of editors) e.close()
    closeAll()

    // 3. A closed note changed outside: it's searchable soon after (watcher).
    const closed = ws.vault.editable[20]!
    const word = 'palabraexterna' + Date.now().toString(36)
    const t0 = performance.now()
    writeFileSync(join(ws.notesDir, closed), readFileSync(join(ws.notesDir, closed), 'utf8') + `\n${word}\n`)
    await waitFor(async () => (await api(srv!, cookie, 'GET', `/api/search?q=${word}`)).body.results.some((r: { path: string }) => r.path === closed), 'searchable', 10_000)
    metric('external change to a closed note → searchable', performance.now() - t0, 'ms')
  } finally {
    closeAll()
    await srv?.stop()
    cleanup(ws)
  }
})
