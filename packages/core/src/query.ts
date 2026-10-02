// Search filters typed into the search box, next to the free text:
// - `tag:hogar` (the tag or any nested under it, `hogar/red`);
// - `path:notes/` (a folder, with its subfolders, or one note's path);
// - a frontmatter field: `type:decision` for any key that isn't one of the
//   filters here, or `prop:type=decision` for any key at all (`prop:tag=x`
//   is the frontmatter's `tag`, not the tag filter). Key and value ignore
//   case; a list matches when any of its items does; a number matches the
//   same number however it's written (`5` and `5.0`);
// - `has:due`: the note's frontmatter has that key.
// Quoted values for spaces (`path:"my notes/"`, `status:"in progress"`,
// `prop:"due date"=today`) and `-` in front to exclude (`-tag:done`,
// `-status:done`, `-has:due`).
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
    /** A frontmatter key that is there, whatever its value (`has:key`). */
    kind: 'has'
    /** The key, case-folded (`foldField`). */
    key: string
    negate: boolean
  }

export interface ParsedQuery {
  /** What is left once the filters are taken out: the full-text part. */
  text: string
  filters: SearchFilter[]
}

/** The filters with a name of their own: any other `name:value` is a frontmatter field. */
export const BUILTIN_FILTERS = ['tag', 'path', 'prop', 'has'] as const

// A value: quoted (a closing quote is optional, so a value being typed still
// counts) or up to the next space.
const VALUE = String.raw`(?:"([^"]*)"?|(\S*))`
// A key for the short form: it starts with a letter or `_` (so `10:30` or
// `C:` stay text) and goes on with letters, digits, `_`, `-` and `.`.
const FIELD_KEY = String.raw`[\p{L}_][\p{L}\p{N}_.\-]*`
// One token: `-`?, then `prop:`, `has:`, `tag:`/`path:`, or `key:value`.
const FILTER = new RegExp(
  String.raw`(^|\s)(-?)(?:` +
    String.raw`(prop):(?:"([^"]*)"|([^\s="]*))(?:=${VALUE})?` + // 3 prop, 4-5 key, 6-7 value
    String.raw`|(has):${VALUE}` + // 8 has, 9-10 key
    String.raw`|(tag|path):${VALUE}` + // 11 kind, 12-13 value
    String.raw`|(${FIELD_KEY}):(?:"([^"]*)"?|(?!\/\/)(\S+))` + // 14 key, 15-16 value (never a URL's `//`)
  String.raw`)`,
  'giu',
)

export function parseSearchQuery(input: string): ParsedQuery {
  const filters: SearchFilter[] = []
  const text = input.normalize('NFC').replace(FILTER, (whole: string, lead: string, neg: string, ...g: (string | undefined)[]) => {
    const negate = neg === '-'
    const [prop, propKeyQ, propKeyB, propValQ, propValB, has, hasQ, hasB, kind, valQ, valB, key, fieldQ, fieldB] = g as (string | undefined)[]
    if (prop !== undefined) {
      const k = foldField((propKeyQ ?? propKeyB ?? '').trim())
      const hasValue = propValQ !== undefined || propValB !== undefined
      const v = foldField((propValQ ?? propValB ?? '').trim())
      // `prop:key` with no `=` yet asks only that the key is there.
      if (k && hasValue && v) filters.push({ kind: 'field', key: k, value: v, negate })
      else if (k && !hasValue) filters.push({ kind: 'has', key: k, negate })
      return lead
    }
    if (has !== undefined) {
      const k = foldField((hasQ ?? hasB ?? '').trim())
      if (k) filters.push({ kind: 'has', key: k, negate })
      return lead
    }
    if (kind !== undefined) {
      const k = kind.toLowerCase() as 'tag' | 'path'
      const raw = (valQ ?? valB ?? '').trim()
      const value = k === 'tag' ? trimTrailingSlashes(normalizeTag(raw)) : trimSlashes(raw)
      if (value) filters.push({ kind: k, value, negate })
      return lead
    }
    if (key !== undefined) {
      const k = foldField(key)
      // `Prop:` or `HAS:` spelled otherwise, without what they need: still theirs, never a field.
      if ((BUILTIN_FILTERS as readonly string[]).includes(k)) return whole
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
 * `has:`, `prop:`): a query like that is a search, never a new note's name.
 * A frontmatter field counts once it has a value (`type:x`): `Re:` alone may
 * still be the start of a name.
 */
export const hasSearchFilter = (input: string) =>
  /(^|\s)-?(tag|path|has|prop):/iu.test(input) || parseSearchQuery(input).filters.length > 0
