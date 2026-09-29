// Edits for the formatting bar's `[[` and `#` (the rest are in format.ts):
// plain text in, one change out, so they can be tested on their own.

export interface Edit {
  from: number
  to: number
  insert: string
  /** Cursor after the edit. */
  cursor: number
}

/** `[[…]]` around the selection; with none, the cursor lands inside to type the name. */
export function wikilink(doc: string, from: number, to: number): Edit {
  const selected = doc.slice(from, to)
  const insert = `[[${selected}]]`
  return { from, to, insert, cursor: selected ? from + insert.length : from + 2 }
}

/** `#` before the selection or at the cursor, separated from a preceding word (a tag starts a word). */
export function tag(doc: string, from: number, to: number): Edit {
  const before = from > 0 ? doc[from - 1]! : ' '
  const insert = `${/\s/.test(before) ? '' : ' '}#${doc.slice(from, to)}`
  return { from, to, insert, cursor: from + insert.length }
}
