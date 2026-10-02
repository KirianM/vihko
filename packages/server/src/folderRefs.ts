// What state.db and the trash keep by a folder's path, rewritten when vihko
// moves that folder: the folders of agent keys and of
// OAuth codes not yet exchanged, what people pinned in the sidebar, the
// paths notices name (a space someone was added to, a folder shared with
// them, a note purged), the original paths of trash entries, the series
// people chose of a shared space renamed (its ids are made from its root),
// and the note people open on coming in («On opening», which also follows a
// note moved on its own: `noteMoved`). Before 0.1.0
// none of them followed: a key limited to a folder that moved stopped
// reaching it, and «ana added you to Home» became «shared something you no
// longer see» once Home was renamed.
//
// Only moves made from vihko (a folder moved or renamed, a deleted person's
// space transferred or converted). A folder moved outside vihko is a new
// folder as far as these are concerned.
import { readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseSpacePath } from '@vihko/core'
import type { Db } from './db.ts'
import { writeTmp } from './fsutil.ts'
import { keepsLineage } from './history/trailers.ts'
import { seriesPrefix } from './noteSettings.ts'

/** `path` with the folder `from` (or what's under it) now at `to`; null if it isn't there. */
export function movedPath(path: string, from: string, to: string): string | null {
  const p = path.normalize('NFC')
  const f = from.normalize('NFC')
  if (p === f) return to.normalize('NFC')
  if (p.startsWith(f + '/')) return to.normalize('NFC') + p.slice(f.length)
  return null
}

/** What a rewrite changed, by kind (counts only). */
export interface RefsReport {
  keys: number
  pins: number
  notices: number
  trash: number
  /** People whose chosen series (`dailySeries`) was a renamed space's. */
  dailySeries: number
  /** People whose note «On opening» (`onOpenNote`) moved. */
  onOpen: number
}

export class FolderRefs {
  private state: Db
  private stateDir: string

  constructor(opts: { state: Db; stateDir: string }) {
    this.state = opts.state
    this.stateDir = opts.stateDir
  }

  /**
   * Everything kept by a path under `from` now names it under `to`. The
   * trash only within its space (or a space renamed), as the history judges
   * its past: what was deleted before a folder went to another space stays
   * with who could see it where it was. With `trash: 'always'`, wherever it
   * goes (a deleted person's space transferred or converted: nobody is left
   * where it was).
   */
  moved(from: string, to: string, opts: { trash?: 'lineage' | 'always' } = {}): RefsReport {
    const keys = this.rewriteFolders(from, to)
    const pins = this.rewritePins(from, to)
    const notices = this.rewriteNotices(from, to)
    const trash = opts.trash === 'always' || keepsLineage({ from, to }) ? this.rewriteTrash(from, to) : 0
    const dailySeries = this.rewriteDailySeries(from, to)
    const onOpen = this.rewriteOnOpen(from, to)
    return { keys, pins, notices, trash, dailySeries, onOpen }
  }

  /** A note moved on its own from `from` to `to`: whoever opens it on coming in follows it. How many people. */
  noteMoved(from: string, to: string): number {
    return this.rewriteOnOpen(from, to)
  }

  /** «On opening: a note» (`profiles.on_open_note`) under `from`, or `from` itself, now under `to`. How many changed. */
  private rewriteOnOpen(from: string, to: string): number {
    let n = 0
    this.state.transaction(() => {
      const rows = this.state.prepare('select user_id, on_open_note from profiles where on_open_note is not null').all() as { user_id: string; on_open_note: string }[]
      for (const r of rows) {
        const m = movedPath(r.on_open_note, from, to)
        if (m === null) continue
        this.state.prepare('update profiles set on_open_note = ? where user_id = ?').run(m, r.user_id)
        n++
      }
    })()
    return n
  }

  /**
   * A shared space renamed (`from` and `to` its roots): the ids of its series
   * start with a prefix made from its root (noteSettings.ts seriesPrefix), so
   * the series people chose (`profiles.daily_series`) take the new prefix.
   * Nothing for any other folder: a personal space's prefix is always `me-`.
   */
  private rewriteDailySeries(from: string, to: string): number {
    const isSharedRoot = (p: string) => {
      const s = parseSpacePath(p)
      return s !== null && s.space.kind === 'shared' && s.inner === ''
    }
    if (!isSharedRoot(from) || !isSharedRoot(to)) return 0
    const [before, after] = [seriesPrefix(from), seriesPrefix(to)]
    if (before === after) return 0
    return Number(this.state.prepare('update profiles set daily_series = ? || substr(daily_series, ?) where substr(daily_series, 1, ?) = ?')
      .run(after, before.length + 1, before.length, before).changes)
  }

  /**
   * Drops the trash entries of what was deleted under `folder` (a deleted
   * person's space, deleted for good: nobody could see or restore them).
   * How many went.
   */
  dropTrash(folder: string): number {
    const root = join(this.stateDir, 'trash')
    let ids: string[]
    try { ids = readdirSync(root) } catch { return 0 }
    let n = 0
    for (const id of ids) {
      let path: unknown
      try { path = (JSON.parse(readFileSync(join(root, id, 'meta.json'), 'utf8')) as { path?: unknown }).path } catch { continue }
      if (typeof path !== 'string' || movedPath(path, folder, folder) === null) continue
      rmSync(join(root, id), { recursive: true, force: true })
      n++
    }
    return n
  }

  /** Keys' and OAuth codes' folders (JSON lists). How many rows changed. */
  private rewriteFolders(from: string, to: string): number {
    let n = 0
    this.state.transaction(() => {
      for (const table of ['api_keys', 'oauth_codes'] as const) {
        const id = table === 'api_keys' ? 'id' : 'code_hash'
        const rows = this.state.prepare(`select ${id} id, folders from ${table} where folders != '[]'`).all() as { id: string; folders: string }[]
        for (const r of rows) {
          let list: unknown
          try { list = JSON.parse(r.folders) } catch { continue }
          if (!Array.isArray(list)) continue
          let changed = false
          const next = [...new Set(list.map((f) => {
            const m = typeof f === 'string' ? movedPath(f, from, to) : null
            if (m === null) return f
            changed = true
            return m
          }))]
          if (!changed) continue
          this.state.prepare(`update ${table} set folders = ? where ${id} = ?`).run(JSON.stringify(next), r.id)
          n++
        }
      }
    })()
    return n
  }

  /** Pins: a pin whose new path someone already pinned is merged into it. */
  private rewritePins(from: string, to: string): number {
    let n = 0
    this.state.transaction(() => {
      const rows = this.state.prepare('select user_id, path, created_at from pins').all() as { user_id: string; path: string; created_at: string }[]
      for (const r of rows) {
        const m = movedPath(r.path, from, to)
        if (m === null) continue
        this.state.prepare('delete from pins where user_id = ? and path = ?').run(r.user_id, r.path)
        this.state.prepare('insert or ignore into pins (user_id, path, created_at) values (?, ?, ?)').run(r.user_id, m, r.created_at)
        n++
      }
    })()
    return n
  }

  /** Notices' paths (their JSON `data`: `path`, or a space's `space`). How many changed. */
  private rewriteNotices(from: string, to: string): number {
    let n = 0
    this.state.transaction(() => {
      const rows = this.state.prepare('select id, data from notices').all() as { id: string; data: string }[]
      for (const r of rows) {
        let data: Record<string, unknown>
        try { data = JSON.parse(r.data) as Record<string, unknown> } catch { continue }
        if (typeof data !== 'object' || data === null) continue
        let changed = false
        for (const k of ['path', 'space'] as const) {
          const m = typeof data[k] === 'string' ? movedPath(data[k], from, to) : null
          if (m === null) continue
          data[k] = m
          changed = true
        }
        if (!changed) continue
        this.state.prepare('update notices set data = ? where id = ?').run(JSON.stringify(data), r.id)
        n++
      }
    })()
    return n
  }

  /** The trash's entries (their meta.json), each written anew atomically. How many changed. */
  private rewriteTrash(from: string, to: string): number {
    const root = join(this.stateDir, 'trash')
    let ids: string[]
    try { ids = readdirSync(root) } catch { return 0 }
    let n = 0
    for (const id of ids) {
      const file = join(root, id, 'meta.json')
      let entry: { path?: unknown; files?: unknown } & Record<string, unknown>
      try {
        entry = JSON.parse(readFileSync(file, 'utf8')) as typeof entry
      } catch {
        continue
      }
      if (typeof entry?.path !== 'string') continue
      let changed = false
      const path = movedPath(entry.path, from, to)
      if (path !== null) { entry.path = path; changed = true }
      if (Array.isArray(entry.files)) {
        entry.files = entry.files.map((f: unknown) => {
          if (typeof f !== 'object' || f === null || typeof (f as { path?: unknown }).path !== 'string') return f
          const m = movedPath((f as { path: string }).path, from, to)
          if (m === null) return f
          changed = true
          return { ...(f as object), path: m }
        })
      }
      if (!changed) continue
      renameSync(writeTmp(file, JSON.stringify(entry, null, 2)), file)
      n++
    }
    return n
  }
}
