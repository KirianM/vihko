// Agent keys (D-035.2, D-035.3): credentials a user delegates to an agent.
// `thoth_<id>_<secret>`: the id finds the key and the secret (256 bits,
// base64url) proves it. Only the secret's sha256 and its last 4 characters are
// stored, compared in constant time; the key itself is shown once, when it is
// created. A new key is read-only and reaches every folder its user sees.
// A key can be rotated: a new secret, the old one still valid for 10 minutes.
// An OAuth authorization (oauth.ts) is a key too, listed and revoked like the
// others, which only its client's tokens reach.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { newUid } from '@thoth/core'
import type { Db } from './db.ts'
import type { Role, User } from './auth.ts'
import { VIAS, type Via } from './actor.ts'
import type { AgentPrincipal } from './access.ts'
import { NoteError, NoteService } from './notes.ts'

export const KEY_PREFIX = 'thoth_'

/** `lastUsedAt` is written at most this often (a key in use doesn't write on every request). */
export const LAST_USED_EVERY_MS = 5 * 60_000

/** After a rotation, the secret it replaced keeps working this long: time to change the configurations that use it. */
export const ROTATION_GRACE_MS = 10 * 60_000

const MAX_NAME = 100
const MAX_FOLDERS = 100

const KEY_FORMAT = /^thoth_([0-9A-HJKMNP-TV-Z]{26})_([A-Za-z0-9_-]{43})$/

/** A key as its owner (or the admin) sees it: never the secret. */
export interface KeyInfo {
  id: string
  userId: string
  /** What the history and the editor show: «Claude Code», «Blog»… */
  name: string
  canWrite: boolean
  /** Folders it reaches; empty = every folder its user sees. */
  folders: string[]
  expiresAt: string | null
  createdAt: string
  lastUsedAt: string | null
  /** How it was last used. */
  lastVia: Via | null
  revokedAt: string | null
  /** The last 4 characters of the key, to tell keys apart (empty for an OAuth authorization, which has no key to show). */
  last4: string
  /** Rotated a moment ago: until when the secret it replaced still works; null otherwise. */
  previousUntil: string | null
  /** `active`, or why it no longer works. */
  status: 'active' | 'expired' | 'revoked'
  /**
   * An OAuth authorization (oauth.ts): the client it was given to and where
   * that client goes back to. Null for a key made in «Agents and API».
   */
  client: { id: string; redirectUris: string[] } | null
}

/** A key in the admin's list of everyone's keys: with its user. */
export interface KeyWithUser extends KeyInfo {
  user: { id: string; username: string }
}

export interface KeyInput {
  name?: unknown
  canWrite?: unknown
  folders?: unknown
  expiresAt?: unknown
}

export type KeyErrorCode = 'invalid' | 'invalid_path' | 'not_found' | 'forbidden'

export class KeyError extends Error {
  readonly code: KeyErrorCode
  constructor(code: KeyErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

interface Row {
  id: string
  user_id: string
  name: string
  secret_hash: string
  last4: string
  can_write: number
  folders: string
  expires_at: string | null
  created_at: string
  last_used_at: string | null
  last_via: Via | null
  revoked_at: string | null
  oauth_client: string | null
  previous_secret_hash: string | null
  previous_until: string | null
  /** From oauth_clients, joined: the client's redirect URIs (JSON). */
  redirect_uris?: string | null
}

/** A key's row joined with its OAuth client, if any. */
const SELECT = 'select k.*, c.redirect_uris from api_keys k left join oauth_clients c on c.id = k.oauth_client'

const sha256 = (s: string) => createHash('sha256').update(s).digest()

/** The id in a key, without checking it; null if it isn't one. Never logs or returns the secret. */
export function keyIdOf(token: string): string | null {
  return KEY_FORMAT.exec(token)?.[1] ?? null
}

export class ApiKeys {
  private db: Db
  private now: () => Date

  constructor(state: Db, opts: { now?: () => Date } = {}) {
    this.db = state
    this.now = opts.now ?? (() => new Date())
  }

  /**
   * A new key for `owner`. Returns it once, with its info; afterwards only
   * the info. Read-only and every folder unless the input says otherwise.
   */
  create(owner: User, input: KeyInput): { key: KeyInfo; token: string } {
    const name = checkName(input.name)
    const canWrite = checkBool(input.canWrite, 'canWrite') ?? false
    const folders = checkFolders(input.folders) ?? []
    const expiresAt = checkExpiry(input.expiresAt, this.now()) ?? null
    const id = newUid()
    const secret = randomBytes(32).toString('base64url')
    const token = `${KEY_PREFIX}${id}_${secret}`
    this.db.prepare(`insert into api_keys (id, user_id, name, secret_hash, last4, can_write, folders, expires_at, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, owner.id, name, sha256(secret).toString('hex'), token.slice(-4), canWrite ? 1 : 0, JSON.stringify(folders), expiresAt, this.now().toISOString())
    return { key: this.info(this.row(id)!), token }
  }

  /**
   * What a user grants an OAuth client (oauth.ts): a key of theirs named
   * after the client, whose secret is random and never shown (only the
   * client's tokens reach it). One per client and user: authorizing the same
   * client again changes what that key may do, so the history keeps naming
   * one author. Returns the key's id.
   */
  authorizeClient(userId: string, client: { id: string; name: string }, grant: { canWrite: boolean; folders: string[] }): string {
    const folders = checkFolders(grant.folders) ?? []
    const now = this.now().toISOString()
    const current = this.db.prepare(`select id from api_keys where user_id = ? and oauth_client = ? and revoked_at is null
      and (expires_at is null or expires_at > ?) order by created_at desc limit 1`).get(userId, client.id, now) as { id: string } | undefined
    if (current) {
      // Its name stays: the person may have renamed it in «Agents and API».
      this.db.prepare('update api_keys set can_write = ?, folders = ? where id = ?').run(grant.canWrite ? 1 : 0, JSON.stringify(folders), current.id)
      return current.id
    }
    const id = newUid()
    this.db.prepare(`insert into api_keys (id, user_id, name, secret_hash, last4, can_write, folders, created_at, oauth_client)
      values (?, ?, ?, ?, '', ?, ?, ?, ?)`)
      .run(id, userId, client.name, sha256(randomBytes(32).toString('base64url')).toString('hex'), grant.canWrite ? 1 : 0, JSON.stringify(folders), now, client.id)
    return id
  }

  /** A user's keys, newest first (revoked ones too: the history still names them). */
  list(userId: string): KeyInfo[] {
    return (this.db.prepare(`${SELECT} where k.user_id = ? order by k.created_at desc, k.id desc`).all(userId) as Row[]).map((r) => this.info(r))
  }

  /** Everyone's keys, for the admin. */
  listAll(): KeyWithUser[] {
    const rows = this.db.prepare(`select k.*, c.redirect_uris, u.username from api_keys k join users u on u.id = k.user_id
      left join oauth_clients c on c.id = k.oauth_client
      order by u.username, k.created_at desc, k.id desc`).all() as (Row & { username: string })[]
    return rows.map((r) => ({ ...this.info(r), user: { id: r.user_id, username: r.username } }))
  }

  get(id: string): KeyInfo | null {
    const r = this.row(id)
    return r ? this.info(r) : null
  }

  /** The name a key had (the history shows it); null if there's no such key. */
  nameOf(id: string): string | null {
    return (this.db.prepare('select name from api_keys where id = ?').get(id) as { name: string } | undefined)?.name ?? null
  }

  /** Renames a key or changes what it may do. A revoked key stays revoked. */
  update(id: string, input: KeyInput): KeyInfo {
    const r = this.row(id)
    if (!r) throw new KeyError('not_found', `no key ${id}`)
    if (r.revoked_at) throw new KeyError('invalid', 'a revoked key cannot change')
    const sets: string[] = []
    const values: unknown[] = []
    if (input.name !== undefined) { sets.push('name = ?'); values.push(checkName(input.name)) }
    const canWrite = checkBool(input.canWrite, 'canWrite')
    if (canWrite !== undefined) { sets.push('can_write = ?'); values.push(canWrite ? 1 : 0) }
    const folders = checkFolders(input.folders)
    if (folders !== undefined) { sets.push('folders = ?'); values.push(JSON.stringify(folders)) }
    const expiresAt = checkExpiry(input.expiresAt, this.now())
    if (expiresAt !== undefined) { sets.push('expires_at = ?'); values.push(expiresAt) }
    if (sets.length) this.db.prepare(`update api_keys set ${sets.join(', ')} where id = ?`).run(...values, id)
    return this.info(this.row(id)!)
  }

  /**
   * Revokes a key for good. Revoking it again changes nothing. An OAuth
   * authorization's tokens go with it.
   */
  revoke(id: string): KeyInfo {
    const r = this.row(id)
    if (!r) throw new KeyError('not_found', `no key ${id}`)
    this.db.transaction(() => {
      if (!r.revoked_at) this.db.prepare('update api_keys set revoked_at = ? where id = ?').run(this.now().toISOString(), id)
      this.db.prepare('delete from oauth_tokens where key_id = ?').run(id)
    })()
    return this.info(this.row(id)!)
  }

  /**
   * A new secret for a key (not an OAuth authorization, which is revoked
   * instead), shown this once, as when it was created: same id, name,
   * permissions, folders and history. The secret it replaces keeps working
   * for ROTATION_GRACE_MS, then stops; rotating again ends that at once (the
   * one being replaced gets the grace).
   */
  rotate(id: string): { key: KeyInfo; token: string } {
    const r = this.row(id)
    if (!r) throw new KeyError('not_found', `no key ${id}`)
    if (r.oauth_client) throw new KeyError('invalid', 'an OAuth authorization has no key to rotate: revoke it, and authorize the app again')
    if (r.revoked_at) throw new KeyError('invalid', 'a revoked key cannot be rotated')
    if (r.expires_at && Date.parse(r.expires_at) <= this.now().getTime()) throw new KeyError('invalid', 'an expired key cannot be rotated')
    const secret = randomBytes(32).toString('base64url')
    const token = `${KEY_PREFIX}${id}_${secret}`
    this.db.prepare('update api_keys set secret_hash = ?, last4 = ?, previous_secret_hash = ?, previous_until = ? where id = ?')
      .run(sha256(secret).toString('hex'), token.slice(-4), r.secret_hash, new Date(this.now().getTime() + ROTATION_GRACE_MS).toISOString(), id)
    return { key: this.info(this.row(id)!), token }
  }

  /**
   * The agent a key acts as, or null: not a key, unknown, wrong secret (or
   * one rotated out more than ROTATION_GRACE_MS ago), revoked, expired, its
   * user disabled, or an OAuth authorization (only its tokens reach it).
   * Records when it was last used (at most every 5 minutes) and how (`via`).
   */
  authenticate(token: string, via: Via): AgentPrincipal | null {
    if (!VIAS.includes(via)) return null
    const m = KEY_FORMAT.exec(token)
    const r = m ? this.db.prepare('select secret_hash, previous_secret_hash, previous_until, oauth_client from api_keys where id = ?').get(m[1]) as
      Pick<Row, 'secret_hash' | 'previous_secret_hash' | 'previous_until' | 'oauth_client'> | undefined : undefined
    // Compared in constant time, both secrets always, and against a dummy when there's no such key.
    const given = sha256(m?.[2] ?? '')
    const same = (hex: string | null | undefined) => {
      const expected = hex ? Buffer.from(hex, 'hex') : DUMMY
      return timingSafeEqual(given, expected.length === 32 ? expected : DUMMY) && !!hex
    }
    const current = same(r?.secret_hash)
    const previous = same(r?.previous_secret_hash) && !!r?.previous_until && Date.parse(r.previous_until) > this.now().getTime()
    if (!(current || previous) || !r || r.oauth_client !== null) return null
    return this.principal(m![1]!, via)
  }

  /**
   * The agent a key acts as, once whoever asks has proved they hold it (its
   * secret, or an OAuth token for it); null if it's revoked, expired or its
   * user disabled. Records when and how (`via`) it was last used.
   */
  principal(id: string, via: Via): AgentPrincipal | null {
    const r = this.db.prepare('select k.*, u.username, u.role, u.disabled from api_keys k join users u on u.id = k.user_id where k.id = ?')
      .get(id) as (Row & { username: string; role: Role; disabled: number }) | undefined
    if (!r) return null
    const now = this.now()
    if (r.revoked_at || r.disabled || (r.expires_at && Date.parse(r.expires_at) <= now.getTime())) return null
    if (!r.last_used_at || now.getTime() - Date.parse(r.last_used_at) >= LAST_USED_EVERY_MS || r.last_via !== via) {
      this.db.prepare('update api_keys set last_used_at = ?, last_via = ? where id = ?').run(now.toISOString(), via, r.id)
    }
    const user: User = { id: r.user_id, username: r.username, role: r.role, disabled: false }
    return { kind: 'agent', user, via, key: { id: r.id, name: r.name, canWrite: !!r.can_write, folders: JSON.parse(r.folders) as string[] } }
  }

  private row(id: string): Row | null {
    return (this.db.prepare(`${SELECT} where k.id = ?`).get(id) as Row | undefined) ?? null
  }

  private info(r: Row): KeyInfo {
    const expired = r.expires_at !== null && Date.parse(r.expires_at) <= this.now().getTime()
    return {
      id: r.id, userId: r.user_id, name: r.name, canWrite: !!r.can_write, folders: JSON.parse(r.folders) as string[],
      expiresAt: r.expires_at, createdAt: r.created_at, lastUsedAt: r.last_used_at, lastVia: r.last_via, revokedAt: r.revoked_at,
      last4: r.last4, status: r.revoked_at ? 'revoked' : expired ? 'expired' : 'active',
      previousUntil: !r.revoked_at && r.previous_until && Date.parse(r.previous_until) > this.now().getTime() ? r.previous_until : null,
      client: r.oauth_client ? { id: r.oauth_client, redirectUris: JSON.parse(r.redirect_uris ?? '[]') as string[] } : null,
    }
  }
}

const DUMMY = Buffer.alloc(32)

function checkName(v: unknown): string {
  if (typeof v !== 'string') throw new KeyError('invalid', 'name must be text')
  const name = v.normalize('NFC').trim()
  if (!name || name.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(name)) throw new KeyError('invalid', `name must be 1-${MAX_NAME} characters, on one line`)
  return name
}

function checkBool(v: unknown, what: string): boolean | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') throw new KeyError('invalid', `${what} must be true or false`)
  return v
}

/** Folders as the notes root names them: relative, no `..`, nothing hidden; stored in NFC, without repeats. */
export function checkFolders(v: unknown): string[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.length > MAX_FOLDERS) throw new KeyError('invalid', `folders must be a list of at most ${MAX_FOLDERS} folders`)
  const out = new Set<string>()
  for (const f of v) {
    if (typeof f !== 'string') throw new KeyError('invalid', 'each folder must be text')
    const folder = f.normalize('NFC').trim().replace(/\/+$/, '')
    try {
      NoteService.checkFolder(folder)
    } catch (err) {
      if (err instanceof NoteError) throw new KeyError('invalid_path', `invalid folder: ${f}`)
      throw err
    }
    out.add(folder)
  }
  // A folder inside another one on the list adds nothing.
  const all = [...out].sort()
  return all.filter((f) => !all.some((g) => g !== f && f.startsWith(g + '/')))
}

/** An expiry in the future (ISO), or null for none. */
function checkExpiry(v: unknown, now: Date): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  if (!Number.isFinite(t)) throw new KeyError('invalid', 'expiresAt must be a date (ISO 8601) or null')
  if (t <= now.getTime()) throw new KeyError('invalid', 'expiresAt must be in the future')
  return new Date(t).toISOString()
}
