// OAuth Client ID Metadata Documents (cimd.ts, D-037): which addresses are
// public, which client_ids thoth would fetch, and the fetch itself against a
// local HTTPS server with a throwaway certificate (for `cimd.test`), which the
// fetcher may only reach through its testing options: loopback allowed, any
// port, its CA trusted, and a resolver that says where `cimd.test` is. Then
// every refusal (a private address, a name that resolves to one, a redirect,
// too large, too slow, another client_id, a secret, bad redirect URIs), that
// the connection goes to the address that was checked, and the whole OAuth
// flow with a client that names itself by its document's URL.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { CIMD_MAX_BYTES, CIMD_MAX_TTL_MS, CIMD_DEFAULT_TTL_MS, CimdError, ClientMetadataFetcher, cacheTtlMs, checkClientIdUrl, isPublicAddress, type Resolver } from '@thoth/server'
import { setup } from './_agents.ts'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

const HOST = 'cimd.test'
const PUBLIC = 'https://notas.example.org'
const RESOURCE = `${PUBLIC}/mcp`
const CALLBACK = 'https://claude.example/api/mcp/auth_callback'

/** A throwaway certificate for cimd.test, made with openssl; null if there's no openssl. */
function certificate(): { key: string; cert: string } | null {
  const dir = tempDir('thoth-cimd-cert-')
  const keyFile = join(dir, 'key.pem')
  const certFile = join(dir, 'cert.pem')
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyFile, '-out', certFile,
    '-days', '1', '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`], { stdio: 'ignore' })
  if (r.status !== 0) return null
  return { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8') }
}

type Route = (url: string) => { status?: number; headers?: Record<string, string>; body?: string; hang?: boolean }

/** The client's side: an HTTPS server on 127.0.0.1 that answers each path as `routes` says, counting requests. */
async function clientSite(tls: { key: string; cert: string }, routes: Record<string, Route>) {
  const hits: Record<string, number> = {}
  let base = ''
  const server: Server = createServer(tls, (req, res) => {
    const path = (req.url ?? '').split('?')[0]!
    hits[path] = (hits[path] ?? 0) + 1
    const route = routes[path]
    if (!route) { res.writeHead(404); res.end(); return }
    const r = route(`${base}${path}`)
    if (r.hang) return // never answers
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers })
    res.end(r.body ?? '')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `https://${HOST}:${(server.address() as AddressInfo).port}`
  return {
    base, hits,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

/** The name the client's documents give. */
const CLIENT = m.aKeyName()

/** A good metadata document for the client at `url`. */
const doc = (url: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ client_id: url, client_name: CLIENT, redirect_uris: [CALLBACK], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...extra })

/** Where `cimd.test` (and anything else asked) is, counting lookups. */
function resolver(map: Record<string, string[]>) {
  const calls: string[] = []
  const resolve: Resolver = async (host) => {
    calls.push(host)
    const all = map[host]
    if (!all) throw new Error('ENOTFOUND')
    return all.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  return { resolve, calls }
}

async function code(p: Promise<unknown>): Promise<string> {
  try { await p } catch (err) { if (err instanceof CimdError) return err.code; throw err }
  return 'ok'
}

test('public addresses: private, loopback, link-local, CGNAT, multicast, documentation and reserved ones are not, in IPv4 and IPv6', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4003:80b::200e', '64:ff9b::808:808']) assert.ok(isPublicAddress(ip), ip)
  for (const ip of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.8.8.8', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.8',
    '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:8.8.8.8', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', 'fec0::1', '100::1',
    '2001:db8::1', '2001::1', '2002:7f00:1::1', '3fff::1', '64:ff9b::a00:1', '64:ff9b::7f00:1', 'not an address', '',
  ]) assert.ok(!isPublicAddress(ip), ip)
})

test('client_id URLs thoth would fetch: https, a host name, port 443, a path, nothing else odd', () => {
  assert.equal(checkClientIdUrl('https://claude.ai/oauth/client.json').hostname, 'claude.ai')
  assert.ok(checkClientIdUrl('https://vscode.dev/oauth/client-metadata.json'))
  for (const [bad, why] of [
    ['http://claude.ai/client.json', 'http'], ['https://claude.ai', 'no path'], ['https://claude.ai/', 'no path'],
    ['https://claude.ai:8443/client.json', 'another port'], ['https://u:p@claude.ai/client.json', 'credentials'],
    ['https://claude.ai/client.json#x', 'fragment'], ['https://claude.ai/a/../client.json', 'dot segments'], ['https://claude.ai/./client.json', 'dot segment'],
    ['https://127.0.0.1/client.json', 'an address'], ['https://[::1]/client.json', 'an IPv6 address'], ['https://CLAUDE.ai/client.json', 'not normalized'],
    ['https://claude.ai:443/client.json', 'not normalized'], [`https://claude.ai/${'x'.repeat(2000)}`, 'too long'], ['https://', 'not a URL'],
  ] as const) assert.throws(() => checkClientIdUrl(bad), (e: unknown) => e instanceof CimdError && e.code === 'invalid_url', `${why}: ${bad}`)
  assert.ok(checkClientIdUrl('https://cimd.test:4450/client.json', { anyPort: true }))
})

test('the cache follows Cache-Control, within bounds', () => {
  assert.equal(cacheTtlMs(undefined), CIMD_DEFAULT_TTL_MS)
  assert.equal(cacheTtlMs('public, max-age=60'), 60_000)
  assert.equal(cacheTtlMs('max-age=86400'), CIMD_MAX_TTL_MS)
  for (const none of ['no-store', 'no-cache', 'private, max-age=600', 'max-age=0']) assert.equal(cacheTtlMs(none), 0, none)
})

test('without testing options: loopback through the system resolver, other ports and addresses are refused before connecting', async () => {
  const f = new ClientMetadataFetcher()
  // `localhost` resolves (/etc/hosts) to loopback: refused as not public.
  assert.equal(await code(f.get('https://localhost/client.json')), 'blocked_address')
  assert.equal(await code(f.get('https://localhost:4450/client.json')), 'invalid_url')
  assert.equal(await code(f.get('https://127.0.0.1/client.json')), 'invalid_url')
  assert.equal(await code(f.get('https://no-such-host.invalid/client.json')), 'unresolved')
})

test('fetching a document: what it gives, the cache, and every refusal', { timeout: 60_000 }, async (t) => {
  const tls = certificate()
  if (!tls) return t.skip('no openssl to make a certificate')
  const big = JSON.stringify({ pad: 'x'.repeat(CIMD_MAX_BYTES) })
  const site = await clientSite(tls, {
    '/client.json': (url) => ({ body: doc(url), headers: { 'cache-control': 'max-age=120' } }),
    '/fresh.json': (url) => ({ body: doc(url), headers: { 'cache-control': 'no-store' } }),
    '/redirect.json': () => ({ status: 302, headers: { location: '/client.json' } }),
    '/big.json': () => ({ body: big }),
    '/big-chunked.json': () => ({ body: big, headers: { 'transfer-encoding': 'chunked' } }),
    '/slow.json': () => ({ hang: true }),
    '/other-id.json': (url) => ({ body: doc(url.replace('other-id', 'client')) }),
    '/no-name.json': (url) => ({ body: doc(url, { client_name: '' }) }),
    '/secret.json': (url) => ({ body: doc(url, { client_secret: m.aSecret(12) }) }),
    '/basic.json': (url) => ({ body: doc(url, { token_endpoint_auth_method: 'client_secret_basic' }) }),
    '/not-json.json': () => ({ body: '<html>hello</html>' }),
    '/array.json': () => ({ body: '[]' }),
    '/gone.json': () => ({ status: 500, body: '{}' }),
  })
  try {
    const dns = resolver({ [HOST]: ['127.0.0.1'] })
    const f = new ClientMetadataFetcher({ testing: { resolve: dns.resolve, allowLoopback: true, anyPort: true, ca: tls.cert } })
    const got = await f.get(`${site.base}/client.json`)
    assert.deepEqual({ ...got }, { clientId: `${site.base}/client.json`, name: CLIENT, host: HOST, redirectUris: [CALLBACK], grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'] })
    // Kept as its Cache-Control says: asking again doesn't fetch; a no-store one is fetched every time.
    await f.get(`${site.base}/client.json`)
    assert.equal(site.hits['/client.json'], 1)
    await f.get(`${site.base}/fresh.json`)
    await f.get(`${site.base}/fresh.json`)
    assert.equal(site.hits['/fresh.json'], 2)
    // Several asks at once share one fetch.
    await Promise.all([f.get(`${site.base}/fresh.json`), f.get(`${site.base}/fresh.json`)])
    assert.equal(site.hits['/fresh.json'], 3)

    assert.equal(await code(f.get(`${site.base}/redirect.json`)), 'redirect')
    assert.equal(site.hits['/client.json'], 1, 'the redirect was not followed')
    assert.equal(await code(f.get(`${site.base}/big.json`)), 'too_large')
    assert.equal(await code(f.get(`${site.base}/big-chunked.json`)), 'too_large')
    assert.equal(await code(f.get(`${site.base}/other-id.json`)), 'invalid_document')
    assert.equal(await code(f.get(`${site.base}/no-name.json`)), 'invalid_document')
    assert.equal(await code(f.get(`${site.base}/secret.json`)), 'invalid_document')
    assert.equal(await code(f.get(`${site.base}/basic.json`)), 'invalid_document')
    assert.equal(await code(f.get(`${site.base}/not-json.json`)), 'invalid_document')
    assert.equal(await code(f.get(`${site.base}/array.json`)), 'invalid_document')
    assert.equal(await code(f.get(`${site.base}/gone.json`)), 'fetch_failed')
    assert.equal(await code(f.get(`${site.base}/missing.json`)), 'fetch_failed')
    // A failure is never kept: asking again fetches again.
    const before = site.hits['/gone.json']
    await code(f.get(`${site.base}/gone.json`))
    assert.equal(site.hits['/gone.json'], before! + 1)

    const started = Date.now()
    assert.equal(await code(f.get(`${site.base}/slow.json`)), 'timeout')
    const took = Date.now() - started
    assert.ok(took >= 4_500 && took < 8_000, `gave up after ${took} ms`)

    // Loopback isn't allowed without the testing option, even with everything else.
    const strict = new ClientMetadataFetcher({ testing: { resolve: dns.resolve, anyPort: true, ca: tls.cert } })
    assert.equal(await code(strict.get(`${site.base}/client.json`)), 'blocked_address')
    // A name that resolves to a private address, alone or among public ones, is refused before connecting.
    const port = new URL(site.base).port
    for (const answer of [['10.0.0.5'], ['192.168.1.10'], ['169.254.169.254'], ['100.64.1.1'], ['fd00::1'], ['::ffff:127.0.0.1'], ['93.184.216.34', '10.0.0.5'], ['2606:4700::1', 'fe80::1']]) {
      const evil = new ClientMetadataFetcher({ testing: { resolve: resolver({ 'evil.test': answer }).resolve, anyPort: true, ca: tls.cert } })
      assert.equal(await code(evil.get(`https://evil.test:${port}/client.json`)), 'blocked_address', answer.join(' '))
    }
    // TLS is checked against the name, not the address: a certificate for cimd.test doesn't serve other.test.
    const other = new ClientMetadataFetcher({ testing: { resolve: resolver({ 'other.test': ['127.0.0.1'] }).resolve, allowLoopback: true, anyPort: true, ca: tls.cert } })
    assert.equal(await code(other.get(`https://other.test:${port}/client.json`)), 'fetch_failed')
  } finally {
    await site.close()
  }
})

test('the connection goes to the address that was checked, even if the name resolves elsewhere afterwards', async (t) => {
  const tls = certificate()
  if (!tls) return t.skip('no openssl to make a certificate')
  const site = await clientSite(tls, { '/client.json': (url) => ({ body: doc(url), headers: { 'cache-control': 'no-store' } }) })
  try {
    // First the local server (allowed here), then a private address: a second resolution would go there.
    let n = 0
    const resolve: Resolver = async () => (n++ === 0 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.255.255.1', family: 4 }])
    const f = new ClientMetadataFetcher({ testing: { resolve, allowLoopback: true, anyPort: true, ca: tls.cert } })
    assert.equal((await f.get(`${site.base}/client.json`)).name, CLIENT)
    assert.equal(n, 1, 'resolved once')
    assert.equal(site.hits['/client.json'], 1)
    // The next fetch resolves again, gets the private address, and is refused without connecting.
    assert.equal(await code(f.get(`${site.base}/client.json`)), 'blocked_address')
    assert.equal(site.hits['/client.json'], 1)
  } finally {
    await site.close()
  }
})

/** A PKCE pair (RFC 7636, S256). */
function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

test('OAuth with a client named by its metadata document: advertised, fetched only once someone signed in asks, approved, tokens, /mcp', { timeout: 60_000 }, async (t) => {
  const tls = certificate()
  if (!tls) return t.skip('no openssl to make a certificate')
  const site = await clientSite(tls, {
    '/client.json': (url) => ({ body: doc(url) }),
    '/js.json': (url) => ({ body: doc(url, { redirect_uris: ['javascript:alert(1)'] }) }),
    '/implicit.json': (url) => ({ body: doc(url, { response_types: ['token'] }) }),
  })
  const dns = resolver({ [HOST]: ['127.0.0.1'], 'intranet.test': ['10.0.0.8'] })
  const clientMetadata = new ClientMetadataFetcher({ testing: { resolve: dns.resolve, allowLoopback: true, anyPort: true, ca: tls.cert } })
  const h = await setup({ files: { [m.aNotePath(m.aFolder())]: `# ${m.aHeading()}\n` }, publicUrl: PUBLIC, ui: true, clientMetadata })
  try {
    await h.enableMcp()
    const meta = await h.app.request('/.well-known/oauth-authorization-server')
    const advertised = await meta.json() as Record<string, unknown>
    assert.equal(advertised.client_id_metadata_document_supported, true)
    assert.ok((advertised.token_endpoint_auth_methods_supported as string[]).includes('none'), 'Claude uses CIMD only with `none` listed')

    const clientId = `${site.base}/client.json`
    const { verifier, challenge } = pkce()
    const state = m.aSecret(12)
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state, resource: RESOURCE }).toString()

    // Before anyone signs in: the page, and nothing fetched (nor resolved).
    const page = await h.app.request(`/oauth/authorize?${q}`, { headers: { accept: 'text/html' } })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /id="root"/)
    assert.equal(site.hits['/client.json'], undefined)
    assert.equal(dns.calls.length, 0)
    // A client_id thoth would never fetch is refused there already, sending the browser nowhere.
    const bad = await h.app.request(`/oauth/authorize?${q.replace(encodeURIComponent(clientId), encodeURIComponent('https://127.0.0.1/client.json'))}`, { headers: { accept: 'application/json' }, redirect: 'manual' })
    assert.equal(bad.status, 400)
    assert.equal(dns.calls.length, 0)

    // The consent page asks, with the session: fetched now; the domain is the document's host.
    const asked = await h.admin('GET', `/api/oauth/authorize?${q}`)
    assert.equal(asked.status, 200, asked.text)
    assert.deepEqual(asked.body.client, { id: clientId, name: CLIENT, redirectUri: CALLBACK, host: HOST })
    assert.equal(site.hits['/client.json'], 1)
    // A client that registered itself has no host to show.
    const reg = await h.app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: m.aKeyName(), redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }) })
    const regId = (await reg.json() as { client_id: string }).client_id
    const regAsked = await h.admin('GET', `/api/oauth/authorize?${q.replace(encodeURIComponent(clientId), regId)}`)
    assert.equal(regAsked.body.client.host, null)

    // A redirect URI the document doesn't list: nowhere to send the browser.
    const wrong = await h.admin('GET', `/api/oauth/authorize?${q.replace(encodeURIComponent(CALLBACK), encodeURIComponent('https://evil.example/cb'))}`)
    assert.deepEqual([wrong.status, wrong.body.error, wrong.body.redirect], [400, 'invalid_redirect_uri', undefined])

    // Approved (the document comes from the cache), then the code for tokens with no secret, as a public client.
    const approved = await h.admin('POST', '/api/oauth/authorize', { query: q, approve: true, confirm: h.users.admin.password })
    assert.equal(approved.status, 200, approved.text)
    assert.equal(site.hits['/client.json'], 1)
    const back = new URL(approved.body.redirect)
    assert.equal(back.searchParams.get('state'), state)
    const form = (fields: Record<string, string>) => h.app.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() })
    const tok = await form({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier, resource: RESOURCE })
    assert.equal(tok.status, 200)
    const tokens = await tok.json() as { access_token: string; refresh_token: string; scope: string }
    assert.equal(tokens.scope, 'read')
    const init = await h.app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    })
    assert.equal(init.status, 200)
    // Refreshing needs no fetch either: the approved client was kept.
    const refreshed = await form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId })
    assert.equal(refreshed.status, 200)
    assert.equal(site.hits['/client.json'], 1)
    // The authorization is a key named after the client.
    const keys = await h.admin('GET', '/api/keys')
    const key = (keys.body.keys as { name: string; client: { id: string; redirectUris: string[] } | null }[]).find((k) => k.client?.id === clientId)
    assert.deepEqual([key?.name, key?.client?.redirectUris], [CLIENT, [CALLBACK]])

    // Documents that can't be used: the page hears why and from which host, never anything they said.
    const refusal = async (id: string) => {
      const r = await h.admin('GET', `/api/oauth/authorize?${q.replace(encodeURIComponent(clientId), encodeURIComponent(id))}`)
      assert.equal(r.status, 400, id)
      assert.equal(r.body.error, 'invalid_client_metadata', id)
      assert.equal(r.body.redirect, undefined, id)
      return [r.body.reason, r.body.host]
    }
    assert.deepEqual(await refusal(`${site.base}/js.json`), ['invalid_redirect_uri', HOST])
    assert.deepEqual(await refusal(`${site.base}/implicit.json`), ['invalid_client_metadata', HOST])
    assert.deepEqual(await refusal(`https://intranet.test:${new URL(site.base).port}/client.json`), ['blocked_address', 'intranet.test'])
    // And the answer can't approve one either.
    const post = await h.admin('POST', '/api/oauth/authorize', { query: q.replace(encodeURIComponent(clientId), encodeURIComponent(`${site.base}/js.json`)), approve: true })
    assert.equal(post.status, 400)
  } finally {
    await h.close()
    await site.close()
  }
})
