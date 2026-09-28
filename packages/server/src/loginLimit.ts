// Limits on guessing passwords (POST /api/auth/login, which the OAuth consent
// page signs in with too) and the first-boot token (POST /api/setup).
//
// Three counters of failures, each with a few free failures and then a wait
// that starts at one second and doubles with every further failure, up to a
// cap (OWASP's exponential lockout):
//
//   client + account   5 free, up to 15 min. The client is the IP address,
//                      or the browser's device cookie (below).
//   account            10 free, up to 1 min. Failures from any address, so
//                      spreading a guess over many addresses doesn't help.
//   IP address         20 free, up to 15 min. Every account from one
//                      address (guessing one password across many names).
//
// A random token (a one-time link, the first-boot token) is counted by the
// client only (`byAddress`): the client + token-kind and IP address counters,
// never an account counter. Its 256 bits make a guess spread over many
// addresses hopeless, so a shared counter would add nothing against guessing
// and would let anyone hold back, for everyone, the person who has the real
// token. VIHKO_TRUSTED_PROXIES decides which address is the client's
// (http/clientIp.ts).
//
// While any counter that applies is waiting, the attempt is refused (429 with
// Retry-After) before the password is checked: no argon2 work for whoever is
// guessing and nothing to learn from the timing. Refused attempts don't count
// (they can't make a wait longer). A success clears the client + account and
// account counters. A counter is forgotten an hour after its last failure.
//
// So that the limit can't lock someone out, a successful sign-in leaves a
// device cookie in that browser (OWASP's "device cookies"): from it, only its
// own client + account counter applies, never the account's or the address's
// counters that someone else is running up. A person on a new browser, while
// someone keeps guessing their name, waits the account's part: a minute at
// most per attempt.
//
// Everything lives in memory: a restart forgets the counters (a restart
// every few failures is not a practical way to guess) and makes device
// cookies worthless until their next sign-in (their key is in memory too).
// The number of counters is capped: whoever invents names can't fill memory;
// past the cap the oldest counters not waiting go first.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export interface Rule {
  /** Failures allowed before the first wait. */
  free: number
  /** The longest wait, in ms. */
  capMs: number
}

export interface LimitRules {
  pair: Rule
  account: Rule
  ip: Rule
  /** The first wait (doubling from there), in ms. */
  baseMs: number
  /** A counter is forgotten this long after its last failure (not while it's waiting). */
  forgetMs: number
  /** At most this many counters in memory. */
  maxEntries: number
  /** The admin's alert: at least this many failed or refused attempts… */
  alertAttempts: number
  /** …the last of them less than this long ago. */
  alertQuietMs: number
}

export const DEFAULT_RULES: LimitRules = {
  pair: { free: 5, capMs: 15 * 60_000 },
  account: { free: 10, capMs: 60_000 },
  ip: { free: 20, capMs: 15 * 60_000 },
  baseMs: 1000,
  forgetMs: 60 * 60_000,
  maxEntries: 10_000,
  alertAttempts: 20,
  alertQuietMs: 24 * 60 * 60_000,
}

/** The account the first-boot token is counted under (no username has a NUL). */
export const SETUP_ACCOUNT = '\0setup'

interface Entry {
  failures: number
  /** Until when attempts are refused (epoch ms; 0: not waiting). */
  lockedUntil: number
  /** The last failure (epoch ms). */
  last: number
}

type Kind = 'pair' | 'account' | 'ip'

export interface AttemptInput {
  /** The client's address (clientIp.ts), or a placeholder when unknown. */
  ip: string
  /** The username as typed, or SETUP_ACCOUNT. */
  account: string
  /** The device cookie's id, when it is valid for this account (`deviceFor`). */
  device?: string | null
  /**
   * A random token rather than a password (a link, the first-boot token):
   * counted by the client only, with no account counter that failures from
   * other addresses could hold back.
   */
  byAddress?: boolean
}

/** An attempt allowed to go on: say how it ended. Both return the wait (seconds) now in force, 0 if none. */
export interface Attempt {
  ok: true
  failed(): number
  passed(): void
}

export type AttemptResult = Attempt | { ok: false; retryAfter: number }

/** Names are compared as the users table does (case-insensitive), and never grow the map without bound. */
export function accountKey(name: string): string {
  return name.normalize('NFC').trim().toLowerCase().slice(0, 128)
}

export class LoginLimiter {
  readonly rules: LimitRules
  private readonly now: () => number
  private readonly entries = new Map<string, Entry>()
  private readonly secret = randomBytes(32)
  private episode: { since: number; last: number; attempts: number } | null = null

  constructor(opts: { now?: () => number; rules?: Partial<LimitRules> } = {}) {
    this.now = opts.now ?? Date.now
    this.rules = { ...DEFAULT_RULES, ...opts.rules }
  }

  /** How many counters are in memory (tests). */
  get size(): number {
    return this.entries.size
  }

  /**
   * Before checking a password: refused while any counter that applies is
   * waiting; otherwise the attempt counts as a failure until it `passed()`
   * (so that many attempts at once can't all slip in before the first fails).
   */
  begin(input: AttemptInput): AttemptResult {
    const now = this.now()
    const account = accountKey(input.account)
    const keys: [Kind, string][] = input.device
      ? [['pair', `d:${input.device}|${account}`]]
      : input.byAddress
        ? [['pair', `i:${input.ip}|${account}`], ['ip', `i:${input.ip}`]]
        : [['pair', `i:${input.ip}|${account}`], ['account', `a:${account}`], ['ip', `i:${input.ip}`]]
    const wait = Math.max(0, ...keys.map(([, k]) => this.waiting(k, now)))
    if (wait > 0) {
      this.record(now)
      return { ok: false, retryAfter: seconds(wait) }
    }
    for (const [kind, key] of keys) {
      const e = this.touch(key, now)
      e.failures++
      e.last = now
      const over = e.failures - this.rules[kind].free
      if (over > 0) e.lockedUntil = now + Math.min(this.rules[kind].capMs, this.rules.baseMs * 2 ** Math.min(over - 1, 30))
    }
    let settled = false
    return {
      ok: true,
      failed: () => {
        if (!settled) { settled = true; this.record(this.now()) }
        const t = this.now()
        return seconds(Math.max(0, ...keys.map(([, k]) => this.waiting(k, t))))
      },
      passed: () => {
        if (settled) return
        settled = true
        for (const [kind, key] of keys) {
          if (kind !== 'ip') { this.entries.delete(key); continue }
          // The address's counter isn't cleared by one account's success (one
          // account of one's own would reset a guess across all the others):
          // only this attempt is taken back.
          const e = this.entries.get(key)
          if (!e) continue
          e.failures--
          if (e.failures <= this.rules.ip.free) e.lockedUntil = 0
          if (e.failures <= 0) this.entries.delete(key)
        }
      },
    }
  }

  /** A device cookie for a browser that just signed in as `account`. */
  deviceToken(account: string): string {
    const id = randomBytes(16).toString('base64url')
    return `${id}.${this.sign(id, account)}`
  }

  /** The device id in a cookie, if the cookie was made here for this account; null otherwise. */
  deviceFor(cookie: string | undefined, account: string): string | null {
    const m = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(cookie ?? '')
    if (!m) return null
    const a = Buffer.from(m[2]!)
    const b = Buffer.from(this.sign(m[1]!, account))
    return a.length === b.length && timingSafeEqual(a, b) ? m[1]! : null
  }

  /**
   * For the admin's alert: failed and refused attempts since `since`, while
   * there have been at least `alertAttempts` and the last is recent. Null otherwise.
   */
  summary(): { attempts: number; since: string } | null {
    const e = this.episode
    if (!e || e.attempts < this.rules.alertAttempts || this.now() - e.last > this.rules.alertQuietMs) return null
    return { attempts: e.attempts, since: new Date(e.since).toISOString() }
  }

  private sign(id: string, account: string): string {
    return createHmac('sha256', this.secret).update(`${id}\n${accountKey(account)}`).digest('base64url')
  }

  private record(now: number) {
    if (!this.episode || now - this.episode.last > this.rules.alertQuietMs) this.episode = { since: now, last: now, attempts: 0 }
    this.episode.attempts++
    this.episode.last = now
  }

  /** How long `key` still has to wait (ms). Reading doesn't create or refresh anything. */
  private waiting(key: string, now: number): number {
    const e = this.entries.get(key)
    return e ? Math.max(0, e.lockedUntil - now) : 0
  }

  private stale(e: Entry, now: number): boolean {
    return e.lockedUntil <= now && now - e.last > this.rules.forgetMs
  }

  /** The counter for `key`, most recently used from now on; a new one if absent or forgotten. */
  private touch(key: string, now: number): Entry {
    let e = this.entries.get(key)
    if (e) {
      this.entries.delete(key)
      if (this.stale(e, now)) e = undefined
    }
    if (!e) {
      if (this.entries.size >= this.rules.maxEntries) this.evict(now)
      e = { failures: 0, lockedUntil: 0, last: now }
    }
    this.entries.set(key, e)
    return e
  }

  /** Makes room: forgotten counters first, then the least recently used not waiting, then the least recently used. */
  private evict(now: number) {
    for (const [k, e] of this.entries) if (this.stale(e, now)) this.entries.delete(k)
    if (this.entries.size < this.rules.maxEntries) return
    let victim: string | undefined
    for (const [k, e] of this.entries) {
      if (e.lockedUntil <= now) { victim = k; break }
    }
    victim ??= this.entries.keys().next().value
    if (victim !== undefined) this.entries.delete(victim)
  }
}

const seconds = (ms: number) => (ms > 0 ? Math.ceil(ms / 1000) : 0)
