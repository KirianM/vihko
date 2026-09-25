// Local users, passwords and sessions. No external provider required.
// Passwords with scrypt (bundled with Node); only the hash of session
// tokens is stored.
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { newUid } from '@thoth/core'
import type { Db } from './db.ts'

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>

// scrypt parameters: N=2^15, r=8, p=1 (~32 MiB, on the order of 100 ms).
const N = 2 ** 15
const R = 8
const P = 1
const KEYLEN = 32
const MAXMEM = 64 * 1024 * 1024

export const MIN_PASSWORD = 10
export const SESSION_DAYS = 30

export type Role = 'admin' | 'member'

export interface User {
  id: string
  username: string
  role: Role
  disabled: boolean
}

export type AuthErrorCode = 'invalid_username' | 'weak_password' | 'user_exists' | 'already_setup' | 'invalid_token'

/** Error creating a user or on first boot. `code` is stable and the UI translates it. */
export class AuthError extends Error {
  readonly code: AuthErrorCode
  constructor(code: AuthErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password.normalize('NFC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$')
  if (alg !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = await scryptAsync(password.normalize('NFC'), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM,
  })
  return timingSafeEqual(actual, expected)
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
const newToken = () => randomBytes(32).toString('base64url')

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

  async createUser(username: string, password: string, role: Role): Promise<User> {
    const name = username.normalize('NFC').trim()
    if (!/^[\p{L}\p{N}._-]{2,64}$/u.test(name)) throw new AuthError('invalid_username', 'invalid username (2-64 letters, digits, ".", "_" or "-")')
    if (password.length < MIN_PASSWORD) throw new AuthError('weak_password', `password must be at least ${MIN_PASSWORD} characters`)
    if (this.db.prepare('select 1 from users where username = ?').get(name)) throw new AuthError('user_exists', `user ${name} already exists`)
    const user: User = { id: newUid(), username: name, role, disabled: false }
    this.db.prepare('insert into users (id, username, password_hash, role, created_at) values (?, ?, ?, ?, ?)')
      .run(user.id, user.username, await hashPassword(password), role, new Date().toISOString())
    return user
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

  /** Returns a new session token, or null if the credentials are invalid. */
  async login(username: string, password: string): Promise<{ token: string; user: User; expiresAt: Date } | null> {
    const row = this.db.prepare('select id, username, role, disabled, password_hash from users where username = ?')
      .get(username.normalize('NFC').trim()) as { id: string; username: string; role: Role; disabled: number; password_hash: string } | undefined
    // Verified against a dummy hash either way, so response time doesn't reveal which users exist.
    const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH)
    if (!row || !ok || row.disabled) return null
    const token = newToken()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000)
    this.db.prepare('insert into sessions (token_hash, user_id, created_at, expires_at, last_seen_at) values (?, ?, ?, ?, ?)')
      .run(tokenHash(token), row.id, now.toISOString(), expiresAt.toISOString(), now.toISOString())
    return { token, user: rowToUser(row), expiresAt }
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

const DUMMY_HASH = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEYLEN).toString('base64')}`
