// What a principal can do with the notes, through the access filter
// (access.ts): the operations the HTTP API offers (and the MCP server),
// each one reading and writing through the note service as that principal.
// A person sees what the folders' permissions give them (D-038); an agent
// only what its user sees and its key allows. Nothing a principal can't see
// leaks through a list, a count, a link, a preview or an error: it doesn't
// exist (`not_found`), or, when an agent names a note that exists,
// `agent_denied` (access.ts). A write that leaves the note hidden from the
// agent that made it succeeds and says so (`nowHidden`); nothing of the note
// reaches it after that.
import { RuleSet, anchorChanged, classifyPath, contentHash, extract, folderOf, parentFolder, parseThreads, withoutRanges, type AttachmentsConfig, type ErrorCode, type Level, type LinkIndex, type LinkRef, type Range } from '@vihko/core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AccessError, AgentDenied, type Access, type DenyReason } from './access.ts'
import { attachmentPath } from './attachments.ts'
import { isPlainFile } from './fsutil.ts'
import type { Db } from './db.ts'
import type { DailyNotes } from './daily.ts'
import { MAX_EDIT_OPS, planEdits, type EditOp } from './edits.ts'
import { CommentError, commentSplices, type CommentOp } from './commenting.ts'
import { HIGHLIGHT_END, HIGHLIGHT_START, search, type SearchResult } from './http/search.ts'
import { FolderNotEmpty, NoteError, NoteService, type FolderContents, type FolderMoveReport, type MoveHooks, type MoveReport, type NoteRead, type TrashEntry, type TrashRestoreReport } from './notes.ts'
import { audienceChange, ruleMove, type AudienceChange } from './audience.ts'
import type { ExternalMoves, PendingExternalMove } from './externalMoves.ts'
import type { Orphans } from './http/app.ts'
import type { KeyWithUser } from './keys.ts'
import type { PermissionsEngine } from './permissions.ts'
import type { PermissionsFile } from './permissionsFile.ts'
import type { Profiles } from './profiles.ts'
import type { LinkState } from './relink.ts'
import { createFromTemplate } from './templates.ts'
import type { HistoryReader } from './history/reader.ts'
import type { Recorder } from './history/recorder.ts'
import { revertVersion, type RevertReport } from './history/revert.ts'

export { HIGHLIGHT_END, HIGHLIGHT_START }

export interface ScopedDeps {
  notes: NoteService
  /** The rules of vihko.yaml, for what moves with a folder and the audience of a move. */
  permissions?: PermissionsEngine
  /** vihko.yaml's permissions, rewritten when a folder moves or is deleted from vihko. */
  permissionsFile?: PermissionsFile
  /** Every key, for how many gain or lose access with a move. */
  keys?: () => KeyWithUser[]
  /** Notes deleted from outside with an open copy (the collaboration hub). */
  orphans?: Orphans
  /** Notes moved outside vihko, pending a link update. */
  externalMoves?: ExternalMoves
  log?: (msg: string) => void
  index: Db
  notesDir: string
  daily: DailyNotes
  profiles: Profiles
  /** Where new images go (vihko.yaml), to know whether an agent may put one there. */
  attachments: () => AttachmentsConfig
  now: () => Date
  /** How links resolve over every indexed note (the indexer's), for `resolveLink`. */
  links?: () => LinkIndex
  /** After a folder moved from vihko: what state.db and the trash keep by its path follows it (folderRefs.ts). */
  onFolderMoved?: (from: string, to: string) => void
}

/**
 * What a folder holds, as `not_empty` tells whoever tried to delete it
 * (scoped `contentsView`): paths relative to the folder, each list capped at
 * FOLDER_LIST_CAP; `kept` blocks it (vihko never touches those), and so does
 * `locked`, how many things in it the person can't edit.
 */
export interface FolderContentsView {
  notes: { total: number; paths: string[] }
  files: { total: number; paths: string[] }
  kept: { total: number; paths: string[] }
  locked: number
}

/** How many paths of each kind a folder's contents name. */
export const FOLDER_LIST_CAP = 20

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

/**
 * An outgoing link as the API gives it. For an agent, `no_access`: it leads
 * to a note that exists but is hidden from it (or every candidate of an
 * ambiguous one is), without saying which; an ambiguous one keeps the
 * candidates it can see, with `othersNoAccess` if there are others.
 * `dstPath`: the note it leads to; `anchorOk`: 1 if its `#heading` is
 * there, 0 if not, null without one; `posFrom`: where it starts in the note.
 */
export interface OutgoingLink {
  raw: string
  kind: string
  target: string
  anchor: string | null
  status: 'resolved' | 'ambiguous' | 'missing' | 'no_access'
  dstPath: string | null
  anchorOk: number | null
  candidates: string[] | null
  posFrom: number
  othersNoAccess?: boolean
  /** `no_access`: why, when every note it may lead to is hidden for the same reason. */
  reason?: DenyReason
  /**
   * It leads to the note it is written in (`[[#Heading]]`, or its own name).
   * Kept for the editor, which shows every link's state; lists of links
   * between notes leave it out (see `links`).
   */
  self?: true
}

/**
 * A write by an agent that left the note hidden from it: `ai: false` (or a
 * frontmatter that can't be read) in what it wrote, or, in principle, a path
 * out of its key's folders. The write stands; from then on the note is like
 * any other hidden one (`agent_denied` when named, absent from every list),
 * and only a person can make it visible again (D-035).
 */
export interface NowHidden { reason: DenyReason; message: string }

/** What an agent is told when its own write hides the note from it. */
export function nowHiddenMessage(reason: DenyReason): string {
  const why = reason === 'ai_false'
    ? 'it is now marked as hidden from agents (`ai: false`, or a frontmatter that can\'t be read)'
    : 'it is now outside the folders of this key'
  return `The change was written. The note is no longer available to agents: ${why}. `
    + 'From now on you can\'t read or change it, and an agent can\'t undo this: only a person can, from vihko\'s interface. '
    + 'Don\'t write it again or create a note to replace it, and leave the links to it as they are.'
}

/** What an edit by operations would do (`dryRun`): each change on the note as it is now, in order. */
export interface EditPreview {
  dryRun: true
  etag: string
  changes: { at: number; removed: string; inserted: string }[]
}

/**
 * A move report as an agent gets it: `hidden` says there are links in notes
 * it can't see, never which or how many (D-018); `nowHidden`, that the note
 * moved is hidden from it at its new path (then without its ETag).
 */
export type ScopedMoveReport = MoveReport & { hidden?: boolean; nowHidden?: NowHidden; audience?: AudienceChange }

/** What `maskReport` filters: the parts of the reports of note moves, folder moves and link updates after external moves. */
interface MaskableReport {
  relinked: MoveReport['relinked']
  shifted: MoveReport['shifted']
  failed: MoveReport['failed']
  from?: string
  to?: string
  kept?: MoveReport['kept']
  images?: MoveReport['images']
  notes?: { from: string; to: string }[]
  moves?: { from: string; to: string }[]
}

/**
 * What a write answers besides its own data: the note's ETag after it, and
 * `nowHidden` if it left the note hidden from the agent that wrote it. Then
 * the ETag only when it is the hash of a text the agent had whole (it wrote
 * all of it, or planned its change on it with an ETag), which tells it
 * nothing it didn't know.
 */
export interface Written { etag?: string; nowHidden?: NowHidden }

/** A revert's report (history/revert.ts) with what its write left (`Written`). */
export type ScopedRevertReport = Omit<RevertReport, 'etag'> & Written

/** For an agent, what refuses a text of the note hidden from it (`agent_denied`); nothing for a user. */
export function agentGuard(access: Access, path: string): ((text: string) => void) | undefined {
  if (!access.isAgent) return undefined
  return (text) => { if (access.hides(text)) throw new AgentDenied(access.reasonFor(path)) }
}

/** A revert's report, with `nowHidden` (and its ETag only if known) when the note it changed is hidden now. */
export function revertWritten(r: RevertReport, written: () => Written): ScopedRevertReport {
  if (!r.changed) return r
  const w = written()
  if (!w.nowHidden) return r
  const out: ScopedRevertReport = { ...r, nowHidden: w.nowHidden }
  if (w.etag === undefined) delete out.etag
  return out
}

/**
 * After a write as `access`: whether the note at `path` is now hidden from
 * it, judged as a read would be (by the index, and by its text now). Null for
 * a user, while it still sees it, or if the note is gone.
 */
export function hiddenAfterWrite(access: Access, notes: Pick<NoteService, 'readCurrent'>, path: string): NowHidden | null {
  if (!access.isAgent) return null
  let reason: DenyReason
  try {
    access.assertRead(path)
    if (!access.hides(notes.readCurrent(path).text)) return null
    reason = access.reasonFor(path)
  } catch (err) {
    if (!(err instanceof AgentDenied)) return null
    reason = err.reason
  }
  return { reason, message: nowHiddenMessage(reason) }
}

/** What the index knows of a note, as `read` gives it. */
export interface NoteMeta { title: string; uid: string | null; fmError: string | null }

/**
 * Where a link leads, written in a note (`resolveLink`), as in `links`.
 * `no_access`: to a note that exists but is hidden from the principal, with
 * `reason` when it is one note. `anchorOk`: whether the heading after `#`
 * is in the note it leads to (null without one).
 */
export interface ResolvedLink {
  kind: LinkRef['kind']
  target: string
  anchor: string | null
  status: 'resolved' | 'ambiguous' | 'missing' | 'no_access'
  path: string | null
  anchorOk: boolean | null
  candidates: string[] | null
  othersNoAccess: boolean
  reason: DenyReason | null
  /** Titles of `path` and the candidates. */
  titles: Record<string, string>
}

/**
 * An agent's move would open the note to someone who can't see it now
 * (D-040 3.2): it goes through only when asked again with the audience
 * confirmed (`confirmAudience`, which the agent asks the person for first).
 * The change carries users' and groups' names (everyone sees them) and how
 * many keys, never whose.
 */
export class AudienceWidens extends Error {
  readonly code = 'audience_widens'
  readonly audience: AudienceChange
  constructor(audience: AudienceChange) {
    super('this move opens the note to people, groups or keys who can\'t see it now: ask the person you act for, and move it again with the audience confirmed if they agree')
    this.audience = audience
  }
}

/** Whether a change of audience gives access to anyone (a person, a group or a key) who doesn't have it. */
export function widens(a: AudienceChange): boolean {
  return a.users.gain.length > 0 || a.groups.gain.length > 0 || a.keys.gain > 0
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

/**
 * The operations of an edit as a request gave them, checked before anything
 * is read: a list of 1 to `MAX_EDIT_OPS`, each a known `op` with the fields
 * it needs, of their types, and never the `uid` (the note's identity). Any
 * of that wrong is `400 invalid`, for the HTTP API and the MCP server alike;
 * what depends on the note's text (a heading or text not found, an empty
 * `find`) is `edit_mismatch` when it is applied (edits.ts).
 */
export function checkEditOps(ops: unknown): EditOp[] {
  if (!Array.isArray(ops)) throw new RequestError(400, 'invalid', 'ops must be a list of operations')
  if (ops.length === 0 || ops.length > MAX_EDIT_OPS) throw new RequestError(400, 'invalid', `an edit has 1 to ${MAX_EDIT_OPS} operations, not ${ops.length}`)
  const scalar = (v: unknown) => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
  return ops.map((o: unknown, i): EditOp => {
    const bad = (why: string): never => { throw new RequestError(400, 'invalid', `operation ${i}: ${why}`) }
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return bad('not an operation')
    const e = o as Record<string, unknown>
    const text = (k: string) => { if (typeof e[k] !== 'string') bad(`${String(e.op)} needs ${k}, as text`); return e[k] as string }
    switch (e.op) {
      case 'find_replace': {
        const expectedCount = e.expectedCount
        if (expectedCount !== undefined && !(Number.isInteger(expectedCount) && (expectedCount as number) >= 1)) bad('expectedCount must be a whole number from 1')
        return { op: 'find_replace', find: text('find'), replace: text('replace'), ...(expectedCount !== undefined ? { expectedCount: expectedCount as number } : {}) }
      }
      case 'append':
        return { op: 'append', text: text('text') }
      case 'append_under_heading':
      case 'replace_section':
        return { op: e.op, heading: text('heading'), text: text('text') }
      case 'set_frontmatter': {
        const key = text('key')
        if (key.trim() === 'uid') bad('the uid is the note\'s identity: it can\'t be changed')
        const value = e.value
        if (!(scalar(value) || (Array.isArray(value) && value.every(scalar)))) bad('set_frontmatter needs value: text, a number, true/false or a list of them')
        return { op: 'set_frontmatter', key, value: value as Extract<EditOp, { op: 'set_frontmatter' }>['value'] }
      }
      default:
        return bad(`unknown op ${JSON.stringify(e.op)}: find_replace, append, append_under_heading, replace_section or set_frontmatter`)
    }
  })
}

export class ScopedNotes {
  private deps: ScopedDeps
  readonly access: Access

  constructor(deps: ScopedDeps, access: Access) {
    this.deps = deps
    this.access = access
  }

  /**
   * The note, if the principal may read it; otherwise `agent_denied` if it
   * exists but is hidden from it, `not_found` if it doesn't exist. An open
   * note as its editors have it now: its ETag is the one a write is checked
   * against (notes.ts `readCurrent`).
   */
  private visible(path: string): NoteRead {
    const p = NoteService.checkPath(path)
    this.access.assertRead(p)
    const r = this.deps.notes.readCurrent(p)
    if (this.access.hides(r.text)) throw new AgentDenied(this.access.reasonFor(p))
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
    if (!(err instanceof NoteError) || this.readable(path)) return err
    // A note there that it can't read (not indexed yet): an agent named it, so it's told, and nothing else; a person, that it doesn't exist.
    if (err.code === 'exists') return this.access.isAgent ? new AgentDenied(this.access.reasonFor(path)) : new NoteError('not_found', `does not exist: ${path}`)
    return err.etag ? new NoteError(err.code, err.message) : err
  }

  /** A write's answer (`Written`): `known`, whether the agent had the whole text that `etag` is the hash of. */
  private written(path: string, etag: string, known: boolean): Written {
    const nowHidden = hiddenAfterWrite(this.access, this.deps.notes, path)
    if (!nowHidden) return { etag }
    return known ? { etag, nowHidden } : { nowHidden }
  }

  /** A write the principal may make: `not_found` for what it can't see, `forbidden` for a read-only key. */
  private writable(path: string): string {
    const p = NoteService.checkPath(path)
    this.access.assertWrite(p)
    return p
  }

  // --- Reading ----------------------------------------------------------------

  /**
   * The note, with what the index knows of it and whether its text hides it
   * from agents (`hiddenFromAgents`, access.ts: null for any note an agent
   * reads, since it can't read the others). For a person, their `level`
   * where it is (D-038.5): the editor is read-only below `edit`. `meta`: its
   * title, uid and why its frontmatter can't be read (`fmError`), or null
   * while the index doesn't have it.
   */
  read(path: string): NoteRead & { meta: NoteMeta | null; hiddenFromAgents: 'ai' | 'frontmatter' | null; level?: Level } {
    const r = this.visible(path)
    const meta = (this.deps.index.prepare('select title, uid, fm_error as fmError from notes where path = ?').get(r.path) as NoteMeta | undefined) ?? null
    const level = this.access.isAgent ? undefined : this.access.level(folderOf(r.path)) ?? 'read'
    return { ...r, meta, hiddenFromAgents: this.access.agentHiding(r.text), ...(level ? { level } : {}) }
  }

  /**
   * The path of the note with this `uid` (D-015), if the principal may read
   * it: `agent_denied` if it's hidden from it (without its path), `not_found`
   * if there's none.
   */
  pathOfUid(uid: string): string {
    const r = this.deps.index.prepare('select path from notes where uid = ? order by path limit 1').get(uid) as { path: string } | undefined
    if (!r) throw new NoteError('not_found', 'there is no note with that uid')
    return this.visible(r.path).path
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
   * titles of an ambiguous link's candidates. A link to a note the
   * principal can't read is `no_access` (the note isn't named, D-024); an
   * ambiguous one keeps the candidates it can see, with `othersNoAccess`
   * if there are others, and is `no_access` if it can see none. Backlinks
   * from notes it can't see aren't there at all.
   *
   * A link from a note to itself (`[[#Heading]]`, or its own name) is not a
   * link between notes: it is never a backlink, and among the outgoing ones
   * it is marked `self` (the editor still shows its state), so lists leave it
   * out on both sides (the UI's panel, the MCP tools).
   */
  links(path: string): { outgoing: OutgoingLink[]; backlinks: { path: string; title: string; raw: string; context: string }[]; titles: Record<string, string> } {
    const { path: p } = this.visible(path)
    const { index, notesDir } = this.deps
    const outgoing = index.prepare(`select raw, kind, target, anchor, status, dst_path as dstPath, anchor_ok as anchorOk, candidates, pos_from as posFrom
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
        try { text = readFileSync(NoteService.fileIn(notesDir, l.src_path), 'utf8') } catch {}
        sources.set(l.src_path, (src = { text, comments: extract(text).comments }))
      }
      // Its text says more than the index: a note hidden since it was indexed isn't a source.
      if (this.access.hides(src.text)) return []
      return [{ path: l.src_path, title: l.title, raw: l.raw, context: context(src.text, src.comments, l.pos_from, l.pos_to) }]
    })
    const titles: Record<string, string> = {}
    const titleOf = index.prepare('select title from notes where path = ?')
    const out = outgoing.map((l): OutgoingLink => {
      const candidates = l.candidates ? JSON.parse(l.candidates) as string[] : null
      const row: OutgoingLink = { ...l, candidates, ...(l.status === 'resolved' && l.dstPath === p ? { self: true as const } : {}) }
      const link = this.maskedLink(row)
      for (const c of link.candidates ?? []) titles[c] ??= (titleOf.get(c) as { title: string } | undefined)?.title ?? c
      return link
    })
    return { outgoing: out, backlinks, titles }
  }

  /**
   * A link as the principal sees it (see `links`). For an agent, `no_access`
   * carries the reason when every note it may lead to is hidden for the same
   * one (the agent has the link, so it names them, as `resolveLink` does); a
   * person gets no reason (D-024).
   */
  private maskedLink(l: OutgoingLink): OutgoingLink {
    const reasonFor = (p: string) => (this.access.isAgent ? this.access.reasonFor(p) : null)
    if (l.dstPath !== null && !this.access.canRead(l.dstPath)) return noAccess(l, reasonFor(l.dstPath))
    if (!l.candidates) return l
    const visible = l.candidates.filter((c) => this.access.canRead(c))
    if (visible.length === 0) {
      const reasons = new Set(l.candidates.map(reasonFor))
      return noAccess(l, reasons.size === 1 ? [...reasons][0]! : null)
    }
    return visible.length === l.candidates.length ? l : { ...l, candidates: visible, othersNoAccess: true }
  }

  /**
   * Where `link` leads, written in `from`: `[[Note#Heading]]`, `[text](path.md)`
   * or a bare target (`Note#Heading`), by the same rules as `links`. A note
   * the principal can't read is `no_access` (for an agent, with its reason
   * when the link leads to that one note: it named it); never its path or
   * title.
   */
  resolveLink(from: string, link: string): ResolvedLink {
    const { path: src } = this.visible(from)
    const parsed = parseLink(link)
    if (!parsed) throw new RequestError(400, 'invalid', 'not a link')
    if (!this.deps.links) throw new Error('link resolution is not available')
    const r = this.deps.links().resolve(src, parsed)
    const row: OutgoingLink = {
      raw: link, kind: parsed.kind, target: parsed.target, anchor: parsed.anchor, posFrom: 0,
      status: r.status, dstPath: r.status === 'resolved' ? r.path : null,
      anchorOk: r.status === 'resolved' && r.anchor !== null ? (r.anchor === 'ok' ? 1 : 0) : null,
      candidates: r.status === 'ambiguous' ? r.candidates : null,
    }
    const shown = this.maskedLink(row)
    const reason = shown.status === 'no_access' ? shown.reason ?? null : null
    const titleOf = this.deps.index.prepare('select title from notes where path = ?')
    const titles: Record<string, string> = {}
    for (const p of [shown.dstPath, ...(shown.candidates ?? [])]) if (p) titles[p] = (titleOf.get(p) as { title: string } | undefined)?.title ?? p
    return {
      kind: parsed.kind, target: parsed.target, anchor: parsed.anchor, status: shown.status, path: shown.dstPath,
      anchorOk: shown.anchorOk === null ? null : shown.anchorOk === 1, candidates: shown.candidates,
      othersNoAccess: shown.othersNoAccess === true, reason, titles,
    }
  }

  /**
   * Notes and folders. A person sees a folder they can read, and the folders
   * above what they can read only as the way to it (`pathOnly`: listed in
   * `folders` too, but nothing in them is theirs). For an agent, only what
   * its key reaches, and not a folder that only holds notes hidden from it
   * (a folder with no notes at all, just created or emptied, still shows).
   */
  tree(): { notes: { path: string; title: string; uid: string | null; aliases: string[] }[]; folders: string[]; pathOnly: string[] } {
    const { index } = this.deps
    const w = this.access.notesWhere('n')
    const rows = index.prepare(`select path, title, uid, aliases from notes n where ${w.sql} order by path`).all(...w.params) as { path: string; title: string; uid: string | null; aliases: string }[]
    const all = (index.prepare('select path from folders order by path').all() as { path: string }[]).map((r) => r.path)
    const readable = new Set(all.filter((f) => this.access.level(f) !== null && this.access.folderInScope(f)))
    const shown = new Set(readable)
    for (const f of readable) for (const a of ancestors(f + '/x')) shown.add(a)
    for (const { path } of rows) for (const a of ancestors(path)) shown.add(a)
    let folders = all.filter((f) => shown.has(f))
    if (this.access.isAgent) {
      const holds = new Set<string>()
      const holdsVisible = new Set<string>()
      for (const { path } of index.prepare('select path from notes').all() as { path: string }[]) for (const a of ancestors(path)) holds.add(a)
      for (const { path } of rows) for (const a of ancestors(path)) holdsVisible.add(a)
      folders = folders.filter((f) => this.access.folderInScope(f) && (!holds.has(f) || holdsVisible.has(f)))
    }
    return { notes: rows.map((r) => ({ ...r, aliases: JSON.parse(r.aliases) as string[] })), folders, pathOnly: folders.filter((f) => !readable.has(f)) }
  }

  /**
   * Tags in use, most used first. `count`: the notes that carry the tag;
   * `total`: those that carry it or one nested under it. Only notes the
   * principal can read count.
   */
  tags(): { tag: string; count: number; total: number }[] {
    const { index } = this.deps
    const w = this.access.notesWhere('n')
    const join = `join notes n on n.path = t.path where ${w.sql}`
    const params = w.params
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
   * overwrites. The template must be one the principal can read. If what an
   * agent created is hidden from it (`ai: false` in its text), `nowHidden`.
   */
  async create(path: string, opts: { text?: string; template?: string; freshUid?: boolean }): Promise<{ path: string; uid: string | null } & Written> {
    const p = this.writable(path)
    const actor = this.access.actor
    let r: { path: string; etag: string; uid: string | null }
    if (opts.template !== undefined) {
      this.unnamed(() => this.visible(opts.template!))
      const user = this.access.user
      r = await this.guardAsync(p, () => createFromTemplate(this.deps.notes, { path: p, template: opts.template!, user, now: this.deps.profiles.now(user.id, this.deps.now()), actor }))
    } else {
      r = await this.guardAsync(p, () => this.deps.notes.create(p, opts.text ?? '', actor, { freshUid: opts.freshUid === true }))
    }
    // Its own text (and the uid it is told) is known to it; a template's filling isn't.
    return { path: r.path, uid: r.uid, ...this.written(r.path, r.etag, opts.template === undefined) }
  }

  /**
   * Replaces the whole text. With `ifMatch`, only over that ETag; with
   * `ifNoneMatch: '*'`, only if the note doesn't exist (412 if it does).
   */
  async write(path: string, text: string, opts: { ifMatch?: string; ifNoneMatch?: string }): Promise<{ created: boolean } & Written> {
    const p = this.writable(path)
    if (opts.ifNoneMatch === '*') {
      try {
        const r = await this.guardAsync(p, () => this.deps.notes.create(p, text, this.access.actor))
        return { created: true, ...this.written(p, r.etag, true) }
      } catch (err) {
        if (err instanceof NoteError && err.code === 'exists') throw new NoteError('precondition_failed', `already exists: ${p}`, err.etag)
        throw err
      }
    }
    if (!opts.ifMatch) throw new RequestError(428, 'precondition_required', "missing If-Match: a note that hasn't been read won't be overwritten")
    const r = await this.edit(p, () => text, { ifMatch: opts.ifMatch })
    return { created: false, ...this.written(p, r.etag, true) }
  }

  /** Applies `fn` to the current text as the principal; an agent never edits a note it can't see. */
  private edit(path: string, fn: (text: string) => string | ReturnType<typeof planEdits>, opts: { ifMatch?: string }) {
    const p = this.writable(path)
    return this.guardAsync(p, () => this.deps.notes.edit(p, (t) => {
      if (this.access.hides(t)) throw new AgentDenied(this.access.reasonFor(p))
      return fn(t)
    }, { ifMatch: opts.ifMatch, actor: this.access.actor }))
  }

  /**
   * Edits by operation (edits.ts), atomic on the current text, even with the
   * note open. An agent must give `ifMatch` for substitutions (D-017).
   * `dryRun`: what it would change, without writing. An edit that hides the
   * note from the agent that makes it (`set_frontmatter ai false`) stands,
   * with `nowHidden`.
   */
  async editOps(path: string, given: unknown, opts: { ifMatch?: string; dryRun?: boolean }): Promise<Written | EditPreview> {
    const ops = checkEditOps(given)
    if (this.access.isAgent && !opts.ifMatch && ops.some((o) => SUBSTITUTIONS.includes(o.op))) {
      throw new RequestError(428, 'precondition_required', 'a substitution needs the ETag of the text it was planned on (If-Match or ifMatch)')
    }
    if (!opts.dryRun) {
      const r = await this.edit(path, (t) => planEdits(t, ops), opts)
      // Planned on an ETag, the text it changed was the one it had read; appends alone may land on a text it hasn't seen.
      return this.written(NoteService.checkPath(path), r.etag, opts.ifMatch !== undefined)
    }
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

  /**
   * A comment (commenting.ts), for someone with `comment` or more where the
   * note is: a new thread, a reply, or resolving a thread they started and
   * nobody else replied to (with `edit`, anyone's). One exact operation through the note service, as the
   * person: on the open document if someone is editing the note, on the
   * file otherwise. Only people: an agent comments by editing (D-038.5).
   */
  async comment(path: string, op: CommentOp): Promise<{ etag: string }> {
    const p = NoteService.checkPath(path)
    this.visible(p)
    if (this.access.isAgent || !this.access.canComment(p)) throw new AccessError('no permission to comment here')
    const resolveAny = this.access.canWrite(p)
    const author = this.access.user.username
    try {
      // A comment refused throws from inside the edit: nothing is written (not even a uid).
      return await this.guardAsync(p, () => this.deps.notes.edit(p, (t) => commentSplices(t, op, author, this.deps.now(), { resolveAny }), { actor: this.access.actor }))
    } catch (err) {
      if (!(err instanceof CommentError)) throw err
      if (err.code === 'not_own') throw new AccessError(err.message)
      if (err.code === 'moved') throw new NoteError('precondition_failed', err.message)
      throw new RequestError(400, 'invalid', err.message)
    }
  }

  /** To the trash. */
  async delete(path: string, opts: { ifMatch?: string }) {
    const p = this.writable(path)
    this.visible(p)
    // Its images go with it only where the principal may write (an agent: within its key's folders).
    return this.guardAsync(p, () => this.deps.notes.delete(p, { ifMatch: opts.ifMatch, actor: this.access.actor, canWrite: (f) => this.access.canWrite(f) }))
  }

  /**
   * Moves or renames a note (links kept, D-018): only a note it can write
   * (`edit` in its folder) to a path it can write. The report never names a
   * note it can't see (`hidden`: there are some, never which or how many);
   * the rewrites still reach them, as the system. A dry run says whose
   * access changes (`audience`, D-038), for the UI to confirm, and for an
   * agent too. An agent's move that opens the note to anyone who can't see
   * it now needs `confirmAudience` (D-040 3.2: the person agreed), or it is
   * refused with the change (`AudienceWidens`); one that only narrows it
   * doesn't.
   */
  async move(from: string, to: string, opts: { ifMatch?: string; dryRun?: boolean; confirmAudience?: boolean } & MoveHooks): Promise<ScopedMoveReport> {
    const f = this.writable(from)
    this.visible(f)
    const t = this.writable(to)
    const audience = this.deps.permissions && this.deps.keys && (opts.dryRun || this.access.isAgent)
      ? audienceChange(this.deps.permissions, this.deps.keys(), [{ before: f, after: t }]) : undefined
    if (!opts.dryRun && this.access.isAgent && audience && widens(audience) && opts.confirmAudience !== true) throw new AudienceWidens(audience)
    const { confirmAudience: _, ...moveOpts } = opts
    const report = await this.guardAsync(f, () => this.deps.notes.move(f, t, { ...moveOpts, actor: this.access.actor }))
    const masked: ScopedMoveReport = this.maskReport(report)
    if (report.dryRun && audience) masked.audience = audience
    if (!this.access.isAgent) return masked
    if (report.dryRun || report.etag === null) return masked
    // Its folders only take it where it can see it, but whatever the reason: hidden now, no ETag (the move rewrote its text).
    const w = this.written(t, report.etag, false)
    return w.nowHidden ? { ...masked, etag: null, nowHidden: w.nowHidden } : masked
  }

  /**
   * A move's report (a note's, a folder's, or the links after moves made
   * outside vihko) with only what the principal can see (D-018): `hidden`
   * says something was left out, never what or how much. `back` gives a
   * path's name before the move (a folder move's notes are listed at their
   * new paths, and whether they're seen is judged where they were).
   */
  maskReport<T extends MaskableReport>(report: T, back: (p: string) => string = (p) => p): T & { hidden: boolean } {
    let hidden = false
    const moved = new Set([report.from, report.to].filter((p): p is string => typeof p === 'string'))
    const sees = (p: string) => moved.has(p) || this.access.canRead(back(p))
    const keep = <X>(list: X[], path: (x: X) => string) => list.filter((x) => (sees(path(x)) ? true : ((hidden = true), false)))
    const stateOk = (s: LinkState) => s.status === 'resolved' ? sees(s.path) : s.status === 'ambiguous' ? s.candidates.every(sees) : true
    const shifted = keep(report.shifted, (g) => g.path).flatMap((g) => {
      const changes = keep(g.changes, (c) => (stateOk(c.before) && stateOk(c.after) ? g.path : ''))
      return changes.length ? [{ ...g, links: changes.length, changes }] : []
    })
    // Images: an agent, those in its key's folders; a person, those in folders they can read.
    const inReach = (p: string) => (this.access.isAgent ? this.access.inScope(p) : this.access.canRead(back(p)))
    const out: T & { hidden: boolean } = {
      ...report,
      relinked: keep(report.relinked, (r) => r.path),
      shifted,
      failed: keep(report.failed, (x) => x.path),
      hidden,
    }
    if (report.kept) out.kept = keep(report.kept, (k) => k.path)
    if (report.images) {
      out.images = {
        moved: report.images.moved.filter((m) => inReach(m.from)),
        stayed: report.images.stayed.filter((x) => inReach(x.path)),
        folder: report.images.folder,
        failed: report.images.failed.filter((x) => inReach(x.path)),
      }
    }
    if (report.notes) out.notes = keep(report.notes, (n) => n.from)
    if (report.moves) out.moves = keep(report.moves, (m) => m.from).filter((m) => sees(m.to))
    out.hidden = hidden
    return out
  }

  /** The largest image `attach` stores, in bytes (VIHKO_MAX_IMAGE_MB). */
  get maxImageBytes(): number {
    return this.deps.notes.maxImageBytes
  }

  /**
   * Stores an image for a note it can write (D-028). An agent can't put one
   * outside its key's folders (the attachments folder of vihko.yaml may be).
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
  async revert(history: { reader: HistoryReader; recorder: Pick<Recorder, 'operation'> }, path: string, id: string, opts: { ifMatch?: string; dryRun?: boolean }): Promise<ScopedRevertReport> {
    const p = this.writable(path)
    if (this.access.isAgent) this.visible(p)
    const r = await this.guardAsync(p, () => revertVersion({ reader: history.reader, notes: this.deps.notes, recorder: history.recorder }, p, id, {
      actor: this.access.actor, ...opts, guard: agentGuard(this.access, p),
    }))
    return revertWritten(r, () => this.written(p, r.etag, opts.ifMatch !== undefined))
  }

  // --- The daily note (D-030) --------------------------------------------------

  /**
   * Where the user's note for today is and whether it exists. Asking for
   * today's note names it, as reading it by its path would: in a folder the
   * person can't read, `not_found` without its path (vihko.yaml made it, not
   * them). For an agent, if it exists but is hidden from it (`ai: false`, a
   * frontmatter that can't be read, outside the key's folders, or its user
   * can't see it), `agent_denied` with the reason (D-035, D-037), never its
   * path or anything of it; if it doesn't exist and falls where the agent
   * can't reach, `not_found`, without its path either.
   */
  dailyToday(series?: string | null) {
    const r = this.deps.daily.today(this.access.user, series)
    this.unnamed(() => {
      this.access.assertRead(r.path)
      if (r.exists) this.visible(r.path)
    })
    return r
  }

  /**
   * Today's note: opened if it exists, created (from the series template,
   * if the principal can read it) if not, as the principal. The same answers
   * as `dailyToday`, and `forbidden` where it can see but not write.
   */
  async dailyOpen(series?: string | null) {
    const user = this.access.user
    const today = this.deps.daily.today(user, series)
    this.unnamed(() => {
      if (today.exists) this.visible(today.path)
      else this.access.assertWrite(today.path)
    })
    return this.deps.daily.open(user, series, {
      actor: this.access.actor,
      template: (t) => this.access.canRead(t) && this.readable(t),
    })
  }

  // --- Folders (D-038.5) ---------------------------------------------------------
  // Creating one needs `edit` where it goes; renaming, moving or deleting
  // one, `manage` in it (and `edit` in its new parent). A folder the person
  // can't see doesn't exist for them; one they see but can't change this
  // way is `forbidden`. Its rules in vihko.yaml go with it.

  /** Unless the person has `need` in `folder`: `forbidden` if they see it, `not_found` if not. */
  private assertFolder(folder: string, need: 'edit' | 'manage') {
    const ok = need === 'manage' ? this.access.canManage(folder) : this.access.canWrite(folder === '' ? '_.md' : `${folder}/_.md`)
    if (ok) return
    if (this.access.level(folder) !== null) throw new AccessError(`no permission to ${need === 'manage' ? 'manage' : 'edit'} ${folder || 'the root'}`)
    throw new NoteError('not_found', `no such folder: ${folder}`)
  }

  /** A new, empty folder: `edit` where it goes. */
  createFolder(path: string): { path: string } {
    const p = NoteService.checkFolder(path)
    this.assertFolder(parentFolder(p) ?? '', 'edit')
    return this.deps.notes.createFolder(p, this.access.actor)
  }

  /**
   * Deletes a folder: `manage` in it. Its rules in vihko.yaml go too. Empty
   * (but for the system's clutter), it just goes; otherwise `not_empty` with
   * what it holds (`FolderContentsView`), unless `trash`: then its notes and
   * files go to the trash first (notes.ts `trashFolder`), provided the person
   * may edit every one of them and nothing in it is what vihko never touches.
   */
  async deleteFolder(path: string, opts: { trash?: boolean } = {}): Promise<{ path: string; trashed: TrashEntry[] }> {
    const p = NoteService.checkFolder(path)
    this.assertFolder(p, 'manage')
    const view = () => this.contentsView(p, this.deps.notes.folderContents(p))
    const now = view()
    const blocked = now.kept.total > 0 || now.locked > 0
    if (blocked || (!opts.trash && (now.notes.total > 0 || now.files.total > 0))) throw new FolderNotEmpty(p, now)
    const canWrite = (f: string) => this.access.canWrite(f)
    let r: { path: string; trashed: TrashEntry[] }
    try {
      r = opts.trash ? await this.deps.notes.trashFolder(p, this.access.actor, { canWrite }) : { ...this.deps.notes.deleteFolder(p, this.access.actor), trashed: [] }
    } catch (err) {
      // Something landed in it meanwhile: say what it holds now.
      if (err instanceof NoteError && err.code === 'not_empty' && !(err instanceof FolderNotEmpty)) {
        let latest: FolderContentsView | null = null
        try { latest = view() } catch { /* gone meanwhile */ }
        if (latest) throw new FolderNotEmpty(p, latest)
      }
      throw err
    }
    await this.deps.permissionsFile?.removeRules(p, { actor: this.access.actor })
      .catch((err) => this.deps.log?.(`permissions of the deleted folder ${p} stay in vihko.yaml: ${err instanceof Error ? err.message : String(err)}`))
    return r
  }

  /**
   * What a folder holds, as the person may be told: its notes, files and
   * what vihko never touches, each list capped (`total` says how many), with
   * paths relative to the folder; what they can't edit only as a count
   * (`locked`), never named.
   */
  private contentsView(folder: string, c: FolderContents): FolderContentsView {
    let locked = 0
    const theirs = (list: string[]) => {
      const mine = list.filter((rel) => this.access.canWrite(`${folder}/${rel.replace(/\/$/, '')}`) || (locked++, false))
      return { total: mine.length, paths: mine.slice(0, FOLDER_LIST_CAP) }
    }
    const notes = theirs(c.notes)
    const files = theirs(c.files)
    const kept = theirs(c.kept)
    return { notes, files, kept, locked }
  }

  /**
   * Moves or renames a folder with everything in it (notes.ts), and its
   * rules with it: `manage` in it and `edit` in its new parent. The rules
   * are first written at the new path too, then the folder moves, then the
   * old ones go: at no moment is what it holds left without its rules. If
   * the rules can't be written, the folder doesn't move; if the folder
   * can't move, the copies go. The report names only what the person can
   * see; a dry run says whose access changes (`audience`).
   */
  async moveFolder(from: string, to: string, opts: { dryRun?: boolean } & MoveHooks = {}): Promise<FolderMoveReport & { hidden: boolean; audience?: AudienceChange }> {
    const f = NoteService.checkFolder(from)
    const t = NoteService.checkFolder(to)
    this.assertFolder(f, 'manage')
    this.assertFolder(parentFolder(t) ?? '', 'edit')
    const actor = this.access.actor
    const back = (p: string) => (p === t || p.startsWith(t + '/') ? f + p.slice(t.length) : p)
    const engine = this.deps.permissions
    const under = (this.deps.index.prepare("select path from folders where path = ? or path like ? escape '\\'").all(f, likePrefix(f)) as { path: string }[]).map((r) => r.path)
    const plan = engine ? ruleMove(engine, f, t, under) : { extra: [], rules: null }
    // A personal folder inside it stays personal where it goes (D-040 3.5): taken out of its `{user}` rule, only
    // the literal copy of its grants would go with it, and whoever manages the folders above would reach it.
    // Only whoever manages it (its owner) may take it out, as they may move it themselves.
    const now = engine?.rules() ?? null
    if (now && plan.rules) {
      const then = new RuleSet(plan.rules)
      for (const d of under) {
        if (now.personal(d) && !then.personal(t + d.slice(f.length)) && !this.access.canManage(d)) {
          throw new AccessError('this move would take a personal folder in it out of its {user} rule: only whoever manages that folder may')
        }
      }
    }
    const mask = (r: FolderMoveReport) => {
      const { filePaths, ...rest } = r
      const masked = this.maskReport(rest, back)
      // Only the files in folders the person can read count.
      return { ...masked, files: (filePaths ?? []).filter((p) => this.access.canRead(p)).length }
    }
    if (opts.dryRun) {
      const r = mask(await this.deps.notes.moveFolder(f, t, { actor, dryRun: true }))
      if (!engine || !this.deps.keys) return r
      const pairs = [...r.notes.map((n) => ({ before: n.from, after: n.to })), ...under.map((d) => ({ before: `${d}/_`, after: `${t}${d.slice(f.length)}/_` }))]
      return { ...r, audience: audienceChange(engine, this.deps.keys(), pairs, plan.rules) }
    }
    const file = this.deps.permissionsFile
    const before = file?.read().text ?? null
    const copied = file ? (await file.moveRules(f, t, { actor, keepFrom: true, extra: plan.extra })).changed : false
    const afterCopy = copied ? file!.read().text : null
    let report: FolderMoveReport
    try {
      report = await this.deps.notes.moveFolder(f, t, { actor, ...opts })
    } catch (err) {
      // It didn't move: the copies go, unless someone changed the file meanwhile.
      if (copied) await file!.update((x) => (x === afterCopy ? before ?? '' : x), { actor }).catch(() => {})
      throw err
    }
    if (copied) {
      await file!.removeRules(f, { actor })
        .catch((err) => this.deps.log?.(`the old rules of ${f} stay in vihko.yaml after it moved to ${t}: ${err instanceof Error ? err.message : String(err)}`))
    }
    try {
      this.deps.onFolderMoved?.(f, t)
    } catch (err) {
      this.deps.log?.(`keys, pins or trash entries under ${f} still name it after it moved to ${t}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return mask(report)
  }

  // --- Other requests about notes -----------------------------------------------

  /**
   * Fixes where one ambiguous link leads (D-031.2), in a note it can write,
   * to a candidate it can see: one it can't is not a candidate for it.
   */
  async pinLink(path: string, link: { raw: string; at?: number }, target: string): Promise<{ etag: string; raw: string }> {
    const p = this.writable(path)
    this.visible(p)
    if (typeof target !== 'string' || !this.access.canRead(target)) throw new NoteError('edit_mismatch', `${link.raw} in ${p} has no such candidate`)
    return this.guardAsync(p, () => this.deps.notes.pinLink(p, link, target, { actor: this.access.actor }))
  }

  /** Stores an image fetched from a URL for a note it can write, like an upload: nothing is fetched for a note it can't. */
  async attachFromUrl(note: string, fetch: () => Promise<Uint8Array>) {
    const p = this.writable(note)
    this.visible(p)
    return this.attach(p, await fetch())
  }

  /**
   * The trash: what was deleted where the person would have `edit` now
   * (D-038): a note where they could edit it, files alone where they could
   * edit any of them; of an entry's files, only those.
   */
  trash(): TrashEntry[] {
    return this.deps.notes.trash().flatMap((e) => {
      const files = e.files?.filter((f) => this.access.canWrite(f.path))
      if (e.kind === 'files' ? !files?.length : !this.access.canWrite(e.path)) return []
      return [files ? { ...e, files } : e]
    })
  }

  /**
   * Restores from the trash: a note (to its path, or `to`) with its files, or
   * files alone, an entry it may see, to where it may write. Files it can't
   * write stay in the trash.
   */
  async restoreTrash(id: string, to?: string): Promise<TrashRestoreReport> {
    const entry = this.trash().find((e) => e.id === id)
    if (!entry) throw new NoteError('not_found', `not in the trash: ${id}`)
    const canWrite = (p: string) => this.access.canWrite(p)
    if (entry.kind === 'files') {
      if (to !== undefined && to !== entry.path) throw new RequestError(400, 'invalid', 'files alone go back where they were: no `to`')
      return this.deps.notes.restore(id, this.access.actor, undefined, { canWrite })
    }
    const dest = this.writable(to ?? entry.path)
    return this.guardAsync(dest, () => this.deps.notes.restore(id, this.access.actor, dest, { canWrite }))
  }

  /** A sync tool's conflict copy the indexer found, in a folder the person can read. */
  conflict(path: string): { path: string; text: string } {
    const known = classifyPath(path) === 'conflict' && this.access.canRead(path)
      && this.deps.index.prepare("select 1 from alerts where path = ? and kind = 'sync_conflict'").get(path)
    let text: string | null = null
    if (known && isPlainFile(this.deps.notesDir, path)) try { text = readFileSync(join(this.deps.notesDir, path), 'utf8') } catch { /* no longer exists */ }
    if (text === null) throw new NoteError('not_found', `there's no conflict copy at ${path}`)
    return { path, text }
  }

  /** Keeps or discards the copy of a note deleted from outside while it was open: `edit` where it was. */
  async orphan(path: string, action: 'restore' | 'discard'): Promise<{ etag: string } | { ok: true }> {
    const orphans = this.deps.orphans
    const p = NoteService.checkPath(path)
    if (!orphans || !orphans.orphans().includes(p) || !this.access.canWrite(p)) throw new NoteError('not_found', `no pending copy for ${p}`)
    if (action === 'restore') return orphans.restoreOrphan(p)
    await orphans.discardOrphan(p)
    return { ok: true }
  }

  /**
   * Notes moved outside vihko whose links are left behind (D-031.4), as the
   * person sees them: only moves they can see at both ends, and only the
   * links in notes they can read.
   */
  externalMoves(): PendingExternalMove[] {
    return this.deps.externalMoves?.pending((m) => this.access.canRead(m.to) && this.access.canRead(m.from), (p) => this.access.canRead(p)) ?? []
  }

  /**
   * Updates the links after notes moved outside vihko (D-031.4), as a vihko
   * move would, for the moves the person may make: `edit` where each note
   * was and is. The rewrites reach notes they can't see, as the system
   * (D-018); the report doesn't name them.
   */
  async relinkExternal(id: string, opts: { dryRun?: boolean } & MoveHooks = {}) {
    const ext = this.deps.externalMoves
    const group = ext?.get(id)
    const moves = group?.moves.filter((m) => this.access.canWrite(m.to) && this.access.canWrite(m.from)) ?? []
    if (!ext || !group || moves.length === 0) throw new NoteError('not_found', 'no such external move')
    const report = await this.deps.notes.relinkMoved(moves, { actor: this.access.actor, ...opts })
    // Done once every rewrite went through, for every move it had; with failures, or moves left, it stays.
    if (!opts.dryRun && report.failed.length === 0 && moves.length === group.moves.length) ext.drop(group.id)
    const back = new Map(report.moves.map((m) => [m.to, m.from]))
    return this.maskReport(report, (p) => back.get(p) ?? p)
  }

  /** Runs a check about a path the principal didn't write: a `not_found` doesn't name it (an `agent_denied` never does). */
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

/** A link to a note hidden from the principal: its own text and why (if one reason), nothing of where it leads. */
function noAccess(l: { raw: string; kind: string; target: string; anchor: string | null; posFrom: number }, reason: DenyReason | null): OutgoingLink {
  return { raw: l.raw, kind: l.kind, target: l.target, anchor: l.anchor, status: 'no_access', dstPath: null, anchorOk: null, candidates: null, posFrom: l.posFrom, ...(reason ? { reason } : {}) }
}

const likePrefix = (dir: string) => dir.replace(/[\\%_]/g, (c) => '\\' + c) + '/%'

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

