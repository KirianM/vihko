// OAuth 2.1 for the MCP server (m3 §7): only with THOTH_PUBLIC_URL and the
// MCP server on; metadata (RFC 8414, RFC 9728), dynamic registration (RFC
// 7591, which the admin may turn off), authorization code with PKCE S256,
// consent as a key (read-only and every folder unless chosen otherwise),
// short access tokens and rotating refresh tokens, exact redirect URIs and
// the resource (RFC 8707); and at /mcp, the tools the authorization allows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { OAuthServer, REGISTRATIONS_PER_HOUR, REGISTRATION_ADDRESSES, WindowLimit, publicUrlFrom, sameRedirect } from '@thoth/server'
import { setup } from './_agents.ts'

const PUBLIC = 'https://notas.example.org'
const RESOURCE = `${PUBLIC}/mcp`
const REDIRECT = 'https://claude.example/api/mcp/auth_callback'
const FILES = {
  'proyectos/plan.md': '# Plan\n\nPaso uno.\n',
  'proyectos/secreto.md': '---\nai: false\n---\n# Secreto\n',
  'diario/hoy.md': '# Hoy\n',
}
const READ = ['changes_since', 'daily_note', 'get_note', 'history', 'list_folder', 'related', 'resolve_link', 'search']
const ALL = [...READ, 'create_note', 'delete', 'edit_note', 'move', 'revert_change'].sort()

type H = Awaited<ReturnType<typeof setup>>

/** A PKCE pair (RFC 7636, S256). */
function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function raw(h: H, method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}) {
  const res = await h.app.request(path, { method, headers: init.headers ?? {}, body: init.body, redirect: 'manual' })
  const text = await res.text()
  let body: any = null
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body, text, headers: res.headers }
}

const json = (h: H, method: string, path: string, body: unknown) =>
  raw(h, method, path, { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

const form = (h: H, path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  raw(h, 'POST', path, { body: new URLSearchParams(fields).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } })

async function register(h: H, meta: Record<string, unknown> = {}) {
  const r = await json(h, 'POST', '/oauth/register', { client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', ...meta })
  assert.equal(r.status, 201, r.text)
  return r.body as { client_id: string; client_secret?: string; client_name: string; redirect_uris: string[]; token_endpoint_auth_method: string }
}

/** The query of an authorization request, as a client builds it. */
function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-123', resource: RESOURCE, ...extra }).toString()
}

/**
 * The person's side: the consent page asks who is asking, then approves (or
 * not) with what they chose. Returns where the browser is sent.
 */
async function consent(h: H, query: string, choice: { approve?: boolean; canWrite?: boolean; folders?: string[] } = {}, who: 'noa' | 'ana' = 'noa') {
  const as = who === 'noa' ? h.noa : h.ana
  const r = await as('POST', '/api/oauth/authorize', { query, approve: choice.approve ?? true, confirm: 'a-long-password', ...(choice.canWrite === undefined ? {} : { canWrite: choice.canWrite }), ...(choice.folders ? { folders: choice.folders } : {}) })
  return r
}

/** The whole dance for one client: consent, then the code for tokens. */
async function authorize(h: H, clientId: string, choice: { canWrite?: boolean; folders?: string[] } = {}) {
  const { verifier, challenge } = pkce()
  const r = await consent(h, authorizeQuery(clientId, challenge), choice)
  assert.equal(r.status, 200, r.text)
  const back = new URL(r.body.redirect)
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT)
  assert.equal(back.searchParams.get('state'), 'st-123')
  assert.equal(back.searchParams.get('iss'), PUBLIC)
  const code = back.searchParams.get('code')!
  const t = await form(h, '/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: RESOURCE })
  assert.equal(t.status, 200, t.text)
  assert.equal(t.headers.get('cache-control'), 'no-store')
  return { ...(t.body as { access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string }), code, verifier }
}

const mcpPost = (h: H, token: string | null, headers: Record<string, string> = {}) =>
  raw(h, 'POST', '/mcp', {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers },
  })

test('THOTH_PUBLIC_URL: only an https origin', () => {
  assert.equal(publicUrlFrom(undefined), null)
  assert.equal(publicUrlFrom(' '), null)
  assert.equal(publicUrlFrom('https://notas.example.org'), PUBLIC)
  assert.equal(publicUrlFrom('https://notas.example.org/'), PUBLIC)
  assert.equal(publicUrlFrom('https://notas.example.org:8443'), 'https://notas.example.org:8443')
  for (const bad of ['http://notas.example.org', 'notas.example.org', 'https://notas.example.org/thoth', 'https://notas.example.org/?x=1', 'https://u:p@notas.example.org']) {
    assert.throws(() => publicUrlFrom(bad), /THOTH_PUBLIC_URL/, bad)
  }
})

test('redirect URIs: exactly as registered; a loopback one on any port', () => {
  assert.ok(sameRedirect(REDIRECT, REDIRECT))
  assert.ok(!sameRedirect(REDIRECT, `${REDIRECT}/`))
  assert.ok(!sameRedirect(REDIRECT, `${REDIRECT}?x=1`))
  assert.ok(!sameRedirect(REDIRECT, 'https://claude.example:444/api/mcp/auth_callback'))
  assert.ok(sameRedirect('http://localhost:3334/oauth/callback', 'http://localhost:4040/oauth/callback'))
  assert.ok(sameRedirect('http://127.0.0.1:3334/cb', 'http://127.0.0.1:5000/cb'))
  assert.ok(!sameRedirect('http://127.0.0.1:3334/cb', 'http://localhost:3334/cb'))
  assert.ok(!sameRedirect('http://localhost:3334/oauth/callback', 'http://localhost:4040/other'))
})

test('without THOTH_PUBLIC_URL, or with the MCP server off, OAuth doesn\'t exist: 404 everywhere; /mcp takes keys only', async () => {
  for (const variant of ['no public URL', 'MCP off'] as const) {
    const h = await setup({ files: FILES, ui: true, ...(variant === 'MCP off' ? { publicUrl: PUBLIC } : {}) })
    try {
      if (variant === 'no public URL') await h.enableMcp()
      const { challenge } = pkce()
      const q = `/oauth/authorize?${authorizeQuery('whatever', challenge)}`
      for (const [m, p] of [
        ['GET', '/.well-known/oauth-protected-resource/mcp'], ['GET', '/.well-known/oauth-protected-resource'],
        ['GET', '/.well-known/oauth-authorization-server'], ['GET', '/.well-known/openid-configuration'],
        ['POST', '/oauth/register'], ['GET', q], ['POST', '/oauth/token'], ['POST', '/oauth/revoke'], ['GET', '/oauth/anything'],
      ] as const) {
        const r = await raw(h, m, p, { headers: { accept: 'text/html' } })
        assert.equal(r.status, 404, `${variant}: ${m} ${p}`)
        assert.ok(!r.text.includes('id="root"'), `${variant}: ${m} ${p} never falls to the UI`)
      }
      for (const m of ['GET', 'POST'] as const) assert.equal((await h.noa(m, `/api/oauth/authorize?${authorizeQuery('x', challenge)}`, m === 'POST' ? { query: '', approve: true } : undefined)).status, 404, `${variant}: ${m} /api/oauth/authorize`)
      const integ = await h.noa('GET', '/api/integrations')
      assert.equal(integ.body.publicUrl, variant === 'MCP off' ? PUBLIC : null)
      if (variant === 'MCP off') {
        assert.equal((await mcpPost(h, null)).status, 404)
        continue
      }
      // /mcp: a plain challenge, with no metadata to go looking for; an OAuth-looking token is just a bad key.
      const none = await mcpPost(h, null)
      assert.equal(none.status, 401)
      assert.equal(none.headers.get('www-authenticate'), 'Bearer')
      const fake = await mcpPost(h, `thoth_oat_${randomBytes(32).toString('base64url')}`)
      assert.equal(fake.status, 401)
      assert.equal(fake.headers.get('www-authenticate'), 'Bearer error="invalid_token"')
      const { token } = await h.newKey({ name: 'Clave' })
      assert.equal((await mcpPost(h, token)).status, 200)
    } finally { await h.close() }
  }
})

test('the full flow: discovery, registration, consent with PKCE, tokens, refresh, revocation, and /mcp with what was granted', async () => {
  const h = await setup({ files: FILES, publicUrl: PUBLIC, ui: true })
  try {
    await h.enableMcp()
    // Discovery, from the 401 of /mcp.
    const first = await mcpPost(h, null)
    assert.equal(first.status, 401)
    assert.equal(first.headers.get('www-authenticate'), `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`)
    const prm = await raw(h, 'GET', '/.well-known/oauth-protected-resource/mcp')
    assert.deepEqual(prm.body, { resource: RESOURCE, authorization_servers: [PUBLIC], bearer_methods_supported: ['header'], resource_name: 'thoth' })
    const as = (await raw(h, 'GET', '/.well-known/oauth-authorization-server')).body
    assert.equal(as.issuer, PUBLIC)
    assert.equal(as.authorization_endpoint, `${PUBLIC}/oauth/authorize`)
    assert.equal(as.token_endpoint, `${PUBLIC}/oauth/token`)
    assert.equal(as.registration_endpoint, `${PUBLIC}/oauth/register`)
    assert.deepEqual(as.code_challenge_methods_supported, ['S256'])
    assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token'])

    // Registration: a public client (PKCE, no secret).
    const client = await register(h)
    assert.equal(client.client_secret, undefined)
    assert.equal(client.token_endpoint_auth_method, 'none')
    assert.deepEqual(client.redirect_uris, [REDIRECT])

    // The authorization request: the page the UI shows, and what it asks the server.
    const { verifier, challenge } = pkce()
    const query = authorizeQuery(client.client_id, challenge)
    const page = await raw(h, 'GET', `/oauth/authorize?${query}`, { headers: { accept: 'text/html' } })
    assert.equal(page.status, 200)
    assert.match(page.text, /id="root"/)
    // Without a session, the page asks to sign in first (its API needs one).
    assert.equal((await raw(h, 'GET', `/api/oauth/authorize?${query}`)).status, 401)
    const asked = await h.noa('GET', `/api/oauth/authorize?${query}`)
    assert.deepEqual(asked.body, { client: { id: client.client_id, name: 'Claude', redirectUri: REDIRECT, host: null }, canAuthorize: true })

    // Approved as it comes: read-only, every folder.
    const ok = await consent(h, query)
    assert.equal(ok.status, 200, ok.text)
    const back = new URL(ok.body.redirect)
    const code = back.searchParams.get('code')!
    assert.ok(code)
    const exchange = (fields: Record<string, string>) => form(h, '/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, ...fields })
    assert.equal((await exchange({ code_verifier: pkce().verifier })).body.error, 'invalid_grant', 'another verifier')
    assert.equal((await exchange({ redirect_uri: 'https://claude.example/other' })).body.error, 'invalid_grant', 'another redirect_uri')
    assert.equal((await exchange({ resource: 'https://elsewhere.example/mcp' })).body.error, 'invalid_target')
    const tokens = await exchange({ resource: RESOURCE })
    assert.equal(tokens.status, 200, tokens.text)
    assert.equal(tokens.body.token_type, 'Bearer')
    assert.equal(tokens.body.expires_in, 3600)
    assert.equal(tokens.body.scope, 'read')
    assert.match(tokens.body.access_token, /^thoth_oat_/)
    assert.match(tokens.body.refresh_token, /^thoth_ort_/)
    // A code works once; used again, what it gave goes too.
    const again = await exchange({})
    assert.equal(again.body.error, 'invalid_grant')
    assert.equal((await mcpPost(h, tokens.body.access_token)).status, 401, 'the tokens of a replayed code are revoked')

    // A read-only authorization: the tools that read, and none that write.
    const ro = await authorize(h, client.client_id)
    const reader = await h.mcp(ro.access_token)
    assert.deepEqual((await reader.client.listTools()).tools.map((t) => t.name).sort(), READ, 'read-only: no tool that writes')
    const found = await reader.call('search', { query: 'Paso' })
    assert.equal(found.error, false)
    assert.deepEqual(found.data.results.map((r: { path: string }) => r.path), ['proyectos/plan.md'])
    assert.equal((await reader.call('get_note', { path: 'proyectos/secreto.md' })).data.error, 'agent_denied', 'ai: false stays hidden')
    await assert.rejects(reader.client.callTool({ name: 'create_note', arguments: { path: 'x.md', text: 'x' } }))
    await reader.close()

    // The authorization is a key of noa's, named after the client, used via OAuth.
    let [key] = (await h.noa('GET', '/api/keys')).body.keys
    assert.equal(key.name, 'Claude')
    assert.equal(key.canWrite, false)
    assert.deepEqual(key.folders, [])
    assert.equal(key.lastVia, 'oauth')
    assert.ok(key.lastUsedAt)
    assert.deepEqual(key.client, { id: client.client_id, redirectUris: [REDIRECT] })
    assert.equal((await h.noa('GET', '/api/keys')).body.keys.length, 1, 'the replayed code\'s authorization is the same key')

    // Renamed by its person, then authorized again with write, in one folder: the same authorization changes, and keeps its name.
    assert.equal((await h.noa('PATCH', `/api/keys/${key.id}`, { name: 'Claude web' })).status, 200)
    const rw = await authorize(h, client.client_id, { canWrite: true, folders: ['proyectos'] })
    assert.equal(rw.scope, 'read write')
    const writer = await h.mcp(rw.access_token)
    assert.deepEqual((await writer.client.listTools()).tools.map((t) => t.name).sort(), ALL)
    const made = await writer.call('create_note', { path: 'proyectos/de-claude.md', text: '# De Claude\n' })
    assert.equal(made.error, false, made.raw)
    assert.equal((await writer.call('create_note', { path: 'diario/no.md', text: 'x' })).error, true, 'outside its folders')
    await writer.close()
    const keys = (await h.noa('GET', '/api/keys')).body.keys
    assert.equal(keys.length, 1)
    assert.equal(keys[0].id, key.id)
    assert.deepEqual([keys[0].name, keys[0].canWrite, keys[0].folders], ['Claude web', true, ['proyectos']])
    // The history names the authorization, on noa's behalf, via OAuth.
    await h.settle()
    const versions = (await h.noa('GET', h.url('/api/history/versions', { path: 'proyectos/de-claude.md' }))).body.versions
    assert.deepEqual(versions[0].authors[0], { kind: 'agent', id: key.id, name: 'Claude web', onBehalfOf: { id: h.users.noa.id, name: 'noa' }, via: 'oauth', key: `agent:${key.id}` })

    // An access token is only for /mcp: the HTTP API never takes it.
    await h.enableApi()
    assert.equal((await h.withKey(rw.access_token)('GET', '/api/tree')).status, 401)

    // Refresh: a new pair; the old refresh token, used again, takes its chain with it.
    const refresh = (token: string) => form(h, '/oauth/token', { grant_type: 'refresh_token', refresh_token: token, client_id: client.client_id })
    const next = await refresh(rw.refresh_token)
    assert.equal(next.status, 200, next.text)
    assert.notEqual(next.body.refresh_token, rw.refresh_token)
    assert.equal((await mcpPost(h, next.body.access_token)).status, 200)
    assert.equal((await refresh(rw.refresh_token)).body.error, 'invalid_grant')
    assert.equal((await mcpPost(h, next.body.access_token)).status, 401, 'a replayed refresh token revokes its chain')
    assert.equal((await refresh(next.body.refresh_token)).body.error, 'invalid_grant')
    // Another client's refresh token isn't this one's.
    const other = await register(h, { client_name: 'Otro' })
    const fresh = await authorize(h, client.client_id)
    assert.equal((await form(h, '/oauth/token', { grant_type: 'refresh_token', refresh_token: fresh.refresh_token, client_id: other.client_id })).body.error, 'invalid_grant')

    // An hour later the access token is over; the refresh token still works.
    h.clock.now = new Date(h.clock.now.getTime() + 3601_000)
    assert.equal((await mcpPost(h, fresh.access_token)).status, 401)
    const later = await refresh(fresh.refresh_token)
    assert.equal(later.status, 200, later.text)
    assert.equal((await mcpPost(h, later.body.access_token)).status, 200)

    // Revoked in «Agents and API»: its tokens stop at once, and refreshing fails.
    assert.equal((await h.noa('DELETE', `/api/keys/${key.id}`)).status, 200)
    const revoked = await mcpPost(h, later.body.access_token)
    assert.equal(revoked.status, 401)
    assert.equal(revoked.headers.get('www-authenticate'), `Bearer error="invalid_token", resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`)
    assert.equal((await refresh(later.body.refresh_token)).body.error, 'invalid_grant')
    // Authorizing again makes a new authorization; the revoked one stays revoked.
    await authorize(h, client.client_id)
    const after = (await h.noa('GET', '/api/keys')).body.keys
    assert.deepEqual(after.map((k: { status: string }) => k.status).sort(), ['active', 'revoked'])
    // With the MCP server off, the tokens of a live authorization reach nothing.
    const live = await authorize(h, client.client_id)
    await h.enableMcp(false)
    assert.equal((await mcpPost(h, live.access_token)).status, 404)
  } finally { await h.close() }
})

test('the authorization request: unknown clients and redirect URIs are never redirected to; other errors go back to the client', async () => {
  const h = await setup({ files: FILES, publicUrl: PUBLIC, ui: true })
  try {
    await h.enableMcp()
    const client = await register(h, { redirect_uris: [REDIRECT, 'http://localhost:3334/oauth/callback'] })
    const { challenge } = pkce()
    const get = (q: string, accept = 'text/html') => raw(h, 'GET', `/oauth/authorize?${q}`, { headers: { accept } })

    // Unknown client, or a redirect URI it didn't register: nowhere safe to send the answer.
    for (const [q, error] of [
      [authorizeQuery('nope', challenge), 'invalid_client'],
      [authorizeQuery(client.client_id, challenge, { redirect_uri: 'https://attacker.example/cb' }), 'invalid_redirect_uri'],
      [authorizeQuery(client.client_id, challenge, { redirect_uri: `${REDIRECT}/x` }), 'invalid_redirect_uri'],
      [authorizeQuery(client.client_id, challenge, { redirect_uri: '' }), 'invalid_redirect_uri'],
    ] as const) {
      const page = await get(q)
      assert.equal(page.status, 200, 'the page tells the person')
      assert.equal(page.headers.get('location'), null)
      const asJson = await get(q, 'application/json')
      assert.deepEqual([asJson.status, asJson.body.error], [400, error])
      const api = await h.noa('GET', `/api/oauth/authorize?${q}`)
      assert.deepEqual([api.status, api.body.error, api.body.redirect], [400, error, undefined])
      assert.equal((await consent(h, q)).body.error, error)
    }
    // A loopback redirect URI on another port is the same one (RFC 8252).
    const loop = authorizeQuery(client.client_id, challenge, { redirect_uri: 'http://localhost:40123/oauth/callback' })
    assert.equal((await get(loop)).status, 200)
    assert.match((await consent(h, loop)).body.redirect, /^http:\/\/localhost:40123\/oauth\/callback\?code=/)

    // The rest go back to the client with the error and its state.
    for (const [extra, error] of [
      [{ code_challenge: '' }, 'invalid_request'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: 'short' }, 'invalid_request'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ resource: 'https://elsewhere.example/mcp' }, 'invalid_target'],
    ] as const) {
      const r = await get(authorizeQuery(client.client_id, challenge, extra))
      assert.equal(r.status, 302, JSON.stringify(extra))
      const to = new URL(r.headers.get('location')!)
      assert.equal(`${to.origin}${to.pathname}`, REDIRECT)
      assert.deepEqual([to.searchParams.get('error'), to.searchParams.get('state'), to.searchParams.get('iss')], [error, 'st-123', PUBLIC])
    }
    // Without `resource`, it's this server's /mcp.
    assert.equal((await get(authorizeQuery(client.client_id, challenge, { resource: '' }).replace('&resource=', '&x='))).status, 200)

    // Denied: the client hears access_denied, with its state.
    const denied = new URL((await consent(h, authorizeQuery(client.client_id, challenge), { approve: false })).body.redirect)
    assert.deepEqual([denied.searchParams.get('error'), denied.searchParams.get('state'), denied.searchParams.get('code')], ['access_denied', 'st-123', null])
    // Folders are checked like a key's.
    assert.equal((await consent(h, authorizeQuery(client.client_id, challenge), { folders: ['../fuera'] })).status, 400)

    // A code lives five minutes.
    const { verifier, challenge: c2 } = pkce()
    const code = new URL((await consent(h, authorizeQuery(client.client_id, c2))).body.redirect).searchParams.get('code')!
    h.clock.now = new Date(h.clock.now.getTime() + 5 * 60_000 + 1000)
    const late = await form(h, '/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier })
    assert.equal(late.body.error, 'invalid_grant')
    assert.equal((await form(h, '/oauth/token', { grant_type: 'password', client_id: client.client_id })).body.error, 'unsupported_grant_type')
    assert.equal((await raw(h, 'POST', '/oauth/token', { body: '{}', headers: { 'content-type': 'application/json' } })).body.error, 'invalid_request')
  } finally { await h.close() }
})

test('registration: checked, confidential clients need their secret, and the admin can turn it off', async () => {
  const h = await setup({ files: FILES, publicUrl: PUBLIC, ui: true })
  try {
    await h.enableMcp()
    for (const [meta, error] of [
      [{ redirect_uris: [] }, 'invalid_redirect_uri'],
      [{ redirect_uris: ['javascript:alert(1)'] }, 'invalid_redirect_uri'],
      [{ redirect_uris: ['data:text/html,x'] }, 'invalid_redirect_uri'],
      [{ redirect_uris: ['http://claude.example/cb'] }, 'invalid_redirect_uri'],
      [{ redirect_uris: ['https://claude.example/cb#x'] }, 'invalid_redirect_uri'],
      [{ redirect_uris: ['/cb'] }, 'invalid_redirect_uri'],
      [{ grant_types: ['client_credentials'] }, 'invalid_client_metadata'],
      [{ response_types: ['token'] }, 'invalid_client_metadata'],
      [{ token_endpoint_auth_method: 'private_key_jwt' }, 'invalid_client_metadata'],
    ] as const) {
      const r = await json(h, 'POST', '/oauth/register', { client_name: 'x', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', ...meta })
      assert.deepEqual([r.status, r.body.error], [400, error], JSON.stringify(meta))
    }
    // An app's own scheme and loopback http are fine; the name falls back to the redirect URI's host.
    const app = await register(h, { client_name: undefined, redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback', 'http://127.0.0.1:9/cb'] })
    assert.equal(app.client_name, 'anysphere.cursor-mcp')
    const long = await register(h, { client_name: `  Mi\u0000cliente ${'x'.repeat(200)}` })
    assert.equal(long.client_name.length, 100)
    assert.ok(!/[\u0000-\u001f]/.test(long.client_name))

    // RFC 7591's default is a confidential client: it gets a secret, and must use it.
    const conf = await json(h, 'POST', '/oauth/register', { client_name: 'Servidor', redirect_uris: [REDIRECT] })
    assert.equal(conf.body.token_endpoint_auth_method, 'client_secret_basic')
    const secret = conf.body.client_secret as string
    assert.ok(secret)
    const code = async () => {
      const { verifier, challenge } = pkce()
      const c = new URL((await consent(h, authorizeQuery(conf.body.client_id, challenge))).body.redirect).searchParams.get('code')!
      return { grant_type: 'authorization_code', code: c, redirect_uri: REDIRECT, code_verifier: verifier }
    }
    const basic = (id: string, s: string) => ({ authorization: `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(s)}`).toString('base64')}` })
    const missing = await form(h, '/oauth/token', { ...(await code()), client_id: conf.body.client_id })
    assert.deepEqual([missing.status, missing.body.error], [401, 'invalid_client'])
    const wrong = await form(h, '/oauth/token', await code(), basic(conf.body.client_id, 'nope'))
    assert.deepEqual([wrong.status, wrong.body.error], [401, 'invalid_client'])
    assert.equal((await form(h, '/oauth/token', await code(), basic(conf.body.client_id, secret))).status, 200)
    assert.equal((await form(h, '/oauth/token', { ...(await code()), client_id: conf.body.client_id, client_secret: secret })).status, 200)
    assert.equal((await form(h, '/oauth/token', { ...(await code()), client_id: 'nope' })).body.error, 'invalid_client')

    // Turned off by the admin: no registration, and the metadata stops offering it; registered clients keep working.
    assert.equal((await h.ana('PUT', '/api/admin/integrations', { oauthRegistration: false })).status, 403)
    assert.equal((await h.noa('PUT', '/api/admin/integrations', { oauthRegistration: false })).body.oauthRegistration, false)
    assert.equal((await json(h, 'POST', '/oauth/register', { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })).status, 404)
    assert.equal((await raw(h, 'GET', '/.well-known/oauth-authorization-server')).body.registration_endpoint, undefined)
    const { challenge } = pkce()
    assert.equal((await consent(h, authorizeQuery(app.client_id, challenge, { redirect_uri: 'http://127.0.0.1:9/cb' }))).status, 200)
    await h.noa('PUT', '/api/admin/integrations', { oauthRegistration: true })

    // A client registered and never authorized is forgotten after a day (registration is open to anyone).
    const idle = await register(h, { client_name: 'Nadie' })
    h.clock.now = new Date(h.clock.now.getTime() + 25 * 3600_000)
    await register(h)
    assert.equal((await h.noa('GET', `/api/oauth/authorize?${authorizeQuery(idle.client_id, challenge)}`)).body.error, 'invalid_client')
    // One that was authorized stays.
    assert.equal((await h.noa('GET', `/api/oauth/authorize?${authorizeQuery(conf.body.client_id, challenge)}`)).status, 200)
  } finally { await h.close() }
})

test('registration is limited per address: 5 an hour, then 429 with Retry-After; other addresses go on', async () => {
  const h = await setup({ files: FILES, publicUrl: PUBLIC, ui: true })
  try {
    await h.enableMcp()
    /** A registration from `ip` (the socket's address, as @hono/node-server gives it). */
    const from = async (ip: string, meta: Record<string, unknown> = {}) => {
      const res = await h.app.request('/oauth/register', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', ...meta }),
      }, { incoming: { socket: { remoteAddress: ip } } })
      return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json() as Record<string, unknown> }
    }
    // A refused request doesn't count: only registrations fill the table.
    for (let i = 0; i < 8; i++) assert.equal((await from('203.0.113.5', { redirect_uris: ['javascript:x'] })).status, 400)
    for (let i = 0; i < REGISTRATIONS_PER_HOUR; i++) assert.equal((await from('203.0.113.5')).status, 201, `registration ${i + 1}`)
    const sixth = await from('203.0.113.5')
    assert.equal(sixth.status, 429)
    assert.equal(sixth.body.error, 'temporarily_unavailable')
    assert.equal(sixth.retryAfter, '3600')
    // IPv4-mapped is the same address; an IPv6 client counts by its /64.
    assert.equal((await from('::ffff:203.0.113.5')).status, 429)
    assert.equal((await from('198.51.100.7')).status, 201)
    for (let i = 0; i < REGISTRATIONS_PER_HOUR; i++) assert.equal((await from(`2001:db8:1:2::${i + 1}`)).status, 201)
    assert.equal((await from('2001:db8:1:2:ffff::9')).status, 429)
    assert.equal((await from('2001:db8:1:3::1')).status, 201)
    // Half an hour later, still waiting (and told how long); an hour after the first, free again.
    h.clock.now = new Date(h.clock.now.getTime() + 30 * 60_000)
    const later = await from('203.0.113.5')
    assert.equal(later.status, 429)
    assert.ok(Number(later.retryAfter) > 1700 && Number(later.retryAfter) <= 1800, String(later.retryAfter))
    h.clock.now = new Date(h.clock.now.getTime() + 31 * 60_000)
    assert.equal((await from('203.0.113.5')).status, 201)
  } finally { await h.close() }
})

test('the registration limit remembers a bounded number of addresses, forgetting the one seen longest ago', () => {
  const limit = new WindowLimit({ max: 2, windowMs: 1000, addresses: 3 })
  for (const ip of ['a', 'a', 'b', 'c']) limit.record(ip, 0)
  assert.equal(limit.wait('a', 10), 1)
  limit.record('d', 10)
  assert.equal(limit.size, 3)
  assert.equal(limit.wait('a', 10), 0, 'a was seen longest ago: forgotten')
  // Past the window, whatever expired goes first.
  limit.record('e', 2000)
  assert.equal(limit.size, 1)
  assert.equal(limit.wait('e', 2000), 0)
  assert.equal(REGISTRATION_ADDRESSES, 10_000)
})

test('who may authorize: a member only while members may create keys; an agent never', async () => {
  const h = await setup({ files: FILES, publicUrl: PUBLIC, ui: true })
  try {
    await h.enableMcp()
    const client = await register(h)
    const { challenge } = pkce()
    const q = authorizeQuery(client.client_id, challenge)
    assert.equal((await h.ana('GET', `/api/oauth/authorize?${q}`)).body.canAuthorize, true)
    assert.equal((await consent(h, q, {}, 'ana')).status, 200)
    assert.equal((await h.noa('PUT', '/api/admin/integrations', { membersCanCreateKeys: false })).status, 200)
    assert.equal((await h.ana('GET', `/api/oauth/authorize?${q}`)).body.canAuthorize, false)
    assert.deepEqual([(await consent(h, q, {}, 'ana')).status, (await consent(h, q, {}, 'ana')).body.error], [403, 'forbidden'])
    // Saying no is always possible.
    assert.equal((await consent(h, q, { approve: false }, 'ana')).status, 200)
    assert.equal((await h.noa('GET', `/api/oauth/authorize?${q}`)).body.canAuthorize, true, 'the admin always may')
    // A key never reaches the consent routes.
    await h.enableApi()
    const { token } = await h.newKey({ name: 'k', canWrite: true })
    assert.equal((await h.withKey(token)('POST', '/api/oauth/authorize', { query: q, approve: true })).status, 404)
    // Nor another site: the consent is a write with the session (CSRF).
    assert.equal((await h.noa('POST', '/api/oauth/authorize', { query: q, approve: true }, { origin: 'https://attacker.example' })).status, 403)
  } finally { await h.close() }
})

test('revocation by the client (RFC 7009): a refresh token takes its chain; another client\'s tokens are left alone', async () => {
  const h = await setup({ files: FILES, publicUrl: PUBLIC, ui: true })
  try {
    await h.enableMcp()
    const a = await register(h)
    const b = await register(h, { client_name: 'B' })
    const t = await authorize(h, a.client_id)
    // Another client can't revoke it (and hears nothing about it).
    assert.equal((await form(h, '/oauth/revoke', { token: t.refresh_token, client_id: b.client_id })).status, 200)
    assert.equal((await mcpPost(h, t.access_token)).status, 200)
    assert.equal((await form(h, '/oauth/revoke', { token: 'nothing', client_id: a.client_id })).status, 200)
    assert.equal((await form(h, '/oauth/revoke', { token: t.refresh_token, client_id: a.client_id })).status, 200)
    assert.equal((await mcpPost(h, t.access_token)).status, 401)
    assert.equal(OAuthServer.isAccessToken(t.access_token), true)
    assert.equal(OAuthServer.isAccessToken(t.refresh_token), false)
    // The refresh token isn't a bearer token for /mcp either.
    const u = await authorize(h, a.client_id)
    assert.equal((await mcpPost(h, u.refresh_token)).status, 401)
  } finally { await h.close() }
})
