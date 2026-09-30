// What state.db and the trash keep by a folder's path, rewritten when vihko
// moves that folder (spec §1.3, §3.5): the folders of agent keys and of
// OAuth codes not yet exchanged, what people pinned in the sidebar, and the
// original paths of trash entries. Before 0.1.0 none of them followed: a key
// limited to a folder that moved stopped reaching it.
//
// Only moves made from vihko (a folder moved or renamed, a deleted person's
// space transferred or converted). A folder moved outside vihko is a new
// folder as far as these are concerned.
import { readdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from './db.ts'
import { writeTmp } from './fsutil.ts'

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
  trash: number
}

export class FolderRefs {
  private state: Db
  private stateDir: string

  constructor(opts: { state: Db; stateDir: string }) {
    this.state = opts.state
    this.stateDir = opts.stateDir
  }

  /** Everything kept by a path under `from` now names it under `to`. */
  moved(from: string, to: string): RefsReport {
    const keys = this.rewriteFolders(from, to)
    const pins = this.rewritePins(from, to)
    const trash = this.rewriteTrash(from, to)
    return { keys, pins, trash }
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
