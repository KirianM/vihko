// Comentarios en el editor (D-023): el texto comentado se resalta con el color de
// quien abrió el hilo y la sintaxis `<!-- … -->` se oculta salvo donde está el
// cursor, como el resto de marcas (livePreview.ts). En pantallas estrechas, bajo
// cada párrafo con comentarios, un aviso que abre el panel.
import { syntaxTree } from '@codemirror/language'
import { Facet, StateEffect, StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { parseThreads, type Thread } from './comments.ts'
import { focusChanged, touches } from './livePreview.ts'

/** Hilos de la nota, siempre al día con el texto. */
export const threadsField = StateField.define<Thread[]>({
  create: (s) => parseThreads(s.doc.toString()),
  update: (v, tr) => (tr.docChanged ? parseThreads(tr.state.doc.toString()) : v),
})

export interface CommentStyle {
  /** Color (hex) de cada autor en el tema actual. */
  color: (author: string) => string
  /** Hilo seleccionado en el panel. */
  active: string | null
}
export const setCommentStyle = StateEffect.define<CommentStyle>()
const style = StateField.define<CommentStyle>({
  create: () => ({ color: () => 'currentColor', active: null }),
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(setCommentStyle) ? e.value : acc), v),
})

export interface CommentUi {
  /** «2 comentarios en este párrafo». */
  count: (n: number) => string
  show: string
  open: (threadId: string) => void
}
export const commentUi = Facet.define<CommentUi, CommentUi>({
  combine: (v) => v[0] ?? { count: (n) => String(n), show: '›', open: () => {} },
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

/** Hilo sin texto al que anclarse: se ve un icono en su sitio. */
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

/** Bloque de primer nivel (párrafo, lista, cita…) que contiene la posición. */
function topBlock(state: EditorState, pos: number) {
  let node = syntaxTree(state).resolveInner(pos, -1)
  while (node.parent && node.parent.name !== 'Document') node = node.parent
  return node.parent ? node : null
}

function decorations(state: EditorState): DecorationSet {
  const threads = state.field(threadsField)
  if (threads.length === 0) return Decoration.none
  const { color, active } = state.field(style)
  const out: Range<Decoration>[] = []
  const perBlock = new Map<number, { n: number; thread: string }>()
  for (const t of threads) {
    const c = color(t.comments[0]!.author)
    const anchored = t.anchorTo > t.anchorFrom
    if (anchored) {
      out.push(Decoration.mark({
        class: t.id === active ? 'cm-commented cm-commented-active' : 'cm-commented',
        attributes: { style: `--comment-color: ${c}` },
      }).range(t.anchorFrom, t.anchorTo))
    }
    if (touches(state, t.from, t.to)) out.push(Decoration.mark({ class: 'cm-comment-raw' }).range(t.from, t.to))
    else out.push(Decoration.replace(anchored ? {} : { widget: new LooseMark(c) }).range(t.from, t.to))

    const block = topBlock(state, t.anchorTo > t.anchorFrom ? t.anchorTo : t.from)
    // Tras el bloque y tras el hilo (sus respuestas pueden ir en líneas propias, ocultas).
    const end = state.doc.lineAt(Math.max(block ? Math.min(block.to, state.doc.length) : 0, t.to)).to
    const cur = perBlock.get(end)
    perBlock.set(end, { n: (cur?.n ?? 0) + t.comments.length, thread: cur?.thread ?? t.id })
  }
  for (const [end, { n, thread }] of perBlock) {
    out.push(Decoration.widget({ widget: new ParagraphNotice(n, thread), block: true, side: 1 }).range(end))
  }
  return Decoration.set(out, true)
}

const commentDecorations = StateField.define<DecorationSet>({
  create: decorations,
  update: (v, tr) =>
    tr.docChanged || tr.selection || focusChanged(tr) || tr.effects.some((e) => e.is(setCommentStyle)) ||
    syntaxTree(tr.state) !== syntaxTree(tr.startState)
      ? decorations(tr.state)
      : v,
  provide: (f) => EditorView.decorations.from(f),
})

export const commentMarks = [threadsField, style, commentDecorations]
