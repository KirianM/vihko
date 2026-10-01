// People's hues, for presence in a note: one per person, generated from their id,
// never in the band reserved for agents (the accent), and separated from
// the hues of whoever else is in the note. The web paints them per theme
// (web/src/userColor.ts); the hub checks the hue a connection announces,
// so no client passes itself off as someone else. No DOM: shared by both.

/** Band reserved for agents (accent hue #1E4A86 ≈ 258°). */
const RESERVED_FROM = 230
const RESERVED_TO = 290
const FREE = 360 - (RESERVED_TO - RESERVED_FROM)

/** Minimum distance between hues of people present in the same note. */
export const MIN_HUE_DISTANCE = 40

/** 32-bit FNV-1a: stable across browsers and versions. */
function fnv1a(s: string) {
  let h = 0x811c9dc5
  for (const ch of new TextEncoder().encode(s)) {
    h ^= ch
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Maps any hue into the free zone (outside the agents' band). */
export function freeHue(h: number) {
  const x = ((h % FREE) + FREE) % FREE
  return (RESERVED_TO + x) % 360
}

export function baseHue(key: string) {
  return freeHue(fnv1a(key) % FREE)
}

export function hueDistance(a: number, b: number) {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/**
 * Hue for `key` that separates from the ones already present: the closest to its
 * usual hue that still respects the minimum distance; if there's no room left,
 * the farthest one.
 */
export function distinctHue(key: string, taken: number[]) {
  const base = baseHue(key)
  const far = (h: number) => (taken.length ? Math.min(...taken.map((t) => hueDistance(h, t))) : 360)
  if (far(base) >= MIN_HUE_DISTANCE) return base
  let best = base
  let bestShift = Infinity
  let fallback = base
  let fallbackDist = -1
  for (let x = 0; x < FREE; x++) {
    const h = freeHue(x)
    const d = far(h)
    if (d >= MIN_HUE_DISTANCE) {
      const shift = hueDistance(h, base)
      if (shift < bestShift) { best = h; bestShift = shift }
    } else if (d > fallbackDist) {
      fallback = h
      fallbackDist = d
    }
  }
  return bestShift < Infinity ? best : fallback
}

/** Whether a hue can be a person's: a number in [0, 360) outside the agents' band. */
export function isPersonHue(h: unknown): h is number {
  return typeof h === 'number' && Number.isFinite(h) && h >= 0 && h < 360 && !(h >= RESERVED_FROM && h < RESERVED_TO)
}
