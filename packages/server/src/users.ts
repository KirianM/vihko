// Users and groups (M4, D-038.3 and .8), which the vihko admin manages.
//
// - A new user has no password: the admin copies a one-time link for them
//   (`/invite/<token>`) and the person chooses it there. The same kind of
//   link resets a password. The admin never knows anyone's password. Only a
//   link's sha256 is stored; it expires after 7 days, works once, and a new
//   link for the same person ends the previous one.
// - Disabling someone (reversible) ends their sessions and live connections
//   at once; their keys and OAuth authorizations stop working while they're
//   disabled (keys.ts refuses a disabled user's), and their grants stay.
// - Deleting (only someone already disabled) leaves a tombstone: the id and
//   the name, so the history still says who wrote and the name is never
//   given to someone else (a `{user}` folder of theirs must not open to a
//   newcomer with the same name, D-038.8). Their keys are revoked for good
//   and their secrets wiped (each keeps its name, for the history, as a
//   revoked key does); sessions, links, profile, memberships, second
//   factor, notices and pins go. Their personal space (`people/<name>`)
//   stays on the disk, closed: nobody sees it, the admin included, nor what
//   they shared from it (D-056.8); the admin may then transfer it, make it a
//   shared space or delete it (spaceService.ts).
// - A new user gets their personal folder (auth.ts, personalFolders.ts).
// - The last active admin can't be demoted, disabled or deleted.
// - Groups are permission subjects (`@name` in vihko.yaml): the admin
//   creates, renames and fills them. Everyone signed in sees the names of
//   users and groups (to share with them), never their state or role.
//
// Grants in vihko.yaml name users and groups: `hooks` let the permissions
// writer follow a deletion or a rename (they run first; if one throws,
// nothing changes here).
import { createHash, randomBytes } from 'node:crypto'
import { newUid, subjectKey } from '@vihko/core'
import type { Db } from './db.ts'
import type { Actor } from './actor.ts'
import { AuthError, MIN_PASSWORD, hashPassword, validName, type Auth, type Role, type User } from './auth.ts'

/** How long a one-time link works. */
export const LINK_DAYS = 7

/** `invited`: never chose a password (a link may be pending). */
export type UserStatus = 'active' | 'invited' | 'disabled'

/** A user as the vihko admin sees them. */
export interface UserInfo {
  id: string
  username: string
  role: Role
  status: UserStatus
  createdAt: string
  /** When one of their sessions was last used (to the hour), or null. */
  lastSeenAt: string | null
  /** Sessions in force. */
  sessions: number
  /** Their groups' names. */
  groups: string[]
  /** A link that still works (never its token): what for, and until when. */
  link: { kind: LinkKind; expiresAt: string } | null
  /** Whether they set up a second factor (D-036), and since when (never the secret or the recovery codes). */
  twoFactor: { enabled: boolean; enabledAt: string | null }
}

export interface GroupInfo {
  id: string
  name: string
  members: { id: string; username: string }[]
}

/** What everyone signed in may see: names only, to share with them. */
export interface Directory {
  users: string[]
  groups: string[]
}

export type LinkKind = 'invite' | 'reset'

/** A new link: its token, shown this once (`/invite/<token>`). */
export interface NewLink {
  token: string
  kind: LinkKind
  expiresAt: string
}

export type UsersErrorCode =
  | 'not_found' // no such user or group
  | 'last_admin' // the last active admin can't stop being one
  | 'not_disabled' // only a disabled user is deleted
  | 'user_disabled' // no link for someone disabled
  | 'invalid_link' // unknown, used or expired: the same answer for all three
  | 'group_exists'
  | 'invalid_group_name'
  | 'invalid'

export class UsersError extends Error {
  readonly code: UsersErrorCode
  constructor(code: UsersErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * What follows a change of users or groups elsewhere. The grants ones are
 * filled by the permissions writer (piece P); until then they do nothing.
 */
export interface UserHooks {
  /** Before a user is deleted: their grants in vihko.yaml go. If it throws, the user isn't deleted. */
  onUserDeleted?(username: string, by: Actor): void | Promise<void>
  /**
   * After a user is deleted: their personal space is closed (D-056.8), so
   * whoever has one of its notes open elsewhere (a folder it shared) loses it
   * now (the hub checks every editor's access again).
   */
  onUserRemoved?(userId: string): void
  /** After someone joined or left a group: what they reach through it changed (the hub checks every editor's access again). */
  onMembersChanged?(): void
  /** Before a group is renamed: its grants follow it. If it throws, the group keeps its name. */
  onGroupRenamed?(from: string, to: string, by: Actor): void | Promise<void>
  /** Before a group is deleted: its grants go. If it throws, the group stays. */
  onGroupDeleted?(name: string, by: Actor): void | Promise<void>
  /**
   * Some of a user's sessions were ended (disabled, deleted, closed, a new
   * password): the live connections of those sessions (the hub's) end too.
   */
  onSessionsEnded?(userId: string): void
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

interface UserRow {
  id: string
  username: string
  role: Role
  password_hash: string
  created_at: string
  disabled: number
  deleted_at: string | null
}

export class Users {
  private db: Db
  private auth: Auth
  private now: () => Date
  readonly hooks: UserHooks

  constructor(auth: Auth, opts: { hooks?: UserHooks; now?: () => Date } = {}) {
    this.auth = auth
    this.db = auth.state
    this.now = opts.now ?? (() => new Date())
    this.hooks = opts.hooks ?? {}
  }

  // --- Users -------------------------------------------------------------------

  /** Everyone but the deleted, by name. */
  list(): UserInfo[] {
    const rows = this.db.prepare('select * from users where deleted_at is null order by username collate nocase').all() as UserRow[]
    return rows.map((r) => this.info(r))
  }

  get(id: string): UserInfo | null {
    const r = this.row(id)
    return r ? this.info(r) : null
  }

  /** A new user without a password, and the link to choose it. */
  async create(username: string, role: unknown): Promise<{ user: UserInfo; link: NewLink }> {
    const user = await this.auth.createUser(String(username ?? ''), null, checkRole(role))
    const link = this.newLink(user.id)
    return { user: this.get(user.id)!, link }
  }

  /**
   * A new one-time link for a user: an invitation if they never chose a
   * password, a reset otherwise. Any earlier link of theirs stops working.
   */
  newLink(id: string): NewLink {
    const kind = this.nextLinkKind(id)
    const token = randomBytes(32).toString('base64url')
    const now = this.now()
    const expiresAt = new Date(now.getTime() + LINK_DAYS * 86_400_000).toISOString()
    this.db.transaction(() => {
      this.db.prepare('delete from user_links where user_id = ?').run(id)
      this.db.prepare('insert into user_links (token_hash, user_id, kind, created_at, expires_at) values (?, ?, ?, ?, ?)')
        .run(sha256(token), id, kind, now.toISOString(), expiresAt)
    })()
    return { token, kind, expiresAt }
  }

  /**
   * What a new link for a user would be: an invitation if they never chose a
   * password, a reset otherwise. Throws if they get none (unknown, disabled).
   */
  nextLinkKind(id: string): LinkKind {
    const r = this.must(id)
    if (r.disabled) throw new UsersError('user_disabled', 'a disabled user gets no link: enable them first')
    return r.password_hash ? 'reset' : 'invite'
  }

  /** Whom a link is for, if it still works; null otherwise (unknown, used, expired, or its user disabled). */
  link(token: string): { kind: LinkKind; userId: string; username: string } | null {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    const r = this.db.prepare(`select l.kind, l.user_id, u.username from user_links l join users u on u.id = l.user_id
      where l.token_hash = ? and l.used_at is null and l.expires_at > ? and u.disabled = 0`).get(sha256(token), this.now().toISOString()) as
      { kind: LinkKind; user_id: string; username: string } | undefined
    return r ? { kind: r.kind, userId: r.user_id, username: r.username } : null
  }

  /**
   * Uses a link: the password becomes theirs, the link is spent, and every
   * session they had ends (a reset is also how a stolen session is thrown
   * out). A weak password leaves the link unused.
   */
  async accept(token: string, password: unknown): Promise<User> {
    if (!this.link(token)) throw new UsersError('invalid_link', 'this link is not valid (unknown, used or expired)')
    // The same check (and code) as everywhere else a password is chosen.
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new AuthError('weak_password', `password must be at least ${MIN_PASSWORD} characters`)
    const hash = await hashPassword(password)
    const userId = this.db.transaction(() => {
      // Checked again after hashing: two tabs with the same link, only one wins.
      const l = this.link(token)
      if (!l) throw new UsersError('invalid_link', 'this link is not valid (unknown, used or expired)')
      this.db.prepare('update user_links set used_at = ? where token_hash = ?').run(this.now().toISOString(), sha256(token))
      this.db.prepare('update users set password_hash = ? where id = ?').run(hash, l.userId)
      this.auth.endSessions(l.userId)
      return l.userId
    })()
    this.hooks.onSessionsEnded?.(userId)
    const r = this.must(userId)
    return { id: r.id, username: r.username, role: r.role, disabled: false }
  }

  setRole(id: string, role: unknown): UserInfo {
    const r = this.must(id)
    const to = checkRole(role)
    if (r.role === to) return this.info(r)
    this.db.transaction(() => {
      if (to !== 'admin') this.keepAnAdmin(id)
      this.db.prepare('update users set role = ? where id = ?').run(to, id)
    })()
    return this.get(id)!
  }

  /** Disables a user: they can't sign in, their sessions and connections end now, and their keys and OAuth authorizations stop working. */
  disable(id: string): UserInfo {
    this.must(id)
    this.db.transaction(() => {
      this.keepAnAdmin(id)
      this.db.prepare('update users set disabled = 1 where id = ?').run(id)
      this.db.prepare('delete from user_links where user_id = ?').run(id)
      // A code not yet exchanged would give tokens that could never be used: gone too.
      this.db.prepare('delete from oauth_codes where user_id = ?').run(id)
      this.auth.endSessions(id)
    })()
    this.hooks.onSessionsEnded?.(id)
    return this.get(id)!
  }

  /** Enables a disabled user again: their keys and authorizations work again; sessions they start anew. */
  enable(id: string): UserInfo {
    this.must(id)
    this.db.prepare('update users set disabled = 0 where id = ?').run(id)
    return this.get(id)!
  }

  /**
   * Deletes a disabled user, leaving their tombstone (id and name). Their
   * grants in vihko.yaml go first (`onUserDeleted`); if that fails, nothing
   * is deleted.
   */
  async remove(id: string, by: Actor): Promise<void> {
    const r = this.must(id)
    if (!r.disabled) throw new UsersError('not_disabled', 'only a disabled user can be deleted: disable them first')
    await this.hooks.onUserDeleted?.(r.username, by)
    this.db.transaction(() => {
      const now = this.now().toISOString()
      this.db.prepare("update users set deleted_at = ?, password_hash = '', disabled = 1 where id = ?").run(now, id)
      for (const t of ['sessions', 'user_links', 'profiles', 'group_members', 'oauth_codes', 'two_factor', 'recovery_codes', 'notices', 'pins']) this.db.prepare(`delete from ${t} where user_id = ?`).run(id)
      this.db.prepare('delete from oauth_tokens where key_id in (select id from api_keys where user_id = ?)').run(id)
      // Revoked for good, with nothing left that could prove to be them; the name stays for the history.
      this.db.prepare(`update api_keys set revoked_at = coalesce(revoked_at, ?), secret_hash = ?, previous_secret_hash = null, previous_until = null
        where user_id = ?`).run(now, sha256(randomBytes(32).toString('hex')), id)
    })()
    this.hooks.onSessionsEnded?.(id)
    this.hooks.onUserRemoved?.(id)
  }

  /** Ends every session of a user's (the admin's «Close sessions»). How many there were. */
  endSessions(id: string): number {
    this.must(id)
    const n = this.auth.endSessions(id)
    this.hooks.onSessionsEnded?.(id)
    return n
  }

  /** The names of a user's groups (the permissions read groups through this). */
  groupsOf(userId: string): string[] {
    return (this.db.prepare(`select g.name from group_members m join user_groups g on g.id = m.group_id
      where m.user_id = ? order by g.name collate nocase`).all(userId) as { name: string }[]).map((r) => r.name)
  }

  /** Names of users (not the deleted) and groups, for anyone signed in. */
  directory(): Directory {
    const users = (this.db.prepare('select username from users where deleted_at is null order by username collate nocase').all() as { username: string }[]).map((r) => r.username)
    const groups = (this.db.prepare('select name from user_groups order by name collate nocase').all() as { name: string }[]).map((r) => r.name)
    return { users, groups }
  }

  // --- Groups ------------------------------------------------------------------

  groups(): GroupInfo[] {
    const groups = this.db.prepare('select id, name from user_groups order by name collate nocase').all() as { id: string; name: string }[]
    const members = this.db.prepare(`select m.group_id, u.id, u.username from group_members m join users u on u.id = m.user_id
      where u.deleted_at is null order by u.username collate nocase`).all() as { group_id: string; id: string; username: string }[]
    return groups.map((g) => ({ ...g, members: members.filter((m) => m.group_id === g.id).map((m) => ({ id: m.id, username: m.username })) }))
  }

  createGroup(name: unknown): GroupInfo {
    const n = this.groupName(name)
    const id = newUid()
    this.db.prepare('insert into user_groups (id, name, created_at) values (?, ?, ?)').run(id, n, this.now().toISOString())
    return this.group(id)
  }

  async renameGroup(id: string, name: unknown, by: Actor): Promise<GroupInfo> {
    const g = this.group(id)
    const n = this.groupName(name, id)
    if (n === g.name) return g
    await this.hooks.onGroupRenamed?.(g.name, n, by)
    this.db.prepare('update user_groups set name = ? where id = ?').run(n, id)
    return this.group(id)
  }

  async deleteGroup(id: string, by: Actor): Promise<void> {
    const g = this.group(id)
    await this.hooks.onGroupDeleted?.(g.name, by)
    this.db.prepare('delete from user_groups where id = ?').run(id)
  }

  addMember(groupId: string, userId: string): GroupInfo {
    this.group(groupId)
    this.must(userId)
    this.db.prepare('insert or ignore into group_members (group_id, user_id) values (?, ?)').run(groupId, userId)
    this.hooks.onMembersChanged?.()
    return this.group(groupId)
  }

  removeMember(groupId: string, userId: string): GroupInfo {
    this.group(groupId)
    this.db.prepare('delete from group_members where group_id = ? and user_id = ?').run(groupId, userId)
    this.hooks.onMembersChanged?.()
    return this.group(groupId)
  }

  // --- Helpers -----------------------------------------------------------------

  private row(id: string): UserRow | null {
    return (this.db.prepare('select * from users where id = ? and deleted_at is null').get(id) as UserRow | undefined) ?? null
  }

  private must(id: string): UserRow {
    const r = this.row(id)
    if (!r) throw new UsersError('not_found', `no user ${id}`)
    return r
  }

  private group(id: string): GroupInfo {
    const g = this.groups().find((x) => x.id === id)
    if (!g) throw new UsersError('not_found', `no group ${id}`)
    return g
  }

  /** A valid group name nobody else has (`except`: the group being renamed). */
  private groupName(name: unknown, except?: string): string {
    const n = typeof name === 'string' ? name.normalize('NFC').trim() : ''
    if (!validName(n)) throw new UsersError('invalid_group_name', 'invalid group name (2-64 letters, digits, ".", "_" or "-", and not a name JavaScript objects have)')
    // As the permissions compare them (auth.ts `createUser`): not only ASCII's case.
    const key = subjectKey(n)
    const groups = this.db.prepare('select id, name from user_groups').all() as { id: string; name: string }[]
    if (groups.some((g) => g.id !== except && subjectKey(g.name) === key)) throw new UsersError('group_exists', `group ${n} already exists`)
    return n
  }

  /** Throws if `id` is the last admin who can sign in (enabled, with a password): they must stay one. */
  private keepAnAdmin(id: string) {
    const others = this.db.prepare(`select count(*) n from users where role = 'admin' and disabled = 0 and deleted_at is null
      and password_hash != '' and id != ?`).get(id) as { n: number }
    const r = this.row(id)!
    const isActiveAdmin = r.role === 'admin' && !r.disabled && r.password_hash !== ''
    if (isActiveAdmin && others.n === 0) throw new UsersError('last_admin', 'the last active admin must stay an enabled admin')
  }

  private info(r: UserRow): UserInfo {
    const now = this.now().toISOString()
    const s = this.db.prepare('select count(*) n, max(last_seen_at) seen from sessions where user_id = ? and expires_at > ?').get(r.id, now) as { n: number; seen: string | null }
    const link = this.db.prepare('select kind, expires_at from user_links where user_id = ? and used_at is null and expires_at > ?').get(r.id, now) as
      { kind: LinkKind; expires_at: string } | undefined
    const tf = this.db.prepare('select enabled_at from two_factor where user_id = ?').get(r.id) as { enabled_at: string } | undefined
    return {
      id: r.id, username: r.username, role: r.role,
      status: r.disabled ? 'disabled' : r.password_hash ? 'active' : 'invited',
      createdAt: r.created_at, lastSeenAt: s.seen, sessions: s.n, groups: this.groupsOf(r.id),
      link: link && !r.disabled ? { kind: link.kind, expiresAt: link.expires_at } : null,
      twoFactor: { enabled: !!tf, enabledAt: tf?.enabled_at ?? null },
    }
  }
}

function checkRole(v: unknown): Role {
  if (v !== 'admin' && v !== 'member') throw new UsersError('invalid', 'role must be admin or member')
  return v
}
