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
//
// The spaces model of 0.1.0 (D-056, core/spaces.ts, core/permissions.ts
// SpaceRules) is here too: `levelFor`, `spacesFor`, `sharedWith`,
// `sharedSpaces`, `spaceName`, `spaceAudience`. The option `model` says which
// one `viewer` and `audience` (and so Access) follow; `legacy` until every
// caller is switched (piece E, step 2), when the 1.0 model goes.
import {
  RuleSet, SpaceRules, USER_SEGMENT, atLeast, folderOf, grantsAt, levelInReach, maxLevel, parentFolder, parseSpacePath, personalRoot, reachingGrants, sharedRoot, spaceOf, subjectKey,
  type ConfigError, type Governing, type Grantee, type Level, type PermissionRule, type Permissions, type Reaching, type SharedSpace,
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

/**
 * The shared spaces and folders that exist on the disk, for what the engine
 * lists (a grant on a folder that doesn't exist is kept, but lists nothing).
 * `diskSpaceFolders` (spaceFolders.ts) reads them from the notes folder.
 */
export interface SpaceFolders {
  /** The folders directly under `spaces/` (their names, as the disk spells them). */
  shared(): readonly string[]
  /** Whether a folder (from the notes root) exists. */
  exists(folder: string): boolean
}

/**
 * Which model levels come from:
 * - `legacy`: 1.0's (a folder's own grants replace its parent's, `{user}`
 *   rules, the implicit root). Until piece E's second step switches every
 *   caller, the default.
 * - `spaces`: 0.1.0's (D-056): personal and shared spaces, sharing only adds.
 * The spaces methods (`spacesFor`, `sharedWith`, `sharedSpaces`, `spaceName`,
 * `spaceRules`) always use the spaces model.
 */
export type PermissionsModel = 'legacy' | 'spaces'

export interface PermissionsOptions {
  /** The section in force (workspace.ts `permissions`). */
  source: () => Permissions
  directory: Directory
  /** What exists on the disk (default: every space the rules name exists, and every folder). */
  folders?: SpaceFolders
  model?: PermissionsModel
}

/** A shared space as its members see it (GET /api/spaces, D-056.14: `{id, name, path}`). */
export interface SpaceEntry {
  /** Its root, `spaces/<readable>-<id>`. */
  path: string
  id: string
  /** Its name (vihko.yaml's, else the folder's readable part). */
  name: string
  /** The person's level at its root. */
  level: Level
  /** The users who manage it (by name, or through a group), sorted. */
  managers: string[]
  /** Whether its root is closed to agents. */
  aiClosed: boolean
}

/**
 * A folder shared with someone who isn't a member of its space: a folder of
 * someone else's personal space (`owner`), or a subfolder of a shared space
 * they don't belong to (`space`). The topmost such folder only.
 */
export interface SharedEntry {
  path: string
  level: Level
  /** A personal space's owner. */
  owner?: string
  /** A shared space's root, id and name. */
  space?: { path: string; id: string; name: string }
}

/** What one person reaches, space by space. */
export interface SpacesView {
  /** Their own space's root (`people/<username>`). */
  personal: { path: string }
  /** The shared spaces they are members of (some level at the root), by name. */
  spaces: SpaceEntry[]
  /** What others share with them outside those (SharedEntry), by path. */
  shared: SharedEntry[]
}

/** A shared space for the admin's directory (spec §2.4, §5.7): no folder inside it is named. */
export interface SharedSpaceInfo {
  path: string
  id: string
  name: string
  /** The users who manage it, sorted. */
  managers: string[]
  /** How many users have some level at its root (managers included). */
  members: number
  aiClosed: boolean
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
  /** Spaces model: `manage` as the owner of the personal space (`from` is its root; no grant is written). */
  owner?: true
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
  private spaceCompiled: { from: Permissions; set: SpaceRules } | null = null

  constructor(opts: PermissionsOptions) {
    this.opts = opts
  }

  get directory(): Directory {
    return this.opts.directory
  }

  /** Which model the levels of `viewer` and `audience` come from. */
  get model(): PermissionsModel {
    return this.opts.model ?? 'legacy'
  }

  // --- Spaces model (D-056) -------------------------------------------------------

  /**
   * The rules of the spaces model in force: the file's; none when it has no
   * section or it was rejected (then only each owner reaches their own
   * personal space: it doesn't depend on the file).
   */
  spaceRules(): SpaceRules {
    const p = this.opts.source()
    if (this.spaceCompiled?.from !== p) this.spaceCompiled = { from: p, set: new SpaceRules(p.kind === 'rules' ? p.rules : []) }
    return this.spaceCompiled.set
  }

  /** What exists on the disk (the default: the spaces the rules name, and every folder). */
  private get folders(): SpaceFolders {
    return this.opts.folders ?? {
      shared: () => [...new Set(this.spaceRules().rules.map((r) => spaceOf(r.folder)).filter((s): s is SharedSpace => s?.kind === 'shared').map((s) => s.folder))],
      exists: () => true,
    }
  }

  /** Whether a username is a user's (active or disabled; a deleted one isn't), as a folder spells it. */
  private ownerCheck(users: readonly DirectoryUser[]): (username: string) => boolean {
    const names = new Set(users.map((u) => u.username.normalize('NFC')))
    return (name) => names.has(name.normalize('NFC'))
  }

  /** Someone as the grants name them: their username and groups. */
  private grantee(user: ViewerUser): Grantee {
    return { username: user.username, groups: this.opts.directory.groupsOf(user.id) }
  }

  /**
   * A user's level in a folder under the spaces model, whatever `model` says
   * (`viewer(user).level` follows `model`). Null: none.
   */
  levelFor(user: ViewerUser, folder: string): Level | null {
    return this.spaceRules().level(folder, this.grantee(user), this.ownerCheck(this.opts.directory.users()))
  }

  /** A shared space's name: vihko.yaml's, else its folder's readable part. Null for a path that isn't a shared space's root. */
  spaceName(root: string): string | null {
    const s = parseSpacePath(root)
    if (!s || s.space.kind !== 'shared' || s.inner !== '') return null
    return this.spaceRules().name(s.space.root) ?? s.space.readable
  }

  /** The users who manage a folder (spaces model), sorted by name. */
  private managersOf(folder: string, users: readonly DirectoryUser[], exists: (n: string) => boolean): string[] {
    const rules = this.spaceRules()
    return users.filter((u) => rules.level(folder, this.grantee(u), exists) === 'manage').map((u) => u.username).sort()
  }

  /** The shared spaces that exist on the disk, each with its root. */
  private existingShared(): SharedSpace[] {
    const out: SharedSpace[] = []
    for (const folder of this.folders.shared()) {
      const s = spaceOf(sharedRoot(folder))
      if (s?.kind === 'shared') out.push(s)
    }
    return out
  }

  /**
   * What a person reaches (spaces model): their personal space, the shared
   * spaces they belong to, and what others share with them outside those
   * (`sharedWith`). Only what exists on the disk; nothing about keys (the
   * caller limits an agent to its key's folders and `ai: false`).
   */
  spacesFor(user: ViewerUser): SpacesView {
    const users = this.opts.directory.users()
    const exists = this.ownerCheck(users)
    const rules = this.spaceRules()
    const me = this.grantee(user)
    const spaces: SpaceEntry[] = []
    for (const s of this.existingShared()) {
      const level = rules.level(s.root, me, exists)
      if (!level) continue
      spaces.push({ path: s.root, id: s.id, name: this.spaceName(s.root)!, level, managers: this.managersOf(s.root, users, exists), aiClosed: rules.aiClosedAt(s.root) !== null })
    }
    spaces.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
    return { personal: { path: personalRoot(user.username) }, spaces, shared: this.sharedWith(user) }
  }

  /**
   * What others share with a person outside their own space and the shared
   * spaces they belong to (spaces model): each folder with grants where they
   * have a level and none in its parent (the topmost only), and that exists.
   * A folder of a deleted person's space is nobody's: never here.
   */
  sharedWith(user: ViewerUser): SharedEntry[] {
    const users = this.opts.directory.users()
    const exists = this.ownerCheck(users)
    const rules = this.spaceRules()
    const me = this.grantee(user)
    const out: SharedEntry[] = []
    for (const folder of rules.granted()) {
      const s = parseSpacePath(folder)
      if (!s || s.inner === '') continue
      if (s.space.kind === 'personal' && s.space.owner === user.username.normalize('NFC')) continue
      const f = folder.normalize('NFC')
      const level = rules.level(f, me, exists)
      if (!level || rules.level(parentFolder(f)!, me, exists) !== null) continue
      if (!this.folders.exists(f)) continue
      if (s.space.kind === 'personal') out.push({ path: f, level, owner: s.space.owner })
      else {
        if (!this.folders.exists(s.space.root)) continue
        out.push({ path: f, level, space: { path: s.space.root, id: s.space.id, name: this.spaceName(s.space.root)! } })
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  /** Every shared space on the disk, for the admin (spec §2.4): its name, managers and how many members; nothing inside it. */
  sharedSpaces(): SharedSpaceInfo[] {
    const users = this.opts.directory.users()
    const exists = this.ownerCheck(users)
    const rules = this.spaceRules()
    const out: SharedSpaceInfo[] = []
    for (const s of this.existingShared()) {
      let members = 0
      const managers: string[] = []
      for (const u of users) {
        const level = rules.level(s.root, this.grantee(u), exists)
        if (level) members++
        if (level === 'manage') managers.push(u.username)
      }
      out.push({ path: s.root, id: s.id, name: this.spaceName(s.root)!, managers: managers.sort(), members, aiClosed: rules.aiClosedAt(s.root) !== null })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  }

  /** Every user with some access to a folder under the spaces model, and why: the grants that reach it, and ownership of a personal space. */
  spaceAudience(folder: string): UserAccess[] {
    const users = this.opts.directory.users()
    const exists = this.ownerCheck(users)
    const f = folder.normalize('NFC')
    const s = parseSpacePath(f)
    if (!s) return []
    if (s.space.kind === 'personal' && !exists(s.space.owner)) return []
    const reaching = this.spaceRules().reaching(f)
    const out: UserAccess[] = []
    for (const u of users) {
      const groups = new Set(this.opts.directory.groupsOf(u.id).map((g) => subjectKey('@' + g)))
      const via: GrantSource[] = []
      if (s.space.kind === 'personal' && u.username.normalize('NFC') === s.space.owner) via.push({ subject: u.username, level: 'manage', from: s.space.root, owner: true })
      for (const g of reaching) {
        const k = subjectKey(g.subject)
        if (k === subjectKey(u.username) || groups.has(k)) via.push({ subject: g.subject, level: g.level, from: g.from })
      }
      const level = via.reduce<Level | null>((l, v) => maxLevel(l, v.level), null)
      if (level) out.push({ id: u.id, username: u.username, level, via })
    }
    return out
  }

  // --- 1.0 model (legacy, until piece E's second step) ----------------------------

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
    if (this.model === 'spaces') return this.spaceAudience(folder)
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
  /** Spaces model: its rules and who exists (null under the legacy model). */
  private spaces: { rules: SpaceRules; owners: Set<string> } | null

  constructor(engine: PermissionsEngine, user: ViewerUser) {
    this.engine = engine
    this.user = user
    const users = engine.directory.users()
    this.set = engine.model === 'legacy' ? engine.rules(users) : null
    this.names = new Set(users.map((u) => subjectKey(u.username)))
    this.groups = engine.directory.groupsOf(user.id)
    this.spaces = engine.model === 'spaces' ? { rules: engine.spaceRules(), owners: new Set(users.map((u) => u.username.normalize('NFC'))) } : null
  }

  /** The user's level in a folder (`""` the root); null: no access. */
  level(folder: string): Level | null {
    const f = folder.normalize('NFC')
    const known = this.levels.get(f)
    if (known !== undefined) return known
    const sp = this.spaces
    const level = sp ? sp.rules.level(f, { username: this.user.username, groups: this.groups }, (n) => sp.owners.has(n.normalize('NFC')))
      : this.set ? levelInReach(reachingGrants(this.set, f, (n) => this.names.has(subjectKey(n))), { username: this.user.username, groups: this.groups }) : null
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
    if (this.spaces) return this.spaces.rules.aiClosedAt(folder) !== null
    return this.set?.aiClosedAt(folder) != null
  }

  /** The rule written for exactly this folder, if any. */
  own(folder: string): { rule: PermissionRule; user: string | null } | null {
    return this.set?.own(folder) ?? null
  }
}
