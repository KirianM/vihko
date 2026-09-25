// Safe conversion of what the user types into an FTS5 query: their text is
// never passed as FTS5 syntax (operators, quotes or columns would give
// errors or odd results). Each word is a term; the last one, a prefix.

/** Highlight markers in snippets: control characters, not HTML. */
export const HIGHLIGHT_START = '\u0002'
export const HIGHLIGHT_END = '\u0003'

export function ftsQuery(input: string): string | null {
  const terms = input.normalize('NFC').match(/[\p{L}\p{N}_]+/gu)
  if (!terms) return null
  return terms.map((t, i) => `"${t}"` + (i === terms.length - 1 ? '*' : '')).join(' ')
}
