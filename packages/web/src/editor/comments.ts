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
// uses it applies the changes it returns to the session's Y.Text (or, with
// `comment` only, asks the server to: http `POST /api/note/comment`). Reading
// the threads, writing a comment, replying, resolving and reopening are shared
// with the server, the indexer and the history (@vihko/core/comments).
import { formatComment, parseComments, parseThreads, type Change } from '@vihko/core/comments'

export {
  anchorChanged, cleanText, commentKey, formatComment, formatDate, parseComments, parseThreads, removedThread, reopener, replyTo, resolveThread,
  type Change, type Comment, type RemovedThread, type Thread,
} from '@vihko/core/comments'

const pad = (n: number) => String(n).padStart(2, '0')

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

/** How much of the text right before a new comment goes with it, so the server finds the place however the note moved meanwhile. */
export const CONTEXT_CHARS = 80

/** The text right before `at`, for the server to place a comment there (`POST /api/note/comment`). */
export function commentContext(doc: string, at: number): string {
  return doc.slice(Math.max(0, at - CONTEXT_CHARS), at)
}
