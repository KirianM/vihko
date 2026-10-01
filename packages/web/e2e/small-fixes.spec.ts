// Small fixes of 0.1.0-rc.3: «End» on a long line with a comment never
// leaves the cursor inside the comment's hidden syntax (what was typed there
// vanished into it), and a phone doesn't bounce a short note.
import { expect, test } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ADMIN, NOTES, inVault, specMother } from './env.ts'
import { signIn } from './helpers.ts'

const m = specMother(import.meta.url)
const DIR = inVault(m.aFolder())
const SLOW = { timeout: 15_000 }

test.beforeAll(() => { mkdirSync(`${NOTES}/${DIR}`, { recursive: true }) })

test('«End» on a long line with a comment at its end: what is typed goes after the comment, never into it', async ({ browser }) => {
  const path = `${DIR}/${m.aTitle()}.md`
  // Long enough to wrap once the comment's syntax shows.
  const line = Array.from({ length: 4 }, () => m.aSentence()).join(' ')
  const comment = `<!-- @${ADMIN.username} 2026-09-01T10:00Z · ${m.aSentence()} ${m.aSentence()} -->`
  writeFileSync(`${NOTES}/${path}`, `---\nuid: ${m.faker.string.ulid({ refDate: '2026-01-01T00:00:00Z' })}\n---\n# ${m.aHeading()}\n\n${line} ${comment}\n`)
  const k = await signIn(browser, ADMIN, path)
  await expect(k.locator('.status')).toHaveText('Guardado en disco', SLOW)
  await k.locator('.cm-line', { hasText: line.slice(0, 20) }).click({ position: { x: 4, y: 8 } })
  await k.keyboard.press('Home')
  const typed = m.aUniqueWord()
  // End, as many times as someone would press it on a line that wraps.
  for (let i = 0; i < 3; i++) await k.keyboard.press('End')
  await k.keyboard.type(` ${typed}`)
  await expect.poll(() => readFileSync(`${NOTES}/${path}`, 'utf8'), SLOW).toContain(typed)
  const text = readFileSync(`${NOTES}/${path}`, 'utf8')
  const start = text.indexOf('<!--')
  const end = text.indexOf('-->')
  const at = text.indexOf(typed)
  expect(at < start || at > end, `typed at ${at}, the comment is ${start}–${end}`).toBe(true)
  expect(text).toContain(comment)
  await k.context().close()
})

test('a phone doesn\'t bounce a short note: the page never scrolls past its ends', async ({ browser }) => {
  const path = `${DIR}/${m.aTitle()}.md`
  writeFileSync(`${NOTES}/${path}`, `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'es-ES' })
  const page = await ctx.newPage()
  await page.goto(`/?note=${encodeURIComponent(path)}`)
  await page.getByLabel('Nombre de usuario').fill(ADMIN.username)
  await page.getByLabel('Contraseña').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Entrar' }).last().tap()
  await expect(page.locator('.cm-content')).toBeVisible()
  const styles = await page.evaluate(() => [document.documentElement, document.body, document.querySelector('.note')!].map((e) => getComputedStyle(e).overscrollBehaviorY))
  expect(styles).toEqual(['none', 'none', 'none'])
  await ctx.close()
})
