// Generates the app icons (public/icons/*.png) from the logo mark in
// public/favicon.svg, with the colours from the design tokens. The PNGs are
// committed; run this again only if the mark or the colours change. It needs a
// browser to rasterise the SVG, the same one as the e2e tests (see
// CONTRIBUTING.md for running it in the Playwright image):
//
//   node scripts/icons.ts
import { chromium } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'

const here = (p: string) => new URL(`../${p}`, import.meta.url)
const tokens = JSON.parse(readFileSync(here('src/theme/tokens.json'), 'utf8')) as {
  color: { tokens: { name: string; value: string | Record<string, string> }[] }
}
const color = (name: string) => (tokens.color.tokens.find((t) => t.name === name)!.value as Record<string, string>).light!
const bg = color('bg')
const accent = color('accent')
// The mark's shapes (the same as Mark in src/ui.tsx), without the favicon's colour.
const shapes = readFileSync(here('public/favicon.svg'), 'utf8').match(/<svg[^>]*>([\s\S]*)<\/svg>/)![1]!

/**
 * @param mark share of the side taken by the mark (maskable icons keep it inside the central safe circle)
 * @param radius corner radius as a share of the side (0: full bleed, the platform applies its own shape)
 */
const svg = (size: number, mark: number, radius: number) => {
  const m = size * mark
  const o = (size - m) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${size * radius}" fill="${bg}"/>
  <svg x="${o}" y="${o}" width="${m}" height="${m}" viewBox="0 0 24 24" fill="none" stroke="${accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shapes}</svg>
</svg>`
}

const icons = [
  { file: 'icon-192.png', size: 192, mark: 0.62, radius: 0.22 },
  { file: 'icon-512.png', size: 512, mark: 0.62, radius: 0.22 },
  { file: 'icon-maskable-512.png', size: 512, mark: 0.5, radius: 0 },
  // iOS rounds the corners itself and turns transparency black: full bleed.
  { file: 'apple-touch-icon.png', size: 180, mark: 0.6, radius: 0 },
]

mkdirSync(here('public/icons'), { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage()
for (const i of icons) {
  await page.setViewportSize({ width: i.size, height: i.size })
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(i.size, i.mark, i.radius)}</body></html>`)
  await page.locator('body > svg').screenshot({ path: new URL(`public/icons/${i.file}`, here('')).pathname, omitBackground: true })
  console.log(i.file)
}
await browser.close()
