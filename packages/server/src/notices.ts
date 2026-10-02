// Notices addressed to one person: what someone else did to
// their account, or to something they wrote, that they see when they sign in
// and in «Alerts» until they dismiss it. The workspace's alerts are about the
// notes folder and computed on each request; these are kept in state.db.
//
// - `account_changed`: the vihko admin gave them a reset link, took their
//   second factor away or changed their role. The admin still
//   may, but never unnoticed.
// - `user_account_changed`: the same, for every other admin: who did it to
//   whom, and when. Also a new admin, told as a role change to
//   admin is.
// - `history_purged_authored`: someone purged from the history a note (or a
//   version of it) they wrote in. The path is kept, and shown
//   only while they can still read it (the caller judges, on each request).
// - `links_not_updated`: a move they made (or an agent of theirs) left links
//   in other notes that vihko couldn't update, even when it tried again after
//   the next rescan. No path, name or count: those notes may be
//   ones they can't read.
// - `space_changed`: the admin did something to a space that concerns them
//   (so it's never done behind their back): made them a manager, joined a space they
//   manage, gave them a deleted person's space or made it a shared space they
//   belong to; and, to every other admin, the same (and a deleted person's
//   space deleted). The space's path is kept; its name is looked up when
//   shown, and a personal space's path only while they can read it.
// - `shared_with_you`: someone added them to a shared space or shared a
//   folder with them. The path is kept; it and every name are
//   shown only while they can still see it.
// - `retention_ran`: to every admin, what the retention removed:
//   how many trash entries and history versions, never a path.
// - `settings_migrated`: to whom a settings file belongs (the person, a
//   space's managers, the admins for vihko.yaml), what vihko did at start
//   with a key it retired there (retiredKeys.ts): how many notes it marked,
//   and the folders the key named that no longer exist.
//
// Only ids are kept (who did it, to whom): names are looked up when shown,
// so a rename shows the new one and a deleted user their tombstone's. Never
// anything of a note's content. Each person keeps their latest notices only.
import { randomUUID } from 'node:crypto'
import { WORKSPACE_FILE, atLeast, folderOf, parseSpacePath, type AccountChange, type Alert, type SpaceChange } from '@vihko/core'
import type { Access } from './access.ts'
import type { Db } from './db.ts'
import type { Role } from './auth.ts'
import type { Actor } from './actor.ts'

export type { AccountChange, SpaceChange }

/**
 * Whether someone can read a path of the history now, as a note (or file)
 * and as a folder alike: both its folder's permission and its own. A folder
 * whose parent they can't read counts as unreadable too (never more than
 * they see); vihko.yaml, for nobody.
 */
export function readablePath(access: Access, path: string): boolean {
  return path !== WORKSPACE_FILE && access.canRead(path) && atLeast(access.level(path), 'read')
}

/**
 * A notice as the alert its person sees: names as they are now, a purge's
 * path only while they can read it, a space's name as it is now (`spaceName`)
 * and a personal space's path only while they can see it (a shared space's
 * name and path are no secret).
 */
export function noticeAlert(n: Notice, access: Access, nameOf: (id: string) => string, spaceName: (root: string) => string | null = () => null, mayRestore: (deleted: string) => boolean = () => false): Alert {
  const d = n.data
  if (d.code === 'links_not_updated') return { code: d.code, id: n.id, at: n.at, actions: ['dismiss'] }
  if (d.code === 'retention_ran') return { code: d.code, id: n.id, at: n.at, trashEntries: d.trashEntries, versions: d.versions, failed: d.failed, actions: ['dismiss'] }
  if (d.code === 'settings_migrated') {
    // The file only while they can still see where it is (vihko.yaml: the admins it went to).
    const shown = d.file === WORKSPACE_FILE || access.level(d.file.slice(0, d.file.indexOf('/.vihko/'))) !== null ? d.file : null
    return { code: d.code, id: n.id, at: n.at, key: d.key, file: shown, marked: d.marked, missing: shown === null ? [] : d.missing, actions: ['dismiss'] }
  }
  if (d.code === 'account_key_added') return { code: d.code, id: n.id, at: n.at, kind: d.kind, name: d.name, actions: ['dismiss'] }
  const base = { id: n.id, at: n.at, by: nameOf(d.by), actions: ['dismiss' as const] }
  switch (d.code) {
    case 'account_changed': return { code: d.code, ...base, change: d.change, role: d.role }
    case 'user_account_changed': return { code: d.code, ...base, change: d.change, role: d.role, user: nameOf(d.user) }
    case 'history_purged_authored': return { code: d.code, ...base, path: readablePath(access, d.path) ? d.path : null, version: d.version }
    case 'space_changed': {
      const s = d.space === null ? null : parseSpacePath(d.space)
      const shown = s === null ? null
        : s.space.kind === 'shared' && s.inner === '' ? { path: d.space!, name: spaceName(s.space.root) }
        : access.level(d.space!) !== null ? { path: d.space!, name: null }
        : null
      return { code: d.code, ...base, change: d.change, user: d.user === null ? null : nameOf(d.user), to: d.to === null ? null : nameOf(d.to), space: shown }
    }
    case 'moved_out': {
      // Where it went, only while they read it; a shared space's name (no secret) or a person's.
      const s = parseSpacePath(d.to)
      const reads = access.level(d.kind === 'folder' ? d.to : folderOf(d.to)) !== null
      return {
        code: d.code, ...base, kind: d.kind, from: d.from, to: reads ? d.to : null,
        space: s?.space.kind === 'shared' ? { path: s.space.root, name: spaceName(s.space.root) } : null,
        owner: s?.space.kind === 'personal' ? s.space.owner : null,
      }
    }
    // What they no longer see, as they last saw it: kept with the notice, never looked up again.
    case 'removed_from': return { code: d.code, ...base, kind: d.kind, name: d.name, owner: d.owner, space: d.space }
    case 'space_deleted': {
      // Restoring it whole, from here, for whoever may (its managers then), while it can be.
      const restorable = mayRestore(d.deleted)
      return { code: d.code, ...base, name: d.name, deleted: restorable ? d.deleted : null, actions: restorable ? ['restore_space', 'dismiss'] : ['dismiss'] }
    }
    case 'space_restored': {
      const shown = access.level(d.path) !== null
      return { code: d.code, ...base, path: shown ? d.path : null, name: parseSpacePath(d.path)?.space.kind === 'shared' ? spaceName(d.path) : null }
    }
    case 'space_renamed': {
      const shown = access.level(d.path) !== null
      return { code: d.code, ...base, from: d.from, path: shown ? d.path : null, name: spaceName(d.path) }
    }
    case 'shared_with_you': {
      const s = parseSpacePath(d.path)
      const none = { code: d.code, ...base, kind: d.kind, path: null, name: null, owner: null, space: null }
      if (!s || access.level(d.path) === null) return none
      if (d.kind === 'space') return { ...none, path: d.path, name: spaceName(s.space.root) }
      const name = d.path.slice(d.path.lastIndexOf('/') + 1)
      return s.space.kind === 'personal'
        ? { ...none, path: d.path, name, owner: s.space.owner }
        : { ...none, path: d.path, name, space: spaceName(s.space.root) }
    }
  }
}

export type NoticeData =
  /** To the person: `by` (a user id) did `change` to their account; `role`: the new one. */
  | { code: 'account_changed'; change: AccountChange; by: string; role: Role | null }
  /** To every other admin: `by` did `change` to `user`'s account. */
  | { code: 'user_account_changed'; change: AccountChange; by: string; user: string; role: Role | null }
  /** To whoever wrote in it: `by` purged `path` (with `version`, one version of it) from the history. */
  | { code: 'history_purged_authored'; by: string; path: string; version: boolean }
  /** To whoever made a move: some links it left couldn't be updated, even retried. Nothing else. */
  | { code: 'links_not_updated' }
  /** `by` did `change` to a space (`space`: its path, null once deleted), concerning `user` and, for a transfer, `to` (ids). */
  | { code: 'space_changed'; change: SpaceChange; by: string; user: string | null; to: string | null; space: string | null }
  /** `by` added them to the shared space at `path` (`space`), or shared the folder at `path` with them (`folder`). */
  | { code: 'shared_with_you'; kind: 'space' | 'folder'; by: string; path: string }
  /** To every admin: the retention removed that many trash entries and history versions (or failed). Counts only. */
  | { code: 'retention_ran'; trashEntries: number; versions: number; failed: boolean }
  /** To whom `file` belongs: vihko removed the retired `key` from it at start, after doing what it asked (`marked` notes; `missing` folders). */
  | { code: 'settings_migrated'; key: string; file: string; marked: number; missing: string[] }
  /** To a personal space's owner: `by` moved a note or folder of theirs (`from`) out of it, to `to`. */
  | { code: 'moved_out'; kind: 'note' | 'folder'; by: string; from: string; to: string }
  /**
   * `by` took them out of a shared space (`space`), or stopped sharing a
   * folder with them (`folder`): its name, and whose it is (`owner`) or the
   * space it's in (`space`, its name), as they last saw them. No path: what
   * it's called later is no longer theirs to know.
   */
  | { code: 'removed_from'; kind: 'space' | 'folder'; by: string; name: string; owner: string | null; space: string | null }
  /** `by` deleted the shared space `name` they were in (`deleted`: its record, to restore it whole). */
  | { code: 'space_deleted'; by: string; name: string; deleted: string }
  /** `by` restored the shared space at `path` they were in. */
  | { code: 'space_restored'; by: string; path: string }
  /** `by` renamed the shared space they're in from `from` (its name then) to the one at `path`. */
  | { code: 'space_renamed'; by: string; from: string; path: string }
  /** A key (`key`) was made, or an app (`app`) authorized, on their account, named `name`: never unnoticed. */
  | { code: 'account_key_added'; kind: 'key' | 'app'; name: string }

export type NoticeCode = NoticeData['code']

export interface Notice {
  id: string
  /** ISO. */
  at: string
  data: NoticeData
}

/** The most notices a person keeps: older ones go first. */
const MAX_PER_USER = 100

const CODES: readonly NoticeCode[] = ['account_changed', 'user_account_changed', 'history_purged_authored', 'links_not_updated', 'space_changed', 'shared_with_you', 'retention_ran', 'settings_migrated', 'moved_out', 'removed_from', 'space_deleted', 'space_restored', 'space_renamed', 'account_key_added']

export class Notices {
  private db: Db
  private now: () => Date
  /** After a notice was kept for someone: their open pages hear of it at once (liveTree.ts `noticeFor`). */
  onAdded: ((userId: string) => void) | null = null

  constructor(state: Db, opts: { now?: () => Date } = {}) {
    this.db = state
    this.now = opts.now ?? (() => new Date())
  }

  /** A notice for a user (never for a deleted one: nobody would read it). */
  add(userId: string, data: NoticeData): Notice | null {
    const alive = this.db.prepare('select 1 from users where id = ? and deleted_at is null').get(userId)
    if (!alive) return null
    const { code, ...rest } = data
    const notice: Notice = { id: randomUUID(), at: this.now().toISOString(), data }
    this.db.transaction(() => {
      this.db.prepare('insert into notices (id, user_id, code, data, created_at) values (?, ?, ?, ?, ?)').run(notice.id, userId, code, JSON.stringify(rest), notice.at)
      this.db.prepare(`delete from notices where user_id = ? and id not in
        (select id from notices where user_id = ? order by created_at desc, rowid desc limit ?)`).run(userId, userId, MAX_PER_USER)
    })()
    try { this.onAdded?.(userId) } catch { /* hearing of it later is never why it fails */ }
    return notice
  }

  /** A user's notices, oldest first. */
  of(userId: string): Notice[] {
    const rows = this.db.prepare('select id, code, data, created_at from notices where user_id = ? order by created_at, rowid').all(userId) as
      { id: string; code: string; data: string; created_at: string }[]
    const out: Notice[] = []
    for (const r of rows) {
      if (!(CODES as readonly string[]).includes(r.code)) continue
      let rest: Record<string, unknown>
      try { rest = JSON.parse(r.data) as Record<string, unknown> } catch { continue }
      out.push({ id: r.id, at: r.created_at, data: { ...rest, code: r.code } as NoticeData })
    }
    return out
  }

  /** Dismisses one of a user's own notices. Whether there was one. */
  dismiss(userId: string, id: string): boolean {
    return this.db.prepare('delete from notices where id = ? and user_id = ?').run(id, userId).changes > 0
  }

  /**
   * The admin (`by`) changed someone's account: they are told, and so is
   * every other admin (not the one who did it, nor the person, who already
   * has theirs). Doing it to oneself tells only the others.
   */
  accountChanged(userId: string, by: string, change: AccountChange, role: Role | null = null) {
    if (userId !== by) this.add(userId, { code: 'account_changed', change, by, role })
    this.toOtherAdmins(userId, by, change, role)
  }

  /**
   * Only every other admin is told (not the one who did it, nor the person):
   * a new admin is told as a role change to admin is, and the
   * person, just invited, has no account yet to be told about.
   */
  toOtherAdmins(userId: string, by: string, change: AccountChange, role: Role | null = null) {
    const admins = this.db.prepare(`select id from users where role = 'admin' and deleted_at is null and id != ? and id != ?`).all(by, userId) as { id: string }[]
    for (const a of admins) this.add(a.id, { code: 'user_account_changed', change, by, user: userId, role })
  }

  /**
   * The links a move left couldn't be updated, even retried (notes.ts
   * `retryRelinks`): the person who made it is told (an agent's, for an
   * agent's move); nobody for a move the system made on its own.
   */
  relinkGaveUp(by: Actor) {
    const id = by.kind === 'user' ? by.id : by.kind === 'agent' ? by.onBehalfOf : null
    if (id !== null) this.add(id, { code: 'links_not_updated' })
  }

  /**
   * The admin (`by`) did something to a space: `to` (ids) are told, and every
   * other admin too (never the one who did it, nor twice).
   */
  spaceChanged(to: Iterable<string>, by: string, data: Omit<Extract<NoticeData, { code: 'space_changed' }>, 'code' | 'by'>, opts: { admins?: boolean } = {}) {
    const told = new Set<string>([by])
    for (const id of to) {
      if (told.has(id)) continue
      told.add(id)
      this.add(id, { code: 'space_changed', by, ...data })
    }
    if (opts.admins === false) return
    const admins = this.db.prepare(`select id from users where role = 'admin' and deleted_at is null`).all() as { id: string }[]
    for (const a of admins) {
      if (told.has(a.id)) continue
      told.add(a.id)
      this.add(a.id, { code: 'space_changed', by, ...data })
    }
  }

  /** A retention run removed something (or failed): every admin is told, with counts only. */
  retentionRan(data: Omit<Extract<NoticeData, { code: 'retention_ran' }>, 'code'>) {
    const admins = this.db.prepare(`select id from users where role = 'admin' and deleted_at is null`).all() as { id: string }[]
    for (const a of admins) this.add(a.id, { code: 'retention_ran', ...data })
  }

  /** `by` purged `path` (or a version of it): whoever else wrote in what went is told. */
  purged(authors: Iterable<string>, by: string, path: string, version: boolean) {
    for (const id of new Set(authors)) if (id !== by) this.add(id, { code: 'history_purged_authored', by, path, version })
  }
}
