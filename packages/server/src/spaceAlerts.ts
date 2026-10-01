// The admin's alerts about the spaces (D-056, spec §1.1, §2.4, §5.7): what
// in the notes folder is in no space, folders in `people/` named like no
// user, shared spaces without members or without managers, and those of
// 0.1.0-rc.1 or rc.2 not renamed to their names yet. None of them names
// anything inside a space.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PEOPLE, SPACES, WORKSPACE_FILE, isSpaceFolderName, isValidUsername, personalRoot, sharedRoot, spaceRootOf, type Alert, type ConfigError } from '@vihko/core'
import type { Db } from './db.ts'
import type { PermissionsEngine } from './permissions.ts'

export interface SpaceAlertsDeps {
  notesDir: string
  engine: PermissionsEngine
  /** state.db: the names of deleted users (their folders are their closed spaces, not strays). */
  state: Db
  /** The admin who asks: what is outside the spaces can go into their own space (`outside_spaces`). */
  username: string
}

/** The entries of a folder, but hidden ones; empty if it can't be read. */
function entries(dir: string): { name: string; dir: boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).map((e) => ({ name: e.name.normalize('NFC'), dir: e.isDirectory() }))
  } catch {
    return []
  }
}

/** `outside_spaces`, `person_folder_without_user`, `closed_spaces`, `space_without_members` and `space_without_managers`, for the admin. */
export function spaceAlerts(deps: SpaceAlertsDeps): Alert[] {
  const out: Alert[] = []
  const outside: string[] = []
  for (const e of entries(deps.notesDir)) {
    if (e.name === WORKSPACE_FILE && !e.dir) continue
    if ((e.name === PEOPLE || e.name === SPACES) && e.dir) continue
    outside.push(e.name)
  }
  for (const e of entries(join(deps.notesDir, SPACES))) {
    if (!e.dir || !isSpaceFolderName(e.name)) outside.push(`${SPACES}/${e.name}`)
  }
  const users = new Set(deps.engine.directory.users().map((u) => u.username.normalize('NFC')))
  const deleted = new Set((deps.state.prepare('select username from users where deleted_at is not null').all() as { username: string }[]).map((r) => r.username.normalize('NFC')))
  const strays: string[] = []
  const closed: string[] = []
  for (const e of entries(join(deps.notesDir, PEOPLE))) {
    if (!e.dir) { outside.push(`${PEOPLE}/${e.name}`); continue }
    // A deleted user's folder is their closed space (D-056.8): not a stray, but undecided while it is there (D-056.28).
    if (isValidUsername(e.name) && !users.has(e.name) && deleted.has(e.name)) closed.push(e.name)
    else if (!isValidUsername(e.name) || !users.has(e.name)) strays.push(e.name)
  }
  if (outside.length) out.push({ code: 'outside_spaces', paths: outside.sort(), into: personalRoot(deps.username), actions: [] })
  if (strays.length) out.push({ code: 'person_folder_without_user', names: strays.sort(), actions: [] })
  if (closed.length) out.push({ code: 'closed_spaces', people: closed.sort(), actions: [] })
  const rules = deps.engine.spaceRules()
  for (const s of deps.engine.sharedSpaces()) {
    if (s.members === 0) out.push({ code: 'space_without_members', path: s.path, name: s.name, actions: [] })
    else if (s.managers.length === 0) out.push({ code: 'space_without_managers', path: s.path, name: s.name, actions: [] })
    // A space of 0.1.0-rc.1 or rc.2 the start couldn't rename to its name (legacySpaces.ts): it tries again at each start.
    const wanted = rules.legacyName(s.path)
    if (wanted !== null && sharedRoot(wanted) !== s.path) out.push({ code: 'space_not_renamed', path: s.path, name: s.name, wanted, actions: [] })
  }
  return out
}

/**
 * A warning about vihko.yaml as the admin may be told it: one about a
 * `permissions` key whose space the admin doesn't read names neither the key
 * nor its detail (a user or group name stays: those aren't secret, D-038).
 */
export function redactPermissionsWarning(w: ConfigError, access: { level(folder: string): unknown }): ConfigError {
  if (!w.at?.startsWith('permissions.')) return w
  const root = spaceRootOf(w.at.slice('permissions.'.length))
  if (root !== null && access.level(root) !== null) return w
  return { ...w, at: 'permissions', detail: w.code === 'unknown_subject' ? w.detail : null }
}
