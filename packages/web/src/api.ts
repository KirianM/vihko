// vihko API client. Cookie-based session (HttpOnly): the browser sends it on its own.
import type { Alert, ErrorCode } from '@vihko/core/codes'
import type { Series } from '@vihko/core/series'

export type { Alert }

export class ApiError extends Error {
  readonly status: number
  /** Server error code (`not_found`, `precondition_failed`…) or `network`. */
  readonly code: string
  readonly etag: string | null
  /** Seconds to wait before trying again (429, from Retry-After), or null. */
  readonly retryAfter: number | null
  constructor(status: number, code: string, message: string, etag: string | null = null, retryAfter: number | null = null) {
    super(message)
    this.status = status
    this.code = code
    this.etag = etag
    this.retryAfter = retryAfter
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
    const wait = Number(res.headers.get('retry-after'))
    throw new ApiError(res.status, String(data?.error ?? 'internal'), String(data?.message ?? res.statusText), (data?.etag as string | null) ?? null,
      Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : null)
  }
  return data as T
}

export interface User { id: string; username: string; role: 'admin' | 'member' }
/**
 * Dispatched on `window` when the hub says this session ended (the admin
 * disabled the account or closed its sessions, or the password changed in
 * another session): the application goes to sign in (Shell.tsx).
 */
export const SESSION_ENDED_EVENT = 'vihko:session-ended'
export interface TreeNote { path: string; title: string; uid: string | null; aliases: string[] }
export interface Note {
  path: string
  text: string
  etag: string
  meta: { title: string; uid: string | null; fm_error: string | null } | null
  /** Whether its text hides it from every agent: `ai: false` (or any doubt), or a frontmatter that can't be read. */
  hiddenFromAgents: 'ai' | 'frontmatter' | null
  /** What the person may do where it is (D-038.5): below `edit`, the editor is read-only. */
  level?: Level
}

/** Whether a level lets the person write the note (`Level`, below: from less to more, D-038.5). */
export const canEdit = (level: Level | null | undefined) => level === 'edit' || level === 'manage'

/**
 * A comment for the server to write (`comment` level, whose editor is
 * read-only): a new thread right after `context` (the text before the place,
 * nearest to `at`), a reply, or resolving a thread one started.
 */
export type CommentOp =
  | { op: 'add'; at: number; context: string; newline?: boolean; text: string }
  | { op: 'reply'; thread: string; text: string }
  | { op: 'resolve'; thread: string }

export interface OutgoingLink {
  raw: string
  kind: 'wiki' | 'embed' | 'md'
  /** `no_access`: a note that exists but isn't the person's to read (D-024): no path, no title. */
  status: 'resolved' | 'ambiguous' | 'missing' | 'no_access'
  dst_path: string | null
  candidates: string[] | null
  /** Where the link starts in the note as indexed (a hint to find that occurrence). */
  pos_from: number
  /** It leads to the note it is in (`[[#Heading]]`, its own name): the editor shows its state, the links panel leaves it out. */
  self?: true
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
    /** In per-note mode (vihko.yaml), the note's folder of images, which moves with it whole. */
    folder: { from: string; to: string; files: number } | null
    failed: { path: string; to: string | null; outcome: 'stayed' | 'copied'; error: ErrorCode; message: string }[]
  }
  /** In a dry run, whose access changes (D-038): the UI asks before moving. */
  audience?: AudienceChange
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
  /** In a dry run, whose access changes (D-038): the UI asks before moving. */
  audience?: AudienceChange
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
 * Updating the links after notes moved outside vihko (or its preview): the
 * rewrites a move of those notes from vihko would have made.
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
/**
 * A trash entry: a note (`path`) with the files that went with it (its
 * images only it used), or files alone (`kind: 'files'`, `path` their folder).
 */
export interface TrashEntry { id: string; path: string; deletedAt: string; kind?: 'files'; files?: { path: string }[] }
/** Installation settings the UI needs. */
export interface ServerConfig {
  externalImages: 'allow' | 'block'
  maxImageBytes: number
  /** The second factor's secrets are stored encrypted (VIHKO_SECRET_KEY). */
  secretsEncrypted?: boolean
  /** vihko's version (the root package.json's). */
  version?: string
}
/** A stored image: `path` from the notes root, `src` relative to the note (to link it). */
export interface Attachment { path: string; src: string }
/** What the UI needs from vihko.yaml: daily-note series and the templates folder. */
export interface WorkspaceInfo {
  daily: Series[]
  templates: string | null
  /** `aliases`: whether aliases resolve links (vihko.yaml `links.aliases`). */
  links: { aliases: boolean }
}
/** The person's own settings (state.db). */
export interface Profile { timezone: string | null; dailySeries: string | null; openDailyOnStart: boolean }

/**
 * The integration switches (D-035.1): the API with keys and the MCP server,
 * whether members may create keys, whether OAuth clients may register
 * themselves, whether the server's administrator locks the API and MCP off
 * (VIHKO_INTEGRATIONS=off), whether this person may create or change keys,
 * and the public URL (VIHKO_PUBLIC_URL) OAuth is offered at, if any.
 */
export interface Integrations {
  api: boolean
  mcp: boolean
  membersCanCreateKeys: boolean
  oauthRegistration: boolean
  locked: boolean
  canCreateKeys: boolean
  publicUrl: string | null
}
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
  /** An OAuth authorization: the client it was given to and where it goes back to. Null for a key. */
  client: { id: string; redirectUris: string[] } | null
  /** Rotated a moment ago: until when the key it replaced still works. */
  previousUntil: string | null
}
/** In the admin's list of everyone's keys, each one with its user. */
export interface KeyWithUser extends KeyInfo { user: { id: string; username: string } }
/** What a key is created or changed with; `expiresAt: null` takes the expiry away. */
export interface KeyInput { name?: string; canWrite?: boolean; folders?: string[]; expiresAt?: string | null }
/** An OAuth client asking for access (the consent page): its name, where it goes back to, and whether this person may authorize it. */
/** An authorization request: who asks (`host`: the domain that described it, for a client named by its metadata document; null if it registered itself) and whether this person may authorize. */
export interface OAuthRequest { client: { id: string; name: string; redirectUri: string; host: string | null }; canAuthorize: boolean }

/** A user as the vihko admin sees them (M4). `invited`: never chose a password. */
export interface UserInfo {
  id: string
  username: string
  role: 'admin' | 'member'
  status: 'active' | 'invited' | 'disabled'
  createdAt: string
  lastSeenAt: string | null
  sessions: number
  groups: string[]
  /** A link that still works: what for and until when (never its token). */
  link: { kind: 'invite' | 'reset'; expiresAt: string } | null
  /** Whether they set up a second factor (D-036), and since when. */
  twoFactor: { enabled: boolean; enabledAt: string | null }
}
/** A folder permission level, from less to more (D-038.5). */
export type Level = 'read' | 'comment' | 'edit' | 'manage'
export const LEVELS: readonly Level[] = ['read', 'comment', 'edit', 'manage']
export const atLeast = (have: Level | null | undefined, need: Level) => have != null && LEVELS.indexOf(have) >= LEVELS.indexOf(need)
/** A user name, `@group`, or `{user}` (in a `{user}` rule), with its level. */
export type Grants = Record<string, Level>
/** A grant that gives someone access to a folder: to them or to a group of theirs, written for `from` (or `rule`, a `{user}` rule's key). */
/** Why someone has access: a grant, where it's written, and `above` when it's `manage` of a folder above that reaches here whatever this one's grants say. */
export interface GrantSource { subject: string; level: Level; from: string; rule?: string; above?: true }
/** Whoever manages a folder from above (D-040 3.5), and where. */
export interface ManagerAbove { subject: string; from: string; rule?: string }
/** A folder's rule, who has access and why (GET /api/permissions). */
export interface FolderPermissions {
  folder: string
  /** vihko.yaml's ETag: a change names it (412 if the file changed). */
  etag: string
  /** `implicit`: no section yet (the admins manage the root); `closed`: rejected, nobody reads. */
  section: 'rules' | 'implicit' | 'closed'
  /** The rule written for this folder: literal (`user` null), or a `{user}` rule matching it. */
  own: { rule: string; user: string | null; grants: Grants | null; ai: boolean } | null
  /** What the parent gives: from which folder, resolved. */
  inherited: { from: string; rule: string; grants: Grants } | null
  /** A `{user}` rule with grants matching this folder, resolved. */
  userRule: { rule: string; user: string; grants: Grants } | null
  /** What applies here, and the folder it's written for. */
  effective: { from: string | null; rule: string | null; grants: Grants }
  /** Who manages it from above, whatever its own grants say; none into a personal folder. */
  managedAbove: ManagerAbove[]
  /** The personal folder (a `{user}` rule's) it is or is in; null if none. */
  personal: string | null
  ai: { closed: boolean; from: string | null }
  canEdit: boolean
  access: { id: string; username: string; level: Level; via: GrantSource[] }[]
}
/** A folder's lock and the person's level in it (GET /api/permissions/folders). */
export interface FolderLock { path: string; level: Level | null; ownGrants: boolean; aiClosed: boolean; canEdit: boolean }
/** What a person or a key reaches, folder by folder. */
export interface EffectiveAccess { user: { id: string; username: string }; key: { id: string; name: string } | null; folders: { folder: string; level: Level }[] }
/** Who gains or loses access with a move (users and groups named, keys counted). */
export interface AudienceChange {
  users: { gain: { id: string; username: string }[]; lose: { id: string; username: string }[] }
  groups: { gain: string[]; lose: string[] }
  keys: { gain: number; lose: number }
}

/** A new one-time link, shown once: `url` with VIHKO_PUBLIC_URL, otherwise this origin + `path`. */
export interface NewLink { token: string; kind: 'invite' | 'reset'; expiresAt: string; path: string; url: string | null }
export interface GroupInfo { id: string; name: string; members: { id: string; username: string }[] }
/** The second factor's policy (D-036): required, optional (the default) or disabled. */
export type TwoFactorPolicy = 'required' | 'optional' | 'disabled'
/** The admin's settings: members downloading images from the local network (off by default), and the second factor's policy. */
export interface AdminSettings { membersLocalDownloads: boolean; twoFactor: TwoFactorPolicy }
/**
 * After the password (signing in, or with a one-time link): the session, or
 * the second step first, with a short-lived pending sign-in: a code, or
 * setting the second factor up (the admin requires it).
 */
export type SignInResult = { user: User } | SecondStep
export interface SecondStep { step: 'code' | 'setup'; pending: string; expiresAt: string; username: string }
/** Setting up the second factor: the secret (in groups of four), the `otpauth://` URI and its QR code (null if it doesn't fit one). */
export interface TwoFactorSetup { secret: string; uri: string; qr: { size: number; path: string } | null }
/** One's own second factor: the policy, whether it's set up, and what confirms a new key or OAuth client. */
export interface TwoFactorInfo {
  policy: TwoFactorPolicy
  enabled: boolean
  enabledAt: string | null
  recoveryCodesLeft: number
  confirmWith: 'code' | 'password'
}
/** One of one's own sessions. */
export interface SessionInfo { id: string; createdAt: string; lastSeenAt: string; expiresAt: string; userAgent: string | null; current: boolean }

let config: Promise<ServerConfig> | null = null

const started = <R>(r: R | { job: MoveJob }): MoveStart<R> => (r !== null && typeof r === 'object' && 'job' in r ? { job: r.job } : { report: r as R })

export const api = {
  setupNeeded: () => request<{ needed: boolean }>('GET', '/api/setup'),
  setup: (token: string, username: string, password: string) => request<{ user: User }>('POST', '/api/setup', { token, username, password }),
  /** The password: the session, or the second step to take first. */
  login: (username: string, password: string) => request<SignInResult>('POST', '/api/auth/login', { username, password }),
  /** The second step with a code (TOTP, or a recovery code: then how many are left). */
  loginCode: (pending: string, code: string) => request<{ user: User; recoveryCodesLeft?: number }>('POST', '/api/auth/login/code', { pending, code }),
  /** Setting the second factor up during a sign-in the admin requires it for. */
  setupPending: (pending: string) => request<TwoFactorSetup>('POST', '/api/auth/2fa/setup', { pending }),
  /** Its first code: now it's theirs and they're signed in; the recovery codes, shown once. */
  enablePending: (pending: string, code: string) => request<{ user: User; recoveryCodes: string[] }>('POST', '/api/auth/2fa/enable', { pending, code }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  me: () => request<{ user: User }>('GET', '/api/auth/me'),
  /** Notes and folders (empty ones included); `pathOnly`: folders shown only as the way to what the person sees. */
  tree: () => request<{ notes: TreeNote[]; folders: string[]; pathOnly: string[] }>('GET', '/api/tree'),
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
  /** A comment the server writes (`precondition_failed`: the place or the thread isn't there any more). */
  comment: (path: string, op: CommentOp) => request<{ etag: string }>('POST', '/api/note/comment', { path, ...op }),
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
  /** Notes held after moving outside vihko (D-038): move the folder's permissions with them, or release them. */
  held: (id: string, action: 'move_permissions' | 'release') => request<{ ok: true }>('POST', `/api/permissions/holds/${encodeURIComponent(id)}`, { action }),
  move: (from: string, to: string, dryRun = false) => request<MoveReport>('POST', '/api/note/move', { from, to, dryRun }),
  /** Moves a note; if rewriting the links takes long, they go on in the background (a job). */
  startMove: (from: string, to: string) => request<MoveReport | { job: MoveJob }>('POST', '/api/note/move', { from, to, background: true }).then(started<MoveReport>),
  trash: (path: string) => request<TrashEntry>('DELETE', `/api/note?path=${encodeURIComponent(path)}`),
  /** Asked once per page load: it only changes when the server restarts. */
  config: () => (config ??= request<ServerConfig>('GET', '/api/config').catch((err) => { config = null; throw err })),
  uploadImage: (note: string, file: Blob) =>
    request<Attachment>('POST', `/api/attachments?note=${encodeURIComponent(note)}`, file, { 'content-type': file.type || 'application/octet-stream' }),
  fetchImage: (note: string, url: string) => request<Attachment>('POST', '/api/attachments/fetch', { note, url }),
  /** A trash entry back: `files` where each landed (another name if its own was taken), `left` those that stay in the trash. */
  restore: (id: string) => request<{ path: string; etag: string | null; files: { from: string; to: string }[]; left: string[] }>('POST', `/api/trash/${encodeURIComponent(id)}/restore`),
  integrations: () => request<Integrations>('GET', '/api/integrations'),
  /** The vihko admin only; turning the API or MCP on while the server locks them gives `integrations_locked`. */
  setIntegrations: (patch: Partial<Pick<Integrations, 'api' | 'mcp' | 'membersCanCreateKeys' | 'oauthRegistration'>>) => request<Integrations>('PUT', '/api/admin/integrations', patch),
  /** This person's keys, newest first (revoked ones too). */
  keys: () => request<{ keys: KeyInfo[] }>('GET', '/api/keys').then((r) => r.keys),
  /** Everyone's keys, with their user: the vihko admin only. */
  allKeys: () => request<{ keys: KeyWithUser[] }>('GET', '/api/keys?all=1').then((r) => r.keys),
  /** A new key: the token comes back this once and never again. */
  /** `confirm`: the current code, or the password without a second factor (D-036). */
  createKey: (input: KeyInput & { name: string; confirm: string }) => request<{ key: KeyInfo; token: string }>('POST', '/api/keys', input),
  /** A change that lets it do more (writing, more folders, a later expiry or none) takes `confirm`, as a new key does. */
  updateKey: (id: string, patch: KeyInput & { confirm?: string }) => request<{ key: KeyInfo }>('PATCH', `/api/keys/${encodeURIComponent(id)}`, patch).then((r) => r.key),
  /** Its owner, or the vihko admin for anyone's. */
  rotateKey: (id: string, confirm: string) => request<{ key: KeyInfo; token: string }>('POST', `/api/keys/${encodeURIComponent(id)}/rotate`, { confirm }),
  revokeKey: (id: string) => request<{ key: KeyInfo }>('DELETE', `/api/keys/${encodeURIComponent(id)}`).then((r) => r.key),
  /** The OAuth authorization request in `query` (the page's own query string, without `?`): who asks, and whether this person may say yes. */
  oauthRequest: (query: string) => request<OAuthRequest>('GET', `/api/oauth/authorize?${query}`),
  /** The person's answer: where the browser goes next (back to the client, with a code or `access_denied`). */
  oauthDecide: (query: string, decision: { approve: boolean; canWrite?: boolean; folders?: string[]; confirm?: string }) =>
    request<{ redirect: string }>('POST', '/api/oauth/authorize', { query, ...decision }),
  /** Whom a one-time link is for; `invalid_link` if it doesn't work (unknown, used or expired, alike). */
  invite: (token: string) => request<{ kind: 'invite' | 'reset'; username: string }>('GET', `/api/invite/${encodeURIComponent(token)}`),
  /** Chooses the password with the link, and signs in. */
  acceptInvite: (token: string, password: string) => request<SignInResult>('POST', `/api/invite/${encodeURIComponent(token)}`, { password }),
  /** Names of users and groups, to share with them. */
  directory: () => request<{ users: string[]; groups: string[] }>('GET', '/api/directory'),
  sessions: () => request<{ sessions: SessionInfo[] }>('GET', '/api/account/sessions').then((r) => r.sessions),
  endSession: (id: string) => request<{ ok: true }>('DELETE', `/api/account/sessions/${encodeURIComponent(id)}`),
  /** One of one's own notices (what the admin did to one's account, a purge of what one wrote), dismissed. */
  dismissNotice: (id: string) => request<{ ok: true }>('DELETE', `/api/account/notices/${encodeURIComponent(id)}`),
  /** The alert of a rewrite of vihko.yaml at start, dismissed (the admin, for every admin). */
  dismissConfigMigration: (id: string) => request<{ ok: true }>('DELETE', `/api/admin/config-migrations/${encodeURIComponent(id)}`),
  endOtherSessions: () => request<{ ended: number }>('DELETE', '/api/account/sessions'),
  /** Other sessions end; `wrong_password` if `current` isn't right. */
  changePassword: (current: string, password: string) => request<{ ok: true }>('POST', '/api/auth/password', { current, password }),
  users: () => request<{ users: UserInfo[] }>('GET', '/api/admin/users').then((r) => r.users),
  /** A new admin, with `confirm`: the admin's current code, or their password without a second factor. */
  createUser: (username: string, role: UserInfo['role'], confirm?: string) =>
    request<{ user: UserInfo; link: NewLink }>('POST', '/api/admin/users', { username, role, ...(confirm === undefined ? {} : { confirm }) }),
  /** A new link for them (an invitation, or a reset if they have a password); the earlier one stops working. */
  /** A new link; a reset (they have a password) is confirmed with `confirm` (D-040 3.1). */
  userLink: (id: string, confirm?: string) => request<{ link: NewLink; user: UserInfo }>('POST', `/api/admin/users/${encodeURIComponent(id)}/link`, confirm ? { confirm } : {}),
  setRole: (id: string, role: UserInfo['role'], confirm: string) => request<{ user: UserInfo }>('PUT', `/api/admin/users/${encodeURIComponent(id)}/role`, { role, confirm }).then((r) => r.user),
  disableUser: (id: string) => request<{ user: UserInfo }>('POST', `/api/admin/users/${encodeURIComponent(id)}/disable`).then((r) => r.user),
  /** A disabled admin, with `confirm`: the admin's current code, or their password without a second factor. */
  enableUser: (id: string, confirm?: string) =>
    request<{ user: UserInfo }>('POST', `/api/admin/users/${encodeURIComponent(id)}/enable`, confirm === undefined ? undefined : { confirm }).then((r) => r.user),
  deleteUser: (id: string) => request<{ ok: true }>('DELETE', `/api/admin/users/${encodeURIComponent(id)}`),
  endUserSessions: (id: string) => request<{ ended: number }>('DELETE', `/api/admin/users/${encodeURIComponent(id)}/sessions`),
  groups: () => request<{ groups: GroupInfo[] }>('GET', '/api/admin/groups').then((r) => r.groups),
  createGroup: (name: string) => request<{ group: GroupInfo }>('POST', '/api/admin/groups', { name }).then((r) => r.group),
  renameGroup: (id: string, name: string) => request<{ group: GroupInfo }>('PATCH', `/api/admin/groups/${encodeURIComponent(id)}`, { name }).then((r) => r.group),
  deleteGroup: (id: string) => request<{ ok: true }>('DELETE', `/api/admin/groups/${encodeURIComponent(id)}`),
  addMember: (group: string, userId: string) => request<{ group: GroupInfo }>('POST', `/api/admin/groups/${encodeURIComponent(group)}/members`, { userId }).then((r) => r.group),
  removeMember: (group: string, userId: string) => request<{ group: GroupInfo }>('DELETE', `/api/admin/groups/${encodeURIComponent(group)}/members/${encodeURIComponent(userId)}`).then((r) => r.group),
  /** A folder's permissions: the admin, or whoever manages it (403 if they see it, 404 if not). */
  permissions: (folder: string) => request<FolderPermissions>('GET', `/api/permissions?folder=${encodeURIComponent(folder)}`),
  /** Changes them: `grants` null inherits, `ai` false closes it to agents (null opens it); 412 if vihko.yaml changed since `ifMatch`. */
  setPermissions: (folder: string, change: { grants?: Grants | null; ai?: false | null }, ifMatch: string) =>
    request<FolderPermissions | { folder: string; etag: string; canEdit: false }>('PUT', '/api/permissions', { folder, ...change, ifMatch }),
  /** Folders with their locks and the person's level (the admin: every folder's name). */
  permissionFolders: () => request<{ folders: FolderLock[]; section: FolderPermissions['section'] }>('GET', '/api/permissions/folders'),
  /** The folders a person (the admin: anyone; others: themselves) or a key reaches. */
  access: (who: { user: string } | { key: string }) =>
    request<EffectiveAccess>('GET', `/api/permissions/access?${'user' in who ? `user=${encodeURIComponent(who.user)}` : `key=${encodeURIComponent(who.key)}`}`),
  adminSettings: () => request<AdminSettings>('GET', '/api/admin/settings'),
  /** A new second-factor policy is confirmed with `confirm` (D-040 3.4a). */
  setAdminSettings: (patch: Partial<AdminSettings> & { confirm?: string }) => request<AdminSettings>('PUT', '/api/admin/settings', patch),
  /** Takes someone's second factor away (the vihko admin). */
  resetTwoFactor: (id: string, confirm: string) => request<{ user: UserInfo }>('POST', `/api/admin/users/${encodeURIComponent(id)}/2fa/reset`, { confirm }).then((r) => r.user),
  twoFactor: () => request<TwoFactorInfo>('GET', '/api/account/2fa'),
  /**
   * A new secret: to set it up, with the password; to replace the
   * authenticator, with a code of the one in force (the app's, or a recovery code).
   */
  startTwoFactor: (proof: { password: string } | { code: string }) => request<TwoFactorSetup>('POST', '/api/account/2fa/setup', proof),
  /** A code from the new secret: now it's theirs; the recovery codes, shown once. */
  enableTwoFactor: (code: string) => request<{ recoveryCodes: string[] }>('POST', '/api/account/2fa/enable', { code }).then((r) => r.recoveryCodes),
  /** New recovery codes (the old ones stop working); `confirm`: the app's code or a recovery code, never the password. */
  newRecoveryCodes: (confirm: string) => request<{ recoveryCodes: string[] }>('POST', '/api/account/2fa/recovery', { confirm }).then((r) => r.recoveryCodes),
  /** Only while the admin doesn't require it; a code or a recovery code. */
  disableTwoFactor: (code: string) => request<{ ok: true }>('POST', '/api/account/2fa/disable', { code }),
}
