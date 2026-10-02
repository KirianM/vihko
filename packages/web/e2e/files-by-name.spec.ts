// Obsidian-style names for files that aren't notes: `![[photo.png]]` shows
// the image wherever it is in the note's space, and `[[invoice.pdf]]` (or a
// Markdown link to one next to the note) opens the file in a new tab, which
// the browser shows or downloads. A file's name is never offered as a note
// to create.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { ADMIN, NOTES, freshFolder, inVault, specMother } from './env.ts'
import { png, signIn } from './helpers.ts'

const m = specMother(import.meta.url)
const DIR = inVault(freshFolder(() => m.aFolder()))
const [NOTES_DIR, IMAGES, DOCS] = [m.aFolder(), m.aFolder(), m.aFolder()]
const NOTE = `${DIR}/${NOTES_DIR}/${m.aTitle()}.md`
const [PHOTO, INVOICE, NEXT, GONE] = [`${m.aUniqueWord()}.png`, `${m.aUniqueWord()}.pdf`, `${m.aUniqueWord()}.pdf`, `${m.aUniqueWord()}.pdf`]
const NEXT_TEXT = m.aUniqueWord()

test.describe.configure({ mode: 'serial' })
test.beforeAll(() => {
  for (const d of [NOTES_DIR, IMAGES, DOCS]) mkdirSync(`${NOTES}/${DIR}/${d}`, { recursive: true })
  writeFileSync(`${NOTES}/${DIR}/${IMAGES}/${PHOTO}`, png(120, 40, [30, 74, 134]))
  writeFileSync(`${NOTES}/${DIR}/${DOCS}/${INVOICE}`, `%PDF-1.4\n${m.aSentence()}\n`)
  writeFileSync(`${NOTES}/${DIR}/${NOTES_DIR}/${NEXT}`, `%PDF-1.4\n${m.aSentence()}\n`)
  writeFileSync(`${NOTES}/${NOTE}`, `# ${m.aHeading()}\n\n![[${PHOTO}]]\n\n[[${INVOICE}]] ${m.aWord()} [${NEXT_TEXT}](${NEXT}) ${m.aWord()} [[${GONE}]]\n`)
})
test.afterAll(() => rmSync(`${NOTES}/${DIR}`, { recursive: true, force: true }))

const wiki = (page: Page, text: string) => page.locator('.cm-content .cm-wikilink', { hasText: text })

test('![[photo.png]] shows the image from wherever it is in the space; [[invoice.pdf]] opens the file in a new tab', async ({ browser }) => {
  const k = await signIn(browser, ADMIN, NOTE)
  // The files reach the index on their own (the watcher, or the rescan).
  await expect.poll(async () => (await k.request.get(`/api/file?note=${encodeURIComponent(NOTE)}&name=${encodeURIComponent(PHOTO)}`)).status(), { timeout: 15_000 }).toBe(200)
  await k.goto(`/?note=${encodeURIComponent(NOTE)}`)
  const img = k.locator('.cm-image img')
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(120)

  // The PDF's link leads to the file, not to a note: no «create».
  await expect(wiki(k, INVOICE)).toHaveClass(/cm-wikilink-resolved/)
  await expect(wiki(k, GONE)).toHaveClass(/cm-wikilink-missing/)
  await expect(wiki(k, GONE).getByRole('button')).toHaveCount(0)
  // A new tab asks for the file (headless, the browser keeps a PDF as a download: what matters is what it asked, and got).
  const asked = (path: string) => k.context().waitForEvent('response', (r) => r.url().endsWith(`/api/file?path=${encodeURIComponent(path)}`))
  const opened = asked(`${DIR}/${DOCS}/${INVOICE}`)
  await wiki(k, INVOICE).click()
  const pdf = await opened
  expect([pdf.status(), pdf.headers()['content-type'], pdf.headers()['content-disposition']?.startsWith('inline')]).toEqual([200, 'application/pdf', true])
  await expect(k.locator('.cm-content')).toBeVisible()

  // A Markdown link to a file next to the note opens it too.
  const next = asked(`${DIR}/${NOTES_DIR}/${NEXT}`)
  await k.locator('.cm-content .cm-link', { hasText: NEXT_TEXT }).click()
  expect((await next).status()).toBe(200)

  // The API says so too: the link leads to the file.
  const r = await k.request.get(`/api/note/links?path=${encodeURIComponent(NOTE)}`)
  const link = ((await r.json()) as { outgoing: { raw: string; status: string; file?: boolean }[] }).outgoing.find((l) => l.raw === `[[${INVOICE}]]`)
  expect([link?.status, link?.file]).toEqual(['resolved', true])
  await k.context().close()
})
