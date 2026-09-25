// Indexer: brings the contents of the notes folder into index.db.
// Change detection by (mtime, size) equality as a fast filter, and the
// content hash as ground truth. Never writes to the notes.
//
// The indexer keeps the note registry (`notes`), the folders and the alerts;
// what else is derived from a note's content comes from extensions
// (extension.ts), run in the order of their dependencies.
import { readFileSync, readdirSync, statSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { classifyPath, contentHash, extract, isIgnoredDir, type Extracted, type LinkIndex } from '@thoth/core'
import type { Db } from './db.ts'
import { ExtensionHost, type Extension, type NoteSnapshot } from './extension.ts'
import { builtinExtensions, type LinksExtension } from './extensions/index.ts'

export interface IndexerOptions {
  notesDir: string
  db: Db
  /** Guards against mass deletion: aborts if a scan is about to remove more than this fraction… */
  massDeleteRatio?: number
  /** …and more than this number of notes. */
  massDeleteMin?: number
  keys?: Partial<FrontmatterKeys>
  /** Extensions besides the built-in ones. */
  extensions?: readonly Extension[]
  /** Whether aliases resolve links (thoth.yaml `links.aliases`; on by default). `setLinkAliases` changes it. */
  linkAliases?: boolean
}

/** Names of the frontmatter keys thoth understands (configurable). */
export interface FrontmatterKeys {
  uid: string
  title: string
  tags: string
  aliases: string
}

const DEFAULT_KEYS: FrontmatterKeys = { uid: 'uid', title: 'title', tags: 'tags', aliases: 'aliases' }

export interface ScanReport {
  added: string[]
  changed: string[]
  removed: string[]
  unchanged: number
  /** Reason if the scan wasn't applied (entirely or in part). */
  aborted: 'root_unavailable' | 'mass_delete' | null
  /** With `mass_delete`: how many notes it was about to remove and how many were in the index. */
  massDelete: { removing: number; total: number } | null
}

export interface ScanOptions {
  /** Skips the mass-deletion guard without checking what's removed. */
  force?: boolean
  /**
   * Skips the guard only if exactly these notes are removed: what someone saw
   * in the alert and confirmed. If it changed meanwhile, the scan stops again.
   */
  confirmRemoval?: number
}

interface Row { path: string; hash: string; mtime_ms: number; size: number }
interface Upsert { path: string; text: string; hash: string; stat: Stats }

export class Indexer {
  private keys: FrontmatterKeys
  private opts: IndexerOptions
  private host: ExtensionHost
  private linkExt: LinksExtension
  /**
   * Extensions that don't hold every note yet: new ones, or a new version of
   * one (and what depends on it). They are filled from the files before the
   * next scan or batch; the rest of the index is left alone.
   */
  private pending: Set<string>

  constructor(opts: IndexerOptions) {
    this.opts = opts
    this.keys = { ...DEFAULT_KEYS, ...opts.keys }
    const builtin = builtinExtensions({ linkAliases: opts.linkAliases })
    this.linkExt = builtin.links
    this.host = new ExtensionHost(opts.db, [...builtin.all, ...(opts.extensions ?? [])])
    this.pending = this.host.install()
  }

  /** Link resolution keys of every indexed note (kept by the links extension). */
  get links(): LinkIndex {
    return this.linkExt.index
  }

  private get db() {
    return this.opts.db
  }

  /** Whether aliases resolve links. */
  get linkAliases(): boolean {
    return this.linkExt.aliases
  }

  /**
   * Turns alias resolution on or off (thoth.yaml changed) and resolves every
   * link again with the keys already indexed: no note is read or reindexed.
   */
  setLinkAliases(on: boolean) {
    if (!this.linkExt.setAliases(on)) return
    this.catchUp()
    this.db.transaction(() => this.host.finalize({ indexed: new Set(), removed: new Set() }, new Set([this.linkExt.name])))()
  }

  /** Full scan of the folder. */
  scan({ force = false, confirmRemoval }: ScanOptions = {}): ScanReport {
    const report: ScanReport = { added: [], changed: [], removed: [], unchanged: 0, aborted: null, massDelete: null }
    try {
      if (!statSync(this.opts.notesDir).isDirectory()) throw new Error('not a directory')
    } catch {
      report.aborted = 'root_unavailable'
      return report
    }
    this.catchUp()

    const seen = new Set<string>()
    const conflicts: string[] = []
    const upserts: Upsert[] = []
    const touch: { path: string; stat: Stats }[] = []
    const known = new Map((this.db.prepare('select path, hash, mtime_ms, size from notes').all() as Row[]).map((r) => [r.path, r]))

    const unreadable: string[] = []
    const dirs: string[] = []
    for (const rel of walk(this.opts.notesDir, '', unreadable, dirs)) {
      const kind = classifyPath(rel)
      if (kind === 'conflict') conflicts.push(rel)
      if (kind !== 'note') continue
      seen.add(rel)
      this.detect(rel, known.get(rel), upserts, touch, report)
    }

    // Anything under a directory that couldn't be read is not treated as deleted.
    const underUnreadable = (p: string) => unreadable.some((d) => p.startsWith(d + '/'))
    const removed = [...known.keys()].filter((p) => !seen.has(p) && !underUnreadable(p))
    const min = this.opts.massDeleteMin ?? 10
    const ratio = this.opts.massDeleteRatio ?? 0.5
    const massive = removed.length > min && removed.length > ratio * known.size
    if (massive && !force && confirmRemoval !== removed.length) {
      report.aborted = 'mass_delete'
      report.massDelete = { removing: removed.length, total: known.size }
    } else report.removed = removed

    this.apply(upserts, touch, report.removed, conflicts)
    // Like notes, folders aren't dropped by a scan that stopped (an unmounted share looks empty).
    if (!report.aborted) this.db.transaction(() => {
      this.db.prepare('delete from folders').run()
      const ins = this.db.prepare('insert into folders (path) values (?)')
      for (const d of dirs) ins.run(d)
    })()
    return report
  }

  /**
   * Brings specific folders up to date (thoth's own folder operations): one
   * that exists is recorded with its ancestors and its subfolders; one that no
   * longer does goes, with everything recorded under it. A full scan does the
   * same for all.
   */
  indexFolders(paths: Iterable<string>) {
    const ins = this.db.prepare('insert or ignore into folders (path) values (?)')
    const del = this.db.prepare("delete from folders where path = ? or path like ? escape '\\'")
    this.db.transaction(() => {
      for (const p of new Set(paths)) {
        if (!p || classifyPath(p) === 'ignored') continue
        let dir = false
        try { dir = statSync(join(this.opts.notesDir, p)).isDirectory() } catch { /* gone */ }
        del.run(p, likePrefix(p))
        if (!dir) continue
        const sub: string[] = []
        for (const _ of walk(this.opts.notesDir, p, [], sub)) { /* only the folders are wanted */ }
        for (const a of [...ancestorsOf(p), p, ...sub]) ins.run(a)
      }
    })()
  }

  /** Reindexes specific paths (watcher events). Doesn't apply the mass-deletion guard. */
  indexPaths(paths: Iterable<string>): ScanReport {
    const report: ScanReport = { added: [], changed: [], removed: [], unchanged: 0, aborted: null, massDelete: null }
    this.catchUp()
    const upserts: Upsert[] = []
    const touch: { path: string; stat: Stats }[] = []
    const conflictsNow: string[] = []
    const conflictsGone: string[] = []
    const getRow = this.db.prepare('select path, hash, mtime_ms, size from notes where path = ?')
    for (const rel of new Set(paths)) {
      const kind = classifyPath(rel)
      if (kind === 'conflict') (exists(join(this.opts.notesDir, rel)) ? conflictsNow : conflictsGone).push(rel)
      if (kind !== 'note') continue
      const row = getRow.get(rel) as Row | undefined
      if (!exists(join(this.opts.notesDir, rel))) {
        if (row) report.removed.push(rel)
        continue
      }
      this.detect(rel, row, upserts, touch, report)
    }
    this.apply(upserts, touch, report.removed, null, conflictsNow, conflictsGone)
    // A note in a folder the index hadn't seen yet (created by thoth or from outside).
    if (report.added.length) {
      const ins = this.db.prepare('insert or ignore into folders (path) values (?)')
      this.db.transaction(() => { for (const p of report.added) for (const a of ancestorsOf(p)) ins.run(a) })()
    }
    return report
  }

  private detect(rel: string, row: Row | undefined, upserts: Upsert[], touch: { path: string; stat: Stats }[], report: ScanReport) {
    let stat: Stats
    try {
      stat = statSync(join(this.opts.notesDir, rel))
    } catch {
      return // disappeared between listing and stat; the next scan will catch it
    }
    if (row && row.mtime_ms === stat.mtimeMs && row.size === stat.size) {
      report.unchanged++
      return
    }
    const text = readFileSync(join(this.opts.notesDir, rel), 'utf8')
    const hash = contentHash(text)
    if (row && row.hash === hash) {
      touch.push({ path: rel, stat })
      report.unchanged++
      return
    }
    upserts.push({ path: rel, text, hash, stat })
    ;(row ? report.changed : report.added).push(rel)
  }

  private apply(
    upserts: Upsert[],
    touch: { path: string; stat: Stats }[],
    removed: string[],
    allConflicts: string[] | null,
    conflictsNow: string[] = [],
    conflictsGone: string[] = [],
  ) {
    const db = this.db
    const indexed = new Set<string>()
    const gone = new Set<string>()
    const delNote = db.prepare('delete from notes where path = ?')
    const insNote = db.prepare('insert into notes (path, uid, title, hash, mtime_ms, size, fm_json, fm_error, aliases) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const touchStmt = db.prepare('update notes set mtime_ms = ?, size = ? where path = ?')

    db.transaction(() => {
      for (const path of removed) {
        delNote.run(path)
        this.host.remove(path)
        gone.add(path)
      }
      for (const t of touch) touchStmt.run(t.stat.mtimeMs, t.stat.size, t.path)
      for (const u of upserts) {
        const note = this.snapshot(u.path, u.text, u.hash)
        const fm = note.parsed.frontmatter
        delNote.run(u.path)
        insNote.run(u.path, note.uid, note.title, u.hash, u.stat.mtimeMs, u.stat.size, JSON.stringify(fm.data), fm.error, JSON.stringify(note.aliases))
        this.host.index(note)
        indexed.add(u.path)
      }
      this.syncConflicts(allConflicts, conflictsNow, conflictsGone)
      this.host.finalize({ indexed, removed: gone })
    })()
  }

  /**
   * Runs the pending extensions over every registered note, in one
   * transaction, and records them as current. A note whose file changed since
   * it was indexed is left for the scan, which reindexes it with every
   * extension. Without the notes folder (an unmounted share) they keep waiting.
   */
  private catchUp() {
    if (this.pending.size === 0) return
    try {
      if (!statSync(this.opts.notesDir).isDirectory()) return
    } catch {
      return
    }
    const only = this.pending
    const db = this.db
    const rows = db.prepare('select path, hash from notes order by path').all() as { path: string; hash: string }[]
    const stale = db.prepare('update notes set mtime_ms = -1 where path = ?')
    const indexed = new Set<string>()
    db.transaction(() => {
      for (const r of rows) {
        let text: string
        try {
          text = readFileSync(join(this.opts.notesDir, r.path), 'utf8')
        } catch {
          continue // gone: the scan removes it
        }
        if (contentHash(text) !== r.hash) {
          stale.run(r.path) // so the next scan sees it changed, whatever its mtime
          continue
        }
        this.host.index(this.snapshot(r.path, text, r.hash), only)
        indexed.add(r.path)
      }
      this.host.finalize({ indexed, removed: new Set() }, only)
      this.host.markCurrent(only)
    })()
    this.pending = new Set()
  }

  /** The note as extensions see it: parsed once, with the registry's own facts. */
  private snapshot(path: string, text: string, hash: string): NoteSnapshot {
    const parsed = extract(text, { tagsKey: this.keys.tags })
    return { path, text, hash, parsed, uid: this.uidOf(parsed), title: this.titleOf(path, parsed), aliases: this.aliasesOf(parsed) }
  }

  private syncConflicts(all: string[] | null, now: string[], gone: string[]) {
    if (all) {
      this.db.prepare("delete from alerts where kind = 'sync_conflict'").run()
      now = all
    }
    const ins = this.db.prepare("insert or ignore into alerts (path, kind, detail) values (?, 'sync_conflict', null)")
    const del = this.db.prepare("delete from alerts where path = ? and kind = 'sync_conflict'")
    for (const p of now) ins.run(p)
    for (const p of gone) del.run(p)
  }

  private uidOf(x: Extracted): string | null {
    const v = x.frontmatter.data[this.keys.uid]
    return typeof v === 'string' || typeof v === 'number' ? String(v) : null
  }

  private titleOf(path: string, x: Extracted): string {
    const t = x.frontmatter.data[this.keys.title]
    if (typeof t === 'string' && t.trim()) return t.trim()
    const h1 = x.headings.find((h) => h.level === 1)
    if (h1?.text) return h1.text
    return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
  }

  private aliasesOf(x: Extracted): string[] {
    const v = x.frontmatter.data[this.keys.aliases]
    const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : []
    return list.filter((a): a is string | number => typeof a === 'string' || typeof a === 'number').map(String).filter((a) => a.trim())
  }

  /** Groups of notes that share a `uid` (e.g. from copy-pasting). Identity conflict. */
  uidConflicts(): { uid: string; paths: string[] }[] {
    const rows = this.db.prepare(`select uid, json_group_array(path) paths from (select uid, path from notes where uid in
      (select uid from notes where uid is not null group by uid having count(*) > 1) order by path) group by uid order by uid`).all() as { uid: string; paths: string }[]
    return rows.map((r) => ({ uid: r.uid, paths: JSON.parse(r.paths) }))
  }
}

/** Walks the folder without entering ignored directories. Returns relative paths with `/`; the directories go to `dirs`. */
function* walk(root: string, rel: string, unreadable: string[], dirs: string[]): Generator<string> {
  let entries
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true })
  } catch {
    unreadable.push(rel)
    return
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (!isIgnoredDir(e.name)) { dirs.push(r); yield* walk(root, r, unreadable, dirs) }
    } else if (e.isFile()) {
      yield r
    }
  }
}

function exists(file: string) {
  try {
    statSync(file)
    return true
  } catch {
    return false
  }
}

/** `a/b/c.md` → `a`, `a/b`. */
function ancestorsOf(path: string): string[] {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

const likePrefix = (dir: string) => dir.replace(/[\\%_]/g, (c) => '\\' + c) + '/%'
