// The single point of access (D-014, D-035, D-038): who is asking (a
// principal) and what they may read and write. Everything a request or an
// agent reaches is asked here, as a path (`canRead`, `canComment`,
// `canWrite`, `canManage`) or, for lists read from the index, as a condition
// in the query itself (`notesWhere`), which runs the same function: counts,
// snippets and pages never see what the principal can't.
//
// - A user has, in each folder, the level the rules of vihko.yaml give them
//   (permissions.ts): read < comment < edit < manage. An image or any other
//   file has the permission of the folder it's in. Being an admin grants
//   nothing here (D-038.1): the admin reads only what is granted.
// - An agent (a key, D-035) sees what its user sees, limited to the key's
//   folders (none = all), and never a note with `ai: false`, in a folder
//   closed to agents (`ai: false` in vihko.yaml) or whose frontmatter can't
//   be read (the most restricted, D-014), nor an image such a note uses. It
//   writes only with a key that may and where its user has `edit`.
//
// What a principal can't read doesn't exist for it: callers answer
// `not_found`, never `forbidden`, and name nothing it can't see (D-030,
// D-024). A person who can see a note (or a folder) but not do something in
// it gets `forbidden`. And an agent that names a note its user can see but
// that is hidden from it gets an explicit denial, `agent_denied` with the
// reason (`ai_false`, `outside_key_folders`), so that it doesn't take it for
// a broken link and delete, redirect or duplicate it. The denial carries
// nothing of the note. Lists still never show it: the agent only learns it
// exists if it already has its name. A note its user can't see is, for the
// agent as for the user, one that doesn't exist (`not_found`, D-056.15):
// nobody learns what exists by naming paths or writing links.
import { WORKSPACE_FILE, atLeast, classifyPath, folderOf, readFrontmatter, type Level } from '@vihko/core'
import type { Actor, Via } from './actor.ts'
import type { User } from './auth.ts'
import type { Db } from './db.ts'
import { NoteError } from './notes.ts'
import type { PermissionsEngine, Viewer } from './permissions.ts'

/** What a key grants (keys.ts). `folders`: those it reaches, empty = all its user sees. */
export interface KeyGrant {
  id: string
  name: string
  canWrite: boolean
  folders: string[]
}

export interface UserPrincipal { kind: 'user'; user: User }
export interface AgentPrincipal { kind: 'agent'; user: User; key: KeyGrant; via: Via }
/** Who is asking: a signed-in user, or an agent acting for one. */
export type Principal = UserPrincipal | AgentPrincipal

/** The frontmatter key that hides a note from agents (`ai: false`), unless configured otherwise. */
export const DEFAULT_AI_KEY = 'ai'

/**
 * Whether a note is hidden from agents by its frontmatter: `ai` set to false
 * (also `no`, `off`, `"false"` or 0: any doubt restricts), or a frontmatter
 * that can't be read.
 */
export function hiddenFromAgents(fm: { data: Record<string, unknown>; error: string | null }, aiKey = DEFAULT_AI_KEY): boolean {
  if (fm.error) return true
  const v = fm.data[aiKey]
  if (v === false || v === 0) return true
  return typeof v === 'string' && /^(false|no|off|0)$/i.test(v.trim())
}

/** A request the principal may make in general but not here (never about a note it can't see: that doesn't exist for it). */
export class AccessError extends Error {
  readonly code = 'forbidden'
}

/**
 * Why a note an agent named isn't for it, when its user can see it: `ai:
 * false` (in the note, a frontmatter that can't be read, or its folder in
 * vihko.yaml), or out of its key's folders. (What its user can't see is
 * `not_found`, D-056.15.)
 */
export type DenyReason = 'ai_false' | 'outside_key_folders'

/**
 * An agent named a note that exists but is hidden from it (403
 * `agent_denied`). Only the reason: nothing of the note.
 */
export class AgentDenied extends Error {
  readonly code = 'agent_denied'
  readonly reason: DenyReason
  constructor(reason: DenyReason) {
    const why = reason === 'ai_false' ? 'it is marked as hidden from them'
      : 'it is outside the folders of this key'
    super(`This note exists but is not available to agents (${why}). `
      + 'Do not delete, rewrite or replace links to it, and do not create a note to replace it.')
    this.reason = reason
  }
}

/** Notes kept from everyone for now (permissionHolds.ts): they arrived from a folder with rules of its own. */
export interface Holds {
  held(path: string): boolean
}

export interface AccessPolicyOptions {
  /** index.db: the notes' frontmatter as last indexed, and which notes use each file. */
  index: Db
  /** The rules of vihko.yaml resolved against users and groups. */
  permissions: PermissionsEngine
  /** Notes nobody reads until someone decides (external moves out of a folder with its own rules). */
  holds?: Holds
  /** The frontmatter key that hides a note from agents (`ai`). */
  aiKey?: string
}

/** Name of the SQL function `notesWhere` uses: (path, fm_json, fm_error, access id) → 0/1. */
const SQL_FN = 'vihko_visible'
/** Accesses the SQL function can reach at once (one per request in flight, and some). */
const LIVE_ACCESSES = 1024

/**
 * Builds the access of each principal over one index. Registers in the index
 * the SQL function lists are filtered with, so queries and `canRead` share
 * one rule.
 */
export class AccessPolicy {
  readonly aiKey: string
  readonly permissions: PermissionsEngine
  readonly holds: Holds | null
  private index: Db
  private statements = new Map<string, Statement>()
  /** The accesses whose queries may be running, by id (the SQL function's last argument). */
  private live = new Map<number, Access>()
  private nextId = 1

  constructor(opts: AccessPolicyOptions) {
    this.index = opts.index
    this.permissions = opts.permissions
    this.holds = opts.holds ?? null
    this.aiKey = opts.aiKey ?? DEFAULT_AI_KEY
    this.index.function(SQL_FN, { deterministic: false }, (path: unknown, fmJson: unknown, fmError: unknown, id: unknown) => {
      // An access no longer known (never, in practice): nothing is visible.
      const a = typeof id === 'number' || typeof id === 'bigint' ? this.live.get(Number(id)) : undefined
      return a && a.rowVisible(String(path), fmJson, fmError) ? 1 : 0
    })
  }

  /** Prepared on first use: the index's extension tables may not exist yet when the policy is made. */
  private statement(sql: string): Statement {
    let st = this.statements.get(sql)
    if (!st) this.statements.set(sql, (st = this.index.prepare(sql)))
    return st
  }

  for(principal: Principal): Access {
    return new Access(this, principal)
  }

  /**
   * @internal The id an access's queries carry: the one it had while it's
   * still reachable (the last LIVE_ACCESSES that queried), a new one if not.
   */
  queryId(access: Access, id: number | null): number {
    if (id !== null && this.live.get(id) === access) return id
    const fresh = this.nextId++
    this.live.set(fresh, access)
    if (this.live.size > LIVE_ACCESSES) this.live.delete(this.live.keys().next().value!)
    return fresh
  }

  /** @internal Whether an indexed note is hidden from agents by its frontmatter. */
  hiddenRow(fmJson: unknown, fmError: unknown): boolean {
    if (fmError !== null && fmError !== undefined) return true
    let data: Record<string, unknown> = {}
    try { data = JSON.parse(String(fmJson ?? '{}')) as Record<string, unknown> } catch { return true }
    return hiddenFromAgents({ data, error: null }, this.aiKey)
  }

  /** @internal Whether the index hides a note from agents; false for one it doesn't know (its text decides, `Access.hides`). */
  hiddenIndexed(path: string): boolean {
    const r = this.statement('select fm_json, fm_error from notes where path = ?').get(path) as { fm_json: string; fm_error: string | null } | undefined
    return r ? this.hiddenRow(r.fm_json, r.fm_error) : false
  }

  /** @internal Whether the index has a note at `path`. */
  indexed(path: string): boolean {
    return this.statement('select 1 from notes where path = ?').get(path) !== undefined
  }

  /** @internal The notes that use a file that isn't a note, as indexed. */
  notesUsing(path: string): { path: string; fm_json: unknown; fm_error: unknown }[] {
    return this.statement('select n.path, n.fm_json, n.fm_error from images i join notes n on n.path = i.src_path where i.path = ?').all(path) as { path: string; fm_json: unknown; fm_error: unknown }[]
  }
}

interface Statement { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] }

/** Whether `path` is one of `folders` or inside one; everything with no folders. Compared in NFC (disks may hold NFD). */
export function inFolders(path: string, folders: readonly string[]): boolean {
  if (folders.length === 0) return true
  const p = path.normalize('NFC')
  return folders.some((f) => p === f || p.startsWith(f + '/'))
}

/** What one principal may read and write. Cheap: made per request. */
export class Access {
  readonly principal: Principal
  /** The user's levels, folder by folder (for an agent, its user's). */
  readonly viewer: Viewer
  private policy: AccessPolicy
  private sqlId: number | null = null

  constructor(policy: AccessPolicy, principal: Principal) {
    this.policy = policy
    this.principal = principal
    this.viewer = policy.permissions.viewer(principal.user)
  }

  /** The user the request acts for (the key's user for an agent). */
  get user(): User {
    return this.principal.user
  }

  get isAgent(): boolean {
    return this.principal.kind === 'agent'
  }

  /** Who the history and the editors see: the user, or the agent on their behalf with how it came. */
  get actor(): Actor {
    const p = this.principal
    return p.kind === 'user' ? { kind: 'user', id: p.user.id } : { kind: 'agent', id: p.key.id, onBehalfOf: p.user.id, via: p.via }
  }

  /** Whether it may write at all (a read-only key may not). */
  get mayWrite(): boolean {
    return this.principal.kind === 'user' || this.principal.key.canWrite
  }

  /** The user's level in a folder (for an agent, its user's; the key may reach less). */
  level(folder: string): Level | null {
    return this.viewer.level(folder)
  }

  /**
   * Whether the user reaches `need` where `path` is, and the path isn't held
   * from everyone. vihko.yaml is never anyone's: it holds the permissions
   * (it's edited through them, or on the disk).
   */
  private userCan(path: string, need: Level): boolean {
    if (path === WORKSPACE_FILE) return false
    return this.viewer.can(path, need) && !this.policy.holds?.held(path.normalize('NFC'))
  }

  /** Whether a path is within the key's folders (always, for a user). Says nothing about the note itself. */
  inScope(path: string): boolean {
    return this.principal.kind === 'user' || inFolders(path, this.principal.key.folders)
  }

  /** Whether a folder (or one above it) is closed to agents in vihko.yaml: never for a user. */
  closedToAgent(folder: string): boolean {
    return this.principal.kind === 'agent' && this.viewer.aiClosed(folder)
  }

  /** For an agent, whether a path is within its key's folders and out of folders closed to agents. */
  private agentReaches(path: string): boolean {
    return this.inScope(path) && !this.closedToAgent(folderOf(path))
  }

  /**
   * Whether a folder may be shown to an agent: inside the key's folders, or
   * on the way to one of them, and not closed to agents. Whether the user
   * sees anything in it, and whether it holds anything visible, is the
   * caller's to weigh (scoped.ts `tree`).
   */
  folderInScope(folder: string): boolean {
    if (this.principal.kind === 'user') return true
    const f = folder.normalize('NFC')
    if (this.viewer.aiClosed(f)) return false
    return this.inScope(f) || this.principal.key.folders.some((k) => k.startsWith(f + '/'))
  }

  /**
   * Whether it may read `path` now: a note (as last indexed; `hides` checks
   * its text), or another file (an image), which has its folder's
   * permission; an agent reads one only in its folders, only if a note it
   * can read uses it, and never if a note hidden from agents does
   * (`fileHidden`).
   */
  canRead(path: string): boolean {
    if (!this.userCan(path, 'read')) return false
    if (this.principal.kind === 'user') return true
    if (!this.agentReaches(path)) return false
    if (classifyPath(path) === 'note') return !this.policy.hiddenIndexed(path)
    const using = this.policy.notesUsing(path)
    return !using.some((n) => this.hiddenNote(n)) && using.some((n) => this.rowVisible(n.path, n.fm_json, n.fm_error))
  }

  /**
   * For an agent, whether a file that isn't a note is used by a note hidden
   * from agents (`ai: false` in it or in its folder, or a frontmatter that
   * can't be read): then the file is hidden too, whatever else uses it, or
   * writing a note that links to it would be enough to read it. Never for a
   * user.
   */
  fileHidden(path: string): boolean {
    return this.principal.kind === 'agent' && this.policy.notesUsing(path).some((n) => this.hiddenNote(n))
  }

  /** Whether a note that uses a file is hidden from every agent, by its frontmatter or its folder. */
  private hiddenNote(n: { path: string; fm_json: unknown; fm_error: unknown }): boolean {
    return this.policy.hiddenRow(n.fm_json, n.fm_error) || this.viewer.aiClosed(folderOf(n.path))
  }

  /**
   * Whether it may comment on a note (D-038.5): `comment` or more. An agent
   * comments only where it may write (commenting with `comment` alone isn't
   * for agents in M4).
   */
  canComment(path: string): boolean {
    if (this.principal.kind === 'agent') return this.canWrite(path)
    return this.userCan(path, 'comment')
  }

  /**
   * Whether it may write `path`: its user has `edit` in its folder, and for
   * an agent, a key that may write, in its folders, out of folders closed to
   * agents and, for a note that exists, one it can read (its text is
   * checked too: `hides`).
   */
  canWrite(path: string): boolean {
    if (!this.mayWrite || !this.userCan(path, 'edit')) return false
    if (this.principal.kind === 'user') return true
    if (!this.agentReaches(path)) return false
    return classifyPath(path) === 'note' ? !this.policy.hiddenIndexed(path) : true
  }

  /** Whether it may manage a folder (rename, move or delete it, change its permissions): `manage`. Never an agent. */
  canManage(folder: string): boolean {
    return this.principal.kind === 'user' && atLeast(this.viewer.level(folder), 'manage')
  }

  /**
   * Whether it may see a note's history (D-034 3.5): `edit` in its folder.
   * For an agent, also within its key's folders and out of folders closed to
   * agents (each version's text is judged by the history filter).
   */
  canHistory(path: string): boolean {
    if (!this.userCan(path, 'edit')) return false
    return this.principal.kind === 'user' || this.agentReaches(path)
  }

  /** Whether a note's text is hidden from this principal (`ai: false`, unreadable frontmatter): never for a user. */
  hides(text: string): boolean {
    return this.principal.kind === 'agent' && hiddenFromAgents(readFrontmatter(text), this.policy.aiKey)
  }

  /**
   * Why a note an agent named is hidden from it, if the note exists (as
   * indexed), its user can read it and the agent can't; null otherwise (a
   * user, it can, it isn't a note, there is no such note, or its user can't
   * see it either: then it doesn't exist for the agent). `hides` judges its
   * text now.
   */
  denial(path: string): DenyReason | null {
    if (this.principal.kind === 'user' || classifyPath(path) !== 'note' || this.canRead(path)) return null
    if (!this.userCanRead(path) || !this.policy.indexed(path)) return null
    return this.reasonFor(path)
  }

  /**
   * Why a note its user can read is hidden from an agent (by its text, say):
   * out of the key's folders, or `ai: false`.
   */
  reasonFor(path: string): DenyReason {
    if (!this.inScope(path)) return 'outside_key_folders'
    return 'ai_false'
  }

  /**
   * Whether the user the request acts for (an agent's, or the person) may
   * read `path`, whatever the key or the note's text say: what isn't so
   * doesn't exist for either of them (D-056.15).
   */
  userCanRead(path: string): boolean {
    return this.userCan(path, 'read')
  }

  /**
   * Why a note's text hides it from every agent, whoever asks (the UI shows
   * it): `ai` (`ai: false`, or any doubt), `frontmatter` (it can't be read),
   * or null.
   */
  agentHiding(text: string): 'ai' | 'frontmatter' | null {
    const fm = readFrontmatter(text)
    if (fm.error) return 'frontmatter'
    return hiddenFromAgents(fm, this.policy.aiKey) ? 'ai' : null
  }

  /** Unless it may read `path`: `agent_denied` for a note that exists and is hidden from an agent, `not_found` otherwise. */
  assertRead(path: string): void {
    if (this.canRead(path)) return
    const d = this.denial(path)
    if (d) throw new AgentDenied(d)
    throw new NoteError('not_found', `does not exist: ${path}`)
  }

  /**
   * Unless it may write `path`: `forbidden` for a read-only key (the key's
   * own limit, never about a note) and where it can see the note (or the
   * folder, for a new one) but its user can't edit; `agent_denied` for a
   * note that exists and is hidden from an agent; `not_found` otherwise.
   */
  assertWrite(path: string): void {
    if (!this.mayWrite) throw new AccessError('this key is read-only')
    if (this.canWrite(path)) return
    const d = this.denial(path)
    if (d) throw new AgentDenied(d)
    if (this.sees(path)) throw new AccessError('no permission to edit here')
    throw new NoteError('not_found', `does not exist: ${path}`)
  }

  /** Whether it sees `path` (a note it can read, or where a new note would go: a folder it sees). */
  private sees(path: string): boolean {
    if (this.canRead(path)) return true
    if (classifyPath(path) === 'note' && this.policy.indexed(path)) return false
    return this.userCan(path, 'read') && (this.principal.kind === 'user' || this.agentReaches(path))
  }

  /** @internal Whether a row of `notes` is one it may read (the SQL function). */
  rowVisible(path: string, fmJson: unknown, fmError: unknown): boolean {
    if (!this.userCan(path, 'read')) return false
    if (this.principal.kind === 'user') return true
    return this.agentReaches(path) && !this.policy.hiddenRow(fmJson, fmError)
  }

  private queryId(): number {
    return (this.sqlId = this.policy.queryId(this, this.sqlId))
  }

  /**
   * A condition on a query over `notes` (as `alias`) that keeps the notes it
   * may read: `where ${w.sql}`, with `w.params` bound in its place.
   */
  notesWhere(alias = 'n'): { sql: string; params: unknown[] } {
    return { sql: `${SQL_FN}(${alias}.path, ${alias}.fm_json, ${alias}.fm_error, ?)`, params: [this.queryId()] }
  }
}
