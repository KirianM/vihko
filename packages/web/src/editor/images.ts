// Images in the editor: `![alt](path)` and `![[image.png]]` are shown
// as the image, resolved against the note's folder (an `![[…]]` also by name
// in the note's space, as Obsidian writes them), and pasting or dropping an
// image hands it to whoever uploads it. The text of the note never changes
// here; this only decorates it.
import { syntaxTree } from '@codemirror/language'
import { Facet, StateEffect, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { isExternalUrl, isImageRef, resolveImageRef } from '@vihko/core/images'
import { focusChanged, touches } from './livePreview.ts'
import { fileUrl, namedFileUrl } from './files.ts'

export { fileUrl }

export interface ImageLabels {
  external: string
  missing: string
  blocked: (domain: string) => string
  /** An external image not loaded until asked: «External image from example.com». */
  ask: (domain: string) => string
  show: string
  saveCopy: string
}

export interface ImageHost {
  /**
   * Path of the open note: relative references resolve against its folder.
   */
  note: string
  /**
   * External images: loaded (`allow`); a box with their site and «Show» until
   * the reader asks (`ask`); never loaded (`block`). Both boxes offer «Save a
   * copy» where the note can be written (`onSaveCopy`).
   */
  external: 'allow' | 'ask' | 'block'
  text: ImageLabels
  /** «Save a copy» of the external image `url` written over `from`–`to` (alt text `alt`); null where the note can't be written. */
  onSaveCopy: ((url: string, alt: string, from: number, to: number) => void) | null
  /** Image files pasted or dropped, to replace `from`–`to`. */
  onFiles: (files: File[], from: number, to: number) => void
  /** A single image URL pasted: someone decides whether to copy it, link it or paste it as text. */
  onUrl: (url: string, from: number, to: number) => void
}

export const imageHost = Facet.define<ImageHost, ImageHost | null>({ combine: (v) => v[0] ?? null })

type Source =
  | { kind: 'local'; url: string; name: string }
  | { kind: 'external'; url: string; domain: string }
  | { kind: 'ask'; url: string; domain: string }
  | { kind: 'blocked'; url: string; domain: string }
  | { kind: 'data'; url: string }
  | { kind: 'invalid'; name: string }

/** External images the reader asked to see on this page («Show»): shown from then on, wherever they are. */
const shown = new Set<string>()
const showExternal = StateEffect.define<string>()

function sourceOf(host: ImageHost, ref: string, embed: boolean): Source {
  const dest = ref.trim().replace(/^<|>$/g, '')
  if (isExternalUrl(dest)) {
    let domain = dest
    try { domain = new URL(dest).host } catch { return { kind: 'invalid', name: dest } }
    if (host.external === 'block') return { kind: 'blocked', url: dest, domain }
    return host.external === 'allow' || shown.has(dest) ? { kind: 'external', url: dest, domain } : { kind: 'ask', url: dest, domain }
  }
  if (/^data:image\//i.test(dest)) return { kind: 'data', url: dest }
  const path = resolveImageRef(host.note, dest, { embed })
  const name = dest.split('/').pop() || dest
  if (!path) return { kind: 'invalid', name }
  // `![[photo.png]]`: next to the note, or wherever it is in the note's space, as Obsidian finds it.
  return { kind: 'local', url: embed ? namedFileUrl(host.note, dest) : fileUrl(path), name }
}

class ImageWidget extends WidgetType {
  readonly source: Source
  readonly alt: string
  readonly text: ImageLabels
  readonly save: ImageHost['onSaveCopy']
  constructor(source: Source, alt: string, text: ImageLabels, save: ImageHost['onSaveCopy']) {
    super()
    this.source = source
    this.alt = alt
    this.text = text
    this.save = save
  }
  eq(o: ImageWidget) {
    return JSON.stringify(o.source) === JSON.stringify(this.source) && o.alt === this.alt && o.text === this.text && (o.save === null) === (this.save === null)
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span')
    wrap.className = 'cm-image'
    // A click puts the cursor right after the image, which reveals its source
    // to edit it. Left to the editor, it went where the click's height fell,
    // often inside the source (a big image beside short lines), and what was
    // typed or inserted next split its reference.
    wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      view.dispatch({ selection: { anchor: imageEnd(view.state, view.posAtDOM(wrap)) } })
      view.focus()
    })
    const s = this.source
    if (s.kind === 'blocked' || s.kind === 'ask') {
      box(wrap, 'cm-image-blocked', s.kind === 'ask' ? this.text.ask(s.domain) : this.text.blocked(s.domain))
      const actions = document.createElement('span')
      actions.className = 'cm-image-actions'
      const button = (label: string, act: () => void) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'cm-image-action'
        b.textContent = label
        b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
        b.addEventListener('click', (e) => { e.preventDefault(); act() })
        actions.append(b)
      }
      if (s.kind === 'ask') button(this.text.show, () => { shown.add(s.url); view.dispatch({ effects: showExternal.of(s.url) }) })
      const save = this.save
      if (save) button(this.text.saveCopy, () => {
        const at = imageRange(view.state, view.posAtDOM(wrap))
        if (at) save(s.url, this.alt, at.from, at.to)
      })
      if (actions.childElementCount) wrap.querySelector('.cm-image-box')!.append(actions)
      return wrap
    }
    if (s.kind === 'invalid') return box(wrap, 'cm-image-missing', `${this.text.missing} · ${s.name}`)
    const img = document.createElement('img')
    img.alt = this.alt
    img.decoding = 'async'
    if (s.kind === 'external') img.referrerPolicy = 'no-referrer'
    // The line changes height once the image arrives: the editor has to measure it again.
    img.addEventListener('load', () => view.requestMeasure())
    img.addEventListener('error', () => {
      wrap.replaceChildren()
      box(wrap, 'cm-image-missing', `${this.text.missing} · ${s.kind === 'local' ? s.name : s.kind === 'external' ? s.domain : this.alt}`)
      view.requestMeasure()
    })
    img.src = s.url
    wrap.append(img)
    if (s.kind === 'external') {
      wrap.classList.add('cm-image-external')
      const mark = document.createElement('span')
      mark.className = 'cm-image-mark'
      mark.textContent = this.text.external
      mark.title = s.domain
      wrap.append(mark)
    }
    return wrap
  }
  // The click is the widget's own (above), and so are its buttons'; the rest reach the editor.
  ignoreEvent(e: Event) { return e.type === 'mousedown' || (e.target instanceof Element && e.target.closest('.cm-image-action') !== null) }
}

/** The whole image at `pos` (`![…](…)` or `![[…]]`), where its widget is. */
function imageRange(state: EditorState, pos: number): { from: number; to: number } | null {
  for (const side of [1, -1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name === 'Image' || n.name === 'WikiEmbed') return { from: n.from, to: n.to }
    }
  }
  return null
}

/** The end of the image at `pos` (where its widget is: at its start, or at its end with its source shown). */
function imageEnd(state: EditorState, pos: number): number {
  for (const side of [1, -1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name === 'Image' || n.name === 'WikiEmbed') return n.to
    }
  }
  return pos
}

function box(wrap: HTMLElement, cls: string, label: string) {
  wrap.classList.add(cls)
  const b = document.createElement('span')
  b.className = 'cm-image-box'
  b.textContent = label
  wrap.append(b)
  return wrap
}

/** `![alt](dest "title")` → alt and destination, or null if it has no destination. */
function markdownImage(view: EditorView, node: SyntaxNode): { alt: string; dest: string } | null {
  const url = node.getChild('URL')
  const marks = node.getChildren('LinkMark')
  if (!url || marks.length < 2) return null
  return { alt: view.state.doc.sliceString(marks[0]!.to, marks[1]!.from), dest: view.state.doc.sliceString(url.from, url.to) }
}

/** `![[name.png|text]]` → target, if it names an image (other embeds are links to notes). */
export function embeddedImage(raw: string): { target: string; alt: string } | null {
  const inner = raw.slice(3, -2)
  const bar = inner.indexOf('|')
  const target = (bar === -1 ? inner : inner.slice(0, bar)).replace(/#.*$/, '').trim()
  return isImageRef(target) ? { target, alt: bar === -1 ? '' : inner.slice(bar + 1).trim() } : null
}

function decorations(view: EditorView): DecorationSet {
  const host = view.state.facet(imageHost)
  if (!host) return Decoration.none
  const out: Range<Decoration>[] = []
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter: (ref) => {
        let widget: ImageWidget | null = null
        if (ref.name === 'Image') {
          const img = markdownImage(view, ref.node)
          if (img) widget = new ImageWidget(sourceOf(host, img.dest, false), img.alt, host.text, host.onSaveCopy)
        } else if (ref.name === 'WikiEmbed') {
          const img = embeddedImage(view.state.doc.sliceString(ref.from, ref.to))
          if (img) widget = new ImageWidget(sourceOf(host, img.target, true), img.alt, host.text, host.onSaveCopy)
        } else return
        if (!widget) return false
        // With the cursor on it, the source shows for editing and the image stays below it.
        out.push(touches(view.state, ref.from, ref.to)
          ? Decoration.widget({ widget, side: 1 }).range(ref.to)
          : Decoration.replace({ widget }).range(ref.from, ref.to))
        return false
      },
    })
  }
  return Decoration.set(out, true)
}

const imagePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) { this.decorations = decorations(view) }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.state) !== syntaxTree(u.startState) ||
          u.startState.facet(imageHost) !== u.state.facet(imageHost) || u.transactions.some(focusChanged) ||
          u.transactions.some((tr) => tr.effects.some((e) => e.is(showExternal)))) {
        this.decorations = decorations(u.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)

/** Image files in a paste or a drop. A paste that also carries text (a spreadsheet range, say) stays a text paste. */
function imageFiles(data: DataTransfer | null, ignoreIfText: boolean): File[] {
  if (!data) return []
  if (ignoreIfText && data.getData('text/plain').trim()) return []
  return [...data.files].filter((f) => f.type.startsWith('image/'))
}

/** A single `http(s)` URL that names an image. */
export function imageUrl(text: string): string | null {
  const t = text.trim()
  return /^https?:\/\/\S+$/i.test(t) && isImageRef(t) ? t : null
}

// Nothing is pasted or dropped into a read-only editor.
const imageInput = EditorView.domEventHandlers({
  paste(e, view) {
    const host = view.state.facet(imageHost)
    if (!host || view.state.readOnly) return false
    const { from, to } = view.state.selection.main
    const files = imageFiles(e.clipboardData, true)
    if (files.length) {
      e.preventDefault()
      host.onFiles(files, from, to)
      return true
    }
    const url = imageUrl(e.clipboardData?.getData('text/plain') ?? '')
    if (!url) return false
    e.preventDefault()
    host.onUrl(url, from, to)
    return true
  },
  drop(e, view) {
    const host = view.state.facet(imageHost)
    const files = imageFiles(e.dataTransfer, false)
    if (!host || !files.length) return false
    if (view.state.readOnly) {
      e.preventDefault()
      return true
    }
    e.preventDefault()
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head
    host.onFiles(files, pos, pos)
    return true
  },
})

export const images = [imagePreview, imageInput]
