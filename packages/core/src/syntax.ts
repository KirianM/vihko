// vihko's Markdown syntax on top of lezer: wikilinks, embeds and tags.
// Browser-safe entry point (@vihko/core/syntax): used by both the editor
// and the indexer, so a link or a tag is parsed the same way in both places.
// No Node modules here.
import { GFM, parser as baseParser, type InlineContext, type MarkdownConfig } from '@lezer/markdown'
import { trimTrailingSlashes } from './paths.ts'

const BRACKET_OPEN = 91 // [
const BRACKET_CLOSE = 93 // ]
const BANG = 33 // !
const HASH = 35 // #
const NEWLINE = 10
const SPACE = 32
const BACKSLASH = 92 // \

/** `[[target#anchor|text]]` and `![[…]]`. No line breaks or brackets inside. */
function parseWiki(cx: InlineContext, pos: number, embed: boolean): number {
  const open = embed ? pos + 1 : pos
  if (cx.char(open) !== BRACKET_OPEN || cx.char(open + 1) !== BRACKET_OPEN) return -1
  for (let i = open + 2; i < cx.end - 1; i++) {
    const c = cx.char(i)
    if (c === NEWLINE || c === BRACKET_OPEN) return -1
    if (c === BRACKET_CLOSE) {
      if (cx.char(i + 1) !== BRACKET_CLOSE || i === open + 2) return -1
      return cx.addElement(cx.elt(embed ? 'WikiEmbed' : 'WikiLink', pos, i + 2))
    }
  }
  return -1
}

const TAG_CHAR = /[\p{L}\p{N}_\-/]/u

/** `#tag`: preceded by start-of-line or whitespace; letters, digits, `_`, `-`, `/`; not only digits. */
function parseTag(cx: InlineContext, pos: number): number {
  if (pos > cx.offset && !/\s/.test(cx.slice(pos - 1, pos))) return -1
  let end = pos + 1
  while (end < cx.end) {
    const ch = String.fromCodePoint(cx.slice(end, end + 2).codePointAt(0)!)
    if (!TAG_CHAR.test(ch)) break
    end += ch.length
  }
  const name = trimTrailingSlashes(cx.slice(pos + 1, end))
  if (!name || /^[\d/]+$/.test(name) || name.startsWith('/')) return -1
  return cx.addElement(cx.elt('Tag', pos, pos + 1 + name.length))
}

/**
 * A hard line break (`\` or two or more spaces, then a line break), as
 * lezer's own: in its place, because that one scans the rest of a run of
 * spaces from each of them, and a long run that doesn't end a line took
 * quadratic time (a note with 100 KB of spaces, ten seconds). A run already
 * scanned answers at once for the spaces after its first.
 */
const scanned = new WeakMap<InlineContext, number>()
function parseHardBreak(cx: InlineContext, next: number, pos: number): number {
  if (next === BACKSLASH && cx.char(pos + 1) === NEWLINE) return cx.addElement(cx.elt('HardBreak', pos, pos + 2))
  if (next !== SPACE || pos < (scanned.get(cx) ?? -1)) return -1
  let end = pos + 1
  while (cx.char(end) === SPACE) end++
  if (cx.char(end) === NEWLINE && end >= pos + 2) return cx.addElement(cx.elt('HardBreak', pos, end + 1))
  scanned.set(cx, end)
  return -1
}

/**
 * An ATX heading's text without its closing sequence (`Plan ##` → `Plan`):
 * the `#`s it ends with, after whitespace, with the whitespace around them.
 * A loop, not `/[ \t]+#+[ \t]*$/`, which tries every space of a long run
 * inside the heading, in quadratic time. `space`: what counts as whitespace.
 */
export function withoutClosingHashes(s: string, space: RegExp = /[ \t]/): string {
  const ws = (i: number) => space.test(s[i]!)
  let end = s.length
  while (end > 0 && ws(end - 1)) end--
  let hashes = end
  while (hashes > 0 && s[hashes - 1] === '#') hashes--
  if (hashes === end || hashes === 0 || !ws(hashes - 1)) return s
  let start = hashes - 1
  while (start > 0 && ws(start - 1)) start--
  return s.slice(0, start)
}

export const vihkoSyntax: MarkdownConfig = {
  defineNodes: ['WikiLink', 'WikiEmbed', 'Tag'],
  parseInline: [
    { name: 'WikiEmbed', before: 'Image', parse: (cx, next, pos) => (next === BANG ? parseWiki(cx, pos, true) : -1) },
    { name: 'WikiLink', before: 'Link', parse: (cx, next, pos) => (next === BRACKET_OPEN ? parseWiki(cx, pos, false) : -1) },
    { name: 'Tag', parse: (cx, next, pos) => (next === HASH ? parseTag(cx, pos) : -1) },
    // Replaces lezer's, in its place.
    { name: 'HardBreak', parse: parseHardBreak },
  ],
}

/** vihko's Markdown parser: CommonMark + GFM + wikilinks, embeds and tags. */
export const markdownParser = baseParser.configure([GFM, vihkoSyntax])

/**
 * The longest inline text (a paragraph, a heading, a table cell) parsed in
 * one piece. lezer matches each closing delimiter (`*`, `~~`, `]`) against
 * every opening one before it, so a paragraph of tens of kilobytes of them
 * (`*a*a…`, `[a] [a] …`) took seconds, and each save of the note took them
 * again on the server's only thread. A longer text is parsed in pieces of
 * about this size, cut at a line break where there is one, else at a space,
 * and never inside an HTML comment (where vihko keeps comments between
 * people, which aren't text to index): emphasis or a Markdown link across a cut
 * is lost, which the index (links, tags, headings, comments) barely notices
 * in a paragraph that long. Wikilinks and tags never span a line, and a cut
 * at a line break keeps them whole.
 */
export const INLINE_PIECE = 2048

const wholeInline = markdownParser.parseInline.bind(markdownParser)
markdownParser.parseInline = (text: string, offset: number) => {
  if (text.length <= INLINE_PIECE) return wholeInline(text, offset)
  const out: ReturnType<typeof wholeInline> = []
  for (let start = 0; start < text.length;) {
    const end = inlineCut(text, start)
    out.push(...wholeInline(text.slice(start, end), offset + start))
    start = end
  }
  return out
}

/** Where the piece of `text` that starts at `start` ends (see INLINE_PIECE). */
function inlineCut(text: string, start: number): number {
  const max = start + INLINE_PIECE
  if (max >= text.length) return text.length
  const half = start + INLINE_PIECE / 2
  let cut = lastAfter(text, '\n', half, max)
  if (cut === -1) cut = lastAfter(text, ' ', half, max)
  if (cut === -1) {
    // No space: where a word (what a tag holds) ends and a mark begins (never inside a tag, nor inside a
    // `<!--`, `[[` or `](`); with none, after the run of word characters, or where the piece ends.
    const boundary = (i: number) => TAG_CHAR.test(text[i - 1]!) && !TAG_CHAR.test(text[i]!)
    cut = max
    while (cut > half && !boundary(cut)) cut--
    if (cut === half) for (cut = max; cut < text.length && TAG_CHAR.test(text[cut]!);) cut++
  }
  // Never between the two halves of a surrogate pair.
  if (/[\uDC00-\uDFFF]/.test(text[cut] ?? '')) cut--
  // Never inside a comment: the piece goes on to its end (one that never closes is no comment, and is cut).
  const open = lastStart(text, '<!--', start, cut)
  if (open !== -1 && lastStart(text, '-->', open + 4, cut) === -1) {
    const close = text.indexOf('-->', Math.max(cut - 2, open + 4))
    if (close !== -1) return close + 3
  }
  return cut
}

/** The position right after the last `ch` in `text[from, to)`, or -1 (looking no further back than `from`). */
function lastAfter(text: string, ch: string, from: number, to: number): number {
  for (let i = to - 1; i >= from; i--) if (text[i] === ch) return i + 1
  return -1
}

/** Where the last `s` that lies wholly in `text[from, to)` starts, or -1 (looking no further back than `from`). */
function lastStart(text: string, s: string, from: number, to: number): number {
  for (let i = to - s.length; i >= from; i--) if (text.startsWith(s, i)) return i
  return -1
}
