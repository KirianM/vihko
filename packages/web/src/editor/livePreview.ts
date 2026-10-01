// Live preview: the file's text never changes; it's only decorated.
// Markdown marks (#, **, [[…]], frontmatter) are hidden except where the cursor
// is, which reveals them for editing.
import { syntaxTree } from '@codemirror/language'
import { EditorState, Facet, StateEffect, StateField, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { isImageRef } from '@vihko/core/images'
import { markdownLinkNote, missingBadge, onCreateButton, wikiLinkNote } from './createLink.ts'

// --- Link state (resolved by the server's index) ----------

export interface LinkInfo {
  /** A link to what the person can't read is `missing`, as one to a note that doesn't exist (D-056.15). */
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

/** How far the link written as `raw` has resolved; null if the server hasn't said (or it isn't a note's link). */
export const linkStatus = (state: EditorState, raw: string): LinkInfo['status'] | null => state.field(links, false)?.get(raw)?.status ?? null

/** Path of the note being edited: where a note created from a broken link goes. */
export const notePath = Facet.define<string, string>({ combine: (v) => v[0] ?? '' })

/** What to do when a resolved link is clicked. */
export const navigate = Facet.define<(path: string) => void, (path: string) => void>({
  combine: (fns) => fns[0] ?? (() => {}),
})
/** An ambiguous link was clicked: its text, where it starts, its candidates and the element to anchor a picker to. */
export type PickAmbiguous = (link: { raw: string; at: number; candidates: string[] }, anchor: HTMLElement) => void
export const pickAmbiguous = Facet.define<PickAmbiguous, PickAmbiguous | null>({ combine: (fns) => fns[0] ?? null })
export const labels = Facet.define<LinkLabels, LinkLabels>({
  combine: (v) => v[0] ?? { ambiguous: (n) => `ambiguous · ${n}`, missing: 'missing', frontmatter: (n) => `frontmatter · ${n}` },
})

// --- Following a link ---------------------------------------------------------------

/** A link where it's written: its whole text (`[[…]]`, `[text](dest)`), where it starts, and a Markdown link's destination (null for a wikilink). */
export interface LinkRef { raw: string; at: number; url: string | null }

/** Destinations that leave vihko, opened in a new tab. */
const EXTERNAL = /^(?:https?|mailto):/i
/** A destination with a scheme: any other one (`javascript:`, `file:`…) is never followed. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** A Markdown link's destination as written (`<a b.md>` → `a b.md`). */
export const linkUrl = (url: string) => url.trim().replace(/^<(.*)>$/s, '$1')

/**
 * What clicking a link does, the same for a wikilink and a Markdown link, in
 * the text or in a table: to a note that resolves, it opens it; an ambiguous
 * one offers its candidates (D-031.2); an http(s) or mailto one opens in a new
 * tab, without the page it opens reaching this one. null for the rest (broken,
 * no access, another scheme, not resolved yet): the click goes through, the
 * cursor enters and the link can be edited.
 */
export function linkAction(view: EditorView, link: LinkRef, anchor: HTMLElement): (() => void) | null {
  const url = link.url === null ? null : linkUrl(link.url)
  if (url !== null && SCHEME.test(url)) {
    return EXTERNAL.test(url) ? () => { window.open(url, '_blank', 'noopener,noreferrer') } : null
  }
  const info = view.state.field(links, false)?.get(link.raw)
  if (info?.status === 'resolved' && info.path) {
    const path = info.path
    return () => view.state.facet(navigate)(path)
  }
  const pick = info?.status === 'ambiguous' ? view.state.facet(pickAmbiguous) : null
  if (pick) return () => pick({ raw: link.raw, at: link.at, candidates: [...info?.candidates ?? []] }, anchor)
  return null
}

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
// CodeMirror drops its focus-change transaction if another one lands first (a
// click that moves the cursor while co-editing, say), and never retries: the
// editor has focus but `focused` says it doesn't, and nothing is revealed.
// This puts them back in step after any update.
const focusSync = ViewPlugin.define((view) => ({
  update() {
    if (view.hasFocus === view.state.field(focused)) return
    queueMicrotask(() => {
      if (view.hasFocus !== view.state.field(focused)) view.dispatch({ effects: focusEffect.of(view.hasFocus) })
    })
  },
}))
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
    return o.raw === this.raw && o.label === this.label && o.info?.status === this.info?.status && o.info?.path === this.info?.path && o.text === this.text &&
      (o.info?.candidates ?? []).join('\n') === (this.info?.candidates ?? []).join('\n')
  }
  toDOM(view: EditorView) {
    const status = this.info?.status ?? 'pending'
    const wrap = document.createElement('span')
    wrap.className = `cm-wikilink cm-wikilink-${status}`
    const a = document.createElement('a')
    a.textContent = this.label
    a.href = this.info?.path ? `?note=${encodeURIComponent(this.info.path)}` : '#'
    if (this.info?.status === 'ambiguous') a.title = (this.info.candidates ?? []).join('\n')
    // Followed on mousedown (`linkAction`): otherwise the editor first moves the
    // cursor to the link, reveals its text for editing, and the click never
    // arrives. Broken links let the click through: the cursor enters and they
    // can be fixed.
    wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || onCreateButton(e)) return
      const act = linkAction(view, { raw: this.raw, at: view.posAtDOM(wrap), url: null }, a)
      if (!act) return
      e.preventDefault()
      act()
    })
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
  ignoreEvent(e: Event) { return ((this.info?.status === 'resolved' || this.info?.status === 'ambiguous') && e.type === 'mousedown') || onCreateButton(e) }
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
            // A task's checkbox (tasks.ts) stands in for its bullet.
            if (node.parent?.parent?.name === 'BulletList' && node.nextSibling?.name !== 'Task' && !touchesLines(state, node.from, node.to)) out.push(bullet.range(node.from, node.to))
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
            if (!touchesLines(state, node.from, node.to)) hideFences(state, node, out)
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

/** A code block's language, as a small label where its opening fence was. */
class CodeLangWidget extends WidgetType {
  readonly lang: string
  constructor(lang: string) {
    super()
    this.lang = lang
  }
  eq(o: CodeLangWidget) { return o.lang === this.lang }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-code-lang'
    s.textContent = this.lang
    return s
  }
}

/**
 * A code block away from the cursor: its fences (from the ``` to the end of
 * their line) are hidden, and their lines stay as its top and bottom edges,
 * so every line of the text is still one of the editor (selecting, copying,
 * moving through them). The opening one shows the language, if it has one.
 * An unclosed block (to the end of the note) has only the opening fence, and
 * one with no line inside keeps both: there'd be nothing left to click into.
 */
function hideFences(state: EditorState, node: SyntaxNode, out: Range<Decoration>[]) {
  const marks = node.getChildren('CodeMark')
  const open = marks[0]
  if (!open || open.from !== node.from) return
  const openLine = state.doc.lineAt(open.from)
  const close = marks.length > 1 ? marks[marks.length - 1]! : null
  const closeLine = close ? state.doc.lineAt(close.from) : null
  if (closeLine && closeLine.number <= openLine.number + 1) return
  const info = node.getChild('CodeInfo')
  const lang = info ? state.doc.sliceString(info.from, info.to).trim().split(/\s+/)[0]! : ''
  // In a quote, its `>` goes too (the line keeps the quote's edge); a list's marker stays.
  const from = (mark: SyntaxNode, line: { from: number }) => (/^[\s>]*$/.test(state.doc.sliceString(line.from, mark.from)) ? line.from : mark.from)
  out.push(Decoration.line({ class: lang ? 'cm-fence cm-fence-open' : 'cm-fence' }).range(openLine.from))
  out.push(Decoration.replace(lang ? { widget: new CodeLangWidget(lang) } : {}).range(from(open, openLine), openLine.to))
  if (close && closeLine) {
    out.push(Decoration.line({ class: 'cm-fence' }).range(closeLine.from))
    out.push(Decoration.replace({}).range(from(close, closeLine), closeLine.to))
  }
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
  const url = node.getChild('URL')
  const external = url !== null && EXTERNAL.test(linkUrl(state.doc.sliceString(url.from, url.to)))
  const kind = status ? ` cm-link-${status}` : external ? ' cm-link-external' : ''
  // `cm-md-link`: the text of a Markdown link shown as one, which `followMarkdownLink` follows.
  out.push(Decoration.mark({ class: `cm-link cm-md-link${kind}` }).range(open.to, close.from))
  if (status === 'missing' && url) {
    const widget = new MissingLinkWidget(state.doc.sliceString(node.from, node.to), state.doc.sliceString(url.from, url.to), state.facet(labels).missing)
    out.push(Decoration.replace({ widget }).range(close.from, node.to))
  } else {
    out.push(hidden.range(close.from, node.to))
  }
}

/**
 * A click on a Markdown link shown as one follows it as a wikilink is
 * followed (`linkAction`), on mousedown for the same reason. With its syntax
 * revealed (the cursor in it) it's text, and clicks edit it.
 */
const followMarkdownLink = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0) return false
    const el = (e.target as Element | null)?.closest?.('.cm-md-link')
    if (!(el instanceof HTMLElement) || !view.contentDOM.contains(el)) return false
    let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(view.posAtDOM(el), 1)
    while (node && node.name !== 'Link') node = node.parent
    const url = node?.getChild('URL')
    if (!node || !url) return false
    const act = linkAction(view, { raw: view.state.doc.sliceString(node.from, node.to), at: node.from, url: view.state.doc.sliceString(url.from, url.to) }, el)
    if (!act) return false
    e.preventDefault()
    act()
    return true
  },
})

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

export const livePreview = [focused, trackFocus, focusSync, links, inlinePreview, followMarkdownLink, frontmatterFold]
