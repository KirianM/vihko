// Search: the text the user types becomes a safe FTS5 query (their text is
// never passed as FTS5 syntax: operators, quotes or columns would give errors
// or odd results; each word is a term, the last one a prefix), and the
// `tag:`/`path:` filters (@vihko/core/query) become conditions on the index.
import { parseSearchQuery, type SearchFilter } from '@vihko/core'
import type { Db } from '../db.ts'

/** Highlight markers in snippets: control characters, not HTML. */
export const HIGHLIGHT_START = '\u0002'
export const HIGHLIGHT_END = '\u0003'

/** Results with text; with filters alone, more (a tag or a folder is a list, not a ranking). */
const LIMIT = 50
const FILTER_LIMIT = 500

export function ftsQuery(input: string): string | null {
  const terms = input.normalize('NFC').match(/[\p{L}\p{N}_]+/gu)
  if (!terms) return null
  return terms.map((t, i) => `"${t}"` + (i === terms.length - 1 ? '*' : '')).join(' ')
}

const like = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c)

/**
 * SQL condition on `n.path` for a filter. A tag matches itself and every tag
 * nested under it (`tag:hogar` → `hogar/red`); a path, that folder
 * with its subfolders or that exact note. Both ignore case.
 */
function condition(f: SearchFilter): { sql: string; params: unknown[] } {
  const c = f.kind === 'tag'
    ? { sql: "exists (select 1 from tags t where t.path = n.path and (t.tag = ? or t.tag like ? escape '\\'))", params: [f.value, like(f.value) + '/%'] }
    : { sql: "(n.path like ? escape '\\' or n.path like ? escape '\\')", params: [like(f.value), like(f.value) + '/%'] }
  return f.negate ? { sql: `not ${c.sql}`, params: c.params } : c
}

export interface SearchResult { path: string; title: string; snippet: string }

/**
 * `visible`: the notes the principal may read (Access.notesWhere, on `n`),
 * applied in the query so the limit, the ranking and the snippets only ever
 * see those.
 */
export function search(db: Db, input: string, visible: { sql: string; params: unknown[] } = { sql: '1', params: [] }): SearchResult[] {
  const { text, filters } = parseSearchQuery(input)
  const fts = ftsQuery(text)
  if (!fts && filters.length === 0) return []
  const conds = [...filters.map(condition), visible]
  const where = conds.map((c) => ` and ${c.sql}`).join('')
  const params = conds.flatMap((c) => c.params)
  if (fts) {
    return db.prepare(`select n.path, n.title, snippet(notes_fts, 3, ?, ?, '…', 12) as snippet
        from notes_fts join notes n on n.path = notes_fts.path
        where notes_fts match ?${where}
        order by bm25(notes_fts, 0, 10.0, 8.0, 1.0) limit ${LIMIT}`)
      .all(HIGHLIGHT_START, HIGHLIGHT_END, fts, ...params) as SearchResult[]
  }
  return db.prepare(`select n.path, n.title, '' as snippet from notes n where 1${where} order by n.path limit ${FILTER_LIMIT}`)
    .all(...params) as SearchResult[]
}
