// Editor autocomplete and creating notes from broken links: `[[` suggests
// notes (the shortest link that resolves, a path suffix for an ambiguous
// name), `#` after a note its headings, `|` its aliases, `#` in text the tags
// in use; «missing · create» creates the note where the link finds it, also
// from a template. Desktop, dark theme and a phone.
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { markdownDest } from '../../core/src/images.ts'
import { ADMIN, E2E_DIR, NOTES, specMother } from './env.ts'
import { literally, signIn, writeWorkspace } from './helpers.ts'

const m = specMother(import.meta.url)
/** As the suggestions compare: case- and accent-insensitive (editor/suggest.ts). */
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim()
/** The query's letters in `text`, in order: the loosest match the suggestions take. */
const subsequence = (text: string, query: string) => {
  let j = 0
  for (let i = 0; i < text.length && j < query.length; i++) if (text[i] === query[j]) j++
  return j === query.length
}
/** A new title with an accent, so typing it without accents proves they're ignored. */
const accented = () => {
  for (;;) {
    const t = m.aTitle()
    if (fold(t) !== t.toLowerCase()) return t
  }
}

const DIR = m.aFolder()
const TEMPLATES = m.aFolder()
const SOURCE = m.aNotePath(DIR)
const FILE = `${NOTES}/${SOURCE}`
const SHOTS = `${E2E_DIR}/shots`
/** The line of the source note links are typed after. */
const TEXT = m.aSentence()
/** The note links point to: its alias and headings (its title the first), the last one found by typing it (the others can't match it). */
const DEST = accented()
const ALIAS = m.aTitle()
let H2 = m.aHeading()
while (subsequence(fold(DEST), fold(H2))) H2 = m.aHeading()
let H1 = m.aHeading()
while (subsequence(fold(H1), fold(H2)) || fold(H2).includes(fold(H1))) H1 = m.aHeading()
/** Two tags in use, with a common start (found by it), neither inside the other; the suggestions list them in this order (equal score and count). */
const TAG_START = m.aUniqueWord()
const tagPair = (): string[] => {
  const [a, b] = [`${TAG_START}-${m.aTag()}`, `${TAG_START}-${m.aTag()}`]
  return a.includes(b) || b.includes(a) ? tagPair() : [a, b].sort((x, y) => x.localeCompare(y, 'es-ES')) // the page's locale
}
const [TAG_A, TAG_B] = tagPair() as [string, string]
const disk = (path = SOURCE) => (existsSync(`${NOTES}/${path}`) ? readFileSync(`${NOTES}/${path}`, 'utf8') : '')
const noteParam = (page: Page) => new URL(page.url()).searchParams.get('note')

/**
 * The caret at the very end of a line of the editor (which must have the
 * focus). End stops where a long line wraps, and generated text may wrap
 * anywhere: the DOM selection instead, which the editor takes as its own.
 */
async function toLineEnd(line: Locator) {
  await line.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
  })
}

test.describe.configure({ mode: 'serial' })

let k: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(FILE, `# ${m.aHeading()}\n\n${TEXT}\n`)
  writeFileSync(`${NOTES}/${DIR}/${DEST}.md`, `---\naliases: [${ALIAS}]\n---\n# ${DEST}\n\n## ${H1}\n\n## ${H2}\n`)
  writeFileSync(`${NOTES}/${m.aNotePath(DIR)}`, `# ${m.aHeading()}\n\n#${TAG_A} y #${TAG_B}\n`)
  k = await signIn(browser, ADMIN)
  // Wait for the indexer to see the new notes.
  await expect.poll(async () => {
    const { notes } = await (await k.request.get('/api/tree')).json() as { notes: { path: string }[] }
    return notes.filter((n) => n.path.startsWith(`${DIR}/`)).length
  }).toBe(3)
  await k.goto(`/?note=${encodeURIComponent(SOURCE)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
})

// Created notes go through thoth's trash (some were open in an editor), then the folders go.
test.afterAll(async () => {
  writeWorkspace()
  const { notes } = await (await k.request.get('/api/tree')).json() as { notes: { path: string }[] }
  for (const n of notes) {
    if (n.path.startsWith(`${DIR}/`) || n.path.startsWith(`${TEMPLATES}/`)) await k.request.delete(`/api/note?path=${encodeURIComponent(n.path)}`)
  }
  await k.context().close()
  for (const d of [DIR, TEMPLATES]) rmSync(`${NOTES}/${d}`, { recursive: true, force: true })
})

const list = (page: Page) => page.locator('.thoth-complete')
const option = (page: Page, text: string | RegExp) => list(page).getByRole('option', { name: text })
/** An option's text starts with this (a note's is its title, then where it is). */
const starts = (text: string) => new RegExp(`^${literally(text)}`, 'u')

/**
 * Accepts the selected suggestion with a key. CodeMirror ignores it for a few
 * milliseconds after the list changes (so a fast ↵ isn't taken by a list that
 * just appeared): the list must have settled on what's expected first.
 */
async function accept(page: Page, expected: string | RegExp, key = 'Enter') {
  await expect(list(page).getByRole('option', { selected: true })).toHaveText(expected)
  await page.waitForTimeout(150)
  await page.keyboard.press(key)
}

/**
 * Puts the cursor at the end of the TEXT line and types there. Clicked at
 * its left edge: further right there are links, and a click on one navigates.
 */
async function typeAtEnd(page: Page, text: string) {
  const line = page.locator('.cm-line', { hasText: TEXT })
  await line.click({ position: { x: 2, y: 8 } })
  await toLineEnd(line)
  await page.keyboard.type(text)
}

test('[[ suggests notes by title, accent-insensitive; ↵ inserts the link and closes it', async () => {
  await typeAtEnd(k, ` [[${fold(DEST)}`)
  await accept(k, starts(DEST))
  await expect(list(k)).toHaveCount(0)
  await expect.poll(() => disk()).toContain(`${TEXT} [[${DEST}]]`)
})

// The vault's own notes named Plan (testdata/vault): an integration with its ambiguity.
test('an ambiguous name is inserted with the path suffix that makes it resolve', async () => {
  await typeAtEnd(k, ' [[plan')
  const blog = option(k, /proyectos \/ blog/)
  await expect(blog).toBeVisible()
  await expect(option(k, /proyectos \/ thoth/)).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/autocomplete-notes-light.png`, animations: 'disabled' })
  await blog.click()
  await expect.poll(() => disk()).toContain(`[[${DEST}]] [[blog/Plan]]`)
  // From here, the plain name is the root Plan.md: choosing it inserts just «Plan».
  await k.keyboard.type(' [[Plan gen')
  await accept(k, /^Plan general/)
  await expect.poll(() => disk()).toContain('[[blog/Plan]] [[Plan]]')
})

test('[[note# suggests its headings; [[note| its title and aliases', async () => {
  await typeAtEnd(k, ` [[${DEST}#`)
  await expect(option(k, H1)).toBeVisible()
  await expect(option(k, H2)).toBeVisible()
  await k.keyboard.type(fold(H2))
  await expect(list(k).getByRole('option')).toHaveCount(1)
  await accept(k, starts(H2))
  await expect.poll(() => disk()).toContain(`[[${DEST}#${H2}]]`)

  await k.keyboard.type(` [[${DEST}|`)
  await expect(option(k, ALIAS)).toBeVisible()
  await option(k, ALIAS).click()
  await expect.poll(() => disk()).toContain(`[[${DEST}|${ALIAS}]]`)
})

test('an alias finds the note and becomes the visible text', async () => {
  await typeAtEnd(k, ` [[${fold(ALIAS)}`)
  await accept(k, starts(ALIAS), 'Tab')
  await expect.poll(() => disk()).toContain(` [[${DEST}|${ALIAS}]]\n`)
})

test('# suggests tags in use with their counts; never inside code or for a heading', async () => {
  await typeAtEnd(k, ` #${TAG_START}`)
  await expect(option(k, `#${TAG_A}`)).toContainText('1 nota')
  await expect(option(k, `#${TAG_B}`)).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/autocomplete-tags-light.png`, animations: 'disabled' })
  await k.waitForTimeout(150)
  await k.keyboard.press('ArrowDown')
  await accept(k, starts(`#${TAG_B}`))
  await expect.poll(() => disk()).toContain(` #${TAG_B}\n`)
  // A complete tag suggests nothing: ↵ is a new line.
  await k.keyboard.type(` #${TAG_A}`)
  await expect(list(k)).toHaveCount(0)
  await k.keyboard.press('Enter')
  await k.keyboard.type(`\`#${TAG_START}`)
  await expect(list(k)).toHaveCount(0)
  await k.keyboard.type('`\n#')
  await expect(list(k)).toHaveCount(0)
  const heading = m.aHeading()
  await k.keyboard.type(` ${heading}`)
  await expect.poll(() => disk()).toContain(`#${TAG_A}\n\`#${TAG_START}\`\n# ${heading}`)
})

test('a broken link offers to create the note in this folder; the link then resolves', async () => {
  const missing = m.aTitle()
  const missingMd = m.aTitle()
  await k.keyboard.press('Enter')
  await k.keyboard.type(`${m.aWord()}: [[${missing}]] y [md](${markdownDest(missingMd)}.md).`)
  await k.locator('.cm-h1').first().click()
  const broken = k.locator('.cm-wikilink-missing', { hasText: missing })
  await expect(broken.locator('.cm-wikilink-badge')).toHaveText('no existe · crear')
  await expect(broken.getByRole('button', { name: 'crear' })).toHaveAttribute('title', `Crear «${missing}» en ${DIR}`)
  await k.screenshot({ path: `${SHOTS}/create-link-light.png`, animations: 'disabled' })
  await broken.getByRole('button', { name: 'crear' }).click()

  await expect.poll(() => noteParam(k)).toBe(`${DIR}/${missing}.md`)
  await expect(k.locator('.cm-h1')).toHaveText(missing)
  // Just the title (opening it adds the uid to the frontmatter).
  expect(disk(`${DIR}/${missing}.md`)).toMatch(new RegExp(`(^|---\\n)# ${literally(missing)}\\n$`, 'u'))
  // The tree knows it too.
  await expect(k.getByRole('row', { name: missing, exact: true })).toBeVisible()

  await k.goBack().catch(() => {})
  await k.goto(`/?note=${encodeURIComponent(SOURCE)}`)
  await expect(k.locator('.cm-wikilink-resolved', { hasText: missing })).toBeVisible()
  const links = await (await k.request.get(`/api/note/links?path=${encodeURIComponent(SOURCE)}`)).json() as { outgoing: { raw: string; status: string; dst_path: string }[] }
  expect(links.outgoing.find((l) => l.raw === `[[${missing}]]`)).toMatchObject({ status: 'resolved', dst_path: `${DIR}/${missing}.md` })

  // A Markdown link to a missing .md: created where it points.
  const md = k.locator('.cm-wikilink-missing').filter({ has: k.getByRole('button', { name: 'crear' }) })
  await expect(md).toHaveCount(1)
  await md.getByRole('button', { name: 'crear' }).click()
  await expect.poll(() => noteParam(k)).toBe(`${DIR}/${missingMd}.md`)
  expect(disk(`${DIR}/${missingMd}.md`)).toMatch(new RegExp(`(^|---\\n)# ${literally(missingMd)}\\n$`, 'u'))
})

test('never overwrites: if the note appeared meanwhile and the link leads there, it opens it', async () => {
  const late = m.aTitle()
  const theirs = m.aSentence()
  await k.goto(`/?note=${encodeURIComponent(SOURCE)}`)
  await typeAtEnd(k, ` [[${late}]]`)
  await k.locator('.cm-h1').first().click()
  const broken = k.locator('.cm-wikilink-missing', { hasText: late })
  await expect(broken.getByRole('button', { name: 'crear' })).toBeVisible()
  // Someone else creates it first, with other text.
  expect((await k.request.post('/api/note', { data: { path: `${DIR}/${late}.md`, text: `# ${late}\n\n${theirs}\n` } })).status()).toBe(201)
  await broken.getByRole('button', { name: 'crear' }).click()
  await expect.poll(() => noteParam(k)).toBe(`${DIR}/${late}.md`)
  expect(disk(`${DIR}/${late}.md`)).toMatch(new RegExp(`(^|---\\n)# ${literally(late)}\\n\\n${literally(theirs)}\\n$`, 'u'))
})

test('with templates configured, «create» asks which one', async () => {
  const template = m.aTitle()
  const line = m.aSentence()
  const fresh = m.aTitle()
  mkdirSync(`${NOTES}/${TEMPLATES}`, { recursive: true })
  writeFileSync(`${NOTES}/${TEMPLATES}/${template}.md`, `# {{title}}\n\n${line}\n`)
  writeWorkspace(`templates: ${JSON.stringify(TEMPLATES)}\n`)
  await expect.poll(async () => (await (await k.request.get('/api/workspace')).json() as { templates: string | null }).templates).toBe(TEMPLATES)
  await expect.poll(async () => {
    const { notes } = await (await k.request.get('/api/tree')).json() as { notes: { path: string }[] }
    return notes.some((n) => n.path === `${TEMPLATES}/${template}.md`)
  }).toBe(true)
  await k.goto(`/?note=${encodeURIComponent(SOURCE)}`)
  await typeAtEnd(k, ` [[${fresh}]]`)
  await k.locator('.cm-h1').first().click()
  const create = k.locator('.cm-wikilink-missing', { hasText: fresh }).getByRole('button', { name: 'crear' })
  const menu = k.getByRole('menu')
  // Dark first (the theme button would close the menu), then light, where it's used.
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await create.click()
  await expect(menu).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/create-link-template-dark.png`, animations: 'disabled' })
  await k.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
  await create.click()
  await expect(menu).toContainText(`Crear «${fresh}» en ${DIR}`)
  await expect(menu.getByRole('menuitem', { name: 'Nota en blanco' })).toBeFocused()
  await k.screenshot({ path: `${SHOTS}/create-link-template-light.png`, animations: 'disabled' })
  await menu.getByRole('menuitem', { name: template }).click()
  await expect.poll(() => noteParam(k)).toBe(`${DIR}/${fresh}.md`)
  await expect.poll(() => disk(`${DIR}/${fresh}.md`)).toMatch(new RegExp(`(^|---\\n)# ${literally(fresh)}\\n\\n${literally(line)}\\n$`, 'u'))
  writeWorkspace()
})

test('with links.aliases off in thoth.yaml, [[alias]] is broken and an alias is inserted as [[Note|alias]]', async () => {
  const NOTE = m.aNotePath(DIR)
  const lead = m.aUniqueWord()
  const status = async () => {
    const links = await (await k.request.get(`/api/note/links?path=${encodeURIComponent(NOTE)}`)).json() as { outgoing: { raw: string; status: string }[] }
    return links.outgoing.find((l) => l.raw === `[[${ALIAS}]]`)?.status
  }
  writeFileSync(`${NOTES}/${NOTE}`, `# ${m.aHeading()}\n\n${lead} [[${ALIAS}]].\n`)
  await expect.poll(status).toBe('resolved')

  writeWorkspace('links:\n  aliases: false\n')
  await expect.poll(async () => (await (await k.request.get('/api/workspace')).json() as { links: { aliases: boolean } }).links.aliases).toBe(false)
  await expect.poll(status).toBe('missing')
  await k.goto(`/?note=${encodeURIComponent(NOTE)}`)
  await expect(k.locator('.cm-wikilink-missing', { hasText: ALIAS })).toBeVisible()

  // Still suggested by its alias, inserted so it resolves by name.
  const line = k.locator('.cm-line', { hasText: lead })
  await line.click({ position: { x: 2, y: 8 } })
  await toLineEnd(line)
  await k.keyboard.type(` [[${fold(ALIAS)}`)
  await accept(k, starts(ALIAS))
  await expect.poll(() => disk(NOTE)).toContain(`[[${ALIAS}]]. [[${DEST}|${ALIAS}]]`)
  await k.locator('.cm-h1').first().click()
  await expect(k.locator('.cm-wikilink-resolved', { hasText: ALIAS })).toHaveCount(1)
  await k.screenshot({ path: `${SHOTS}/aliases-off-light.png`, animations: 'disabled' })

  // Back on: the alias resolves again, without touching the note.
  writeWorkspace()
  await expect.poll(status).toBe('resolved')
})

test('dark theme: the suggestion list', async () => {
  await k.goto(`/?note=${encodeURIComponent(SOURCE)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  const theme = k.getByRole('button', { name: /Cambiar a tema/ })
  if (await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).count()) await theme.click()
  await typeAtEnd(k, ` [[${fold(DEST).slice(0, 1)}`)
  await expect(list(k)).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/autocomplete-notes-dark.png`, animations: 'disabled' })
  await k.keyboard.press('Escape')
  await expect(list(k)).toHaveCount(0)
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
})

test('phone: the editor bar\'s [[ opens the suggestions and a tap inserts the link', async ({ browser }: { browser: Browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'es-ES', storageState: await k.context().storageState() })
  const page = await ctx.newPage()
  await page.goto(`/?note=${encodeURIComponent(SOURCE)}`)
  await expect(page.locator('.cm-content')).toBeVisible()
  // At the end of the note, on a line of its own (lines wrap on a phone: End would stop mid-paragraph).
  const word = m.aUniqueWord()
  await page.locator('.cm-h1').first().tap()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(`${word} `)
  await page.getByRole('toolbar', { name: 'Formato' }).getByRole('button', { name: 'Enlazar nota' }).tap()
  await expect(list(page)).toBeVisible()
  await page.keyboard.type(fold(DEST))
  const opt = option(page, starts(DEST))
  await expect(list(page).getByRole('option', { selected: true })).toHaveText(starts(DEST))
  const box = await list(page).boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  expect((await opt.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await page.screenshot({ path: `${SHOTS}/autocomplete-mobile.png`, animations: 'disabled' })
  await opt.tap()
  await expect.poll(() => disk()).toMatch(new RegExp(`\\n${literally(word)} \\[\\[${literally(DEST)}\\]\\]\\n?$`, 'u'))
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await ctx.close()
})
