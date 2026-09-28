// Each person's color: generated, with no fixed palette or user limit.
//
// - The hue comes from a hash of the user's id, in OKLCH (different hues are
//   perceived as equally light, which HSL doesn't guarantee).
// - It skips the lapis lazuli band (accent): in vihko that color belongs to
//   agents, and a person shouldn't be mistaken for one.
// - Lightness is adjusted per theme until it meets AA (4.5:1) against the
//   avatar's initial (on-user token), which also makes it visible against the
//   background.
// - In a note, if two people land on close hues, whoever arrives later shifts
//   theirs (distinctHue).
//
// Only the hue travels over the network; each browser paints it with its own
// theme.
// No DOM dependencies: tested in Node.

export type Theme = 'light' | 'dark'

// The hues themselves (a person's, distinct from others', never in the
// agents' band) are core's (hue.ts): the hub signs presence with them too.
export { MIN_HUE_DISTANCE, baseHue, distinctHue, freeHue, hueDistance } from '@vihko/core/hue'

/** Text over the color (on-user token), in linear sRGB → relative luminance. */
const ON_USER: Record<Theme, number> = { light: 1, dark: luminance('#15130F') }
const START: Record<Theme, { l: number; c: number }> = { light: { l: 0.55, c: 0.13 }, dark: { l: 0.74, c: 0.12 } }

// --- OKLCH → sRGB ---------------------------------------------------------------

function oklchToLinear(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
}

const inGamut = (rgb: number[]) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4)
const encode = (v: number) => {
  const x = Math.min(1, Math.max(0, v))
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055
}
function decode(v: number) {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function toHex(rgb: number[]) {
  return '#' + rgb.map((v) => Math.round(encode(v) * 255).toString(16).padStart(2, '0')).join('')
}

export function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => decode(v / 255))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

export function contrast(a: number, b: number) {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const cache = new Map<string, string>()

/** Hex color for a hue in a theme: within sRGB and AA-compliant against the initial. */
export function userColor(hue: number, theme: Theme): string {
  const key = `${theme}:${Math.round(hue * 10)}`
  const hit = cache.get(key)
  if (hit) return hit
  let { l, c } = START[theme]
  const step = theme === 'light' ? -0.01 : 0.01
  let hex = '#000000'
  for (let i = 0; i < 60; i++) {
    let rgb = oklchToLinear(l, c, hue)
    let cc = c
    while (!inGamut(rgb) && cc > 0.01) { cc -= 0.005; rgb = oklchToLinear(l, cc, hue) }
    hex = toHex(rgb)
    if (contrast(luminance(hex), ON_USER[theme]) >= 4.5) break
    l += step
  }
  cache.set(key, hex)
  return hex
}
