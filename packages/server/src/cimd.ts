// OAuth Client ID Metadata Documents (CIMD, D-037): a client names itself
// with an https URL as its `client_id`, and that URL serves its description
// (name, redirect URIs). The MCP authorization spec of 2026-07-28 recommends
// it over dynamic registration, which it deprecates, following
// draft-ietf-oauth-client-id-metadata-document-00:
// - "Client Registration", section "Client ID Metadata Documents":
//   https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration
// - "Authorization Security Considerations", section "Client ID Metadata
//   Document Security" (SSRF, showing the redirect host, localhost warnings):
//   https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations
//
// This is the only request thoth makes on its own initiative towards an
// address someone else chose, so it is fenced in (the draft's §6, SSRF):
//
// - It happens only when someone signed in to thoth starts an authorization
//   with such a client (http/oauth.ts), never at registration or for the
//   token endpoint; and only while OAuth exists (a public URL, MCP on).
// - `https`, port 443, no credentials, fragment or dot segments in the URL,
//   and a host name (not an address).
// - The name is resolved once, every address it gives must be public (not
//   private, loopback, link-local, CGNAT, multicast, documentation or
//   otherwise reserved, IPv4 or IPv6), and the connection goes to the address
//   that was checked (the socket's lookup is pinned to it: no second
//   resolution between checking and connecting). TLS is still verified
//   against the host name.
// - No redirects followed; 5 KB and 5 s at most, for everything (resolving,
//   connecting, headers and body).
// - The document must be a JSON object whose `client_id` is exactly the URL,
//   with a `client_name`, redirect URIs under the same rules as dynamic
//   registration (oauth.ts), no secret, and `none` as its token endpoint
//   authentication (thoth supports no key-based client authentication).
// - A good document is kept in memory for a short while, as its
//   Cache-Control says within bounds; a failure is never kept.
//
// Loopback addresses and other ports can only be allowed through the
// `testing` options, which only tests pass: nothing reads them from the
// environment or the configuration.
import { lookup as dnsLookup } from 'node:dns/promises'
import { request } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'

/** The largest document read (the draft's recommendation). */
export const CIMD_MAX_BYTES = 5 * 1024
/** How long a fetch may take, all of it. */
export const CIMD_TIMEOUT_MS = 5_000
/** A document is kept this long when its response says nothing about caching. */
export const CIMD_DEFAULT_TTL_MS = 5 * 60_000
/** ... and never longer than this, whatever it says. */
export const CIMD_MAX_TTL_MS = 30 * 60_000
/** At most this many documents kept at once. */
export const CIMD_CACHE_ENTRIES = 200

const MAX_URL = 2000

/** Why a client's metadata document can't be used. */
export type CimdErrorCode =
  | 'invalid_url' // not a URL thoth fetches (scheme, port, credentials, path...)
  | 'blocked_address' // the host resolves to an address that isn't public
  | 'unresolved' // the host doesn't resolve
  | 'fetch_failed' // connection, TLS or HTTP failure, or a status other than 200
  | 'redirect' // a redirect (never followed)
  | 'too_large'
  | 'timeout'
  | 'invalid_document' // not JSON, or not a valid description of this client

export class CimdError extends Error {
  readonly code: CimdErrorCode
  constructor(code: CimdErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** What thoth takes from a client's metadata document. */
export interface ClientMetadata {
  /** The URL: its `client_id`. */
  clientId: string
  /** Its `client_name`. */
  name: string
  /** Its host: what the consent screen shows as the client's domain. */
  host: string
  /** Its raw `redirect_uris`, for the caller to check (oauth.ts). */
  redirectUris: unknown
  /** Its raw `grant_types` and `response_types`, if any, for the caller to check. */
  grantTypes: unknown
  responseTypes: unknown
}

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>

export interface ClientMetadataOptions {
  now?: () => number
  /**
   * Only for tests, never from the environment or the configuration: a
   * resolver in place of the system's, loopback addresses allowed (a local
   * HTTPS server), any port, and a CA to trust for its certificate.
   */
  testing?: { resolve?: Resolver; allowLoopback?: boolean; anyPort?: boolean; ca?: string | Buffer }
}

// --- Addresses ---------------------------------------------------------------

/** IPv4 ranges that are not the public internet (RFC 6890 and its registry). */
const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT (shared address space)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata lives here)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and the broadcast address
]

/** Within 2000::/3 (the only IPv6 global unicast there is), what isn't public. */
const V6_BLOCKED_IN_GLOBAL: [string, number][] = [
  ['2001::', 23], // IETF protocol assignments (Teredo, ORCHID, benchmarking...)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4: an IPv4 address in disguise
  ['3fff::', 20], // documentation
]

const v4Blocked = new BlockList()
for (const [a, bits] of V4_BLOCKED) v4Blocked.addSubnet(a, bits, 'ipv4')
const v6Global = new BlockList()
v6Global.addSubnet('2000::', 3, 'ipv6')
const v6Blocked = new BlockList()
for (const [a, bits] of V6_BLOCKED_IN_GLOBAL) v6Blocked.addSubnet(a, bits, 'ipv6')
const nat64 = new BlockList()
nat64.addSubnet('64:ff9b::', 96, 'ipv6')
const loopback = new BlockList()
loopback.addSubnet('127.0.0.0', 8, 'ipv4')
loopback.addAddress('::1', 'ipv6')

/** An IPv6 address as its eight 16-bit groups; null if it isn't one. */
function v6Groups(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null
  let s = ip.toLowerCase().replace(/%.*$/, '')
  // A dotted IPv4 tail becomes two groups.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (dotted) {
    const [a, b, c, d] = dotted[2]!.split('.').map(Number) as [number, number, number, number]
    s = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail] = s.split('::') as [string, string | undefined]
  const left = head ? head.split(':') : []
  const right = tail === undefined ? [] : tail ? tail.split(':') : []
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  return groups.length === 8 ? groups.map((g) => parseInt(g, 16)) : null
}

/**
 * Whether an address is on the public internet: IPv4 outside every special
 * range; IPv6 within global unicast (2000::/3) outside its special ranges,
 * or a NAT64 address (64:ff9b::/96) whose IPv4 is public. IPv4-mapped,
 * unique-local, link-local, multicast and the rest of IPv6 are not.
 */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return !v4Blocked.check(ip, 'ipv4')
  if (family !== 6) return false
  if (nat64.check(ip, 'ipv6')) {
    const g = v6Groups(ip)!
    return isPublicAddress(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`)
  }
  return v6Global.check(ip, 'ipv6') && !v6Blocked.check(ip, 'ipv6')
}

// --- The URL -----------------------------------------------------------------

/** Whether a `client_id` is meant as a metadata document's URL (anything registered is a random id, never a URL). */
export function isMetadataClientId(id: string): boolean {
  return id.startsWith('https://')
}

/**
 * A `client_id` thoth would fetch, or why not: https, a host name, port 443
 * (unless testing), a path that isn't just `/`, no credentials, fragment or
 * dot segments, and written as a URL is normalized (the document's
 * `client_id` is compared with it character by character).
 */
export function checkClientIdUrl(raw: string, opts: { anyPort?: boolean } = {}): URL {
  if (raw.length > MAX_URL) throw new CimdError('invalid_url', 'client_id is too long')
  let u: URL
  try { u = new URL(raw) } catch { throw new CimdError('invalid_url', 'client_id is not a URL') }
  if (u.protocol !== 'https:') throw new CimdError('invalid_url', 'client_id must be https')
  if (u.username || u.password) throw new CimdError('invalid_url', 'client_id may not carry credentials')
  if (raw.includes('#')) throw new CimdError('invalid_url', 'client_id may not have a fragment')
  if (u.port && !opts.anyPort) throw new CimdError('invalid_url', 'client_id must use port 443')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!host || isIP(host)) throw new CimdError('invalid_url', 'client_id must name a host, not an address')
  if (u.pathname === '/' || u.pathname === '') throw new CimdError('invalid_url', 'client_id must have a path')
  if (/(^|\/)\.{1,2}(\/|\?|$)/.test(raw.slice(raw.indexOf('/', 'https://'.length)))) throw new CimdError('invalid_url', 'client_id may not have dot segments')
  if (u.href !== raw) throw new CimdError('invalid_url', `client_id must be written as ${u.href}`)
  return u
}

// --- Fetching ----------------------------------------------------------------

/** How long a response may be kept, from its Cache-Control: 0 = not at all. */
export function cacheTtlMs(cacheControl: string | undefined): number {
  const cc = (cacheControl ?? '').toLowerCase()
  if (/(^|[\s,])(no-store|no-cache|private)([\s,=]|$)/.test(cc)) return 0
  const m = /(?:^|[\s,])max-age\s*=\s*"?(\d+)"?/.exec(cc)
  if (!m) return CIMD_DEFAULT_TTL_MS
  return Math.min(Number(m[1]) * 1000, CIMD_MAX_TTL_MS)
}

interface Entry { doc: ClientMetadata; until: number }

export class ClientMetadataFetcher {
  private now: () => number
  private testing: NonNullable<ClientMetadataOptions['testing']>
  private cache = new Map<string, Entry>()
  private inflight = new Map<string, Promise<ClientMetadata>>()

  constructor(opts: ClientMetadataOptions = {}) {
    this.now = opts.now ?? Date.now
    this.testing = opts.testing ?? {}
  }

  /**
   * The client described at `url`: from the cache, or fetched now. Throws a
   * CimdError (never with anything of the response in it) when it can't be
   * used.
   */
  async get(url: string): Promise<ClientMetadata> {
    const hit = this.cache.get(url)
    if (hit && hit.until > this.now()) return hit.doc
    if (hit) this.cache.delete(url)
    // Several asks for the same client at once share one fetch.
    const running = this.inflight.get(url)
    if (running) return running
    const p = this.fetch(url).finally(() => this.inflight.delete(url))
    this.inflight.set(url, p)
    return p
  }

  /** Whether thoth would fetch this `client_id` (checkClientIdUrl, as this fetcher allows): throws a CimdError if not. Fetches nothing. */
  checkUrl(raw: string): URL {
    return checkClientIdUrl(raw, { anyPort: this.testing.anyPort })
  }

  private async fetch(raw: string): Promise<ClientMetadata> {
    const u = this.checkUrl(raw)
    const host = u.hostname
    // One deadline for all of it; when it passes, the request (if any) is torn down.
    const abort = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort()
        reject(new CimdError('timeout', `no answer from ${host} within ${CIMD_TIMEOUT_MS} ms`))
      }, CIMD_TIMEOUT_MS)
    })
    try {
      const address = await Promise.race([this.resolve(host), timeout])
      const res = await Promise.race([this.download(u, address, abort.signal), timeout])
      const doc = parseDocument(res.body, raw, host)
      const ttl = cacheTtlMs(res.cacheControl)
      if (ttl > 0) {
        if (this.cache.size >= CIMD_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!)
        this.cache.set(raw, { doc, until: this.now() + ttl })
      }
      return doc
    } finally {
      clearTimeout(timer)
    }
  }

  /** The one address to connect to: every address the host resolves to must be public. */
  private async resolve(host: string): Promise<{ address: string; family: number }> {
    let all: { address: string; family: number }[]
    try {
      all = this.testing.resolve ? await this.testing.resolve(host) : await dnsLookup(host, { all: true, verbatim: true })
    } catch {
      throw new CimdError('unresolved', `${host} does not resolve`)
    }
    if (all.length === 0) throw new CimdError('unresolved', `${host} does not resolve`)
    const allowed = (ip: string) => isPublicAddress(ip) || (this.testing.allowLoopback === true && loopback.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6'))
    if (!all.every((a) => allowed(a.address))) throw new CimdError('blocked_address', `${host} resolves to an address that is not public`)
    return all[0]!
  }

  /** GET the document from that address (TLS checked against the host name), as bytes within the limit. */
  private download(u: URL, to: { address: string; family: number }, signal: AbortSignal): Promise<{ body: Buffer; cacheControl: string | undefined }> {
    // The socket connects to the address that was checked, whatever the name resolves to now.
    const pinned = ((_host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
      if (options?.all) cb(null, [{ address: to.address, family: to.family }])
      else cb(null, to.address, to.family)
    }) as unknown as LookupFunction
    return new Promise((resolve, reject) => {
      const req = request({
        protocol: 'https:', hostname: u.hostname, port: u.port || 443, path: `${u.pathname}${u.search}`, method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'thoth' },
        lookup: pinned, servername: u.hostname, agent: false, signal,
        ...(this.testing.ca ? { ca: this.testing.ca } : {}),
      }, (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400) { reject(new CimdError('redirect', `${u.hostname} answered with a redirect, which thoth does not follow`)); res.destroy(); return }
        if (status !== 200) { reject(new CimdError('fetch_failed', `${u.hostname} answered ${status}`)); res.destroy(); return }
        const declared = Number(res.headers['content-length'])
        if (Number.isFinite(declared) && declared > CIMD_MAX_BYTES) { reject(new CimdError('too_large', `the document is larger than ${CIMD_MAX_BYTES} bytes`)); res.destroy(); return }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (d: Buffer) => {
          size += d.length
          // Rejected first: tearing the request down makes it report an error of its own.
          if (size > CIMD_MAX_BYTES) { reject(new CimdError('too_large', `the document is larger than ${CIMD_MAX_BYTES} bytes`)); req.destroy(); return }
          chunks.push(d)
        })
        res.on('end', () => resolve({ body: Buffer.concat(chunks), cacheControl: res.headers['cache-control'] }))
        res.on('error', () => reject(new CimdError('fetch_failed', `the answer from ${u.hostname} broke off`)))
        res.on('aborted', () => reject(new CimdError('fetch_failed', `the answer from ${u.hostname} broke off`)))
      })
      req.on('error', () => reject(new CimdError('fetch_failed', `could not fetch the document from ${u.hostname}`)))
      req.end()
    })
  }
}

/** The document, checked: a JSON object for exactly this client, with a name, and no secret. */
function parseDocument(body: Buffer, url: string, host: string): ClientMetadata {
  let doc: unknown
  try { doc = JSON.parse(body.toString('utf8')) } catch { throw new CimdError('invalid_document', 'the document is not JSON') }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new CimdError('invalid_document', 'the document is not a JSON object')
  const d = doc as Record<string, unknown>
  if (d.client_id !== url) throw new CimdError('invalid_document', 'the document\'s client_id is not its URL')
  if (typeof d.client_name !== 'string' || !d.client_name.trim()) throw new CimdError('invalid_document', 'the document has no client_name')
  if ('client_secret' in d || 'client_secret_expires_at' in d) throw new CimdError('invalid_document', 'a metadata document may not carry a secret')
  if (d.token_endpoint_auth_method !== undefined && d.token_endpoint_auth_method !== 'none') {
    throw new CimdError('invalid_document', 'token_endpoint_auth_method must be none (thoth supports no other for these clients)')
  }
  return { clientId: url, name: d.client_name, host, redirectUris: d.redirect_uris, grantTypes: d.grant_types, responseTypes: d.response_types }
}
