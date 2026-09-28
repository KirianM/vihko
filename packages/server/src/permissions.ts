// Per-folder permissions as they apply now (D-014, D-038): the rules of
// vihko.yaml (core/permissions.ts) resolved against the users and groups of
// state.db. Access (access.ts) asks here what level a user has in a folder;
// the permissions API (http/permissions.ts) asks who has access and why.
//
// - The section in force comes from the workspace (workspace.ts): the file's,
//   the last valid one while running, the implicit one without a section
//   (every admin manages the root) or none at all (closed: nobody reads).
// - A user's level in a folder is the highest the grants that govern it give
//   them, by name or through a group, or `manage` if they manage a folder
//   above it (D-040 3.5: grants of its own never lock out whoever manages
//   above), unless a personal folder (a `{user}` rule's) lies between: no
//   manager from above crosses into one. Being an admin changes nothing here
//   (D-038.1): the admin reads only what is granted, or what they manage
//   from above, never a personal folder that isn't shared with them.
// - A grant to a user or group that doesn't exist is ignored, with a warning
//   (`unknownSubjects`): deleting someone never invalidates the section.
import {
  RuleSet, USER_SEGMENT, atLeast, folderOf, grantsAt, levelInReach, maxLevel, reachingGrants, subjectKey,
  type ConfigError, type Governing, type Level, type PermissionRule, type Permissions, type Reaching,
} from '@vihko/core'
import type { Role } from './auth.ts'
import type { Db } from './db.ts'

/** A user as the grants may name them. */
export interface DirectoryUser {
  id: string
  username: string
  role: Role
}

/**
 * Who exists, for the grants: users (active or disabled; a deleted one is
 * not here) and groups. Groups come from piece U (state.db); until then a
 * user belongs to none.
 */
export interface Directory {
  users(): DirectoryUser[]
  /** The groups a user belongs to, by name (without `@`). */
  groupsOf(userId: string): string[]
  /** Every group's name (without `@`). */
  groups(): string[]
}

/** Groups as piece U provides them. */
export interface GroupSource {
  groupsOf(userId: string): string[]
  groups(): string[]
}

/** The groups of users.ts (state.db), as the permissions read them. */
export function groupSource(users: { groupsOf(userId: string): string[]; groups(): { name: string }[] }): GroupSource {
  return { groupsOf: (id) => users.groupsOf(id), groups: () => users.groups().map((g) => g.name) }
}

/**
 * The directory over state.db's users, and the groups `groups` gives (none by
 * default). A deleted user is unknown: their name in a grant reaches nobody,
 * and a `{user}` folder of theirs matches no one (D-038.8).
 */
export function stateDirectory(state: Db, groups: Partial<GroupSource> = {}): Directory {
  return {
    users: () => state.prepare('select id, username, role from users where deleted_at is null order by username').all() as DirectoryUser[],
    groupsOf: groups.groupsOf ?? (() => []),
    groups: groups.groups ?? (() => []),
  }
}

export interface PermissionsOptions {
  /** The section in force (workspace.ts `permissions`). */
  source: () => Permissions
  directory: Directory
}

/** A user as a viewer of folders: who they are and their groups. */
export interface ViewerUser { id: string; username: string }

/** How one subject's grant reaches a folder. */
export interface GrantSource {
  subject: string
  level: Level
  /** The folder whose rule grants it (the folder itself, or an ancestor). */
  from: string
  /** The rule's key as written (`personas/{user}`), when it isn't `from`. */
  rule?: string
  /** A `manage` grant of a folder above (`from`), which reaches here whatever this folder's grants say (D-040 3.5). */
  above?: true
}

/** A user's access to a folder, and why. */
export interface UserAccess {
  id: string
  username: string
  level: Level
  /** The grants that give it: to them, or to a group of theirs. */
  via: GrantSource[]
}

export class PermissionsEngine {
  private opts: PermissionsOptions
  private compiled: { from: Permissions; set: RuleSet | null } | null = null

  constructor(opts: PermissionsOptions) {
    this.opts = opts
  }

  get directory(): Directory {
    return this.opts.directory
  }

  /** The section in force. */
  get section(): Permissions {
    return this.opts.source()
  }

  /**
   * The rules in force, compiled: the file's, or the implicit rule (each
   * admin manages the root, recomputed each time: admins change). Null when
   * closed: nobody reads anything.
   */
  rules(users?: readonly DirectoryUser[]): RuleSet | null {
    const p = this.opts.source()
    if (p.kind === 'closed') return null
    if (p.kind === 'implicit') {
      const admins = (users ?? this.opts.directory.users()).filter((u) => u.role === 'admin').map((u) => u.username)
      return new RuleSet([{ folder: '', grants: Object.fromEntries(admins.map((a) => [a, 'manage' as Level])), ai: null }])
    }
    if (this.compiled?.from !== p) this.compiled = { from: p, set: new RuleSet(p.rules) }
    return this.compiled.set
  }

  /** What one user may do, folder by folder. Made per request: groups and users are read once. */
  viewer(user: ViewerUser): Viewer {
    return new Viewer(this, user)
  }

  /** The grants that govern a folder, with `{user}` resolved (a folder named like nobody: none). */
  grantsAt(folder: string, users?: readonly DirectoryUser[]): { governing: Governing | null; grants: Record<string, Level> } {
    const list = users ?? this.opts.directory.users()
    const set = this.rules(list)
    const g = set?.governing(folder) ?? null
    if (!g) return { governing: null, grants: {} }
    const names = new Set(list.map((u) => subjectKey(u.username)))
    return { governing: g, grants: grantsAt(g, (n) => names.has(subjectKey(n))) }
  }

  /**
   * What reaches a folder: the grants that govern it (`grantsAt`) and whoever
   * manages it from above (D-040 3.5). Empty when closed.
   */
  reaching(folder: string, users?: readonly DirectoryUser[]): Reaching {
    const list = users ?? this.opts.directory.users()
    const set = this.rules(list)
    if (!set) return { governing: null, grants: {}, above: [] }
    const names = new Set(list.map((u) => subjectKey(u.username)))
    return reachingGrants(set, folder, (n) => names.has(subjectKey(n)))
  }

  /** Every user with some access to a folder, and why (the effective access, D-038). */
  audience(folder: string): UserAccess[] {
    const users = this.opts.directory.users()
    const { governing, grants, above } = this.reaching(folder, users)
    const out: UserAccess[] = []
    for (const u of users) {
      const groups = new Set(this.opts.directory.groupsOf(u.id).map((g) => subjectKey('@' + g)))
      const mine = (subject: string) => subjectKey(subject) === subjectKey(u.username) || groups.has(subjectKey(subject))
      const via: GrantSource[] = []
      if (governing) {
        for (const [subject, level] of Object.entries(grants)) {
          if (mine(subject)) via.push({ subject, level, from: governing.at, ...(governing.rule.folder !== governing.at ? { rule: governing.rule.folder } : {}) })
        }
      }
      // Managing a folder above: said once per grant, unless it's the grant that governs here anyway (inherited).
      for (const m of above) {
        if (!mine(m.subject) || (m.from === governing?.at && via.some((v) => v.subject === m.subject))) continue
        via.push({ subject: m.subject, level: 'manage', from: m.from, ...(m.rule ? { rule: m.rule } : {}), above: true })
      }
      const level = via.reduce<Level | null>((l, v) => maxLevel(l, v.level), null)
      if (level) out.push({ id: u.id, username: u.username, level, via })
    }
    return out
  }

  /**
   * Grants to users or groups that don't exist: ignored, and reported as
   * workspace warnings (`unknown_subject`, at the grant's key path). `{user}`
   * is never unknown: it names whoever the folder is named after.
   */
  unknownSubjects(): ConfigError[] {
    const p = this.opts.source()
    if (p.kind !== 'rules') return []
    const users = new Set(this.opts.directory.users().map((u) => subjectKey(u.username)))
    const groups = new Set(this.opts.directory.groups().map((g) => subjectKey('@' + g)))
    const out: ConfigError[] = []
    for (const r of p.rules) {
      for (const s of Object.keys(r.grants ?? {})) {
        if (s === USER_SEGMENT) continue
        const k = subjectKey(s)
        if (s.startsWith('@') ? groups.has(k) : users.has(k)) continue
        out.push({ code: 'unknown_subject', at: `permissions.${r.folder}.grants.${s}`, line: null, detail: s })
      }
    }
    return out
  }
}

/** One user's levels, folder by folder, remembered for the request. */
export class Viewer {
  readonly user: ViewerUser
  private engine: PermissionsEngine
  private set: RuleSet | null
  private names: Set<string>
  private groups: string[]
  private levels = new Map<string, Level | null>()

  constructor(engine: PermissionsEngine, user: ViewerUser) {
    this.engine = engine
    this.user = user
    const users = engine.directory.users()
    this.set = engine.rules(users)
    this.names = new Set(users.map((u) => subjectKey(u.username)))
    this.groups = engine.directory.groupsOf(user.id)
  }

  /** The user's level in a folder (`""` the root); null: no access. */
  level(folder: string): Level | null {
    const f = folder.normalize('NFC')
    const known = this.levels.get(f)
    if (known !== undefined) return known
    const level = this.set ? levelInReach(reachingGrants(this.set, f, (n) => this.names.has(subjectKey(n))), { username: this.user.username, groups: this.groups }) : null
    if (this.levels.size > 20_000) this.levels.clear()
    this.levels.set(f, level)
    return level
  }

  /** The level in the folder a path (a note, an image) is in. */
  levelOf(path: string): Level | null {
    return this.level(folderOf(path))
  }

  /** Whether the user reaches `need` in the folder of `path`. */
  can(path: string, need: Level): boolean {
    return atLeast(this.levelOf(path), need)
  }

  /** Whether a folder (or one above it) is closed to agents (`ai: false`). */
  aiClosed(folder: string): boolean {
    return this.set?.aiClosedAt(folder) != null
  }

  /** The rule written for exactly this folder, if any. */
  own(folder: string): { rule: PermissionRule; user: string | null } | null {
    return this.set?.own(folder) ?? null
  }
}
