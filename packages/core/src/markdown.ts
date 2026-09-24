// Sintaxis de thoth sobre lezer-markdown (D-019) y extracción de enlaces, tags y
// encabezados. El mismo parser lo usará el editor (CodeMirror), así que un enlace
// o un tag se interpreta igual en el editor y en el índice (D-021).
import { GFM, parser as baseParser, type InlineContext, type MarkdownConfig } from '@lezer/markdown'
import { readFrontmatter } from './frontmatter.ts'

const BRACKET_OPEN = 91 // [
const BRACKET_CLOSE = 93 // ]
const BANG = 33 // !
const HASH = 35 // #
const NEWLINE = 10

/** `[[destino#ancla|texto]]` y `![[…]]`. Sin saltos de línea ni corchetes dentro. */
function parseWiki(cx: InlineContext, pos: number, embed: boolean): number {
  const open = embed ? pos + 1 : pos
  if (cx.char(open) !== BRACKET_OPEN || cx.char(open + 1) !== BRACKET_OPEN) return -1
  for (let i = open + 2; i < cx.end - 1; i++) {
    const c = cx.char(i)
    if (c === NEWLINE || c === BRACKET_OPEN) return -1
    if (c === BRACKET_CLOSE) {
      if (cx.char(i + 1) !== BRACKET_CLOSE || i === open + 2) return -1
      return cx.addElement(cx.elt(embed ? 'WikiEmbed' : 'WikiLink', pos, i + 2))
    }
  }
  return -1
}

const TAG_CHAR = /[\p{L}\p{N}_\-/]/u

/** `#tag`: precedido de inicio o espacio; letras, dígitos, `_`, `-`, `/`; no solo dígitos. */
function parseTag(cx: InlineContext, pos: number): number {
  if (pos > cx.offset && !/\s/.test(cx.slice(pos - 1, pos))) return -1
  let end = pos + 1
  while (end < cx.end) {
    const ch = String.fromCodePoint(cx.slice(end, end + 2).codePointAt(0)!)
    if (!TAG_CHAR.test(ch)) break
    end += ch.length
  }
  const name = cx.slice(pos + 1, end).replace(/\/+$/, '')
  if (!name || /^[\d/]+$/.test(name) || name.startsWith('/')) return -1
  return cx.addElement(cx.elt('Tag', pos, pos + 1 + name.length))
}

export const thothSyntax: MarkdownConfig = {
  defineNodes: ['WikiLink', 'WikiEmbed', 'Tag'],
  parseInline: [
    { name: 'WikiEmbed', before: 'Image', parse: (cx, next, pos) => (next === BANG ? parseWiki(cx, pos, true) : -1) },
    { name: 'WikiLink', before: 'Link', parse: (cx, next, pos) => (next === BRACKET_OPEN ? parseWiki(cx, pos, false) : -1) },
    { name: 'Tag', parse: (cx, next, pos) => (next === HASH ? parseTag(cx, pos) : -1) },
  ],
}

/** Parser de Markdown de thoth: CommonMark + GFM + wikilinks, embeds y tags. */
export const markdownParser = baseParser.configure([GFM, thothSyntax])

// --- Extracción -------------------------------------------------------------

export interface LinkRef {
  kind: 'wiki' | 'embed' | 'markdown'
  /** Texto literal del enlace tal como está en la nota. */
  raw: string
  /** Destino sin ancla: nombre, ruta parcial o ruta relativa. Vacío = la propia nota. */
  target: string
  /** Encabezado tras `#`, o null. */
  anchor: string | null
  /** Texto visible (`|texto` o el texto del enlace Markdown), o null. */
  display: string | null
  from: number
  to: number
}

export interface TagRef {
  /** Normalizado: NFC, minúsculas, sin `#`. */
  name: string
  source: 'inline' | 'frontmatter'
  from: number | null
  to: number | null
}

export interface Heading {
  level: number
  text: string
  from: number
}

export interface ExtractOptions {
  /** Clave del frontmatter con los tags (configurable, D-019). */
  tagsKey?: string
}

export interface Extracted {
  frontmatter: ReturnType<typeof readFrontmatter>
  links: LinkRef[]
  tags: TagRef[]
  headings: Heading[]
}

export const normalizeTag = (t: string) => t.replace(/^#/, '').normalize('NFC').toLowerCase()

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

function parseWikiRaw(raw: string, kind: 'wiki' | 'embed', from: number, to: number): LinkRef {
  const inner = raw.slice(kind === 'embed' ? 3 : 2, -2)
  const bar = inner.indexOf('|')
  const dest = bar === -1 ? inner : inner.slice(0, bar)
  const display = bar === -1 ? null : inner.slice(bar + 1).trim()
  const hash = dest.indexOf('#')
  return {
    kind,
    raw,
    target: (hash === -1 ? dest : dest.slice(0, hash)).trim(),
    anchor: hash === -1 ? null : dest.slice(hash + 1).trim() || null,
    display: display || null,
    from,
    to,
  }
}

function safeDecode(s: string) {
  try { return decodeURIComponent(s) } catch { return s }
}

function headingText(raw: string, setext: boolean) {
  if (setext) return raw.split('\n')[0]!.trim()
  return raw.replace(/^#{1,6}[ \t]*/, '').replace(/[ \t]+#+[ \t]*$/, '').trim()
}

function frontmatterTags(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : []
  return items.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map(normalizeTag)
}

/** Extrae enlaces, tags y encabezados de una nota completa (frontmatter incluido). */
export function extract(text: string, opts: ExtractOptions = {}): Extracted {
  const frontmatter = readFrontmatter(text)
  const bodyStart = frontmatter.bodyStart
  const body = text.slice(bodyStart)
  const tree = markdownParser.parse(body)
  const links: LinkRef[] = []
  const tags: TagRef[] = []
  const headings: Heading[] = []

  for (const t of frontmatterTags(frontmatter.data[opts.tagsKey ?? 'tags'])) {
    tags.push({ name: t, source: 'frontmatter', from: null, to: null })
  }

  tree.iterate({
    enter(node) {
      const from = node.from + bodyStart
      const to = node.to + bodyStart
      const raw = body.slice(node.from, node.to)
      switch (node.name) {
        case 'WikiLink':
          links.push(parseWikiRaw(raw, 'wiki', from, to))
          return false
        case 'WikiEmbed':
          links.push(parseWikiRaw(raw, 'embed', from, to))
          return false
        case 'Tag':
          tags.push({ name: normalizeTag(raw), source: 'inline', from, to })
          return false
        case 'Link': {
          const url = node.node.getChild('URL')
          if (!url) return
          let dest = body.slice(url.from, url.to).replace(/^<|>$/g, '')
          if (!dest || EXTERNAL.test(dest)) return
          const hash = dest.indexOf('#')
          const anchor = hash === -1 ? null : safeDecode(dest.slice(hash + 1)) || null
          dest = safeDecode(hash === -1 ? dest : dest.slice(0, hash))
          const labelEnd = raw.indexOf('](')
          links.push({
            kind: 'markdown',
            raw,
            target: dest,
            anchor,
            display: labelEnd > 0 ? raw.slice(1, labelEnd) : null,
            from,
            to,
          })
          return
        }
        default: {
          const m = /^(ATX|Setext)Heading(\d)$/.exec(node.name)
          if (m) headings.push({ level: Number(m[2]), text: headingText(raw, m[1] === 'Setext'), from })
        }
      }
    },
  })

  return { frontmatter, links, tags, headings }
}
