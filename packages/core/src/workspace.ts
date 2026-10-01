// vihko.yaml: the workspace configuration, at the root of the notes folder so
// it travels (and is versioned) with the notes (D-011, D-014). vihko only
// writes its `permissions` section, from the permissions UI (permissions.ts),
// keeping the rest of the file as it was. Parsing is tolerant where it can be
// and strict where it must (D-031.9):
// - An unknown key (a typo, or a newer vihko's setting) is reported and
//   ignored; the rest applies. So is a `version` newer than this vihko's.
// - A wrong value in a known key makes the file unusable: vihko keeps the last
//   valid configuration, so a mistyped setting never silently turns into
//   another one.
// - Security-relevant sections (`permissions`) are strict sections: any
//   doubt about one invalidates that section alone, which then applies its most
//   restrictive setting.
import { LineCounter, isMap, isScalar, isSeq, type Document } from 'yaml'
import { parseYamlDocument } from './yaml.ts'
import { NO_PERMISSIONS, CLOSED_PERMISSIONS, parsePermissions, type Permissions } from './permissions.ts'
import { patternPeriod, patternTokens, seriesPath, type Series } from './series.ts'
import { classifyPath } from './paths.ts'
import { globProblem } from './glob.ts'
import { toData } from './frontmatter.ts'
import { trimTrailingSlashes } from './paths.ts'
import { WORKSPACE_VERSION } from './workspaceMigrations.ts'

/** Name of the file at the root of the notes folder. */
export const WORKSPACE_FILE = 'vihko.yaml'

/** The newest `version` of vihko.yaml this vihko understands: the format its migrations bring files to (workspaceMigrations.ts). */
export { WORKSPACE_VERSION }

export interface WorkspaceConfig {
  /**
   * Folders holding the templates offered when creating a note, in the order
   * written (empty: none). vihko.yaml takes one folder or a list; each may
   * hold `{user}`, the person creating the note (`people/{user}/Templates`).
   */
  templates: string[]
  /** Daily-note series, in the order declared (the first is the default). */
  daily: Series[]
  /** Where new images go (D-028, D-031.5). */
  attachments: AttachmentsConfig
  /**
   * How links resolve. `aliases`: whether a note's frontmatter aliases
   * resolve `[[links]]` (D-019, D-031.1). Off, `[[alias]]` is broken, as in
   * Obsidian, and the editor inserts `[[Note|alias]]`.
   */
  links: { aliases: boolean }
  /** Note history (D-016, D-032): how it's kept and the largest file it takes. */
  history: HistoryConfig
  /** The MCP server (M3): what it tells the agents that connect. */
  mcp: McpConfig
}

/**
 * The MCP server (`mcp` in vihko.yaml):
 * - `instructions`: a note of the workspace served to agents as the server's
 *   instructions (how this workspace is organised, what to write where), to
 *   an agent that can read it. Null: only vihko's own.
 */
export interface McpConfig {
  instructions: string | null
}

/**
 * Note history (`history` in vihko.yaml):
 * - `mode`: `managed` (the default: vihko keeps its own repository in the
 *   state volume), `unmanaged` (vihko only reads the repository the notes
 *   folder already has) or `off`.
 * - `maxFileSize`: in MB; a larger file doesn't enter the history.
 * - `exclude`: path patterns (glob.ts) kept out of the managed history. vihko
 *   still indexes, shows and edits those files; their changes just aren't
 *   versions. What the history already holds stays (`vihko history purge`
 *   removes it).
 */
export interface HistoryConfig {
  mode: HistoryMode
  maxFileSize: number
  exclude: string[]
}

export type HistoryMode = 'managed' | 'unmanaged' | 'off'

export const HISTORY_MODES: readonly HistoryMode[] = ['managed', 'unmanaged', 'off']

/** Largest file the history takes by default, in MB: the same as uploads. */
export const DEFAULT_HISTORY_MAX_FILE_MB = 20

/**
 * Where new images go. Three modes, chosen with `attachments.mode`:
 * - next to the note (the default: `folder` null, no `perNote`);
 * - a fixed folder (`folder`; `mode: folder`, implied when only `folder` is given);
 * - a folder per note (`perNote`, the suffix of its name: `plan.md` →
 *   `plan.assets/` with the default `.assets`), which moves with the note.
 */
export interface AttachmentsConfig {
  folder: string | null
  /** `mode: per-note`: the suffix of each note's own folder (`suffix`, `.assets` by default). */
  perNote?: string
}

/** Suffix of a note's attachments folder in `per-note` mode, unless `attachments.suffix` says otherwise. */
export const DEFAULT_ATTACHMENTS_SUFFIX = '.assets'

export const EMPTY_WORKSPACE: WorkspaceConfig = {
  templates: [], daily: [], attachments: { folder: null }, links: { aliases: true },
  history: { mode: 'managed', maxFileSize: DEFAULT_HISTORY_MAX_FILE_MB, exclude: [] },
  mcp: { instructions: null },
}

/**
 * A problem in vihko.yaml. Stable codes; the UI words them.
 *
 * Errors (the file can't be used; the last valid configuration stays):
 * - `yaml`: not valid YAML (`detail` is the parser's message, for developers).
 * - `not_a_map`: the file (or a section) isn't a set of `key: value`.
 * - `invalid_version`: `version` isn't a whole number from 1 up.
 * - `invalid_type`: a value of the wrong kind (`detail`: what was expected).
 * - `not_boolean`: a switch that isn't `true` or `false`.
 * - `invalid_path`: a folder or note path that isn't relative to the notes
 *   root, climbs out of it or goes through a hidden folder.
 * - `invalid_id`: a series key that isn't letters, digits, `-` or `_`.
 * - `pattern_token`: an unknown `{token}` in a series pattern (`detail`).
 * - `pattern_period`: a series pattern that doesn't name one note per day,
 *   ISO week, month or year.
 * - `unreadable`: the file exists but can't be read (permissions).
 * - `invalid_value`: a value vihko doesn't accept there (`detail`: what it
 *   accepts, or the key it needs), such as an unknown attachments `mode`.
 * - `invalid_pattern`: a path pattern that isn't relative to the notes root
 *   or uses what vihko's globs don't (`detail`: the pattern).
 *
 * Warnings (the file applies without that part):
 * - `unknown_key`: a key vihko doesn't know (a typo, or a newer version's):
 *   ignored.
 * - `newer_version`: `version` is newer than this vihko's (`detail`); what it
 *   understands applies.
 * - `not_supported`: a section this version reserves but doesn't implement
 *   yet: not applied.
 * - `section_rejected`: a strict section with a problem (listed next to it):
 *   the whole section is left out and its most restrictive setting applies.
 * - `ignored_value`: a value that means nothing there and is ignored without
 *   rejecting anything (`ai: true` in `permissions`: it never reopens).
 * - `unknown_subject`: a grant to a user or group that doesn't exist
 *   (`detail`): ignored, so that deleting someone never invalidates the
 *   section. Reported by the server, which knows the users.
 * - `missing_folder`: rules for a folder that doesn't exist (moved or
 *   deleted outside vihko): kept, and applied again if it comes back.
 *   Reported by the server.
 * - `outside_spaces`: a path (a series' folder, a templates folder, the
 *   agents' guide) outside `people/` and `spaces/` (D-056.4), where nobody
 *   reads or writes: ignored. Reported by the server under the spaces model.
 * Inside a strict section, any other code (an unknown key included) is a
 * warning that comes with `section_rejected`.
 */
export type ConfigErrorCode =
  | 'yaml' | 'not_a_map' | 'invalid_version' | 'invalid_type' | 'not_boolean'
  | 'invalid_path' | 'invalid_id' | 'pattern_token' | 'pattern_period' | 'unreadable'
  | 'invalid_value' | 'invalid_pattern'
  | 'unknown_key' | 'newer_version' | 'not_supported' | 'section_rejected'
  | 'ignored_value' | 'unknown_subject' | 'missing_folder' | 'outside_spaces'

export interface ConfigError {
  code: ConfigErrorCode
  /** Where, as a key path (`daily.journal.name`); null for the whole file. */
  at: string | null
  /** 1-based line in the file, when known. */
  line: number | null
  detail: string | null
}

/**
 * `ok`: the configuration applies, without what `warnings` lists. Otherwise
 * `errors` say why the file can't be used. `sections` holds what each strict
 * section resolved to (its most restrictive setting when rejected or missing).
 */
export type ParseResult =
  | { ok: true; config: WorkspaceConfig; warnings: ConfigError[]; sections: Record<string, unknown> }
  /**
   * `sections`: the strict sections, when the file could be read as YAML:
   * they stand on their own, so a mistake elsewhere doesn't change them.
   */
  | { ok: false; errors: ConfigError[]; warnings: ConfigError[]; sections?: Record<string, unknown> }

export type Report = (code: ConfigErrorCode, path: string[], detail?: string | null) => void

/**
 * A security-relevant section: parsed strictly and failing closed. Any
 * problem it reports rejects the section alone (never the rest of the file),
 * and then `closed` applies; when the section is missing, `missing` (by
 * default, `closed` too).
 */
export interface StrictSection<T = unknown> {
  key: string
  /** The most restrictive setting: what applies when the section is rejected. */
  closed: T
  /** What applies when the file doesn't have the section (`closed` if not given). */
  missing?: T
  /**
   * Reads the section; `report`ing anything rejects it, a `notice` only
   * tells (something ignored that changes nothing). `at` is `[key]`.
   */
  parse(raw: unknown, at: string[], report: Report, notice: Report): T
}

/**
 * Per-folder permissions (D-014, D-038, D-056, permissions.ts). Missing or
 * rejected, nothing is shared: each person has only their own space.
 */
export const PERMISSIONS_SECTION: StrictSection<Permissions> = {
  key: 'permissions',
  closed: CLOSED_PERMISSIONS,
  missing: NO_PERMISSIONS,
  parse: (raw, at, report, notice) => parsePermissions(raw, at, report, notice),
}

export const STRICT_SECTIONS: readonly StrictSection[] = [PERMISSIONS_SECTION as StrictSection]

const TOP_KEYS = ['version', 'templates', 'daily', 'attachments', 'links', 'history', 'mcp']
const LINKS_KEYS = ['aliases']
const HISTORY_KEYS = ['mode', 'maxFileSize', 'exclude']
const MCP_KEYS = ['instructions']
const SERIES_KEYS = ['folder', 'name', 'template', 'label']
const ATTACHMENT_KEYS = ['mode', 'folder', 'suffix']
const ATTACHMENT_MODES = ['next-to-note', 'folder', 'per-note']
const DEFAULT_NAME = '{YYYY}-{MM}-{DD}'
const SERIES_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** A folder relative to the notes root: no leading or trailing `/`, no `.`/`..`, nothing hidden. */
function isFolder(path: string): boolean {
  if (path === '') return true
  return !/[\\\u0000-\u001f]/.test(path) && path.split('/').every((s) => s !== '' && !s.startsWith('.') && s.trim() === s)
}

export function parseWorkspaceConfig(text: string, strict: readonly StrictSection[] = STRICT_SECTIONS): ParseResult {
  const lines = new LineCounter()
  const doc = parseYamlDocument(text, { lineCounter: lines })
  if (doc.errors.length) {
    const e = doc.errors[0]!
    return { ok: false, errors: [{ code: 'yaml', at: null, line: lines.linePos(e.pos[0]).line, detail: e.message }], warnings: [] }
  }
  const errors: ConfigError[] = []
  const warnings: ConfigError[] = []
  const issue = (code: ConfigErrorCode, path: string[], detail: string | null = null): ConfigError =>
    ({ code, at: path.length ? path.join('.') : null, line: nodeLine(doc, lines, path), detail })
  const fail: Report = (code, path, detail = null) => { errors.push(issue(code, path, detail)) }
  const warn: Report = (code, path, detail = null) => { warnings.push(issue(code, path, detail)) }
  const sections: Record<string, unknown> = Object.fromEntries(strict.map((s) => [s.key, 'missing' in s ? s.missing : s.closed]))
  const js = toData(doc)
  if ('error' in js) return { ok: false, errors: [{ code: 'yaml', at: null, line: null, detail: js.error }], warnings: [] }
  const data = js.value
  if (data === null || data === undefined) return { ok: true, config: EMPTY_WORKSPACE, warnings, sections }
  if (!isRecord(data)) return { ok: false, errors: [{ code: 'not_a_map', at: null, line: 1, detail: null }], warnings }

  const config: WorkspaceConfig = {
    templates: [], daily: [], attachments: { folder: null }, links: { aliases: true },
    history: { mode: 'managed', maxFileSize: DEFAULT_HISTORY_MAX_FILE_MB, exclude: [] },
    mcp: { instructions: null },
  }
  const strictKeys = new Set(strict.map((s) => s.key))
  for (const key of Object.keys(data)) if (!TOP_KEYS.includes(key) && !strictKeys.has(key)) warn('unknown_key', [key])

  if ('version' in data) {
    const v = data.version
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) fail('invalid_version', ['version'], String(v))
    else if (v > WORKSPACE_VERSION) warn('newer_version', ['version'], String(v))
  }

  const folder = (value: unknown, at: string[]): string | null => {
    if (typeof value !== 'string') { fail('invalid_type', at, 'string'); return null }
    const f = trimTrailingSlashes(value.trim())
    if (!f || !isFolder(f)) { fail('invalid_path', at); return null }
    return f
  }

  /** What goes after a note's name to name its attachments folder: `.assets`, `_files`… Never a path, never `.md`. */
  const suffix = (value: unknown, at: string[]): string | null => {
    if (typeof value !== 'string') { fail('invalid_type', at, 'string'); return null }
    if (!value || value.length > 32 || value.trim() !== value || /[/\\\u0000-\u001f]/.test(value) || /\.md$/i.test(value)) { fail('invalid_path', at); return null }
    return value
  }

  if (data.templates !== undefined && data.templates !== null) {
    // One folder alone is a list of one.
    const list = Array.isArray(data.templates) ? data.templates : [data.templates]
    list.forEach((t: unknown, i) => {
      const f = folder(t, Array.isArray(data.templates) ? ['templates', String(i)] : ['templates'])
      if (f !== null && !config.templates.includes(f)) config.templates.push(f)
    })
  }

  if (data.attachments !== undefined && data.attachments !== null) {
    if (!isRecord(data.attachments)) fail('not_a_map', ['attachments'])
    else {
      const a = data.attachments
      for (const k of Object.keys(a)) if (!ATTACHMENT_KEYS.includes(k)) warn('unknown_key', ['attachments', k])
      const given = (k: string) => a[k] !== undefined && a[k] !== null
      let mode = given('folder') ? 'folder' : 'next-to-note'
      if (given('mode')) {
        if (typeof a.mode === 'string' && ATTACHMENT_MODES.includes(a.mode)) mode = a.mode
        else fail('invalid_value', ['attachments', 'mode'], ATTACHMENT_MODES.join(', '))
      }
      // A key that only another mode uses would look active without being so: a wrong value, not an unknown key.
      if (mode === 'folder') {
        if (given('folder')) config.attachments.folder = folder(a.folder, ['attachments', 'folder'])
        else fail('invalid_value', ['attachments', 'mode'], 'folder')
      } else if (given('folder')) fail('invalid_value', ['attachments', 'folder'], 'mode: folder')
      if (mode === 'per-note') config.attachments.perNote = given('suffix') ? suffix(a.suffix, ['attachments', 'suffix']) ?? '' : DEFAULT_ATTACHMENTS_SUFFIX
      else if (given('suffix')) fail('invalid_value', ['attachments', 'suffix'], 'mode: per-note')
    }
  }

  if (data.links !== undefined && data.links !== null) {
    if (!isRecord(data.links)) fail('not_a_map', ['links'])
    else {
      for (const k of Object.keys(data.links)) if (!LINKS_KEYS.includes(k)) warn('unknown_key', ['links', k])
      const a = data.links.aliases
      if (typeof a === 'boolean') config.links.aliases = a
      else if (a !== undefined && a !== null) fail('not_boolean', ['links', 'aliases'])
    }
  }

  if (data.history !== undefined && data.history !== null) {
    if (!isRecord(data.history)) fail('not_a_map', ['history'])
    else {
      const h = data.history
      for (const k of Object.keys(h)) if (!HISTORY_KEYS.includes(k)) warn('unknown_key', ['history', k])
      if (h.mode !== undefined && h.mode !== null) {
        if (typeof h.mode === 'string' && (HISTORY_MODES as readonly string[]).includes(h.mode)) config.history.mode = h.mode as HistoryMode
        else fail('invalid_value', ['history', 'mode'], HISTORY_MODES.join(', '))
      }
      if (h.maxFileSize !== undefined && h.maxFileSize !== null) {
        if (typeof h.maxFileSize === 'number' && Number.isFinite(h.maxFileSize) && h.maxFileSize > 0) config.history.maxFileSize = h.maxFileSize
        else fail('invalid_value', ['history', 'maxFileSize'], 'MB > 0')
      }
      if (h.exclude !== undefined && h.exclude !== null) {
        // One pattern alone is a list of one.
        const list = typeof h.exclude === 'string' ? [h.exclude] : h.exclude
        if (!Array.isArray(list)) fail('invalid_type', ['history', 'exclude'], 'list')
        else {
          const at = (i: number) => ['history', 'exclude', ...(typeof h.exclude === 'string' ? [] : [String(i)])]
          list.forEach((p: unknown, i) => {
            if (typeof p !== 'string') fail('invalid_type', at(i), 'string')
            else if (globProblem(p) !== null) fail('invalid_pattern', at(i), p)
            else config.history.exclude.push(p)
          })
        }
      }
    }
  }

  if (data.mcp !== undefined && data.mcp !== null) {
    if (!isRecord(data.mcp)) fail('not_a_map', ['mcp'])
    else {
      for (const k of Object.keys(data.mcp)) if (!MCP_KEYS.includes(k)) warn('unknown_key', ['mcp', k])
      const i = data.mcp.instructions
      if (i !== undefined && i !== null) {
        if (typeof i !== 'string') fail('invalid_type', ['mcp', 'instructions'], 'string')
        else config.mcp.instructions = notePath(i, ['mcp', 'instructions'], fail)
      }
    }
  }

  if (data.daily !== undefined && data.daily !== null) {
    if (!isRecord(data.daily)) fail('not_a_map', ['daily'])
    else for (const [id, raw] of Object.entries(data.daily)) {
      const at = ['daily', id]
      if (!SERIES_ID.test(id)) { fail('invalid_id', at); continue }
      if (!isRecord(raw)) { fail('not_a_map', at); continue }
      for (const k of Object.keys(raw)) if (!SERIES_KEYS.includes(k)) warn('unknown_key', [...at, k])
      const s = parseSeries(id, raw, at, fail)
      if (s) config.daily.push(s)
    }
  }

  // Strict sections: whatever they report rejects them alone, failing closed.
  for (const section of strict) {
    if (!(section.key in data)) continue
    const found: ConfigError[] = []
    const value = section.parse(data[section.key], [section.key], (code, path, detail = null) => { found.push(issue(code, path, detail)) }, warn)
    if (found.length === 0) { sections[section.key] = value; continue }
    sections[section.key] = section.closed
    warnings.push(...found)
    if (!found.some((f) => f.code === 'not_supported' && f.at === section.key)) warn('section_rejected', [section.key])
  }

  // Reported in the order of the file.
  warnings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
  return errors.length ? { ok: false, errors, warnings, sections } : { ok: true, config, warnings, sections }
}

/** A note's path relative to the notes root (`.md` added if missing), or null with the problem reported. */
function notePath(value: string, at: string[], fail: Report): string | null {
  let p = value.trim()
  if (p && !/\.md$/i.test(p)) p += '.md'
  if (!p || !isFolder(p) || classifyPath(p) !== 'note') { fail('invalid_path', at); return null }
  return p
}

function parseSeries(id: string, raw: Record<string, unknown>, at: string[], fail: Report): Series | null {
  let failed = false
  const bad = (code: ConfigErrorCode, key: string, detail: string | null = null) => { failed = true; fail(code, [...at, key], detail) }
  const str = (key: string): string | null | undefined => {
    const v = raw[key]
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'string' && typeof v !== 'number') { bad('invalid_type', key, 'string'); return null }
    return String(v).trim()
  }

  const folder = trimTrailingSlashes(str('folder') ?? '')
  const name = str('name') ?? DEFAULT_NAME
  const label = str('label') || null
  let template = str('template') ?? null
  if (template) {
    if (!/\.md$/i.test(template)) template += '.md'
    if (!isFolder(template) || classifyPath(template) !== 'note') bad('invalid_path', 'template')
  }
  if (name.includes('/') || !name) bad('invalid_path', 'name')

  const where = { folder, name }
  for (const key of ['folder', 'name'] as const) {
    const unknown = patternTokens(where[key]).unknown
    for (const token of unknown) bad('pattern_token', key, token)
  }
  const period = patternPeriod(patternTokens(`${folder}/${name}`).tokens)
  if (!failed) {
    if (!period) bad('pattern_period', raw.name === undefined ? 'folder' : 'name')
    // With sample values, the pattern must give a valid note path.
    const sample = seriesPath(where, { year: 2026, month: 9, day: 25 }, 'user')
    if (!isFolder(sample) || classifyPath(sample) !== 'note') bad('invalid_path', 'folder')
  }
  if (failed || !period) return null
  return { id, label, folder, name, template, period }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Line of the key at `path` (the value's own line for the whole file), for error messages. */
function nodeLine(doc: Document, lines: LineCounter, path: string[]): number | null {
  let node: unknown = doc.contents
  let offset: number | undefined
  for (const seg of path) {
    if (isSeq(node)) {
      // An item of a list: its own line.
      const item = node.items[Number(seg)]
      if (!item || typeof item !== 'object' || !('range' in item)) break
      offset = (item as { range?: [number, number, number] | null }).range?.[0]
      node = item
      continue
    }
    if (!isMap(node)) break
    const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === seg)
    if (!pair) break
    offset = isScalar(pair.key) ? pair.key.range?.[0] : undefined
    node = pair.value
  }
  return offset === undefined ? null : lines.linePos(offset).line
}
