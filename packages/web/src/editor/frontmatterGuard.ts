// The frontmatter is protected from what is done in the body (D-056.34):
// select all, deleting, pasting, dropping or typing over a selection never
// reach it, so its `uid`, aliases, tags and, above all, an `ai: false` are
// never lost by accident, without anyone noticing. It is edited by opening
// its folded block (livePreview.ts) and working inside it.
//
// - A transaction filter clips what a person does (typing, deleting,
//   pasting, dropping, completing, formatting) to the body: a change that
//   starts in the frontmatter starts at the body instead, and one wholly in
//   it is dropped (what it inserts goes to the start of the body). Only when
//   every selection range lies inside the block (opened by its chip, or the
//   cursor moved into it) does it pass as it is.
// - Select all (Mod-a) selects the body; inside the open block, the YAML
//   between its delimiters.
// - Nothing else is filtered: what other people type and agents write
//   arrives through the shared document (y-codemirror), and the undo of the
//   shared document only takes back what this person did. External writes,
//   the API and MCP have their own `set_frontmatter`.
import { EditorSelection, EditorState, Transaction, type ChangeSpec, type Extension, type Text } from '@codemirror/state'
import { keymap } from '@codemirror/view'

const BOM = '﻿'
const CLOSING = /^(?:---|\.\.\.)[ \t]*$/
/** A frontmatter longer than this many lines isn't looked for (it isn't one a person writes). */
const MAX_LINES = 2000

/** The frontmatter at the start of a document, as core's locateFrontmatter finds it. */
export interface FrontmatterRange {
  /** Where its YAML starts (after the opening line) and ends (the start of the closing line). */
  yamlFrom: number
  yamlTo: number
  /** The end of the closing line. */
  close: number
  /** Where the body starts: after the closing line's line break (the end of the document without one). */
  end: number
}

/** The document's frontmatter, or null: an opening `---` line and a closing `---` or `...` line. */
export function frontmatterRange(doc: Text): FrontmatterRange | null {
  if (doc.lines < 2) return null
  const first = doc.line(1)
  const opening = first.text.startsWith(BOM) ? first.text.slice(1) : first.text
  if (opening.replace(/\r$/, '') !== '---') return null
  for (let n = 2; n <= Math.min(doc.lines, MAX_LINES); n++) {
    const line = doc.line(n)
    if (CLOSING.test(line.text.replace(/\r$/, ''))) {
      return { yamlFrom: first.to + 1, yamlTo: line.from, close: line.to, end: Math.min(line.to + 1, doc.length) }
    }
  }
  return null
}

/** Whether every selection range lies inside the frontmatter block (its delimiters included): the block is being edited. */
export function insideFrontmatter(state: EditorState, fm: FrontmatterRange): boolean {
  return state.selection.ranges.every((r) => r.to <= fm.close)
}

/** What a person does to the text, as CodeMirror and vihko's commands mark it. */
const PERSON = ['input', 'delete', 'move']

/**
 * The changes of `tr` clipped to the body (see the header), or null when
 * nothing has to change.
 */
export function clipToBody(tr: Transaction): ChangeSpec[] | null {
  const fm = frontmatterRange(tr.startState.doc)
  if (!fm) return null
  if (insideFrontmatter(tr.startState, fm)) return null
  let touches = false
  tr.changes.iterChangedRanges((fromA) => { if (fromA < fm.end) touches = true })
  if (!touches) return null
  const out: ChangeSpec[] = []
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (fromA >= fm.end) { out.push({ from: fromA, to: toA, insert: inserted }); return }
    // From the frontmatter: only the part in the body is changed, and what it inserts goes there.
    const to = Math.max(toA, fm.end)
    if (to > fm.end || inserted.length > 0) out.push({ from: fm.end, to, insert: inserted })
  })
  return out
}

/** The filter: a person's change that reaches the frontmatter from the body is clipped to the body. */
const guard = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !PERSON.some((e) => tr.isUserEvent(e))) return tr
  const clipped = clipToBody(tr)
  if (clipped === null) return tr
  const fm = frontmatterRange(tr.startState.doc)!
  const changes = tr.startState.changes(clipped)
  // Where the selection ends: after what was inserted, never inside the frontmatter.
  const head = Math.min(Math.max(changes.mapPos(tr.startState.selection.main.head, 1), fm.end), changes.newLength)
  return {
    changes,
    selection: EditorSelection.cursor(head),
    scrollIntoView: tr.scrollIntoView,
    userEvent: tr.annotation(Transaction.userEvent),
  }
})

/** Select all: the body, or, inside the open block, the YAML between its delimiters. */
export function selectBody(state: EditorState): { anchor: number; head: number } | null {
  const fm = frontmatterRange(state.doc)
  if (!fm) return null
  if (insideFrontmatter(state, fm)) return { anchor: fm.yamlFrom, head: fm.yamlTo === fm.yamlFrom ? fm.yamlTo : fm.yamlTo - 1 }
  return { anchor: fm.end, head: state.doc.length }
}

const selectAll = keymap.of([{
  key: 'Mod-a',
  run: (view) => {
    const range = selectBody(view.state)
    if (!range) return false
    view.dispatch({ selection: EditorSelection.single(range.anchor, range.head), userEvent: 'select' })
    return true
  },
}])

/** The frontmatter guard: the filter and select all. Before the default keymap, which selects the whole document. */
export const frontmatterGuard: Extension = [guard, selectAll]
