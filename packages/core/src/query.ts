// Search filters typed into the search box, next to the free text:
// `tag:hogar` (the tag or any nested under it, `hogar/red`), `path:notes/`
// (a folder, with its subfolders, or one note's path), quoted values for
// spaces (`path:"my notes/"`) and `-` in front to exclude (`-tag:done`).
// Shared by the server (it applies them) and the UI (it knows a query with a
// filter is a search, never the name of a new note). No imports: the UI's main
// bundle takes this file, and the Markdown parser stays in the editor's chunk.

/** The same normalisation as `normalizeTag` in markdown.ts (D-019: case-insensitive). */
const normalizeTag = (t: string) => t.replace(/^#/, '').normalize('NFC').toLowerCase()

export interface SearchFilter {
  kind: 'tag' | 'path'
  /** Tags as the index keeps them (lowercase, no `#`); paths without leading or trailing `/`. */
  value: string
  negate: boolean
}

export interface ParsedQuery {
  /** What is left once the filters are taken out: the full-text part. */
  text: string
  filters: SearchFilter[]
}

// A closing quote is optional, so a value being typed still counts.
const FILTER = /(^|\s)(-?)(tag|path):(?:"([^"]*)"?|(\S*))/giu

export function parseSearchQuery(input: string): ParsedQuery {
  const filters: SearchFilter[] = []
  const text = input.normalize('NFC').replace(FILTER, (_m, lead: string, neg: string, kind: string, quoted: string | undefined, bare: string | undefined) => {
    const k = kind.toLowerCase() as SearchFilter['kind']
    const raw = (quoted ?? bare ?? '').trim()
    const value = k === 'tag' ? normalizeTag(raw).replace(/\/+$/, '') : raw.replace(/^\/+|\/+$/g, '')
    if (value) filters.push({ kind: k, value, negate: neg === '-' })
    return lead
  })
  return { text: text.replace(/\s+/g, ' ').trim(), filters }
}

/** true if the query has a filter, even one still without a value (`tag:`). */
export const hasSearchFilter = (input: string) => /(^|\s)-?(tag|path):/iu.test(input)
