// GFM tables in the editor: outside the cursor, a table drawn from the
// Markdown in place of its lines; with the cursor inside, the source, to edit
// it as text (like the frontmatter). Drawing never touches the file: a table
// is shown as written, never reformatted.
import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { focusChanged, touches } from './livePreview.ts'

// --- Pure helpers: from the syntax tree to a model ------------------------------------

export type Align = 'left' | 'center' | 'right' | null
export type Mark = 'strong' | 'em' | 'strike' | 'code' | 'link' | 'tag'
export interface Segment { text: string; marks: Mark[] }
export interface Cell {
  /** Where the cell's text starts in the source, relative to the table's first line. */
  pos: number
  content: Segment[]
}
export interface TableModel { align: Align[]; head: Cell[]; body: Cell[][] }

type Slice = (from: number, to: number) => string

/** `|:--|:-:|--:|---|` → the alignment of each column. */
export function alignments(row: string): Align[] {
  let cells = row.trim().split('|')
  if (cells[0]!.trim() === '') cells = cells.slice(1)
  if (cells.length && cells[cells.length - 1]!.trim() === '') cells = cells.slice(0, -1)
  return cells.map((c) => {
    const s = c.trim()
    const left = s.startsWith(':')
    const right = s.endsWith(':') && s.length > 1
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null
  })
}

/** `[[target#anchor|alias]]` → what's shown: the alias or the target. */
function wikiLabel(raw: string, embed: boolean) {
  const inner = raw.slice(embed ? 3 : 2, -2)
  const bar = inner.indexOf('|')
  if (bar !== -1) return inner.slice(bar + 1)
  return inner.replace(/^\//, '').replace(/\.md$/i, '')
}

const HIDDEN = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LinkMark', 'Comment'])
const STYLE: Record<string, Mark> = { StrongEmphasis: 'strong', Emphasis: 'em', Strikethrough: 'strike', InlineCode: 'code', Tag: 'tag', URL: 'link', Autolink: 'link' }

/** A cell's inline Markdown as plain text runs with their styles: emphasis, code, links as text. */
export function inline(node: SyntaxNode, slice: Slice): Segment[] {
  const out: Segment[] = []
  const push = (text: string, marks: Mark[]) => {
    if (!text) return
    // The table's `\|` is not a code escape, but it still stands for a pipe (GFM).
    if (marks.includes('code')) text = text.replaceAll('\\|', '|')
    const last = out[out.length - 1]
    if (last && last.marks.join() === marks.join()) last.text += text
    else out.push({ text, marks })
  }
  const walk = (parent: SyntaxNode, from: number, to: number, marks: Mark[]) => {
    let pos = from
    for (let c = parent.firstChild; c; c = c.nextSibling) {
      if (c.to <= from || c.from >= to) continue
      push(slice(pos, c.from), marks)
      pos = c.to
      if (HIDDEN.has(c.name)) continue
      if (c.name === 'Escape') push(slice(c.from + 1, c.to), marks)
      else if (c.name === 'WikiLink' || c.name === 'WikiEmbed') push(wikiLabel(slice(c.from, c.to), c.name === 'WikiEmbed'), [...marks, 'link'])
      else if (c.name === 'Link' || c.name === 'Image') {
        const lm = c.getChildren('LinkMark')
        if (lm.length >= 2) walk(c, lm[0]!.to, lm[1]!.from, [...marks, 'link'])
        else push(slice(c.from, c.to), marks)
      } else walk(c, c.from, c.to, STYLE[c.name] ? [...marks, STYLE[c.name]!] : marks)
    }
    push(slice(pos, to), marks)
  }
  walk(node, node.from, node.to, [])
  return out
}

/** The cells of a row, empty ones included (the parser only has nodes for cells with text). */
function rowCells(row: SyntaxNode, slice: Slice, base: number): Cell[] {
  const kids: SyntaxNode[] = []
  for (let c = row.firstChild; c; c = c.nextSibling) kids.push(c)
  const pipes = kids.filter((k) => k.name === 'TableDelimiter')
  const bounds: [number, number][] = []
  let start = row.from
  for (const p of pipes) {
    bounds.push([start, p.from])
    start = p.to
  }
  bounds.push([start, row.to])
  // A pipe at the start or the end of the row is a border, not an empty cell.
  if (pipes.length && !slice(bounds[0]![0], bounds[0]![1]).trim()) bounds.shift()
  if (pipes.length && bounds.length && !slice(bounds[bounds.length - 1]![0], bounds[bounds.length - 1]![1]).trim()) bounds.pop()
  return bounds.map(([from, to]) => {
    const cell = kids.find((k) => k.name === 'TableCell' && k.from >= from && k.to <= to)
    if (cell) return { pos: cell.from - base, content: inline(cell, slice) }
    return { pos: Math.min(to, from + (slice(from, from + 1) === ' ' ? 1 : 0)) - base, content: [] }
  })
}

/**
 * The model of a `Table` node. Rows have as many cells as the header, as GFM says:
 * missing ones are empty (clicking one goes to the end of its row) and extra ones
 * aren't shown. Positions are relative to `base`, the start of the table's first line.
 */
export function tableModel(table: SyntaxNode, slice: Slice, base: number): TableModel {
  const header = table.getChild('TableHeader')
  const head = header ? rowCells(header, slice, base) : []
  const delim = table.getChildren('TableDelimiter')[0]
  const align = delim ? alignments(slice(delim.from, delim.to)) : []
  const body = table.getChildren('TableRow').map((row) => {
    const cells = rowCells(row, slice, base).slice(0, head.length)
    while (cells.length < head.length) cells.push({ pos: row.to - base, content: [] })
    return cells
  })
  return { align: head.map((_, i) => align[i] ?? null), head, body }
}

// --- The widget --------------------------------------------------------------------

const TAGS: Record<Mark, string> = { strong: 'strong', em: 'em', strike: 's', code: 'code', link: 'span', tag: 'span' }

function renderCell(el: HTMLElement, cell: Cell, align: Align) {
  el.dataset.pos = String(cell.pos)
  if (align) el.style.textAlign = align
  for (const seg of cell.content) {
    let node: Node = document.createTextNode(seg.text)
    for (const m of [...seg.marks].reverse()) {
      const wrap = document.createElement(TAGS[m])
      if (m === 'link') wrap.className = 'cm-link'
      if (m === 'tag') wrap.className = 'cm-tag'
      wrap.append(node)
      node = wrap
    }
    el.append(node)
  }
}

class TableWidget extends WidgetType {
  readonly model: TableModel
  readonly key: string
  constructor(model: TableModel) {
    super()
    this.model = model
    this.key = JSON.stringify(model)
  }
  eq(o: TableWidget) { return o.key === this.key }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div')
    wrap.className = 'cm-table-wrap'
    const table = document.createElement('table')
    table.className = 'cm-table'
    const thead = table.createTHead().insertRow()
    this.model.head.forEach((c, i) => {
      const th = document.createElement('th')
      renderCell(th, c, this.model.align[i] ?? null)
      thead.append(th)
    })
    const tbody = table.createTBody()
    for (const row of this.model.body) {
      const tr = tbody.insertRow()
      row.forEach((c, i) => renderCell(tr.insertCell(), c, this.model.align[i] ?? null))
    }
    wrap.append(table)
    // A click on a cell puts the cursor at that cell's text, which reveals the source
    // (mousedown is held back so the editor doesn't place the cursor itself).
    const cellOf = (e: Event) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-pos]')
      return cell && wrap.contains(cell) ? cell : null
    }
    wrap.addEventListener('mousedown', (e) => { if (e.button === 0 && cellOf(e)) e.preventDefault() })
    wrap.addEventListener('click', (e) => {
      const cell = cellOf(e)
      if (e.button !== 0 || !cell) return
      e.preventDefault()
      const anchor = view.posAtDOM(wrap) + Number(cell.dataset.pos)
      view.dispatch({ selection: { anchor: Math.min(anchor, view.state.doc.length) }, scrollIntoView: true })
      view.focus()
    })
    return wrap
  }
  ignoreEvent() { return true }
}

// --- Decorations (StateField: a table spans several lines) -------------------------

/** Nodes a table can be inside of; nothing else is descended into. */
const CONTAINERS = new Set(['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem'])

function tableDecorations(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  const slice: Slice = (from, to) => state.doc.sliceString(from, to)
  syntaxTree(state).iterate({
    enter: (ref) => {
      if (ref.name !== 'Table') return CONTAINERS.has(ref.name)
      const first = state.doc.lineAt(ref.from)
      const last = state.doc.lineAt(ref.to)
      // Only tables that own their lines (not one starting after a list marker, say).
      if (!/^[\s>]*$/.test(slice(first.from, ref.from))) return false
      if (touches(state, first.from, last.to)) return false
      const widget = new TableWidget(tableModel(ref.node, slice, first.from))
      out.push(Decoration.replace({ widget, block: true }).range(first.from, last.to))
      return false
    },
  })
  return Decoration.set(out)
}

export const tables = StateField.define<DecorationSet>({
  create: tableDecorations,
  update: (v, tr) => (tr.docChanged || tr.selection || focusChanged(tr) || syntaxTree(tr.state) !== syntaxTree(tr.startState) ? tableDecorations(tr.state) : v),
  provide: (f) => EditorView.decorations.from(f),
})
