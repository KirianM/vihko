// Extraction of links, tags and headings on top of vihko's syntax (syntax.ts).
import { markdownParser } from './syntax.ts'
import { readFrontmatter } from './frontmatter.ts'
import { isImageRef } from './images.ts'
import { caseFold } from './casefold.ts'

// --- Extraction -------------------------------------------------------------

export interface LinkRef {
  kind: 'wiki' | 'embed' | 'markdown'
  /** The link's literal text as it appears in the note. */
  raw: string
  /** Target without the anchor: name, partial path or relative path. Empty = the note itself. */
  target: string
  /** Heading after `#`, or null. */
  anchor: string | null
  /** Visible text (`|text` or the Markdown link's text), or null. */
  display: string | null
  from: number
  to: number
}

/**
 * A reference to an image file (D-028): `![alt](dest)`, `![[image.png]]`, and
 * links to an image file (`[text](image.png)`, `[[image.png]]`). They are not
 * links between notes; the index keeps them apart to know who uses each image.
 */
export interface ImageLink {
  /** `image` = `![](…)`, `embed` = `![[…]]`, `markdown` = `[](…)`, `wiki` = `[[…]]`. */
  kind: 'image' | 'embed' | 'markdown' | 'wiki'
  /** The reference's literal text as it appears in the note. */
  raw: string
  /**
   * The destination as written: for Markdown, possibly URL-encoded, in `<>` or
   * with `?query`/`#anchor`; for wikilinks, the target without `|text` or `#anchor`.
   * Only local references: URLs with a scheme are left out.
   */
  dest: string
  /** Span of the whole reference. */
  from: number
  to: number
  /** Span of `dest` in the note's text: what a rewrite replaces. */
  destFrom: number
  destTo: number
}

export interface TagRef {
  /** Normalized: NFC, lowercase, no `#`. */
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

/** Span of the note's text, `[from, to)`. */
export interface Range {
  from: number
  to: number
}

export interface ExtractOptions {
  /** Frontmatter key holding the tags (configurable). */
  tagsKey?: string
}

export interface Extracted {
  frontmatter: ReturnType<typeof readFrontmatter>
  links: LinkRef[]
  /** Local image references, in order of appearance. Resolved against the note with `resolveImageRef`. */
  images: ImageLink[]
  tags: TagRef[]
  headings: Heading[]
  /**
   * HTML comments (`<!-- -->`), where vihko keeps the comments between people
   * and agents. Viewers hide them, so they aren't body text: not searchable, not
   * part of heading texts or backlink contexts. Never inside code.
   */
  comments: Range[]
}

export const normalizeTag = (t: string) => caseFold(t.replace(/^#/, ''))

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i
/** A comment inside a raw HTML block; unterminated, it runs to the end of the block. */
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g

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

/** Where the target of a wikilink or embed is in the note: `[[ target #anchor|text]]` → ` target `, trimmed. */
function wikiTargetSpan(raw: string, kind: 'wiki' | 'embed', from: number): { destFrom: number; destTo: number } {
  const start = kind === 'embed' ? 3 : 2
  const inner = raw.slice(start, -2)
  const end = inner.search(/[|#]/)
  const dest = end === -1 ? inner : inner.slice(0, end)
  const lead = dest.length - dest.trimStart().length
  return { destFrom: from + start + lead, destTo: from + start + dest.trimEnd().length }
}

function safeDecode(s: string) {
  try { return decodeURIComponent(s) } catch { return s }
}

/**
 * `text[from, to)` without the given ranges (sorted, not overlapping). Where a
 * range glued two words together, a space keeps them apart.
 */
export function withoutRanges(text: string, ranges: readonly Range[], from = 0, to = text.length): string {
  let out = ''
  let pos = from
  for (const r of ranges) {
    if (r.to <= pos) continue
    if (r.from >= to) break
    out += text.slice(pos, Math.max(pos, r.from))
    pos = Math.min(r.to, to)
    const before = out.at(-1)
    const after = pos < to ? text[pos] : undefined
    if (before !== undefined && after !== undefined && /\S/.test(before) && /\S/.test(after)) out += ' '
  }
  return out + text.slice(pos, to)
}

function headingText(raw: string, setext: boolean) {
  if (setext) return raw.split('\n')[0]!.trim()
  return raw.replace(/^#{1,6}[ \t]*/, '').replace(/[ \t]+#+[ \t]*$/, '').trim()
}

function frontmatterTags(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : []
  return items.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map(normalizeTag)
}

/** Extracts links, tags and headings from a whole note (frontmatter included). */
export function extract(text: string, opts: ExtractOptions = {}): Extracted {
  const frontmatter = readFrontmatter(text)
  const bodyStart = frontmatter.bodyStart
  const body = text.slice(bodyStart)
  const tree = markdownParser.parse(body)
  const links: LinkRef[] = []
  const images: ImageLink[] = []
  const tags: TagRef[] = []
  const headingNodes: { level: number; setext: boolean; from: number; to: number }[] = []
  const comments: Range[] = []

  for (const t of frontmatterTags(frontmatter.data[opts.tagsKey ?? 'tags'])) {
    tags.push({ name: t, source: 'frontmatter', from: null, to: null })
  }

  tree.iterate({
    enter(node) {
      const from = node.from + bodyStart
      const to = node.to + bodyStart
      const raw = body.slice(node.from, node.to)
      switch (node.name) {
        // A reference to an image is not a link between notes: it never resolves
        // to a note and would show up as broken (the editor renders it instead).
        case 'WikiLink':
        case 'WikiEmbed': {
          const kind = node.name === 'WikiEmbed' ? 'embed' : 'wiki'
          const link = parseWikiRaw(raw, kind, from, to)
          if (!isImageRef(link.target)) links.push(link)
          else if (!EXTERNAL.test(link.target)) images.push({ kind, raw, dest: link.target, from, to, ...wikiTargetSpan(raw, kind, from) })
          return false
        }
        case 'Image': {
          const url = node.node.getChild('URL')
          if (!url) return
          const dest = body.slice(url.from, url.to)
          if (!EXTERNAL.test(dest.replace(/^</, ''))) images.push({ kind: 'image', raw, dest, from, to, destFrom: url.from + bodyStart, destTo: url.to + bodyStart })
          return
        }
        case 'Tag':
          tags.push({ name: normalizeTag(raw), source: 'inline', from, to })
          return false
        case 'Link': {
          const url = node.node.getChild('URL')
          if (!url) return
          let dest = body.slice(url.from, url.to).replace(/^<|>$/g, '')
          if (!dest || EXTERNAL.test(dest)) return
          if (isImageRef(dest)) {
            images.push({ kind: 'markdown', raw, dest: body.slice(url.from, url.to), from, to, destFrom: url.from + bodyStart, destTo: url.to + bodyStart })
            return
          }
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
        case 'Comment':
          comments.push({ from, to })
          return false
        case 'CommentBlock':
        case 'HTMLBlock':
          // A comment block ends with the line holding `-->`: what follows it on that line is text.
          for (const m of raw.matchAll(HTML_COMMENT)) comments.push({ from: from + m.index, to: from + m.index + m[0].length })
          return false
        default: {
          const m = /^(ATX|Setext)Heading(\d)$/.exec(node.name)
          if (m) headingNodes.push({ level: Number(m[2]), setext: m[1] === 'Setext', from, to })
        }
      }
    },
  })

  // After the walk: a heading's comments are its children.
  const headings = headingNodes.map((h) => ({ level: h.level, text: headingText(withoutRanges(text, comments, h.from, h.to), h.setext), from: h.from }))
  return { frontmatter, links, images, tags, headings, comments }
}
