// Prueba de carga del hub sobre el servidor real: `npm run load` (LOAD_SECONDS, 30 por defecto).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as Y from 'yjs'
import { api, closeAll, connect, login, makeDirs, sleep, startServer, waitFor, type Client } from './_collab.ts'

const NOTE = 'carga.md'
const SECONDS = Number(process.env.LOAD_SECONDS ?? 30)

async function human(c: Client, id: string, until: number, done: string[]) {
  const t = c.doc.getText('md')
  for (let n = 0; Date.now() < until; n++) {
    const token = `${id}-${n} escribe despacio`
    const s = t.toString()
    const body = s.indexOf('\n---\n') + 5
    const starts = [body]
    for (let i = s.indexOf('\n', body); i !== -1 && i < s.length - 1; i = s.indexOf('\n', i + 1)) starts.push(i + 1)
    const at = starts[Math.floor(Math.random() * starts.length)]!
    t.insert(at, '\n')
    let cursor = Y.createRelativePositionFromTypeIndex(t, at)
    for (const ch of token) {
      const abs = Y.createAbsolutePositionFromRelativePosition(cursor, c.doc)!
      t.insert(abs.index, ch)
      cursor = Y.createRelativePositionFromTypeIndex(t, abs.index + 1)
      await sleep(5 + Math.random() * 25)
    }
    done.push(token)
  }
}

test(`carga del hub: 3 personas + agente por API + editor externo lento, ${SECONDS} s`, { timeout: (SECONDS + 120) * 1000 }, async () => {
  const { notes, env } = makeDirs()
  const file = join(notes, NOTE)
  writeFileSync(file, '---\ntitle: Carga\n---\n# Carga\n\nMARCA-AGENTE\nlinea fija 1\n')
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const clients = [await connect(srv, cookie, NOTE), await connect(srv, cookie, NOTE), await connect(srv, cookie, NOTE)]
    const until = Date.now() + SECONDS * 1000
    const typed: string[] = []
    const agent: string[] = []
    const ext: string[] = []
    let lastFija = ''
    const agentLoop = (async () => {
      for (let k = 0; Date.now() < until; k++) {
        // Edición por operación: no depende de que nadie más esté escribiendo.
        const r = await api(srv, cookie, 'POST', '/api/note/edit', { path: NOTE, ops: [{ op: 'find_replace', find: 'MARCA-AGENTE\n', replace: `MARCA-AGENTE\nAGENT-${k}\n` }] })
        assert.equal(r.status, 200, JSON.stringify(r.body))
        agent.push(`AGENT-${k}`)
        await sleep(700 + Math.random() * 600)
      }
    })()
    const externalLoop = (async () => {
      for (let k = 0; Date.now() < until; k++) {
        const read = readFileSync(file, 'utf8')
        await sleep(200 + Math.random() * 600)
        lastFija = `linea fija 1 v${k}`
        writeFileSync(file, read.replace(/^linea fija 1.*$/m, lastFija) + `EXT-${k}\n`)
        ext.push(`EXT-${k}`)
        await sleep(1500 + Math.random() * 1500)
      }
    })()
    await Promise.all([...clients.map((c, i) => human(c, `H${i}`, until, typed)), agentLoop, externalLoop])
    const lines = (s: string) => s.split('\n')
    await waitFor(() => {
      const ls = lines(clients[0]!.text())
      return [...ext, lastFija].every((e) => ls.includes(e)) && clients.every((c) => c.text() === clients[0]!.text())
    }, 'convergencia final', 30000)
    const text = clients[0]!.text()
    const ls = lines(text)
    const missing = [...typed, ...agent, ...ext].filter((t) => ls.filter((l) => l === t).length !== 1)
    assert.deepEqual(missing, [], 'líneas perdidas o duplicadas')
    assert.ok(agent.length >= SECONDS / 2, `el agente debe poder escribir con gente editando (${agent.length} ediciones)`)
    assert.ok(typed.length > SECONDS * 3 && ext.length >= SECONDS / 4, 'la carga debe haber ocurrido de verdad')
    assert.equal(ls.filter((l) => l.startsWith('linea fija 1')).length, 1)
    clients.forEach((c) => c.close())
    await waitFor(() => readFileSync(file, 'utf8') === text, 'volcado final', 15000)
    console.log(`personas: ${typed.length} líneas · agente: ${agent.length} ediciones · externo: ${ext.length} guardados`)
  } finally { closeAll(); await srv.stop() }
})
