// OAuth with a real client over the network (m3 §7): mcp-remote (the stdio
// bridge Claude Desktop and others use) against the real server, started as
// in production with THOTH_PUBLIC_URL, behind a local HTTPS reverse proxy
// whose certificate the test makes. mcp-remote finds the metadata from the
// 401, registers itself, and sends the person to the authorization page; the
// test does what the person would (signs in, approves read-only) and follows
// the redirect back to mcp-remote, which gets its tokens and connects.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { makeDirs, startServer, waitFor } from './_collab.ts'

const MODULES = fileURLToPath(new URL('../../../node_modules/', import.meta.url))
const MCP_REMOTE = join(MODULES, 'mcp-remote/dist/proxy.js')
const READ = ['changes_since', 'daily_note', 'get_note', 'history', 'list_folder', 'related', 'resolve_link', 'search']

/** A throwaway certificate for localhost, made with openssl; null if there's no openssl. */
function certificate(dir: string): { key: string; cert: string; certFile: string } | null {
  const keyFile = join(dir, 'key.pem')
  const certFile = join(dir, 'cert.pem')
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyFile, '-out', certFile,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })
  if (r.status !== 0) return null
  return { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8'), certFile }
}

/** A reverse proxy as a deployment would have: HTTPS outside, thoth over http inside, Host kept, X-Forwarded-Proto set. */
async function httpsProxy(tls: { key: string; cert: string }, target: number) {
  const server = createHttpsServer(tls, (req: IncomingMessage, res: ServerResponse) => {
    const up = httpRequest({ host: '127.0.0.1', port: target, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    up.on('error', () => { res.writeHead(502); res.end() })
    req.pipe(up)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

/** A free local port (for mcp-remote's callback). */
async function freePort(): Promise<number> {
  const s = createHttpServer()
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  const port = (s.address() as AddressInfo).port
  await new Promise((resolve) => s.close(resolve))
  return port
}

test('mcp-remote: discovery, registration, consent, tokens and the tools of a read-only authorization, over HTTPS', { timeout: 240_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'thoth-oauth-remote-'))
  const tls = certificate(home)
  if (!tls) { rmSync(home, { recursive: true, force: true }); return t.skip('no openssl to make a certificate') }
  const { notes, env } = makeDirs()
  // The built UI isn't needed: a stand-in page is enough for the authorization address.
  const web = join(home, 'web')
  mkdirSync(web)
  writeFileSync(join(web, 'index.html'), '<!doctype html><div id="root"></div>')
  const proxy = await httpsProxy(tls, Number(env.THOTH_PORT))
  const publicUrl = `https://localhost:${proxy.port}`
  const srv = await startServer({ ...env, THOTH_PUBLIC_URL: publicUrl, THOTH_WEB_DIR: web })
  const live: StdioClientTransport[] = []

  /** A request through the proxy, trusting its certificate: what the person's browser does. */
  const browser = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any }>((resolve, reject) => {
    const req = httpsRequest(`${publicUrl}${path}`, { method, ca: tls.cert, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, (res) => {
      let text = ''
      res.on('data', (d) => { text += d })
      res.on('end', () => {
        let parsed: unknown = text
        try { parsed = JSON.parse(text) } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })

  try {
    const login = await browser('POST', '/api/auth/login', { username: 'noa', password: 'a-long-password' })
    assert.equal(login.status, 200)
    const setCookie = String(login.headers['set-cookie'])
    assert.match(setCookie, /Secure/i, 'behind HTTPS the session cookie is Secure')
    const cookie = setCookie.split(';')[0]!
    assert.equal((await browser('PUT', '/api/admin/integrations', { mcp: true }, { cookie })).status, 200)

    /** mcp-remote as Claude Desktop runs it, with its own home and no browser to open. */
    const start = async (callbackPort: number) => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [MCP_REMOTE, `${publicUrl}/mcp`, String(callbackPort), '--transport', 'http-only', '--auth-timeout', '90'],
        env: {
          ...process.env as Record<string, string>, HOME: home, MCP_REMOTE_CONFIG_DIR: join(home, 'mcp-auth'),
          NODE_EXTRA_CA_CERTS: tls.certFile, BROWSER: 'true', DISPLAY: '', WAYLAND_DISPLAY: '',
        },
        stderr: 'pipe',
      })
      live.push(transport)
      const err: string[] = []
      transport.stderr?.on('data', (d) => err.push(String(d)))
      const client = new Client({ name: 'thoth-ci', version: '1' })
      const connected = client.connect(transport).then(() => null, (e: unknown) => e)
      return { transport, client, err, connected }
    }
    /** The address mcp-remote sends the person to, once it prints it. */
    const authorizationUrl = async (err: string[]) => {
      let url: URL | null = null
      await waitFor(() => {
        const m = /Please authorize this client by visiting:\s+(\S+)/.exec(err.join(''))
        if (m) url = new URL(m[1]!)
        return url !== null
      }, `mcp-remote's authorization URL\n${err.join('')}`, 60_000)
      return url! as URL
    }

    const port = await freePort()
    const first = await start(port)
    const url = await authorizationUrl(first.err)
    assert.equal(url.origin + url.pathname, `${publicUrl}/oauth/authorize`)
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(url.searchParams.get('resource'), `${publicUrl}/mcp`)
    // The person's browser: the page, then what it asks and the approval (read-only, every folder, as it comes).
    const page = await browser('GET', `${url.pathname}${url.search}`, undefined, { accept: 'text/html' })
    assert.equal(page.status, 200)
    const asked = await browser('GET', `/api/oauth/authorize${url.search}`, undefined, { cookie })
    assert.equal(asked.status, 200, JSON.stringify(asked.body))
    assert.equal(asked.body.client.redirectUri, `http://localhost:${port}/oauth/callback`)
    const approved = await browser('POST', '/api/oauth/authorize', { query: url.search.slice(1), approve: true }, { cookie, origin: publicUrl })
    assert.equal(approved.status, 200, JSON.stringify(approved.body))
    // Back to mcp-remote, as the browser follows the redirect. mcp-remote prints the address
    // before it opens its callback server: a person's browser is never that fast, this test can be.
    await waitFor(() => /OAuth callback server running/.test(first.err.join('')), `mcp-remote's callback server\n${first.err.join('')}`, 30_000)
    const back = await fetch(approved.body.redirect).catch((e: unknown) => { throw new Error(`${approved.body.redirect}: ${e}\n${first.err.join('')}`) })
    assert.equal(back.status, 200, await back.text())
    const failed = await first.connected
    assert.equal(failed, null, `${failed}\n${first.err.join('')}`)
    assert.deepEqual((await first.client.listTools()).tools.map((x) => x.name).sort(), READ, 'a read-only authorization sees no tool that writes')
    const found = await first.client.callTool({ name: 'search', arguments: { query: 'Proxy' } }) as { content: { text: string }[]; isError?: boolean }
    assert.notEqual(found.isError, true)
    assert.ok(JSON.parse(found.content[0]!.text).results.length > 0)
    await first.client.close()

    // It's an authorization in «Agents and API»: named after the client, used via OAuth.
    const keys = (await browser('GET', '/api/keys', undefined, { cookie })).body.keys as { id: string; name: string; lastVia: string; canWrite: boolean; client: { redirectUris: string[] } | null }[]
    assert.equal(keys.length, 1)
    assert.equal(keys[0]!.lastVia, 'oauth')
    assert.equal(keys[0]!.canWrite, false)
    assert.deepEqual(keys[0]!.client?.redirectUris, [`http://localhost:${port}/oauth/callback`])

    // Started again, it uses what it stored: nobody is asked.
    const second = await start(port)
    assert.equal(await second.connected, null, second.err.join(''))
    assert.deepEqual((await second.client.listTools()).tools.map((x) => x.name).sort(), READ)
    assert.doesNotMatch(second.err.join(''), /Please authorize/)
    await second.client.close()

    // Revoked: its tokens stop working, and the next start asks the person again.
    assert.equal((await browser('DELETE', `/api/keys/${keys[0]!.id}`, undefined, { cookie, origin: publicUrl })).status, 200)
    const third = await start(port)
    await authorizationUrl(third.err)
    await third.transport.close()
  } finally {
    for (const tr of live) await tr.close().catch(() => {})
    await srv.stop()
    proxy.server.closeAllConnections()
    await new Promise((resolve) => proxy.server.close(resolve))
    rmSync(dirname(notes), { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
