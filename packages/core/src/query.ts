// Search filters typed into the search box, next to the free text:
// - `tag:hogar` (the tag or any nested under it, `hogar/red`);
// - `path:notes/` (a folder, with its subfolders, or one note's path);
// - a frontmatter field: `type:decision` for any key whose name isn't
//   reserved (RESERVED_FILTERS), or `prop:type=decision` for any key at all
//   (`prop:tag=x` is the frontmatter's `tag`, not the tag filter). Key and
//   value ignore case; a list matches when any of its items does; a number
//   matches the same number however it's written (`5` and `5.0`);
// - `prop:due`, with no value: the note's frontmatter has that key.
// Quoted values for spaces (`path:"my notes/"`, `status:"in progress"`,
// `prop:"due date"=today`) and `-` in front to exclude (`-tag:done`,
// `-status:done`, `-prop:due`).
// The names in RESERVED_FILTERS are vihko's own, now or later (`is:`, `has:`,
// `in:`, `before:`, `after:` have no meaning yet): never a frontmatter field,
// so a filter that comes later never changes what an older query meant.
// Shared by the server (it applies them) and the UI (it knows a query with a
// filter is a search, never the name of a new note). The UI's main bundle takes
// this file: it imports nothing but case folding, so the Markdown parser stays
// in the editor's chunk.
import { caseFold } from './casefold.ts'
import { trimSlashes, trimTrailingSlashes } from './paths.ts'

/** The same normalisation as `normalizeTag` in markdown.ts (case-insensitive, full case folding). */
const normalizeTag = (t: string) => caseFold(t.replace(/^#/, ''))

/** How a frontmatter key or value is compared: NFC, full case folding. */
export const foldField = (s: string) => caseFold(s.normalize('NFC'))

/**
 * Filter names that are vihko's own, now (`tag`, `path`, `prop`) or later:
 * never read as a frontmatter field (`prop:<name>=<value>` reaches a field
 * with one of these names).
 */
export const RESERVED_FILTERS = ['tag', 'path', 'is', 'has', 'in', 'prop', 'before', 'after'] as const

/** Reserved names with no meaning yet: a filter with one matches no note (and, negated, every note). */
export type ReservedFilter = 'is' | 'has' | 'in' | 'before' | 'after'

export type SearchFilter =
  | {
    kind: 'tag' | 'path'
    /** Tags as the index keeps them (case-folded, no `#`); paths without leading or trailing `/`. */
    value: string
    negate: boolean
  }
  | {
    /** A frontmatter field equal to a value (`key:value`, `prop:key=value`). */
    kind: 'field'
    /** The key, case-folded (`foldField`). */
    key: string
    /** The value, case-folded (`foldField`). */
    value: string
    negate: boolean
  }
  | {
    /** A frontmatter key that is there, whatever its value (`prop:key`). */
    kind: 'exists'
    /** The key, case-folded (`foldField`). */
    key: string
    negate: boolean
  }
  | {
    /** A reserved filter that means nothing yet (`is:`, `has:`, `in:`, `before:`, `after:`). */
    kind: 'reserved'
    name: ReservedFilter
    value: string
    negate: boolean
  }

export interface ParsedQuery {
  /** What is left once the filters are taken out: the full-text part. */
  text: string
  filters: SearchFilter[]
}

// A value: quoted (a closing quote is optional, so a value being typed still
// counts) or up to the next space.
const VALUE = String.raw`(?:"([^"]*)"?|(\S*))`
// A key for the short form: it starts with a letter or `_` (so `10:30` or
// `C:` stay text) and goes on with letters, digits, `_`, `-` and `.`.
const FIELD_KEY = String.raw`[\p{L}_][\p{L}\p{N}_.\-]*`
// One token: `-`?, then `prop:`, `tag:`/`path:`, a reserved name, or `key:value`.
const FILTER = new RegExp(
  String.raw`(^|\s)(-?)(?:` +
    String.raw`(prop):(?:"([^"]*)"|([^\s="]*))(?:=${VALUE})?` + // 3 prop, 4-5 key, 6-7 value
    String.raw`|(tag|path):${VALUE}` + // 8 kind, 9-10 value
    String.raw`|(is|has|in|before|after):${VALUE}` + // 11 reserved, 12-13 value
    String.raw`|(${FIELD_KEY}):(?:"([^"]*)"?|(?!\/\/)(\S+))` + // 14 key, 15-16 value (never a URL's `//`)
  String.raw`)`,
  'giu',
)

export function parseSearchQuery(input: string): ParsedQuery {
  const filters: SearchFilter[] = []
  const text = input.normalize('NFC').replace(FILTER, (whole: string, lead: string, neg: string, ...g: (string | undefined)[]) => {
    const negate = neg === '-'
    const [prop, propKeyQ, propKeyB, propValQ, propValB, kind, valQ, valB, reserved, resQ, resB, key, fieldQ, fieldB] = g as (string | undefined)[]
    if (prop !== undefined) {
      const k = foldField((propKeyQ ?? propKeyB ?? '').trim())
      const hasValue = propValQ !== undefined || propValB !== undefined
      const v = foldField((propValQ ?? propValB ?? '').trim())
      // `prop:key` with no `=` asks only that the key is there; `prop:key=` (a value still to type) asks nothing yet.
      if (k && hasValue && v) filters.push({ kind: 'field', key: k, value: v, negate })
      else if (k && !hasValue) filters.push({ kind: 'exists', key: k, negate })
      return lead
    }
    if (kind !== undefined) {
      const k = kind.toLowerCase() as 'tag' | 'path'
      const raw = (valQ ?? valB ?? '').trim()
      const value = k === 'tag' ? trimTrailingSlashes(normalizeTag(raw)) : trimSlashes(raw)
      if (value) filters.push({ kind: k, value, negate })
      return lead
    }
    if (reserved !== undefined) {
      const value = foldField((resQ ?? resB ?? '').trim())
      if (value) filters.push({ kind: 'reserved', name: reserved.toLowerCase() as ReservedFilter, value, negate })
      return lead
    }
    if (key !== undefined) {
      const k = foldField(key)
      // A reserved name spelled otherwise (in another case, say): never a field.
      if ((RESERVED_FILTERS as readonly string[]).includes(k)) return lead
      const v = foldField((fieldQ ?? fieldB ?? '').trim())
      if (v) filters.push({ kind: 'field', key: k, value: v, negate })
      return lead
    }
    return whole
  })
  return { text: text.replace(/\s+/g, ' ').trim(), filters }
}

/**
 * true if the query has a filter, even one still without a value (`tag:`,
 * `prop:`, a reserved name): a query like that is a search, never a new
 * note's name. A frontmatter field counts once it has a value (`type:x`):
 * `Re:` alone may still be the start of a name.
 */
export const hasSearchFilter = (input: string) =>
  new RegExp(String.raw`(^|\s)-?(${RESERVED_FILTERS.join('|')}):`, 'iu').test(input) || parseSearchQuery(input).filters.length > 0
