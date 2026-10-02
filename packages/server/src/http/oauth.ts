// OAuth's addresses (oauth.ts). None exists without VIHKO_PUBLIC_URL or with
// the MCP server off: 404, as for any address that doesn't. Nothing under
// /oauth or /.well-known falls through to the UI, except the authorization
// page itself, which the UI shows (web: Consent.tsx).
//
// For clients, no session (their own credentials, or none):
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
//   GET  /.well-known/oauth-authorization-server       RFC 8414
//   POST /oauth/register                               RFC 7591 (only while the admin has it on); 5 an hour per address
//   GET  /oauth/authorize                              checked here, then the UI's consent page
//   POST /oauth/token                                  code (PKCE) or refresh token
//   POST /oauth/revoke                                 RFC 7009
// For the consent page, with the person's session (http/routes.ts: `session`):
//   GET  /api/oauth/authorize?<the request's query>    who is asking (fetching a client's metadata document
//                                                      if its client_id is one's URL), and whether this person may authorize
//   POST /api/oauth/authorize { query, approve, canWrite?, folders?, confirm? } → { redirect }; approving
//                                                      needs `confirm`: the current TOTP code, or the password without one
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { User } from '../auth.ts'
import type { Access } from '../access.ts'
import type { Integrations } from '../integrations.ts'
import { OAuthRequestError, nameFitsDomain, type AuthorizeCheck, type OAuthServer } from '../oauth.ts'

type Env = { Variables: { user: User; token: string; access: Access } }

export interface OAuthRoutesDeps {
  oauth: OAuthServer
  integrations: Integrations
  /** Whether the UI is served (the consent page); without it, a bad request is answered in JSON only. */
  ui: boolean
  /** Who is asking, by address (http/clientIp.ts), for the limit on registrations. */
  clientAddress: (c: Context) => string
  /**
   * Confirms that the person is there now (the current TOTP code, or the
   * password without one), even with a session: null if so, the response otherwise.
   */
  confirm: (c: Context<Env>, confirm: unknown) => Promise<Response | null>
}

const MAX_BODY = 64 * 1024

export function oauthRoutes(app: Hono<Env>, deps: OAuthRoutesDeps) {
  const { oauth, integrations } = deps
  const none = (c: Context) => c.json({ error: 'not_found', message: 'does not exist' }, 404)
  const oauthFail = (c: Context, err: OAuthRequestError) =>
    c.json(err.body(), err.status, { 'Cache-Control': 'no-store', ...(err.retryAfter === null ? {} : { 'Retry-After': String(err.retryAfter) }) })
  const limit = bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: 'invalid_request', error_description: 'body too large' }, 413) })

  // --- Discovery ----------------------------------------------------------------
  const resourceMetadata = (c: Context) => (oauth.available() ? c.json(oauth.resourceMetadata()) : none(c))
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMetadata)
  app.get('/.well-known/oauth-protected-resource', resourceMetadata)
  app.get('/.well-known/oauth-authorization-server', (c) => (oauth.available() ? c.json(oauth.metadata()) : none(c)))
  // Nothing else is there, and never the UI (a client probing for metadata must not get a page).
  app.all('/.well-known/*', none)

  // --- For clients ----------------------------------------------------------------

  /** A form body (RFC 6749: application/x-www-form-urlencoded). */
  const form = async (c: Context): Promise<URLSearchParams> => {
    if (!/^application\/x-www-form-urlencoded\b/i.test(c.req.header('content-type') ?? '')) {
      throw new OAuthRequestError('invalid_request', 'expected application/x-www-form-urlencoded')
    }
    return new URLSearchParams(await c.req.text())
  }

  app.post('/oauth/register', limit, async (c) => {
    if (!oauth.registrationOpen()) return none(c)
    let body: unknown
    try { body = await c.req.json() } catch { return oauthFail(c, new OAuthRequestError('invalid_client_metadata', 'expected a JSON object')) }
    try {
      return c.json(oauth.register(body, deps.clientAddress(c)), 201, { 'Cache-Control': 'no-store' })
    } catch (err) {
      if (err instanceof OAuthRequestError) return oauthFail(c, err)
      throw err
    }
  })

  // The authorization request. Checked before the page loads: one that isn't
  // valid gets the page, which says so once the person signs in (or, asked
  // for JSON, as mcp-remote does to find a stale registration, a 400). Never
  // a redirect to the client with the error, as RFC 6749 §4.1.2.1 would
  // have it: registration, when on, is open to anyone, so a registered redirect URI proves
  // nothing, and that would make this server a redirector to anywhere
  // (RFC 9700 §4.11.2). A good one gets the page, which signs in if needed
  // and asks.
  // A client named by its metadata document's URL isn't fetched here, before
  // anyone signed in: the page asks for it with the person's session.
  app.get('/oauth/authorize', async (c, next) => {
    if (!oauth.available()) return none(c)
    const check = oauth.precheckAuthorize((name) => c.req.query(name))
    if (check.ok === 'later') {
      c.header('Cache-Control', 'no-store')
      return next()
    }
    const wantsJson = /application\/json/i.test(c.req.header('accept') ?? '') && !/text\/html/i.test(c.req.header('accept') ?? '')
    if (!check.ok && (wantsJson || !deps.ui)) {
      return c.json({ error: check.error, error_description: 'description' in check ? check.description : 'unknown client or redirect_uri' }, 400)
    }
    c.header('Cache-Control', 'no-store')
    await next()
  })

  app.post('/oauth/token', limit, async (c) => {
    if (!oauth.available()) return none(c)
    try {
      return c.json(oauth.token(await form(c), c.req.header('authorization')), 200, { 'Cache-Control': 'no-store', Pragma: 'no-cache' })
    } catch (err) {
      if (err instanceof OAuthRequestError) return oauthFail(c, err)
      throw err
    }
  })

  app.post('/oauth/revoke', limit, async (c) => {
    if (!oauth.available()) return none(c)
    try {
      oauth.revokeToken(await form(c), c.req.header('authorization'))
      return c.body(null, 200, { 'Cache-Control': 'no-store' })
    } catch (err) {
      if (err instanceof OAuthRequestError) return oauthFail(c, err)
      throw err
    }
  })

  // Nothing else is there; the authorization page (above) goes on to the UI.
  app.all('/oauth/*', async (c, next) => (c.req.method === 'GET' && c.req.path === '/oauth/authorize' ? next() : none(c)))

  // --- For the consent page (session) -----------------------------------------

  /** An admin always may; a member, if the admin lets members create keys (an authorization is one). */
  const mayAuthorize = (c: Context<Env>) => c.get('user').role === 'admin' || integrations.view().membersCanCreateKeys
  // The page names what it can (an unknown client or redirect URI, a metadata
  // document); anything else is a request that isn't valid. Never an address to go to.
  const refused = (c: Context, check: Extract<AuthorizeCheck, { ok: false }>) =>
    c.json({
      error: 'description' in check ? 'invalid' : check.error, message: 'not a valid authorization request',
      // A metadata document that can't be used: why, and whose (the page names the host).
      ...(check.error === 'invalid_client_metadata' && 'reason' in check ? { reason: check.reason, host: check.host } : {}),
      // An app from a domain vihko.yaml doesn't allow: which one.
      ...(check.error === 'client_not_allowed' ? { host: check.host } : {}),
    }, 400)

  // Whoever asks here is signed in: a client named by a URL is fetched now (cimd.ts).
  app.get('/api/oauth/authorize', async (c) => {
    if (!oauth.available() || c.get('access').isAgent) return none(c)
    const check = await oauth.checkAuthorize((name) => c.req.query(name))
    if (!check.ok) return refused(c, check)
    const { client, redirectUri } = check.req
    // Where it comes from: its metadata document's host, or, for one that registered itself, where the code goes.
    // While vihko.yaml lists no domains, the page warns when its name doesn't fit that.
    const domain = client.host ?? new URL(redirectUri).hostname
    const nameMatchesDomain = oauth.domainsListed() || nameFitsDomain(client.name, domain)
    return c.json({ client: { id: client.id, name: client.name, redirectUri, host: client.host, domain, nameMatchesDomain }, canAuthorize: mayAuthorize(c) })
  })

  app.post('/api/oauth/authorize', async (c) => {
    if (!oauth.available() || c.get('access').isAgent) return none(c)
    const b = await c.req.json<{ query?: unknown; approve?: unknown; canWrite?: unknown; folders?: unknown; confirm?: unknown }>()
    if (typeof b !== 'object' || b === null || typeof b.query !== 'string' || typeof b.approve !== 'boolean') {
      return c.json({ error: 'invalid', message: 'expected { query, approve, canWrite?, folders?, confirm? }' }, 400)
    }
    const query = new URLSearchParams(b.query)
    const check = await oauth.checkAuthorize((name) => query.get(name))
    if (!check.ok) return refused(c, check)
    if (!b.approve) return c.json({ redirect: oauth.deny(check.req) })
    if (!mayAuthorize(c)) return c.json({ error: 'forbidden', message: 'members may not authorize clients here' }, 403)
    if (b.canWrite !== undefined && typeof b.canWrite !== 'boolean') return c.json({ error: 'invalid', message: 'canWrite must be true or false' }, 400)
    // Saying yes is confirmed at the moment: a session left open isn't enough; saying no never needs it.
    const unconfirmed = await deps.confirm(c, b.confirm)
    if (unconfirmed) return unconfirmed
    // Read-only and every folder unless the person chose otherwise.
    const folders = b.folders ?? []
    return c.json({ redirect: oauth.approve(check.req, c.get('user').id, { canWrite: b.canWrite === true, folders: folders as string[] }) })
  })
}
