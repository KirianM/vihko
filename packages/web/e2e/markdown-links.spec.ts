// Markdown links are followed as wikilinks are (D-019): one to a note opens
// it, an http(s) one opens in a new tab and the app stays, the same in a
// table, and a broken one (or another scheme) takes the click into its text
// to edit it.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { ADMIN, NOTES, SPACE_NAME, freshFolder, inVault, specMother } from './env.ts'
import { signIn } from './helpers.ts'

const m = specMother(import.meta.url)
const DIR = inVault(freshFolder(() => m.aFolder()))
const TITLE = m.aTitle()
const NOTE = `${DIR}/${TITLE}.md`
/** The links' texts: words nothing else on the page has. */
const [TO_NOTE, OUT, IN_TABLE, BROKEN, SCRIPT] = [m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord()]
const EXTERNAL = `https://${m.aHost()}/${m.aWord()}`
/** As the browser asks for it: a word with «ñ» or an accent is percent-encoded. */
const OPENED = new URL(EXTERNAL).href
/** A note that doesn't exist, next to this one. */
const MISSING = `${m.aTitle()}.md`
// Markdown links are relative to the note: hogar/Red.md is testdata/vault's.
const TEXT = `# ${TITLE}

${m.aWord()} [${TO_NOTE}](../hogar/Red.md) ${m.aWord()} [${OUT}](${EXTERNAL}) ${m.aWord()}

[${BROKEN}](${MISSING}) ${m.aWord()} [${SCRIPT}](javascript:void%20document.body.remove%28%29)

| ${m.aWord()} |
|---|
| [${IN_TABLE}](../hogar/Red.md) |
`

test.describe.configure({ mode: 'serial' })
test.beforeAll(() => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  writeFileSync(`${NOTES}/${NOTE}`, TEXT)
})
test.afterAll(() => rmSync(`${NOTES}/${DIR}`, { recursive: true, force: true }))

const link = (page: Page, text: string) => page.locator('.cm-content .cm-link', { hasText: text })
/** Opens the note and waits until its links have resolved (the one to a note shows as such). */
async function openNote(page: Page) {
  await page.goto(`/?note=${encodeURIComponent(NOTE)}`)
  await expect(link(page, TO_NOTE)).toHaveClass(/cm-link-resolved/)
}

test('a Markdown link to a note opens it on click', async ({ browser }) => {
  const k = await signIn(browser, ADMIN, NOTE)
  await openNote(k)
  await link(k, TO_NOTE).click()
  await expect(k.locator('.crumbs')).toHaveText(`${SPACE_NAME} / hogar / Red`)
  await k.context().close()
})

test('an http(s) link opens in a new tab, which gets no hold on the app; the app stays on the note', async ({ browser }) => {
  const k = await signIn(browser, ADMIN, NOTE)
  // Nothing leaves the test machine: the new tab gets its page from here.
  await k.context().route(`${OPENED}**`, (route) => route.fulfill({ contentType: 'text/html', body: '<p>outside</p>' }))
  await openNote(k)
  const opened = k.context().waitForEvent('page')
  await link(k, OUT).click()
  const tab = await opened
  await tab.waitForLoadState()
  expect(tab.url()).toBe(OPENED)
  expect(await tab.evaluate(() => window.opener)).toBeNull()
  await expect(k.locator('.crumbs b')).toHaveText(TITLE)
  expect(new URL(k.url()).searchParams.get('note')).toBe(NOTE)
  await k.context().close()
})

test('a Markdown link in a table is followed the same way', async ({ browser }) => {
  const k = await signIn(browser, ADMIN, NOTE)
  await openNote(k)
  const inTable = k.locator('.cm-table .cm-link', { hasText: IN_TABLE })
  await expect(inTable).toHaveClass(/cm-link-resolved/)
  await inTable.click()
  await expect(k.locator('.crumbs')).toHaveText(`${SPACE_NAME} / hogar / Red`)
  await k.context().close()
})

test('a broken link, or one with another scheme, is not followed: the click goes into its text to edit it', async ({ browser }) => {
  const k = await signIn(browser, ADMIN, NOTE)
  await openNote(k)
  const pages = k.context().pages().length
  for (const [text, dest] of [[BROKEN, MISSING], [SCRIPT, 'javascript:']] as const) {
    await link(k, text).click()
    // Its syntax is revealed around the cursor: the link is text to edit.
    await expect(k.locator('.cm-line', { hasText: `[${text}](${dest}` })).toBeVisible()
    await expect(k.locator('.crumbs b')).toHaveText(TITLE)
    await k.locator('.cm-h1').click()
  }
  await expect(k.locator('.cm-content')).toBeVisible() // the javascript: link ran nothing
  expect(k.context().pages()).toHaveLength(pages)
  await k.context().close()
})
