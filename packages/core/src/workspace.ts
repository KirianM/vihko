// thoth.yaml: the workspace configuration, at the root of the notes folder so
// it travels (and is versioned) with the notes (D-011, D-014). thoth only reads
// it. Parsing is strict: an unknown or misspelt key is an error, not something
// silently ignored, so a setting that looks active always is.
import { LineCounter, isMap, isScalar, parseDocument, type Document } from 'yaml'
import { patternPeriod, patternTokens, seriesPath, type Series } from './series.ts'
import { classifyPath } from './paths.ts'

/** Name of the file at the root of the notes folder. */
export const WORKSPACE_FILE = 'thoth.yaml'

export interface WorkspaceConfig {
  /** Folder holding the templates offered when creating a note, or null. */
  templates: string | null
  /** Daily-note series, in the order declared (the first is the default). */
  daily: Series[]
  /** Fixed folder for new images, or null to keep them next to their note (D-028). */
  attachments: { folder: string | null }
}

export const EMPTY_WORKSPACE: WorkspaceConfig = { templates: null, daily: [], attachments: { folder: null } }

/**
 * Why thoth.yaml can't be used. Stable codes; the UI words them.
 * - `yaml`: not valid YAML (`detail` is the parser's message, for developers).
 * - `not_a_map`: the file (or a section) isn't a set of `key: value`.
 * - `unknown_key`: a key thoth doesn't know (a typo, or a newer version's).
 * - `not_supported`: a key this version reserves but doesn't implement yet
 *   (`permissions`). Refused rather than ignored: ignoring it would look like
 *   the setting works.
 * - `unsupported_version`: `version` isn't 1.
 * - `invalid_type`: a value of the wrong kind (`detail`: what was expected).
 * - `invalid_path`: a folder or note path that isn't relative to the notes
 *   root, climbs out of it or goes through a hidden folder.
 * - `invalid_id`: a series key that isn't letters, digits, `-` or `_`.
 * - `pattern_token`: an unknown `{token}` in a series pattern (`detail`).
 * - `pattern_period`: a series pattern that doesn't name one note per day,
 *   ISO week, month or year.
 * - `unreadable`: the file exists but can't be read (permissions).
 */
export type ConfigErrorCode =
  | 'yaml' | 'not_a_map' | 'unknown_key' | 'not_supported' | 'unsupported_version' | 'invalid_type'
  | 'invalid_path' | 'invalid_id' | 'pattern_token' | 'pattern_period' | 'unreadable'

export interface ConfigError {
  code: ConfigErrorCode
  /** Where, as a key path (`daily.journal.name`); null for the whole file. */
  at: string | null
  /** 1-based line in the file, when known. */
  line: number | null
  detail: string | null
}

export type ParseResult = { ok: true; config: WorkspaceConfig } | { ok: false; errors: ConfigError[] }

const TOP_KEYS = ['version', 'templates', 'daily', 'attachments']
const RESERVED = ['permissions']
const SERIES_KEYS = ['folder', 'name', 'template', 'label']
const ATTACHMENT_KEYS = ['folder']
const DEFAULT_NAME = '{YYYY}-{MM}-{DD}'
const SERIES_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** A folder relative to the notes root: no leading or trailing `/`, no `.`/`..`, nothing hidden. */
function isFolder(path: string): boolean {
  if (path === '') return true
  return !/[\\\u0000-\u001f]/.test(path) && path.split('/').every((s) => s !== '' && !s.startsWith('.') && s.trim() === s)
}

export function parseWorkspaceConfig(text: string): ParseResult {
  const lines = new LineCounter()
  const doc = parseDocument(text, { schema: 'core', uniqueKeys: true, prettyErrors: false, lineCounter: lines })
  if (doc.errors.length) {
    const e = doc.errors[0]!
    return { ok: false, errors: [{ code: 'yaml', at: null, line: lines.linePos(e.pos[0]).line, detail: e.message }] }
  }
  const errors: ConfigError[] = []
  const lineOf = (path: string[]) => nodeLine(doc, lines, path)
  const fail = (code: ConfigErrorCode, path: string[], detail: string | null = null) => {
    errors.push({ code, at: path.length ? path.join('.') : null, line: lineOf(path), detail })
  }
  const data = doc.toJS({ maxAliasCount: 100 }) as unknown
  if (data === null || data === undefined) return { ok: true, config: EMPTY_WORKSPACE }
  if (!isRecord(data)) return { ok: false, errors: [{ code: 'not_a_map', at: null, line: 1, detail: null }] }

  const config: WorkspaceConfig = { templates: null, daily: [], attachments: { folder: null } }
  for (const key of Object.keys(data)) {
    if (RESERVED.includes(key)) fail('not_supported', [key])
    else if (!TOP_KEYS.includes(key)) fail('unknown_key', [key])
  }

  if ('version' in data && data.version !== 1) fail('unsupported_version', ['version'], String(data.version))

  const folder = (value: unknown, at: string[]): string | null => {
    if (typeof value !== 'string') { fail('invalid_type', at, 'string'); return null }
    const f = value.trim().replace(/\/+$/, '')
    if (!f || !isFolder(f)) { fail('invalid_path', at); return null }
    return f
  }

  if (data.templates !== undefined && data.templates !== null) config.templates = folder(data.templates, ['templates'])

  if (data.attachments !== undefined && data.attachments !== null) {
    if (!isRecord(data.attachments)) fail('not_a_map', ['attachments'])
    else {
      for (const k of Object.keys(data.attachments)) if (!ATTACHMENT_KEYS.includes(k)) fail('unknown_key', ['attachments', k])
      const f = data.attachments.folder
      if (f !== undefined && f !== null) config.attachments.folder = folder(f, ['attachments', 'folder'])
    }
  }

  if (data.daily !== undefined && data.daily !== null) {
    if (!isRecord(data.daily)) fail('not_a_map', ['daily'])
    else for (const [id, raw] of Object.entries(data.daily)) {
      const at = ['daily', id]
      if (!SERIES_ID.test(id)) { fail('invalid_id', at); continue }
      if (!isRecord(raw)) { fail('not_a_map', at); continue }
      for (const k of Object.keys(raw)) if (!SERIES_KEYS.includes(k)) fail('unknown_key', [...at, k])
      const s = parseSeries(id, raw, at, fail)
      if (s) config.daily.push(s)
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, config }
}

function parseSeries(id: string, raw: Record<string, unknown>, at: string[], fail: (code: ConfigErrorCode, path: string[], detail?: string | null) => void): Series | null {
  let failed = false
  const bad = (code: ConfigErrorCode, key: string, detail: string | null = null) => { failed = true; fail(code, [...at, key], detail) }
  const str = (key: string): string | null | undefined => {
    const v = raw[key]
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'string' && typeof v !== 'number') { bad('invalid_type', key, 'string'); return null }
    return String(v).trim()
  }

  const folder = (str('folder') ?? '').replace(/\/+$/, '')
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
    if (!isMap(node)) break
    const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === seg)
    if (!pair) break
    offset = isScalar(pair.key) ? pair.key.range?.[0] : undefined
    node = pair.value
  }
  return offset === undefined ? null : lines.linePos(offset).line
}
