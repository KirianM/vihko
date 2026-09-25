// Images stored in the notes folder (D-028): which types are accepted, where a
// new one goes and what it is called, and downloading one from a URL when a
// user explicitly asks for a copy.
import { posix } from 'node:path'

/** Types thoth stores, detected from the bytes (never from the name or the declared type). */
const STORED: { mime: string; ext: string; test: (b: Uint8Array) => boolean }[] = [
  { mime: 'image/png', ext: 'png', test: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  { mime: 'image/gif', ext: 'gif', test: (b) => ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a' },
  { mime: 'image/webp', ext: 'webp', test: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
  { mime: 'image/avif', ext: 'avif', test: isAvif },
]
// SVG is not stored: it is a document that can carry scripts. An SVG already in
// the folder is still served, sandboxed (see SERVED_TYPES and the file endpoint).

function starts(b: Uint8Array, sig: number[]) {
  return b.length >= sig.length && sig.every((v, i) => b[i] === v)
}
function ascii(b: Uint8Array, from: number, to: number) {
  return b.length >= to ? String.fromCharCode(...b.subarray(from, to)) : ''
}
/** ISO BMFF `ftyp` box whose major or compatible brands include `avif` or `avis`. */
function isAvif(b: Uint8Array) {
  if (ascii(b, 4, 8) !== 'ftyp') return false
  const size = Math.min(((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0, b.length, 256)
  for (let i = 8; i + 4 <= size; i += 4) {
    if (i === 12) continue // minor version
    const brand = ascii(b, i, i + 4)
    if (brand === 'avif' || brand === 'avis') return true
  }
  return false
}

/** The stored image type of these bytes, or null if it isn't one thoth accepts. */
export function sniffImage(bytes: Uint8Array): { mime: string; ext: string } | null {
  const t = STORED.find((s) => s.test(bytes))
  return t ? { mime: t.mime, ext: t.ext } : null
}

/** Content type when serving a file from the notes folder, by extension. */
export const SERVED_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * Where a new image for `notePath` goes, relative to the notes root: next to
 * the note, named after it and the time in UTC (`projects/plan.md` →
 * `projects/plan-2026-09-25-1012.png`). `n` > 1 adds a suffix for a name
 * that is taken (`…-1012-2.png`).
 *
 * This is the single place that decides it: when `thoth.yaml` exists, its
 * destination setting (a fixed folder, a subfolder per note) plugs in here.
 */
export function attachmentPath(notePath: string, ext: string, now: Date, n = 1): string {
  const dir = posix.dirname(notePath)
  const stem = posix.basename(notePath).replace(/\.md$/i, '')
  const stamp = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`
  const name = `${stem}-${stamp}${n > 1 ? `-${n}` : ''}.${ext}`
  return dir === '.' ? name : `${dir}/${name}`
}

export type FetchErrorCode = 'invalid' | 'too_large' | 'unsupported_type' | 'fetch_failed'

export class FetchImageError extends Error {
  readonly code: FetchErrorCode
  constructor(code: FetchErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface FetchImageOptions {
  maxBytes: number
  timeoutMs?: number
  maxRedirects?: number
}

/**
 * Downloads an image for a user who asked for a copy of it. Only http(s), a
 * total time limit, a size cap (checked while reading, not only from the
 * headers), a bounded number of redirects, an image content type and bytes
 * that really are one of the stored types.
 *
 * Private and LAN addresses are allowed on purpose: a user may want a copy of a
 * chart from a service on their network. It only runs on an explicit user
 * action, never for URLs found in notes (D-028).
 */
export async function fetchImage(url: string, opts: FetchImageOptions): Promise<{ bytes: Uint8Array; mime: string }> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 15_000)
  const maxRedirects = opts.maxRedirects ?? 5
  let current = parseHttpUrl(url)
  try {
    for (let hop = 0; ; hop++) {
      const res = await fetch(current, { redirect: 'manual', signal, headers: { accept: 'image/*' } })
      if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
        await res.body?.cancel()
        if (hop >= maxRedirects) throw new FetchImageError('fetch_failed', `too many redirects from ${url}`)
        current = parseHttpUrl(new URL(res.headers.get('location')!, current).href)
        continue
      }
      if (!res.ok) {
        await res.body?.cancel()
        throw new FetchImageError('fetch_failed', `the server answered ${res.status}`)
      }
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      if (!type.startsWith('image/')) {
        await res.body?.cancel()
        throw new FetchImageError('unsupported_type', `not an image: ${type || 'no content type'}`)
      }
      const declared = Number(res.headers.get('content-length'))
      if (declared > opts.maxBytes) {
        await res.body?.cancel()
        throw new FetchImageError('too_large', `${declared} bytes, the limit is ${opts.maxBytes}`)
      }
      const bytes = await readCapped(res, opts.maxBytes)
      const sniffed = sniffImage(bytes)
      if (!sniffed) throw new FetchImageError('unsupported_type', `unsupported image type (${type})`)
      return { bytes, mime: sniffed.mime }
    }
  } catch (err) {
    if (err instanceof FetchImageError) throw err
    const reason = signal.aborted ? 'timed out' : err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)
    throw new FetchImageError('fetch_failed', `could not download ${url}: ${reason}`)
  }
}

function parseHttpUrl(raw: string): URL {
  let u: URL
  try { u = new URL(raw) } catch { throw new FetchImageError('invalid', `not a URL: ${raw}`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchImageError('invalid', `only http and https: ${u.protocol}`)
  if (u.username || u.password) throw new FetchImageError('invalid', 'URLs with credentials are not fetched')
  return u
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      throw new FetchImageError('too_large', `more than ${max} bytes`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.byteLength }
  return out
}
