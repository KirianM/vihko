// A QR code (ISO/IEC 18004) for the second factor's setup: the `otpauth://`
// URI an authenticator app scans. Written here rather than taken from a
// package because what it encodes is the TOTP secret itself: no third-party
// code sees it. Only what that needs: byte mode, error correction level M
// (15%), versions 1 to 40, and the mask with the lowest penalty. The layout
// follows the standard as Project Nayuki's reference implementation reads it.

/** Error correction codewords per block, by version (level M). */
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28]
/** Error correction blocks, by version (level M). */
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49]
/** Level M's two bits in the format information. */
const LEVEL_M = 0

/** A QR code: `size` modules a side, and the dark ones as an SVG path in module units (no quiet zone). */
export interface QrCode {
  size: number
  path: string
}

/** Data modules of a version, all function patterns taken out. */
function rawModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2
    n -= (25 * align - 10) * align - 55
    if (ver >= 7) n -= 36
  }
  return n
}

/** Data codewords (not error correction) a version holds at level M. */
function dataCodewords(ver: number): number {
  return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver]! * BLOCKS[ver]!
}

/** Where the alignment patterns' centres go, on each axis. */
function alignmentPositions(ver: number): number[] {
  if (ver === 1) return []
  const count = Math.floor(ver / 7) + 2
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2
  const out = [6]
  for (let pos = ver * 4 + 10; out.length < count; pos -= step) out.splice(1, 0, pos)
  return out
}

// --- Reed-Solomon over GF(2^8), polynomial 0x11D ------------------------------

function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function rsDivisor(degree: number): number[] {
  const out = new Array<number>(degree).fill(0)
  out[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j]!, root)
      if (j + 1 < degree) out[j] = out[j]! ^ out[j + 1]!
    }
    root = gfMul(root, 0x02)
  }
  return out
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const out = new Array<number>(divisor.length).fill(0)
  for (const b of data) {
    const factor = b ^ out.shift()!
    out.push(0)
    divisor.forEach((coef, i) => { out[i] = out[i]! ^ gfMul(coef, factor) })
  }
  return out
}

// --- Encoding --------------------------------------------------------------------

/** The data codewords: mode, length, the bytes, terminator and padding. */
function codewords(bytes: Uint8Array, ver: number): number[] {
  const bits: number[] = []
  const put = (value: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1) }
  put(0b0100, 4)
  put(bytes.length, ver <= 9 ? 8 : 16)
  for (const b of bytes) put(b, 8)
  const capacity = dataCodewords(ver) * 8
  put(0, Math.min(4, capacity - bits.length))
  put(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8)
  const out: number[] = []
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))
  return out
}

/** Split into blocks, each with its error correction, and interleaved. */
function withErrorCorrection(data: number[], ver: number): number[] {
  const blocks = BLOCKS[ver]!
  const ecc = ECC_PER_BLOCK[ver]!
  const raw = Math.floor(rawModules(ver) / 8)
  const short = blocks - (raw % blocks)
  const shortLen = Math.floor(raw / blocks)
  const divisor = rsDivisor(ecc)
  const parts: { data: number[]; ecc: number[] }[] = []
  for (let i = 0, k = 0; i < blocks; i++) {
    const len = shortLen - ecc + (i < short ? 0 : 1)
    const d = data.slice(k, k + len)
    k += len
    parts.push({ data: d, ecc: rsRemainder(d, divisor) })
  }
  const out: number[] = []
  for (let i = 0; i <= shortLen - ecc; i++) for (const p of parts) if (i < p.data.length) out.push(p.data[i]!)
  for (let i = 0; i < ecc; i++) for (const p of parts) out.push(p.ecc[i]!)
  return out
}

// --- The matrix --------------------------------------------------------------------

class Matrix {
  readonly size: number
  readonly dark: boolean[][]
  readonly fixed: boolean[][]

  constructor(size: number) {
    this.size = size
    this.dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
    this.fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  }

  /** A function module (never masked), at column x, row y. */
  set(x: number, y: number, dark: boolean) {
    this.dark[y]![x] = dark
    this.fixed[y]![x] = true
  }
}

function drawFunctionPatterns(m: Matrix, ver: number) {
  const n = m.size
  for (let i = 0; i < n; i++) {
    m.set(6, i, i % 2 === 0)
    m.set(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || x >= n || y < 0 || y >= n) continue
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        m.set(x, y, d !== 2 && d !== 4)
      }
    }
  }
  const pos = alignmentPositions(ver)
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      // Not over the three finder patterns.
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) m.set(pos[i]! + dx, pos[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }
  drawFormat(m, 0) // reserves the areas; the real bits go in with the mask
  if (ver >= 7) {
    let rem = ver
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (ver << 12) | rem
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1
      const a = n - 11 + (i % 3)
      const b = Math.floor(i / 3)
      m.set(a, b, bit)
      m.set(b, a, bit)
    }
  }
}

function drawFormat(m: Matrix, mask: number) {
  const n = m.size
  const data = (LEVEL_M << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bits = ((data << 10) | rem) ^ 0x5412
  const bit = (i: number) => ((bits >>> i) & 1) === 1
  for (let i = 0; i <= 5; i++) m.set(8, i, bit(i))
  m.set(8, 7, bit(6))
  m.set(8, 8, bit(7))
  m.set(7, 8, bit(8))
  for (let i = 9; i < 15; i++) m.set(14 - i, 8, bit(i))
  for (let i = 0; i < 8; i++) m.set(n - 1 - i, 8, bit(i))
  for (let i = 8; i < 15; i++) m.set(8, n - 15 + i, bit(i))
  m.set(8, n - 8, true)
}

/** The codewords, two columns at a time in a zigzag from the bottom right. */
function drawCodewords(m: Matrix, data: number[]) {
  const n = m.size
  let i = 0
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? n - 1 - vert : vert
        if (!m.fixed[y]![x] && i < data.length * 8) {
          m.dark[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1
          i++
        }
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

function applyMask(m: Matrix, mask: number) {
  const f = MASKS[mask]!
  for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (!m.fixed[y]![x] && f(x, y)) m.dark[y]![x] = !m.dark[y]![x]
}

const FINDER_LIKE = [[1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]]

/** The standard's penalty: long runs, 2×2 blocks, finder-like patterns and an uneven balance of dark and light. */
function penalty(m: Matrix): number {
  const n = m.size
  const at = (x: number, y: number) => m.dark[y]![x]!
  let score = 0
  for (const line of [(i: number, j: number) => at(j, i), (i: number, j: number) => at(i, j)]) {
    for (let i = 0; i < n; i++) {
      let run = 1
      for (let j = 1; j <= n; j++) {
        if (j < n && line(i, j) === line(i, j - 1)) { run++; continue }
        if (run >= 5) score += run - 2
        run = 1
      }
      for (let j = 0; j + 11 <= n; j++) {
        for (const p of FINDER_LIKE) if (p.every((b, k) => line(i, j + k) === (b === 1))) score += 40
      }
    }
  }
  let dark = 0
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (at(x, y)) dark++
      if (x + 1 < n && y + 1 < n && at(x, y) === at(x + 1, y) && at(x, y) === at(x, y + 1) && at(x, y) === at(x + 1, y + 1)) score += 3
    }
  }
  const total = n * n
  return score + (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
}

/** The QR code of `text` (UTF-8), in the smallest version that holds it; null if it doesn't fit in any. */
export function qrCode(text: string): QrCode | null {
  const bytes = new TextEncoder().encode(text)
  let ver = 1
  while (ver <= 40 && 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++
  if (ver > 40) return null
  const all = withErrorCorrection(codewords(bytes, ver), ver)
  const size = ver * 4 + 17
  let best: { m: Matrix; score: number } | null = null
  for (let mask = 0; mask < 8; mask++) {
    const m = new Matrix(size)
    drawFunctionPatterns(m, ver)
    drawCodewords(m, all)
    applyMask(m, mask)
    drawFormat(m, mask)
    const score = penalty(m)
    if (!best || score < best.score) best = { m, score }
  }
  return { size, path: toPath(best!.m) }
}

/** Dark modules as an SVG path: one rectangle per horizontal run. */
function toPath(m: Matrix): string {
  const out: string[] = []
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.dark[y]![x]) continue
      let len = 1
      while (x + len < m.size && m.dark[y]![x + len]) len++
      out.push(`M${x} ${y}h${len}v1h-${len}z`)
      x += len - 1
    }
  }
  return out.join('')
}

/** The modules as rows of booleans (tests). */
export function qrModules(text: string): boolean[][] | null {
  const q = qrCode(text)
  if (!q) return null
  const rows = Array.from({ length: q.size }, () => new Array<boolean>(q.size).fill(false))
  for (const [, x, y, len] of q.path.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
    for (let i = 0; i < Number(len); i++) rows[Number(y)]![Number(x) + i] = true
  }
  return rows
}
