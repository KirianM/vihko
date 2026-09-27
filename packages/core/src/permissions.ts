// Per-folder permissions (D-014, D-038): the strict `permissions` section of
// thoth.yaml, how a folder's rule is found, and the edits thoth makes to the
// file (keeping everything else in it as it was).
//
//   permissions:
//     "":                         # the root
//       grants: { noa: manage }
//     familia:
//       grants: { "@familia": edit }
//     "personas/{user}":
//       grants: { "{user}": manage }
//     personas/laura/diario:
//       ai: false
//
// - Keys are folders from the notes root (`""` is the root). One segment may
//   be `{user}`: the rule then holds for each user, at the folder named like
//   them. Rules are identified by their key.
// - Subjects: a user's name, `@group`, or `{user}` (only in a `{user}` rule).
// - Levels, from less to more: read < comment < edit < manage.
// - A folder with no `grants` of its own inherits those of its nearest
//   ancestor that has some; one with its own replaces them (never adds). The
//   most specific rule wins: a literal folder over a `{user}` rule at the same
//   depth, and either over an ancestor's. A `{user}` rule at a folder named
//   like no user grants nothing: nobody sees it (it never inherits).
// - `ai: false` holds for the folder and everything under it, on top of the
//   notes' own `ai: false`. `ai: true` never reopens anything: ignored, with
//   a notice.
// - The section is strict (D-031.9): anything wrong in it rejects it whole,
//   and then nobody reads anything (`closed`). Without the section, the
//   implicit one applies: every admin manages the root.
//
// This module knows nothing of users or groups: the server resolves subjects
// (and warns about the ones it doesn't know).
import { isMap, isScalar, parseDocument, type Document, type Pair, type YAMLMap } from 'yaml'

/** What a grant allows, from less to more. */
export type Level = 'read' | 'comment' | 'edit' | 'manage'

export const LEVELS: readonly Level[] = ['read', 'comment', 'edit', 'manage']

/** Whether `have` reaches `need` (null: no access at all). */
export function atLeast(have: Level | null, need: Level): boolean {
  return have !== null && LEVELS.indexOf(have) >= LEVELS.indexOf(need)
}

/** The higher of two levels. */
export function maxLevel(a: Level | null, b: Level | null): Level | null {
  if (a === null) return b
  if (b === null) return a
  return LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b
}

/** The segment that makes a rule hold for each user. */
export const USER_SEGMENT = '{user}'

/** One folder's rule as written. `grants` null: it inherits; `ai` null: nothing about agents. */
export interface PermissionRule {
  /** Its key: a folder (NFC), `""` for the root, maybe with a `{user}` segment. */
  folder: string
  grants: Record<string, Level> | null
  ai: false | null
}

/**
 * The section as it applies:
 * - `implicit`: there is none; every admin manages the root.
 * - `closed`: it was rejected (and no valid one was in force): nobody reads.
 * - `rules`: the rules written, which may leave folders to nobody.
 */
export type Permissions =
  | { kind: 'implicit' }
  | { kind: 'closed' }
  | { kind: 'rules'; rules: PermissionRule[] }

export const IMPLICIT_PERMISSIONS: Permissions = { kind: 'implicit' }
export const CLOSED_PERMISSIONS: Permissions = { kind: 'closed' }

/** A problem in the section: its code (ConfigErrorCode), where (as a key path) and a detail. */
export type PermissionsReport = (code: 'not_a_map' | 'invalid_path' | 'invalid_value' | 'invalid_type' | 'not_boolean' | 'unknown_key' | 'ignored_value', at: string[], detail?: string | null) => void

const RULE_KEYS = ['grants', 'ai']
const USERNAME = /^[\p{L}\p{N}._-]{2,64}$/u
const GROUP = /^@[^\u0000-\u001f@/]{1,64}$/u

/** Whether a subject is written as one: a user's name, `@group` or `{user}`. */
export function isSubject(s: string): boolean {
  return s === USER_SEGMENT || USERNAME.test(s) || (GROUP.test(s) && s.slice(1).trim() === s.slice(1))
}

/** A folder key: relative, no leading or trailing `/`, no `.`/`..` or hidden segments; at most one `{user}` and no other `{…}` segment. */
function folderProblem(key: string): string | null {
  if (key === '') return null
  if (/[\\\u0000-\u001f]/.test(key)) return 'control characters'
  const segs = key.split('/')
  if (!segs.every((s) => s !== '' && !s.startsWith('.') && s.trim() === s)) return 'not a folder'
  if (segs.filter((s) => s === USER_SEGMENT).length > 1) return 'more than one {user}'
  const other = segs.find((s) => s !== USER_SEGMENT && /^\{.*\}$/.test(s))
  if (other) return `unknown ${other}`
  return null
}

/**
 * Reads the section. `report`: anything that rejects it; `notice`: what is
 * ignored without rejecting it (`ai: true`).
 */
export function parsePermissions(raw: unknown, at: string[], report: PermissionsReport, notice: PermissionsReport): Permissions {
  if (raw === null || raw === undefined) return { kind: 'rules', rules: [] }
  if (!isRecord(raw)) { report('not_a_map', at); return CLOSED_PERMISSIONS }
  const rules: PermissionRule[] = []
  const seen = new Set<string>()
  for (const [rawKey, value] of Object.entries(raw)) {
    const here = [...at, rawKey]
    const folder = rawKey.normalize('NFC')
    const problem = folderProblem(folder)
    if (problem) { report('invalid_path', here, problem); continue }
    if (seen.has(folder)) { report('invalid_path', here, 'written twice'); continue }
    seen.add(folder)
    if (!isRecord(value)) { report('not_a_map', here); continue }
    for (const k of Object.keys(value)) if (!RULE_KEYS.includes(k)) report('unknown_key', [...here, k])
    const perUser = folder.split('/').includes(USER_SEGMENT)
    let grants: Record<string, Level> | null = null
    if (value.grants !== undefined && value.grants !== null) {
      if (!isRecord(value.grants)) report('not_a_map', [...here, 'grants'])
      else {
        grants = {}
        for (const [rawSubject, level] of Object.entries(value.grants)) {
          const subject = rawSubject.normalize('NFC')
          const where = [...here, 'grants', rawSubject]
          if (!isSubject(subject)) { report('invalid_value', where, 'user, @group, {user}'); continue }
          if (subject === USER_SEGMENT && !perUser) { report('invalid_value', where, 'user, @group'); continue }
          if (typeof level !== 'string' || !(LEVELS as readonly string[]).includes(level)) { report('invalid_value', where, LEVELS.join(', ')); continue }
          const key = subjectKey(subject)
          if (Object.keys(grants).some((s) => subjectKey(s) === key)) { report('invalid_value', where); continue }
          grants[subject] = level as Level
        }
      }
    }
    let ai: false | null = null
    if (value.ai !== undefined && value.ai !== null) {
      if (value.ai === false) ai = false
      else if (value.ai === true) notice('ignored_value', [...here, 'ai'], 'ai: true')
      else report('not_boolean', [...here, 'ai'])
    }
    rules.push({ folder, grants, ai })
  }
  return { kind: 'rules', rules }
}

/** How subjects are compared: user and group names ignore case (state.db compares names without it). */
export function subjectKey(subject: string): string {
  return subject.normalize('NFC').toLowerCase()
}

/** A rule applying to a folder: the rule, and the user its `{user}` segment names there (null without one). */
export interface RuleMatch {
  rule: PermissionRule
  user: string | null
}

/** Where a folder's grants come from: the rule and the folder it's written for (an ancestor, or the folder itself). */
export interface Governing extends RuleMatch {
  /** The concrete folder the rule applies at (`personas/laura` for `personas/{user}`). */
  at: string
}

/** The folder's parent, `""` for a top-level one; null for the root. */
export function parentFolder(folder: string): string | null {
  if (folder === '') return null
  const i = folder.lastIndexOf('/')
  return i === -1 ? '' : folder.slice(0, i)
}

/** The folder a path is in (`a/b/c.md` → `a/b`, `c.md` → `""`). */
export function folderOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/** A folder and its ancestors, the folder first and the root last. */
export function selfAndAncestors(folder: string): string[] {
  const out: string[] = []
  for (let f: string | null = folder; f !== null; f = parentFolder(f)) out.push(f)
  return out
}

/**
 * The rules, ready to answer which one applies where. Pure: nothing about
 * users. Answers are remembered (the rules never change: a new file is a
 * new set).
 */
export class RuleSet {
  readonly rules: readonly PermissionRule[]
  private literal = new Map<string, PermissionRule>()
  /** `{user}` rules: their segments and where the `{user}` is. */
  private patterns: { rule: PermissionRule; segs: string[]; at: number }[] = []
  private ownCache = new Map<string, RuleMatch | null>()
  private userCache = new Map<string, RuleMatch | null>()
  private governingCache = new Map<string, Governing | null>()

  constructor(rules: readonly PermissionRule[]) {
    this.rules = rules
    for (const r of rules) {
      const segs = r.folder === '' ? [] : r.folder.split('/')
      const at = segs.indexOf(USER_SEGMENT)
      if (at === -1) this.literal.set(r.folder, r)
      else this.patterns.push({ rule: r, segs, at })
    }
    // Two `{user}` rules may match the same folder: the one with more of it written literally first wins.
    this.patterns.sort((a, b) => b.at - a.at)
  }

  /** The rule written for exactly this folder: a literal one, else a `{user}` one matching it. */
  own(folder: string): RuleMatch | null {
    const f = folder.normalize('NFC')
    const cached = this.ownCache.get(f)
    if (cached !== undefined) return cached
    const lit = this.literal.get(f)
    const found: RuleMatch | null = lit ? { rule: lit, user: null } : this.userRule(f)
    this.remember(this.ownCache, f, found)
    return found
  }

  /** The `{user}` rule matching this folder, even under a literal one written for it. */
  userRule(folder: string): RuleMatch | null {
    const f = folder.normalize('NFC')
    if (f === '' || this.patterns.length === 0) return null
    const cached = this.userCache.get(f)
    if (cached !== undefined) return cached
    const segs = f.split('/')
    let found: RuleMatch | null = null
    for (const p of this.patterns) {
      if (p.segs.length !== segs.length) continue
      if (p.segs.every((s, i) => i === p.at || s === segs[i])) { found = { rule: p.rule, user: segs[p.at]! }; break }
    }
    this.remember(this.userCache, f, found)
    return found
  }

  /**
   * Where the folder's grants come from: its own rule with grants, or its
   * nearest ancestor's; null if none has any. A literal rule without grants
   * (only `ai: false`, say) over a `{user}` one leaves that one's grants in
   * place: the folder never falls through to what's above it.
   */
  governing(folder: string): Governing | null {
    const f = folder.normalize('NFC')
    const cached = this.governingCache.get(f)
    if (cached !== undefined) return cached
    let found: Governing | null = null
    for (const d of selfAndAncestors(f)) {
      const m = this.own(d)
      if (m && m.rule.grants !== null) { found = { ...m, at: d }; break }
      const u = m && m.user === null ? this.userRule(d) : null
      if (u && u.rule.grants !== null) { found = { ...u, at: d }; break }
    }
    this.remember(this.governingCache, f, found)
    return found
  }

  /** The folder (itself or an ancestor) whose `ai: false` closes it to agents; null if none does. */
  aiClosedAt(folder: string): string | null {
    for (const d of selfAndAncestors(folder.normalize('NFC'))) {
      if (this.own(d)?.rule.ai === false || this.userRule(d)?.rule.ai === false) return d
    }
    return null
  }

  private remember<T>(cache: Map<string, T>, key: string, value: T) {
    if (cache.size > 20_000) cache.clear()
    cache.set(key, value)
  }
}

/**
 * The grants a governing rule gives at its folder: `{user}` becomes the user
 * the folder is named after, and a folder named like nobody (`userExists`
 * false) gets none at all.
 */
export function grantsAt(g: Governing, userExists: (name: string) => boolean): Record<string, Level> {
  const grants = g.rule.grants ?? {}
  if (g.user === null) return grants
  if (!userExists(g.user)) return {}
  const out: Record<string, Level> = {}
  for (const [s, l] of Object.entries(grants)) out[s === USER_SEGMENT ? g.user : s] = maxLevel(out[s === USER_SEGMENT ? g.user : s] ?? null, l)!
  return out
}

/** The highest level `grants` give a user (by name, and through their groups). */
export function levelIn(grants: Record<string, Level>, user: { username: string; groups: readonly string[] }): Level | null {
  const me = subjectKey(user.username)
  const groups = new Set(user.groups.map((g) => subjectKey('@' + g)))
  let level: Level | null = null
  for (const [s, l] of Object.entries(grants)) {
    const k = subjectKey(s)
    if (k === me || groups.has(k)) level = maxLevel(level, l)
  }
  return level
}

// --- Writing thoth.yaml ---------------------------------------------------------
// thoth only ever changes the `permissions` entries it's asked to. Each one is
// spliced into the text where it was (or added at the end of the section):
// comments, blank lines, quoting, key order and every other section stay
// byte for byte as they were. Only a section written in flow style (`{…}`
// spanning lines) is rewritten through the yaml Document API, which keeps
// its comments and order but not its spacing.

/** A rule as thoth writes it. Both null: the folder has no rule (it's removed). */
export interface RuleValue {
  grants: Record<string, Level> | null
  ai: false | null
}

/** thoth.yaml can't be edited as it is (not valid YAML, or `permissions` isn't a map): it's fixed by hand first. */
export class PermissionsFileError extends Error {}

type Ranged = { range: [number, number, number] }
const range = (node: unknown): [number, number, number] => (node as Ranged).range

function load(text: string): Document {
  const doc = parseDocument(text, { schema: 'core', uniqueKeys: true, prettyErrors: false })
  if (doc.errors.length) throw new PermissionsFileError(`thoth.yaml is not valid YAML: ${doc.errors[0]!.message}`)
  if (doc.contents !== null && !isMap(doc.contents)) throw new PermissionsFileError('thoth.yaml is not a set of key: value')
  return doc
}

/** The `permissions` pair of the file, if it has one. */
function sectionPair(doc: Document): Pair | null {
  const top = doc.contents as YAMLMap | null
  if (!top) return null
  return (top.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === 'permissions') as Pair | undefined) ?? null
}

/** A key of the section as the folder it names (NFC); null if it isn't one. */
function folderKey(item: Pair): string | null {
  const k = isScalar(item.key) ? item.key.value : item.key
  return k === null ? '' : typeof k === 'string' ? k.normalize('NFC') : null
}

/** The rules as the file has them now, by folder (NFC), in order. */
function currentRules(doc: Document): Map<string, RuleValue> {
  const out = new Map<string, RuleValue>()
  const pair = sectionPair(doc)
  if (!pair || !isMap(pair.value)) return out
  for (const item of pair.value.items as Pair[]) {
    const folder = folderKey(item)
    if (folder === null) continue
    const js = (isMap(item.value) ? item.value.toJSON() : {}) as { grants?: Record<string, Level> | null; ai?: unknown }
    out.set(folder, { grants: js.grants && typeof js.grants === 'object' ? { ...js.grants } : null, ai: js.ai === false ? false : null })
  }
  return out
}

const PLAIN_KEY = /^[\p{L}\p{N}_][\p{L}\p{N}_ ./-]*(?<! )$/u
const PLAIN_SUBJECT = /^[\p{L}\p{N}_][\p{L}\p{N}._-]*$/u

/** A key as YAML: plain when that reads back the same, double-quoted otherwise (`""`, `@group`, `{user}`, `true`…). */
function yamlKey(key: string, plain: RegExp): string {
  return plain.test(key) && !/^(true|false|null|yes|no|on|off|y|n|~)$/i.test(key) && !/^[\d.+-]/.test(key) ? key : JSON.stringify(key)
}

/** Grants as a flow map, in the order given: `{ noa: manage, "@familia": edit }`. */
function grantsText(grants: Record<string, Level>): string {
  const entries = Object.entries(grants)
  return entries.length === 0 ? '{}' : `{ ${entries.map(([s, l]) => `${yamlKey(s, PLAIN_SUBJECT)}: ${l}`).join(', ')} }`
}

/** One entry of the section in block style, at `indent`. */
function entryText(keySource: string, value: RuleValue, indent: string): string {
  let out = `${indent}${keySource}:\n`
  if (value.grants !== null) out += `${indent}  grants: ${grantsText(value.grants)}\n`
  if (value.ai === false) out += `${indent}  ai: false\n`
  return out
}

const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1
const nextLine = (text: string, at: number) => {
  const nl = text.indexOf('\n', at)
  return nl === -1 ? text.length : nl + 1
}

type Change = [folder: string, value: RuleValue | null]

/**
 * Sets each folder's rule (null, or both fields null: removes it) and
 * returns the new text. `implicitAdmins`: when the file has no section yet,
 * the implicit one (each of them manages the root) is written with the
 * change, so that the change doesn't take it away.
 */
function applyRules(text: string, changes: readonly Change[], opts: { implicitAdmins?: readonly string[] } = {}): string {
  const doc = load(text)
  const want = new Map<string, RuleValue | null>()
  const pair = sectionPair(doc)
  const empty = !pair || pair.value === null || (isScalar(pair.value) && pair.value.value === null)
  const adding = changes.some(([, v]) => v !== null && (v.grants !== null || v.ai !== null))
  if (empty && opts.implicitAdmins && adding && !changes.some(([f]) => f.normalize('NFC') === '')) {
    want.set('', { grants: Object.fromEntries(opts.implicitAdmins.map((a) => [a, 'manage' as Level])), ai: null })
  }
  for (const [folder, v] of changes) want.set(folder.normalize('NFC'), v === null || (v.grants === null && v.ai === null) ? null : v)
  const before = currentRules(doc)
  const asked = new Map(want)
  if (empty) {
    const added = [...want].filter(([, v]) => v !== null)
    if (added.length === 0) return text
    const block = added.map(([f, v]) => entryText(yamlKey(f, PLAIN_KEY), v!, '  ')).join('')
    if (pair) {
      // `permissions:` with nothing under it: the entries go right after its line.
      const at = nextLine(text, range(pair.key)[1])
      return verify(text.slice(0, at) + (at > 0 && text[at - 1] !== '\n' ? '\n' : '') + block + text.slice(at), asked, before)
    }
    const base = text === '' || text.endsWith('\n') ? text : text + '\n'
    return verify(`${base}permissions:\n${block}`, asked, before)
  }
  if (!isMap(pair!.value)) throw new PermissionsFileError('permissions in thoth.yaml is not a set of key: value')
  const map = pair!.value
  const spansLines = (i: Pair) => isMap(i.value) && i.value.flow && text.slice(range(i.key)[0], range(i.value)[1]).includes('\n')
  if (map.flow || (map.items as Pair[]).some(spansLines)) return verify(viaDocument(doc, map, want), asked, before)

  const splices: { from: number; to: number; text: string }[] = []
  const items = map.items as Pair[]
  const indent = items.length ? ' '.repeat(range(items[0]!.key)[0] - lineStart(text, range(items[0]!.key)[0])) : '  '
  let end = nextLine(text, range(pair!.key)[1])
  for (const item of items) {
    const keyStart = range(item.key)[0]
    const valueEnd = item.value !== null && typeof item.value === 'object' && 'range' in item.value ? range(item.value)[1] : range(item.key)[1]
    const from = lineStart(text, keyStart)
    const to = nextLine(text, Math.max(valueEnd - 1, keyStart))
    end = Math.max(end, to)
    const folder = folderKey(item)
    if (folder === null || !want.has(folder)) continue
    const v = want.get(folder)!
    want.delete(folder)
    if (v === null) { splices.push({ from, to, text: '' }); continue }
    // A block entry keeps its key's line (and the comment on it); only what is under it is written again.
    const keyLineEnd = nextLine(text, range(item.key)[1])
    if (/^\s*:\s*(#.*)?\r?\n?$/.test(text.slice(range(item.key)[1], keyLineEnd)) && keyLineEnd <= to) {
      splices.push({ from: keyLineEnd, to, text: keepComments(text.slice(keyLineEnd, to), entryText('', v, indent).slice(indent.length + 2)) })
    } else splices.push({ from, to, text: entryText(text.slice(keyStart, range(item.key)[1]), v, indent) })
  }
  const added = [...want].filter(([, v]) => v !== null).map(([f, v]) => entryText(yamlKey(f, PLAIN_KEY), v!, indent)).join('')
  if (added) splices.push({ from: end, to: end, text: (end > 0 && text[end - 1] !== '\n' ? '\n' : '') + added })
  let out = text
  for (const s of splices.sort((a, b) => b.from - a.from)) out = out.slice(0, s.from) + s.text + out.slice(s.to)
  return verify(out, asked, before)
}

/**
 * The comments of an entry's lines written again: a comment line stays, first,
 * and a comment at the end of a line (`grants: {…}  # why`) goes back to the
 * new line with the same key. Subjects and levels never hold a `#`.
 */
function keepComments(before: string, after: string): string {
  const own = before.split('\n').filter((l) => /^\s*#/.test(l))
  const trailing = new Map<string, string>()
  for (const l of before.split('\n')) {
    const m = /^\s*([^\s#:][^:#]*):[^#]*?(\s+#[^"'\n]*)$/.exec(l.replace(/\r$/, ''))
    if (m) trailing.set(m[1]!.trim(), m[2]!)
  }
  const lines = after.split('\n').map((l) => {
    const key = /^\s*([^\s#:][^:#]*):/.exec(l)?.[1]?.trim()
    const comment = key === undefined ? undefined : trailing.get(key)
    return comment === undefined || l.includes('#') ? l : l + comment
  })
  return (own.length ? own.join('\n') + '\n' : '') + lines.join('\n')
}

/** A section written in flow style: through the Document API (comments and order kept, spacing not). */
function viaDocument(doc: Document, map: YAMLMap, want: Map<string, RuleValue | null>): string {
  for (const [folder, v] of want) {
    const item = (map.items as Pair[]).find((i) => folderKey(i) === folder)
    if (v === null) {
      if (item) map.items.splice(map.items.indexOf(item), 1)
      continue
    }
    const node = doc.createNode({ ...(v.grants !== null ? { grants: v.grants } : {}), ...(v.ai === false ? { ai: false } : {}) }) as YAMLMap
    if (item) item.value = node
    else map.add(doc.createPair(folder, node))
  }
  return doc.toString()
}

/** The new text holds exactly the rules asked for, and the others as they were: anything else is a bug, and nothing is written. */
function verify(out: string, asked: Map<string, RuleValue | null>, before: Map<string, RuleValue>): string {
  const expected = new Map(before)
  for (const [f, v] of asked) {
    if (v === null) expected.delete(f)
    else expected.set(f, { grants: v.grants === null ? null : { ...v.grants }, ai: v.ai })
  }
  const norm = (m: Map<string, RuleValue>) => JSON.stringify([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  if (norm(currentRules(load(out))) !== norm(expected)) throw new Error('permissions: the edited thoth.yaml does not hold the rules asked for')
  return out
}

/** Sets one folder's rule (both fields null: removes it), leaving the rest of the file as it was. */
export function setRule(text: string, folder: string, value: RuleValue, opts: { implicitAdmins?: readonly string[] } = {}): string {
  return applyRules(text, [[folder, value]], opts)
}

/** The rules the file has now, by folder (NFC). */
export function rulesInFile(text: string): Map<string, RuleValue> {
  return currentRules(load(text))
}

/**
 * Moves the rules of `from` and every folder under it to `to` (a folder moved
 * or renamed from thoth). `extra`: rules to write as well, such as the
 * literal copy of a `{user}` rule that stops matching once the folder moves.
 * With `keepFrom`, the rules stay at `from` too (the first step of a move
 * that never leaves the folder without its rules).
 */
export function moveRules(text: string, from: string, to: string, opts: { extra?: readonly (RuleValue & { folder: string })[]; keepFrom?: boolean } = {}): string {
  const f = from.normalize('NFC')
  const t = to.normalize('NFC')
  const changes: Change[] = []
  for (const [key, v] of currentRules(load(text))) {
    if (key !== f && !key.startsWith(f + '/')) continue
    if (!opts.keepFrom) changes.push([key, null])
    changes.push([t + key.slice(f.length), v])
  }
  for (const e of opts.extra ?? []) changes.push([e.folder, { grants: e.grants, ai: e.ai }])
  return changes.length ? applyRules(text, changes) : text
}

/** Removes every rule of `folder` and under it (a folder deleted from thoth). */
export function removeRules(text: string, folder: string): string {
  const f = folder.normalize('NFC')
  const changes: Change[] = [...currentRules(load(text)).keys()]
    .filter((key) => key === f || (f !== '' && key.startsWith(f + '/'))).map((key) => [key, null])
  return changes.length ? applyRules(text, changes) : text
}

/**
 * Rewrites a subject in every rule's grants: renamed to `to` (a group
 * renamed), or removed with `to` null (a user deleted, D-038.8). A rule left
 * with no grants keeps them empty: its folder stays closed, never inheriting.
 */
export function rewriteSubject(text: string, subject: string, to: string | null): string {
  const key = subjectKey(subject)
  const changes: Change[] = []
  for (const [folder, v] of currentRules(load(text))) {
    if (!v.grants || !Object.keys(v.grants).some((s) => subjectKey(s) === key)) continue
    const grants: Record<string, Level> = {}
    for (const [s, l] of Object.entries(v.grants)) {
      const name = subjectKey(s) !== key ? s : to
      if (name !== null) grants[name] = maxLevel(grants[name] ?? null, l)!
    }
    changes.push([folder, { grants, ai: v.ai }])
  }
  return changes.length ? applyRules(text, changes) : text
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
