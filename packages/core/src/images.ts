// Images in notes: which references point to an image, how a note-relative
// reference resolves to a path in the notes folder, and how a path is written
// as a Markdown link destination. Browser-safe entry point (@vihko/core/images):
// used by the indexer, the server and the editor. No Node modules here.
import { rootedPath } from './resolve.ts'

/** Extensions shown as images (also those vihko never stores, like SVG: they can already be in a vault). */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'] as const

const IMAGE_RE = new RegExp(`\\.(?:${IMAGE_EXTENSIONS.join('|')})$`, 'i')

/** true if the reference (a path or a URL, without `#anchor` or `?query`) names an image file. */
export function isImageRef(ref: string): boolean {
  return IMAGE_RE.test(ref.replace(/[?#].*$/, ''))
}

/** `http://` or `https://`: an image outside the notes folder. */
export const isExternalUrl = (ref: string) => /^https?:\/\//i.test(ref)

/** Any scheme (`data:`, `mailto:`…) or a protocol-relative URL: never a path in the notes folder. */
const HAS_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

function decode(s: string) {
  try { return decodeURIComponent(s) } catch { return s }
}

/**
 * Path in the notes folder that a reference written in `notePath` points to, or
 * null if it isn't a local path or it leaves the folder. Markdown destinations
 * are relative to the note and may be URL-encoded; a leading `/` is the root
 * of the note's space, as for links (resolve.ts `rootedPath`).
 * `![[name]]` embeds are passed with `embed: true`: a bare name is taken as
 * relative to the note, like Markdown (no name lookup across the vault).
 */
export function resolveImageRef(notePath: string, ref: string, opts: { embed?: boolean } = {}): string | null {
  let dest = ref.trim().replace(/^<|>$/g, '')
  if (!dest || HAS_SCHEME.test(dest)) return null
  dest = dest.replace(/[?#].*$/, '')
  if (!opts.embed) dest = decode(dest)
  if (dest.startsWith('/')) dest = rootedPath(notePath, dest)
  else dest = `${dirOf(notePath)}/${dest}`
  const parts: string[] = []
  for (const seg of dest.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else parts.push(seg)
  }
  return parts.length ? parts.join('/') : null
}

const utf8 = new TextEncoder()

/**
 * A relative path written as a Markdown link destination: only what would
 * break the link is escaped (white space of any kind, brackets, `%`, `#`,
 * `?`, `<`, `>`, `\`), so accents and other letters stay readable. Each
 * escaped character is written as its UTF-8 bytes, which is how
 * `decodeURIComponent` reads it back: the narrow no-break space of macOS
 * screenshot names (U+202F) is `%E2%80%AF`.
 */
export function markdownDest(path: string): string {
  return path.replace(/[\s()[\]%#?<>\\]/g, (c) => Array.from(utf8.encode(c), (b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join(''))
}

/**
 * The Markdown image for a stored image, ready to write into its note:
 * `src` relative to the note (as `markdownDest` escapes it), and `alt` on one
 * line, with the brackets and backslashes that would end or break it escaped.
 */
export function imageMarkdown(src: string, alt = ''): string {
  // Any run of white space, line breaks included, is one space: a line break could end the paragraph, and the link with it.
  const text = alt.replace(/\s+/g, ' ').trim().replace(/[\\[\]]/g, '\\$&')
  return `![${text}](${markdownDest(src)})`
}
