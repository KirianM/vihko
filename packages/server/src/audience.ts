// Who gains or loses access when something moves (D-038, «mover con aviso»):
// the preview of a note or folder move says it, and the UI asks before
// moving. Users and groups are named (everyone may see their names, D-038);
// keys are only counted (they're their owners' own).
//
// A folder moved from thoth takes its rules along (permissionsFile.ts): its
// own rules and those under it move with it, and a `{user}` rule that would
// stop matching it is written as a literal copy at the new path
// (`ruleMove`). Only what inherits from above the folder changes hands.
import {
  RuleSet, folderOf, grantsAt, levelIn, subjectKey,
  type Level, type PermissionRule, type RuleValue,
} from '@thoth/core'
import { inFolders } from './access.ts'
import type { KeyWithUser } from './keys.ts'
import type { DirectoryUser, PermissionsEngine } from './permissions.ts'

export interface AudienceChange {
  users: { gain: { id: string; username: string }[]; lose: { id: string; username: string }[] }
  /** Groups whose grant reaches it before and not after (`lose`), or after and not before (`gain`). */
  groups: { gain: string[]; lose: string[] }
  /** How many keys (of anyone) gain or lose it. */
  keys: { gain: number; lose: number }
}

/** What moves with a folder: the rules to write at the new path besides its own literal ones (see the header). */
export function ruleMove(engine: PermissionsEngine, from: string, to: string, folders: readonly string[]): { extra: (RuleValue & { folder: string })[]; rules: PermissionRule[] | null } {
  const set = engine.rules()
  const users = engine.directory.users()
  if (!set) return { extra: [], rules: null }
  const names = new Set(users.map((u) => subjectKey(u.username)))
  const f = from.normalize('NFC')
  const t = to.normalize('NFC')
  const under = (k: string) => k === f || k.startsWith(f + '/')
  const extra: (RuleValue & { folder: string })[] = []
  for (const folder of new Set([f, ...folders.map((x) => x.normalize('NFC')).filter(under)])) {
    const own = set.own(folder)
    if (!own) continue
    // A literal rule without grants over a `{user}` one takes that one's grants along (RuleSet.governing).
    const u = own.user === null && own.rule.grants === null ? set.userRule(folder) : null
    const m = own.user !== null ? own : u !== null && u.rule.grants !== null ? u : null
    if (!m) continue
    const grants = m.rule.grants === null ? null : grantsAt({ ...m, at: folder }, (n) => names.has(subjectKey(n)))
    extra.push({ folder: t + folder.slice(f.length), grants, ai: own.user === null ? own.rule.ai : m.rule.ai })
  }
  // The rules as they'll be once it moved (the implicit section has no rule under any folder: it doesn't change).
  const section = engine.section
  if (section.kind !== 'rules') return { extra, rules: null }
  const rules = section.rules.flatMap((r): PermissionRule[] => {
    const literal = !r.folder.split('/').includes('{user}')
    return literal && under(r.folder) ? [{ ...r, folder: t + r.folder.slice(f.length) }] : [r]
  })
  for (const e of extra) {
    const i = rules.findIndex((r) => r.folder === e.folder)
    const rule = { folder: e.folder, grants: e.grants, ai: e.ai }
    if (i === -1) rules.push(rule)
    else rules[i] = rule
  }
  return { extra, rules }
}

/**
 * The change of audience of moving what is at the folders `pairs` (before →
 * after, each a folder and a sample path in it for the keys' folders), with
 * `after` rules (null: the same as now).
 */
export function audienceChange(engine: PermissionsEngine, keys: readonly KeyWithUser[], pairs: readonly { before: string; after: string }[], afterRules: PermissionRule[] | null = null): AudienceChange {
  const users = engine.directory.users()
  const nowSet = engine.rules(users)
  const thenSet = afterRules ? new RuleSet(afterRules) : nowSet
  const names = new Set(users.map((u) => subjectKey(u.username)))
  const exists = (n: string) => names.has(subjectKey(n))
  const groupsOf = new Map(users.map((u) => [u.id, engine.directory.groupsOf(u.id)]))
  const levelIn_ = (set: RuleSet | null, folder: string, u: DirectoryUser): Level | null => {
    const g = set?.governing(folder)
    return g ? levelIn(grantsAt(g, exists), { username: u.username, groups: groupsOf.get(u.id) ?? [] }) : null
  }
  const grantedGroups = (set: RuleSet | null, folder: string): Set<string> => {
    const g = set?.governing(folder)
    return new Set(g ? Object.keys(grantsAt(g, exists)).filter((s) => s.startsWith('@')).map((s) => s.slice(1)) : [])
  }
  const gainU = new Map<string, DirectoryUser>()
  const loseU = new Map<string, DirectoryUser>()
  const gainG = new Set<string>()
  const loseG = new Set<string>()
  const gainK = new Set<string>()
  const loseK = new Set<string>()
  for (const { before, after } of pairs) {
    const fb = folderOf(before)
    const fa = folderOf(after)
    const readers = new Map<string, [boolean, boolean]>()
    for (const u of users) {
      const b = levelIn_(nowSet, fb, u) !== null
      const a = levelIn_(thenSet, fa, u) !== null
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
      const b = ub && inFolders(before, k.folders) && nowSet?.aiClosedAt(fb) == null
      const a = ua && inFolders(after, k.folders) && thenSet?.aiClosedAt(fa) == null
      if (b && !a) loseK.add(k.id)
      if (!b && a) gainK.add(k.id)
    }
  }
  const brief = (m: Map<string, DirectoryUser>) => [...m.values()].map((u) => ({ id: u.id, username: u.username })).sort((a, b) => a.username.localeCompare(b.username))
  return {
    users: { gain: brief(gainU), lose: brief(loseU) },
    groups: { gain: [...gainG].sort(), lose: [...loseG].sort() },
    keys: { gain: gainK.size, lose: loseK.size },
  }
}
