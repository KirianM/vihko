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
// - Resolving deletes the thread. With history (D-032.5), the threads that
//   left a note are found by comparing its versions, and reopening puts one
//   back as it was, right after the text it commented.
//
// Browser-safe entry point (@vihko/core/comments): the editor, the indexer and
// the history read threads with the same code. No Node modules here.

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

// --- Writing -----------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0')

/** UTC to the minute, as written into the note: `YYYY-MM-DDTHH:MMZ`. */
export function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`
}

/** One line, with nothing that closes the comment early. */
export function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/--+>/g, (m) => m.slice(0, -1) + ' >')
}

export function formatComment(author: string, date: Date, text: string, reply = false): string {
  return `<!-- @${author} ${formatDate(date)} · ${reply ? '↳ ' : ''}${cleanText(text)} -->`
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

// --- Resolving and reopening ---------------------------------------------------

/** Change to the text: delete [from, to) and insert `insert`. */
export interface Change {
  from: number
  to: number
  insert: string
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

/**
 * A comment's identity (D-032.5): author, date and text. A thread is known by
 * its first comment's, whatever replies come and go.
 */
export const commentKey = (c: Pick<Comment, 'author' | 'date' | 'text'>) => `${c.author}|${c.date}|${c.text}`

/** A thread that left the note, and what it takes to put it back as it was. */
export interface RemovedThread {
  /** Its first comment's key. */
  id: string
  comments: Pick<Comment, 'author' | 'date' | 'text' | 'reply'>[]
  /** The commented text; empty if the thread had none on its line. */
  anchor: string
  /**
   * Where it was: what resolving it removed (the thread, and its line when it
   * had one to itself); the text right before that, from the commented text
   * or else from the nearest line above with something on it; and the offset.
   */
  place: { removed: string; context: string; at: number }
}

/** Longest context kept for a thread without commented text (the line above it can be a whole paragraph). */
const MAX_CONTEXT = 240
const WORD_CHAR = /[\p{L}\p{N}_]/u

/** Thread `t` of `doc`, as resolving it takes it out. */
export function removedThread(doc: string, t: Thread): RemovedThread {
  const cut = resolveThread(doc, t)
  let start = t.anchorFrom
  if (t.anchorTo === t.anchorFrom) {
    // From the nearest line above with something on it, blank lines in between included.
    start = 0
    for (let line = doc.lastIndexOf('\n', t.from - 1) + 1; line > 0;) {
      const above = doc.lastIndexOf('\n', line - 2) + 1
      if (doc.slice(above, line - 1).trim() !== '') { start = above; break }
      line = above
    }
    if (cut.from - start > MAX_CONTEXT) {
      const ws = /\s/.exec(doc.slice(cut.from - MAX_CONTEXT, cut.from))
      start = ws ? cut.from - MAX_CONTEXT + ws.index + 1 : cut.from
    }
  }
  return {
    id: commentKey(t.comments[0]!),
    comments: t.comments.map(({ author, date, text, reply }) => ({ author, date, text, reply })),
    anchor: doc.slice(t.anchorFrom, t.anchorTo),
    place: { removed: doc.slice(cut.from, cut.to), context: doc.slice(Math.min(start, cut.from), cut.from), at: cut.from },
  }
}

/**
 * The threads of `before` that `after` no longer has: their first comment is
 * nowhere in it, not even inside another thread (two threads that merge
 * because the text between them went away were not resolved).
 */
export function goneThreads(before: string, after: string): RemovedThread[] {
  const still = new Map<string, number>()
  for (const c of parseComments(after)) still.set(commentKey(c), (still.get(commentKey(c)) ?? 0) + 1)
  const out: RemovedThread[] = []
  for (const t of parseThreads(before)) {
    const key = commentKey(t.comments[0]!)
    const n = still.get(key) ?? 0
    if (n > 0) still.set(key, n - 1)
    else out.push(removedThread(before, t))
  }
  return out
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A context as a pattern: runs of whitespace inside it may differ (a reflowed paragraph); the ones it ends with may not. */
function contextPattern(context: string): RegExp {
  const tail = /\s*$/.exec(context)!.index
  const body = context.slice(0, tail).split(/(\s+)/).map((p, i) => (i % 2 ? '\\s+' : escapeRegExp(p))).join('')
  return new RegExp(body + escapeRegExp(context.slice(tail)), 'g')
}

/**
 * Where removed threads can go back into `doc`: right after their context,
 * at the occurrence nearest to where they were. Null when that text isn't in
 * `doc` any more, or only where a comment can't go (inside another comment or
 * a code block) or would merge with another thread. `doc` is parsed once, for
 * any number of threads.
 */
export function reopener(doc: string): (r: RemovedThread) => Change | null {
  const comments = parseComments(doc)
  const fences = fencedRanges(doc)
  const blocked = (pos: number) => comments.some((c) => pos > c.from && pos < c.to) || fences.some(([a, b]) => pos > a && pos < b)
  const merges = (pos: number, removed: string) => {
    const first = removed.indexOf('<!--')
    const last = removed.lastIndexOf('-->') + 3
    const before = comments.findLast((c) => c.to <= pos)
    const after = comments.find((c) => c.from >= pos)
    return (before !== undefined && joins(doc.slice(before.to, pos) + removed.slice(0, first)))
      || (after !== undefined && joins(removed.slice(last) + doc.slice(pos, after.from)))
  }
  return (r) => {
    const { context, removed, at } = r.place
    const found: number[] = []
    if (context === '') found.push(0)
    else {
      const startsWord = WORD_CHAR.test(context[0]!)
      const endsWord = WORD_CHAR.test(context.at(-1)!)
      for (const m of doc.matchAll(contextPattern(context))) {
        const end = m.index + m[0].length
        // Whole words: the context doesn't start or end in the middle of one.
        if (startsWord && m.index > 0 && WORD_CHAR.test(doc[m.index - 1]!)) continue
        if (endsWord && end < doc.length && WORD_CHAR.test(doc[end]!)) continue
        found.push(end)
      }
    }
    let best: number | null = null
    for (const pos of found) {
      if (blocked(pos) || merges(pos, removed)) continue
      if (best === null || Math.abs(pos - at) < Math.abs(best - at)) best = pos
    }
    return best === null ? null : { from: best, to: best, insert: removed }
  }
}
