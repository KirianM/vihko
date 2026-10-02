// Permissions as they apply now: the rules of
// vihko.yaml (core/permissions.ts SpaceRules) resolved against the users and
// groups of state.db and the spaces on the disk. Access (access.ts) asks here
// what level a user has in a folder; the permissions API (http/permissions.ts)
// and the spaces API ask who has access, and why, and which spaces each
// person reaches.
//
// - Every note is in a space (core/spaces.ts): `people/<user>/`, which its
//   owner manages whatever is written and nobody else reaches unless a
//   folder in it is shared; or `spaces/<name>/`, whose members are
//   whoever its root's grants name. Anything outside the spaces is nobody's.
// - Grants only add (so nothing unseen takes up names): a person's level in a folder is the highest
//   the grants of it and of each folder above it in its space give them, by
//   name or through a group.
// - The space of a deleted person is nobody's, not even the admin's.
//   Being an admin changes nothing here: the admin manages, but doesn't read.
// - The section in force comes from the workspace (workspace.ts): the
//   file's, the last valid one while running, or none (no section, or
//   rejected when vihko started): then nothing is shared.
// - A grant to a user or group that doesn't exist is ignored, with a warning
//   (`unknownSubjects`): deleting someone never invalidates the section.
import {
  SpaceRules, atLeast, folderOf, maxLevel, parentFolder, parseSpacePath, personalRoot, rulesOf, sharedRoot, spaceOf, subjectKey,
  type ConfigError, type Grantee, type Level, type PermissionRule, type Permissions, type SharedSpace,
} from '@vihko/core'
import type { Role } from './auth.ts'
import type { Db } from './db.ts'

/** A user as the grants may name them. */
export interface DirectoryUser {
  id: string
  username: string
  role: Role
  /** Disabled by the admin: their grants stay, but they don't count as anyone's manager while so. */
  disabled?: boolean
}

/** Who exists, for the grants: users (active or disabled; a deleted one is not here) and groups. */
export interface Directory {
  users(): DirectoryUser[]
  /** The groups a user belongs to, by name (without `@`). */
  groupsOf(userId: string): string[]
  /** Every group's name (without `@`). */
  groups(): string[]
}

/** Groups as users.ts provides them. */
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
 * and their personal space is nobody's.
 */
export function stateDirectory(state: Db, groups: Partial<GroupSource> = {}): Directory {
  return {
    users: () => (state.prepare('select id, username, role, disabled from users where deleted_at is null order by username').all() as (Omit<DirectoryUser, 'disabled'> & { disabled: number })[])
      .map((u) => ({ ...u, disabled: u.disabled !== 0 })),
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
 * Which model levels come from. Only `spaces` since 0.1.0: the
 * option stays so that callers written against the transition keep
 * compiling; it changes nothing.
 */
export type PermissionsModel = 'spaces'

export interface PermissionsOptions {
  /** The section in force (workspace.ts `permissions`). */
  source: () => Permissions
  directory: Directory
  /** What exists on the disk (default: every space the rules name exists, and every folder). */
  folders?: SpaceFolders
  /** Ignored (see PermissionsModel). */
  model?: PermissionsModel
}

/** A user as a viewer of folders: who they are (their groups are looked up). */
export interface ViewerUser { id: string; username: string }

/** How one subject's grant reaches a folder. */
export interface GrantSource {
  subject: string
  level: Level
  /** The folder whose rule grants it (the folder itself, or one above it in its space). */
  from: string
  /** `manage` as the owner of the personal space (`from` is its root; no grant is written). */
  owner?: true
}

/** A user's access to a folder, and why. */
export interface UserAccess {
  id: string
  username: string
  level: Level
  /** The grants that give it: to them, or to a group of theirs; or their ownership of the space. */
  via: GrantSource[]
  /** Disabled by the admin: their access stays for when they're enabled, but they manage nothing meanwhile. */
  disabled?: true
}

/** A shared space as its members see it (GET /api/spaces): `{path, name}`, the name its folder's. */
export interface SpaceEntry {
  /** Its root, `spaces/<name>`. */
  path: string
  /** Its name: its folder's. */
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
  /** A shared space's root and name. */
  space?: { path: string; name: string }
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

/** A shared space for the admin's directory: no folder inside it is named. */
export interface SharedSpaceInfo {
  path: string
  name: string
  /** The users who manage it, sorted. */
  managers: string[]
  /** How many users have some level at its root (managers included). */
  members: number
  aiClosed: boolean
}

export class PermissionsEngine {
  private opts: PermissionsOptions
  private compiled: { from: Permissions; set: SpaceRules } | null = null

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

  /** Always `spaces` (PermissionsModel). */
  get model(): PermissionsModel {
    return 'spaces'
  }

  /**
   * The rules in force, compiled: the file's; none when it has no section or
   * it was rejected (then only each owner reaches their own personal space:
   * it doesn't depend on the file).
   */
  spaceRules(): SpaceRules {
    const p = this.opts.source()
    if (this.compiled?.from !== p) {
      this.compiled = { from: p, set: new SpaceRules(rulesOf(p)) }
      for (const fn of this.listeners) fn(this.compiled.set.rules)
    }
    return this.compiled.set
  }

  private listeners: ((rules: readonly PermissionRule[]) => void)[] = []

  /** Called with the rules each time those in force change (and once now): when each grant began is kept by them (grantStarts.ts). */
  onRules(fn: (rules: readonly PermissionRule[]) => void): void {
    this.listeners.push(fn)
    fn(this.spaceRules().rules)
  }

  /** What exists on the disk (the default: the spaces the rules name, and every folder). */
  private get folders(): SpaceFolders {
    return this.opts.folders ?? {
      shared: () => [...new Set(this.spaceRules().rules.map((r) => spaceOf(r.folder)).filter((s): s is SharedSpace => s?.kind === 'shared').map((s) => s.folder))],
      exists: () => true,
    }
  }

  /** Whether a folder exists on the disk (as SpaceFolders says). */
  folderExists(folder: string): boolean {
    return this.folders.exists(folder)
  }

  /** Whether a username is a user's (active or disabled; a deleted one isn't), as a folder spells it. */
  ownerCheck(users: readonly DirectoryUser[] = this.opts.directory.users()): (username: string) => boolean {
    const names = new Set(users.map((u) => u.username.normalize('NFC')))
    return (name) => names.has(name.normalize('NFC'))
  }

  /** Someone as the grants name them: their username and groups. */
  grantee(user: ViewerUser): Grantee {
    return { username: user.username, groups: this.opts.directory.groupsOf(user.id) }
  }

  /** A user's level in a folder (`viewer(user).level` remembers them for a request). Null: none. */
  levelFor(user: ViewerUser, folder: string, rules: SpaceRules = this.spaceRules()): Level | null {
    return rules.level(folder, this.grantee(user), this.ownerCheck())
  }

  /** What one user may do, folder by folder. Made per request: groups and users are read once. */
  viewer(user: ViewerUser): Viewer {
    return new Viewer(this, user)
  }

  /** A shared space's name: its folder's. Null for a path that isn't a shared space's root. */
  spaceName(root: string): string | null {
    const s = parseSpacePath(root)
    if (!s || s.space.kind !== 'shared' || s.inner !== '') return null
    return s.space.name
  }

  /**
   * The users who manage a folder, sorted by name. A disabled one doesn't
   * count: nobody could add people to a space whose only manager left, and
   * the admin couldn't name another (they assign one only where there's none).
   */
  managersOf(folder: string, rules: SpaceRules = this.spaceRules()): string[] {
    return this.readers(folder, rules).filter((r) => r.level === 'manage' && !r.disabled).map((r) => r.username).sort()
  }

  /** Every user with some level in a folder, with it (under `rules`, the rules in force by default). */
  readers(folder: string, rules: SpaceRules = this.spaceRules()): { id: string; username: string; level: Level; disabled: boolean }[] {
    const users = this.opts.directory.users()
    const exists = this.ownerCheck(users)
    const out: { id: string; username: string; level: Level; disabled: boolean }[] = []
    for (const u of users) {
      const level = rules.level(folder, this.grantee(u), exists)
      if (level) out.push({ id: u.id, username: u.username, level, disabled: u.disabled === true })
    }
    return out
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
   * What a person reaches: their personal space, the shared spaces they
   * belong to, and what others share with them outside those
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
      spaces.push({ path: s.root, name: s.name, level, managers: this.managersOf(s.root, rules), aiClosed: rules.aiClosedAt(s.root) !== null })
    }
    spaces.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
    return { personal: { path: personalRoot(user.username) }, spaces, shared: this.sharedWith(user) }
  }

  /**
   * What others share with a person outside their own space and the shared
   * spaces they belong to: each folder with grants where they have a level
   * and none in its parent (the topmost only), and that exists. A folder of
   * a deleted person's space is nobody's: never here.
   */
  sharedWith(user: ViewerUser): SharedEntry[] {
    const exists = this.ownerCheck()
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
        out.push({ path: f, level, space: { path: s.space.root, name: s.space.name } })
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  /** Every shared space on the disk, for the admin: its name, managers and how many members; nothing inside it. */
  sharedSpaces(): SharedSpaceInfo[] {
    const rules = this.spaceRules()
    const out: SharedSpaceInfo[] = []
    for (const s of this.existingShared()) {
      const readers = this.readers(s.root, rules)
      out.push({
        path: s.root, name: s.name,
        managers: readers.filter((r) => r.level === 'manage' && !r.disabled).map((r) => r.username).sort(),
        members: readers.length, aiClosed: rules.aiClosedAt(s.root) !== null,
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  }

  /** Every user with some access to a folder, and why: the grants that reach it, and ownership of a personal space. */
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
      if (level) out.push({ id: u.id, username: u.username, level, via, ...(u.disabled ? { disabled: true } : {}) })
    }
    return out
  }

  /** Every user with some access to a folder, and why (spaceAudience). */
  audience(folder: string): UserAccess[] {
    return this.spaceAudience(folder)
  }

  /**
   * Grants to users or groups that don't exist: ignored, and reported as
   * workspace warnings (`unknown_subject`, at the grant's key path).
   */
  unknownSubjects(): ConfigError[] {
    const users = new Set(this.opts.directory.users().map((u) => subjectKey(u.username)))
    const groups = new Set(this.opts.directory.groups().map((g) => subjectKey('@' + g)))
    const out: ConfigError[] = []
    for (const r of rulesOf(this.opts.source())) {
      for (const s of Object.keys(r.grants ?? {})) {
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
  private rules: SpaceRules
  private who: Grantee
  private owners: (name: string) => boolean
  private levels = new Map<string, Level | null>()

  constructor(engine: PermissionsEngine, user: ViewerUser) {
    this.user = user
    this.rules = engine.spaceRules()
    this.who = engine.grantee(user)
    this.owners = engine.ownerCheck()
  }

  /** The user's level in a folder; null: no access (always, outside the spaces). */
  level(folder: string): Level | null {
    const f = folder.normalize('NFC')
    const known = this.levels.get(f)
    if (known !== undefined) return known
    const level = this.rules.level(f, this.who, this.owners)
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
    return this.rules.aiClosedAt(folder) !== null
  }

  /** The rule written for exactly this folder, if any. */
  own(folder: string): PermissionRule | null {
    return this.rules.own(folder)
  }
}
