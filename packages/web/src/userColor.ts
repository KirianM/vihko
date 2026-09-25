// Color de cada persona: generado, sin paleta fija ni límite de usuarios.
//
// - El tono sale de un hash del id del usuario, en OKLCH (tonos distintos se
//   perciben igual de claros, cosa que HSL no garantiza).
// - Se salta la franja del lapislázuli (accent): en thoth ese color es de los
//   agentes, y una persona no debe confundirse con uno.
// - La luminosidad se ajusta por tema hasta cumplir AA (4,5:1) con la inicial del
//   avatar (token on-user), lo que además lo hace visible sobre el fondo.
// - En una nota, si dos personas caen en tonos cercanos, quien llega después
//   desplaza el suyo (distinctHue).
//
// Por la red viaja el tono; cada navegador lo pinta con su tema.
// Sin dependencias del DOM: se prueba en Node.

export type Theme = 'light' | 'dark'

/** Franja reservada a los agentes (tono del accent #1E4A86 ≈ 258°). */
const RESERVED_FROM = 230
const RESERVED_TO = 290
const FREE = 360 - (RESERVED_TO - RESERVED_FROM)

/** Distancia mínima entre tonos de personas presentes en la misma nota. */
export const MIN_HUE_DISTANCE = 40

/** Texto sobre el color (token on-user), en sRGB lineal → luminancia relativa. */
const ON_USER: Record<Theme, number> = { light: 1, dark: luminance('#15130F') }
const START: Record<Theme, { l: number; c: number }> = { light: { l: 0.55, c: 0.13 }, dark: { l: 0.74, c: 0.12 } }

/** FNV-1a de 32 bits: estable entre navegadores y versiones. */
function fnv1a(s: string) {
  let h = 0x811c9dc5
  for (const ch of new TextEncoder().encode(s)) {
    h ^= ch
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Lleva un tono cualquiera a la zona libre (fuera de la franja de los agentes). */
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
 * Tono para `key` que se separe de los ya presentes: el más cercano a su tono de
 * siempre que respete la distancia mínima; si no cabe nadie más, el más alejado.
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

/** Color hex de un tono en un tema: dentro de sRGB y con AA frente a la inicial. */
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
