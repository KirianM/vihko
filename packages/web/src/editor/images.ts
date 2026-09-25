// Images in the editor (D-028): `![alt](path)` and `![[image.png]]` are shown
// as the image, resolved against the note's folder, and pasting or dropping an
// image hands it to whoever uploads it. The text of the note never changes
// here; this only decorates it.
import { syntaxTree } from '@codemirror/language'
import { Facet, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { isExternalUrl, isImageRef, resolveImageRef } from '@thoth/core/images'
import { focusChanged, touches } from './livePreview.ts'

export interface ImageLabels {
  external: string
  missing: string
  blocked: (domain: string) => string
}

export interface ImageHost {
  /** Path of the open note: relative references resolve against its folder. */
  note: string
  /** External images: loaded, or replaced by a box with their domain. */
  external: 'allow' | 'block'
  text: ImageLabels
  /** Image files pasted or dropped, to replace `from`–`to`. */
  onFiles: (files: File[], from: number, to: number) => void
  /** A single image URL pasted: someone decides whether to copy it, link it or paste it as text. */
  onUrl: (url: string, from: number, to: number) => void
}

export const imageHost = Facet.define<ImageHost, ImageHost | null>({ combine: (v) => v[0] ?? null })

/** URL the browser loads a file of the notes folder from. */
export const fileUrl = (path: string) => `/api/file?path=${encodeURIComponent(path)}`

type Source =
  | { kind: 'local'; url: string; name: string }
  | { kind: 'external'; url: string; domain: string }
  | { kind: 'blocked'; domain: string }
  | { kind: 'data'; url: string }
  | { kind: 'invalid'; name: string }

function sourceOf(host: ImageHost, ref: string, embed: boolean): Source {
  const dest = ref.trim().replace(/^<|>$/g, '')
  if (isExternalUrl(dest)) {
    let domain = dest
    try { domain = new URL(dest).host } catch { return { kind: 'invalid', name: dest } }
    return host.external === 'allow' ? { kind: 'external', url: dest, domain } : { kind: 'blocked', domain }
  }
  if (/^data:image\//i.test(dest)) return { kind: 'data', url: dest }
  const path = resolveImageRef(host.note, dest, { embed })
  const name = dest.split('/').pop() || dest
  return path ? { kind: 'local', url: fileUrl(path), name } : { kind: 'invalid', name }
}

class ImageWidget extends WidgetType {
  readonly source: Source
  readonly alt: string
  readonly text: ImageLabels
  constructor(source: Source, alt: string, text: ImageLabels) {
    super()
    this.source = source
    this.alt = alt
    this.text = text
  }
  eq(o: ImageWidget) {
    return JSON.stringify(o.source) === JSON.stringify(this.source) && o.alt === this.alt && o.text === this.text
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span')
    wrap.className = 'cm-image'
    const s = this.source
    if (s.kind === 'blocked') return box(wrap, 'cm-image-blocked', this.text.blocked(s.domain))
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
  // A click lets the editor place the cursor there, which reveals the source to edit it.
  ignoreEvent() { return false }
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
          if (img) widget = new ImageWidget(sourceOf(host, img.dest, false), img.alt, host.text)
        } else if (ref.name === 'WikiEmbed') {
          const img = embeddedImage(view.state.doc.sliceString(ref.from, ref.to))
          if (img) widget = new ImageWidget(sourceOf(host, img.target, true), img.alt, host.text)
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
          u.startState.facet(imageHost) !== u.state.facet(imageHost) || u.transactions.some(focusChanged)) {
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

const imageInput = EditorView.domEventHandlers({
  paste(e, view) {
    const host = view.state.facet(imageHost)
    if (!host) return false
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
    e.preventDefault()
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head
    host.onFiles(files, pos, pos)
    return true
  },
})

export const images = [imagePreview, imageInput]
