// Local users, passwords and sessions. No external provider required.
// Passwords with argon2id, bundled with Node (D-031.8); older scrypt hashes
// still verify and are replaced on the next successful login. Only the hash
// of session tokens is stored.
import * as crypto from 'node:crypto'
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { newUid, subjectKey } from '@thoth/core'
import type { Db } from './db.ts'

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>

interface Argon2Params { message: string | Buffer; nonce: Buffer; parallelism: number; tagLength: number; memory: number; passes: number }
type Argon2 = (algorithm: 'argon2id', params: Argon2Params, cb: (err: Error | null, key: Buffer) => void) => void
// Stable in Node 26 (added in 24.7). A Node built against an OpenSSL without
// Argon2 (older than 3.2) doesn't have it: then new hashes stay on scrypt.
const argon2 = (crypto as unknown as { argon2?: Argon2 }).argon2
const argon2Async = argon2 && ((params: Argon2Params) =>
  new Promise<Buffer>((resolve, reject) => argon2('argon2id', params, (err, key) => (err ? reject(err) : resolve(key)))))

// argon2id with OWASP's parameters: 19 MiB, 2 passes, 1 lane.
const ARGON2 = { m: 19 * 1024, t: 2, p: 1 }
const ARGON2_VERSION = 19

// scrypt parameters: N=2^15, r=8, p=1 (~32 MiB, on the order of 100 ms). Only for hashes made before argon2id.
const N = 2 ** 15
const R = 8
const P = 1
const KEYLEN = 32
const MAXMEM = 64 * 1024 * 1024

export const MIN_PASSWORD = 10
export const SESSION_DAYS = 30
/** The browser a session remembers (its User-Agent), cut to this length. */
const MAX_USER_AGENT = 200

export type Role = 'admin' | 'member'

export interface User {
  id: string
  username: string
  role: Role
  disabled: boolean
}

export type AuthErrorCode = 'invalid_username' | 'weak_password' | 'user_exists' | 'already_setup' | 'invalid_token'

/** A session as its owner sees it in «Account»: never its token. */
export interface SessionInfo {
  /** Stands for the session (part of its token's hash, which reveals nothing of the token). */
  id: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  userAgent: string | null
}

/** Error creating a user or on first boot. `code` is stable and the UI translates it. */
/**
 * The id of the user (not deleted) with this name, compared as the
 * permissions compare names (subjectKey: any case, in any script); SQLite's
 * `nocase` folds only ASCII, and «LUCÍA» couldn't sign in as «lucía».
 */
export function userIdByName(db: Db, name: string): string | null {
  const key = subjectKey(name.normalize('NFC').trim())
  const rows = db.prepare('select id, username from users where deleted_at is null').all() as { id: string; username: string }[]
  return rows.find((r) => subjectKey(r.username) === key)?.id ?? null
}

export class AuthError extends Error {
  readonly code: AuthErrorCode
  constructor(code: AuthErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '')

/**
 * A new password hash, as a PHC string with its algorithm and parameters:
 * `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>` (base64 without padding).
 * Without Argon2 in this Node, `scrypt$N$r$p$<salt>$<hash>`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  if (!argon2Async) {
    const hash = await scryptAsync(password.normalize('NFC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM })
    return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`
  }
  const hash = await argon2Async({ message: password.normalize('NFC'), nonce: salt, parallelism: ARGON2.p, tagLength: KEYLEN, memory: ARGON2.m, passes: ARGON2.t })
  return `$argon2id$v=${ARGON2_VERSION}$m=${ARGON2.m},t=${ARGON2.t},p=${ARGON2.p}$${b64(salt)}$${b64(hash)}`
}

const ARGON2_HASH = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/

/** Whether `password` matches a stored hash of either kind. An unknown or malformed hash never matches. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const a = ARGON2_HASH.exec(stored)
  if (a) {
    const [, v, m, t, p, salt, hash] = a
    if (!argon2Async || Number(v) !== ARGON2_VERSION) return false
    const expected = Buffer.from(hash!, 'base64')
    const actual = await argon2Async({
      message: password.normalize('NFC'), nonce: Buffer.from(salt!, 'base64'), parallelism: Number(p), tagLength: expected.length, memory: Number(m), passes: Number(t),
    })
    return timingSafeEqual(actual, expected)
  }
  const [alg, n, r, p, salt, hash] = stored.split('$')
  if (alg !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = await scryptAsync(password.normalize('NFC'), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM,
  })
  return timingSafeEqual(actual, expected)
}

/** Whether a stored hash (already verified) should be replaced: an older algorithm or weaker parameters. */
export function needsRehash(stored: string): boolean {
  if (!argon2Async) return false
  const a = ARGON2_HASH.exec(stored)
  return !a || Number(a[1]) !== ARGON2_VERSION || Number(a[2]) < ARGON2.m || Number(a[3]) < ARGON2.t || Number(a[4]) < ARGON2.p
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
const newToken = () => randomBytes(32).toString('base64url')
/** How long the public id of a session is: the start of its token's hash. */
const SESSION_ID = 32

/** The public id of the session with this token (SessionInfo.id). */
export function sessionIdOf(token: string): string {
  return tokenHash(token).slice(0, SESSION_ID)
}

/** A username (or a group name, users.ts): letters, digits, `.`, `_` or `-`, 2 to 64. */
export const NAME_PATTERN = /^[\p{L}\p{N}._-]{2,64}$/u

function rowToUser(r: { id: string; username: string; role: Role; disabled: number }): User {
  return { id: r.id, username: r.username, role: r.role, disabled: !!r.disabled }
}

export class Auth {
  private db: Db
  /** Hash of a one-time token to create the first admin (in memory only). */
  private setupHash: string | null = null

  constructor(stateDb: Db) {
    this.db = stateDb
  }

  /** state.db, which other application state (keys, settings) shares. */
  get state(): Db {
    return this.db
  }

  /** A user's current name, or null if there's no such user (ids are stable; names may change). */
  username(id: string): string | null {
    return (this.db.prepare('select username from users where id = ?').get(id) as { username: string } | undefined)?.username ?? null
  }

  userCount(): number {
    return (this.db.prepare('select count(*) n from users').get() as { n: number }).n
  }

  /** If there are no users, generates the first-boot token. It's shown only once, in the log. */
  setupToken(): string | null {
    if (this.userCount() > 0) return null
    const token = newToken()
    this.setupHash = tokenHash(token)
    return token
  }

  /**
   * A new user. Without a password (null), they can't sign in until they
   * choose one with a one-time link (users.ts). A deleted user's name is
   * still taken (its tombstone keeps it).
   */
  async createUser(username: string, password: string | null, role: Role): Promise<User> {
    const name = username.normalize('NFC').trim()
    if (!NAME_PATTERN.test(name)) throw new AuthError('invalid_username', 'invalid username (2-64 letters, digits, ".", "_" or "-")')
    if (password !== null) strongEnough(password)
    // Taken as the permissions compare names (any case, in any script): SQLite's
    // nocase only folds ASCII, and «ángela» would inherit «Ángela»'s grants.
    const key = subjectKey(name)
    const names = this.db.prepare('select username from users').all() as { username: string }[]
    if (names.some((r) => subjectKey(r.username) === key)) throw new AuthError('user_exists', `user ${name} already exists`)
    const user: User = { id: newUid(), username: name, role, disabled: false }
    this.db.prepare('insert into users (id, username, password_hash, role, created_at) values (?, ?, ?, ?, ?)')
      .run(user.id, user.username, password === null ? '' : await hashPassword(password), role, new Date().toISOString())
    return user
  }

  /** Replaces a user's password (a one-time link, or «Account»). Sessions stay: the caller ends those it has to. */
  async setPassword(userId: string, password: string): Promise<void> {
    strongEnough(password)
    this.db.prepare('update users set password_hash = ? where id = ? and deleted_at is null').run(await hashPassword(password), userId)
  }

  /** Whether this is the user's password now (always as slow as a real check). */
  async checkPassword(userId: string, password: string): Promise<boolean> {
    const row = this.db.prepare('select password_hash from users where id = ? and disabled = 0').get(userId) as { password_hash: string } | undefined
    const ok = await verifyPassword(password, row?.password_hash || DUMMY_HASH)
    return ok && !!row?.password_hash
  }

  /** Creates the first admin with the first-boot token. The token is consumed. */
  async setup(token: string, username: string, password: string): Promise<User> {
    if (!this.setupHash || this.userCount() > 0) throw new AuthError('already_setup', 'the installation is already set up')
    const a = Buffer.from(tokenHash(token))
    const b = Buffer.from(this.setupHash)
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AuthError('invalid_token', 'invalid first-boot token')
    const user = await this.createUser(username, password, 'admin')
    this.setupHash = null
    return user
  }

  /**
   * Returns a new session token, or null if the credentials are invalid.
   * `userAgent`: the browser, remembered to tell the session apart. (The
   * API's sign-in checks the credentials with `verifyLogin` instead, and
   * asks for the second factor before starting the session.)
   */
  async login(username: string, password: string, userAgent?: string): Promise<{ token: string; user: User; expiresAt: Date } | null> {
    const user = await this.verifyLogin(username, password)
    return user && { ...this.startSession(user.id, userAgent), user }
  }

  /** The user these credentials are for, or null if they are invalid (or the user is disabled). Starts no session. */
  async verifyLogin(username: string, password: string): Promise<User | null> {
    const id = userIdByName(this.db, username)
    const row = id === null ? undefined : this.db.prepare('select id, username, role, disabled, password_hash from users where id = ?')
      .get(id) as { id: string; username: string; role: Role; disabled: number; password_hash: string } | undefined
    // Verified against a dummy hash either way (also for someone invited who
    // has no password yet), so response time doesn't reveal which users exist.
    const ok = await verifyPassword(password, row?.password_hash || DUMMY_HASH)
    if (!row || !ok || !row.password_hash || row.disabled) return null
    // A hash from before argon2id (or with weaker parameters) is replaced now that the password is known.
    if (needsRehash(row.password_hash)) {
      this.db.prepare('update users set password_hash = ? where id = ? and password_hash = ?').run(await hashPassword(password), row.id, row.password_hash)
    }
    return rowToUser(row)
  }

  /** A user who can sign in (enabled, not deleted), by id; null otherwise. */
  user(id: string): User | null {
    const row = this.db.prepare('select id, username, role, disabled from users where id = ? and disabled = 0 and deleted_at is null').get(id) as
      { id: string; username: string; role: Role; disabled: number } | undefined
    return row ? rowToUser(row) : null
  }

  /** A new session for a user whose credentials were just checked (a login, or a one-time link). */
  startSession(userId: string, userAgent?: string): { token: string; expiresAt: Date } {
    const token = newToken()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000)
    this.db.prepare('insert into sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent) values (?, ?, ?, ?, ?, ?)')
      .run(tokenHash(token), userId, now.toISOString(), expiresAt.toISOString(), now.toISOString(), userAgent?.slice(0, MAX_USER_AGENT) || null)
    return { token, expiresAt }
  }

  /** A user's sessions still in force, most recently used first. */
  sessions(userId: string): SessionInfo[] {
    const rows = this.db.prepare(`select token_hash, created_at, last_seen_at, expires_at, user_agent from sessions
      where user_id = ? and expires_at > ? order by last_seen_at desc, created_at desc`).all(userId, new Date().toISOString()) as
      { token_hash: string; created_at: string; last_seen_at: string; expires_at: string; user_agent: string | null }[]
    return rows.map((r) => ({ id: r.token_hash.slice(0, SESSION_ID), createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, userAgent: r.user_agent }))
  }

  /** Ends one session of a user's by its public id. Whether there was one. */
  endSession(userId: string, id: string): boolean {
    if (!/^[0-9a-f]+$/.test(id) || id.length !== SESSION_ID) return false
    return this.db.prepare('delete from sessions where user_id = ? and substr(token_hash, 1, ?) = ?').run(userId, SESSION_ID, id).changes > 0
  }

  /** Ends every session of a user's, but the one with the public id `keep` (if given). How many ended. */
  endSessions(userId: string, keep?: string): number {
    if (keep) return this.db.prepare('delete from sessions where user_id = ? and substr(token_hash, 1, ?) != ?').run(userId, SESSION_ID, keep).changes
    return this.db.prepare('delete from sessions where user_id = ?').run(userId).changes
  }

  /** User of a valid session. Renews the expiry (sliding session). */
  session(token: string | undefined): User | null {
    if (!token) return null
    const h = tokenHash(token)
    const row = this.db.prepare(`select u.id, u.username, u.role, u.disabled, s.expires_at, s.last_seen_at
      from sessions s join users u on u.id = s.user_id where s.token_hash = ?`).get(h) as
      { id: string; username: string; role: Role; disabled: number; expires_at: string; last_seen_at: string } | undefined
    if (!row) return null
    const now = Date.now()
    if (Date.parse(row.expires_at) < now || row.disabled) {
      this.db.prepare('delete from sessions where token_hash = ?').run(h)
      return null
    }
    // Renew at most once an hour, so we don't write on every request.
    if (now - Date.parse(row.last_seen_at) > 3_600_000) {
      this.db.prepare('update sessions set last_seen_at = ?, expires_at = ? where token_hash = ?')
        .run(new Date(now).toISOString(), new Date(now + SESSION_DAYS * 86_400_000).toISOString(), h)
    }
    return rowToUser(row)
  }

  logout(token: string) {
    this.db.prepare('delete from sessions where token_hash = ?').run(tokenHash(token))
  }
}

function strongEnough(password: string) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new AuthError('weak_password', `password must be at least ${MIN_PASSWORD} characters`)
}

// Same algorithm and cost as a real hash, so an unknown user takes as long as a known one.
const DUMMY_HASH = argon2Async
  ? `$argon2id$v=${ARGON2_VERSION}$m=${ARGON2.m},t=${ARGON2.t},p=${ARGON2.p}$${b64(Buffer.alloc(16))}$${b64(Buffer.alloc(KEYLEN))}`
  : `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEYLEN).toString('base64')}`
