// Edits for the phone editor bar (link, tag, list): plain text in, one change
// out, so they don't depend on CodeMirror and can be tested on their own.

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

/** Turns the cursor's line into a list item, or back into plain text if it already is one. */
export function listItem(doc: string, pos: number): Edit {
  const start = doc.lastIndexOf('\n', pos - 1) + 1
  if (doc.startsWith('- ', start)) return { from: start, to: start + 2, insert: '', cursor: Math.max(start, pos - 2) }
  return { from: start, to: start, insert: '- ', cursor: pos + 2 }
}
