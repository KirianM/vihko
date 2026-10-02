// When each grant began: what a person may see of the past. Each
// person sees a note's history (and the trash) only from when they could
// read it: sharing a folder doesn't share what was written, or deleted,
// there before. Application state in state.db (never a note's content, nor
// a relation between notes):
//
// - `grant_starts`: a folder of vihko.yaml's permissions and one subject of
//   its grants (subjectKey: a user's name or `@group`), and since when (ISO;
//   null: from the start). Kept in step with the rules in force (`sync`): a
//   grant vihko hasn't seen before starts when it first sees it, whether it
//   shared the folder itself or someone wrote it by hand; one that's gone
//   loses its row, so giving it again starts anew. The grants in force the
//   first time vihko looks (an installation upgraded to this) count from the
//   start: nobody loses a past they had.
// - `group_members.added_at`: since when someone is in a group (null: from
//   before it was kept). A grant to a group reaches them from the later of
//   the two.
//
// A folder vihko moves keeps its grants' starts (`moving`, before its rules
// are written at the new path). A person's own space has no start: its
// owner sees all of its past.
import { parseSpacePath, subjectKey, type PermissionRule, type SpaceRules } from '@vihko/core'
import type { Db } from './db.ts'

/** The setting that says the starts were taken once (after that, a grant not seen before starts now). */
const STARTED_KEY = 'grants.started'

/** Someone whose past is asked about. */
export interface PastViewer {
  id: string
  username: string
}

export class GrantStarts {
  private db: Db
  private now: () => Date
  /** The rules last synced (by identity: the engine keeps one object while they don't change). */
  private synced: readonly PermissionRule[] | null = null

  constructor(state: Db, opts: { now?: () => Date } = {}) {
    this.db = state
    this.now = opts.now ?? (() => new Date())
  }

  /**
   * The rules in force now: a grant not known yet starts now (from the start
   * the first time ever), one no longer there goes.
   */
  sync(rules: readonly PermissionRule[]): void {
    if (rules === this.synced) return
    this.synced = rules
    const want = new Set<string>()
    for (const r of rules) for (const s of Object.keys(r.grants ?? {})) want.add(pair(r.folder, s))
    const first = this.db.prepare('select 1 from settings where key = ?').get(STARTED_KEY) === undefined
    const since = first ? null : this.now().toISOString()
    this.db.transaction(() => {
      const have = this.db.prepare('select folder, subject from grant_starts').all() as { folder: string; subject: string }[]
      const known = new Set(have.map((h) => `${h.folder}\u0000${h.subject}`))
      const del = this.db.prepare('delete from grant_starts where folder = ? and subject = ?')
      for (const h of have) if (!want.has(`${h.folder}\u0000${h.subject}`)) del.run(h.folder, h.subject)
      const ins = this.db.prepare('insert or ignore into grant_starts (folder, subject, since) values (?, ?, ?)')
      for (const k of want) {
        if (known.has(k)) continue
        const [folder, subject] = k.split('\u0000') as [string, string]
        ins.run(folder, subject, since)
      }
      if (first) this.db.prepare('insert or ignore into settings (key, value) values (?, ?)').run(STARTED_KEY, this.now().toISOString())
    })()
  }

  /**
   * A folder is about to move from `from` to `to` (its rules with it): the
   * starts of its grants, and of those under it, are kept at the new path
   * (the earlier one where both have one).
   */
  moving(from: string, to: string): void {
    const f = from.normalize('NFC')
    const t = to.normalize('NFC')
    if (f === t) return
    const rows = this.db.prepare("select folder, subject, since from grant_starts where folder = ? or folder like ? escape '\\'")
      .all(f, likePrefix(f)) as { folder: string; subject: string; since: string | null }[]
    this.db.transaction(() => {
      for (const r of rows) {
        const at = t + r.folder.slice(f.length)
        const cur = this.db.prepare('select since from grant_starts where folder = ? and subject = ?').get(at, r.subject) as { since: string | null } | undefined
        const since = cur === undefined ? r.since : earlier(cur.since, r.since)
        this.db.prepare('insert into grant_starts (folder, subject, since) values (?, ?, ?) on conflict(folder, subject) do update set since = excluded.since').run(at, r.subject, since)
      }
    })()
  }

  /** The starts of the grants at `folder` and under it (a space about to be deleted: kept to restore it). */
  under(folder: string): { folder: string; subject: string; since: string | null }[] {
    const f = folder.normalize('NFC')
    return this.db.prepare("select folder, subject, since from grant_starts where folder = ? or folder like ? escape '\\'").all(f, likePrefix(f)) as { folder: string; subject: string; since: string | null }[]
  }

  /** Puts starts back (a space restored, before its rules are written again): its grants keep when they began. */
  restore(rows: readonly { folder: string; subject: string; since: string | null }[]): void {
    this.db.transaction(() => {
      const put = this.db.prepare('insert into grant_starts (folder, subject, since) values (?, ?, ?) on conflict(folder, subject) do update set since = excluded.since')
      for (const r of rows) put.run(r.folder, r.subject, r.since)
    })()
  }

  /**
   * Since when `who` has been able to read `folder` through the grants that
   * reach it now (ms since the epoch): the earliest of those grants' starts,
   * each from when they joined the group it names, if it's a group's. `-Infinity`:
   * from the start (their own space, or a grant from before starts were
   * kept). `Infinity`: no grant reaches them (they can't read it).
   */
  since(who: PastViewer, folder: string, rules: SpaceRules, groupsOf: (userId: string) => readonly string[]): number {
    const s = parseSpacePath(folder.normalize('NFC'))
    if (!s) return Infinity
    if (s.space.kind === 'personal' && s.space.owner === who.username.normalize('NFC')) return -Infinity
    const me = subjectKey(who.username)
    const groups = new Set(groupsOf(who.id).map((g) => subjectKey('@' + g)))
    let best = Infinity
    const start = this.db.prepare('select since from grant_starts where folder = ? and subject = ?')
    for (const g of rules.reaching(folder)) {
      const k = subjectKey(g.subject)
      if (k !== me && !groups.has(k)) continue
      const row = start.get(g.from.normalize('NFC'), k) as { since: string | null } | undefined
      // Not synced yet (never, once the rules were read): from now, never earlier.
      let t = row === undefined ? this.now().getTime() : row.since === null ? -Infinity : Date.parse(row.since)
      if (k !== me) t = Math.max(t, this.joined(who.id, k.slice(1)))
      best = Math.min(best, t)
    }
    return best
  }

  /**
   * Since when someone is in a group (by its subject key, without `@`):
   * -Infinity from before it was kept (or a membership state.db doesn't
   * hold: the caller found it in their groups already).
   */
  private joined(userId: string, groupKey: string): number {
    const rows = this.db.prepare('select g.name, m.added_at from group_members m join user_groups g on g.id = m.group_id where m.user_id = ?').all(userId) as { name: string; added_at: string | null }[]
    const r = rows.find((x) => subjectKey('@' + x.name) === '@' + groupKey)
    return r?.added_at ? Date.parse(r.added_at) : -Infinity
  }
}

/** The key of a grant: its folder (NFC) and its subject (subjectKey). */
function pair(folder: string, subject: string): string {
  return `${folder.normalize('NFC')}\u0000${subjectKey(subject)}`
}

/** The earlier of two starts (null: from the start). */
function earlier(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null
  return Date.parse(a) <= Date.parse(b) ? a : b
}

/** A LIKE pattern for everything under a folder. */
function likePrefix(folder: string): string {
  return folder.replace(/[\\%_]/g, (c) => '\\' + c) + '/%'
}
