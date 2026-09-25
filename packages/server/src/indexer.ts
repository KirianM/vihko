// Indexer: brings the contents of the notes folder into index.db.
// Change detection by (mtime, size) equality as a fast filter, and the
// content hash as ground truth. Never writes to the notes.
//
// The indexer keeps the note registry (`notes`), the folders and the alerts;
// what else is derived from a note's content comes from extensions
// (extension.ts), run in the order of their dependencies.
import { readFileSync, readdirSync, statSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { LinkIndex, classifyPath, contentHash, extract, isIgnoredDir, normKey, pathKeys, resolveImageRef, type Extracted } from '@thoth/core'
import type { Db } from './db.ts'
import { ExtensionHost, type Extension, type NoteSnapshot } from './extension.ts'
import { fts } from './extensions/fts.ts'

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
  readonly links = new LinkIndex()
  private keys: FrontmatterKeys
  private opts: IndexerOptions
  private host: ExtensionHost

  constructor(opts: IndexerOptions) {
    this.opts = opts
    this.keys = { ...DEFAULT_KEYS, ...opts.keys }
    this.host = new ExtensionHost(opts.db, [fts, ...(opts.extensions ?? [])])
    this.host.markCurrent(this.host.install())
    this.loadLinkIndex()
  }

  private get db() {
    return this.opts.db
  }

  private loadLinkIndex() {
    const headings = new Map<string, string[]>()
    for (const h of this.db.prepare('select path, text from headings order by path, ord').all() as { path: string; text: string }[]) {
      let list = headings.get(h.path)
      if (!list) headings.set(h.path, (list = []))
      list.push(h.text)
    }
    for (const n of this.db.prepare('select path, aliases from notes').all() as { path: string; aliases: string }[]) {
      this.links.set({ path: n.path, aliases: JSON.parse(n.aliases), headings: headings.get(n.path) ?? [] })
    }
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
    const affectedKeys = new Set<string>()
    const changedPaths = new Set<string>()
    const indexedPaths = new Set<string>()
    const removedPaths = new Set<string>()

    const del = {
      notes: db.prepare('delete from notes where path = ?'),
      keys: db.prepare('delete from link_keys where path = ?'),
      links: db.prepare('delete from links where src_path = ?'),
      images: db.prepare('delete from images where src_path = ?'),
      tags: db.prepare('delete from tags where path = ?'),
      headings: db.prepare('delete from headings where path = ?'),
    }
    const removeRows = (path: string) => {
      for (const s of Object.values(del)) s.run(path)
    }

    const ins = {
      note: db.prepare('insert into notes (path, uid, title, hash, mtime_ms, size, fm_json, fm_error, aliases) values (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      key: db.prepare('insert or ignore into link_keys (key, path, kind) values (?, ?, ?)'),
      link: db.prepare(`insert into links (src_path, ord, kind, raw, target, anchor, display, pos_from, pos_to, key, status)
                        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'missing')`),
      image: db.prepare('insert into images (src_path, ord, kind, raw, path) values (?, ?, ?, ?, ?)'),
      tag: db.prepare('insert or ignore into tags (path, tag, source) values (?, ?, ?)'),
      heading: db.prepare('insert into headings (path, ord, level, text, pos) values (?, ?, ?, ?, ?)'),
    }
    const touchStmt = db.prepare('update notes set mtime_ms = ?, size = ? where path = ?')

    db.transaction(() => {
      for (const path of removed) {
        removeRows(path)
        this.host.remove(path)
        for (const k of this.links.delete(path)) affectedKeys.add(k)
        changedPaths.add(path)
        removedPaths.add(path)
      }
      for (const t of touch) touchStmt.run(t.stat.mtimeMs, t.stat.size, t.path)
      for (const u of upserts) {
        removeRows(u.path)
        const note = this.snapshot(u.path, u.text, u.hash)
        const x = note.parsed
        const aliases = note.aliases
        ins.note.run(u.path, note.uid, note.title, u.hash, u.stat.mtimeMs, u.stat.size,
          JSON.stringify(x.frontmatter.data), x.frontmatter.error, JSON.stringify(aliases))
        this.host.index(note)
        for (const k of pathKeys(u.path)) ins.key.run(k, u.path, 'path')
        for (const a of aliases) ins.key.run(normKey(a), u.path, 'alias')
        x.links.forEach((l, i) => {
          ins.link.run(u.path, i, l.kind, l.raw, l.target, l.anchor, l.display, l.from, l.to, LinkIndex.keyOf(u.path, l))
        })
        x.images.forEach((img, i) => {
          const path = resolveImageRef(u.path, img.dest, { embed: img.kind === 'embed' || img.kind === 'wiki' })
          if (path !== null) ins.image.run(u.path, i, img.kind, img.raw, path)
        })
        for (const t of x.tags) ins.tag.run(u.path, t.name, t.source)
        x.headings.forEach((h, i) => ins.heading.run(u.path, i, h.level, h.text, h.from))
        for (const k of this.links.set({ path: u.path, aliases, headings: x.headings.map((h) => h.text) })) affectedKeys.add(k)
        changedPaths.add(u.path)
        indexedPaths.add(u.path)
      }
      this.syncConflicts(allConflicts, conflictsNow, conflictsGone)
      this.resolveLinks(changedPaths, affectedKeys)
      this.host.finalize({ indexed: indexedPaths, removed: removedPaths })
    })()
  }

  /** The note as extensions see it: parsed once, with the registry's own facts. */
  private snapshot(path: string, text: string, hash: string): NoteSnapshot {
    const parsed = extract(text, { tagsKey: this.keys.tags })
    return { path, text, hash, parsed, uid: this.uidOf(parsed), title: this.titleOf(path, parsed), aliases: this.aliasesOf(parsed) }
  }

  /** Re-resolves affected links: those in changed notes, those that look up an affected key, and those that pointed to a changed note. */
  private resolveLinks(changedPaths: Set<string>, affectedKeys: Set<string>) {
    if (changedPaths.size === 0 && affectedKeys.size === 0) return
    const rows: { src_path: string; ord: number; kind: 'wiki' | 'embed' | 'markdown'; target: string; anchor: string | null }[] = []
    const seen = new Set<string>()
    const collect = (sql: string, values: string[]) => {
      for (const chunk of chunks(values, 500)) {
        const q = this.db.prepare(sql.replace('$IN', chunk.map(() => '?').join(',')))
        for (const r of q.all(...chunk) as typeof rows) {
          const id = r.src_path + '\u0000' + r.ord
          if (!seen.has(id)) { seen.add(id); rows.push(r) }
        }
      }
    }
    const cols = 'select src_path, ord, kind, target, anchor from links'
    collect(`${cols} where src_path in ($IN)`, [...changedPaths])
    collect(`${cols} where key in ($IN)`, [...affectedKeys])
    collect(`${cols} where dst_path in ($IN)`, [...changedPaths])
    const update = this.db.prepare('update links set status = ?, dst_path = ?, via = ?, anchor_ok = ?, candidates = ? where src_path = ? and ord = ?')
    for (const r of rows) {
      if (!this.links.has(r.src_path)) continue // source note deleted
      const res = this.links.resolve(r.src_path, r)
      if (res.status === 'resolved') {
        update.run('resolved', res.path, res.via, res.anchor === null ? null : res.anchor === 'ok' ? 1 : 0, null, r.src_path, r.ord)
      } else if (res.status === 'ambiguous') {
        update.run('ambiguous', null, null, null, JSON.stringify(res.candidates), r.src_path, r.ord)
      } else {
        update.run('missing', null, null, null, null, r.src_path, r.ord)
      }
    }
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

function* chunks<T>(list: T[], size: number) {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size)
}
