// GFM task items (`- [ ]`, `* [x]`, `1. [ ]`…) in the editor: a real checkbox
// in place of the marker, outside the cursor. Toggling changes a single
// character of the file (` ` ↔ `x`), so it merges with whatever others are
// typing at the same time; the rest of the line is never touched.
import { insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, Facet, Prec, type EditorState, type Range, type StateCommand, type Transaction } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { focusChanged, touches } from './livePreview.ts'

// --- Pure helpers ------------------------------------------------------------------

export interface Change { from: number; to: number; insert: string }

/**
 * The one-character change that toggles the task whose marker (`[ ]`, `[x]`, `[X]`)
 * starts at `marker` in `doc`. Null if there is no task marker there.
 */
export function toggleAt(doc: string, marker: number): Change | null {
  const m = /^\[([ xX])\]/.exec(doc.slice(marker, marker + 3))
  if (!m) return null
  return { from: marker + 1, to: marker + 2, insert: m[1] === ' ' ? 'x' : ' ' }
}

/** What goes before the cursor on a line that has just been continued with a list marker. */
export const continuedMarker = (before: string) => /^[\s>]*(?:[-*+]|\d{1,9}[.)])[ \t]+$/.test(before)

// --- Labels ------------------------------------------------------------------------

export const taskLabel = Facet.define<string, string>({ combine: (v) => v[0] ?? 'Toggle task' })

// --- Finding tasks in the syntax tree ------------------------------------------------

/** The task markers (`[ ]` start) of the lines the selection touches. */
function markersInSelection(state: EditorState): number[] {
  const out = new Set<number>()
  const tree = syntaxTree(state)
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number
    const last = state.doc.lineAt(r.to).number
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n)
      tree.iterate({
        from: line.from, to: line.to,
        enter: (node) => {
          if (node.name === 'TaskMarker' && node.from >= line.from && node.from <= line.to) out.add(node.from)
        },
      })
    }
  }
  return [...out]
}

function toggleChanges(state: EditorState, markers: number[]): Change[] {
  const changes: Change[] = []
  for (const m of markers) {
    const c = toggleAt(state.doc.sliceString(m, m + 3), 0)
    if (c) changes.push({ from: m + c.from, to: m + c.to, insert: c.insert })
  }
  return changes
}

/** Toggles the tasks on the lines of the selection (Mod-Enter). Does nothing outside tasks. */
export const toggleTask: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false
  const changes = toggleChanges(state, markersInSelection(state))
  if (!changes.length) return false
  dispatch(state.update({ changes, userEvent: 'input.toggle' }))
  return true
}

/** The task whose `[ ]` is right after (or at) `pos`, on the same line. */
function markerFrom(state: EditorState, pos: number): number | null {
  const line = state.doc.lineAt(pos)
  let found: number | null = null
  syntaxTree(state).iterate({
    from: pos, to: line.to,
    enter: (node) => {
      if (found === null && node.name === 'TaskMarker' && node.from >= pos) found = node.from
    },
  })
  return found
}

/**
 * Enter on a task: the new item is a task too (`- [ ] `). On a task with no text,
 * the marker goes and Enter behaves like on an empty list item. Everything else
 * is lang-markdown's markup continuation.
 */
export const insertNewlineContinueTask: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection
  if (sel.ranges.length !== 1 || !sel.main.empty) return insertNewlineContinueMarkup({ state, dispatch })
  const pos = sel.main.head
  const line = state.doc.lineAt(pos)
  const marker = markersInSelection(state)[0]
  // Only with the cursor in the task's text, after `[ ] `.
  if (marker === undefined || pos < marker + 3) return insertNewlineContinueMarkup({ state, dispatch })
  const markerEnd = state.doc.sliceString(marker + 3, marker + 4) === ' ' ? marker + 4 : marker + 3
  if (!state.doc.sliceString(markerEnd, line.to).trim()) {
    // Empty task: drop `[ ] ` and let the list logic end (or outdent) the item.
    const drop = state.update({ changes: { from: marker, to: markerEnd }, selection: { anchor: marker } })
    const next = run(insertNewlineContinueMarkup, drop.state)
    if (!next) {
      dispatch(state.update({ changes: drop.changes, selection: drop.selection, scrollIntoView: true, userEvent: 'input' }))
      return true
    }
    dispatch(state.update({ changes: drop.changes.compose(next.changes), selection: next.selection, scrollIntoView: true, userEvent: 'input' }))
    return true
  }
  const cont = run(insertNewlineContinueMarkup, state)
  if (!cont) return false
  const head = cont.state.selection.main.head
  const newLine = cont.state.doc.lineAt(head)
  if (!continuedMarker(cont.state.doc.sliceString(newLine.from, head))) {
    dispatch(cont)
    return true
  }
  const box = cont.state.changes({ from: head, insert: '[ ] ' })
  dispatch(state.update({
    changes: cont.changes.compose(box),
    selection: EditorSelection.cursor(head + 4),
    scrollIntoView: true,
    userEvent: 'input',
  }))
  return true
}

/** Runs a command against a state and returns its transaction instead of applying it. */
function run(cmd: StateCommand, state: EditorState): Transaction | null {
  let tr: Transaction | null = null
  const ok = cmd({ state, dispatch: (t) => { tr = t } })
  return ok ? tr : null
}

/** lang-markdown's keymap with task-aware Enter, plus Mod-Enter to toggle. Replaces `markdown()`'s own (addKeymap: false). */
export const taskKeymap = Prec.high(keymap.of([
  { key: 'Enter', run: insertNewlineContinueTask },
  { key: 'Backspace', run: deleteMarkupBackward },
  { key: 'Mod-Enter', run: toggleTask },
]))

// --- The checkbox ------------------------------------------------------------------

class TaskBox extends WidgetType {
  readonly checked: boolean
  readonly label: string
  constructor(checked: boolean, label: string) {
    super()
    this.checked = checked
    this.label = label
  }
  eq(o: TaskBox) { return o.checked === this.checked && o.label === this.label }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span')
    wrap.className = 'cm-task'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.checked
    box.tabIndex = -1
    box.title = this.label
    box.setAttribute('aria-label', this.label)
    if (view.state.readOnly) box.disabled = true
    wrap.append(box)
    // Not on mousedown: the editor would move the cursor there first and reveal
    // the marker. The change is dispatched here and the widget redrawn from the text.
    wrap.addEventListener('mousedown', (e) => e.preventDefault())
    wrap.addEventListener('click', (e) => {
      e.preventDefault()
      if (view.state.readOnly) return
      const marker = markerFrom(view.state, view.posAtDOM(wrap))
      if (marker === null) return
      const changes = toggleChanges(view.state, [marker])
      if (changes.length) view.dispatch({ changes, userEvent: 'input.toggle' })
    })
    return wrap
  }
  ignoreEvent() { return true }
}

const taskLine = Decoration.line({ class: 'cm-task-line' })

function decorations(view: EditorView): DecorationSet {
  const { state } = view
  const label = state.facet(taskLabel)
  const out: Range<Decoration>[] = []
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (ref) => {
        if (ref.name !== 'Task') return
        const marker = ref.node.getChild('TaskMarker')
        if (!marker) return false
        const checked = state.doc.sliceString(marker.from + 1, marker.from + 2) !== ' '
        out.push(taskLine.range(state.doc.lineAt(marker.from).from))
        // In a bullet list the checkbox stands in for the bullet too; numbers stay.
        const mark = ref.node.prevSibling
        const start = mark?.name === 'ListMark' && ref.node.parent?.parent?.name === 'BulletList' ? mark.from : marker.from
        // Only the marker reveals the source: the checkbox stays while typing the task's text.
        if (!touches(state, start, marker.to)) {
          out.push(Decoration.replace({ widget: new TaskBox(checked, label) }).range(start, marker.to))
        }
        if (checked && marker.to < ref.to) out.push(Decoration.mark({ class: 'cm-task-done' }).range(marker.to, ref.to))
        return false
      },
    })
  }
  return Decoration.set(out, true)
}

const taskPreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) { this.decorations = decorations(view) }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.state) !== syntaxTree(u.startState) ||
          u.startState.facet(taskLabel) !== u.state.facet(taskLabel) || u.transactions.some(focusChanged)) {
        this.decorations = decorations(u.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)

export const tasks = [taskPreview, taskKeymap]
