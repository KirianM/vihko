// Per-folder permissions: the strict `permissions`
// section of vihko.yaml, the levels it gives (sharing only adds), and the
// edits vihko makes to the file (keeping everything else in it as it was).
//
//   permissions:
//     spaces/Home:                    # a shared space: its members
//       grants: { "@family": edit, ana: manage }
//     spaces/Home/recipes:            # adds luis, who isn't a member of Home
//       grants: { luis: read }
//     spaces/Home/finances:
//       ai: false
//     people/ana/trips:               # a folder of ana's shared with luis
//       grants: { luis: comment }
//     people/ana:                     # ana's whole space closed to agents
//       ai: false
//
// - Keys are real folders from the notes root (core/spaces.ts): a shared
//   space's root and what's under it; a folder inside a personal space. A
//   personal space's root takes only `ai: false`, never grants (it isn't
//   shared whole: that's what a shared space is). `name`, only at a shared
//   space's root, is 0.1.0-rc.1 and rc.2's: read for the start that renames
//   such a space's folder to it, never written. Anything else (`""`, `people`, `spaces`, anything outside
//   them, a `{user}` segment) rejects the section.
// - Subjects: a user's name or `@group`.
// - Levels, from less to more: read < comment < edit < manage.
// - A person's level in a folder: `manage` in their own personal space
//   (whatever is written); nothing in the space of someone who doesn't exist
//   (deleted); otherwise the highest level the grants of the folder and of
//   each folder above it, up to its space's root, give them by name or
//   through a group. Grants only add: a subfolder never gives less than its
//   parent, so nothing hidden takes up names where people create. Being an
//   admin changes nothing: admins manage, they don't read what isn't shared
//   with them.
// - `ai: false` holds for the folder and everything under it, on top of the
//   notes' own `ai: false`. `ai: true` never reopens anything: ignored, with
//   a notice.
// - The section is strict, failing closed: anything wrong in it rejects it whole,
//   and then no grant applies (`closed`): each person still has their own
//   space, which doesn't depend on the file. Without the section, the same
//   (`none`): nobody shares anything.
//
// This module knows nothing of users or groups: the server resolves subjects
// (and warns about the ones it doesn't know).
import { isMap, isScalar, type Document, type Pair, type YAMLMap } from 'yaml'
import { parseSpacePath } from './spaces.ts'
import { parseYamlDocument } from './yaml.ts'

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

/** One folder's rule as written. `grants` null: none of its own; `ai` null: nothing about agents. */
export interface PermissionRule {
  /** Its key: a real folder (NFC) in a space. */
  folder: string
  grants: Record<string, Level> | null
  ai: false | null
  /** 0.1.0-rc.1 and rc.2's name of a shared space, at its root (`spaces/<readable>-<id>`): what the start renames its folder to. */
  name?: string
}

/**
 * The section as it applies:
 * - `none`: the file has none: no grants (each person has their own space).
 * - `closed`: it was rejected (and no valid one was in force): no grants.
 * - `rules`: the rules written.
 */
export type Permissions =
  | { kind: 'none' }
  | { kind: 'closed' }
  | { kind: 'rules'; rules: PermissionRule[] }

export const NO_PERMISSIONS: Permissions = { kind: 'none' }
export const CLOSED_PERMISSIONS: Permissions = { kind: 'closed' }

/** The rules a section in force gives (none when it's missing or rejected). */
export function rulesOf(p: Permissions): readonly PermissionRule[] {
  return p.kind === 'rules' ? p.rules : []
}

/** A problem in the section: its code (ConfigErrorCode), where (as a key path) and a detail. */
export type PermissionsReport = (code: 'not_a_map' | 'invalid_path' | 'invalid_value' | 'invalid_type' | 'not_boolean' | 'unknown_key' | 'ignored_value', at: string[], detail?: string | null) => void

const RULE_KEYS = ['grants', 'ai', 'name']
const USERNAME = /^[\p{L}\p{N}._-]{2,64}$/u
const GROUP = /^@[^\u0000-\u001f@/]{1,64}$/u

/** Whether a subject is written as one: a user's name or `@group`. */
export function isSubject(s: string): boolean {
  return USERNAME.test(s) || (GROUP.test(s) && s.slice(1).trim() === s.slice(1))
}

/** A folder key: relative, no leading or trailing `/`, no `.`/`..` or hidden segments. */
function folderProblem(key: string): string | null {
  if (key === '') return 'the root'
  if (/[\\\u0000-\u001f]/.test(key)) return 'control characters'
  const segs = key.split('/')
  if (!segs.every((s) => s !== '' && !s.startsWith('.') && s.trim() === s)) return 'not a folder'
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
    let grants: Record<string, Level> | null = null
    if (value.grants !== undefined && value.grants !== null) {
      if (!isRecord(value.grants)) report('not_a_map', [...here, 'grants'])
      else {
        grants = {}
        for (const [rawSubject, level] of Object.entries(value.grants)) {
          const subject = rawSubject.normalize('NFC')
          const where = [...here, 'grants', rawSubject]
          if (!isSubject(subject)) { report('invalid_value', where, 'user, @group'); continue }
          if (typeof level !== 'string' || !(LEVELS as readonly string[]).includes(level)) { report('invalid_value', where, LEVELS.join(', ')); continue }
          const key = subjectKey(subject)
          if (Object.keys(grants).some((s) => subjectKey(s) === key)) { report('invalid_value', where); continue }
          grants[subject] = level as Level
        }
      }
    }
    const keyProblem = spaceKeyProblem(folder, { grants })
    if (keyProblem) { report('invalid_path', here, keyProblem); continue }
    let ai: false | null = null
    if (value.ai !== undefined && value.ai !== null) {
      if (value.ai === false) ai = false
      else if (value.ai === true) notice('ignored_value', [...here, 'ai'], 'ai: true')
      else report('not_boolean', [...here, 'ai'])
    }
    // `name` is 0.1.0-rc.1 and rc.2's (a space's name): the folder is the
    // name now, and the start renames such a folder to it. Read, never written.
    let name: string | null = null
    if (value.name !== undefined && value.name !== null) {
      const root = parseSpacePath(folder)
      if (typeof value.name !== 'string') report('invalid_type', [...here, 'name'], 'string')
      else if (!root || root.space.kind !== 'shared' || root.inner !== '') report('invalid_value', [...here, 'name'], 'only at a shared space root')
      else name = value.name.normalize('NFC')
    }
    rules.push({ folder, grants, ai, ...(name !== null ? { name } : {}) })
  }
  return { kind: 'rules', rules }
}

/** How subjects are compared: user and group names ignore case (state.db compares names without it). */
export function subjectKey(subject: string): string {
  return subject.normalize('NFC').toLowerCase()
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

// --- Levels (see the header) ------------------------------------------------------

/** Why a key can't be in the section, or null. */
export type SpaceKeyProblem = 'user_segment' | 'outside_spaces' | 'personal_root_grants'

/**
 * What's wrong with a rule's key: a `{user}` segment (1.0's
 * per-user rules), a key in no space (the root, `people`, `spaces`,
 * anything else), or grants at a personal space's root. `name` outside a
 * shared space's root is the parser's (`invalid_value`).
 */
export function spaceKeyProblem(folder: string, rule: { grants: Record<string, Level> | null }): SpaceKeyProblem | null {
  const f = folder.normalize('NFC')
  if (f.split('/').includes('{user}')) return 'user_segment'
  const s = parseSpacePath(f)
  if (!s) return 'outside_spaces'
  if (s.space.kind === 'personal' && s.inner === '' && rule.grants !== null) return 'personal_root_grants'
  return null
}

/** Someone the grants may name: their username and their groups (without `@`). */
export interface Grantee {
  username: string
  groups: readonly string[]
}

/** One grant that reaches a folder: who, what level, and the folder it's written at (the folder itself or one above it in its space). */
export interface ReachingGrant {
  subject: string
  level: Level
  from: string
}

/**
 * The rules of the spaces model, ready to answer levels. Pure: nothing of the
 * users but what the caller passes. Rules the model doesn't take
 * (spaceKeyProblem) are left out.
 */
export class SpaceRules {
  readonly rules: readonly PermissionRule[]
  private byFolder = new Map<string, PermissionRule>()
  private reachCache = new Map<string, ReachingGrant[]>()

  constructor(rules: readonly PermissionRule[] | Permissions) {
    const list = 'kind' in rules ? rulesOf(rules) : rules
    this.rules = list.filter((r) => spaceKeyProblem(r.folder, r) === null)
    for (const r of this.rules) this.byFolder.set(r.folder.normalize('NFC'), r)
  }

  /** The rule written for exactly this folder, if any. */
  own(folder: string): PermissionRule | null {
    return this.byFolder.get(folder.normalize('NFC')) ?? null
  }

  /**
   * Every grant that reaches a folder: those written at its space's root and
   * at each folder down to it, the root's first. None outside a space.
   */
  reaching(folder: string): ReachingGrant[] {
    const f = folder.normalize('NFC')
    const cached = this.reachCache.get(f)
    if (cached) return cached
    const out: ReachingGrant[] = []
    const s = parseSpacePath(f)
    if (s) {
      const chain = [s.space.root]
      if (s.inner !== '') {
        let at = s.space.root
        for (const seg of s.inner.split('/')) chain.push((at = `${at}/${seg}`))
      }
      for (const d of chain) {
        const r = this.byFolder.get(d)
        for (const [subject, level] of Object.entries(r?.grants ?? {})) out.push({ subject, level, from: d })
      }
    }
    if (this.reachCache.size > 20_000) this.reachCache.clear()
    this.reachCache.set(f, out)
    return out
  }

  /**
   * The level `who` has in a folder (a space's root or anything under it);
   * null: none. `userExists` says whether a personal space's owner exists
   * (active or disabled): a deleted person's space is nobody's.
   */
  level(folder: string, who: Grantee, userExists: (username: string) => boolean): Level | null {
    const s = parseSpacePath(folder)
    if (!s) return null
    if (s.space.kind === 'personal') {
      if (!userExists(s.space.owner)) return null
      if (who.username.normalize('NFC') === s.space.owner) return 'manage'
    }
    const me = subjectKey(who.username)
    const groups = new Set(who.groups.map((g) => subjectKey('@' + g)))
    let level: Level | null = null
    for (const g of this.reaching(folder)) {
      const k = subjectKey(g.subject)
      if (k === me || groups.has(k)) level = maxLevel(level, g.level)
    }
    return level
  }

  /** The folder (itself, or one above it up to its space's root) whose `ai: false` closes it to agents; null if none does, or it is in no space. */
  aiClosedAt(folder: string): string | null {
    const s = parseSpacePath(folder)
    if (!s) return null
    const f = folder.normalize('NFC')
    for (let d: string | null = f; d !== null && d.length >= s.space.root.length; d = parentFolder(d)) {
      if (this.byFolder.get(d)?.ai === false) return d
    }
    return null
  }

  /** The name 0.1.0-rc.1 or rc.2 wrote at a shared space's root (PermissionRule `name`); null if none is. */
  legacyName(root: string): string | null {
    return this.byFolder.get(root.normalize('NFC'))?.name ?? null
  }

  /** The folders with grants of their own (at least one subject), as written. */
  granted(): string[] {
    return this.rules.filter((r) => r.grants !== null && Object.keys(r.grants).length > 0).map((r) => r.folder)
  }
}

// --- Writing vihko.yaml ---------------------------------------------------------
// vihko only ever changes the `permissions` entries it's asked to. Each one is
// spliced into the text where it was (or added at the end of the section):
// comments, blank lines, quoting, key order and every other section stay
// byte for byte as they were. Only a section written in flow style (`{…}`
// spanning lines) is rewritten through the yaml Document API, which keeps
// its comments and order but not its spacing.

/** A rule as vihko writes it. All null (or `name` absent): the folder has no rule (it's removed). */
export interface RuleValue {
  grants: Record<string, Level> | null
  ai: false | null
  /** A shared space's name, at its root. Absent or null: none. */
  name?: string | null
}

/** Whether a rule value says nothing (writing it removes the rule). */
const emptyValue = (v: RuleValue) => v.grants === null && v.ai === null && (v.name ?? null) === null

/** vihko.yaml can't be edited as it is (not valid YAML, or `permissions` isn't a map): it's fixed by hand first. */
export class PermissionsFileError extends Error {}

type Ranged = { range: [number, number, number] }
const range = (node: unknown): [number, number, number] => (node as Ranged).range

function load(text: string): Document {
  const doc = parseYamlDocument(text)
  if (doc.errors.length) throw new PermissionsFileError(`vihko.yaml is not valid YAML: ${doc.errors[0]!.message}`)
  if (doc.contents !== null && !isMap(doc.contents)) throw new PermissionsFileError('vihko.yaml is not a set of key: value')
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
    const js = (isMap(item.value) ? item.value.toJSON() : {}) as { grants?: Record<string, Level> | null; ai?: unknown; name?: unknown }
    out.set(folder, {
      grants: js.grants && typeof js.grants === 'object' ? { ...js.grants } : null,
      ai: js.ai === false ? false : null,
      ...(typeof js.name === 'string' ? { name: js.name.normalize('NFC') } : {}),
    })
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

/** A shared space's name as a YAML scalar: plain when that reads back the same, double-quoted otherwise. */
function nameText(name: string): string {
  return /^[\p{L}\p{N}_][\p{L}\p{N}_ .()'-]*$/u.test(name) && name.trim() === name && !/^(true|false|null|yes|no|on|off|y|n|~)$/i.test(name) && !/^[\d.+-]/.test(name)
    ? name : JSON.stringify(name)
}

/** One entry of the section in block style, at `indent`. */
function entryText(keySource: string, value: RuleValue, indent: string): string {
  let out = `${indent}${keySource}:\n`
  if (value.name) out += `${indent}  name: ${nameText(value.name)}\n`
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

/** Sets each folder's rule (null, or every field null: removes it) and returns the new text. */
function applyRules(text: string, changes: readonly Change[]): string {
  const doc = load(text)
  const want = new Map<string, RuleValue | null>()
  const pair = sectionPair(doc)
  const empty = !pair || pair.value === null || (isScalar(pair.value) && pair.value.value === null)
  for (const [folder, v] of changes) want.set(folder.normalize('NFC'), v === null || emptyValue(v) ? null : v)
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
  if (!isMap(pair!.value)) throw new PermissionsFileError('permissions in vihko.yaml is not a set of key: value')
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
    const node = doc.createNode({ ...(v.name ? { name: v.name } : {}), ...(v.grants !== null ? { grants: v.grants } : {}), ...(v.ai === false ? { ai: false } : {}) }) as YAMLMap
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
    else expected.set(f, { grants: v.grants === null ? null : { ...v.grants }, ai: v.ai, ...(v.name ? { name: v.name.normalize('NFC') } : {}) })
  }
  const norm = (m: Map<string, RuleValue>) => JSON.stringify([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  if (norm(currentRules(load(out))) !== norm(expected)) throw new Error('permissions: the edited vihko.yaml does not hold the rules asked for')
  return out
}

/** Sets one folder's rule (every field null: removes it), leaving the rest of the file as it was. */
export function setRule(text: string, folder: string, value: RuleValue): string {
  return applyRules(text, [[folder, value]])
}

/** The rules the file has now, by folder (NFC). */
export function rulesInFile(text: string): Map<string, RuleValue> {
  return currentRules(load(text))
}

/**
 * Moves the rules of `from` and every folder under it to `to` (a folder moved
 * or renamed from vihko). Rules already written at `to` or under it (for a
 * folder that didn't exist: a forgotten audience) go: the folder
 * brings its own. `extra`: rules to write as well. With `keepFrom`, the rules
 * stay at `from` too (the first step of a move that never leaves the folder
 * without its rules).
 */
export function moveRules(text: string, from: string, to: string, opts: { extra?: readonly (RuleValue & { folder: string })[]; keepFrom?: boolean } = {}): string {
  const f = from.normalize('NFC')
  const t = to.normalize('NFC')
  const changes: Change[] = []
  const rules = currentRules(load(text))
  const under = (key: string, root: string) => key === root || key.startsWith(root + '/')
  for (const key of rules.keys()) if (under(key, t) && !under(key, f)) changes.push([key, null])
  for (const [key, v] of rules) {
    if (!under(key, f)) continue
    if (!opts.keepFrom) changes.push([key, null])
    changes.push([t + key.slice(f.length), v])
  }
  for (const e of opts.extra ?? []) changes.push([e.folder, { grants: e.grants, ai: e.ai, name: e.name ?? null }])
  return changes.length ? applyRules(text, changes) : text
}

/** Removes every rule of `folder` and under it (a folder deleted from vihko). */
export function removeRules(text: string, folder: string): string {
  const f = folder.normalize('NFC')
  const changes: Change[] = [...currentRules(load(text)).keys()]
    .filter((key) => key === f || (f !== '' && key.startsWith(f + '/'))).map((key) => [key, null])
  return changes.length ? applyRules(text, changes) : text
}

/**
 * Rewrites a subject in every rule's grants: renamed to `to` (a group
 * renamed), or removed with `to` null (a user deleted). A rule left
 * with no grants keeps them empty (which gives nobody anything).
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
    changes.push([folder, { ...v, grants }])
  }
  return changes.length ? applyRules(text, changes) : text
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
