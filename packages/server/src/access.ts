// The single point of access (D-014, D-035): who is asking (a principal) and
// what they may read and write. Everything a request or an agent reaches is
// asked here, as a path (`canRead`, `canWrite`) or, for lists read from the
// index, as a condition in the query itself (`notesWhere`), which runs the
// same function: counts, snippets and pages never see what the principal can't.
//
// - A user sees and writes everything until M4, which adds per-folder
//   permissions here (in `Access` and the SQL function) without changing
//   any caller.
// - An agent (a key, D-035) sees what its user sees, limited to the key's
//   folders (none = all), and never a note with `ai: false` or whose
//   frontmatter can't be read (the most restricted, D-014). It writes only
//   with `canWrite`, where it can read (or, for a new file, in its folders).
//
// What an agent can't read doesn't exist for it: callers answer `not_found`,
// never `forbidden`, and name nothing it can't see (D-030, D-024).
import { classifyPath, readFrontmatter } from '@thoth/core'
import type { Actor, Via } from './actor.ts'
import type { User } from './auth.ts'
import type { Db } from './db.ts'
import { NoteError } from './notes.ts'

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

/** A request the principal may make in general but not here (never about a note it can't see: that is `not_found`). */
export class AccessError extends Error {
  readonly code = 'forbidden'
}

export interface AccessPolicyOptions {
  /** index.db: the notes' frontmatter as last indexed, and which notes use each file. */
  index: Db
  /** The frontmatter key that hides a note from agents (`ai`). */
  aiKey?: string
}

/** Name of the SQL function `notesWhere` uses: (path, fm_json, fm_error, grant) → 0/1. */
const SQL_FN = 'thoth_visible'

/**
 * Builds the access of each principal over one index. Registers in the index
 * the SQL function lists are filtered with, so queries and `canRead` share
 * one rule.
 */
export class AccessPolicy {
  readonly aiKey: string
  private index: Db
  private grants = new Map<string, Grant>()
  private statements = new Map<string, Statement>()

  constructor(opts: AccessPolicyOptions) {
    this.index = opts.index
    this.aiKey = opts.aiKey ?? DEFAULT_AI_KEY
    this.index.function(SQL_FN, { deterministic: true }, (path: unknown, fmJson: unknown, fmError: unknown, grant: unknown) => {
      if (grant === null || grant === undefined) return 1
      const g = this.grant(String(grant))
      return inFolders(String(path), g.folders) && !this.hiddenRow(fmJson, fmError) ? 1 : 0
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

  /** @internal The folders of a grant, parsed once. */
  grant(json: string): Grant {
    let g = this.grants.get(json)
    if (!g) {
      g = { folders: (JSON.parse(json) as string[]).map((f) => f.normalize('NFC')) }
      if (this.grants.size > 256) this.grants.clear()
      this.grants.set(json, g)
    }
    return g
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

  /** @internal Whether a file that isn't a note is used by a note the grant can read. */
  usedByVisible(path: string, grantJson: string): boolean {
    return this.statement(`select 1 from images i join notes n on n.path = i.src_path
      where i.path = ? and ${SQL_FN}(n.path, n.fm_json, n.fm_error, ?) limit 1`).get(path, grantJson) !== undefined
  }
}

interface Grant { folders: string[] }

interface Statement { get(...params: unknown[]): unknown }

/** Whether `path` is one of `folders` or inside one; everything with no folders. Compared in NFC (disks may hold NFD). */
function inFolders(path: string, folders: readonly string[]): boolean {
  if (folders.length === 0) return true
  const p = path.normalize('NFC')
  return folders.some((f) => p === f || p.startsWith(f + '/'))
}

/** What one principal may read and write. Cheap: made per request. */
export class Access {
  readonly principal: Principal
  private policy: AccessPolicy
  private grantJson: string | null

  constructor(policy: AccessPolicy, principal: Principal) {
    this.policy = policy
    this.principal = principal
    this.grantJson = principal.kind === 'agent' ? JSON.stringify(principal.key.folders.map((f) => f.normalize('NFC'))) : null
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

  /** Whether a path is within the key's folders (always, for a user). Says nothing about the note itself. */
  inScope(path: string): boolean {
    return this.principal.kind === 'user' || inFolders(path, this.principal.key.folders)
  }

  /**
   * Whether a folder may be shown: inside the key's folders, or on the way
   * to one of them. Whether it holds anything visible is the caller's to
   * weigh (a folder of hidden notes alone isn't shown).
   */
  folderInScope(folder: string): boolean {
    if (this.principal.kind === 'user') return true
    const f = folder.normalize('NFC')
    return this.inScope(f) || this.principal.key.folders.some((k) => k.startsWith(f + '/'))
  }

  /**
   * Whether it may read `path` now: a note (as last indexed; `hides` checks
   * its text), or another file (an image), which an agent reads only in its
   * folders and only if a note it can read uses it.
   */
  canRead(path: string): boolean {
    if (this.principal.kind === 'user') return true
    if (!this.inScope(path)) return false
    if (classifyPath(path) === 'note') return !this.policy.hiddenIndexed(path)
    return this.policy.usedByVisible(path, this.grantJson!)
  }

  /**
   * Whether it may write `path`: a note or file it can read, or a new one in
   * its folders. For a note that exists, its text is checked too (`hides`).
   */
  canWrite(path: string): boolean {
    if (!this.mayWrite) return false
    if (this.principal.kind === 'user') return true
    if (!this.inScope(path)) return false
    return classifyPath(path) === 'note' ? !this.policy.hiddenIndexed(path) : true
  }

  /** Whether a note's text is hidden from this principal (`ai: false`, unreadable frontmatter): never for a user. */
  hides(text: string): boolean {
    return this.principal.kind === 'agent' && hiddenFromAgents(readFrontmatter(text), this.policy.aiKey)
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

  /** `not_found` unless it may read `path`: what it can't see doesn't exist. */
  assertRead(path: string): void {
    if (!this.canRead(path)) throw new NoteError('not_found', `does not exist: ${path}`)
  }

  /**
   * `not_found` unless it may write `path`; `forbidden` for a read-only key
   * (the key's own limit, never about a note).
   */
  assertWrite(path: string): void {
    if (!this.mayWrite) throw new AccessError('this key is read-only')
    if (!this.canWrite(path)) throw new NoteError('not_found', `does not exist: ${path}`)
  }

  /**
   * A condition on a query over `notes` (as `alias`) that keeps the notes it
   * may read: `where ${w.sql}`, with `w.params` bound in its place.
   */
  notesWhere(alias = 'n'): { sql: string; params: unknown[] } {
    if (this.principal.kind === 'user') return { sql: '1', params: [] }
    return { sql: `${SQL_FN}(${alias}.path, ${alias}.fm_json, ${alias}.fm_error, ?)`, params: [this.grantJson] }
  }
}
