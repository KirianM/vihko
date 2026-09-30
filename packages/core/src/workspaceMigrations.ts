// vihko.yaml's format migrations (D-042.6). When a version of vihko changes
// how something is written in vihko.yaml, the server rewrites the file itself
// when it starts (server configMigrations.ts), keeping a copy of it as it was.
// Migrations don't go by the file's `version:`: each one looks at the content
// and applies only where the old form is there and the new one isn't, so
// running it again changes nothing (and a `version` set by hand can't make
// one skip an old form).
//
// `version` is the format's number: 1 until the first migration, and each
// release that adds migrations gives them the next one (WORKSPACE_VERSION is
// the highest). A rewrite raises the file's `version` to it (adding the key
// if it was missing), so that an older vihko reading the file, after a roll
// back, says it's newer than it understands (`newer_version`) instead of
// only ignoring the new forms as unknown keys. A file with nothing to
// migrate is never rewritten just for its number.
//
// A migration changes the file's yaml Document, which carries its comments,
// key order and unknown keys. But the Document's rendering of the whole file
// respaces aligned comments, reindents lists and drops a final line's missing
// line break, so it isn't what gets written: the change is taken as the diff
// between two renderings (before and after the migrations) and applied to the
// file as it was (a three-way merge by lines, and by words where a changed
// line is one the rendering respaced). Everything the migrations didn't
// change stays byte for byte, down to a renamed key's aligned comment; only
// where the file's own spacing and a change touch the same words does that
// stretch come out as the Document writes it. The merged text must read back
// as the migrated Document; if it doesn't (or the file is too big to merge),
// the Document's rendering is written whole.
import { isMap, isScalar, type Document } from 'yaml'
import type { ConfigMigrationRef } from './codes.ts'
import { parseYamlDocument } from './yaml.ts'

export interface WorkspaceMigration extends ConfigMigrationRef {
  /**
   * The format (`version`) the file is in once this migration applied: 2
   * or more, the same for every migration of one release, never lower than
   * an earlier migration's.
   */
  version: number
  /**
   * Changes `doc` from the old form to the new one, only where the old one is
   * present and the new one absent. Whether it changed anything. It may
   * throw: then nothing is written.
   */
  apply: (doc: Document) => boolean
}

/**
 * The format's migrations, oldest first. None yet: adding one is one entry
 * here (its id, a line saying what it does, and `apply`), with a test.
 */
export const WORKSPACE_MIGRATIONS: readonly WorkspaceMigration[] = []

/** The format of `migrations`: the highest `version` among them, 1 without any. */
export const formatVersion = (migrations: readonly WorkspaceMigration[]) => migrations.reduce((v, m) => Math.max(v, m.version), 1)

/** The newest `version` of vihko.yaml this vihko understands (see the header). A missing `version` is 1. */
export const WORKSPACE_VERSION = formatVersion(WORKSPACE_MIGRATIONS)

export type MigrationOutcome =
  /** Nothing applies: the file stays as it is. */
  | { kind: 'none' }
  /** The file isn't valid YAML: its format can't be checked (the workspace alert says why). */
  | { kind: 'invalid'; detail: string }
  /** `migration` threw, or applies again to what it wrote: nothing is written. */
  | { kind: 'failed'; migration: ConfigMigrationRef; detail: string }
  /** The file's new text, and the migrations that changed it, in order. */
  | { kind: 'migrated'; text: string; applied: ConfigMigrationRef[] }

const ref = (m: WorkspaceMigration): ConfigMigrationRef => ({ id: m.id, description: m.description })
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const render = (doc: Document) => doc.toString({ lineWidth: 0 })

/** Runs `migrations` over vihko.yaml's `text` (see the header). */
export function migrateWorkspaceText(text: string, migrations: readonly WorkspaceMigration[] = WORKSPACE_MIGRATIONS): MigrationOutcome {
  if (migrations.length === 0) return { kind: 'none' }
  const doc = parseYamlDocument(text)
  if (doc.errors.length) return { kind: 'invalid', detail: doc.errors[0]!.message }
  const before = render(doc)
  const applied: ConfigMigrationRef[] = []
  for (const m of migrations) {
    try {
      if (m.apply(doc)) applied.push(ref(m))
    } catch (err) {
      return { kind: 'failed', migration: ref(m), detail: message(err) }
    }
  }
  if (applied.length === 0) return { kind: 'none' }
  raiseVersion(doc, formatVersion(migrations))
  const after = render(doc)
  const merged = mergeChange(text, before, after)
  const out = merged !== null && sameDocument(merged, after) ? merged : after
  if (out === text) return { kind: 'none' }
  // What was written must be the new form for good: a migration that applies again would rewrite the file at every start.
  const again = parseYamlDocument(out)
  for (const m of migrations) {
    try {
      if (m.apply(again)) return { kind: 'failed', migration: ref(m), detail: 'it applies again to the text it wrote (not idempotent)' }
    } catch (err) {
      return { kind: 'failed', migration: ref(m), detail: message(err) }
    }
  }
  return { kind: 'migrated', text: out, applied }
}

/**
 * The file's `version` raised to `target`: set where it's a lower whole
 * number, added as the first key where it's missing. A `version` that isn't
 * a whole number is left for the workspace's own alert (`invalid_version`),
 * and a higher one (a newer vihko's) is never lowered.
 */
function raiseVersion(doc: Document, target: number) {
  if (!isMap(doc.contents)) return
  const node = doc.get('version', true)
  if (node === undefined) {
    if (target <= 1) return
    const pair = doc.createPair('version', target)
    // A comment right above the first key is the file's header as often as that key's: it stays on top.
    const first = doc.contents.items[0]?.key
    if (isScalar(first) && first.commentBefore && isScalar(pair.key)) {
      pair.key.commentBefore = first.commentBefore
      first.commentBefore = undefined
    }
    doc.contents.items.unshift(pair)
  } else if (isScalar(node) && typeof node.value === 'number' && Number.isInteger(node.value) && node.value < target) {
    node.value = target
  }
}

/** Whether two texts read as the same Document: same data, comments and order (the renderings match). */
function sameDocument(a: string, b: string): boolean {
  const da = parseYamlDocument(a)
  const db = parseYamlDocument(b)
  return da.errors.length === 0 && db.errors.length === 0 && render(da) === render(db)
}

/** Lines with their line break. */
const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? []

/** Lines `[from, to)` of a base replaced with `lines`. */
interface Hunk { from: number; to: number; lines: string[] }

/** Past this many cells, the line diff isn't worth it: the Document's rendering is written whole. */
const MAX_CELLS = 1_000_000

/** The hunks that turn `a` into `b` (a longest-common-subsequence diff of lines); null if too big. */
function hunks(a: readonly string[], b: readonly string[]): Hunk[] | null {
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  const n = a.length - p - s
  const m = b.length - p - s
  if ((n + 1) * (m + 1) > MAX_CELLS) return null
  // common[i * w + j]: lines in common between a's middle from i and b's from j.
  const w = m + 1
  const common = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      common[i * w + j] = a[p + i] === b[p + j] ? common[(i + 1) * w + j + 1]! + 1 : Math.max(common[(i + 1) * w + j]!, common[i * w + j + 1]!)
    }
  }
  const out: Hunk[] = []
  let cur: Hunk | null = null
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[p + i] === b[p + j]) {
      if (cur) out.push(cur)
      cur = null
      i++
      j++
      continue
    }
    cur ??= { from: p + i, to: p + i, lines: [] }
    if (j < m && (i === n || common[i * w + j + 1]! >= common[(i + 1) * w + j]!)) cur.lines.push(b[p + j++]!)
    else cur.to = p + ++i
  }
  if (cur) out.push(cur)
  return out
}

/** `base`'s lines `[from, to)` with `list`'s hunks (all within them) applied. */
function applyHunks(base: readonly string[], list: readonly Hunk[], from: number, to: number): string[] {
  const out: string[] = []
  let at = from
  for (const h of list) {
    out.push(...base.slice(at, h.from), ...h.lines)
    at = h.to
  }
  out.push(...base.slice(at, to))
  return out
}

/** Words, runs of spaces (line breaks included) and marks, each one token. */
const words = (text: string) => text.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? []

/**
 * The three-way merge of token lists over `base`: `ours` (the file) and
 * `theirs` (its rendering with the change) each changed it in places. Where
 * both changed the same tokens (or inserted at the same place), `theirs`
 * wins: by lines, that stretch is merged again by words first, so a line
 * whose spacing is the file's own and whose key the migration renamed keeps
 * both. null if too big to diff.
 */
function merge3(base: readonly string[], ours: readonly string[], theirs: readonly string[], byWords: boolean): string[] | null {
  const mine = hunks(base, ours)
  const change = hunks(base, theirs)
  if (mine === null || change === null) return null
  const out: string[] = []
  let at = 0
  let i = 0
  let j = 0
  while (i < mine.length || j < change.length) {
    // A group: the next hunk and every hunk of either side that overlaps it (an insertion also where the group starts or ends).
    const first = j >= change.length || (i < mine.length && mine[i]!.from < change[j]!.from) ? mine[i]! : change[j]!
    const from = first.from
    let to = first.to
    const own: Hunk[] = []
    const theirsHere: Hunk[] = []
    const joins = (h: Hunk) => h.from < to || (h.from === to && (h.from === h.to || from === to))
    for (;;) {
      if (i < mine.length && joins(mine[i]!)) { to = Math.max(to, mine[i]!.to); own.push(mine[i++]!) }
      else if (j < change.length && joins(change[j]!)) { to = Math.max(to, change[j]!.to); theirsHere.push(change[j++]!) }
      else break
    }
    out.push(...base.slice(at, from))
    if (theirsHere.length === 0) out.push(...applyHunks(base, own, from, to))
    else if (own.length === 0) out.push(...applyHunks(base, theirsHere, from, to))
    else {
      const wanted = applyHunks(base, theirsHere, from, to)
      const merged = byWords ? merge3(words(base.slice(from, to).join('')), words(applyHunks(base, own, from, to).join('')), words(wanted.join('')), false) : null
      out.push(...(merged ? [merged.join('')] : wanted))
    }
    at = to
  }
  out.push(...base.slice(at))
  return out
}

/**
 * The file (`original`) with the change from `before` to `after` (renderings
 * of its Document) applied (see the header). null if too big to diff.
 */
function mergeChange(original: string, before: string, after: string): string | null {
  return merge3(lines(before), lines(original), lines(after), true)?.join('') ?? null
}
