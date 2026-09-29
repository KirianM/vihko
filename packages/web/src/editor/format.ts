// Formatting from the toolbar and its shortcuts: bold, italic, strikethrough,
// inline code, links, headings, lists, tasks, quotes, code blocks and tables.
// Each is a function from the editor state to one change (a transaction spec),
// or null when there's nothing to do there, so it can be tested without a
// view. Only CommonMark and GFM: what any other tool reads the same way.
//
// Inline marks wrap the selection (or the word under the cursor), and come off
// when it's already inside one. Line formats apply to every line of the
// selection and come off when every line already has them. Nothing is ever
// inserted inside a link's, an image's or a comment's syntax (insertAt.ts).
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorSelection, Facet, type ChangeSet, type EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView, KeyBinding } from '@codemirror/view'
import type { SyntaxNode, Tree } from '@lezer/common'
import { INLINE, outsideInline } from './insertAt.ts'

export type InlineKind = 'strong' | 'em' | 'strike' | 'code'
export type ListKind = 'bullet' | 'ordered' | 'task'

const NODE: Record<InlineKind, string> = { strong: 'StrongEmphasis', em: 'Emphasis', strike: 'Strikethrough', code: 'InlineCode' }
const MARK: Record<InlineKind, string> = { strong: '**', em: '*', strike: '~~', code: '`' }
/** Inline marks a range must not cut in two: the markers would pair up wrong. */
const EMPHASIS = new Set(['StrongEmphasis', 'Emphasis', 'Strikethrough'])
/** Not Markdown text to format: code, the frontmatter, raw HTML. */
const LITERAL = new Set(['FencedCode', 'CodeBlock', 'Frontmatter', 'HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock'])
const WORD = /[\p{L}\p{N}_]+/gu

/** The syntax tree, parsed at least up to `upto` (the whole text by default). */
function tree(state: EditorState, upto = state.doc.length): Tree {
  return ensureSyntaxTree(state, upto, 200) ?? syntaxTree(state)
}

/** The innermost-to-outermost nodes at `pos`, entering those that start there. */
function* ancestors(t: Tree, pos: number, side: -1 | 1 = 1): Generator<SyntaxNode> {
  for (let n: SyntaxNode | null = t.resolveInner(pos, side); n; n = n.parent) yield n
}

/** A node named `name` starting exactly at `pos`. */
function nodeAt(t: Tree, pos: number, name: string): SyntaxNode | null {
  for (const n of ancestors(t, pos)) {
    if (n.from !== pos) return null
    if (n.name === name) return n
  }
  return null
}

/** The code block (or frontmatter, HTML…) at `pos`, at its end included. */
function literalAt(t: Tree, pos: number, names = LITERAL): SyntaxNode | null {
  for (const side of [1, -1] as const) for (const n of ancestors(t, pos, side)) if (names.has(n.name)) return n
  return null
}

/**
 * The node named `name` the selection is inside: an empty cursor strictly
 * inside it (not at its edges: typing there is outside it), a range within it.
 */
function enclosing(t: Tree, from: number, to: number, name: string): SyntaxNode | null {
  for (const n of ancestors(t, from)) {
    if (n.name !== name) continue
    if (from === to ? n.from < from && from < n.to : n.from <= from && to <= n.to) return n
  }
  return null
}

// --- Lines -------------------------------------------------------------------------

interface LineInfo {
  number: number
  from: number
  to: number
  text: string
  /** Nothing after its quote markers. */
  blank: boolean
  /** Inside code, the frontmatter, raw HTML or a table: no line formats there. */
  literal: 'frontmatter' | 'table' | 'other' | null
  /** After its `>` markers, and after the indentation that follows them. */
  quoteEnd: number
  indentEnd: number
  /** Its list marker, with the spaces after it. */
  list: { kind: 'bullet' | 'ordered'; from: number; to: number; num: number } | null
  /** Its task box (`[ ]`), with the spaces after it. */
  task: { from: number; to: number } | null
  /** Its ATX heading marker (`##`), with the spaces after it. */
  heading: { level: number; from: number; to: number } | null
  /** It's the text of a one-line Setext heading: its level and its underline (with the line break before it). */
  setext: { level: number; from: number; to: number } | null
  /** Where its text starts, after every marker. */
  textFrom: number
}

function lineInfo(state: EditorState, t: Tree, number: number): LineInfo {
  const line = state.doc.line(number)
  const text = line.text
  const at = (i: number) => line.from + i
  let i = /^(?:[ \t]{0,3}>[ \t]?)*/.exec(text)![0].length
  const quoteEnd = at(i)
  i += /^[ \t]*/.exec(text.slice(i))![0].length
  const indentEnd = at(i)
  let list: LineInfo['list'] = null
  const lm = /^(?:[-*+]|(\d{1,9})[.)])(?:[ \t]+|$)/.exec(text.slice(i))
  // The syntax tree confirms it (`* * *` is a rule, `2024. was` may be text).
  if (lm && nodeAt(t, at(i), 'ListMark')) {
    list = { kind: lm[1] ? 'ordered' : 'bullet', from: at(i), to: at(i + lm[0].length), num: lm[1] ? Number(lm[1]) : 0 }
    i += lm[0].length
  }
  let task: LineInfo['task'] = null
  const tm = list && /^\[[ xX]\](?:[ \t]+|$)/.exec(text.slice(i))
  if (tm && nodeAt(t, at(i), 'TaskMarker')) {
    task = { from: at(i), to: at(i + tm[0].length) }
    i += tm[0].length
  }
  let heading: LineInfo['heading'] = null
  const hm = /^(#{1,6})(?:[ \t]+|$)/.exec(text.slice(i))
  if (hm && nodeAt(t, at(i), 'HeaderMark')) {
    heading = { level: hm[1]!.length, from: at(i), to: at(i + hm[0].length) }
    i += hm[0].length
  }
  let setext: LineInfo['setext'] = null
  let literal: LineInfo['literal'] = null
  for (const n of ancestors(t, at(i))) {
    const s = /^SetextHeading(\d)$/.exec(n.name)
    if (s && state.doc.lineAt(n.from).number === number) {
      const mark = n.lastChild
      const under = mark && state.doc.lineAt(mark.from)
      if (under && under.number === number + 1) setext = { level: Number(s[1]), from: line.to, to: under.to }
    }
    if (n.name === 'Frontmatter') literal = 'frontmatter'
    else if (!literal && n.name === 'Table') literal = 'table'
    else if (!literal && LITERAL.has(n.name)) literal = 'other'
  }
  return {
    number, from: line.from, to: line.to, text,
    blank: text.slice(quoteEnd - line.from).trim() === '',
    literal, quoteEnd, indentEnd, list, task, heading, setext, textFrom: at(i),
  }
}

/** The lines the selection touches (a range ending at the start of a line leaves that line out). */
function selectedLines(state: EditorState, t: Tree, limit = Infinity): LineInfo[] {
  const { from, to } = state.selection.main
  const first = state.doc.lineAt(from).number
  let last = state.doc.lineAt(to).number
  if (to > from && last > first && state.doc.lineAt(to).from === to) last--
  const out: LineInfo[] = []
  for (let n = first; n <= Math.min(last, first + limit - 1); n++) out.push(lineInfo(state, t, n))
  return out
}

/** The lines a heading or list applies to: not code or tables, and not the blank ones in a range of several. */
function textLines(lines: LineInfo[]): LineInfo[] {
  const text = lines.filter((l) => !l.literal)
  return text.length > 1 ? text.filter((l) => !l.blank) : text
}

const headingLevel = (l: LineInfo) => l.heading?.level ?? l.setext?.level ?? 0
const isQuoted = (l: LineInfo) => l.quoteEnd > l.from
const quotePrefix = (l: LineInfo) => l.text.slice(0, l.quoteEnd - l.from)
const hasList = (l: LineInfo, kind: ListKind) => (kind === 'task' ? l.task !== null : l.list?.kind === kind && l.task === null)

// --- Building the change ---------------------------------------------------------------

interface Finish {
  /** Lines (by a position in them, before the change) whose numbered list is numbered again afterwards. */
  renumber?: number[]
  /** How a selection end maps where text is inserted right at it: after it (1, the default) or before it (-1). */
  assoc?: (pos: number, end: boolean) => -1 | 1
  /** The selection after the change, in the new text, instead of the mapped one. */
  select?: (changes: ChangeSet) => { anchor: number; head?: number }
}

function sorted(specs: { from: number; to?: number; insert?: string }[]) {
  return [...specs].sort((a, b) => a.from - b.from || (a.to ?? a.from) - (b.to ?? b.from))
}

function finish(state: EditorState, specs: { from: number; to?: number; insert?: string }[], opts: Finish = {}): TransactionSpec | null {
  let changes = state.changes(sorted(specs))
  if (opts.renumber?.length) {
    const next = state.update({ changes }).state
    const more = renumber(next, opts.renumber.map((p) => changes.mapPos(p, 1)))
    if (more.length) changes = changes.compose(next.changes(sorted(more)))
  }
  if (changes.empty) return null
  if (opts.select) {
    const s = opts.select(changes)
    return { changes, selection: EditorSelection.single(s.anchor, s.head ?? s.anchor) }
  }
  const { anchor, head } = state.selection.main
  const assoc = opts.assoc ?? (() => 1)
  const lo = Math.min(anchor, head)
  const map = (p: number) => changes.mapPos(p, assoc(p, p !== lo || anchor === head))
  return { changes, selection: EditorSelection.single(map(anchor), map(head)) }
}

/** Numbers each numbered list the positions are in from its first item on (1., 2., 3.… or 4., 5.…). */
function renumber(state: EditorState, positions: number[]): { from: number; to: number; insert: string }[] {
  const t = tree(state)
  const done = new Set<number>()
  const out: { from: number; to: number; insert: string }[] = []
  for (const pos of positions) {
    const info = lineInfo(state, t, state.doc.lineAt(pos).number)
    if (info.list?.kind !== 'ordered') continue
    const list = nodeAt(t, info.list.from, 'ListMark')?.parent?.parent
    if (!list || list.name !== 'OrderedList' || done.has(list.from)) continue
    done.add(list.from)
    let start: number | null = null
    let i = 0
    for (let item = list.firstChild; item; item = item.nextSibling) {
      const mark = item.name === 'ListItem' ? item.getChild('ListMark') : null
      const m = mark && /^(\d+)([.)])$/.exec(state.sliceDoc(mark.from, mark.to))
      if (!mark || !m) continue
      start ??= Number(m[1])
      const want = `${start + i++}${m[2]}`
      if (want !== m[0]) out.push({ from: mark.from, to: mark.to, insert: want })
    }
  }
  return out
}

// --- Inline marks ------------------------------------------------------------------------

/** The text of a Markdown link (between `[` and `]`): formatting inside it keeps the link. */
function linkLabel(n: SyntaxNode): { from: number; to: number } | null {
  const marks = n.getChildren('LinkMark')
  return n.name === 'Link' && marks.length >= 2 ? { from: marks[0]!.to, to: marks[1]!.from } : null
}

/**
 * The range widened so that neither end cuts a link, an image, a wikilink, a
 * tag, a comment, inline code or another mark: `[te|xt](x) more` → the whole
 * link. Within a Markdown link's text it stays: `[**te**xt](x)` is fine.
 */
function widen(t: Tree, from: number, to: number): { from: number; to: number } {
  let a = from
  let b = to
  for (let again = true; again;) {
    again = false
    for (const [pos, side] of [[a, 1], [b, -1]] as const) {
      for (const n of ancestors(t, pos, side)) {
        if (!(n.from < pos && pos < n.to)) continue
        const label = linkLabel(n)
        const cuts = INLINE.has(n.name) ? !(label && label.from <= a && b <= label.to) : EMPHASIS.has(n.name) && !(n.from <= a && b <= n.to)
        if (cuts && (n.from < a || n.to > b)) {
          a = Math.min(a, n.from)
          b = Math.max(b, n.to)
          again = true
        }
      }
    }
  }
  return { from: a, to: b }
}

/** The markers of an inline node: its first and last children, when they are marks. */
function marksOf(n: SyntaxNode): SyntaxNode[] {
  const first = n.firstChild
  const last = n.lastChild
  const isMark = (c: SyntaxNode | null): c is SyntaxNode => c !== null && /Mark$/.test(c.name)
  return [first, last !== first ? last : null].filter(isMark)
}

/** Inline code keeps a space inside its backticks when its text starts or ends with one: it goes with them. */
function unwrapCode(state: EditorState, n: SyntaxNode, marks: SyntaxNode[]) {
  const specs = marks.map((m) => ({ from: m.from, to: m.to }))
  if (marks.length === 2) {
    const inner = state.sliceDoc(marks[0]!.to, marks[1]!.from)
    if (inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim().length > 0 && /^ `|` $/.test(inner)) {
      specs[0]!.to += 1
      specs[1]!.from -= 1
    }
  }
  return specs
}

/** `**|**`: the markers just put in, with nothing typed between them. */
function emptyPair(state: EditorState, pos: number, kind: InlineKind): boolean {
  const m = MARK[kind]
  if (state.sliceDoc(pos - m.length, pos) !== m || state.sliceDoc(pos, pos + m.length) !== m) return false
  // `**|**` is an empty bold, not two empty italics.
  return state.sliceDoc(pos - m.length - 1, pos - m.length) !== m[0] && state.sliceDoc(pos + m.length, pos + m.length + 1) !== m[0]
}

/** The word the cursor is strictly inside, if any. */
function wordAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(pos)
  const off = pos - line.from
  for (const m of line.text.matchAll(WORD)) {
    if (m.index < off && off < m.index + m[0].length) return { from: line.from + m.index, to: line.from + m.index + m[0].length }
  }
  return null
}

/** Bold, italic, strikethrough or inline code: on over the selection (or the word at the cursor), or off if it's in one. */
export function toggleInline(state: EditorState, kind: InlineKind): TransactionSpec | null {
  const { from, to } = state.selection.main
  const t = tree(state)
  if (literalAt(t, from) || literalAt(t, to)) return null
  const inside = enclosing(t, from, to, NODE[kind])
  if (inside) {
    const marks = marksOf(inside)
    return finish(state, kind === 'code' ? unwrapCode(state, inside, marks) : marks.map((m) => ({ from: m.from, to: m.to })))
  }
  const m = MARK[kind]
  let range = { from, to }
  if (from === to) {
    if (emptyPair(state, from, kind)) return finish(state, [{ from: from - m.length, to: from + m.length }])
    const word = wordAt(state, from)
    if (!word) {
      // Nothing to wrap: the markers, with the cursor between them to type.
      const at = outsideInline(state, from)
      return finish(state, [{ from: at, insert: m + m }], { select: () => ({ anchor: at + m.length }) })
    }
    range = word
  }
  const { from: a, to: b } = widen(t, range.from, range.to)
  const specs: { from: number; to?: number; insert?: string }[] = []
  // The same mark inside the range goes: the whole range gets it once.
  t.iterate({
    from: a, to: b,
    enter: (n) => {
      if (n.name !== NODE[kind] || n.from < a || n.to > b) return
      const marks = marksOf(n.node)
      specs.push(...(kind === 'code' ? unwrapCode(state, n.node, marks) : marks.map((x) => ({ from: x.from, to: x.to }))))
      return false
    },
  })
  const removed = (p: number) => specs.some((s) => s.from <= p && p < (s.to ?? s.from))
  // Emphasis can't span a paragraph break or take a list marker in: each line on its own.
  for (let n = state.doc.lineAt(a).number; n <= state.doc.lineAt(b).number; n++) {
    const info = lineInfo(state, t, n)
    if (info.literal && info.literal !== 'table') continue
    let s = Math.max(a, info.textFrom)
    let e = Math.min(b, info.to)
    // Markers must touch the text (`** x**` isn't bold): the spaces stay outside.
    while (s < e && (/\s/.test(state.sliceDoc(s, s + 1)) || removed(s))) s++
    while (e > s && (/\s/.test(state.sliceDoc(e - 1, e)) || removed(e - 1))) e--
    if (s >= e) continue
    let open = m
    let close = m
    if (kind === 'code') {
      const inner = state.sliceDoc(s, e)
      const run = Math.max(0, ...[...inner.matchAll(/`+/g)].map((x) => x[0].length))
      const fence = '`'.repeat(run + 1)
      const pad = inner.startsWith('`') || inner.endsWith('`') ? ' ' : ''
      open = fence + pad
      close = pad + fence
    }
    specs.push({ from: s, insert: open }, { from: e, insert: close })
  }
  if (!specs.some((s) => s.insert)) return null
  // The selection stays on the same text, inside the new markers.
  return finish(state, specs, { assoc: (_p, end) => (end ? -1 : 1) })
}

// --- Links -------------------------------------------------------------------------

const URLISH = /^(?:https?:\/\/|mailto:)\S+$/i

/**
 * A Markdown link `[text](url)`: with a selection (or the word the cursor is
 * in), it's the text and the cursor lands where the URL goes (a selected URL
 * becomes the URL, and the cursor goes to the text); with none, `[]()` with
 * the cursor in the text. In a link already, its URL is selected, to change it.
 */
export function insertLink(state: EditorState): TransactionSpec | null {
  const { from, to } = state.selection.main
  const t = tree(state)
  if (literalAt(t, from) || literalAt(t, to)) return null
  const link = enclosing(t, from, to, 'Link')
  if (link) {
    const url = link.getChild('URL')
    const marks = link.getChildren('LinkMark')
    if (url) return { selection: EditorSelection.single(url.from, url.to) }
    if (marks.length >= 4) return { selection: EditorSelection.single(marks[2]!.to) }
  }
  // The word the cursor is in is the text, as a selection would be (not in a wikilink, a tag…: the link goes after it).
  const word = from === to && outsideInline(state, from) === from ? wordAt(state, from) : null
  if (from === to && !word) {
    const at = outsideInline(state, from)
    return finish(state, [{ from: at, insert: '[]()' }], { select: () => ({ anchor: at + 1 }) })
  }
  let { from: a, to: b } = widen(t, word?.from ?? from, word?.to ?? to)
  while (a < b && /\s/.test(state.sliceDoc(a, a + 1))) a++
  while (b > a && /\s/.test(state.sliceDoc(b - 1, b))) b--
  const text = state.sliceDoc(a, b)
  if (URLISH.test(text)) return finish(state, [{ from: a, to: b, insert: `[](${text})` }], { select: () => ({ anchor: a + 1 }) })
  return finish(state, [{ from: a, insert: '[' }, { from: b, insert: ']()' }], { select: () => ({ anchor: b + 3 }) })
}

// --- Headings, lists and quotes ------------------------------------------------------

/**
 * Heading `level` (1–6) on the selected lines, or normal text (0). A level
 * every line already has comes off. A list item becomes the heading (its
 * marker goes); a Setext heading (`Title` over `===`) loses its underline.
 */
export function toggleHeading(state: EditorState, level: number): TransactionSpec | null {
  const t = tree(state)
  const lines = textLines(selectedLines(state, t))
  if (!lines.length) return null
  const target = level > 0 && lines.every((l) => headingLevel(l) === level) ? 0 : level
  const mark = target > 0 ? `${'#'.repeat(target)} ` : ''
  const specs: { from: number; to?: number; insert?: string }[] = []
  for (const l of lines) {
    if (headingLevel(l) === target && !l.setext) continue
    if (l.heading) specs.push({ from: l.list ? l.quoteEnd : l.heading.from, to: l.heading.to, insert: mark })
    else specs.push({ from: l.list ? l.quoteEnd : l.textFrom, to: l.textFrom, insert: mark })
    if (l.setext) specs.push({ from: l.setext.from, to: l.setext.to })
  }
  return specs.length ? finish(state, specs) : null
}

/** Whether the line is part of a list item or a quote with text: a plain line right after it would join it. */
function continues(t: Tree, l: LineInfo, name: 'ListItem' | 'Blockquote'): boolean {
  if (l.blank) return false
  for (const n of ancestors(t, l.textFrom, -1)) if (n.name === name) return true
  for (const n of ancestors(t, l.textFrom, 1)) if (n.name === name) return true
  return false
}

/**
 * A bulleted, numbered or task list over the selected lines: another kind of
 * list takes this one's marker; if every line already is one, the markers go.
 * Numbered lists are numbered from their first item after the change.
 */
export function toggleList(state: EditorState, kind: ListKind): TransactionSpec | null {
  const t = tree(state)
  const lines = textLines(selectedLines(state, t))
  if (!lines.length) return null
  const specs: { from: number; to?: number; insert?: string }[] = []
  const renumberAt: number[] = []
  if (lines.every((l) => hasList(l, kind))) {
    for (const l of lines) specs.push({ from: l.list!.from, to: (l.task ?? l.list!).to })
    const first = lines[0]!
    const last = lines[lines.length - 1]!
    // Out of the list for real: a plain line right after an item would be part of it.
    if (first.number > 1 && continues(t, lineInfo(state, t, first.number - 1), 'ListItem')) specs.push({ from: first.from, insert: '\n' })
    // A numbered list can only follow a paragraph from 1.
    if (last.number < state.doc.lines) {
      const next = lineInfo(state, t, last.number + 1)
      if (next.list?.kind === 'ordered' && next.list.num !== 1) {
        specs.push({ from: next.list.from, to: next.list.from + String(next.list.num).length, insert: '1' })
        renumberAt.push(next.from)
      }
    }
    return finish(state, specs, { renumber: renumberAt })
  }
  for (const l of lines) {
    renumberAt.push(l.from)
    if (hasList(l, kind)) continue
    const marker = kind === 'bullet' ? '- ' : kind === 'ordered' ? '1. ' : '- [ ] '
    // A heading becomes the list item (its marker goes), as a list item becomes a heading.
    const from = l.list?.from ?? l.indentEnd
    const to = l.heading?.to ?? l.task?.to ?? l.list?.to ?? l.indentEnd
    specs.push({ from, to, insert: marker })
    if (l.setext) specs.push({ from: l.setext.from, to: l.setext.to })
  }
  return finish(state, specs, { renumber: renumberAt })
}

/** A quote over the selected lines (blank ones too, so it stays one quote); if all are quoted, one level goes. */
export function toggleQuote(state: EditorState): TransactionSpec | null {
  const t = tree(state)
  const lines = selectedLines(state, t).filter((l) => l.literal !== 'frontmatter')
  if (!lines.length) return null
  const specs: { from: number; to?: number; insert?: string }[] = []
  if (lines.every(isQuoted)) {
    for (const l of lines) specs.push({ from: l.from, to: l.from + /^[ \t]{0,3}>[ \t]?/.exec(l.text)![0].length })
    const first = lines[0]!
    // A plain line right after a quoted one would be part of the quote.
    if (first.number > 1 && continues(t, lineInfo(state, t, first.number - 1), 'Blockquote')) specs.push({ from: first.from, insert: '\n' })
    return finish(state, specs)
  }
  for (const l of lines) if (!isQuoted(l)) specs.push({ from: l.from, insert: l.blank && lines.length > 1 ? '>' : '> ' })
  return finish(state, specs)
}

// --- Blocks ------------------------------------------------------------------------

/**
 * A fenced code block around the selected lines (or an empty one on a blank
 * line); inside one, its fences go.
 */
export function toggleCodeBlock(state: EditorState): TransactionSpec | null {
  const { from, to } = state.selection.main
  const t = tree(state)
  for (const n of ancestors(t, from)) {
    if (n.name !== 'FencedCode' || !(n.from <= from && to <= n.to)) continue
    const marks = n.getChildren('CodeMark')
    const open = state.doc.lineAt(n.from)
    const close = marks.length > 1 ? state.doc.lineAt(marks[marks.length - 1]!.from) : null
    const specs = [open.number < state.doc.lines ? { from: open.from, to: open.to + 1 } : { from: open.from, to: open.to }]
    if (close && close.number !== open.number) specs.push({ from: close.from - 1, to: close.to })
    return finish(state, specs)
  }
  const lines = selectedLines(state, t)
  if (lines.some((l) => l.literal && l.literal !== 'table')) return null
  const first = lines[0]!
  const last = lines[lines.length - 1]!
  const quote = quotePrefix(first)
  if (lines.length === 1 && first.blank && from === to) {
    const insert = `\`\`\`\n${quote}\n${quote}\`\`\``
    return finish(state, [{ from: first.quoteEnd, to: first.to, insert }], { select: () => ({ anchor: first.quoteEnd + 4 + quote.length }) })
  }
  // Longer than any fence inside, so it can't be closed early.
  const run = Math.max(2, ...lines.map((l) => /^`*/.exec(l.text.slice(l.indentEnd - l.from))![0].length))
  const fence = '`'.repeat(run + 1)
  return finish(state, [{ from: first.from, insert: `${quote}${fence}\n` }, { from: last.to, insert: `\n${quote}${fence}` }], {
    assoc: (p) => (p === last.to ? -1 : 1),
  })
}

/**
 * A small GFM table (two columns, a header and one row), on the cursor's
 * line if it's blank or after it, with a blank line on each side; its first
 * header selected, to type over it.
 */
export function insertTable(state: EditorState, header: (n: number) => string): TransactionSpec | null {
  const t = tree(state)
  let pos = state.selection.main.head
  if (literalAt(t, pos)) return null
  const table = literalAt(t, pos, new Set(['Table']))
  if (table) pos = table.to
  const line = lineInfo(state, t, state.doc.lineAt(pos).number)
  const quote = quotePrefix(line)
  const sep = quote.trimEnd()
  const h1 = header(1)
  const text = [`| ${h1} | ${header(2)} |`, '| --- | --- |', '|  |  |'].map((r) => quote + r).join('\n')
  const blankAt = (n: number) => n < 1 || n > state.doc.lines || lineInfo(state, t, n).blank
  const after = blankAt(line.number + 1) ? '' : `\n${sep}`
  const [from, to, before] = line.blank
    ? [line.from, line.to, blankAt(line.number - 1) ? '' : `${sep}\n`]
    : [line.to, line.to, `\n${sep}\n`]
  const start = from + before.length + quote.length + 2
  return finish(state, [{ from, to, insert: before + text + after }], { select: () => ({ anchor: start, head: start + h1.length }) })
}

// --- What's on where the cursor is -----------------------------------------------------

export interface Active {
  strong: boolean
  em: boolean
  strike: boolean
  code: boolean
  /** The heading level of the selected lines (0: normal text, or not all the same). */
  heading: number
  bullet: boolean
  ordered: boolean
  task: boolean
  quote: boolean
  codeBlock: boolean
}

export const NOTHING_ACTIVE: Active = { strong: false, em: false, strike: false, code: false, heading: 0, bullet: false, ordered: false, task: false, quote: false, codeBlock: false }

/** The formats pressing a button would take off, from the syntax tree where the selection is. */
export function activeFormats(state: EditorState): Active {
  const { from, to } = state.selection.main
  const t = tree(state, Math.min(state.doc.length, to + 1000))
  const inline = (kind: InlineKind) => enclosing(t, from, to, NODE[kind]) !== null || (from === to && emptyPair(state, from, kind))
  // Enough lines to tell; a selection of the whole of a long note isn't read line by line.
  const all = selectedLines(state, t, 500)
  const lines = textLines(all)
  const quoted = all.filter((l) => l.literal !== 'frontmatter')
  let codeBlock = false
  for (const n of ancestors(t, from)) if (n.name === 'FencedCode' && n.from <= from && to <= n.to) codeBlock = true
  const level = lines.length ? headingLevel(lines[0]!) : 0
  return {
    strong: inline('strong'),
    em: inline('em'),
    strike: inline('strike'),
    code: inline('code'),
    heading: lines.every((l) => headingLevel(l) === level) ? level : 0,
    bullet: lines.length > 0 && lines.every((l) => hasList(l, 'bullet')),
    ordered: lines.length > 0 && lines.every((l) => hasList(l, 'ordered')),
    task: lines.length > 0 && lines.every((l) => hasList(l, 'task')),
    quote: quoted.length > 0 && quoted.every(isQuoted),
    codeBlock,
  }
}

// --- Running them in the editor --------------------------------------------------------

/**
 * Closes the current undo step (the editor's Y.UndoManager): given by the
 * editor, so a button press is an undo step of its own, never merged with
 * the typing just before or after it.
 */
export const undoBoundary = Facet.define<() => void, () => void>({ combine: (v) => v[0] ?? (() => {}) })

/** Applies a formatting change as typing would be (collaboration, undo), as one undo step. */
export function runFormat(view: EditorView, spec: TransactionSpec | null): void {
  if (!spec || view.state.readOnly) return
  const boundary = view.state.facet(undoBoundary)
  boundary()
  view.dispatch({ ...spec, scrollIntoView: true, userEvent: spec.changes ? 'input.format' : 'select' })
  boundary()
}

/**
 * Shortcuts, as CodeMirror names them. Mod-k is the palette's (Shell.tsx) and
 * Shift-Mod-k deletes a line (CodeMirror's default keymap), so a link is
 * Mod-Alt-k, next to commenting's Mod-Alt-m (Editor.tsx).
 */
export const SHORTCUTS = { strong: 'Mod-b', em: 'Mod-i', link: 'Mod-Alt-k', comment: 'Mod-Alt-m' } as const

/** Bold, italic and link from the keyboard; they take the key even where they do nothing (the browser's Ctrl+B, Ctrl+I…). */
export const formatKeymap: readonly KeyBinding[] = [
  { key: SHORTCUTS.strong, run: (v) => { runFormat(v, toggleInline(v.state, 'strong')); return true } },
  { key: SHORTCUTS.em, run: (v) => { runFormat(v, toggleInline(v.state, 'em')); return true } },
  { key: SHORTCUTS.link, run: (v) => { runFormat(v, insertLink(v.state)); return true } },
]
