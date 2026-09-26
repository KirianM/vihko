// thoth API client. Cookie-based session (HttpOnly): the browser sends it on its own.
import type { Alert, ErrorCode } from '@thoth/core/codes'
import type { Series } from '@thoth/core/series'

export type { Alert }

export class ApiError extends Error {
  readonly status: number
  /** Server error code (`not_found`, `precondition_failed`…) or `network`. */
  readonly code: string
  readonly etag: string | null
  constructor(status: number, code: string, message: string, etag: string | null = null) {
    super(message)
    this.status = status
    this.code = code
    this.etag = etag
  }
}

export async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  let res: Response
  const raw = body instanceof Blob
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined || raw ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      signal,
    })
  } catch {
    throw new ApiError(0, 'network', 'network')
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) {
    throw new ApiError(res.status, String(data?.error ?? 'internal'), String(data?.message ?? res.statusText), (data?.etag as string | null) ?? null)
  }
  return data as T
}

export interface User { id: string; username: string; role: 'admin' | 'member' }
export interface TreeNote { path: string; title: string; uid: string | null; aliases: string[] }
export interface Note { path: string; text: string; etag: string; meta: { title: string; uid: string | null; fm_error: string | null } | null }

export interface OutgoingLink {
  raw: string
  kind: 'wiki' | 'embed' | 'md'
  status: 'resolved' | 'ambiguous' | 'missing'
  dst_path: string | null
  candidates: string[] | null
  /** Where the link starts in the note as indexed (a hint to find that occurrence). */
  pos_from: number
}
/** A note's links: outgoing, backlinks and the titles of ambiguous links' candidates. */
export interface NoteLinks { outgoing: OutgoingLink[]; backlinks: Backlink[]; titles: Record<string, string> }
export interface Backlink { path: string; title: string; raw: string; context: string }
/** A comment thread's text as the index first saw it (D-031.6); `changed` compares it with the saved note. */
export interface CommentOriginal { id: string; original: string; changed: boolean }
export interface SearchResult { path: string; title: string; snippet: string }
/** Search results; the snippet highlight uses control characters, not HTML. */
export interface SearchResponse { results: SearchResult[]; highlight?: { start: string; end: string } }

/** A link's resolution in a move report: where it leads, among which notes it is ambiguous, or broken. */
export type LinkState = { status: 'resolved'; path: string } | { status: 'ambiguous'; candidates: string[] } | { status: 'missing' }
/**
 * A link a move leaves as it is but whose resolution changes (D-019):
 * `resolves` (it was ambiguous or broken), `ambiguous`, `retargets` or `breaks`.
 * `before` in the paths before the move, `after` in those after it.
 */
export interface Shift { raw: string; code: 'resolves' | 'ambiguous' | 'retargets' | 'breaks'; before: LinkState; after: LinkState }
/** Those links, by source note. */
export interface ShiftGroup { path: string; links: number; changes: Shift[] }

/** What a rename or move does (or would do, with `dryRun`). */
export interface MoveReport {
  from: string
  to: string
  relinked: { path: string; links: number; changes: { before: string; after: string }[] }[]
  shifted: ShiftGroup[]
  kept: { path: string; raw: string; via: 'path' | 'alias' }[]
  failed: { path: string; error: ErrorCode; message: string }[]
  aliasAdded: string | null
  /**
   * The note's images, when it changes folder: those that go with it, those
   * that stay (shared, or in another folder) and those that ran into trouble
   * (`stayed`: still in the old folder, linked there; `copied`: moved, but the
   * original could not be removed).
   */
  images: {
    moved: { from: string; to: string }[]
    stayed: { path: string; reason: 'shared' | 'elsewhere' }[]
    /** In per-note mode (thoth.yaml), the note's folder of images, which moves with it whole. */
    folder: { from: string; to: string; files: number } | null
    failed: { path: string; to: string | null; outcome: 'stayed' | 'copied'; error: ErrorCode; message: string }[]
  }
  dryRun: boolean
}
/** What a folder move does (or would do, with `dryRun`): every note in it goes along, links kept. */
export interface FolderMoveReport {
  from: string
  to: string
  notes: { from: string; to: string }[]
  /** Other files that go with the folder (images, attachments). */
  files: number
  relinked: MoveReport['relinked']
  shifted: ShiftGroup[]
  failed: MoveReport['failed']
  dryRun: boolean
}
/**
 * A move whose link rewrites go on in the background: the note (or folder) is
 * already in place; `done` of `total` notes rewritten, and the report at the end.
 */
export type MoveJob = { id: string; kind: 'note' | 'folder' | 'relink'; from: string; to: string; done: number; total: number } & (
  | { state: 'running' }
  | { state: 'done'; report: MoveReport | FolderMoveReport | MovedRelinkReport }
  | { state: 'failed'; error: ErrorCode; message: string }
)
/**
 * Updating the links after notes moved outside thoth (or its preview): the
 * rewrites a move of those notes from thoth would have made.
 */
export interface MovedRelinkReport {
  moves: { from: string; to: string }[]
  relinked: MoveReport['relinked']
  shifted: ShiftGroup[]
  failed: MoveReport['failed']
  dryRun: boolean
}
/** A move asked for in the background: its report if it ended quickly, or its job. */
export type MoveStart<R> = { report: R } | { job: MoveJob }
/** A tag in use, with the notes that carry it (`count`) and it or any tag nested under it (`total`). */
export interface TagCount { tag: string; count: number; total: number }
export interface TrashEntry { id: string; path: string; deletedAt: string }
/** Installation settings the UI needs. */
export interface ServerConfig { externalImages: 'allow' | 'block'; maxImageBytes: number }
/** A stored image: `path` from the notes root, `src` relative to the note (to link it). */
export interface Attachment { path: string; src: string }
/** What the UI needs from thoth.yaml: daily-note series and the templates folder. */
export interface WorkspaceInfo {
  daily: Series[]
  templates: string | null
  /** `aliases`: whether aliases resolve links (thoth.yaml `links.aliases`). */
  links: { aliases: boolean }
}
/** The person's own settings (state.db). */
export interface Profile { timezone: string | null; dailySeries: string | null; openDailyOnStart: boolean }

/**
 * The integration switches (D-035.1): the API with keys and the MCP server,
 * whether members may create keys, whether the server's administrator locks
 * the API and MCP off (THOTH_INTEGRATIONS=off), and whether this person may
 * create or change keys.
 */
export interface Integrations { api: boolean; mcp: boolean; membersCanCreateKeys: boolean; locked: boolean; canCreateKeys: boolean }
/** An agent key as its owner (or the admin) sees it: never the secret. `folders` empty = every folder. */
export interface KeyInfo {
  id: string
  userId: string
  name: string
  canWrite: boolean
  folders: string[]
  expiresAt: string | null
  createdAt: string
  lastUsedAt: string | null
  lastVia: 'api' | 'mcp' | 'oauth' | null
  revokedAt: string | null
  last4: string
  status: 'active' | 'expired' | 'revoked'
}
/** In the admin's list of everyone's keys, each one with its user. */
export interface KeyWithUser extends KeyInfo { user: { id: string; username: string } }
/** What a key is created or changed with; `expiresAt: null` takes the expiry away. */
export interface KeyInput { name?: string; canWrite?: boolean; folders?: string[]; expiresAt?: string | null }

let config: Promise<ServerConfig> | null = null

const started = <R>(r: R | { job: MoveJob }): MoveStart<R> => (r !== null && typeof r === 'object' && 'job' in r ? { job: r.job } : { report: r as R })

export const api = {
  setupNeeded: () => request<{ needed: boolean }>('GET', '/api/setup'),
  setup: (token: string, username: string, password: string) => request<{ user: User }>('POST', '/api/setup', { token, username, password }),
  login: (username: string, password: string) => request<{ user: User }>('POST', '/api/auth/login', { username, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  me: () => request<{ user: User }>('GET', '/api/auth/me'),
  /** Notes and folders (empty ones included). */
  tree: () => request<{ notes: TreeNote[]; folders: string[] }>('GET', '/api/tree'),
  createFolder: (path: string) => request<{ path: string }>('POST', '/api/folder', { path }),
  /** Only an empty folder (`not_empty` otherwise). */
  deleteFolder: (path: string) => request<{ path: string }>('DELETE', `/api/folder?path=${encodeURIComponent(path)}`),
  moveFolder: (from: string, to: string, dryRun = false) => request<FolderMoveReport>('POST', '/api/folder/move', { from, to, dryRun }),
  /** Moves a folder; if rewriting the links takes long, they go on in the background (a job). */
  startMoveFolder: (from: string, to: string) => request<FolderMoveReport | { job: MoveJob }>('POST', '/api/folder/move', { from, to, background: true }).then(started<FolderMoveReport>),
  /** A job's state; `timeoutMs`: give up on a request that doesn't answer (it's asked again). */
  moveJob: (id: string, timeoutMs?: number) => request<MoveJob>('GET', `/api/move-jobs/${encodeURIComponent(id)}`, undefined, {}, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined),
  note: (path: string) => request<Note>('GET', `/api/note?path=${encodeURIComponent(path)}`),
  alerts: () => request<{ alerts: Alert[] }>('GET', '/api/alerts').then((r) => r.alerts),
  conflict: (path: string) => request<{ path: string; text: string }>('GET', `/api/conflict?path=${encodeURIComponent(path)}`),
  rescan: (confirmRemoval?: number) => request<{ aborted: string | null }>('POST', '/api/admin/rescan', confirmRemoval === undefined ? {} : { confirmRemoval }),
  links: (path: string) => request<NoteLinks>('GET', `/api/note/links?path=${encodeURIComponent(path)}`),
  /** Fixes where an ambiguous link leads: that occurrence (`raw` nearest to `at`) is rewritten to reach `target`. */
  pinLink: (path: string, raw: string, at: number | undefined, target: string) =>
    request<{ etag: string; raw: string }>('POST', '/api/note/link/pin', { path, raw, at, target }),
  /** What updating the links after an external move would do. */
  relinkPreview: (id: string) => request<MovedRelinkReport>('POST', `/api/external-moves/${encodeURIComponent(id)}/relink`, { dryRun: true }),
  /** Updates them; if it takes long, it goes on in the background (a job). */
  startRelink: (id: string) => request<MovedRelinkReport | { job: MoveJob }>('POST', `/api/external-moves/${encodeURIComponent(id)}/relink`, { background: true }).then(started<MovedRelinkReport>),
  commentOriginals: (path: string) => request<{ threads: CommentOriginal[] }>('GET', `/api/note/comments?path=${encodeURIComponent(path)}`).then((r) => r.threads),
  /** Tags in use, most used first (editor suggestions and the tags view). */
  tags: () => request<{ tags: TagCount[] }>('GET', '/api/tags').then((r) => r.tags),
  headings: (path: string) => request<{ headings: { level: number; text: string }[] }>('GET', `/api/note/headings?path=${encodeURIComponent(path)}`).then((r) => r.headings),
  search: (q: string) => request<SearchResponse>('GET', `/api/search?q=${encodeURIComponent(q)}`),
  /** `freshUid`: the text may carry another note's uid (a copy): it gets a new one. */
  createNote: (path: string, text: string, opts: { freshUid?: boolean } = {}) => request<{ path: string; etag: string; uid: string | null }>('POST', '/api/note', { path, text, ...opts }),
  /** A new note with the text of the template note, its variables filled in by the server. */
  createFromTemplate: (path: string, template: string) => request<{ path: string; etag: string; uid: string | null }>('POST', '/api/note', { path, template }),
  workspace: () => request<WorkspaceInfo>('GET', '/api/workspace'),
  profile: () => request<Profile>('GET', '/api/profile'),
  updateProfile: (patch: Partial<Profile>) => request<Profile>('PUT', '/api/profile', patch),
  /** Where today's note is and whether it exists; creates nothing. */
  today: () => request<{ series: string; path: string; exists: boolean }>('GET', '/api/daily'),
  /** Opens today's note, creating it from its template if it doesn't exist. */
  openToday: () => request<{ series: string; path: string; created: boolean }>('POST', '/api/daily', {}),
  orphan: (path: string, action: 'restore' | 'discard') => request<{ ok: true }>('POST', '/api/note/orphan', { path, action }),
  move: (from: string, to: string, dryRun = false) => request<MoveReport>('POST', '/api/note/move', { from, to, dryRun }),
  /** Moves a note; if rewriting the links takes long, they go on in the background (a job). */
  startMove: (from: string, to: string) => request<MoveReport | { job: MoveJob }>('POST', '/api/note/move', { from, to, background: true }).then(started<MoveReport>),
  trash: (path: string) => request<TrashEntry>('DELETE', `/api/note?path=${encodeURIComponent(path)}`),
  /** Asked once per page load: it only changes when the server restarts. */
  config: () => (config ??= request<ServerConfig>('GET', '/api/config').catch((err) => { config = null; throw err })),
  uploadImage: (note: string, file: Blob) =>
    request<Attachment>('POST', `/api/attachments?note=${encodeURIComponent(note)}`, file, { 'content-type': file.type || 'application/octet-stream' }),
  fetchImage: (note: string, url: string) => request<Attachment>('POST', '/api/attachments/fetch', { note, url }),
  restore: (id: string) => request<{ path: string; etag: string }>('POST', `/api/trash/${encodeURIComponent(id)}/restore`),
  integrations: () => request<Integrations>('GET', '/api/integrations'),
  /** The thoth admin only; turning the API or MCP on while the server locks them gives `integrations_locked`. */
  setIntegrations: (patch: Partial<Pick<Integrations, 'api' | 'mcp' | 'membersCanCreateKeys'>>) => request<Integrations>('PUT', '/api/admin/integrations', patch),
  /** This person's keys, newest first (revoked ones too). */
  keys: () => request<{ keys: KeyInfo[] }>('GET', '/api/keys').then((r) => r.keys),
  /** Everyone's keys, with their user: the thoth admin only. */
  allKeys: () => request<{ keys: KeyWithUser[] }>('GET', '/api/keys?all=1').then((r) => r.keys),
  /** A new key: the token comes back this once and never again. */
  createKey: (input: KeyInput & { name: string }) => request<{ key: KeyInfo; token: string }>('POST', '/api/keys', input),
  updateKey: (id: string, patch: KeyInput) => request<{ key: KeyInfo }>('PATCH', `/api/keys/${encodeURIComponent(id)}`, patch).then((r) => r.key),
  /** Its owner, or the thoth admin for anyone's. */
  revokeKey: (id: string) => request<{ key: KeyInfo }>('DELETE', `/api/keys/${encodeURIComponent(id)}`).then((r) => r.key),
}
