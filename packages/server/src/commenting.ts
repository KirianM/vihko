// Commenting without editing (D-038.5): someone with `comment` in a folder adds
// comments (D-023) to its notes, replies, and resolves their own threads;
// with `edit` they resolve anyone's. Their editor is read-only (the hub drops
// whatever it sends), so a comment reaches the note here, as one exact
// operation the server builds itself (never a text the client sends): a
// comment with the person's name and the server's clock, a reply at the end
// of a thread, or a thread taken out. It's written through the note service,
// which puts it on the open document when someone is editing the note (the
// hub, as Yjs operations that merge with their typing) or on the file
// otherwise. Before it's written, what it does is checked against the note:
// the text outside the comments stays as it was, and the comments change by
// exactly that one (`commentOnly`).
import { extract, formatComment, parseComments, parseThreads, readFrontmatter, replyTo, resolveThread, type Change, type Comment } from '@thoth/core'
import type { Splice } from './edits.ts'

/**
 * What to do. `add`: a new thread right after `context`, the text the
 * person saw before the place (the occurrence nearest to `at`, where it was
 * then); `newline` puts it on a line of its own (after a block a comment
 * can't sit in). `reply` and `resolve` name a thread by its id.
 */
export type CommentOp =
  | { op: 'add'; at: number; context: string; newline?: boolean; text: string }
  | { op: 'reply'; thread: string; text: string }
  | { op: 'resolve'; thread: string }

/** Why a comment can't be written: `invalid` (the request), `moved` (the place or the thread isn't in the note any more), `not_own` (someone else's thread). */
export class CommentError extends Error {
  readonly code: 'invalid' | 'moved' | 'not_own'
  constructor(code: CommentError['code'], message: string) {
    super(message)
    this.code = code
  }
}

/** The longest comment accepted, in characters. */
export const MAX_COMMENT = 10_000

/** Parses a request's body into an operation; null if it isn't one. */
export function commentOp(body: unknown): CommentOp | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  const text = typeof b.text === 'string' ? b.text : null
  if (b.op === 'add' && text !== null && typeof b.context === 'string' && Number.isInteger(b.at) && (b.newline === undefined || typeof b.newline === 'boolean')) {
    return { op: 'add', at: b.at as number, context: b.context, text, ...(b.newline ? { newline: true } : {}) }
  }
  if (b.op === 'reply' && text !== null && typeof b.thread === 'string') return { op: 'reply', thread: b.thread, text }
  if (b.op === 'resolve' && typeof b.thread === 'string') return { op: 'resolve', thread: b.thread }
  return null
}

/**
 * The change `op` makes to `doc`, as `author` at `date`, checked: the text
 * outside the comments doesn't change, and the comments change by exactly
 * that one comment (or thread). `resolveAny`: whoever asks may resolve
 * anyone's thread (`edit`); otherwise only one they started.
 */
export function commentSplices(doc: string, op: CommentOp, author: string, date: Date, opts: { resolveAny: boolean }): Splice[] {
  if (op.op !== 'resolve' && (op.text.trim() === '' || op.text.length > MAX_COMMENT)) throw new CommentError('invalid', 'a comment needs some text, and not too much')
  let change: Change
  if (op.op === 'add') {
    const at = placeAfter(doc, op.context, op.at)
    if (at === null) throw new CommentError('moved', 'the commented text is not in the note any more')
    // Right after another thread, it would join it without being a reply: it goes after that thread.
    const inside = parseThreads(doc).find((t) => at > t.from && at < t.to)
    const pos = inside ? inside.to : at
    change = { from: pos, to: pos, insert: (op.newline ? '\n' : '') + formatComment(author, date, op.text) }
  } else {
    const thread = parseThreads(doc).find((t) => t.id === op.thread)
    if (!thread) throw new CommentError('moved', 'the thread is not in the note any more')
    if (op.op === 'reply') change = replyTo(doc, thread, author, date, op.text)
    else {
      if (!opts.resolveAny && thread.comments[0]!.author !== author) throw new CommentError('not_own', 'only whoever started a thread (or someone who can edit the note) resolves it')
      change = resolveThread(doc, thread)
    }
  }
  const after = doc.slice(0, change.from) + change.insert + doc.slice(change.to)
  const expected = op.op === 'resolve'
    ? { added: [], removed: parseThreads(doc).find((t) => t.id === op.thread)!.comments }
    : { added: [parseComments(change.insert.replace(/^\n/, ''))[0]!], removed: [] }
  if (!commentOnly(doc, after, expected)) throw new CommentError('invalid', 'a comment can\'t go there')
  return [{ at: change.from, remove: change.to - change.from, insert: change.insert }]
}

/**
 * Where the text `context` ends in `doc`, at the occurrence nearest to `at`;
 * with no context, the start. Null if it isn't there.
 */
function placeAfter(doc: string, context: string, at: number): number | null {
  if (context === '') return 0
  let best: number | null = null
  for (let i = doc.indexOf(context); i >= 0; i = doc.indexOf(context, i + 1)) {
    const end = i + context.length
    if (best === null || Math.abs(end - at) < Math.abs(best - at)) best = end
  }
  return best
}

const key = (c: Pick<Comment, 'author' | 'date' | 'text' | 'reply'>) => `${c.author}|${c.date}|${c.reply ? '↳' : ''}${c.text}`

/**
 * Whether `after` is `before` with exactly these comments added and removed,
 * and nothing else: the text outside the comments is the same (whitespace
 * aside: a comment may take its line with it, or come on one of its own), no
 * comment lands in the frontmatter, and every comment added is one for
 * Markdown too (not inside code, where it would be text).
 */
export function commentOnly(before: string, after: string, expected: { added: Pick<Comment, 'author' | 'date' | 'text' | 'reply'>[]; removed: Pick<Comment, 'author' | 'date' | 'text' | 'reply'>[] }): boolean {
  const was = parseComments(before)
  const now = parseComments(after)
  if (prose(before, was) !== prose(after, now)) return false
  const count = new Map<string, number>()
  for (const c of was) count.set(key(c), (count.get(key(c)) ?? 0) + 1)
  for (const c of expected.removed) count.set(key(c), (count.get(key(c)) ?? 0) - 1)
  for (const c of expected.added) count.set(key(c), (count.get(key(c)) ?? 0) + 1)
  for (const c of now) count.set(key(c), (count.get(key(c)) ?? 0) - 1)
  if ([...count.values()].some((n) => n !== 0)) return false
  if (expected.added.length === 0) return true
  // Where the new ones are: after the frontmatter, and where Markdown takes a
  // comment for one (not inside code). The place is what's judged: with a
  // plain text in it (a Markdown parser may not take `--` inside one).
  const body = readFrontmatter(after).bodyStart
  const added = new Set(expected.added.map(key))
  return now.filter((c) => added.has(key(c))).every((c) => {
    if (c.from < body) return false
    const probe = after.slice(0, c.from) + PROBE + after.slice(c.to)
    return extract(probe).comments.some((r) => r.from === c.from && r.to === c.from + PROBE.length)
  })
}

const PROBE = '<!-- x -->'

/** The text without its comments, whitespace runs as one space. */
function prose(doc: string, comments: Comment[]): string {
  let out = ''
  let pos = 0
  for (const c of comments) {
    out += doc.slice(pos, c.from) + ' '
    pos = c.to
  }
  return (out + doc.slice(pos)).replace(/\s+/g, ' ').trim()
}
