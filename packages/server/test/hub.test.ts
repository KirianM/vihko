import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { readFrontmatter } from '@thoth/core'
import { api, closeAll, connect, login, makeDirs, open, sleep, startServer, typeLine, waitFor } from './_collab.ts'

const NOTE = 'hogar/Proxy.md'

test('dos clientes, API y editor externo sobre una nota abierta; el archivo converge y recibe uid', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    const b = await connect(srv, cookie, NOTE)
    for (let i = 0; i < 20; i++) { typeLine(a, `A-${i}`); typeLine(b, `B-${i}`); await sleep(5) }
    // Edición por la API con la nota caliente: pasa por el documento vivo. Mientras
    // los clientes escriben, el ETag cambia: se reintenta como haría un cliente real.
    let put = { status: 0, body: null as any }
    for (let i = 0; i < 20 && put.status !== 200; i++) {
      const cur = await api(srv, cookie, 'GET', `/api/note?path=${encodeURIComponent(NOTE)}`)
      put = await api(srv, cookie, 'PUT', `/api/note?path=${encodeURIComponent(NOTE)}`, { text: cur.body.text.replace('## Red', '## Red (editado por API)') }, { 'if-match': `"${cur.body.etag}"` })
      assert.ok([200, 412].includes(put.status), `estado ${put.status}`)
    }
    assert.equal(put.status, 200)
    // Editor externo.
    const file = join(notes, NOTE)
    await waitFor(() => readFileSync(file, 'utf8').includes('A-0'), 'primer volcado')
    writeFileSync(file, readFileSync(file, 'utf8').replace('## Almacenamiento', '## Almacenamiento (editado fuera)'))
    await waitFor(() => a.text().includes('(editado fuera)') && b.text().includes('(editado fuera)'), 'cambio externo en los clientes')
    await waitFor(() => a.text() === b.text() && a.text().includes('(editado por API)'), 'convergencia')
    const final = a.text()
    for (let i = 0; i < 20; i++) assert.ok(final.includes(`A-${i}\n`) && final.includes(`B-${i}\n`), `falta A-${i}/B-${i}`)
    a.close(); b.close()
    await waitFor(() => readFileSync(file, 'utf8') === final, 'volcado final')
    const fm = readFrontmatter(final)
    assert.deepEqual(fm.data.aliases, ['gw', 'Hipervisor'], 'el frontmatter original se conserva')
    assert.match(String(fm.data.uid), /^[0-9A-Z]{26}$/, 'recibe uid al escribirla thoth (D-015)')
  } finally { closeAll(); await srv.stop() }
})

test('un editor externo que guarda sobre una versión vieja no borra lo escrito en la UI', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    const file = join(notes, NOTE)
    typeLine(a, 'ANTES')
    await waitFor(() => readFileSync(file, 'utf8').includes('ANTES\n'), 'volcado')
    const opened = readFileSync(file, 'utf8') // el editor externo abre aquí…
    for (let i = 0; i < 3; i++) {
      typeLine(a, `UI-${i}`)
      await waitFor(() => readFileSync(file, 'utf8').includes(`UI-${i}\n`), 'volcado')
    }
    writeFileSync(file, opened.replace('## Red', '## Red (editor lento)')) // …y guarda mucho después
    await waitFor(() => a.text().includes('(editor lento)'), 'fusión')
    for (let i = 0; i < 3; i++) assert.ok(a.text().includes(`UI-${i}\n`), `se perdió UI-${i}`)
  } finally { closeAll(); await srv.stop() }
})

test('caída del servidor con ediciones sin volcar: se recuperan al arrancar', async () => {
  const { notes, env } = makeDirs()
  let srv = await startServer(env)
  const file = join(notes, NOTE)
  const before = readFileSync(file, 'utf8')
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    for (let i = 0; i < 10; i++) typeLine(a, `SIN-VOLCAR-${i}`)
    await waitFor(() => a.provider.unsyncedChanges === 0, 'envío al servidor')
    await sleep(100)
    a.close()
    await srv.stop('SIGKILL') // antes del volcado (debounce de 1 s)
    assert.equal(readFileSync(file, 'utf8'), before, 'aún no se había volcado')
    srv = await startServer(env)
    await waitFor(() => readFileSync(file, 'utf8').includes('SIN-VOLCAR-9'), 'recuperación')
    for (let i = 0; i < 10; i++) assert.ok(readFileSync(file, 'utf8').includes(`SIN-VOLCAR-${i}\n`))
    await waitFor(() => readdirSync(join(env.THOTH_STATE_DIR!, 'collab')).length === 0, 'log recuperado y eliminado')
  } finally { closeAll(); await srv.stop() }
})

test('borrar una nota abierta la cierra y no la resucita', async () => {
  const { notes, env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const a = await connect(srv, cookie, NOTE)
    typeLine(a, 'ANTES-DE-BORRAR')
    await waitFor(() => readFileSync(join(notes, NOTE), 'utf8').includes('ANTES-DE-BORRAR'), 'volcado')
    const del = await api(srv, cookie, 'DELETE', `/api/note?path=${encodeURIComponent(NOTE)}`)
    assert.equal(del.status, 200)
    await sleep(1500)
    assert.ok(!existsSync(join(notes, NOTE)), 'no se vuelve a crear')
    const trash = await api(srv, cookie, 'GET', '/api/trash')
    assert.equal(trash.body.entries[0].path, NOTE)
  } finally { closeAll(); await srv.stop() }
})

test('WebSocket: sin sesión, desde otro origen o a una nota inexistente, se rechaza', async () => {
  const { env } = makeDirs()
  const srv = await startServer(env)
  try {
    const cookie = await login(srv)
    const url = srv.base.replace('http', 'ws') + '/collab'
    const status = (headers: Record<string, string>) => new Promise<number>((resolve) => {
      const ws = new WebSocket(url, { headers })
      ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate() })
      ws.on('open', () => { resolve(101); ws.close() })
      ws.on('error', () => {})
    })
    assert.equal(await status({}), 401)
    assert.equal(await status({ cookie, origin: 'https://malicioso.example' }), 403)
    assert.equal(await status({ cookie }), 101)
    // Nota inexistente: la conexión se acepta pero el documento no se carga.
    const doc = new Y.Doc()
    class AuthedWS extends WebSocket { constructor(u: string, p?: string | string[]) { super(u, p, { headers: { cookie } }) } }
    const wsp = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: AuthedWS })
    const p = new HocuspocusProvider({ websocketProvider: wsp, name: 'no-existe.md', document: doc })
    p.attach()
    open.push(p, wsp)
    await sleep(800)
    assert.equal(p.isSynced, false)
    assert.ok(!existsSync(join(env.THOTH_NOTES_DIR!, 'no-existe.md')))
    wsp.destroy()
  } finally { closeAll(); await srv.stop() }
})

