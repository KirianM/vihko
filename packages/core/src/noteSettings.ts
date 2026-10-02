// Note settings of a space: a person's own (`people/<user>/.vihko/settings.yaml`)
// or a shared space's (`spaces/<name>/.vihko/settings.yaml`), one format for
// both. What vihko.yaml says for the whole installation, a space can add for
// itself and a person for their own notes:
//
//   version: 1
//   daily:                         # daily-note series, as vihko.yaml's
//     journal:
//       label: Journal
//       folder: journal/{YYYY}     # inside the space; `{user}` isn't needed (the space is theirs, or everyone's)
//       name: "{YYYY}-{MM}-{DD}"
//       template: Templates/Daily
//   attachments:                   # where new images of the space's notes go, as vihko.yaml's
//     mode: folder
//     folder: images
//   agents: For agents             # a person's space: a note of it, their guide for agents
//   guide: |                       # a shared space: its guide for agents, written here
//     Answer in Spanish.
//
// A shared space's guide is written in the file itself, never in a note: the
// file is changed by the space's managers only, and a note by anyone who edits
// it, so a member with edit can't change what every member's agents are told.
// A person's own guide is one of their notes (`agents`): their space is theirs.
//
// Templates aren't configured: a template is a note marked `template: true` in
// its frontmatter, wherever it is. An old `templates` key is an unknown one.
//
// - Every path is relative to the space's root: nothing names `people/` or
//   `spaces/`, and renaming a space changes nothing in it. None may leave the
//   space (`..`, an absolute path) or enter a hidden folder.
// - `version` is the format's number, 1 now: a later vihko that changes the
//   format knows which one a file has. A file without it is version 1; a
//   higher one is read as far as it can, with a warning.
// - Parsing is as vihko.yaml's (workspace.ts): an unknown key is reported and
//   ignored; a wrong value in a known key leaves that key out, reported. A
//   file that isn't YAML gives nothing, reported.
// - The file is the space's own setting, never a note: hidden (`.vihko/`), so
//   never indexed, served as a file or kept in a note's history.
//
// The server reads and writes these files (noteSettings.ts there); the UI only edits the form.
import { isMap, isScalar } from 'yaml'
import { patternPeriod, patternTokens, seriesPath, type Series } from './series.ts'
import { classifyPath, trimTrailingSlashes } from './paths.ts'
import { SETTINGS_FOLDER } from './spaces.ts'
import { parseYamlDocument } from './yaml.ts'
import { toData } from './frontmatter.ts'
import { DEFAULT_ATTACHMENTS_SUFFIX, type AttachmentsConfig, type ConfigError, type ConfigErrorCode } from './workspace.ts'

/** The file's name, in a space's `.vihko/`. */
export const NOTE_SETTINGS_FILE = 'settings.yaml'
/** The newest `version` of a settings file this vihko understands. */
export const NOTE_SETTINGS_VERSION = 1

/** `<root>/.vihko/settings.yaml`: the settings file of the space whose root is `root`. */
export const noteSettingsPath = (root: string) => `${root}/${SETTINGS_FOLDER}/${NOTE_SETTINGS_FILE}`

/** A series as the file writes it: paths relative to the space. */
export interface SettingsSeries {
  id: string
  label: string | null
  folder: string
  name: string
  template: string | null
}

/** Where new images go, as written (relative to the space); null: as vihko.yaml says. */
export type SettingsAttachments =
  | { mode: 'next-to-note' }
  | { mode: 'folder'; folder: string }
  | { mode: 'per-note'; suffix: string }

/** The settings as written: what the Preferences form edits. Paths relative to the space. */
export interface NoteSettings {
  version: number
  daily: SettingsSeries[]
  attachments: SettingsAttachments | null
  /** A person's space: a note of it with their guide for agents (`.md` optional when written). */
  agents: string | null
  /** A shared space: its guide for agents, the text itself. */
  guide: string | null
}

export const EMPTY_NOTE_SETTINGS: NoteSettings = { version: NOTE_SETTINGS_VERSION, daily: [], attachments: null, agents: null, guide: null }

/** Whose settings: a person's own space's, or a shared space's (what `agents` and `guide` mean depends on it). */
export type NoteSettingsKind = 'personal' | 'shared'

/** The longest guide a shared space's settings may hold, in characters. */
export const MAX_SPACE_GUIDE = 20_000

/** The settings as they apply: paths from the notes root. */
export interface ResolvedNoteSettings {
  daily: Series[]
  attachments: AttachmentsConfig | null
  /** A person's guide: the note, from the notes root. */
  agents: string | null
  /** A shared space's guide: its text. */
  guide: string | null
}

const TOP_KEYS = ['version', 'daily', 'attachments', 'agents', 'guide']
const SERIES_KEYS = ['label', 'folder', 'name', 'template']
const ATTACHMENT_KEYS = ['mode', 'folder', 'suffix']
const SERIES_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const DEFAULT_NAME = '{YYYY}-{MM}-{DD}'

/** A path inside a space, as written there: relative, no `..`, `.` or hidden segment, no control characters. */
export function spacePathProblem(p: string): boolean {
  if (p === '' || p.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(p)) return true
  return p.split('/').some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))
}

/**
 * Reads a settings file's text. `errors`: what was left out and why (codes
 * as vihko.yaml's: `yaml`, `not_a_map`, `unknown_key`, `invalid_version`,
 * `invalid_value`, `invalid_path`, `invalid_type`, `invalid_id`,
 * `pattern_token`, `pattern_period`, `newer_version`; `space_guide_note` for
 * `agents` in a shared space's, with the note it names, and `unknown_key` for
 * `guide` in a person's), each with where (a key path) and its line. A file that isn't there is `EMPTY_NOTE_SETTINGS`.
 */
export function parseNoteSettings(text: string | null, kind: NoteSettingsKind = 'personal'): { settings: NoteSettings; errors: ConfigError[] } {
  const settings: NoteSettings = { ...EMPTY_NOTE_SETTINGS, daily: [] }
  const errors: ConfigError[] = []
  if (text === null || text.trim() === '') return { settings, errors }
  const doc = parseYamlDocument(text)
  const lineOf = (at: number | undefined) => (at === undefined ? null : text.slice(0, at).split('\n').length)
  if (doc.errors.length) {
    errors.push({ code: 'yaml', at: null, line: lineOf(doc.errors[0]!.pos[0]), detail: doc.errors[0]!.message })
    return { settings, errors }
  }
  const data = toData(doc)
  if ('error' in data) {
    errors.push({ code: 'yaml', at: null, line: null, detail: data.error })
    return { settings, errors }
  }
  const root = data.value
  if (root === null || root === undefined) return { settings, errors }
  if (!isRecord(root)) {
    errors.push({ code: 'not_a_map', at: null, line: 1, detail: null })
    return { settings, errors }
  }
  // Each problem with the line of its key.
  const keyLine = (path: string[]): number | null => {
    let node: unknown = doc.contents
    let at: number | undefined
    for (const seg of path) {
      if (!isMap(node)) break
      const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === seg)
      if (!pair) break
      at = isScalar(pair.key) ? pair.key.range?.[0] : undefined
      node = pair.value
    }
    return lineOf(at)
  }
  const fail = (code: ConfigErrorCode, path: string[], detail: string | null = null) => {
    errors.push({ code, at: path.join('.'), line: keyLine(path), detail })
  }

  for (const k of Object.keys(root)) if (!TOP_KEYS.includes(k)) fail('unknown_key', [k])

  if (root.version !== undefined && root.version !== null) {
    if (typeof root.version !== 'number' || !Number.isInteger(root.version) || root.version < 1) fail('invalid_version', ['version'])
    else {
      settings.version = root.version
      if (root.version > NOTE_SETTINGS_VERSION) fail('newer_version', ['version'], String(NOTE_SETTINGS_VERSION))
    }
  }

  // A shared space's guide was a note before: said, with the note it named, so its managers can move its text in.
  if (root.agents !== undefined && root.agents !== null && kind === 'shared') fail('space_guide_note', ['agents'], typeof root.agents === 'string' ? root.agents : null)
  else if (root.agents !== undefined && root.agents !== null) {
    if (typeof root.agents !== 'string') fail('invalid_type', ['agents'], 'string')
    else {
      let p = root.agents.trim().normalize('NFC')
      if (p && !/\.md$/i.test(p)) p += '.md'
      if (spacePathProblem(p) || classifyPath(p) !== 'note') fail('invalid_path', ['agents'])
      else settings.agents = p
    }
  }

  if (root.guide !== undefined && root.guide !== null && kind === 'personal') fail('unknown_key', ['guide'])
  else if (root.guide !== undefined && root.guide !== null) {
    if (typeof root.guide !== 'string') fail('invalid_type', ['guide'], 'string')
    else if (root.guide.length > MAX_SPACE_GUIDE) fail('invalid_value', ['guide'], String(MAX_SPACE_GUIDE))
    else if (root.guide.trim() !== '') settings.guide = root.guide.normalize('NFC')
  }

  if (root.attachments !== undefined && root.attachments !== null) {
    const a = root.attachments
    if (!isRecord(a)) fail('not_a_map', ['attachments'])
    else {
      for (const k of Object.keys(a)) if (!ATTACHMENT_KEYS.includes(k)) fail('unknown_key', ['attachments', k])
      const mode = a.mode ?? (a.folder !== undefined ? 'folder' : undefined)
      if (mode === 'next-to-note') settings.attachments = { mode }
      else if (mode === 'folder') {
        const f = typeof a.folder === 'string' ? trimTrailingSlashes(a.folder.trim().normalize('NFC')) : ''
        if (spacePathProblem(f)) fail('invalid_path', ['attachments', 'folder'])
        else settings.attachments = { mode, folder: f }
      } else if (mode === 'per-note') {
        const s = a.suffix === undefined || a.suffix === null ? DEFAULT_ATTACHMENTS_SUFFIX : a.suffix
        if (typeof s !== 'string' || s === '' || /[\\/\u0000-\u001f]/.test(s) || /\.md$/i.test(s)) fail('invalid_value', ['attachments', 'suffix'])
        else settings.attachments = { mode, suffix: s }
      } else fail('invalid_value', ['attachments', 'mode'], 'next-to-note, folder, per-note')
    }
  }

  if (root.daily !== undefined && root.daily !== null) {
    if (!isRecord(root.daily)) fail('not_a_map', ['daily'])
    else for (const [id, raw] of Object.entries(root.daily)) {
      const at = ['daily', id]
      if (!SERIES_ID.test(id)) { fail('invalid_id', at); continue }
      if (!isRecord(raw)) { fail('not_a_map', at); continue }
      for (const k of Object.keys(raw)) if (!SERIES_KEYS.includes(k)) fail('unknown_key', [...at, k])
      const s = parseSettingsSeries(id, raw, (code, key, detail) => fail(code, [...at, key], detail))
      if (s) settings.daily.push(s)
    }
  }
  return { settings, errors }
}

/** One series as written, or null with what's wrong reported. */
function parseSettingsSeries(id: string, raw: Record<string, unknown>, bad: (code: ConfigErrorCode, key: string, detail?: string | null) => void): SettingsSeries | null {
  let failed = false
  const fail = (code: ConfigErrorCode, key: string, detail: string | null = null) => { failed = true; bad(code, key, detail) }
  const str = (key: string): string | undefined => {
    const v = raw[key]
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'string' && typeof v !== 'number') { fail('invalid_type', key, 'string'); return undefined }
    return String(v).trim().normalize('NFC')
  }
  const folder = trimTrailingSlashes(str('folder') ?? '')
  const name = str('name') ?? DEFAULT_NAME
  const label = str('label') || null
  let template = str('template') ?? null
  if (template) {
    if (!/\.md$/i.test(template)) template += '.md'
    if (spacePathProblem(template) || classifyPath(template) !== 'note') fail('invalid_path', 'template')
  }
  if (folder !== '' && spacePathProblem(folder.replace(/\{[^{}]*\}/g, 'x'))) fail('invalid_path', 'folder')
  if (name === '' || name.includes('/')) fail('invalid_path', 'name')
  for (const key of ['folder', 'name'] as const) {
    const t = patternTokens(key === 'folder' ? folder : name)
    // `{user}` means nothing here: the space is one person's, or everyone's.
    for (const token of [...t.unknown, ...(t.tokens.has('user') ? ['user'] : [])]) fail('pattern_token', key, token)
  }
  if (failed) return null
  if (!patternPeriod(patternTokens(`${folder}/${name}`).tokens)) { fail('pattern_period', raw.name === undefined ? 'folder' : 'name'); return null }
  const sample = seriesPath({ folder, name }, { year: 2026, month: 9, day: 25 }, 'x')
  if (classifyPath(sample) !== 'note' || spacePathProblem(sample)) { fail('invalid_path', 'folder'); return null }
  return { id, label, folder, name, template }
}

/**
 * The settings of the space at `root` as they apply: every path from the
 * notes root, and each series with its id prefixed by `idPrefix` (so it
 * never takes the id of vihko.yaml's or another space's series).
 */
export function resolveNoteSettings(s: NoteSettings, root: string, idPrefix: string): ResolvedNoteSettings {
  const at = (p: string) => (p === '' ? root : `${root}/${p}`)
  return {
    daily: s.daily.map((x) => {
      const period = patternPeriod(patternTokens(`${x.folder}/${x.name}`).tokens)!
      return { id: `${idPrefix}${x.id}`, label: x.label ?? x.id, folder: at(x.folder), name: x.name, template: x.template === null ? null : at(x.template), period }
    }),
    attachments: s.attachments === null ? null
      : s.attachments.mode === 'next-to-note' ? { folder: null }
      : s.attachments.mode === 'folder' ? { folder: s.attachments.folder }
      : { folder: null, perNote: s.attachments.suffix },
    agents: s.agents === null ? null : at(s.agents),
    guide: s.guide,
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The file can't be edited by vihko as it is (not YAML, not a map): it's fixed by hand first. */
export class NoteSettingsFileError extends Error {}

/** A series as the file writes it (only what isn't a default). */
function seriesValue(s: SettingsSeries): Record<string, string> {
  return {
    ...(s.label ? { label: s.label } : {}),
    folder: s.folder,
    ...(s.name !== DEFAULT_NAME ? { name: s.name } : {}),
    ...(s.template ? { template: s.template.replace(/\.md$/i, '') } : {}),
  }
}

function attachmentsValue(a: SettingsAttachments): Record<string, string> {
  return a.mode === 'folder' ? { mode: a.mode, folder: a.folder } : a.mode === 'per-note' ? { mode: a.mode, suffix: a.suffix } : { mode: a.mode }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The file's text with `next` written in it: only what changed is touched
 * (a series by its id, each other key on its own), so comments, the order
 * of keys and anything vihko doesn't know stay as they were around it. A
 * file without `version` gets it, first. Throws NoteSettingsFileError for a
 * file that isn't YAML or a map: it's fixed by hand.
 */
export function writeNoteSettings(text: string | null, next: NoteSettings, kind: NoteSettingsKind = 'personal', remove: readonly string[] = []): string {
  const doc = parseYamlDocument(text ?? '')
  if (doc.errors.length) throw new NoteSettingsFileError(`not valid YAML: ${doc.errors[0]!.message}`)
  if (doc.contents !== null && !isMap(doc.contents)) throw new NoteSettingsFileError('not a set of key: value')
  const read = parseNoteSettings(text, kind)
  const was = read.settings
  // A known key whose value was left out as wrong is written over (a key vihko doesn't know stays).
  const wrong = new Set(read.errors.filter((e) => e.code !== 'unknown_key').map((e) => e.at?.split('.')[0]))
  // Keys vihko doesn't know that the person chose to remove (`remove`, as their `at`): only those, never one it knows.
  const unknown = new Set(read.errors.filter((e) => e.code === 'unknown_key' && e.at !== null).map((e) => e.at!))
  for (const at of remove) if (unknown.has(at)) doc.deleteIn(at.split('.'))
  const current = (doc.toJS() ?? {}) as Record<string, unknown>
  if (doc.contents === null) doc.contents = doc.createNode({}) as never
  if (current.version === undefined) {
    const pair = doc.createPair('version', NOTE_SETTINGS_VERSION)
    ;(doc.contents as unknown as { items: unknown[] }).items.unshift(pair)
  } else if (read.errors.some((e) => e.code === 'invalid_version')) doc.set('version', NOTE_SETTINGS_VERSION)
  // `daily` that isn't a map at all can't take series: it starts again.
  if (current.daily !== undefined && current.daily !== null && !isRecord(current.daily)) {
    doc.delete('daily')
    delete current.daily
  }
  // Series: by id.
  const ids = new Set(next.daily.map((s) => s.id))
  const daily = isRecord(current.daily) ? current.daily : {}
  for (const id of Object.keys(daily)) if (!ids.has(id)) doc.deleteIn(['daily', id])
  for (const s of next.daily) {
    const before = was.daily.find((x) => x.id === s.id)
    if (before && same(before, s) && isRecord(daily[s.id])) continue
    doc.setIn(['daily', s.id], doc.createNode(seriesValue(s)))
  }
  if (next.daily.length === 0 && current.daily !== undefined) doc.delete('daily')
  // The rest: each key on its own.
  if (!same(was.attachments, next.attachments) || wrong.has('attachments')) {
    if (next.attachments === null) doc.delete('attachments')
    else doc.set('attachments', doc.createNode(attachmentsValue(next.attachments)))
  }
  if (!same(was.agents, next.agents) || wrong.has('agents')) {
    if (next.agents === null) doc.delete('agents')
    else doc.set('agents', next.agents.replace(/\.md$/i, ''))
  }
  if (!same(was.guide, next.guide) || wrong.has('guide')) {
    if (next.guide === null) doc.delete('guide')
    else doc.set('guide', next.guide)
  }
  return doc.toString({ lineWidth: 0 })
}
