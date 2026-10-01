// Text in both themes. Light text on a dark ground looks heavier than the
// same weight dark on light, so in dark bold hardly stood out from the text
// around it. Weights never change with the theme (they change the glyphs'
// widths, and a note must wrap the same in light and dark): dark sets its
// text a step dimmer (ink) and bold and headings at the brightest text
// (ink-strong), both from the tokens; light keeps them the same colour.
// Screenshots of a note with every inline style, in both themes, on a
// desktop (at 1× and 2×) and on a phone, with a close-up of the mixed paragraph.
import { expect, test, type Browser, type BrowserContextOptions, type Locator, type Page } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, NOTES, freshFolder, inVault, specMother } from './env.ts'
import { signIn } from './helpers.ts'

const m = specMother(import.meta.url)
const DIR = inVault(freshFolder(() => m.aFolder()))
const NOTE = `${DIR}/${m.aTitle()}.md`
const SHOTS = `${E2E_DIR}/shots`
/** The words of each inline style: nothing else in the note has them. */
const [BOLD, ITALIC, BOTH, CODE, STRUCK, LINK, COMMENTED] = Array.from({ length: 7 }, () => m.aUniqueWord())
const stamp = new Date(Date.now() - 3_600_000).toISOString().slice(0, 16) + 'Z'
const TEXT = `# ${m.aHeading()}

${m.aSentence()} **${BOLD} ${m.aWord()}** ${m.aSentence()} *${ITALIC} ${m.aWord()}* ${m.aSentence()} ***${BOTH}*** ${m.aSentence()} \`${CODE}\` ~~${STRUCK}~~ [${LINK}](https://${m.aHost()}/) ${m.aSentence()}

## ${m.aHeading()}

${m.aParagraph()} ${COMMENTED} ${m.aSentence()}<!-- @${ADMIN.username} ${stamp} · ${m.aComment()} -->

### ${m.aHeading()}

| ${m.aWord()} | ${m.aWord()} |
| --- | --- |
| ${m.aWord()} **${m.aWord()}** | ${m.aSentence()} |
| *${m.aWord()}* | \`${m.aWord()}\` |

> ${m.aSentence()} **${m.aWord()}** ${m.aSentence()}

${m.aParagraph()}
`

const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }
const DESKTOP_1X: BrowserContextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }

test.describe.configure({ mode: 'serial' })
let k: Page
test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(`${NOTES}/${NOTE}`, TEXT)
  k = await signIn(browser, ADMIN, NOTE)
})
test.afterAll(async () => {
  await k.context().close()
  rmSync(`${NOTES}/${DIR}`, { recursive: true, force: true })
})

/** The paragraph with every inline style, its bold, and the note's first heading. */
const mixed = (p: Page) => p.locator('.cm-line', { hasText: BOLD })
const bold = (p: Page) => mixed(p).locator('.tok-strong', { hasText: BOLD })
const heading = (p: Page) => p.locator('.cm-h1').first()

/** The note open in a browser of its own (the admin's session), with the OS in `scheme`. */
async function open(browser: Browser, scheme: 'light' | 'dark', device: BrowserContextOptions): Promise<Page> {
  const ctx = await browser.newContext({ ...device, colorScheme: scheme, locale: 'es-ES', storageState: await k.context().storageState() })
  const page = await ctx.newPage()
  await page.goto(`/?note=${encodeURIComponent(NOTE)}`)
  await expect(bold(page)).toBeVisible()
  await expect(page.locator('.cm-commented')).toBeVisible()
  // The fonts, not a fallback, in the pictures and the measures.
  await page.evaluate(() => document.fonts.ready)
  return page
}

for (const scheme of ['light', 'dark'] as const) {
  test(`${scheme}: the note on a desktop and on a phone, and a close-up of the mixed paragraph`, async ({ browser }) => {
    for (const [device, options] of [['desktop', DESKTOP], ['desktop-1x', DESKTOP_1X], ['phone', PHONE]] as const) {
      const page = await open(browser, scheme, options)
      await page.screenshot({ path: `${SHOTS}/typography-${device}-${scheme}.png`, animations: 'disabled' })
      await mixed(page).screenshot({ path: `${SHOTS}/typography-${device}-${scheme}-paragraph.png`, animations: 'disabled' })
      await page.context().close()
    }
  })
}

/** Everything that decides how the note wraps and how its text looks, in one theme. */
async function measure(page: Page) {
  const style = (l: Locator) => l.evaluate((e) => {
    const s = getComputedStyle(e)
    return { weight: s.fontWeight, color: s.color }
  })
  const box = async (l: Locator) => {
    const b = (await l.boundingBox())!
    return { width: b.width, height: b.height }
  }
  const [text, strong, h1] = await Promise.all([style(mixed(page)), style(bold(page)), style(heading(page))])
  return {
    weights: { text: text.weight, bold: strong.weight, heading: h1.weight },
    colors: { text: text.color, bold: strong.color, heading: h1.color },
    ground: await page.locator('body').evaluate((e) => getComputedStyle(e).backgroundColor),
    boxes: { paragraph: await box(mixed(page)), bold: await box(bold(page)), heading: await box(heading(page)) },
  }
}

/** WCAG relative luminance of a computed `rgb(r, g, b)`. */
function luminance(rgb: string): number {
  const [r, g, b] = rgb.match(/\d+(\.\d+)?/g)!.slice(0, 3).map((c) => {
    const v = Number(c) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

test('the same weights and metrics in light and dark; in dark bold and headings are brighter than the text, all readable', async ({ browser }) => {
  const page = await open(browser, 'light', DESKTOP)
  const light = await measure(page)
  // Dark chosen in vihko while the OS is light: the same as dark from the OS.
  await page.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const chosen = await measure(page)
  await page.context().close()
  const dark = await open(browser, 'dark', DESKTOP)
  const fromOs = await measure(dark)
  await dark.context().close()

  expect(chosen).toEqual(fromOs)
  // Nothing a theme sets changes how a note wraps.
  expect(fromOs.weights).toEqual(light.weights)
  expect(fromOs.boxes).toEqual(light.boxes)

  // Light as it was: bold and headings in the text's colour.
  expect(light.colors.bold).toBe(light.colors.text)
  expect(light.colors.heading).toBe(light.colors.text)
  // Dark: bold and headings stand out by brightness.
  expect(luminance(fromOs.colors.bold)).toBeGreaterThan(luminance(fromOs.colors.text))
  expect(fromOs.colors.heading).toBe(fromOs.colors.bold)
  // Text readable on the ground in both (WCAG AA for body text).
  for (const theme of [light, fromOs]) expect(contrast(theme.colors.text, theme.ground)).toBeGreaterThanOrEqual(4.5)
})
