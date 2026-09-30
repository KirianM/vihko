// Spaces as people and the admin use them (D-056, spec §2.4, §2.6, §3.2,
// §5.1–§5.2, §6.1): what a person reaches, creating and renaming shared
// spaces, leaving one, pinning what others share, and the admin's directory,
// managers, joining, and what becomes of a deleted person's space.
//
// - Who reaches what is the permissions engine's (permissions.ts, spaces
//   model); the members of a space are the grants at its root in vihko.yaml,
//   written through PermissionsFile, one change at a time. Nothing here adds
//   rules to the engine.
// - Asking about a path the person can't see answers `not_found`, whether it
//   exists or not; one they see but can't change this way, `forbidden`.
// - A shared space's folder is `spaces/<readable>-<id>` and never changes
//   (D-056.14): renaming one changes its name in vihko.yaml, not the folder.
//   Names are not unique: the id tells spaces apart, and names are no secret
//   (spec §3.4 row 9).
// - Agents only read what a person reaches (`view`); everything else is for
//   people (spec §2.5).
import { lstatSync, mkdirSync, readdirSync, rmdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  LEVELS, SPACES, SpaceRules, isSpaceRoot, maxLevel, newSpaceFolder, parseSpaceFolder, parseSpacePath, personalRoot, rulesInFile, setRule, sharedRoot, spaceNameProblem, subjectKey,
  type Level, type PermissionRule, type RuleValue,
} from '@vihko/core'
import type { Access } from './access.ts'
import { AccessError } from './access.ts'
import type { Actor } from './actor.ts'
import type { AdminSettings } from './adminSettings.ts'
import type { Db } from './db.ts'
import type { FolderRefs } from './folderRefs.ts'
import { followable } from './fsutil.ts'
import type { Indexer } from './indexer.ts'
import { NoteError, NoteService } from './notes.ts'
import type { Notices } from './notices.ts'
import type { PermissionsEngine, SharedEntry, SharedSpaceInfo, SpaceEntry } from './permissions.ts'
import type { PermissionsFile } from './permissionsFile.ts'
import type { Users } from './users.ts'

/** A request about spaces that can't be made as it is: `invalid` and `space_needs_manager` (400), `leave_via_group` and `space_has_managers` (409). */
export class SpaceError extends Error {
  readonly status: 400 | 409
  readonly code: 'invalid' | 'leave_via_group' | 'space_has_managers' | 'space_needs_manager'
  readonly extra: Record<string, unknown>
  constructor(status: SpaceError['status'], code: SpaceError['code'], message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

/** What someone received, with whether they pinned it in the sidebar. */
export type SharedView = SharedEntry & { pinned: boolean }

/** GET /api/spaces: what a person (or an agent, within its key) reaches. */
export interface SpacesResponse {
  /** Their own space; null for an agent whose key doesn't reach it. */
  personal: { path: string } | null
  spaces: SpaceEntry[]
  shared: SharedView[]
  /** Whether they may create a shared space (the setting `spacesCreation`, D-056.5); never an agent. */
  canCreate: boolean
}

/** A deleted person's personal space still on the disk: closed, nobody sees it (D-056.8). */
export interface ClosedSpace {
  userId: string
  username: string
  path: string
}

/** What becoming of a deleted person's space involves (a dry run), as counts: nothing of its content is named. */
export interface PersonalSpacePlan {
  action: PersonalAction
  from: string
  /** Where it goes (null: deleted, or a dry run of a conversion, whose id is drawn when it's made). */
  to: string | null
  notes: number
  files: number
  /** Its folders shared with others, and how many people those reach (its owner aside). */
  sharedFolders: number
  people: number
}

export type PersonalAction = 'transfer' | 'convert' | 'delete'

/** What a person's space holds shared, for the confirmation of deleting them (spec §2.6): counts only. */
export interface PersonalSummary {
  path: string
  exists: boolean
  sharedFolders: number
  people: number
}

export interface SpaceServiceOptions {
  notesDir: string
  state: Db
  engine: PermissionsEngine
  file: PermissionsFile
  users: Users
  notices: Notices
  settings: AdminSettings
  refs: FolderRefs
  notes: NoteService
  indexer: Indexer
  /** Deletes a folder as a principal (scoped.ts `deleteFolder`): a shared space goes this way. */
  deleteFolder: (access: Access, path: string, opts: { trash: boolean }) => Promise<unknown>
  log?: (msg: string) => void
  now?: () => Date
}

export class SpaceService {
  private opts: SpaceServiceOptions

  constructor(opts: SpaceServiceOptions) {
    this.opts = opts
  }

  private get engine() {
    return this.opts.engine
  }

  private now(): string {
    return (this.opts.now?.() ?? new Date()).toISOString()
  }

  // --- What a person reaches --------------------------------------------------------

  /**
   * Their space, the shared spaces they belong to and what others share with
   * them, with what they pinned. For an agent, only what its key reaches (its
   * folders, out of folders closed to agents).
   */
  view(access: Access): SpacesResponse {
    const v = this.engine.spacesFor(access.user)
    const pins = new Set(this.pinsOf(access.user.id))
    const reach = (path: string) => access.folderInScope(path)
    return {
      personal: reach(v.personal.path) ? v.personal : null,
      spaces: v.spaces.filter((s) => reach(s.path)),
      shared: v.shared.filter((s) => reach(s.path)).map((s) => ({ ...s, pinned: pins.has(s.path) })),
      canCreate: !access.isAgent && (access.user.role === 'admin' || this.opts.settings.spacesCreation() === 'everyone'),
    }
  }

  private pinsOf(userId: string): string[] {
    return (this.opts.state.prepare('select path from pins where user_id = ? order by created_at, path').all(userId) as { path: string }[]).map((r) => r.path)
  }

  // --- Shared spaces ---------------------------------------------------------------

  /**
   * A new shared space named `name`: its folder under `spaces/`, and its rule
   * with the name and its members, the creator managing it (D-056.5). With
   * the setting `spacesCreation: admins`, only an admin may. `members`: more
   * people or groups, with their level.
   */
  async create(access: Access, input: { name: unknown; members?: unknown }): Promise<SpaceEntry> {
    const user = this.person(access)
    if (this.opts.settings.spacesCreation() === 'admins' && user.role !== 'admin') throw new AccessError('only admins create shared spaces here')
    const name = this.spaceName(input.name)
    const members = this.members(input.members ?? {})
    // The creator manages it, whatever `members` says of them.
    for (const k of Object.keys(members)) if (subjectKey(k) === subjectKey(user.username)) delete members[k]
    const grants: Record<string, Level> = { [user.username]: 'manage', ...members }
    const root = this.newSharedFolder(name)
    let before = ''
    try {
      await this.opts.file.update((t) => {
        before = t
        return setRule(t, root, { name, grants, ai: null })
      }, { actor: access.actor })
    } catch (err) {
      try { rmdirSync(join(this.opts.notesDir, root)) } catch { /* something landed in it: left */ }
      throw err
    }
    this.opts.indexer.indexFolders([root])
    // Its first members are told they were added.
    this.notifyShared(root, before, access.actor)
    return this.entry(access, root)
  }

  /** Renames a shared space (`manage` at its root): only its name in vihko.yaml changes, never its folder (D-056.14). */
  async rename(access: Access, path: unknown, name: unknown): Promise<SpaceEntry> {
    this.person(access)
    const root = this.sharedRootFor(access, path, 'manage')
    const n = this.spaceName(name)
    await this.opts.file.update((t) => {
      const current = rulesInFile(t).get(root) ?? { grants: null, ai: null }
      return setRule(t, root, { ...current, name: n })
    }, { actor: access.actor })
    return this.entry(access, root)
  }

  /**
   * Deletes a shared space (`manage` at its root): what it holds to the trash
   * (with `trash`; otherwise only an empty one), and its rules out of
   * vihko.yaml (scoped.ts `deleteFolder`). Pins under it go.
   */
  async remove(access: Access, path: unknown, opts: { trash: boolean }): Promise<{ path: string }> {
    this.person(access)
    const root = this.sharedRootFor(access, path, 'manage')
    await this.opts.deleteFolder(access, root, { trash: opts.trash })
    this.opts.state.prepare("delete from pins where path = ? or path like ? escape '\\'").run(root, likePrefix(root))
    return { path: root }
  }

  /**
   * Leaves a space or stops seeing a folder received (spec §2.6): the
   * person's own grants there and under it go; nothing is deleted. One who
   * reaches it through a group can't (`leave_via_group`: the admin takes them
   * out of it); one who reaches it from a folder above leaves that one.
   */
  async leave(access: Access, path: unknown): Promise<{ path: string }> {
    const user = this.person(access)
    const p = this.folderArg(path)
    const s = parseSpacePath(p)
    if (!s || access.level(p) === null) throw notFound()
    if (s.space.kind === 'personal' && s.space.owner === user.username.normalize('NFC')) throw new SpaceError(400, 'invalid', 'your own space can\'t be left')
    const me = subjectKey(user.username)
    const groups = new Map(this.opts.users.groupsOf(user.id).map((g) => [subjectKey('@' + g), g]))
    const reaching = this.engine.spaceRules().reaching(p)
    const group = reaching.find((g) => groups.has(subjectKey(g.subject)))
    if (group) throw new SpaceError(409, 'leave_via_group', `reached through @${groups.get(subjectKey(group.subject))}: the admin takes them out of the group`, { group: groups.get(subjectKey(group.subject)) })
    const above = reaching.find((g) => g.from !== p && subjectKey(g.subject) === me)
    if (above) throw new SpaceError(400, 'invalid', `granted at ${above.from}: leave that folder instead`)
    await this.opts.file.update((t) => {
      let out = t
      for (const [folder, v] of rulesInFile(t)) {
        if ((folder !== p && !folder.startsWith(p + '/')) || !v.grants) continue
        const grants = Object.fromEntries(Object.entries(v.grants).filter(([k]) => subjectKey(k) !== me))
        if (Object.keys(grants).length === Object.keys(v.grants).length) continue
        // A space's root keeps its name (and an empty list of members); another folder left without grants loses its rule's grants.
        const keep = Object.keys(grants).length > 0 || isSpaceRoot(folder)
        out = setRule(out, folder, { ...v, grants: keep ? grants : null })
      }
      return out
    }, { actor: access.actor })
    this.opts.state.prepare("delete from pins where user_id = ? and (path = ? or path like ? escape '\\')").run(user.id, p, likePrefix(p))
    return { path: p }
  }

  /** Pins (or unpins) in the sidebar a folder others share with the person («Shared with me», D-056.6). */
  pin(access: Access, path: unknown, pinned: unknown): { path: string; pinned: boolean } {
    const user = this.person(access)
    if (typeof pinned !== 'boolean') throw new SpaceError(400, 'invalid', 'pinned must be true or false')
    const p = this.folderArg(path)
    if (access.level(p) === null) throw notFound()
    if (pinned) {
      const shared = this.engine.sharedWith(user).some((s) => s.path === p)
      if (!shared) throw new SpaceError(400, 'invalid', 'only a folder shared with you can be pinned')
      this.opts.state.prepare('insert or ignore into pins (user_id, path, created_at) values (?, ?, ?)').run(user.id, p, this.now())
    } else {
      this.opts.state.prepare('delete from pins where user_id = ? and path = ?').run(user.id, p)
    }
    return { path: p, pinned }
  }

  // --- The admin ---------------------------------------------------------------------

  /** Every shared space (its name, managers and how many members: nothing inside it), and the closed spaces of deleted people. */
  directory(access: Access): { spaces: SharedSpaceInfo[]; closed: ClosedSpace[] } {
    this.admin(access)
    const deleted = this.opts.state.prepare('select id, username from users where deleted_at is not null order by username').all() as { id: string; username: string }[]
    const closed = deleted.filter((u) => this.isFolder(personalRoot(u.username))).map((u) => ({ userId: u.id, username: u.username, path: personalRoot(u.username) }))
    return { spaces: this.engine.sharedSpaces(), closed }
  }

  /**
   * The admin makes someone a manager of a shared space that has none (spec
   * §2.4, D-056.8): told to them and to every other admin. Only while it
   * has no manager (`space_has_managers`).
   */
  async assignManager(access: Access, path: unknown, userId: unknown): Promise<SharedSpaceInfo> {
    const { admin, root, target } = this.checkAssignManager(access, path, userId)
    await this.grant(root, target.username, 'manage', access.actor)
    this.opts.notices.spaceChanged([target.id], admin.id, { change: 'manager_assigned', user: target.id, to: null, space: root })
    return this.info(root)
  }

  /** Throws unless the admin may make `userId` a manager of the space at `path` now (the checks of `assignManager`). */
  checkAssignManager(access: Access, path: unknown, userId: unknown) {
    const admin = this.admin(access)
    const root = this.existingShared(path)
    const target = typeof userId === 'string' ? this.opts.users.get(userId) : null
    if (!target) throw new NoteError('not_found', 'no such user')
    if (this.engine.spaceAudience(root).some((u) => u.level === 'manage')) throw new SpaceError(409, 'space_has_managers', 'this space has managers: they add people')
    return { admin, root, target }
  }

  /**
   * The admin adds themselves to a shared space (spec §2.4): a member row
   * like any other, at `level` (`read` by default), which its managers are
   * told of.
   */
  async join(access: Access, path: unknown, level: unknown): Promise<SharedSpaceInfo> {
    const { admin, root, level: l } = this.checkJoin(access, path, level)
    const managers = this.engine.spaceAudience(root).filter((u) => u.level === 'manage' && u.id !== admin.id).map((u) => u.id)
    await this.grant(root, admin.username, l, access.actor)
    this.opts.notices.spaceChanged(managers, admin.id, { change: 'admin_joined', user: admin.id, to: null, space: root }, { admins: false })
    return this.info(root)
  }

  /** Throws unless the admin may join the space at `path` at `level` (the checks of `join`). */
  checkJoin(access: Access, path: unknown, level: unknown): { admin: Access['user']; root: string; level: Level } {
    const admin = this.admin(access)
    const root = this.existingShared(path)
    const l = level === undefined || level === null ? 'read' : level
    if (typeof l !== 'string' || !(LEVELS as readonly string[]).includes(l)) throw new SpaceError(400, 'invalid', `level must be one of ${LEVELS.join(', ')}`)
    return { admin, root, level: l as Level }
  }

  /** What a person's space holds shared (the confirmation of deleting them): counts, nothing named. */
  summary(access: Access, userId: string): PersonalSummary {
    this.admin(access)
    const u = this.opts.users.get(userId)
    if (!u) throw new NoteError('not_found', 'no such user')
    const root = personalRoot(u.username)
    const { folders, people } = this.sharedCounts(root, u.username)
    return { path: root, exists: this.isFolder(root), sharedFolders: folders, people }
  }

  /**
   * What becomes of a deleted person's closed space (spec §2.6), the
   * admin's explicit choice:
   * - `transfer` to someone (`to`, a user id): it goes into theirs, as
   *   `people/<to>/<deleted>`, with its grants (what was shared stays so);
   * - `convert` into a shared space named `name` with `members`: the whole
   *   space becomes theirs, what was shared as subfolders with their grants;
   * - `delete`: its files go from the disk (no trash: nobody could see it)
   *   and its rules from vihko.yaml; the history keeps what it had.
   * Links into it are rewritten as a folder move rewrites them, and keys,
   * pins and the trash follow (folderRefs.ts). `dryRun`: what it would do.
   */
  async personal(access: Access, userId: string, input: { action?: unknown; to?: unknown; name?: unknown; members?: unknown; dryRun?: unknown }): Promise<PersonalSpacePlan> {
    const admin = this.admin(access)
    const gone = this.opts.state.prepare('select id, username from users where id = ? and deleted_at is not null').get(userId) as { id: string; username: string } | undefined
    const from = gone ? personalRoot(gone.username) : null
    if (!gone || !from || !this.isFolder(from)) throw new NoteError('not_found', 'no closed space for that user')
    const action = input.action
    if (action !== 'transfer' && action !== 'convert' && action !== 'delete') throw new SpaceError(400, 'invalid', 'action must be transfer, convert or delete')
    const dryRun = input.dryRun === true
    let to: string | null = null
    let recipient: { id: string; username: string } | null = null
    let name = ''
    let members: Record<string, Level> = {}
    if (action === 'transfer') {
      recipient = typeof input.to === 'string' ? this.opts.users.get(input.to) : null
      if (!recipient) throw new NoteError('not_found', 'no such user')
      to = `${personalRoot(recipient.username)}/${gone.username}`
      if (this.exists(to)) throw new NoteError('exists', `already exists: ${to}`)
    } else if (action === 'convert') {
      name = this.spaceName(input.name)
      members = this.members(input.members ?? {})
      // Someone has to manage it (D-056.22): its members, and later who else joins, are theirs to decide.
      if (!Object.values(members).includes('manage')) throw new SpaceError(400, 'space_needs_manager', 'a shared space needs at least one member who manages it')
    }
    const counts = this.contentCounts(from)
    const shared = this.sharedCounts(from, gone.username)
    const plan = (dest: string | null): PersonalSpacePlan => ({ action, from, to: dest, ...counts, sharedFolders: shared.folders, people: shared.people })
    // A new space's id is drawn when it's made: a dry run doesn't say it.
    if (dryRun) return plan(to)

    if (action === 'delete') {
      // Its rules first: if vihko.yaml can't be written, nothing is deleted.
      await this.opts.file.update((t) => {
        let out = t
        for (const folder of rulesInFile(t).keys()) if (folder === from || folder.startsWith(from + '/')) out = setRule(out, folder, { grants: null, ai: null })
        return out
      }, { actor: access.actor })
      this.deleteTree(from)
      // Its older trash entries too: nobody could ever see or restore them (D-056.22).
      this.opts.refs.dropTrash(from)
      this.opts.state.prepare("delete from pins where path = ? or path like ? escape '\\'").run(from, likePrefix(from))
      this.opts.notices.spaceChanged([], admin.id, { change: 'personal_deleted', user: gone.id, to: null, space: null })
      return plan(null)
    }

    const dest = action === 'transfer' ? to! : this.newSharedFolder(name, { claim: false })
    // Its rules first at the new path too, then the folder, then the old rules go (as a folder move does, scoped.ts).
    await this.opts.file.update((t) => {
      let out = t
      const rules = rulesInFile(t)
      for (const [folder, v] of rules) {
        if (folder !== from && !folder.startsWith(from + '/')) continue
        const at = dest + folder.slice(from.length)
        // A personal root never takes grants (spec §1.2): none are carried over from one written by hand.
        const value: RuleValue = folder === from ? { grants: null, ai: v.ai } : { ...v, name: null }
        if (folder === from && action === 'convert') continue
        out = setRule(out, at, value)
      }
      if (action === 'convert') out = setRule(out, dest, { name, grants: members, ai: rules.get(from)?.ai ?? null })
      return out
    }, { actor: access.actor })
    try {
      await this.opts.notes.moveFolder(from, dest, { actor: access.actor })
    } catch (err) {
      // It didn't move: the new rules go.
      await this.opts.file.update((t) => {
        let out = t
        for (const folder of rulesInFile(t).keys()) if (folder === dest || folder.startsWith(dest + '/')) out = setRule(out, folder, { grants: null, ai: null })
        return out
      }, { actor: access.actor }).catch(() => {})
      throw err
    }
    await this.opts.file.update((t) => {
      let out = t
      for (const folder of rulesInFile(t).keys()) if (folder === from || folder.startsWith(from + '/')) out = setRule(out, folder, { grants: null, ai: null })
      return out
    }, { actor: access.actor }).catch((err) => this.opts.log?.(`the old rules of ${from} stay in vihko.yaml after it moved to ${dest}: ${err instanceof Error ? err.message : String(err)}`))
    this.opts.refs.moved(from, dest)
    if (action === 'transfer') {
      this.opts.notices.spaceChanged([recipient!.id], admin.id, { change: 'personal_transferred', user: gone.id, to: recipient!.id, space: dest })
    } else {
      const told = this.engine.spaceAudience(dest).map((u) => u.id)
      this.opts.notices.spaceChanged(told, admin.id, { change: 'personal_converted', user: gone.id, to: null, space: dest })
    }
    return plan(dest)
  }

  // --- Telling people they were added ------------------------------------------------

  /**
   * After a folder's rule changed (`before`: vihko.yaml's text then): whoever
   * sees the folder now and didn't before is told (D-056.22), that `actor`
   * added them to the shared space (its root) or shared the folder with them.
   * Never the one who did it, and only for a person's change. What they're told is only what they can see (notices.ts).
   */
  notifyShared(folder: string, before: string, actor: Actor): void {
    if (actor.kind !== 'user') return
    const f = folder.normalize('NFC')
    const s = parseSpacePath(f)
    if (!s || !this.isFolder(f)) return
    const then = new SpaceRules([...rulesInFile(before)].map(([k, v]): PermissionRule => ({ folder: k, grants: v.grants, ai: v.ai, ...(v.name ? { name: v.name } : {}) })))
    const now = this.engine.spaceRules()
    const dir = this.engine.directory
    const users = dir.users()
    const names = new Set(users.map((u) => u.username.normalize('NFC')))
    const exists = (n: string) => names.has(n.normalize('NFC'))
    const kind = s.space.kind === 'shared' && s.inner === '' ? 'space' : 'folder'
    for (const u of users) {
      if (u.id === actor.id) continue
      const who = { username: u.username, groups: dir.groupsOf(u.id) }
      if (then.level(f, who, exists) !== null || now.level(f, who, exists) === null) continue
      this.opts.notices.add(u.id, { code: 'shared_with_you', kind, by: actor.id, path: f })
    }
  }

  // --- Helpers -------------------------------------------------------------------------

  /** The person asking (never an agent: spaces are managed by people, spec §2.5). */
  private person(access: Access) {
    if (access.isAgent) throw new AccessError('agents don\'t manage spaces')
    return access.user
  }

  private admin(access: Access) {
    const u = this.person(access)
    if (u.role !== 'admin') throw new AccessError('admins only')
    return u
  }

  /** A folder path as given: valid (NoteService.checkFolder), in NFC. */
  private folderArg(path: unknown): string {
    if (typeof path !== 'string') throw new SpaceError(400, 'invalid', 'path must be a folder path')
    return NoteService.checkFolder(path.normalize('NFC'))
  }

  /**
   * A shared space's root the person names, with at least `need` there:
   * `not_found` where they have no level (whether it exists or not),
   * `forbidden` where they see it but lack `need`, `invalid` for a folder
   * they see that isn't a shared space's root.
   */
  private sharedRootFor(access: Access, path: unknown, need: 'manage'): string {
    const p = this.folderArg(path)
    const level = access.level(p)
    if (level === null || !this.isFolder(p)) throw notFound()
    const s = parseSpacePath(p)
    if (!s || s.space.kind !== 'shared' || s.inner !== '') throw new SpaceError(400, 'invalid', 'not a shared space')
    if (need === 'manage' && !access.canManage(p)) throw new AccessError('only its managers can do this')
    return p
  }

  /** A shared space's root that exists, for the admin (who may name any: their names are the admin's directory). */
  private existingShared(path: unknown): string {
    const p = this.folderArg(path)
    const s = parseSpacePath(p)
    if (!s || s.space.kind !== 'shared' || s.inner !== '' || !this.isFolder(p)) throw new NoteError('not_found', 'no such shared space')
    return p
  }

  /** A shared space's name, checked (core spaceNameProblem) and in NFC. */
  private spaceName(name: unknown): string {
    if (typeof name !== 'string') throw new SpaceError(400, 'invalid', 'name must be text')
    const n = name.normalize('NFC')
    const problem = spaceNameProblem(n)
    if (problem) throw new SpaceError(400, 'invalid', `invalid space name: ${problem}`, { problem })
    return n
  }

  /** Members as given (`{ "<user>" | "@<group>": level }`): each one a user or group that exists, with a level. */
  private members(raw: unknown): Record<string, Level> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SpaceError(400, 'invalid', 'members must map users and groups to levels')
    const dir = this.opts.users.directory()
    const users = new Map(dir.users.map((u) => [subjectKey(u), u]))
    const groups = new Map(dir.groups.map((g) => [subjectKey('@' + g), '@' + g]))
    const out: Record<string, Level> = {}
    for (const [subject, level] of Object.entries(raw as Record<string, unknown>)) {
      const name = users.get(subjectKey(subject)) ?? groups.get(subjectKey(subject))
      if (!name) throw new SpaceError(400, 'invalid', `no user or group ${subject}`)
      if (typeof level !== 'string' || !(LEVELS as readonly string[]).includes(level)) throw new SpaceError(400, 'invalid', `level must be one of ${LEVELS.join(', ')}`)
      out[name] = maxLevel(out[name] ?? null, level as Level)!
    }
    return out
  }

  /**
   * A new shared space's root, `spaces/<readable>-<id>`, with an id no space
   * has (on the disk, or named by a rule, in any case). With `claim` (the
   * default) its folder is made at once, never over one that exists.
   */
  private newSharedFolder(name: string, opts: { claim?: boolean } = {}): string {
    const dir = join(this.opts.notesDir, SPACES)
    mkdirSync(dir, { recursive: true })
    for (let attempt = 0; attempt < 5; attempt++) {
      const taken = new Set<string>()
      try {
        for (const e of readdirSync(dir)) taken.add(e.slice(e.lastIndexOf('-') + 1).toLowerCase())
      } catch { /* none yet */ }
      for (const r of this.engine.spaceRules().rules) {
        const s = parseSpacePath(r.folder)
        if (s?.space.kind === 'shared') taken.add(s.space.id)
      }
      const folder = newSpaceFolder(name, (id) => taken.has(id))
      const root = sharedRoot(folder)
      if (opts.claim === false) return root
      try {
        mkdirSync(join(this.opts.notesDir, root))
        return root
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
    }
    throw new Error('no free shared space folder after 5 tries')
  }

  /** Adds (or raises) one person's grant at a shared space's root, keeping its name, members and `ai`. */
  private async grant(root: string, username: string, level: Level, actor: Actor) {
    await this.opts.file.update((t) => {
      const current = rulesInFile(t).get(root) ?? { grants: null, ai: null }
      const grants: Record<string, Level> = {}
      let had: Level | null = null
      for (const [k, l] of Object.entries(current.grants ?? {})) {
        if (subjectKey(k) === subjectKey(username)) had = maxLevel(had, l)
        else grants[k] = l
      }
      grants[username] = maxLevel(had, level)!
      return setRule(t, root, { ...current, grants })
    }, { actor })
  }

  /** A shared space as the person sees it now. */
  private entry(access: Access, root: string): SpaceEntry {
    const found = this.engine.spacesFor(access.user).spaces.find((s) => s.path === root)
    if (found) return found
    // Just written, and the disk (NFS) or the rules not caught up yet: as it was asked for.
    const s = parseSpacePath(root)!
    return { path: root, id: s.space.kind === 'shared' ? s.space.id : '', name: this.engine.spaceName(root) ?? '', level: access.level(root) ?? 'manage', managers: [], aiClosed: false }
  }

  /** A shared space as the admin's directory has it. */
  private info(root: string): SharedSpaceInfo {
    return this.engine.sharedSpaces().find((s) => s.path === root) ?? { path: root, id: parseSpaceFolder(root.slice(SPACES.length + 1))?.id ?? '', name: this.engine.spaceName(root) ?? '', managers: [], members: 0, aiClosed: false }
  }

  /** Whether a folder exists as the disk spells it (never through a symbolic link). */
  private isFolder(folder: string): boolean {
    try {
      return lstatSync(join(this.opts.notesDir, folder)).isDirectory() && followable(this.opts.notesDir, folder)
    } catch {
      return false
    }
  }

  private exists(path: string): boolean {
    try {
      lstatSync(join(this.opts.notesDir, path))
      return true
    } catch {
      return false
    }
  }

  /** How many notes and other files a folder holds (the index's notes; the disk's files). */
  private contentCounts(folder: string): { notes: number; files: number } {
    let notes = 0
    let files = 0
    for (const rel of this.walk(folder)) {
      if (/\.md$/i.test(rel)) notes++
      else files++
    }
    return { notes, files }
  }

  /** Every file under a folder (relative to the notes root), never through a symbolic link. */
  private walk(folder: string): string[] {
    const out: string[] = []
    const visit = (rel: string) => {
      let entries: import('node:fs').Dirent[]
      try { entries = readdirSync(join(this.opts.notesDir, rel), { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const p = `${rel}/${e.name}`
        if (e.isDirectory()) visit(p)
        else if (e.isFile()) out.push(p)
      }
    }
    visit(folder)
    return out
  }

  /**
   * The folders of a personal space shared with others (rules with grants
   * under its root) and how many people they reach, by name or through a
   * group, its owner aside. From the rules alone: its owner may be gone.
   */
  private sharedCounts(root: string, owner: string): { folders: number; people: number } {
    const users = this.opts.users.list()
    const groupsOf = new Map(users.map((u) => [u.id, new Set(u.groups.map((g) => subjectKey('@' + g)))]))
    const reached = new Set<string>()
    let folders = 0
    for (const r of this.engine.spaceRules().rules) {
      const f = r.folder.normalize('NFC')
      if (!f.startsWith(root + '/') || !r.grants || Object.keys(r.grants).length === 0) continue
      folders++
      const subjects = new Set(Object.keys(r.grants).map(subjectKey))
      for (const u of users) {
        if (subjectKey(u.username) === subjectKey(owner)) continue
        if (subjects.has(subjectKey(u.username)) || [...groupsOf.get(u.id)!].some((g) => subjects.has(g))) reached.add(u.id)
      }
    }
    return { folders, people: reached.size }
  }

  /** Removes a folder with everything in it from the disk and the index (no trash). */
  private deleteTree(folder: string) {
    const files = this.walk(folder)
    rmSync(join(this.opts.notesDir, folder), { recursive: true, force: true })
    this.opts.indexer.indexPaths(files)
    this.opts.indexer.indexFolders([folder])
  }
}

function notFound(): NoteError {
  return new NoteError('not_found', 'no such folder')
}

/** A LIKE pattern for everything under a folder. */
function likePrefix(folder: string): string {
  return folder.replace(/[\\%_]/g, (c) => '\\' + c) + '/%'
}
