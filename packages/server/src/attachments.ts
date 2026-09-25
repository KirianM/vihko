// Images stored in the notes folder (D-028): which types are accepted and
// where a new one goes and what it is called.
import { posix } from 'node:path'

/** Types thoth stores, detected from the bytes (never from the name or the declared type). */
const STORED: { mime: string; ext: string; test: (b: Uint8Array) => boolean }[] = [
  { mime: 'image/png', ext: 'png', test: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  { mime: 'image/gif', ext: 'gif', test: (b) => ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a' },
  { mime: 'image/webp', ext: 'webp', test: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
  { mime: 'image/avif', ext: 'avif', test: isAvif },
]
// SVG is not stored: it is a document that can carry scripts.

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
