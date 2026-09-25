// Comments inside the note: HTML comments with author, date and text.
//
//   We'll use Postgres for the index.<!-- @noa 2026-09-24T08:12Z · no, use SQLite -->
//   <!-- @claude 2026-09-24T08:15Z · ↳ agreed, changing it -->
//
// - Thread: consecutive comments (only spaces or a single line break between them).
//   `↳` marks replies.
// - Anchor: the text preceding the thread's first comment on its line, starting
//   from the beginning of the sentence (or of the line, or from the previous
//   comment). This way the anchor is derived from the file, with no start markers
//   or positions stored separately.
// - Date: UTC, ISO 8601 to the minute (`2026-09-24T08:12Z`): people commenting
//   on the same note may live in different timezones. The UI shows it in the
//   reader's local time. Dates with an offset or without a zone (written by hand
//   or by other tools) are still read.
//
// Pure module (no DOM, no CodeMirror): tested by the Node test runner. Whoever
// uses it applies the changes it returns to the session's Y.Text. Reading the
// threads is shared with the indexer (@thoth/core/comments).
import { parseComments, parseThreads, type Thread } from '@thoth/core/comments'

export { parseComments, parseThreads, type Comment, type Thread } from '@thoth/core/comments'

/** Change to the text: delete [from, to) and insert `insert`. */
export interface Change {
  from: number
  to: number
  insert: string
}

const pad = (n: number) => String(n).padStart(2, '0')

/** UTC to the minute, as written into the note: `YYYY-MM-DDTHH:MMZ`. */
export function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`
}

/** Instant of a comment date, or null when it has no timezone (then it can't be converted). */
export function parseDate(date: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?) ?(Z|[+-]\d{2}:?\d{2})$/.exec(date)
  if (!m) return null
  const zone = m[3] === 'Z' ? 'Z' : m[3]!.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')
  const d = new Date(`${m[1]}T${m[2]}${zone}`)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * How a reader sees a comment date: in their local time, only `HH:MM` when it
 * is from today. Dates without a zone are shown as written.
 */
export function displayDate(date: string, now = new Date()): string {
  const d = parseDate(date)
  if (!d) return date
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return day === today ? time : `${day} ${time}`
}

/** One line, with nothing that closes the comment early. */
export function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/--+>/g, (m) => m.slice(0, -1) + ' >')
}

export function formatComment(author: string, date: Date, text: string, reply = false): string {
  return `<!-- @${author} ${formatDate(date)} · ${reply ? '↳ ' : ''}${cleanText(text)} -->`
}

/**
 * Where a new comment on the selection [from, to) gets inserted: right after the end
 * of the selection, without splitting a word. With no selection, at the end of the
 * sentence (or line) where the cursor is. Inside a comment, after its thread.
 */
export function commentPosition(doc: string, from: number, to: number): number {
  let at = to
  if (from === to) {
    const lineEnd = doc.indexOf('\n', at) === -1 ? doc.length : doc.indexOf('\n', at)
    const rest = doc.slice(at, lineEnd)
    const m = /[.!?…][)"'»”’]*(?=\s|$)/.exec(rest)
    at = m ? at + m.index + m[0].length : lineEnd
    // No trailing spaces before the comment.
    while (at > from && /[ \t]/.test(doc[at - 1]!)) at--
  } else {
    while (at > from && /\s/.test(doc[at - 1]!)) at--
    while (at < doc.length && /[\p{L}\p{N}_]/u.test(doc[at]!) && at > 0 && /[\p{L}\p{N}_]/u.test(doc[at - 1]!)) at++
  }
  for (const t of parseThreads(doc)) if (at > t.from && at < t.to) return t.to
  for (const c of parseComments(doc)) if (at > c.from && at < c.to) return c.to
  return at
}

export function addComment(doc: string, at: number, author: string, date: Date, text: string): Change {
  return { from: at, to: at, insert: formatComment(author, date, text) }
}

/**
 * Reply at the end of the thread. On its own line (as in the format above) if the
 * thread closes the line and what follows is a blank line or the end; otherwise,
 * right after the thread, so as not to split the paragraph in two.
 */
export function replyTo(doc: string, thread: Thread, author: string, date: Date, text: string): Change {
  const comment = formatComment(author, date, text, true)
  const lineEnd = doc.indexOf('\n', thread.to) === -1 ? doc.length : doc.indexOf('\n', thread.to)
  const restBlank = doc.slice(thread.to, lineEnd).trim() === ''
  const nextEnd = doc.indexOf('\n', lineEnd + 1) === -1 ? doc.length : doc.indexOf('\n', lineEnd + 1)
  const nextBlank = lineEnd >= doc.length || doc.slice(lineEnd + 1, nextEnd).trim() === ''
  if (restBlank && nextBlank) return { from: lineEnd, to: lineEnd, insert: '\n' + comment }
  return { from: thread.to, to: thread.to, insert: comment }
}

/** Resolving deletes the thread. If it took up the whole line, the line goes too. */
export function resolveThread(doc: string, thread: Thread): Change {
  const lineStart = doc.lastIndexOf('\n', thread.from - 1) + 1
  const lineEnd = doc.indexOf('\n', thread.to) === -1 ? doc.length : doc.indexOf('\n', thread.to)
  if (doc.slice(lineStart, thread.from).trim() === '' && doc.slice(thread.to, lineEnd).trim() === '') {
    if (lineEnd < doc.length) return { from: lineStart, to: lineEnd + 1, insert: '' }
    if (lineStart > 0) return { from: lineStart - 1, to: lineEnd, insert: '' }
    return { from: lineStart, to: lineEnd, insert: '' }
  }
  return { from: thread.from, to: thread.to, insert: '' }
}
