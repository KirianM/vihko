import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseHue, contrast, distinctHue, freeHue, hueDistance, luminance, MIN_HUE_DISTANCE, userColor, type Theme } from '../src/userColor.ts'

const BG: Record<Theme, string> = { light: '#F4F0E6', dark: '#191815' }
const ON_USER: Record<Theme, string> = { light: '#FFFFFF', dark: '#15130F' }

test('todo tono libre da un color AA con la inicial y visible sobre el fondo, en los dos temas', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (let h = 0; h < 360; h += 0.5) {
      const hex = userColor(h, theme)
      assert.match(hex, /^#[0-9a-f]{6}$/)
      const lum = luminance(hex)
      assert.ok(contrast(lum, luminance(ON_USER[theme])) >= 4.5, `${theme} ${h}: ${hex} sin AA con la inicial`)
      assert.ok(contrast(lum, luminance(BG[theme])) >= 3, `${theme} ${h}: ${hex} poco visible sobre el fondo`)
    }
  }
})

test('el tono es estable, sale del id y nunca cae en la franja de los agentes', () => {
  assert.equal(baseHue('01JABC'), baseHue('01JABC'))
  const hues = new Set<number>()
  for (let i = 0; i < 2000; i++) {
    const h = baseHue(`usuario-${i}`)
    assert.ok(h >= 0 && h < 360)
    assert.ok(h < 230 || h >= 290, `tono ${h} en la franja reservada`)
    hues.add(Math.round(h))
  }
  assert.ok(hues.size > 250, 'se reparten por todo el círculo libre')
})

test('en una nota, quien llega se separa de los presentes mientras quepa', () => {
  const far = (h: number, taken: number[]) => Math.min(360, ...taken.map((t) => hueDistance(h, t)))
  const taken: number[] = []
  for (let i = 0; i < 5; i++) {
    const h = distinctHue(`persona-${i}`, taken)
    assert.ok(far(h, taken) >= MIN_HUE_DISTANCE, `persona ${i}: ${h} demasiado cerca`)
    taken.push(h)
  }
  // Con muchos, cuando ya no hay hueco, el más alejado posible.
  for (let i = 5; i < 12; i++) {
    const h = distinctHue(`persona-${i}`, taken)
    let best = 0
    for (let x = 0; x < 300; x++) best = Math.max(best, far(freeHue(x), taken))
    if (best >= MIN_HUE_DISTANCE) assert.ok(far(h, taken) >= MIN_HUE_DISTANCE, `persona ${i}: había hueco`)
    else assert.equal(far(h, taken), best, `persona ${i}: no elige el más alejado`)
    taken.push(h)
  }
  assert.equal(distinctHue('sola', []), baseHue('sola'), 'sin nadie más, su tono de siempre')
})
