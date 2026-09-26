// OAuth 2.1 for the MCP server (m3 §7, D-035), so that remote clients such as
// claude.ai can connect without anyone pasting a key. thoth is its own
// authorization server, as small as the flow allows:
//
// - It only exists when the server's administrator gives thoth a public HTTPS
//   address (THOTH_PUBLIC_URL) and the MCP switch is on. Otherwise every
//   OAuth address answers 404 and `/mcp` takes keys only.
// - Metadata: RFC 8414 (authorization server) and RFC 9728 (the protected
//   resource, `<public>/mcp`, named in the `WWW-Authenticate` of its 401).
// - Dynamic client registration (RFC 7591), which the thoth admin may turn
//   off (clients already registered keep working). Public clients (`none`)
//   and clients with a secret (`client_secret_post`/`_basic`). Registrations
//   are limited per address (http/oauth.ts).
// - Client ID Metadata Documents (cimd.ts): a `client_id` that is an https
//   URL describes the client there. It is fetched only when someone signed in
//   starts an authorization with it; approving keeps the client (as a public
//   one, `none`) so that the token endpoint knows it without fetching again.
// - Authorization code with PKCE S256, always; the redirect URI must be one
//   the client registered, exactly (a loopback one on any port, RFC 8252);
//   the `resource` (RFC 8707), if given, must be `<public>/mcp`.
// - Consent in the UI (web: Consent.tsx): whoever authorizes signs in, and
//   chooses as for a new key (read-only and every folder by default). The
//   authorization is a key of theirs (keys.ts), named after the client:
//   listed in «Agents and API», with its last use, and revocable, which
//   invalidates its tokens.
// - Access tokens for an hour; refresh tokens rotate on every use and expire
//   after 30 days unused. A refresh token (or a code) used twice revokes every
//   token that came from it. Only their sha256 is stored.
// - Access tokens are only for `/mcp` (the resource they were issued for):
//   the HTTP API takes keys, never these.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { OAuthClientInformationFull, OAuthMetadata, OAuthProtectedResourceMetadata, OAuthTokens } from '@modelcontextprotocol/server'
import type { AgentPrincipal } from './access.ts'
import { CimdError, ClientMetadataFetcher, isMetadataClientId, type CimdErrorCode } from './cimd.ts'
import type { Db } from './db.ts'
import type { Integrations } from './integrations.ts'
import { checkFolders, type ApiKeys } from './keys.ts'

export const ACCESS_PREFIX = 'thoth_oat_'
export const REFRESH_PREFIX = 'thoth_ort_'
/** How long a code waits to be exchanged. */
export const CODE_TTL_MS = 5 * 60_000
/** How long an access token lives. */
export const ACCESS_TTL_S = 3600
/** A refresh token unused for this long expires (each use gives a new one). */
export const REFRESH_IDLE_MS = 30 * 86_400_000
/** Clients registered but never authorized are forgotten after a day. */
export const UNUSED_CLIENT_MS = 86_400_000
/** At most this many clients waiting for an authorization at once (registration is open to anyone). */
export const MAX_UNUSED_CLIENTS = 500

const MAX_NAME = 100
const MAX_REDIRECT_URIS = 10
const MAX_URI = 2000
const MAX_STATE = 2000
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])
/** Schemes a redirect URI can never have: they'd run or read something in the browser. */
const BANNED_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:', 'filesystem:', 'ws:', 'wss:', 'ftp:'])

/** The `error` codes of RFC 6749 §4.1.2.1 and §5.2, RFC 7591 §3.2.2 and RFC 8707 that thoth uses. */
export type OAuthErrorCode =
  | 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unauthorized_client' | 'unsupported_grant_type'
  | 'unsupported_response_type' | 'access_denied' | 'invalid_target' | 'invalid_redirect_uri' | 'invalid_client_metadata'
  | 'temporarily_unavailable'

/** A request the authorization server refuses, as RFC 6749 words it (`error`, `error_description`). */
export class OAuthRequestError extends Error {
  readonly code: OAuthErrorCode
  readonly status: 400 | 401 | 429
  constructor(code: OAuthErrorCode, message: string, status: 400 | 401 | 429 = 400) {
    super(message)
    this.code = code
    this.status = status
  }

  body() {
    return { error: this.code, error_description: this.message }
  }
}

export type AuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic'
const AUTH_METHODS: readonly AuthMethod[] = ['none', 'client_secret_post', 'client_secret_basic']

/** A registered client. */
export interface OAuthClient {
  id: string
  name: string
  redirectUris: string[]
  authMethod: AuthMethod
  /**
   * For a client described by a metadata document: the host that served it
   * (its `client_id`'s), which the consent screen shows. Null for one that
   * registered itself: its name is only what it declared.
   */
  host: string | null
}

/** An authorization request that passed every check, waiting for the person's decision. */
export interface AuthorizeRequest {
  client: OAuthClient
  redirectUri: string
  codeChallenge: string
  state: string | null
  resource: string
}

/**
 * What an authorization request is: valid, or why not. Without a known
 * client and one of its redirect URIs there's nowhere safe to send the answer
 * (`redirect: null`: the person is told); otherwise the error goes back to
 * the client at its redirect URI.
 */
export type AuthorizeCheck =
  | { ok: true; req: AuthorizeRequest }
  | { ok: false; error: 'invalid_client' | 'invalid_redirect_uri'; redirect: null }
  // A metadata document that couldn't be fetched or used: why (never anything of its content), and from which host.
  | { ok: false; error: 'invalid_client_metadata'; redirect: null; reason: CimdErrorCode | 'invalid_redirect_uri' | 'invalid_client_metadata'; host: string }
  | { ok: false; error: OAuthErrorCode; redirect: string }

/** What the person decided on the consent screen. */
export interface Grant {
  canWrite: boolean
  folders: string[]
}

interface ClientRow { id: string; name: string; redirect_uris: string; auth_method: AuthMethod; secret_hash: string | null; created_at: string }
interface CodeRow { code_hash: string; client_id: string; user_id: string; redirect_uri: string; code_challenge: string; resource: string; can_write: number; folders: string; expires_at: string; used_family: string | null }
interface TokenRow { token_hash: string; kind: 'access' | 'refresh'; key_id: string; family: string; resource: string; expires_at: string; used_at: string | null }

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex')
const random = () => randomBytes(32).toString('base64url')

/**
 * THOTH_PUBLIC_URL: unset (no OAuth), or the HTTPS origin where thoth is
 * reached from outside (behind a reverse proxy), with nothing after it.
 */
export function publicUrlFrom(raw: string | undefined): string | null {
  const v = (raw ?? '').trim()
  if (!v) return null
  let u: URL
  try { u = new URL(v) } catch { throw new Error(`THOTH_PUBLIC_URL must be an address such as https://notes.example.com, not "${raw}"`) }
  if (u.protocol !== 'https:') throw new Error(`THOTH_PUBLIC_URL must be https: OAuth needs it (not "${raw}")`)
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error(`THOTH_PUBLIC_URL must be only the origin (https://host[:port]), where thoth answers at the root, not "${raw}"`)
  return u.origin
}

export interface OAuthOptions {
  /** state.db. */
  state: Db
  keys: ApiKeys
  integrations: Integrations
  /** THOTH_PUBLIC_URL (publicUrlFrom); null: OAuth doesn't exist. */
  publicUrl: string | null
  now?: () => Date
  /** Fetches clients' metadata documents (cimd.ts). One of its own by default; tests pass one that may reach a local server. */
  clientMetadata?: ClientMetadataFetcher
}

export class OAuthServer {
  readonly publicUrl: string | null
  private db: Db
  private keys: ApiKeys
  private integrations: Integrations
  private now: () => Date
  private clientMetadata: ClientMetadataFetcher

  constructor(opts: OAuthOptions) {
    this.db = opts.state
    this.keys = opts.keys
    this.integrations = opts.integrations
    this.publicUrl = opts.publicUrl
    this.now = opts.now ?? (() => new Date())
    this.clientMetadata = opts.clientMetadata ?? new ClientMetadataFetcher()
  }

  /** Whether OAuth exists now: a public URL, and the MCP server on. */
  available(): boolean {
    return this.publicUrl !== null && this.integrations.mcpEnabled()
  }

  /** Whether clients may register themselves now. */
  registrationOpen(): boolean {
    return this.available() && this.integrations.view().oauthRegistration
  }

  /** The issuer: the public URL. */
  get issuer(): string {
    return this.publicUrl ?? ''
  }

  /** The one protected resource: the MCP server's public address. */
  get resource(): string {
    return `${this.issuer}/mcp`
  }

  /** Where its RFC 9728 metadata is (path-inserted, as clients look for it). */
  get resourceMetadataUrl(): string {
    return `${this.issuer}/.well-known/oauth-protected-resource/mcp`
  }

  /** RFC 8414. */
  metadata(): OAuthMetadata & { authorization_response_iss_parameter_supported: boolean; client_id_metadata_document_supported: boolean } {
    const base = this.issuer
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      ...(this.registrationOpen() ? { registration_endpoint: `${base}/oauth/register` } : {}),
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: [...AUTH_METHODS],
      revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
      authorization_response_iss_parameter_supported: true,
      // MCP authorization 2026-07-28, "Client Registration", section "Advertising CIMD Support":
      // https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration
      client_id_metadata_document_supported: true,
    }
  }

  /** RFC 9728. */
  resourceMetadata(): OAuthProtectedResourceMetadata {
    return { resource: this.resource, authorization_servers: [this.issuer], bearer_methods_supported: ['header'], resource_name: 'thoth' }
  }

  // --- Clients --------------------------------------------------------------

  /**
   * RFC 7591: a client registers itself. Only what the flow uses is kept:
   * its name (what the person sees and the history names), its redirect
   * URIs and how it authenticates at the token endpoint (a secret is made
   * for `client_secret_*`, the default of RFC 7591, and shown this once).
   */
  register(body: unknown): OAuthClientInformationFull {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new OAuthRequestError('invalid_client_metadata', 'expected a JSON object')
    const b = body as Record<string, unknown>
    const redirectUris = checkRedirectUris(b.redirect_uris)
    const method = b.token_endpoint_auth_method ?? 'client_secret_basic'
    if (!AUTH_METHODS.includes(method as AuthMethod)) throw new OAuthRequestError('invalid_client_metadata', `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(', ')}`)
    checkTypes(b.grant_types, b.response_types)
    const name = clientName(b.client_name, redirectUris[0]!)
    this.prune()
    const waiting = (this.db.prepare('select count(*) n from oauth_clients c where not exists (select 1 from api_keys k where k.oauth_client = c.id)').get() as { n: number }).n
    if (waiting >= MAX_UNUSED_CLIENTS) throw new OAuthRequestError('temporarily_unavailable', 'too many clients waiting for an authorization; try again later', 429)
    const id = randomBytes(16).toString('base64url')
    const secret = method === 'none' ? null : random()
    const issuedAt = this.now()
    this.db.prepare('insert into oauth_clients (id, name, redirect_uris, auth_method, secret_hash, created_at) values (?, ?, ?, ?, ?, ?)')
      .run(id, name, JSON.stringify(redirectUris), method, secret === null ? null : sha256hex(secret), issuedAt.toISOString())
    return {
      client_id: id,
      client_id_issued_at: Math.floor(issuedAt.getTime() / 1000),
      ...(secret === null ? {} : { client_secret: secret, client_secret_expires_at: 0 }),
      client_name: name,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method as AuthMethod,
    }
  }

  /** A client that registered itself (a metadata document's client is looked up with `checkAuthorize`). */
  client(id: string): OAuthClient | null {
    const r = isMetadataClientId(id) ? null : this.clientRow(id)
    return r ? { id: r.id, name: r.name, redirectUris: JSON.parse(r.redirect_uris) as string[], authMethod: r.auth_method, host: null } : null
  }

  /**
   * A client described by its metadata document (cimd.ts), fetched now or
   * from the short cache: always from the document, never from what an
   * earlier approval kept, so that what the person sees is what it says now.
   */
  private async metadataClient(id: string): Promise<OAuthClient | Extract<AuthorizeCheck, { error: 'invalid_client_metadata' }>> {
    const host = hostOf(id)
    const refused = (reason: CimdErrorCode | 'invalid_redirect_uri' | 'invalid_client_metadata') => ({ ok: false as const, error: 'invalid_client_metadata' as const, redirect: null, reason, host })
    try {
      const doc = await this.clientMetadata.get(id)
      let redirectUris: string[]
      try {
        redirectUris = checkRedirectUris(doc.redirectUris)
        checkTypes(doc.grantTypes, doc.responseTypes)
      } catch (err) {
        if (err instanceof OAuthRequestError) return refused(err.code === 'invalid_redirect_uri' ? 'invalid_redirect_uri' : 'invalid_client_metadata')
        throw err
      }
      return { id, name: clientName(doc.name, redirectUris[0]!), redirectUris, authMethod: 'none', host: doc.host }
    } catch (err) {
      if (err instanceof CimdError) return refused(err.code)
      throw err
    }
  }

  private clientRow(id: string): ClientRow | null {
    if (!id) return null
    return (this.db.prepare('select * from oauth_clients where id = ?').get(id) as ClientRow | undefined) ?? null
  }

  // --- Authorization --------------------------------------------------------

  /**
   * An authorization request (its query parameters), checked in the order
   * RFC 6749 §4.1.2.1 asks. A client named by a metadata document's URL is
   * fetched here (cimd.ts): only call it for someone signed in (the consent
   * page's requests); before that, `precheckAuthorize`.
   */
  async checkAuthorize(param: (name: string) => string | null | undefined): Promise<AuthorizeCheck> {
    const id = param('client_id') ?? ''
    if (!isMetadataClientId(id)) return this.checkWith(this.client(id), param)
    const client = await this.metadataClient(id)
    return 'ok' in client ? client : this.checkWith(client, param)
  }

  /**
   * The same checks before anyone signed in, which never fetch anything: a
   * client named by a URL is only checked to be one thoth would fetch
   * (`later`: the rest waits for the consent page, with a session).
   */
  precheckAuthorize(param: (name: string) => string | null | undefined): AuthorizeCheck | { ok: 'later' } {
    const id = param('client_id') ?? ''
    if (!isMetadataClientId(id)) return this.checkWith(this.client(id), param)
    try {
      this.clientMetadata.checkUrl(id)
      return { ok: 'later' }
    } catch (err) {
      if (err instanceof CimdError) return { ok: false, error: 'invalid_client_metadata', redirect: null, reason: err.code, host: hostOf(id) }
      throw err
    }
  }

  private checkWith(client: OAuthClient | null, param: (name: string) => string | null | undefined): AuthorizeCheck {
    if (!client) return { ok: false, error: 'invalid_client', redirect: null }
    const redirectUri = param('redirect_uri') ?? ''
    if (!redirectUri || !client.redirectUris.some((r) => sameRedirect(r, redirectUri))) return { ok: false, error: 'invalid_redirect_uri', redirect: null }
    const rawState = param('state')
    const state = rawState === undefined || rawState === null || rawState === '' ? null : rawState.slice(0, MAX_STATE)
    const back = (error: OAuthErrorCode, description: string): AuthorizeCheck =>
      ({ ok: false, error, redirect: this.redirectWith(redirectUri, { error, error_description: description, ...(state === null ? {} : { state }) }) })
    if (param('response_type') !== 'code') return back('unsupported_response_type', 'only response_type=code')
    const challenge = param('code_challenge') ?? ''
    if (param('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return back('invalid_request', 'PKCE is required: code_challenge (S256) and code_challenge_method=S256')
    const resource = param('resource') ?? this.resource
    if (resource !== this.resource) return back('invalid_target', `the only resource here is ${this.resource}`)
    return { ok: true, req: { client, redirectUri, codeChallenge: challenge, state, resource } }
  }

  /**
   * The person approved: a single-use code for the client, bound to its
   * redirect URI, its PKCE challenge and what the person granted. Returns
   * where the browser goes next.
   */
  approve(req: AuthorizeRequest, userId: string, grant: Grant): string {
    const folders = checkFolders(grant.folders) ?? []
    const code = random()
    this.prune()
    if (req.client.host !== null) {
      // A metadata document's client, kept as it is now: the token endpoint knows it by this, without fetching.
      this.db.prepare(`insert into oauth_clients (id, name, redirect_uris, auth_method, secret_hash, created_at) values (?, ?, ?, 'none', null, ?)
        on conflict(id) do update set name = excluded.name, redirect_uris = excluded.redirect_uris, auth_method = 'none', secret_hash = null`)
        .run(req.client.id, req.client.name, JSON.stringify(req.client.redirectUris), this.now().toISOString())
    }
    this.db.prepare(`insert into oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, can_write, folders, expires_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sha256hex(code), req.client.id, userId, req.redirectUri, req.codeChallenge, req.resource, grant.canWrite ? 1 : 0, JSON.stringify(folders), new Date(this.now().getTime() + CODE_TTL_MS).toISOString())
    return this.redirectWith(req.redirectUri, { code, ...(req.state === null ? {} : { state: req.state }) })
  }

  /** The person said no: the client hears `access_denied`. */
  deny(req: AuthorizeRequest): string {
    return this.redirectWith(req.redirectUri, { error: 'access_denied', error_description: 'the person did not authorize it', ...(req.state === null ? {} : { state: req.state }) })
  }

  /** The redirect URI with these parameters and the issuer (RFC 9207). */
  private redirectWith(uri: string, params: Record<string, string>): string {
    const u = new URL(uri)
    for (const [k, v] of Object.entries({ ...params, iss: this.issuer })) u.searchParams.set(k, v)
    return u.toString()
  }

  // --- Tokens ---------------------------------------------------------------

  /**
   * The token endpoint (RFC 6749 §3.2): a form, with the client's
   * credentials in it or in `Authorization: Basic`.
   */
  token(form: URLSearchParams, authorization: string | undefined): OAuthTokens {
    const client = this.authenticateClient(form, authorization)
    const grantType = form.get('grant_type')
    if (grantType === 'authorization_code') return this.exchangeCode(client, form)
    if (grantType === 'refresh_token') return this.refresh(client, form)
    throw new OAuthRequestError('unsupported_grant_type', 'only authorization_code and refresh_token')
  }

  private exchangeCode(client: ClientRow, form: URLSearchParams): OAuthTokens {
    const code = form.get('code') ?? ''
    const row = this.db.prepare('select * from oauth_codes where code_hash = ?').get(sha256hex(code)) as CodeRow | undefined
    if (!row || row.client_id !== client.id) throw new OAuthRequestError('invalid_grant', 'unknown code')
    if (row.used_family) {
      // A second use: whoever holds it may not be the client. What the first one gave goes.
      this.revokeFamily(row.used_family)
      throw new OAuthRequestError('invalid_grant', 'this code was already used')
    }
    if (Date.parse(row.expires_at) <= this.now().getTime()) throw new OAuthRequestError('invalid_grant', 'the code expired')
    if (form.get('redirect_uri') !== row.redirect_uri) throw new OAuthRequestError('invalid_grant', 'redirect_uri must be the one of the authorization request')
    const verifier = form.get('code_verifier') ?? ''
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthRequestError('invalid_request', 'code_verifier is required (PKCE)')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    if (!equal(challenge, row.code_challenge)) throw new OAuthRequestError('invalid_grant', 'code_verifier does not match the code_challenge')
    this.checkResource(form, row.resource)
    const clientName = client.name
    return this.db.transaction(() => {
      const keyId = this.keys.authorizeClient(row.user_id, { id: client.id, name: clientName }, { canWrite: !!row.can_write, folders: JSON.parse(row.folders) as string[] })
      const family = random()
      this.db.prepare('update oauth_codes set used_family = ? where code_hash = ?').run(family, row.code_hash)
      return this.issue(keyId, family, row.resource)
    })()
  }

  private refresh(client: ClientRow, form: URLSearchParams): OAuthTokens {
    const token = form.get('refresh_token') ?? ''
    const row = token.startsWith(REFRESH_PREFIX)
      ? this.db.prepare(`select t.*, k.oauth_client from oauth_tokens t join api_keys k on k.id = t.key_id where t.token_hash = ? and t.kind = 'refresh'`)
        .get(sha256hex(token)) as (TokenRow & { oauth_client: string | null }) | undefined
      : undefined
    if (!row || row.oauth_client !== client.id) throw new OAuthRequestError('invalid_grant', 'unknown refresh token')
    if (row.used_at) {
      // Rotated already: someone else has it. Every token of this chain goes.
      this.revokeFamily(row.family)
      throw new OAuthRequestError('invalid_grant', 'this refresh token was already used')
    }
    if (Date.parse(row.expires_at) <= this.now().getTime()) throw new OAuthRequestError('invalid_grant', 'the refresh token expired')
    this.checkResource(form, row.resource)
    // Revoked, expired, or its user disabled: the authorization is over.
    if (!this.keys.principal(row.key_id, 'oauth')) throw new OAuthRequestError('invalid_grant', 'the authorization was revoked')
    return this.db.transaction(() => {
      this.db.prepare('update oauth_tokens set used_at = ? where token_hash = ?').run(this.now().toISOString(), row.token_hash)
      return this.issue(row.key_id, row.family, row.resource)
    })()
  }

  /** RFC 8707 at the token endpoint: if given, the resource the grant is for. */
  private checkResource(form: URLSearchParams, granted: string) {
    const all = form.getAll('resource')
    if (all.length > 1 || (all.length === 1 && all[0] !== granted)) throw new OAuthRequestError('invalid_target', `the only resource here is ${granted}`)
  }

  private issue(keyId: string, family: string, resource: string): OAuthTokens {
    this.prune()
    const now = this.now().getTime()
    const access = ACCESS_PREFIX + random()
    const refresh = REFRESH_PREFIX + random()
    const put = this.db.prepare('insert into oauth_tokens (token_hash, kind, key_id, family, resource, expires_at) values (?, ?, ?, ?, ?, ?)')
    put.run(sha256hex(access), 'access', keyId, family, resource, new Date(now + ACCESS_TTL_S * 1000).toISOString())
    put.run(sha256hex(refresh), 'refresh', keyId, family, resource, new Date(now + REFRESH_IDLE_MS).toISOString())
    const canWrite = (this.db.prepare('select can_write from api_keys where id = ?').get(keyId) as { can_write: number }).can_write
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: canWrite ? 'read write' : 'read' }
  }

  /**
   * RFC 7009: the client gives up a token. A refresh token takes its whole
   * chain with it. Unknown tokens, or another client's, change nothing (and
   * say nothing).
   */
  revokeToken(form: URLSearchParams, authorization: string | undefined): void {
    const client = this.authenticateClient(form, authorization)
    const token = form.get('token') ?? ''
    const row = this.db.prepare('select t.*, k.oauth_client from oauth_tokens t join api_keys k on k.id = t.key_id where t.token_hash = ?')
      .get(sha256hex(token)) as (TokenRow & { oauth_client: string | null }) | undefined
    if (!row || row.oauth_client !== client.id) return
    if (row.kind === 'refresh') this.revokeFamily(row.family)
    else this.db.prepare('delete from oauth_tokens where token_hash = ?').run(row.token_hash)
  }

  private revokeFamily(family: string) {
    this.db.prepare('delete from oauth_tokens where family = ?').run(family)
  }

  /**
   * The client at the token or revocation endpoint: its id, and its secret
   * if it was registered with one (compared in constant time).
   */
  private authenticateClient(form: URLSearchParams, authorization: string | undefined): ClientRow {
    let id = form.get('client_id')
    let secret = form.get('client_secret')
    const basic = /^\s*basic\s+(\S+)\s*$/i.exec(authorization ?? '')
    if (basic) {
      const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8')
      const colon = decoded.indexOf(':')
      if (colon === -1) throw new OAuthRequestError('invalid_client', 'malformed Basic credentials', 401)
      // RFC 6749 §2.3.1: each part form-encoded.
      const unform = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')) } catch { return s } }
      const basicId = unform(decoded.slice(0, colon))
      if (id !== null && id !== basicId) throw new OAuthRequestError('invalid_request', 'two different client ids')
      id = basicId
      secret = unform(decoded.slice(colon + 1))
    }
    const client = this.clientRow(id ?? '')
    if (!client) throw new OAuthRequestError('invalid_client', 'unknown client', 401)
    if (client.secret_hash !== null && (!secret || !equal(sha256hex(secret), client.secret_hash))) throw new OAuthRequestError('invalid_client', 'wrong or missing client secret', 401)
    return client
  }

  // --- The resource ---------------------------------------------------------

  /** Whether a bearer token is one of these (an access token), as opposed to a key. */
  static isAccessToken(token: string): boolean {
    return token.startsWith(ACCESS_PREFIX)
  }

  /**
   * The agent an access token acts as at `/mcp`: its authorization (a key),
   * via `oauth`. Null if OAuth isn't available, or the token is unknown,
   * expired, for another resource, or its authorization is over.
   */
  authenticate(token: string): AgentPrincipal | null {
    if (!this.available() || !OAuthServer.isAccessToken(token)) return null
    const row = this.db.prepare(`select * from oauth_tokens where token_hash = ? and kind = 'access'`).get(sha256hex(token)) as TokenRow | undefined
    if (!row || row.resource !== this.resource || Date.parse(row.expires_at) <= this.now().getTime()) return null
    return this.keys.principal(row.key_id, 'oauth')
  }

  /** Forgets what can no longer be used: expired codes and tokens, and clients registered a day ago and never authorized. */
  private prune() {
    const now = this.now()
    this.db.prepare('delete from oauth_codes where expires_at <= ?').run(now.toISOString())
    this.db.prepare('delete from oauth_tokens where expires_at <= ?').run(now.toISOString())
    this.db.prepare(`delete from oauth_clients where created_at <= ? and not exists (select 1 from api_keys k where k.oauth_client = oauth_clients.id)
      and not exists (select 1 from oauth_codes c where c.client_id = oauth_clients.id)`)
      .run(new Date(now.getTime() - UNUSED_CLIENT_MS).toISOString())
  }
}

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Whether a redirect URI is the registered one: the same string, or, for a
 * loopback address over http, the same but for the port (a native app picks
 * a free one each time: RFC 8252 §7.3, OAuth 2.1).
 */
export function sameRedirect(registered: string, given: string): boolean {
  if (registered === given) return true
  let a: URL, b: URL
  try { a = new URL(registered); b = new URL(given) } catch { return false }
  if (a.protocol !== 'http:' || b.protocol !== 'http:' || !LOOPBACK.has(a.hostname) || a.hostname !== b.hostname) return false
  return a.pathname === b.pathname && a.search === b.search && !a.hash && !b.hash && !b.username && !b.password
}

/**
 * The redirect URIs a client registers: 1 to 10 absolute URIs without a
 * fragment or credentials; https, http only to a loopback address, or an
 * app's own scheme (`cursor://…`), never one that runs something in the
 * browser (`javascript:`, `data:`…).
 */
function checkRedirectUris(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_REDIRECT_URIS) throw new OAuthRequestError('invalid_redirect_uri', `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs`)
  const out: string[] = []
  for (const raw of v) {
    if (typeof raw !== 'string' || raw.length > MAX_URI) throw new OAuthRequestError('invalid_redirect_uri', 'each redirect URI must be text')
    let u: URL
    try { u = new URL(raw) } catch { throw new OAuthRequestError('invalid_redirect_uri', `not an absolute URI: ${raw}`) }
    if (raw.includes('#') || u.username || u.password) throw new OAuthRequestError('invalid_redirect_uri', `no fragment or credentials in a redirect URI: ${raw}`)
    const ok = u.protocol === 'https:' ? !!u.hostname
      : u.protocol === 'http:' ? LOOPBACK.has(u.hostname)
        : /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !BANNED_SCHEMES.has(u.protocol)
    if (!ok) throw new OAuthRequestError('invalid_redirect_uri', `a redirect URI must be https, http to a loopback address, or an app's own scheme: ${raw}`)
    if (!out.includes(raw)) out.push(raw)
  }
  return out
}

/** `grant_types` and `response_types`, when given, only with what thoth does. */
function checkTypes(grantTypes: unknown, responseTypes: unknown) {
  for (const [field, v, allowed] of [['grant_types', grantTypes, ['authorization_code', 'refresh_token']], ['response_types', responseTypes, ['code']]] as const) {
    if (v === undefined) continue
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !(allowed as readonly string[]).includes(x))) {
      throw new OAuthRequestError('invalid_client_metadata', `${field} may only hold ${allowed.join(', ')}`)
    }
  }
}

/** A URL's host, or '' if it isn't one. */
function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

/** The client's name as people will see it: its `client_name`, or its redirect URI's host. One line, 100 characters at most. */
function clientName(v: unknown, redirectUri: string): string {
  const name = typeof v === 'string' ? v.normalize('NFC').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_NAME).trim() : ''
  if (name) return name
  const u = new URL(redirectUri)
  return u.hostname || u.protocol.replace(/:$/, '')
}
