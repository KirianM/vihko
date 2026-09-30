// Who gains or loses access when something moves (D-038 «mover con aviso»,
// spec §3.3): the preview of a note or folder move says it, and the UI asks
// before moving. Users and groups are named (everyone may see their names,
// D-038); keys are only counted (they're their owners' own). Moving to
// another space also changes whose it is (`owner`): out of one's own space
// it stops being theirs; into a folder someone shares, it goes into their
// space.
//
// A folder moved from vihko takes its rules along (permissionsFile.ts): its
// own rules and those under it move with it, and rules forgotten at the
// destination go (core `moveRules`). Only what reaches it from above changes.
import { SpaceRules, folderOf, parseSpacePath, rulesOf, type PermissionRule } from '@vihko/core'
import { inFolders } from './access.ts'
import type { KeyWithUser } from './keys.ts'
import type { DirectoryUser, PermissionsEngine } from './permissions.ts'

/** Whose a path is: a person's space (`owner`), a shared space (its root and name), or nobody's (outside the spaces). */
export type SpaceOwner =
  | { kind: 'personal'; owner: string }
  | { kind: 'shared'; path: string; name: string }
  | null

export interface AudienceChange {
  users: { gain: { id: string; username: string }[]; lose: { id: string; username: string }[] }
  /** Groups whose grant reaches it before and not after (`lose`), or after and not before (`gain`). */
  groups: { gain: string[]; lose: string[] }
  /** How many keys (of anyone) gain or lose it. */
  keys: { gain: number; lose: number }
  /** Whose it is before and after, when the move changes its space; null when it stays in its space. */
  owner: { before: SpaceOwner; after: SpaceOwner } | null
}

/**
 * The rules as they'll be once the folder `from` moved to `to`, as
 * vihko.yaml will have them (core `moveRules`): every key under the folder
 * moves, and keys already at the destination go.
 */
export function ruleMove(engine: PermissionsEngine, from: string, to: string): { rules: PermissionRule[] } {
  const f = from.normalize('NFC')
  const t = to.normalize('NFC')
  const under = (k: string, root: string) => k === root || k.startsWith(root + '/')
  const rules = rulesOf(engine.section)
    .filter((r) => under(r.folder, f) || !under(r.folder, t))
    .map((r): PermissionRule => (under(r.folder, f) ? { ...r, folder: t + r.folder.slice(f.length) } : r))
  return { rules }
}

/** Whose `path` is under `rules`. */
function ownerOf(engine: PermissionsEngine, rules: SpaceRules, path: string): SpaceOwner {
  const s = parseSpacePath(path)
  if (!s) return null
  return s.space.kind === 'personal' ? { kind: 'personal', owner: s.space.owner } : { kind: 'shared', path: s.space.root, name: engine.spaceName(s.space.root, rules) ?? s.space.readable }
}

/**
 * The change of audience of moving what is at the paths `pairs` (before →
 * after: a note, or a sample path in a folder), with `afterRules` (null: the
 * same as now).
 */
export function audienceChange(engine: PermissionsEngine, keys: readonly KeyWithUser[], pairs: readonly { before: string; after: string }[], afterRules: PermissionRule[] | null = null): AudienceChange {
  const users = engine.directory.users()
  const nowSet = engine.spaceRules()
  const thenSet = afterRules ? new SpaceRules(afterRules) : nowSet
  const exists = engine.ownerCheck(users)
  const groupsOf = new Map(users.map((u) => [u.id, engine.directory.groupsOf(u.id)]))
  const levelIn = (set: SpaceRules, folder: string, u: DirectoryUser) => set.level(folder, { username: u.username, groups: groupsOf.get(u.id) ?? [] }, exists)
  const grantedGroups = (set: SpaceRules, folder: string): Set<string> =>
    new Set(set.reaching(folder).map((g) => g.subject).filter((s) => s.startsWith('@')).map((s) => s.slice(1)))
  const gainU = new Map<string, DirectoryUser>()
  const loseU = new Map<string, DirectoryUser>()
  const gainG = new Set<string>()
  const loseG = new Set<string>()
  const gainK = new Set<string>()
  const loseK = new Set<string>()
  let owner: AudienceChange['owner'] = null
  for (const { before, after } of pairs) {
    const fb = folderOf(before)
    const fa = folderOf(after)
    const readers = new Map<string, [boolean, boolean]>()
    for (const u of users) {
      const b = levelIn(nowSet, fb, u) !== null
      const a = levelIn(thenSet, fa, u) !== null
      readers.set(u.id, [b, a])
      if (b && !a) loseU.set(u.id, u)
      if (!b && a) gainU.set(u.id, u)
    }
    const gb = grantedGroups(nowSet, fb)
    const ga = grantedGroups(thenSet, fa)
    for (const g of gb) if (!ga.has(g)) loseG.add(g)
    for (const g of ga) if (!gb.has(g)) gainG.add(g)
    for (const k of keys) {
      if (k.status !== 'active') continue
      const [ub, ua] = readers.get(k.userId) ?? [false, false]
      const b = ub && inFolders(before, k.folders) && nowSet.aiClosedAt(fb) === null
      const a = ua && inFolders(after, k.folders) && thenSet.aiClosedAt(fa) === null
      if (b && !a) loseK.add(k.id)
      if (!b && a) gainK.add(k.id)
    }
    const sb = parseSpacePath(before)?.space.root ?? null
    const sa = parseSpacePath(after)?.space.root ?? null
    if (owner === null && sb !== sa) owner = { before: ownerOf(engine, nowSet, before), after: ownerOf(engine, thenSet, after) }
  }
  const brief = (m: Map<string, DirectoryUser>) => [...m.values()].map((u) => ({ id: u.id, username: u.username })).sort((a, b) => a.username.localeCompare(b.username))
  return {
    users: { gain: brief(gainU), lose: brief(loseU) },
    groups: { gain: [...gainG].sort(), lose: [...loseG].sort() },
    keys: { gain: gainK.size, lose: loseK.size },
    owner,
  }
}
