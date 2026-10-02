// Search: the text the user types becomes a safe FTS5 query (their text is
// never passed as FTS5 syntax: operators, quotes or columns would give errors
// or odd results; each word is a term, the last one a prefix), and the
// filters (`tag:`, `path:`, frontmatter fields and `prop:`; @vihko/core/query)
// become conditions on the index.
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
 * with its subfolders or that exact note; a field, a frontmatter key with
 * that value (any item of a list); `exists`, a key with any value or none.
 * All ignore case. A reserved filter that means nothing yet matches no note
 * (so `-is:x` matches every one).
 */
function condition(f: SearchFilter): { sql: string; params: unknown[] } {
  const c = filterSql(f)
  return f.negate ? { sql: `not ${c.sql}`, params: c.params } : c
}

function filterSql(f: SearchFilter): { sql: string; params: unknown[] } {
  switch (f.kind) {
    case 'tag': return { sql: "exists (select 1 from tags t where t.path = n.path and (t.tag = ? or t.tag like ? escape '\\'))", params: [f.value, like(f.value) + '/%'] }
    case 'path': return { sql: "(n.path like ? escape '\\' or n.path like ? escape '\\')", params: [like(f.value), like(f.value) + '/%'] }
    case 'exists': return { sql: 'exists (select 1 from fields f where f.path = n.path and f.key_fold = ?)', params: [f.key] }
    case 'reserved': return { sql: '0', params: [] }
    // The value as text (case folded), or, for a number, the same number however it's written.
    case 'field': return { sql: 'exists (select 1 from fields f where f.path = n.path and f.key_fold = ? and (f.value_fold = ? or f.num = ?))', params: [f.key, f.value, asNumber(f.value)] }
  }
}

/** A value typed as a number (`5`, `-2.5`, `1e3`), or null. */
function asNumber(v: string): number | null {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(v)) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export interface SearchResult { path: string; title: string; snippet: string }

/** Words in a snippet. */
const SNIPPET_TOKENS = 12
/** How far into a note's text a snippet is looked for: past it, the snippet is the best window found before. */
const SNIPPET_SCAN = 1_000_000
/** A token as FTS5's `unicode61` tokenizer splits text: letters, digits and marks. */
const TOKEN = /[\p{L}\p{N}\p{M}\p{Co}]+/gu
/** A token compared as `unicode61 remove_diacritics 2` does: without diacritics, case-insensitively. */
const foldToken = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/**
 * The snippet of a result: the window of `SNIPPET_TOKENS` words of `body`
 * that holds the most of the query's words (each matching word between the
 * highlight markers), with `…` where text is left out on either side. FTS5's
 * `snippet()` gave the same, but scored every window against every match, so a
 * note with thousands of matches (a pasted log, a long list) kept the server's
 * only thread busy for seconds on every search; this is one pass over the text.
 */
export function snippetOf(body: string, text: string): string {
  const words = (text.normalize('NFC').match(/[\p{L}\p{N}_]+/gu) ?? []).flatMap((w) => w.match(TOKEN) ?? []).map(foldToken)
  const prefix = words.length ? words[words.length - 1]! : null
  const exact = new Map<string, number>()
  for (const [i, w] of words.entries()) if (!exact.has(w)) exact.set(w, i)
  const termOf = (token: string): number => {
    const f = foldToken(token)
    const i = exact.get(f)
    if (i !== undefined) return i
    return prefix !== null && f.startsWith(prefix) ? exact.get(prefix)! : -1
  }
  const scanned = body.length > SNIPPET_SCAN ? body.slice(0, SNIPPET_SCAN) : body
  const tokens: { from: number; to: number; term: number }[] = []
  for (const m of scanned.matchAll(TOKEN)) tokens.push({ from: m.index, to: m.index + m[0].length, term: termOf(m[0]) })
  if (tokens.length === 0) return ''
  // Windows that start at a matching word, scored by how many different words of the query they hold, then how many matches.
  const counts = new Map<number, number>()
  let distinct = 0
  let hits = 0
  let end = 0
  let best = { start: 0, score: -1 }
  const wanted = exact.size
  for (let s = 0; s < tokens.length; s++) {
    while (end < tokens.length && end < s + SNIPPET_TOKENS) {
      const t = tokens[end++]!.term
      if (t >= 0) {
        hits++
        const c = counts.get(t) ?? 0
        if (c === 0) distinct++
        counts.set(t, c + 1)
      }
    }
    if (tokens[s]!.term >= 0) {
      const score = distinct * 100_000 + hits
      if (score > best.score) best = { start: s, score }
      if (distinct >= wanted) break
    }
    const t = tokens[s]!.term
    if (t >= 0) {
      hits--
      const c = counts.get(t)! - 1
      if (c === 0) distinct--
      counts.set(t, c)
    }
  }
  const start = Math.max(0, Math.min(best.start, tokens.length - SNIPPET_TOKENS))
  const last = Math.min(tokens.length, start + SNIPPET_TOKENS) - 1
  const parts: string[] = [start > 0 ? '…' : '']
  let at = start > 0 ? tokens[start]!.from : 0
  for (let i = start; i <= last; i++) {
    const t = tokens[i]!
    parts.push(scanned.slice(at, t.from))
    const word = scanned.slice(t.from, t.to)
    parts.push(t.term >= 0 ? HIGHLIGHT_START + word + HIGHLIGHT_END : word)
    at = t.to
  }
  if (last < tokens.length - 1 || scanned.length < body.length) parts.push('…')
  else parts.push(scanned.slice(at))
  return parts.join('')
}

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
    const rows = db.prepare(`select n.path, n.title, notes_fts.body as body
        from notes_fts join notes n on n.path = notes_fts.path
        where notes_fts match ?${where}
        order by bm25(notes_fts, 0, 10.0, 8.0, 1.0) limit ${LIMIT}`)
      .all(fts, ...params) as { path: string; title: string; body: string }[]
    return rows.map((r) => ({ path: r.path, title: r.title, snippet: snippetOf(r.body, text) }))
  }
  return db.prepare(`select n.path, n.title, '' as snippet from notes n where 1${where} order by n.path limit ${FILTER_LIMIT}`)
    .all(...params) as SearchResult[]
}
