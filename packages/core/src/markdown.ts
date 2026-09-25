// Extraction of links, tags and headings on top of thoth's syntax (syntax.ts).
import { markdownParser } from './syntax.ts'
import { readFrontmatter } from './frontmatter.ts'
import { isImageRef } from './images.ts'

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

export interface ExtractOptions {
  /** Frontmatter key holding the tags (configurable). */
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

/** Extracts links, tags and headings from a whole note (frontmatter included). */
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
        // A reference to an image is not a link between notes: it never resolves
        // to a note and would show up as broken (the editor renders it instead).
        case 'WikiLink':
        case 'WikiEmbed': {
          const link = parseWikiRaw(raw, node.name === 'WikiEmbed' ? 'embed' : 'wiki', from, to)
          if (!isImageRef(link.target)) links.push(link)
          return false
        }
        case 'Tag':
          tags.push({ name: normalizeTag(raw), source: 'inline', from, to })
          return false
        case 'Link': {
          const url = node.node.getChild('URL')
          if (!url) return
          let dest = body.slice(url.from, url.to).replace(/^<|>$/g, '')
          if (!dest || EXTERNAL.test(dest) || isImageRef(dest)) return
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
