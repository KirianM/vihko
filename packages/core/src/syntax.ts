// Sintaxis de Markdown de thoth sobre lezer (D-019): wikilinks, embeds y tags.
// Punto de entrada apto para el navegador (@thoth/core/syntax): lo usan el editor
// y el indexador, así que un enlace o un tag se interpreta igual en los dos sitios
// (D-021). Nada de módulos de Node aquí.
import { GFM, parser as baseParser, type InlineContext, type MarkdownConfig } from '@lezer/markdown'

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
