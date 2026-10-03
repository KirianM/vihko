// vihko API client. Cookie-based session (HttpOnly): the browser sends it on its own.
import type { Alert, ErrorCode } from '@vihko/core/codes'
import type { Language } from '@vihko/core/languages'
import type { Series } from '@vihko/core/series'

export type { Alert }

export class ApiError extends Error {
  readonly status: number
  /** Server error code (`not_found`, `precondition_failed`…) or `network`. */
  readonly code: string
  readonly etag: string | null
  /** Seconds to wait before trying again (429, from Retry-After), or null. */
  readonly retryAfter: number | null
  /** The error's whole answer, for the codes that carry more (`not_empty`'s `contents`). */
  readonly data: Record<string, unknown> | null
  constructor(status: number, code: string, message: string, etag: string | null = null, retryAfter: number | null = null, data: Record<string, unknown> | null = null) {
    super(message)
    this.status = status
    this.code = code
    this.etag = etag
    this.retryAfter = retryAfter
    this.data = data
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
      Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : null, data)
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
/** A note of the tree. `template`: it is a template (`template: true` in its frontmatter), offered when creating a note. */
export interface TreeNote { path: string; title: string; uid: string | null; aliases: string[]; template?: true }
/** What marking a folder's notes as templates does, or would do: marked, already marked, skipped (a frontmatter that can't be read). */
export interface TemplatesMarked { marked: number; already: number; skipped: number }
export interface Note {
  path: string
  text: string
  etag: string
  meta: { title: string; uid: string | null; fmError: string | null } | null
  /** Whether its text hides it from every agent: `ai: false` (or any doubt), or a frontmatter that can't be read. */
  hiddenFromAgents: 'ai' | 'frontmatter' | null
  /** What the person may do where it is: below `edit`, the editor is read-only. */
  level?: Level
  /** Larger than vihko.yaml's `notes.maxSize`: never opened in the live editor, shown as plain text with a download. */
  tooLarge?: true
}

/** A shared space deleted that the person may restore whole (GET /api/spaces/deleted). */
export interface DeletedSpace { id: string; path: string; name: string; by: string; deletedAt: string; entries: number }

/** Whether a level lets the person write the note (`Level`, below: from less to more). */
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
  /** A link to what the person can't read is `missing`, as one to a note that doesn't exist, so links can't probe for notes. */
  status: 'resolved' | 'ambiguous' | 'missing'
  dstPath: string | null
  candidates: string[] | null
  /** Where the link starts in the note as indexed (a hint to find that occurrence). */
  posFrom: number
  /** It leads to the note it is in (`[[#Heading]]`, its own name): the editor shows its state, the links panel leaves it out. */
  self?: true
  /** It leads to a file that isn't a note (`[[invoice.pdf]]`): `dstPath` is the file. */
  file?: true
}
/** A note's links: outgoing, backlinks and the titles of ambiguous links' candidates. */
export interface NoteLinks { outgoing: OutgoingLink[]; backlinks: Backlink[]; titles: Record<string, string> }
export interface Backlink { path: string; title: string; raw: string; context: string }
/** A comment thread's text as the index first saw it; `changed` compares it with the saved note. */
export interface CommentOriginal { id: string; original: string; changed: boolean }
export interface SearchResult { path: string; title: string; snippet: string }
/** Search results; the snippet highlight uses control characters, not HTML. */
export interface SearchResponse { results: SearchResult[]; highlight?: { start: string; end: string } }

/** A link's resolution in a move report: where it leads, among which notes it is ambiguous, or broken. */
export type LinkState = { status: 'resolved'; path: string } | { status: 'ambiguous'; candidates: string[] } | { status: 'missing' }
/**
 * A link a move leaves as it is but whose resolution changes:
 * `resolves` (it was ambiguous or broken), `ambiguous`, `retargets` or `breaks`.
 * `before` in the paths before the move, `after` in those after it.
 */
export interface Shift { raw: string; code: 'resolves' | 'ambiguous' | 'retargets' | 'breaks'; before: LinkState; after: LinkState }
/** Those links, by source note. */
export interface ShiftGroup { path: string; links: number; changes: Shift[] }

/** One rewrite in a note: its text before and after, and the note (`link`) or image (`image`) it keeps leading to. */
export interface RelinkChange { before: string; after: string; kind: 'link' | 'image'; to: string }
/**
 * A link a move to another space leaves broken (a link never leads
 * to another space): in `path` (where that note is after the move), to `to`
 * (where the note it led to is after the move).
 */
export interface BrokenLink { path: string; to: string }

/** What a rename or move does (or would do, with `dryRun`). */
export interface MoveReport {
  from: string
  to: string
  relinked: { path: string; links: number; changes: RelinkChange[] }[]
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
    /** Going to another space: images it shares with notes that stay are copied there. */
    copied?: { from: string; to: string }[]
    stayed: { path: string; reason: 'shared' | 'elsewhere' }[]
    /** In per-note mode (vihko.yaml), the note's folder of images, which moves with it whole. */
    folder: { from: string; to: string; files: number } | null
    failed: { path: string; to: string | null; outcome: 'stayed' | 'copied'; error: ErrorCode; message: string }[]
  }
  /** In a dry run, whose access changes: the UI asks before moving. */
  audience?: AudienceChange
  /** To another space: the links it leaves broken. */
  brokenLinks?: BrokenLink[]
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
  /** Going to another space: images its notes share with notes that stay, copied there. */
  images?: { copied: { from: string; to: string }[]; failed: MoveReport['images']['failed'] }
  /** In a dry run, whose access changes: the UI asks before moving. */
  audience?: AudienceChange
  /** To another space: the links it leaves broken. */
  brokenLinks?: BrokenLink[]
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
export interface TrashEntry { id: string; path: string; deletedAt: string; kind?: 'files'; files?: { path: string }[]; space?: string | null }
/** Who deleted a trash entry, by their name now. */
export type DeletedBy =
  | { kind: 'user'; id: string; name: string }
  | { kind: 'agent'; id: string; name: string; onBehalfOf: { id: string; name: string } }
  | { kind: 'system'; name: string }
/**
 * A trash entry as the trash screen lists it: what it takes (`bytes`, of
 * what the person sees of it), who deleted it, whether they may restore it
 * and delete it for good, when the retention takes it (null: never), and
 * the deleted space it belongs to, when it's shown as part of that.
 */
export interface TrashListed extends TrashEntry {
  space: string | null
  deletedBy: DeletedBy
  bytes: number
  canRestore: boolean
  canDelete: boolean
  expiresAt: string | null
  deletedSpace?: string
}
/** A deleted shared space in the trash, restored (or deleted for good) whole; `bytes` only for who managed it. */
export interface TrashSpace extends DeletedSpace { bytes: number | null; canRestore: boolean; canDelete: boolean; expiresAt: string | null }
/** GET /api/trash: what this person sees in the trash, and what it takes; `retentionDays`: the admin's retention (null: off). */
export interface TrashView { entries: TrashListed[]; spaces: TrashSpace[]; bytes: number; retentionDays: number | null }
/** What emptying the trash deletes (or would): entries and deleted spaces, their size, and how many this person may only restore (`kept`). */
export interface TrashEmptied { entries: number; spaces: number; bytes: number; kept: number }
/**
 * What a folder holds, as `not_empty` says when it can't just be deleted
 * (paths relative to it, each list capped: `total` says how many). `hidden`:
 * its hidden folders (`.obsidian/`…), which vihko doesn't show and which go
 * to the trash with it (`files`: how many files they hold). `kept`: links
 * vihko never follows, which keep the folder from going. Whoever deletes a
 * folder sees all of it.
 */
export interface FolderContents {
  notes: { total: number; paths: string[] }
  files: { total: number; paths: string[] }
  hidden: { total: number; paths: string[]; files: number }
  kept: { total: number; paths: string[] }
}
/** Installation settings the UI needs. */
export interface ServerConfig {
  externalImages: 'allow' | 'ask' | 'block'
  maxImageBytes: number
  /** The second factor's secrets are stored encrypted (VIHKO_SECRET_KEY). */
  secretsEncrypted?: boolean
  /** vihko's version (the root package.json's). */
  version?: string
}
/** A stored image: `path` from the notes root, `src` relative to the note (to link it). */
export interface Attachment { path: string; src: string }
/** What the UI needs from vihko.yaml: daily-note series. */
export interface WorkspaceInfo {
  daily: Series[]
  /** `aliases`: whether aliases resolve links (vihko.yaml `links.aliases`). */
  links: { aliases: boolean }
}
/** The person's own settings (state.db). `language`: the UI's, null = automatic (the browser's). */
/** What vihko opens when the person comes in: Home, this device's last note, a note they chose, or today's note if it exists. */
export type OnOpen = 'home' | 'last' | 'note' | 'daily'
export interface Profile { timezone: string | null; dailySeries: string | null; onOpen: OnOpen; onOpenNote: string | null; openDailyOnStart: boolean; language: Language | null }

/** Note settings of a person or a shared space (GET/PUT /api/settings): paths inside the space. */
export interface NoteSettingsForm {
  version: number
  daily: { id: string; label: string | null; folder: string; name: string; template: string | null }[]
  attachments: { mode: 'next-to-note' } | { mode: 'folder'; folder: string } | { mode: 'per-note'; suffix: string } | null
  /** A person's own: the note with their guide for agents. */
  agents: string | null
  /** A shared space's: its guide for agents, the text. */
  guide: string | null
}
export interface SettingsProblem { code: string; at: string | null; line: number | null; detail: string | null }
export interface SettingsView { space: string; etag: string; settings: NoteSettingsForm; errors: SettingsProblem[]; guideMissing: boolean; canEdit: boolean }

/** «Home» (GET /api/home): only what the person reads now. */
export interface HomeNote { path: string; title: string; at: string }
export interface HomeView {
  recent: HomeNote[]
  changed: (HomeNote & { by: { kind: 'user' | 'agent' | 'external'; name: string | null; onBehalfOf?: string } | null })[]
  shared: { kind: 'space' | 'folder'; path: string; name: string; owner: string | null; by: string; at: string }[]
}

/**
 * The integration switches: the API with keys and the MCP server,
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
  /** For the admin: how many keys and apps members have, which turning `membersCanCreateKeys` off suspends. */
  memberKeys?: number
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
  /** `suspended`: a member's, while the admin doesn't let members have keys (it works again once they do). */
  status: 'active' | 'expired' | 'revoked' | 'suspended'
  /** An OAuth authorization: the client it was given to and where it goes back to. Null for a key. */
  client: { id: string; redirectUris: string[] } | null
  /** Rotated a moment ago: until when the key it replaced still works. */
  previousUntil: string | null
}
/** In the admin's list of everyone's keys, each one with its user. */
/** Someone's key as the admin lists them: its folders only those the admin reads too, `foldersHidden` when it has others. */
export interface KeyWithUser extends KeyInfo { user: { id: string; username: string }; foldersHidden: boolean }
/** What a key is created or changed with; `expiresAt: null` takes the expiry away. */
export interface KeyInput { name?: string; canWrite?: boolean; folders?: string[]; expiresAt?: string | null }
/** An OAuth client asking for access (the consent page): its name, where it goes back to, and whether this person may authorize it. */
/** An authorization request: who asks (`host`: the domain that described it, for a client named by its metadata document; null if it registered itself) and whether this person may authorize. */
/**
 * An authorization request as the consent page shows it. `domain`: where the
 * app comes from (its metadata document's host, or, for one that registered
 * itself, where it goes back to); `nameMatchesDomain`: false when its declared
 * name doesn't fit that domain (and vihko.yaml lists no domains).
 */
export interface OAuthRequest { client: { id: string; name: string; redirectUri: string; host: string | null; domain: string; nameMatchesDomain: boolean }; canAuthorize: boolean }

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
  /** Whether they set up a second factor, and since when. */
  twoFactor: { enabled: boolean; enabledAt: string | null }
}
/** A folder permission level, from less to more. */
export type Level = 'read' | 'comment' | 'edit' | 'manage'
export const LEVELS: readonly Level[] = ['read', 'comment', 'edit', 'manage']
export const atLeast = (have: Level | null | undefined, need: Level) => have != null && LEVELS.indexOf(have) >= LEVELS.indexOf(need)
/** A user name or `@group`, with its level. */
export type Grants = Record<string, Level>
/** Why someone has access: a grant to them or a group of theirs, written for `from`; `owner` when it's their own space. */
export interface GrantSource { subject: string; level: Level; from: string; owner?: true }
/**
 * Who a folder is shared with (GET /api/permissions): its own grants,
 * those of the folders above it in its space (they only add: they can't be
 * taken away here), whose personal space it is in or which shared space, and
 * who has access and why.
 */
export interface FolderPermissions {
  folder: string
  /** vihko.yaml's ETag: a change names it (412 if the file changed). */
  etag: string
  /** `none`: nothing written yet (the first change writes it); `closed`: rejected, nothing is shared until it's fixed. */
  section: 'rules' | 'none' | 'closed'
  /** The grants written for this folder (null: none). */
  own: { grants: Grants | null }
  /** The grants of the folders above it in its space, from the space's root down. */
  inherited: { from: string; grants: Grants }[]
  /** Whose personal space it is in; null in a shared space. */
  owner: string | null
  /** The shared space it is in; null in a personal space. */
  space: { path: string; name: string | null } | null
  ai: { closed: boolean; from: string | null }
  canEdit: boolean
  access: { id: string; username: string; level: Level; via: GrantSource[] }[]
}

/** A shared space the person belongs to (GET /api/spaces). */
export interface SpaceEntry { path: string; name: string; level: Level; managers: string[]; aiClosed: boolean }
/** A folder someone shares with the person outside their spaces: of someone's personal space (`owner`) or of a shared space they don't belong to (`space`). */
export interface SharedEntry { path: string; level: Level; owner?: string; space?: { path: string; name: string }; pinned: boolean }
/** What a person reaches, space by space (GET /api/spaces). */
export interface SpacesInfo {
  personal: { path: string } | null
  spaces: SpaceEntry[]
  shared: SharedEntry[]
  /** Whether they may create a shared space (the admin's setting). */
  canCreate: boolean
}
/**
 * Who has access to a folder the person reads (GET /api/spaces/members):
 * each one with their level and why; `from` null where the grant
 * is written in a folder the person doesn't read.
 */
export interface MembersView {
  path: string
  space: { path: string; name: string } | null
  owner: string | null
  members: { username: string; level: Level; via: { subject: string; level: Level; from: string | null; owner?: true }[] }[]
}
/** A shared space in the admin's directory: its name, managers and how many members; never anything inside it. */
export interface SpaceInfo { path: string; name: string; managers: string[]; members: number; aiClosed: boolean }
/** A deleted person's personal space, closed: nobody sees it, not even the admin. */
export interface ClosedSpace { userId: string; username: string; path: string }
/** What a person's space shares, before deleting them: counts, and each shared folder with its people (its path only where the admin reads it). */
export interface PersonalSummary { path: string; exists: boolean; sharedFolders: number; people: number; shared: { path: string | null; people: { username: string; level: Level }[] }[] }
/** What becoming of a deleted person's space involves: counts only. */
export interface PersonalSpacePlan { action: 'transfer' | 'convert' | 'delete'; from: string; to: string | null; notes: number; files: number; sharedFolders: number; people: number }
/** A folder's lock and the person's level in it (GET /api/permissions/folders). */
export interface FolderLock { path: string; level: Level | null; ownGrants: boolean; aiClosed: boolean; canEdit: boolean }
/** What a person or a key reaches, folder by folder. */
export interface EffectiveAccess { user: { id: string; username: string }; key: { id: string; name: string } | null; folders: { folder: string; level: Level }[] }
/** Who gains or loses access with a move (users and groups named, keys counted). */
export interface AudienceChange {
  users: { gain: { id: string; username: string }[]; lose: { id: string; username: string }[] }
  groups: { gain: string[]; lose: string[] }
  keys: { gain: number; lose: number }
  /** Whose it is before and after, when the move changes its space; null when it stays in its space. */
  owner?: { before: SpaceOwner; after: SpaceOwner } | null
}
/** Whose a path is: a person's space (`owner`) or a shared space (its root and name). */
export type SpaceOwner = { kind: 'personal'; owner: string } | { kind: 'shared'; path: string; name: string } | null

/** A new one-time link, shown once: `url` with VIHKO_PUBLIC_URL, otherwise this origin + `path`. */
export interface NewLink { token: string; kind: 'invite' | 'reset'; expiresAt: string; path: string; url: string | null }
export interface GroupInfo { id: string; name: string; members: { id: string; username: string }[] }
/** The second factor's policy: required, optional (the default) or disabled. */
export type TwoFactorPolicy = 'required' | 'optional' | 'disabled'
/** The admin's settings: members downloading images from the local network (off by default), and the second factor's policy. */
export interface AdminSettings {
  membersLocalDownloads: boolean
  twoFactor: TwoFactorPolicy
  spacesCreation: 'everyone' | 'admins'
  /** Trash entries older than this many days are removed at night; null: never. */
  trashRetentionDays: number | null
  /** History versions older than this many days are removed at night (each note keeps its current one); null: never. */
  historyRetentionDays: number | null
}

/** What a retention run removes, or would (counts and sizes; `history` null: no managed history to thin). */
export interface RetentionCounts { trash: { entries: number; bytes: number }; history: { versions: number; bytes: number } | null }
/** The retention's last run, the next one (ISO; null while both settings are off), and whether the history is vihko's own. */
export interface RetentionStatus { lastRun: (RetentionCounts & { at: string; failed: boolean }) | null; nextRun: string | null; history: boolean }
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
  /** Whether what confirms at the moment asks now: not while a confirmation of this browser session lasts (`confirmedUntil`). */
  confirmNeeded: boolean
  confirmedUntil: string | null
}
/** One of one's own sessions. */
export interface SessionInfo { id: string; createdAt: string; lastSeenAt: string; expiresAt: string; userAgent: string | null; current: boolean }

let config: Promise<ServerConfig> | null = null

const started = <R>(r: R | { job: MoveJob }): MoveStart<R> => (r !== null && typeof r === 'object' && 'job' in r ? { job: r.job } : { report: r as R })

/**
 * The keys made in this tab: its own notice of each (`account_key_added`, sent
 * however a key is made) goes to the notices, not to a toast over what the
 * person just did.
 */
export const keysMadeHere = new Set<string>()

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
  /** Marks every note of a folder (subfolders too) as a template; `dryRun` only counts. */
  markFolderTemplates: (path: string, dryRun = false) => request<TemplatesMarked>('POST', '/api/folder/templates', { path, dryRun }),
  /** Makes a note a template, or stops it being one: only its `template: true` changes. */
  markTemplate: (path: string, template: boolean) => request<{ etag?: string }>('POST', '/api/note/template', { path, template }),
  /**
   * An empty folder; with `trash`, its notes and files go to the trash first
   * (`trashed`, the entries). Otherwise `not_empty`, with what it holds in the
   * error's `data.contents` (FolderContents).
   */
  deleteFolder: (path: string, trash = false) =>
    request<{ path: string; trashed: TrashEntry[] }>('DELETE', `/api/folder?path=${encodeURIComponent(path)}${trash ? '&trash=true' : ''}`),
  /** What deleting a folder (or a space's root) would take, deleting nothing: for its dialog to name it first. */
  folderContents: (path: string) =>
    request<{ path: string; contents: FolderContents }>('DELETE', `/api/folder?path=${encodeURIComponent(path)}&dryRun=true`).then((r) => r.contents),
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
  /**
   * `freshUid`: the text may carry another note's uid (a copy): it gets a new
   * one. `fromLink`: the note whose broken link this creates (never allowed in
   * someone else's personal space: there a link that looks
   * broken may lead to a note this person can't read).
   */
  createNote: (path: string, text: string, opts: { freshUid?: boolean; fromLink?: string } = {}) => request<{ path: string; etag: string; uid: string | null }>('POST', '/api/note', { path, text, ...opts }),
  /** A new note with the text of the template note, its variables filled in by the server. */
  createFromTemplate: (path: string, template: string, opts: { fromLink?: string } = {}) => request<{ path: string; etag: string; uid: string | null }>('POST', '/api/note', { path, template, ...opts }),
  /** What the person reaches: their space, the shared spaces they belong to, what's shared with them. */
  spaces: () => request<SpacesInfo>('GET', '/api/spaces'),
  /** A new shared space; whoever creates it manages it. */
  createSpace: (name: string, members: Grants = {}) => request<{ space: SpaceEntry }>('POST', '/api/spaces', { name, members }).then((r) => r.space),
  /** «Move to a new space»: the folder becomes a shared space of its own, named `name`; `dryRun`: the move's preview. */
  spaceFromFolder: (path: string, name: string, dryRun = false) => request<{ space?: SpaceEntry; report: FolderMoveReport }>('POST', '/api/spaces/from-folder', { path, name, dryRun }),
  renameSpace: (path: string, name: string) => request<{ space: SpaceEntry }>('POST', '/api/spaces/rename', { path, name }).then((r) => r.space),
  /** A shared space and everything in it (to the trash with `trash`); `deleted` restores it whole. */
  deleteSpace: (path: string, trash = true) => request<{ path: string; deleted: string }>('DELETE', `/api/spaces?path=${encodeURIComponent(path)}${trash ? '&trash=true' : ''}`),
  /** The deleted spaces this person may restore whole (who managed them; the admin, every one). */
  deletedSpaces: () => request<{ spaces: DeletedSpace[] }>('GET', '/api/spaces/deleted').then((r) => r.spaces),
  /** A deleted space back whole, with its members (`space_name_taken` while another space has its name). */
  restoreSpace: (id: string) => request<{ space: { path: string; name: string }; restored: number; missing: number }>('POST', '/api/spaces/restore', { id }),
  /** vihko.yaml's last permissions that shared something, written back (`permissions_missing`), confirmed at the moment. */
  restorePermissions: (confirm: string) => request<{ ok: true; folders: number }>('POST', '/api/admin/permissions/restore', { confirm }),
  /** The `permissions_missing` alert dismissed: the kept permissions are forgotten. */
  dismissMissingPermissions: () => request<{ ok: true }>('DELETE', '/api/admin/permissions/restore'),
  /** Leaves a space, or stops seeing a folder shared with one (`leave_via_group` through a group). */
  leaveSpace: (path: string) => request<{ path: string }>('POST', '/api/spaces/leave', { path }),
  /** Who has access to a folder one reads (a space's members); not_found for anything one doesn't. */
  members: (path: string) => request<MembersView>('GET', `/api/spaces/members?path=${encodeURIComponent(path)}`),
  pinShared: (path: string, pinned: boolean) => request<{ path: string; pinned: boolean }>('POST', '/api/spaces/pin', { path, pinned }),
  /** The admin: every shared space (names, managers, how many members) and deleted people's closed spaces. */
  adminSpaces: () => request<{ spaces: SpaceInfo[]; closed: ClosedSpace[] }>('GET', '/api/admin/spaces'),
  assignManager: (path: string, userId: string, confirm: string) => request<{ space: SpaceInfo }>('POST', '/api/admin/spaces/managers', { path, userId, confirm }).then((r) => r.space),
  joinSpace: (path: string, level: Level, confirm: string) => request<{ space: SpaceInfo }>('POST', '/api/admin/spaces/join', { path, level, confirm }).then((r) => r.space),
  /** Before deleting someone: what their space shares, as counts, and who has access to what (a folder's path only where the admin reads it). */
  personalSummary: (userId: string) => request<PersonalSummary>('GET', `/api/admin/users/${encodeURIComponent(userId)}/space`),
  /**
   * A deleted person's closed space: transferred, made a shared space or deleted (`dryRun`: what it would do).
   * With `deleteUser`, a disabled person not deleted yet: deleted, and their space transferred or converted at once.
   */
  settleSpace: (userId: string, input: { action: PersonalSpacePlan['action']; to?: string; name?: string; members?: Grants; dryRun?: boolean; confirm?: string; deleteUser?: boolean }) =>
    request<{ plan: PersonalSpacePlan }>('POST', `/api/admin/users/${encodeURIComponent(userId)}/space`, input).then((r) => r.plan),
  workspace: () => request<WorkspaceInfo>('GET', '/api/workspace'),
  profile: () => request<Profile>('GET', '/api/profile'),
  home: () => request<HomeView>('GET', '/api/home'),
  settings: (space?: string) => request<SettingsView>('GET', `/api/settings${space ? `?space=${encodeURIComponent(space)}` : ''}`),
  /** `remove`: keys vihko doesn't know (as `errors` names them) to remove from the file. */
  saveSettings: (space: string | null, settings: NoteSettingsForm, ifMatch: string, remove: string[] = []) => request<SettingsView>('PUT', '/api/settings', { ...(space ? { space } : {}), settings, ifMatch, ...(remove.length ? { remove } : {}) }),
  updateProfile: (patch: Partial<Profile>) => request<Profile>('PUT', '/api/profile', patch),
  /** Where today's note is and whether it exists; creates nothing. */
  today: () => request<{ series: string; path: string; exists: boolean }>('GET', '/api/daily'),
  /** Opens today's note, creating it from its template if it doesn't exist. */
  openToday: () => request<{ series: string; path: string; created: boolean }>('POST', '/api/daily', {}),
  orphan: (path: string, action: 'restore' | 'discard') => request<{ ok: true }>('POST', '/api/note/orphan', { path, action }),
  /** Notes held after moving outside vihko (held, so the move opens nothing to anyone): move the folder's permissions with them, or release them. */
  held: (id: string, action: 'release') => request<{ ok: true }>('POST', `/api/permissions/holds/${encodeURIComponent(id)}`, { action }),
  move: (from: string, to: string, dryRun = false) => request<MoveReport>('POST', '/api/note/move', { from, to, dryRun }),
  /** Moves a note; if rewriting the links takes long, they go on in the background (a job). */
  startMove: (from: string, to: string) => request<MoveReport | { job: MoveJob }>('POST', '/api/note/move', { from, to, background: true }).then(started<MoveReport>),
  trash: (path: string) => request<TrashEntry>('DELETE', `/api/note?path=${encodeURIComponent(path)}`),
  /** The trash as this person sees it: what they may restore. */
  trashEntries: () => request<{ entries: TrashEntry[] }>('GET', '/api/trash').then((r) => r.entries),
  /** Asked once per page load: it only changes when the server restarts. */
  config: () => (config ??= request<ServerConfig>('GET', '/api/config').catch((err) => { config = null; throw err })),
  uploadImage: (note: string, file: Blob) =>
    request<Attachment>('POST', `/api/attachments?note=${encodeURIComponent(note)}`, file, { 'content-type': file.type || 'application/octet-stream' }),
  fetchImage: (note: string, url: string) => request<Attachment>('POST', '/api/attachments/fetch', { note, url }),
  /**
   * A trash entry back (to `to`, another name or place, when given): `files`
   * where each landed (another name if its own was taken), `left` those that
   * stay in the trash. A note whose name is taken is `exists`.
   */
  restore: (id: string, to?: string) => request<{ path: string; etag: string | null; files: { from: string; to: string }[]; left: string[] }>('POST', `/api/trash/${encodeURIComponent(id)}/restore`, to === undefined ? undefined : { to }),
  /** The trash screen: entries, deleted spaces, sizes and the retention. */
  trashView: () => request<TrashView>('GET', '/api/trash'),
  /** One entry deleted for good; `confirm`: the code or password, unless a confirmation lasts. */
  discardTrash: (id: string, confirm?: string) => request<{ entries: number; bytes: number }>('DELETE', `/api/trash/${encodeURIComponent(id)}`, { confirm }),
  /** A deleted space deleted for good, by who managed it. */
  discardSpace: (id: string, confirm?: string) => request<{ entries: number; bytes: number }>('DELETE', `/api/spaces/deleted/${encodeURIComponent(id)}`, { confirm }),
  /** Everything this person may delete for good (in one space, with `space`); `dryRun`: what it would. */
  emptyTrash: (opts: { space?: string; dryRun?: boolean; confirm?: string }) => request<TrashEmptied>('POST', '/api/trash/empty', opts),
  integrations: () => request<Integrations>('GET', '/api/integrations'),
  /** The vihko admin only; turning the API or MCP on while the server locks them gives `integrations_locked`. */
  setIntegrations: (patch: Partial<Pick<Integrations, 'api' | 'mcp' | 'membersCanCreateKeys' | 'oauthRegistration'>>) => request<Integrations>('PUT', '/api/admin/integrations', patch),
  /** This person's keys, newest first (revoked ones too). */
  keys: () => request<{ keys: KeyInfo[] }>('GET', '/api/keys').then((r) => r.keys),
  /** Everyone's keys, with their user: the vihko admin only. */
  allKeys: () => request<{ keys: KeyWithUser[] }>('GET', '/api/keys?all=1').then((r) => r.keys),
  /** A new key: the token comes back this once and never again. */
  /** `confirm`: the current code, or the password without a second factor. */
  createKey: (input: KeyInput & { name: string; confirm: string }) => request<{ key: KeyInfo; token: string }>('POST', '/api/keys', input).then((r) => { keysMadeHere.add(r.key.name); return r }),
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
  /** The alert of a migration of state.db at start, dismissed (the admin, for every admin). */
  dismissStateMigration: (id: string) => request<{ ok: true }>('DELETE', `/api/admin/state-migrations/${encodeURIComponent(id)}`),
  endOtherSessions: () => request<{ ended: number }>('DELETE', '/api/account/sessions'),
  /**
   * A new password. `endSessions` signs out one's other sessions (never this
   * one); `revokeKeys` revokes one's keys and authorised apps. `wrong_password`
   * if `current` isn't right.
   */
  changePassword: (current: string, password: string, also: { endSessions: boolean; revokeKeys: boolean }) =>
    request<{ ok: true; sessionsEnded: number; keysRevoked: number }>('POST', '/api/auth/password', { current, password, endSessions: also.endSessions, revokeKeys: also.revokeKeys }),
  users: () => request<{ users: UserInfo[] }>('GET', '/api/admin/users').then((r) => r.users),
  /**
   * A new admin, with `confirm`: the admin's current code, or their password without a second factor.
   * `adopt`: their folder already in people/, with something in it, becomes theirs (never by default).
   */
  createUser: (username: string, role: UserInfo['role'], confirm?: string, adopt = false) =>
    request<{ user: UserInfo; link: NewLink }>('POST', '/api/admin/users', { username, role, ...(confirm === undefined ? {} : { confirm }), ...(adopt ? { adopt: true } : {}) }),
  /** Someone who hasn't used their invitation yet, renamed (`not_invited` otherwise). */
  renameUser: (id: string, username: string) => request<{ user: UserInfo }>('PUT', `/api/admin/users/${encodeURIComponent(id)}/username`, { username }).then((r) => r.user),
  /** A new link for them (an invitation, or a reset if they have a password); the earlier one stops working. */
  /** A new link; a reset (they have a password) is confirmed with `confirm`. */
  userLink: (id: string, confirm?: string) => request<{ link: NewLink; user: UserInfo }>('POST', `/api/admin/users/${encodeURIComponent(id)}/link`, confirm ? { confirm } : {}),
  setRole: (id: string, role: UserInfo['role'], confirm: string) => request<{ user: UserInfo }>('PUT', `/api/admin/users/${encodeURIComponent(id)}/role`, { role, confirm }).then((r) => r.user),
  /** Confirmed with `confirm`: the admin's current code, or their password without a second factor. */
  disableUser: (id: string, confirm: string) => request<{ user: UserInfo }>('POST', `/api/admin/users/${encodeURIComponent(id)}/disable`, { confirm }).then((r) => r.user),
  /** A disabled admin, with `confirm`: the admin's current code, or their password without a second factor. */
  enableUser: (id: string, confirm?: string) =>
    request<{ user: UserInfo }>('POST', `/api/admin/users/${encodeURIComponent(id)}/enable`, confirm === undefined ? undefined : { confirm }).then((r) => r.user),
  /** Confirmed as `disableUser` is. */
  deleteUser: (id: string, confirm: string) => request<{ ok: true }>('DELETE', `/api/admin/users/${encodeURIComponent(id)}`, { confirm }),
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
  /** A new second-factor policy, or a retention turned on or shortened, is confirmed with `confirm`. */
  setAdminSettings: (patch: Partial<AdminSettings> & { confirm?: string }) => request<AdminSettings>('PUT', '/api/admin/settings', patch),
  retentionStatus: () => request<RetentionStatus>('GET', '/api/admin/retention'),
  /** What the next run would remove with these periods (null: off). */
  retentionPreview: (periods: { trashRetentionDays: number | null; historyRetentionDays: number | null }) => request<RetentionCounts>('POST', '/api/admin/retention/preview', periods),
  /** A run now, with the settings in force, confirmed with the admin's code or password: what it removed. */
  retentionRun: (confirm: string) => request<RetentionCounts & { at: string; failed: boolean }>('POST', '/api/admin/retention/run', { confirm }),
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
