// Grants inside a shared space, by the level each subject has in the whole
// space (at its root): a grant below the root only ever raises a member
// above it (http/permissions.ts refuses one that doesn't), and those that
// stop doing so, or belong to someone taken out of the space, go when its
// root changes (`tidyBelow`). Sharing a subfolder with someone who isn't a
// member is unchanged.
import { SpaceRules, atLeast, maxLevel, rulesInFile, setRule, subjectKey, type Level, type PermissionRule } from '@vihko/core'
import type { PermissionsEngine } from './permissions.ts'

/**
 * A subject's level in a whole shared space (at its root), under `rules`:
 * a user's, by name or through their groups; a group's, its own grant there.
 * Null: not a member (or no such user).
 */
export function memberLevel(engine: PermissionsEngine, rules: SpaceRules, root: string, subject: string): Level | null {
  const k = subjectKey(subject)
  if (subject.startsWith('@')) {
    let level: Level | null = null
    for (const g of rules.reaching(root)) if (subjectKey(g.subject) === k) level = maxLevel(level, g.level)
    return level
  }
  const user = engine.directory.users().find((u) => subjectKey(u.username) === k)
  return user ? engine.levelFor(user, root, rules) : null
}

/**
 * After a shared space's root changed in `text`: below it, the grants of
 * whoever was taken out of it (`removed`, subject keys) go, as leaving
 * takes one's own; and so do grants no longer above their subject's level
 * in the whole space (they add nothing). A folder left without grants
 * keeps its `ai`.
 */
export function tidyBelow(text: string, root: string, removed: ReadonlySet<string>, engine: PermissionsEngine): string {
  const written = rulesInFile(text)
  const rules = new SpaceRules([...written].map(([folder, v]): PermissionRule => ({ folder, grants: v.grants, ai: v.ai })))
  let out = text
  for (const [folder, v] of written) {
    if (!folder.startsWith(root + '/') || !v.grants) continue
    const grants: Record<string, Level> = {}
    for (const [subject, level] of Object.entries(v.grants)) {
      if (removed.has(subjectKey(subject))) continue
      const member = memberLevel(engine, rules, root, subject)
      if (member !== null && atLeast(member, level)) continue
      grants[subject] = level
    }
    if (Object.keys(grants).length === Object.keys(v.grants).length) continue
    out = setRule(out, folder, { ...v, grants: Object.keys(grants).length ? grants : null })
  }
  return out
}
