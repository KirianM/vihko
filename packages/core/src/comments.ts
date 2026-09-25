// Comments inside the note (D-023): HTML comments with author, date and text.
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
// - Date: UTC, ISO 8601 to the minute (`2026-09-24T08:12Z`). Dates with an
//   offset or without a zone (written by hand or by other tools) are still read.
//
// Browser-safe entry point (@thoth/core/comments): the editor and the indexer
// read threads with the same code. No Node modules here.

export interface Comment {
  from: number
  to: number
  author: string
  date: string
  text: string
  reply: boolean
}

export interface Thread {
  /** Stable as long as the first comment doesn't change: author, date, text and occurrence. */
  id: string
  comments: Comment[]
  /** From the first comment to the end of the last. */
  from: number
  to: number
  /** Commented text; empty if the thread is alone on its line. */
  anchorFrom: number
  anchorTo: number
}

const COMMENT = /<!--[ \t]*@([\p{L}\p{N}._-]+)[ \t]+(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?: ?(?:Z|[+-]\d{2}:?\d{2}))?)?)[ \t]*·[ \t]*([\s\S]*?)[ \t]*-->/gu
const REPLY = /^↳[ \t]*/
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/
/** End of sentence: a closing mark followed by whitespace. */
const SENTENCE_END = /[.!?…][)"'»”’]*\s+/g
/** Block markers at the start of a line that aren't part of the commented text. */
const BLOCK_PREFIX = /^[ \t]*(?:>[ \t]?)*(?:#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/

/** Ranges of fenced code blocks: there, a `<!-- -->` is code, not a comment. */
function fencedRanges(doc: string): [number, number][] {
  const out: [number, number][] = []
  let open: { at: number; mark: string } | null = null
  let pos = 0
  for (const line of doc.split('\n')) {
    const m = FENCE.exec(line)
    if (m) {
      if (!open) open = { at: pos, mark: m[1]! }
      else if (m[1]![0] === open.mark[0] && m[1]!.length >= open.mark.length && line.trim() === m[1]) {
        out.push([open.at, pos + line.length])
        open = null
      }
    }
    pos += line.length + 1
  }
  if (open) out.push([open.at, doc.length])
  return out
}

export function parseComments(doc: string): Comment[] {
  const fences = fencedRanges(doc)
  const out: Comment[] = []
  for (const m of doc.matchAll(COMMENT)) {
    const from = m.index
    if (fences.some(([a, b]) => from >= a && from < b)) continue
    const body = m[3]!.trim()
    out.push({
      from,
      to: from + m[0].length,
      author: m[1]!,
      date: m[2]!,
      text: body.replace(REPLY, ''),
      reply: REPLY.test(body),
    })
  }
  return out
}

/** Between two comments of the same thread there's only room for whitespace and, at most, one line break. */
const joins = (between: string) => /^[ \t]*(?:\n[ \t]*)?$/.test(between)

function anchorOf(doc: string, at: number, floor: number): [number, number] {
  const lineStart = doc.lastIndexOf('\n', at - 1) + 1
  let start = Math.max(lineStart, floor)
  // The sentence the text ends in: last sentence end before the end (not counting
  // the mark that the commented text itself ends with).
  const before = doc.slice(start, at)
  const trimmed = before.replace(/[.!?…][)"'»”’]*\s*$/, '')
  let last = -1
  for (const m of trimmed.matchAll(SENTENCE_END)) last = m.index + m[0].length
  if (last > 0) start += last
  else if (start === lineStart) start += BLOCK_PREFIX.exec(before)![0].length
  let end = at
  while (start < end && /\s/.test(doc[start]!)) start++
  while (end > start && /\s/.test(doc[end - 1]!)) end--
  return [start, end]
}

export function parseThreads(doc: string): Thread[] {
  const threads: Thread[] = []
  const seen = new Map<string, number>()
  let prevEnd = 0
  for (const c of parseComments(doc)) {
    const cur = threads[threads.length - 1]
    if (cur && joins(doc.slice(cur.to, c.from))) {
      cur.comments.push(c)
      cur.to = c.to
    } else {
      const [anchorFrom, anchorTo] = anchorOf(doc, c.from, prevEnd)
      const base = `${c.author}|${c.date}|${c.text}`
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      threads.push({ id: `${base}|${n}`, comments: [c], from: c.from, to: c.to, anchorFrom, anchorTo })
    }
    prevEnd = c.to
  }
  return threads
}

/**
 * The commented text as it is compared (D-031.6): Unicode NFC, whitespace
 * runs as one space, trimmed. Reflowing a paragraph or retyping an accent
 * the other way is not a change.
 */
export const normalizeAnchor = (text: string) => text.normalize('NFC').replace(/\s+/g, ' ').trim()

/**
 * Whether the commented text changed since `original`: any difference after
 * normalizing. No similarity threshold on purpose: a small edit ("no" added,
 * a number changed) can turn the sentence around, and the mark only says
 * "look again", never hides anything. A thread that had no text to anchor to
 * (alone on its line) never changes.
 */
export function anchorChanged(original: string, current: string): boolean {
  const was = normalizeAnchor(original)
  return was !== '' && was !== normalizeAnchor(current)
}
