// Live preview: the file's text never changes; it's only decorated.
// Markdown marks (#, **, [[…]], frontmatter) are hidden except where the cursor
// is, which reveals them for editing.
import { syntaxTree } from '@codemirror/language'
import { EditorState, Facet, StateEffect, StateField, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { isImageRef } from '@thoth/core/images'
import { markdownLinkNote, missingBadge, onCreateButton, wikiLinkNote } from './createLink.ts'

// --- Link state (resolved by the server's index) ----------

export interface LinkInfo {
  status: 'resolved' | 'ambiguous' | 'missing'
  path: string | null
  candidates: string[] | null
}
export interface LinkLabels { ambiguous: (n: number) => string; missing: string; frontmatter: (n: number) => string }

/** Outgoing links of the note, by their exact text (`[[target|alias]]`). */
export const setLinks = StateEffect.define<Map<string, LinkInfo>>()
const links = StateField.define<Map<string, LinkInfo>>({
  create: () => new Map(),
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(setLinks) ? e.value : acc), v),
})

/** Path of the note being edited: where a note created from a broken link goes. */
export const notePath = Facet.define<string, string>({ combine: (v) => v[0] ?? '' })

/** What to do when a resolved link is clicked. */
export const navigate = Facet.define<(path: string) => void, (path: string) => void>({
  combine: (fns) => fns[0] ?? (() => {}),
})
export const labels = Facet.define<LinkLabels, LinkLabels>({
  combine: (v) => v[0] ?? { ambiguous: (n) => `ambiguous · ${n}`, missing: 'missing', frontmatter: (n) => `frontmatter · ${n}` },
})

// --- Utilities -------------------------------------------------------------------

// Whether the editor has focus. With no focus there's no cursor to edit: everything
// looks clean (also when opening the note, with the cursor at position 0, inside
// the frontmatter).
const focusEffect = StateEffect.define<boolean>()
const focused = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(focusEffect) ? e.value : acc), v),
})
const trackFocus = EditorView.focusChangeEffect.of((_state, focusing) => focusEffect.of(focusing))
export const focusChanged = (tr: { effects: readonly StateEffect<unknown>[] }) => tr.effects.some((e) => e.is(focusEffect))

/** The cursor (or a selection) touches the range and the editor has focus: the marks show there. */
export function touches(state: EditorState, from: number, to: number) {
  return state.field(focused) && state.selection.ranges.some((r) => r.from <= to && r.to >= from)
}
function touchesLines(state: EditorState, from: number, to: number) {
  return touches(state, state.doc.lineAt(from).from, state.doc.lineAt(to).to)
}

const hidden = Decoration.replace({})

/** `[[target#anchor|alias]]` → what's shown: the alias or the target. */
function wikiLabel(raw: string, embed: boolean) {
  const inner = raw.slice(embed ? 3 : 2, -2)
  const bar = inner.indexOf('|')
  if (bar !== -1) return inner.slice(bar + 1)
  return inner.replace(/^\//, '').replace(/\.md$/i, '')
}

class WikiWidget extends WidgetType {
  readonly raw: string
  readonly label: string
  readonly info: LinkInfo | undefined
  readonly text: LinkLabels
  constructor(raw: string, label: string, info: LinkInfo | undefined, text: LinkLabels) {
    super()
    this.raw = raw
    this.label = label
    this.info = info
    this.text = text
  }
  eq(o: WikiWidget) {
    return o.raw === this.raw && o.label === this.label && o.info?.status === this.info?.status && o.info?.path === this.info?.path && o.text === this.text
  }
  toDOM(view: EditorView) {
    const status = this.info?.status ?? 'pending'
    const wrap = document.createElement('span')
    wrap.className = `cm-wikilink cm-wikilink-${status}`
    const a = document.createElement('a')
    a.textContent = this.label
    a.href = this.info?.path ? `?note=${encodeURIComponent(this.info.path)}` : '#'
    if (this.info?.status === 'ambiguous') a.title = (this.info.candidates ?? []).join('\n')
    // A resolved link navigates on click (on mousedown: otherwise the editor first
    // moves the cursor to the link, reveals its text for editing, and the click never
    // arrives). Broken or ambiguous links let the click through: the cursor enters
    // and they can be fixed.
    const target = this.info?.status === 'resolved' ? this.info.path : null
    if (target) {
      a.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return
        e.preventDefault()
        view.state.facet(navigate)(target)
      })
    }
    a.addEventListener('click', (e) => e.preventDefault())
    wrap.append(a)
    if (status === 'missing') {
      wrap.append(missingBadge(view, this.text.missing, wikiLinkNote(view.state.facet(notePath), this.raw)))
    } else if (status === 'ambiguous') {
      const badge = document.createElement('span')
      badge.className = 'cm-wikilink-badge'
      badge.textContent = this.text.ambiguous(this.info?.candidates?.length ?? 0)
      wrap.append(badge)
    }
    return wrap
  }
  ignoreEvent(e: Event) { return (this.info?.status === 'resolved' && e.type === 'mousedown') || onCreateButton(e) }
}

class BulletWidget extends WidgetType {
  eq() { return true }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-bullet'
    s.textContent = '•'
    return s
  }
}
const bullet = Decoration.replace({ widget: new BulletWidget() })

// --- Inline decorations (ViewPlugin: only what's visible) --------------------------

function inlineDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const out: Range<Decoration>[] = []
  const linkMap = state.field(links)
  const text = state.facet(labels)
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (ref) => {
        const node = ref.node
        const name = node.name
        const heading = /^ATXHeading(\d)$/.exec(name)
        if (heading) {
          out.push(Decoration.line({ class: `cm-h cm-h${heading[1]}` }).range(state.doc.lineAt(node.from).from))
          const mark = node.getChild('HeaderMark')
          if (mark && !touchesLines(state, node.from, node.to)) {
            const after = state.doc.sliceString(mark.to, mark.to + 1) === ' ' ? mark.to + 1 : mark.to
            out.push(hidden.range(mark.from, after))
          }
          return
        }
        const setext = /^SetextHeading(\d)$/.exec(name)
        if (setext) {
          out.push(Decoration.line({ class: `cm-h cm-h${setext[1]}` }).range(state.doc.lineAt(node.from).from))
          return
        }
        switch (name) {
          case 'Emphasis':
          case 'StrongEmphasis':
          case 'Strikethrough':
          case 'InlineCode':
            if (!touches(state, node.from, node.to)) hideChildren(node, ['EmphasisMark', 'StrikethroughMark', 'CodeMark'], out)
            return
          case 'Link':
            if (!touches(state, node.from, node.to)) hideLinkSyntax(state, node, out, linkMap.get(state.doc.sliceString(node.from, node.to))?.status)
            return
          case 'WikiLink':
          case 'WikiEmbed': {
            const raw = state.doc.sliceString(node.from, node.to)
            // `![[image.png]]` is an image, not a link: images.ts shows it.
            if (name === 'WikiEmbed' && isImageRef(raw.slice(3, -2).split('|')[0]!.replace(/#.*$/, '').trim())) return false
            if (touches(state, node.from, node.to)) {
              out.push(Decoration.mark({ class: 'cm-wikilink-raw' }).range(node.from, node.to))
            } else {
              const info = linkMap.get(raw)
              out.push(Decoration.replace({ widget: new WikiWidget(raw, wikiLabel(raw, name === 'WikiEmbed'), info, text) }).range(node.from, node.to))
            }
            return false
          }
          case 'ListMark':
            if (node.parent?.parent?.name === 'BulletList' && !touchesLines(state, node.from, node.to)) out.push(bullet.range(node.from, node.to))
            return
          case 'Tag':
            out.push(Decoration.mark({ class: 'cm-tag' }).range(node.from, node.to))
            return false
          case 'FencedCode':
            for (let pos = node.from; pos <= node.to;) {
              const line = state.doc.lineAt(pos)
              out.push(Decoration.line({ class: 'cm-codeblock' }).range(line.from))
              pos = line.to + 1
            }
            return false
          case 'Blockquote':
            for (let pos = node.from; pos <= node.to;) {
              const line = state.doc.lineAt(pos)
              out.push(Decoration.line({ class: 'cm-quote' }).range(line.from))
              pos = line.to + 1
            }
            return
          case 'HorizontalRule':
            out.push(Decoration.line({ class: 'cm-hr' }).range(state.doc.lineAt(node.from).from))
            return
        }
      },
    })
  }
  return Decoration.set(out, true)
}

function hideChildren(node: SyntaxNode, names: string[], out: Range<Decoration>[]) {
  for (let c = node.firstChild; c; c = c.nextSibling) if (names.includes(c.name)) out.push(hidden.range(c.from, c.to))
}

/** «missing · create» after a Markdown link to a note that doesn't exist. */
class MissingLinkWidget extends WidgetType {
  readonly raw: string
  readonly dest: string
  readonly text: string
  constructor(raw: string, dest: string, text: string) {
    super()
    this.raw = raw
    this.dest = dest
    this.text = text
  }
  eq(o: MissingLinkWidget) { return o.raw === this.raw && o.text === this.text }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span')
    wrap.className = 'cm-wikilink-missing'
    wrap.append(missingBadge(view, this.text, markdownLinkNote(view.state.facet(notePath), this.raw, this.dest)))
    return wrap
  }
  ignoreEvent(e: Event) { return onCreateButton(e) }
}

/** `[text](url "title")` → shows `text` as a link. */
function hideLinkSyntax(state: EditorState, node: SyntaxNode, out: Range<Decoration>[], status?: LinkInfo['status']) {
  const marks: SyntaxNode[] = []
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === 'LinkMark') marks.push(c)
  if (marks.length < 2) return
  const open = marks[0]!
  const close = marks[1]!
  if (open.to >= close.from) return
  out.push(hidden.range(open.from, open.to))
  out.push(Decoration.mark({ class: status ? `cm-link cm-link-${status}` : 'cm-link' }).range(open.to, close.from))
  const url = node.getChild('URL')
  if (status === 'missing' && url) {
    const widget = new MissingLinkWidget(state.doc.sliceString(node.from, node.to), state.doc.sliceString(url.from, url.to), state.facet(labels).missing)
    out.push(Decoration.replace({ widget }).range(close.from, node.to))
  } else {
    out.push(hidden.range(close.from, node.to))
  }
}

const inlinePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) { this.decorations = inlineDecorations(view) }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.state) !== syntaxTree(u.startState) ||
          u.transactions.some((t) => focusChanged(t) || t.effects.some((e) => e.is(setLinks)))) {
        this.decorations = inlineDecorations(u.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)

// --- Folded frontmatter (StateField: spans several lines) ------------------------

class FrontmatterChip extends WidgetType {
  readonly keys: number
  readonly label: string
  readonly inside: number
  constructor(keys: number, label: string, inside: number) {
    super()
    this.keys = keys
    this.label = label
    this.inside = inside
  }
  eq(o: FrontmatterChip) { return o.keys === this.keys && o.label === this.label && o.inside === this.inside }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div')
    wrap.className = 'cm-frontmatter-chip'
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = this.label
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', () => {
      view.dispatch({ selection: { anchor: this.inside } })
      view.focus()
    })
    wrap.append(b)
    return wrap
  }
  ignoreEvent() { return true }
}

function frontmatterDecorations(state: EditorState): DecorationSet {
  const fm = syntaxTree(state).topNode.getChild('Frontmatter')
  if (!fm || fm.to <= fm.from) return Decoration.none
  const first = state.doc.lineAt(fm.from)
  const last = state.doc.lineAt(Math.max(fm.from, fm.to - 1))
  if (last.number === first.number || touches(state, first.from, last.to)) return Decoration.none
  const yaml = state.doc.sliceString(first.to + 1, last.from)
  const keys = yaml.split('\n').filter((l) => /^[^\s#-][^:]*:/.test(l)).length
  const widget = new FrontmatterChip(keys, state.facet(labels).frontmatter(keys), first.to + 1)
  return Decoration.set([Decoration.replace({ widget, block: true }).range(first.from, last.to)])
}

const frontmatterFold = StateField.define<DecorationSet>({
  create: frontmatterDecorations,
  update: (v, tr) => (tr.docChanged || tr.selection || focusChanged(tr) || syntaxTree(tr.state) !== syntaxTree(tr.startState) ? frontmatterDecorations(tr.state) : v),
  provide: (f) => EditorView.decorations.from(f),
})

export const livePreview = [focused, trackFocus, links, inlinePreview, frontmatterFold]
