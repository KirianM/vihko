// Comments in the editor: the commented text is highlighted with the color of
// whoever opened the thread, and the `<!-- … -->` syntax is hidden except where
// the cursor is, like the rest of the marks (livePreview.ts). While the side
// panel is closed, a notice below each paragraph with comments opens it and,
// beside it on a wide screen, so does a click on the commented text.
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, Facet, StateEffect, StateField, Transaction, type Range, type TransactionSpec } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { parseThreads, type Thread } from './comments.ts'
import { focusChanged, touches } from './livePreview.ts'

/** The note's threads, always in sync with the text. */
export const threadsField = StateField.define<Thread[]>({
  create: (s) => parseThreads(s.doc.toString()),
  update: (v, tr) => (tr.docChanged ? parseThreads(tr.state.doc.toString()) : v),
})

export interface CommentStyle {
  /** Hex color for each author in the current theme. */
  color: (author: string) => string
  /** Thread selected in the panel. */
  active: string | null
}
export const setCommentStyle = StateEffect.define<CommentStyle>()
const style = StateField.define<CommentStyle>({
  create: () => ({ color: () => 'currentColor', active: null }),
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(setCommentStyle) ? e.value : acc), v),
})

export interface CommentUi {
  /** "2 comments in this paragraph": comments are threads (a comment with its replies), as the panel counts them. */
  count: (n: number) => string
  show: string
  /** "1 comment · click to see it": the commented text's title when a click opens its thread. */
  hint: string
  open: (threadId: string) => void
}
export const commentUi = Facet.define<CommentUi, CommentUi>({
  combine: (v) => v[0] ?? { count: (n) => String(n), show: '›', hint: '', open: () => {} },
})

/**
 * How the comments are reached from the text, as the side panel is:
 * `notices` below their paragraphs while it's closed; `click` on the commented
 * text too while it's closed beside the editor (on a narrow screen it would
 * cover the editor at every tap into that text: the notice is the way there).
 */
export interface CommentReach { notices: boolean; click: boolean }
export const setCommentReach = StateEffect.define<CommentReach>()
const reach = StateField.define<CommentReach>({
  create: () => ({ notices: false, click: false }),
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(setCommentReach) ? e.value : acc), v),
})

class ParagraphNotice extends WidgetType {
  readonly n: number
  readonly thread: string
  constructor(n: number, thread: string) {
    super()
    this.n = n
    this.thread = thread
  }
  eq(o: ParagraphNotice) { return o.n === this.n && o.thread === this.thread }
  toDOM(view: EditorView) {
    const ui = view.state.facet(commentUi)
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'cm-comment-notice'
    const label = document.createElement('span')
    label.textContent = ui.count(this.n)
    const show = document.createElement('b')
    show.textContent = ui.show
    b.append(label, show)
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', () => view.state.facet(commentUi).open(this.thread))
    return b
  }
  ignoreEvent() { return true }
}

/** Thread with no text to anchor to: shows an icon in its place. */
class LooseMark extends WidgetType {
  readonly color: string
  constructor(color: string) {
    super()
    this.color = color
  }
  eq(o: LooseMark) { return o.color === this.color }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-comment-loose'
    s.style.color = this.color
    s.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
    return s
  }
}

/** Top-level block (paragraph, list, quote…) that contains the position. */
function topBlock(state: EditorState, pos: number) {
  let node = syntaxTree(state).resolveInner(pos, -1)
  while (node.parent && node.parent.name !== 'Document') node = node.parent
  return node.parent ? node : null
}

function decorations(state: EditorState): DecorationSet {
  const threads = state.field(threadsField)
  if (threads.length === 0) return Decoration.none
  const { color, active } = state.field(style)
  const { notices, click } = state.field(reach)
  const ui = state.facet(commentUi)
  const out: Range<Decoration>[] = []
  const perBlock = new Map<number, { n: number; thread: string }>()
  for (const t of threads) {
    const c = color(t.comments[0]!.author)
    const anchored = t.anchorTo > t.anchorFrom
    if (anchored) {
      out.push(Decoration.mark({
        class: `cm-commented${t.id === active ? ' cm-commented-active' : ''}${click ? ' cm-commented-open' : ''}`,
        attributes: { style: `--comment-color: ${c}`, ...(click ? { title: ui.hint } : {}) },
      }).range(t.anchorFrom, t.anchorTo))
    }
    if (touches(state, t.from, t.to)) out.push(Decoration.mark({ class: 'cm-comment-raw' }).range(t.from, t.to))
    else out.push(Decoration.replace(anchored ? {} : { widget: new LooseMark(c) }).range(t.from, t.to))

    const block = topBlock(state, t.anchorTo > t.anchorFrom ? t.anchorTo : t.from)
    // After the block and after the thread (its replies may be on their own hidden lines).
    const end = state.doc.lineAt(Math.max(block ? Math.min(block.to, state.doc.length) : 0, t.to)).to
    const cur = perBlock.get(end)
    // One per thread, its replies included: the same count as the panel's «Comments · n».
    perBlock.set(end, { n: (cur?.n ?? 0) + 1, thread: cur?.thread ?? t.id })
  }
  if (notices) {
    for (const [end, { n, thread }] of perBlock) {
      out.push(Decoration.widget({ widget: new ParagraphNotice(n, thread), block: true, side: 1 }).range(end))
    }
  }
  return Decoration.set(out, true)
}

const commentDecorations = StateField.define<DecorationSet>({
  create: decorations,
  update: (v, tr) =>
    tr.docChanged || tr.selection || focusChanged(tr) || tr.effects.some((e) => e.is(setCommentStyle) || e.is(setCommentReach)) ||
    syntaxTree(tr.state) !== syntaxTree(tr.startState)
      ? decorations(tr.state)
      : v,
  provide: (f) => EditorView.decorations.from(f),
})

/**
 * A click on commented text, while `reach.click`, opens its thread in the
 * panel (the first one there, with several: the panel lists them all). The
 * click still places the cursor, and the editor keeps the focus: it's still
 * a click to edit. Not after a drag that selected text.
 */
const openOnClick = EditorView.domEventHandlers({
  click(e, view) {
    if (e.button !== 0 || !view.state.field(reach).click || !view.state.selection.main.empty) return false
    const el = (e.target as Element | null)?.closest?.('.cm-commented')
    if (!el || !view.contentDOM.contains(el)) return false
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.posAtDOM(el)
    const thread = view.state.field(threadsField).find((t) => t.anchorTo > t.anchorFrom && pos >= t.anchorFrom && pos <= t.anchorTo)
    if (thread) view.state.facet(commentUi).open(thread.id)
    return false
  },
})

/**
 * The cursor never lands inside a comment's `<!-- … -->` by moving it with
 * the keyboard: what's typed there would be hidden in the comment once the
 * cursor leaves (a long line with a comment wraps when its syntax shows, and
 * «End» went to the end of the visual line, inside the comment). A cursor
 * the keyboard would leave inside one goes to its end when moving forward,
 * to its start when moving back. A click inside a comment that shows is
 * left where it is: that is someone choosing to edit it.
 */
export function outOfComments(tr: Transaction): TransactionSpec | null {
  if (!tr.selection || tr.docChanged || !tr.isUserEvent('select') || tr.isUserEvent('select.pointer')) return null
  const threads = tr.startState.field(threadsField, false)
  if (!threads?.length) return null
  const before = tr.startState.selection.main.head
  let moved = false
  const ranges = tr.selection.ranges.map((r) => {
    const t = threads.find((x) => r.head > x.from && r.head < x.to)
    if (!t) return r
    moved = true
    const to = r.head >= before ? t.to : t.from
    return r.empty ? EditorSelection.cursor(to) : EditorSelection.range(r.anchor, to)
  })
  return moved ? { selection: EditorSelection.create(ranges, tr.selection.mainIndex), scrollIntoView: tr.scrollIntoView, userEvent: tr.annotation(Transaction.userEvent) } : null
}

const keepOutOfComments = EditorState.transactionFilter.of((tr) => outOfComments(tr) ?? tr)

export const commentMarks = [threadsField, style, reach, commentDecorations, openOnClick, keepOutOfComments]
