import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseHue, contrast, distinctHue, freeHue, hueDistance, luminance, MIN_HUE_DISTANCE, userColor, type Theme } from '../src/userColor.ts'

const BG: Record<Theme, string> = { light: '#F4F0E6', dark: '#191815' }
const ON_USER: Record<Theme, string> = { light: '#FFFFFF', dark: '#15130F' }

test('every free hue gives an AA color against the initial and is visible against the background, in both themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (let h = 0; h < 360; h += 0.5) {
      const hex = userColor(h, theme)
      assert.match(hex, /^#[0-9a-f]{6}$/)
      const lum = luminance(hex)
      assert.ok(contrast(lum, luminance(ON_USER[theme])) >= 4.5, `${theme} ${h}: ${hex} not AA against the initial`)
      assert.ok(contrast(lum, luminance(BG[theme])) >= 3, `${theme} ${h}: ${hex} not visible enough against the background`)
    }
  }
})

test('the hue is stable, derives from the id, and never falls in the agents\' band', () => {
  assert.equal(baseHue('01JABC'), baseHue('01JABC'))
  const hues = new Set<number>()
  for (let i = 0; i < 2000; i++) {
    const h = baseHue(`usuario-${i}`)
    assert.ok(h >= 0 && h < 360)
    assert.ok(h < 230 || h >= 290, `hue ${h} in the reserved band`)
    hues.add(Math.round(h))
  }
  assert.ok(hues.size > 250, 'they spread across the whole free circle')
})

test('in a note, whoever arrives separates from those present while there is room', () => {
  const far = (h: number, taken: number[]) => Math.min(360, ...taken.map((t) => hueDistance(h, t)))
  const taken: number[] = []
  for (let i = 0; i < 5; i++) {
    const h = distinctHue(`persona-${i}`, taken)
    assert.ok(far(h, taken) >= MIN_HUE_DISTANCE, `person ${i}: ${h} too close`)
    taken.push(h)
  }
  // With many, once there's no room left, the farthest one possible.
  for (let i = 5; i < 12; i++) {
    const h = distinctHue(`persona-${i}`, taken)
    let best = 0
    for (let x = 0; x < 300; x++) best = Math.max(best, far(freeHue(x), taken))
    if (best >= MIN_HUE_DISTANCE) assert.ok(far(h, taken) >= MIN_HUE_DISTANCE, `person ${i}: there was room`)
    else assert.equal(far(h, taken), best, `person ${i}: doesn't pick the farthest`)
    taken.push(h)
  }
  assert.equal(distinctHue('sola', []), baseHue('sola'), 'with no one else, its usual hue')
})
