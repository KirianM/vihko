// What a principal can do with the notes, through the access filter
// (access.ts): the operations the HTTP API offers (and the MCP server, M3),
// each one reading and writing through the note service as that principal.
// A user sees everything (until M4); an agent only what its key allows, and
// nothing it can't see leaks through a list, a count, a link, a preview or an
// error: it doesn't exist (`not_found`).
import { LinkIndex, anchorChanged, contentHash, extract, normKey, parseThreads, withoutRanges, type AttachmentsConfig, type ErrorCode, type LinkRef, type Range } from '@thoth/core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AccessError, type Access } from './access.ts'
import { attachmentPath } from './attachments.ts'
import type { Db } from './db.ts'
import type { DailyNotes } from './daily.ts'
import { planEdits, type EditOp } from './edits.ts'
import { HIGHLIGHT_END, HIGHLIGHT_START, search, type SearchResult } from './http/search.ts'
import { NoteError, NoteService, type MoveHooks, type MoveReport, type NoteRead } from './notes.ts'
import type { Profiles } from './profiles.ts'
import type { LinkState } from './relink.ts'
import { createFromTemplate } from './templates.ts'
import type { HistoryReader } from './history/reader.ts'
import type { Recorder } from './history/recorder.ts'
import { revertVersion, type RevertReport } from './history/revert.ts'

export { HIGHLIGHT_END, HIGHLIGHT_START }

export interface ScopedDeps {
  notes: NoteService
  index: Db
  notesDir: string
  daily: DailyNotes
  profiles: Profiles
  /** Where new images go (thoth.yaml), to know whether an agent may put one there. */
  attachments: () => AttachmentsConfig
  now: () => Date
  /** How links resolve over every indexed note (the indexer's), for `resolveLink`. */
  links?: () => LinkIndex
}

/** A request that can't be served as it is: the status and the code the API answers with. */
export class RequestError extends Error {
  readonly status: 400 | 403 | 428
  readonly code: ErrorCode
  constructor(status: RequestError['status'], code: ErrorCode, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** An outgoing link as the API gives it. `status` null: it leads to a note the principal can't see. */
export interface OutgoingLink {
  raw: string
  kind: string
  target: string
  anchor: string | null
  status: 'resolved' | 'ambiguous' | 'missing' | null
  dst_path: string | null
  anchor_ok: number | null
  candidates: string[] | null
  pos_from: number
}

/** What an edit by operations would do (`dryRun`): each change on the note as it is now, in order. */
export interface EditPreview {
  dryRun: true
  etag: string
  changes: { at: number; removed: string; inserted: string }[]
}

/** A move report as an agent gets it: `hidden` says there are links in notes it can't see, never which or how many (D-018). */
export type ScopedMoveReport = MoveReport & { hidden?: boolean }

/**
 * Where a link leads, written in a note (`resolveLink`). `status` null: it
 * doesn't lead to a note the principal can see (as in `links`). `anchorOk`:
 * whether the heading after `#` is in the note it leads to (null without one).
 */
export interface ResolvedLink {
  kind: LinkRef['kind']
  target: string
  anchor: string | null
  status: 'resolved' | 'ambiguous' | 'missing' | null
  path: string | null
  anchorOk: boolean | null
  candidates: string[] | null
  /** Titles of `path` and the candidates. */
  titles: Record<string, string>
}

class DryRun extends Error {
  readonly preview: EditPreview
  constructor(preview: EditPreview) {
    super('dry run')
    this.preview = preview
  }
}

/**
 * Substitutions need the ETag of the text they were planned on (D-017):
 * they replace text (or a frontmatter value) the agent must have seen.
 * Appends don't.
 */
export const SUBSTITUTIONS: readonly string[] = ['find_replace', 'replace_section', 'set_frontmatter']

export class ScopedNotes {
  private deps: ScopedDeps
  readonly access: Access

  constructor(deps: ScopedDeps, access: Access) {
    this.deps = deps
    this.access = access
  }

  /** The note, if the principal may read it; `not_found` otherwise, whether it exists or not. */
  private visible(path: string): NoteRead {
    const p = NoteService.checkPath(path)
    this.access.assertRead(p)
    const r = this.deps.notes.read(p)
    if (this.access.hides(r.text)) throw new NoteError('not_found', `does not exist: ${p}`)
    return r
  }

  /** A note error about a note the principal can't read never carries its ETag. */
  private async guardAsync<T>(path: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      throw this.masked(err, path)
    }
  }

  private masked(err: unknown, path: string): unknown {
    if (err instanceof NoteError && err.etag && this.access.isAgent && !this.readable(path)) return new NoteError(err.code, err.message)
    return err
  }

  /** A write the principal may make: `not_found` for what it can't see, `forbidden` for a read-only key. */
  private writable(path: string): string {
    const p = NoteService.checkPath(path)
    this.access.assertWrite(p)
    return p
  }

  // --- Reading ----------------------------------------------------------------

  read(path: string): NoteRead & { meta: unknown } {
    const r = this.visible(path)
    const meta = this.deps.index.prepare('select title, uid, fm_error from notes where path = ?').get(r.path) ?? null
    return { ...r, meta }
  }

  /** A note's headings, in order (link anchors). */
  headings(path: string): { level: number; text: string }[] {
    const r = this.visible(path)
    return this.deps.index.prepare('select level, text from headings where path = ? order by ord').all(r.path) as { level: number; text: string }[]
  }

  /** A note's comment threads as the index first saw them (D-031.6). */
  comments(path: string) {
    const { path: p, text } = this.visible(path)
    const originals = new Map((this.deps.index.prepare('select thread, original from comment_anchors where src_path = ? and orphaned = 0').all(p) as { thread: string; original: string }[])
      .map((r) => [r.thread, r.original]))
    return parseThreads(text).flatMap((t) => {
      const original = originals.get(t.id)
      return original === undefined ? [] : [{ id: t.id, original, changed: anchorChanged(original, text.slice(t.anchorFrom, t.anchorTo)) }]
    })
  }

  /**
   * A note's outgoing links and backlinks (with their context), and the
   * titles of an ambiguous link's candidates. A link to a note the principal
   * can't see is just its text, with no status; an ambiguous one keeps the
   * candidates it can see (without status if fewer than two remain).
   */
  links(path: string): { outgoing: OutgoingLink[]; backlinks: { path: string; title: string; raw: string; context: string }[]; titles: Record<string, string> } {
    const { path: p } = this.visible(path)
    const { index, notesDir } = this.deps
    const outgoing = index.prepare(`select raw, kind, target, anchor, status, dst_path, anchor_ok, candidates, pos_from
      from links where src_path = ? order by ord`).all(p) as (Omit<OutgoingLink, 'candidates'> & { candidates: string | null })[]
    const w = this.access.notesWhere('n')
    const incoming = index.prepare(`select l.src_path, n.title, l.raw, l.pos_from, l.pos_to
      from links l join notes n on n.path = l.src_path where l.dst_path = ? and l.src_path != ? and ${w.sql} order by l.src_path, l.ord`)
      .all(p, p, ...w.params) as { src_path: string; title: string; raw: string; pos_from: number; pos_to: number }[]
    const sources = new Map<string, { text: string; comments: Range[] }>()
    const backlinks = incoming.flatMap((l) => {
      let src = sources.get(l.src_path)
      if (!src) {
        let text = ''
        try { text = readFileSync(join(notesDir, l.src_path), 'utf8') } catch {}
        sources.set(l.src_path, (src = { text, comments: extract(text).comments }))
      }
      // Its text says more than the index: a note hidden since it was indexed isn't a source.
      if (this.access.hides(src.text)) return []
      return [{ path: l.src_path, title: l.title, raw: l.raw, context: context(src.text, src.comments, l.pos_from, l.pos_to) }]
    })
    const titles: Record<string, string> = {}
    const titleOf = index.prepare('select title from notes where path = ?')
    const out = outgoing.map((l): OutgoingLink => {
      let candidates = l.candidates ? JSON.parse(l.candidates) as string[] : null
      let link: OutgoingLink = { ...l, candidates }
      if (this.access.isAgent) {
        if (l.dst_path !== null && !this.access.canRead(l.dst_path)) link = unknownLink(l)
        else if (candidates) {
          candidates = candidates.filter((c) => this.access.canRead(c))
          link = candidates.length >= 2 ? { ...l, candidates } : unknownLink(l)
        }
      }
      for (const c of link.candidates ?? []) titles[c] ??= (titleOf.get(c) as { title: string } | undefined)?.title ?? c
      return link
    })
    return { outgoing: out, backlinks, titles }
  }

  /**
   * Where `link` leads, written in `from`: `[[Note#Heading]]`, `[text](path.md)`
   * or a bare target (`Note#Heading`). A link the note has is answered as
   * `links` gives it. Any other, for an agent, is resolved over only the notes
   * it can read: asking about names never tells whether something exists out
   * of its sight (which `null` would, next to `missing`).
   */
  resolveLink(from: string, link: string): ResolvedLink {
    const { path: src } = this.visible(from)
    const parsed = parseLink(link)
    if (!parsed) throw new RequestError(400, 'invalid', 'not a link')
    const { index } = this.deps
    const titleOf = index.prepare('select title from notes where path = ?')
    const withTitles = (r: Omit<ResolvedLink, 'titles'>): ResolvedLink => {
      const titles: Record<string, string> = {}
      for (const p of [r.path, ...(r.candidates ?? [])]) if (p) titles[p] = (titleOf.get(p) as { title: string } | undefined)?.title ?? p
      return { ...r, titles }
    }
    const same = (a: string | null, b: string | null) => normKey(a ?? '') === normKey(b ?? '')
    const own = this.links(src).outgoing.find((l) => l.kind === parsed.kind && same(l.target, parsed.target) && same(l.anchor, parsed.anchor))
    if (own) {
      return withTitles({
        kind: parsed.kind, target: own.target, anchor: own.anchor, status: own.status, path: own.dst_path,
        anchorOk: own.anchor_ok === null ? null : own.anchor_ok === 1, candidates: own.candidates,
      })
    }
    if (!this.deps.links) throw new Error('link resolution is not available')
    let links = this.deps.links()
    if (this.access.isAgent) {
      const full = links
      links = new LinkIndex({ aliases: full.aliases })
      const w = this.access.notesWhere('n')
      for (const { path } of index.prepare(`select path from notes n where ${w.sql}`).all(...w.params) as { path: string }[]) {
        const keys = full.get(path)
        if (keys) links.set(keys)
      }
    }
    const r = links.resolve(src, parsed)
    const base = { kind: parsed.kind, target: parsed.target, anchor: parsed.anchor }
    if (r.status === 'resolved') return withTitles({ ...base, status: 'resolved', path: r.path, anchorOk: r.anchor === null ? null : r.anchor === 'ok', candidates: null })
    if (r.status === 'ambiguous') return withTitles({ ...base, status: 'ambiguous', path: null, anchorOk: null, candidates: r.candidates })
    return withTitles({ ...base, status: 'missing', path: null, anchorOk: null, candidates: null })
  }

  /**
   * Notes and folders. A folder shows if it is within reach and doesn't only
   * hold notes the principal can't see (a folder with no notes at all, just
   * created or emptied, still shows).
   */
  tree(): { notes: { path: string; title: string; uid: string | null; aliases: string[] }[]; folders: string[] } {
    const { index } = this.deps
    const w = this.access.notesWhere('n')
    const rows = index.prepare(`select path, title, uid, aliases from notes n where ${w.sql} order by path`).all(...w.params) as { path: string; title: string; uid: string | null; aliases: string }[]
    let folders = (index.prepare('select path from folders order by path').all() as { path: string }[]).map((r) => r.path)
    if (this.access.isAgent) {
      const holds = new Set<string>()
      const holdsVisible = new Set<string>()
      for (const { path } of index.prepare('select path from notes').all() as { path: string }[]) for (const a of ancestors(path)) holds.add(a)
      for (const { path } of rows) for (const a of ancestors(path)) holdsVisible.add(a)
      folders = folders.filter((f) => this.access.folderInScope(f) && (!holds.has(f) || holdsVisible.has(f)))
    }
    return { notes: rows.map((r) => ({ ...r, aliases: JSON.parse(r.aliases) as string[] })), folders }
  }

  /**
   * Tags in use, most used first. `count`: the notes that carry the tag;
   * `total`: those that carry it or one nested under it. Only notes the
   * principal can read count.
   */
  tags(): { tag: string; count: number; total: number }[] {
    const { index } = this.deps
    const w = this.access.notesWhere('n')
    const join = this.access.isAgent ? `join notes n on n.path = t.path where ${w.sql}` : ''
    const params = this.access.isAgent ? w.params : []
    const rows = index.prepare(`select t.tag, count(distinct t.path) as count from tags t ${join} group by t.tag order by count desc, t.tag`).all(...params) as { tag: string; count: number }[]
    const under = new Map<string, Set<string>>()
    for (const r of index.prepare(`select distinct t.path, t.tag from tags t ${join}`).all(...params) as { path: string; tag: string }[]) {
      const parts = r.tag.split('/')
      for (let i = 1; i <= parts.length; i++) {
        const t = parts.slice(0, i).join('/')
        let set = under.get(t)
        if (!set) under.set(t, (set = new Set()))
        set.add(r.path)
      }
    }
    return rows.map((r) => ({ ...r, total: under.get(r.tag)?.size ?? r.count }))
  }

  /** Full text plus `tag:` and `path:` filters, over what the principal can read. */
  search(q: string): SearchResult[] {
    return search(this.deps.index, q, this.access.notesWhere('n'))
  }

  /** Whether the principal may be served a file that isn't a note (an image): `not_found` otherwise. */
  assertFile(path: string): void {
    this.access.assertRead(path)
  }

  // --- Writing ----------------------------------------------------------------

  /**
   * A new note, with the given text or from a template note (D-030). Never
   * overwrites. An agent needs to be able to read the template.
   */
  async create(path: string, opts: { text?: string; template?: string; freshUid?: boolean }) {
    const p = this.writable(path)
    const actor = this.access.actor
    if (opts.template !== undefined) {
      if (this.access.isAgent) this.visible(opts.template)
      const user = this.access.user
      return this.guardAsync(p, () => createFromTemplate(this.deps.notes, { path: p, template: opts.template!, user, now: this.deps.profiles.now(user.id, this.deps.now()), actor }))
    }
    return this.guardAsync(p, () => this.deps.notes.create(p, opts.text ?? '', actor, { freshUid: opts.freshUid === true }))
  }

  /**
   * Replaces the whole text. With `ifMatch`, only over that ETag; with
   * `ifNoneMatch: '*'`, only if the note doesn't exist (412 if it does).
   */
  async write(path: string, text: string, opts: { ifMatch?: string; ifNoneMatch?: string }): Promise<{ etag: string; created: boolean }> {
    const p = this.writable(path)
    if (opts.ifNoneMatch === '*') {
      try {
        const r = await this.guardAsync(p, () => this.deps.notes.create(p, text, this.access.actor))
        return { etag: r.etag, created: true }
      } catch (err) {
        if (err instanceof NoteError && err.code === 'exists') throw new NoteError('precondition_failed', `already exists: ${p}`, err.etag)
        throw err
      }
    }
    if (!opts.ifMatch) throw new RequestError(428, 'precondition_required', "missing If-Match: a note that hasn't been read won't be overwritten")
    const r = await this.edit(p, () => text, { ifMatch: opts.ifMatch })
    return { etag: r.etag, created: false }
  }

  /** Applies `fn` to the current text as the principal; an agent never edits a note it can't see. */
  private edit(path: string, fn: (text: string) => string | ReturnType<typeof planEdits>, opts: { ifMatch?: string }) {
    const p = this.writable(path)
    return this.guardAsync(p, () => this.deps.notes.edit(p, (t) => {
      if (this.access.hides(t)) throw new NoteError('not_found', `does not exist: ${p}`)
      return fn(t)
    }, { ifMatch: opts.ifMatch, actor: this.access.actor }))
  }

  /**
   * Edits by operation (edits.ts), atomic on the current text, even with the
   * note open. An agent must give `ifMatch` for substitutions (D-017).
   * `dryRun`: what it would change, without writing.
   */
  async editOps(path: string, ops: EditOp[], opts: { ifMatch?: string; dryRun?: boolean }): Promise<{ etag: string } | EditPreview> {
    if (!Array.isArray(ops)) throw new RequestError(400, 'invalid', 'ops must be a list of operations')
    if (this.access.isAgent && !opts.ifMatch && ops.some((o) => SUBSTITUTIONS.includes((o as { op?: string })?.op ?? ''))) {
      throw new RequestError(428, 'precondition_required', 'a substitution needs the ETag of the text it was planned on (If-Match or ifMatch)')
    }
    if (!opts.dryRun) return this.edit(path, (t) => planEdits(t, ops), opts)
    try {
      await this.edit(path, (t) => {
        const splices = planEdits(t, ops)
        let cur = t
        const changes: EditPreview['changes'] = []
        for (const s of splices) {
          changes.push({ at: s.at, removed: cur.slice(s.at, s.at + s.remove), inserted: s.insert })
          cur = cur.slice(0, s.at) + s.insert + cur.slice(s.at + s.remove)
        }
        throw new DryRun({ dryRun: true, etag: contentHash(t), changes })
      }, opts)
    } catch (err) {
      if (err instanceof DryRun) return err.preview
      throw err
    }
    throw new Error('unreachable: a dry run always ends in its preview')
  }

  /** To the trash. */
  async delete(path: string, opts: { ifMatch?: string }) {
    const p = this.writable(path)
    if (this.access.isAgent) this.visible(p)
    return this.guardAsync(p, () => this.deps.notes.delete(p, { ifMatch: opts.ifMatch, actor: this.access.actor }))
  }

  /**
   * Moves or renames a note (links kept, D-018). An agent moves only a note
   * it can write to a path it can write; the report never names a note it
   * can't see (`hidden`: there are some).
   */
  async move(from: string, to: string, opts: { ifMatch?: string; dryRun?: boolean } & MoveHooks): Promise<ScopedMoveReport> {
    const f = this.writable(from)
    if (this.access.isAgent) this.visible(f)
    const t = this.writable(to)
    const report = await this.guardAsync(f, () => this.deps.notes.move(f, t, { ...opts, actor: this.access.actor }))
    return this.access.isAgent ? this.maskReport(report) : report
  }

  private maskReport(report: MoveReport): ScopedMoveReport {
    let hidden = false
    const sees = (p: string) => p === report.to || p === report.from || this.access.canRead(p)
    const keep = <T>(list: T[], path: (x: T) => string) => list.filter((x) => (sees(path(x)) ? true : ((hidden = true), false)))
    const stateOk = (s: LinkState) => s.status === 'resolved' ? sees(s.path) : s.status === 'ambiguous' ? s.candidates.every(sees) : true
    const shifted = keep(report.shifted, (g) => g.path).flatMap((g) => {
      const changes = keep(g.changes, (c) => (stateOk(c.before) && stateOk(c.after) ? g.path : ''))
      return changes.length ? [{ ...g, links: changes.length, changes }] : []
    })
    const inReach = (p: string) => this.access.inScope(p)
    return {
      ...report,
      relinked: keep(report.relinked, (r) => r.path),
      shifted,
      kept: keep(report.kept, (k) => k.path),
      failed: keep(report.failed, (x) => x.path),
      images: {
        moved: report.images.moved.filter((m) => inReach(m.from) && inReach(m.to)),
        stayed: report.images.stayed.filter((s) => inReach(s.path)),
        folder: report.images.folder,
        failed: report.images.failed.filter((x) => inReach(x.path)),
      },
      hidden,
    }
  }

  /**
   * Stores an image for a note it can write (D-028). An agent can't put one
   * outside its key's folders (the attachments folder of thoth.yaml may be).
   */
  async attach(note: string, bytes: Uint8Array) {
    const p = this.writable(note)
    if (this.access.isAgent) {
      this.visible(p)
      const probe = attachmentPath(p, 'png', this.deps.now(), 1, this.deps.attachments())
      if (!this.access.canWrite(probe)) throw new AccessError(`images for ${p} go outside this key's folders`)
    }
    return this.guardAsync(p, () => this.deps.notes.attach(p, bytes, this.access.actor))
  }

  /**
   * Undoes what version `id` of a note changed (history/revert.ts), as the
   * principal: on a note it can read and write now (for an agent, by its
   * text too; a note deleted since can't be reverted, it has no text), and
   * only a version `reader` shows it (`historyFor`).
   */
  async revert(history: { reader: HistoryReader; recorder: Pick<Recorder, 'operation'> }, path: string, id: string, opts: { ifMatch?: string; dryRun?: boolean }): Promise<RevertReport> {
    const p = this.writable(path)
    if (this.access.isAgent) this.visible(p)
    return this.guardAsync(p, () => revertVersion({ reader: history.reader, notes: this.deps.notes, recorder: history.recorder }, p, id, { actor: this.access.actor, ...opts }))
  }

  // --- The daily note (D-030) --------------------------------------------------

  /**
   * Where the user's note for today is and whether it exists. An agent gets
   * `not_found` for one it can't see, without its path (thoth.yaml made it,
   * not the agent).
   */
  dailyToday(series?: string | null) {
    const r = this.deps.daily.today(this.access.user, series)
    if (this.access.isAgent) {
      this.unnamed(() => {
        this.access.assertRead(r.path)
        if (r.exists) this.visible(r.path)
      })
    }
    return r
  }

  /** Today's note: opened if it exists, created (from the series template) if not, as the principal. */
  async dailyOpen(series?: string | null) {
    const user = this.access.user
    if (this.access.isAgent) {
      const today = this.deps.daily.today(user, series)
      this.unnamed(() => {
        this.access.assertWrite(today.path)
        if (today.exists) this.visible(today.path)
      })
    }
    return this.deps.daily.open(user, series, {
      actor: this.access.actor,
      template: (t) => !this.access.isAgent || (this.access.canRead(t) && this.readable(t)),
    })
  }

  /** Runs a check about a path the principal didn't name: a `not_found` doesn't name it either. */
  private unnamed(fn: () => void) {
    try {
      fn()
    } catch (err) {
      if (err instanceof NoteError && err.code === 'not_found') throw new NoteError('not_found', 'does not exist')
      throw err
    }
  }

  /** Whether the principal may read the note, by the index and by its text now. */
  private readable(path: string): boolean {
    try { this.visible(path); return true } catch { return false }
  }
}

/**
 * A link as written: `[[Note#Heading|text]]`, `![[…]]`, `[text](path.md#h)`,
 * or a bare target (`Note#Heading`), taken as a wikilink. Null if it's none.
 */
function parseLink(link: string): Pick<LinkRef, 'kind' | 'target' | 'anchor'> | null {
  const s = typeof link === 'string' ? link.trim() : ''
  if (!s) return null
  if (/^!?\[\[[\s\S]*\]\]$|^\[[\s\S]*\]\([\s\S]*\)$/.test(s)) {
    const l = extract(s).links[0]
    return l ? { kind: l.kind, target: l.target, anchor: l.anchor } : null
  }
  const bare = s.split('|')[0]!
  const hash = bare.indexOf('#')
  const target = (hash === -1 ? bare : bare.slice(0, hash)).trim()
  const anchor = hash === -1 ? null : bare.slice(hash + 1).trim() || null
  return { kind: 'wiki', target, anchor }
}

function unknownLink(l: { raw: string; kind: string; target: string; anchor: string | null; pos_from: number }): OutgoingLink {
  return { raw: l.raw, kind: l.kind, target: l.target, anchor: l.anchor, status: null, dst_path: null, anchor_ok: null, candidates: null, pos_from: l.pos_from }
}

/** `a/b/c.md` → `a`, `a/b`. */
function ancestors(path: string): string[] {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

/** Text fragment around a link, to show backlinks with context. Without comments: they're not the note's text. */
function context(text: string, comments: Range[], from: number, to: number, radius = 80) {
  const start = Math.max(0, text.lastIndexOf('\n', from - 1) + 1, from - radius)
  const nl = text.indexOf('\n', to)
  const end = Math.min(text.length, nl === -1 ? text.length : nl, to + radius)
  return withoutRanges(text, comments, start, end).trim()
}

