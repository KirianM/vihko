// The MCP server with real clients over the network (m3 §5), against the real
// server started as in production: the SDK's own client (both protocol eras),
// MCP Inspector in CLI mode, and mcp-remote (the stdio bridge Claude Desktop
// and others use for remote servers). Each one lists the tools a key gets,
// calls every one of them, sees none that write with a read-only key, and
// gets 404 with the MCP switched off.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, StreamableHTTPClientTransport, type VersionNegotiationMode } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { toolData } from '@thoth/server'
import { api, login, makeDirs, startServer, waitFor } from './_collab.ts'
import { tempDir } from './_tmp.ts'

const MODULES = fileURLToPath(new URL('../../../node_modules/', import.meta.url))
const INSPECTOR = join(MODULES, '@modelcontextprotocol/inspector/clients/launcher/build/index.js')
const MCP_REMOTE = join(MODULES, 'mcp-remote/dist/proxy.js')

const READ = ['changes_since', 'daily_note', 'get_note', 'history', 'list_folder', 'related', 'resolve_link', 'search']
const ALL = [...READ, 'create_note', 'delete', 'edit_note', 'move', 'revert_change'].sort()

/** A tool's result as a client got it: its JSON data (first block) and whether it's an error. */
interface Result { data: any; error: boolean }
type Call = (name: string, args: Record<string, unknown>) => Promise<Result>

const parse = (r: { content?: { type: string; text?: string }[]; isError?: boolean }): Result => {
  let data: any = null
  try { data = toolData(r.content?.[0]?.text ?? 'null') } catch { data = r.content?.[0]?.text }
  return { data, error: r.isError === true }
}

/**
 * Every tool, called the way an agent would: reading around a note, then a
 * note of its own created, edited (the change seen with changes_since and in
 * the history), a revert previewed, moved and deleted. `tag` keeps each
 * client's note apart. Returns the tools it called.
 */
async function exercise(call: Call, tag: string, write: boolean): Promise<string[]> {
  const called: string[] = []
  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await call(name, args)
    assert.equal(r.error, false, `${tag} ${name} ${JSON.stringify(args)}: ${JSON.stringify(r.data)}`)
    if (!called.includes(name)) called.push(name)
    return r.data
  }
  assert.ok((await ok('search', { query: 'Proxy' })).results.length > 0)
  assert.ok((await ok('list_folder', { folder: 'hogar' })).entries.length > 0)
  const note = await ok('get_note', { path: 'hogar/Proxy.md' })
  await ok('related', { path: 'hogar/Proxy.md' })
  assert.equal((await ok('resolve_link', { from: 'hogar/enlaces.md', link: 'Firewall' })).status, 'resolved')
  assert.equal((await ok('changes_since', { path: 'hogar/Proxy.md', since: note.etag })).changed, false)
  await ok('history', { path: 'hogar/Proxy.md' })
  await ok('daily_note', {})
  if (!write) return called

  const path = `clientes/${tag}.md`
  const made = await ok('create_note', { path, text: `# ${tag}\n\n## Registro\n` })
  const versions = async (n: number) => {
    let list: any[] = []
    await waitFor(async () => (list = (await ok('history', { path })).versions).length >= n, `${tag}: ${n} versions`, 20_000)
    return list
  }
  await versions(1)
  await ok('edit_note', { path, operations: [{ op: 'append_under_heading', heading: 'Registro', text: `- ${tag} estuvo aquí` }] })
  const since = await ok('changes_since', { path, since: made.etag })
  assert.deepEqual(since.changes.map((c: any) => c.added), [`- ${tag} estuvo aquí\n`])
  const [edit] = await versions(2)
  assert.equal(edit.authors[0].name, 'Claude Code')
  assert.equal(edit.authors[0].via, 'mcp')
  assert.equal((await ok('revert_change', { path, version: edit.version, dry_run: true })).counts.reverted, 1)
  await ok('move', { from: path, to: `clientes/${tag}-movida.md` })
  await ok('delete', { path: `clientes/${tag}-movida.md` })
  return called
}

async function server() {
  const { notes, env } = makeDirs()
  writeFileSync(join(notes, 'thoth.yaml'), 'daily:\n  diario:\n    folder: diario\n')
  const srv = await startServer({ ...env, THOTH_HISTORY_QUIET_SECONDS: '0.3' })
  const cookie = await login(srv)
  const key = async (input: Record<string, unknown>) => {
    const r = await api(srv, cookie, 'POST', '/api/keys', { confirm: 'a-long-password', ...input })
    assert.equal(r.status, 201)
    return r.body.token as string
  }
  const mcp = async (on: boolean) => assert.equal((await api(srv, cookie, 'PUT', '/api/admin/integrations', { mcp: on })).status, 200)
  await mcp(true)
  /** Stops the server and removes its folders (a test run leaves nothing in /tmp). */
  const stop = async () => {
    await srv.stop()
    rmSync(dirname(notes), { recursive: true, force: true })
  }
  return { srv, url: `${srv.base}/mcp`, rw: await key({ name: 'Claude Code', canWrite: true }), ro: await key({ name: 'Lector' }), mcp, stop }
}

/** The SDK's client, over HTTP. */
async function sdk(url: string, token: string, mode: VersionNegotiationMode) {
  const client = new Client({ name: 'thoth-ci', version: '1' }, { versionNegotiation: { mode } })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  return {
    client,
    tools: async () => (await client.listTools()).tools.map((t) => t.name).sort(),
    call: (async (name, args) => parse(await client.callTool({ name, arguments: args }) as never)) as Call,
  }
}

test('the SDK\'s client, in both protocol eras', { timeout: 120_000 }, async () => {
  const s = await server()
  try {
    for (const mode of ['legacy', 'auto'] as const) {
      const rw = await sdk(s.url, s.rw, mode)
      assert.deepEqual(await rw.tools(), ALL, mode)
      assert.deepEqual((await exercise(rw.call, `sdk-${mode}`, true)).sort(), ALL, `${mode}: every tool called`)
      await rw.client.close()
      const ro = await sdk(s.url, s.ro, mode)
      assert.deepEqual(await ro.tools(), READ, `${mode}: a read-only key sees no tool that writes`)
      await exercise(ro.call, `sdk-ro-${mode}`, false)
      await assert.rejects(ro.client.callTool({ name: 'create_note', arguments: { path: 'x.md', text: 'x' } }), /create_note/)
      await ro.client.close()
    }
    await s.mcp(false)
    for (const mode of ['legacy', 'auto'] as const) await assert.rejects(sdk(s.url, s.rw, mode), (err: { status?: number }) => err.status === 404, mode)
    const raw = await fetch(s.url, { method: 'POST', headers: { authorization: `Bearer ${s.rw}`, 'content-type': 'application/json' }, body: '{}' })
    assert.equal(raw.status, 404)
  } finally { await s.stop() }
})

/** MCP Inspector's CLI, one process per call, with its own home (it keeps a catalog there). */
function inspector(home: string, url: string, token: string, era: 'legacy' | 'modern', args: string[]): Promise<{ code: number | null; out: any; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [INSPECTOR, '--cli', url, '--transport', 'http', '--protocol-era', era, '--format', 'json', '--header', `Authorization: Bearer ${token}`, ...args], {
      env: { ...process.env, HOME: home, MCP_CATALOG_PATH: join(home, 'catalog.json'), MCP_CLIENT_CONFIG_PATH: join(home, 'client.json') },
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    // A call that hangs fails on its own: a test that times out never reaches its cleanup,
    // and a live child would keep the test file (and npm test) from ever exiting.
    const timer = setTimeout(() => { err += '\n[killed after 60 s]'; p.kill('SIGKILL') }, 60_000)
    p.on('close', (code) => {
      clearTimeout(timer)
      let parsed: any = null
      try { parsed = JSON.parse(out) } catch { parsed = out }
      resolve({ code, out: parsed, err })
    })
  })
}

test('MCP Inspector in CLI mode, in both protocol eras', { timeout: 300_000 }, async () => {
  const s = await server()
  const home = tempDir('thoth-inspector-')
  try {
    for (const era of ['legacy', 'modern'] as const) {
      const list = async (token: string) => {
        const r = await inspector(home, s.url, token, era, ['--method', 'tools/list'])
        assert.equal(r.code, 0, `${era}: ${r.err} ${JSON.stringify(r.out)}`)
        return (r.out.result.tools as { name: string }[]).map((t) => t.name).sort()
      }
      assert.deepEqual(await list(s.rw), ALL, era)
      assert.deepEqual(await list(s.ro), READ, `${era}: a read-only key sees no tool that writes`)
      const call = (token: string): Call => async (name, args) => {
        const r = await inspector(home, s.url, token, era, ['--method', 'tools/call', '--tool-name', name, '--tool-args-json', JSON.stringify(args)])
        assert.equal(r.code === 0 || r.out?.result?.isError === true, true, `${era} ${name}: ${r.err} ${JSON.stringify(r.out)}`)
        return parse(r.out.result)
      }
      assert.deepEqual((await exercise(call(s.rw), `inspector-${era}`, true)).sort(), ALL, `${era}: every tool called`)
      const refused = await inspector(home, s.url, s.ro, era, ['--method', 'tools/call', '--tool-name', 'create_note', '--tool-args-json', '{"path":"x.md","text":"x"}'])
      assert.ok(refused.code !== 0 || refused.out?.result?.isError === true, `${era}: ${JSON.stringify(refused.out)}`)
    }
    await s.mcp(false)
    // (In the modern era it only says the negotiation failed; the 2025 handshake reports the status.)
    for (const era of ['legacy', 'modern'] as const) assert.notEqual((await inspector(home, s.url, s.rw, era, ['--method', 'tools/list'])).code, 0, era)
    const off = await inspector(home, s.url, s.rw, 'legacy', ['--method', 'tools/list'])
    assert.match(JSON.stringify(off.out) + off.err, /404/)
  } finally {
    await s.stop()
    rmSync(home, { recursive: true, force: true })
  }
})

test('mcp-remote, the stdio bridge to a remote server', { timeout: 180_000 }, async () => {
  const s = await server()
  const home = tempDir('thoth-mcp-remote-')
  const connect = async (token: string) => {
    // The key in a file, as its docs advise: never in the process list.
    const headers = join(home, `headers-${token.slice(-6)}.txt`)
    writeFileSync(headers, `Authorization: Bearer ${token}\n`)
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_REMOTE, s.url, '--header-file', headers, '--transport', 'http-only'],
      env: { ...process.env as Record<string, string>, HOME: home, MCP_REMOTE_CONFIG_DIR: join(home, 'mcp-auth') },
      stderr: 'pipe',
    })
    const err: string[] = []
    transport.stderr?.on('data', (d) => err.push(String(d)))
    const client = new Client({ name: 'thoth-ci', version: '1' })
    await client.connect(transport).catch((e) => { throw new Error(`${e}\n${err.join('')}`) })
    return { client, err, call: (async (name, args) => parse(await client.callTool({ name, arguments: args }) as never)) as Call }
  }
  try {
    const rw = await connect(s.rw)
    assert.deepEqual((await rw.client.listTools()).tools.map((t) => t.name).sort(), ALL)
    assert.deepEqual((await exercise(rw.call, 'mcp-remote', true)).sort(), ALL, 'every tool called')
    await rw.client.close()
    const ro = await connect(s.ro)
    assert.deepEqual((await ro.client.listTools()).tools.map((t) => t.name).sort(), READ)
    await assert.rejects(ro.client.callTool({ name: 'edit_note', arguments: { path: 'x.md', operations: [] } }))
    await ro.client.close()
    await s.mcp(false)
    await assert.rejects(connect(s.rw), /404/)
  } finally {
    await s.stop()
    rmSync(home, { recursive: true, force: true })
  }
})
