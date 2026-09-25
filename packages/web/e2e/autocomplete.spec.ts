// Editor autocomplete and creating notes from broken links: `[[` suggests
// notes (the shortest link that resolves, a path suffix for an ambiguous
// name), `#` after a note its headings, `|` its aliases, `#` in text the tags
// in use; «missing · create» creates the note where the link finds it, also
// from a template. Desktop, dark theme and a phone.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { E2E_DIR, NOTES } from './env.ts'
import { signIn } from './helpers.ts'

const DIR = 'e2e-ac'
const TEMPLATES = 'e2e-ac-plantillas'
const SOURCE = `${DIR}/Origen.md`
const FILE = `${NOTES}/${SOURCE}`
const SHOTS = `${E2E_DIR}/shots`
const disk = (path = SOURCE) => (existsSync(`${NOTES}/${path}`) ? readFileSync(`${NOTES}/${path}`, 'utf8') : '')

test.describe.configure({ mode: 'serial' })

let k: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(FILE, '# Origen\n\nTexto.\n')
  writeFileSync(`${NOTES}/${DIR}/Destino.md`, '---\naliases: [Alias destino]\n---\n# Destino\n\n## Primera sección\n\n## Segunda\n')
  writeFileSync(`${NOTES}/${DIR}/Etiquetas.md`, '# Etiquetas\n\n#e2etag-alpha y #e2etag-beta\n')
  k = await signIn(browser, 'noa')
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
  rmSync(`${NOTES}/thoth.yaml`, { force: true })
  const { notes } = await (await k.request.get('/api/tree')).json() as { notes: { path: string }[] }
  for (const n of notes) {
    if (n.path.startsWith(`${DIR}/`) || n.path.startsWith(`${TEMPLATES}/`)) await k.request.delete(`/api/note?path=${encodeURIComponent(n.path)}`)
  }
  await k.context().close()
  for (const d of [DIR, TEMPLATES]) rmSync(`${NOTES}/${d}`, { recursive: true, force: true })
})

const list = (page: Page) => page.locator('.thoth-complete')
const option = (page: Page, text: string | RegExp) => list(page).getByRole('option', { name: text })

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
 * Puts the cursor at the end of the «Texto.» line and types there. Clicked at
 * its left edge: further right there are links, and a click on one navigates.
 */
async function typeAtEnd(page: Page, text: string) {
  await page.locator('.cm-line', { hasText: 'Texto.' }).click({ position: { x: 2, y: 8 } })
  await page.keyboard.press('End')
  await page.keyboard.type(text)
}

test('[[ suggests notes by title, accent-insensitive; ↵ inserts the link and closes it', async () => {
  await typeAtEnd(k, ' [[destin')
  await accept(k, /^Destino/)
  await expect(list(k)).toHaveCount(0)
  await expect.poll(() => disk()).toContain('Texto. [[Destino]]')
})

test('an ambiguous name is inserted with the path suffix that makes it resolve', async () => {
  await typeAtEnd(k, ' [[plan')
  const blog = option(k, /proyectos \/ blog/)
  await expect(blog).toBeVisible()
  await expect(option(k, /proyectos \/ thoth/)).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/autocomplete-notes-light.png`, animations: 'disabled' })
  await blog.click()
  await expect.poll(() => disk()).toContain('[[Destino]] [[blog/Plan]]')
  // From here, the plain name is the root Plan.md: choosing it inserts just «Plan».
  await k.keyboard.type(' [[Plan gen')
  await accept(k, /^Plan general/)
  await expect.poll(() => disk()).toContain('[[blog/Plan]] [[Plan]]')
})

test('[[note# suggests its headings; [[note| its title and aliases', async () => {
  await typeAtEnd(k, ' [[Destino#')
  await expect(option(k, 'Primera sección')).toBeVisible()
  await expect(option(k, 'Segunda')).toBeVisible()
  await k.keyboard.type('seg')
  await expect(list(k).getByRole('option')).toHaveCount(1)
  await accept(k, /^Segunda/)
  await expect.poll(() => disk()).toContain('[[Destino#Segunda]]')

  await k.keyboard.type(' [[Destino|')
  await expect(option(k, 'Alias destino')).toBeVisible()
  await option(k, 'Alias destino').click()
  await expect.poll(() => disk()).toContain('[[Destino|Alias destino]]')
})

test('an alias finds the note and becomes the visible text', async () => {
  await typeAtEnd(k, ' [[alias dest')
  await accept(k, /^Alias destino/, 'Tab')
  await expect.poll(() => disk()).toContain(' [[Destino|Alias destino]]\n')
})

test('# suggests tags in use with their counts; never inside code or for a heading', async () => {
  await typeAtEnd(k, ' #e2etag')
  await expect(option(k, /#e2etag-alpha/)).toContainText('1 nota')
  await expect(option(k, /#e2etag-beta/)).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/autocomplete-tags-light.png`, animations: 'disabled' })
  await k.waitForTimeout(150)
  await k.keyboard.press('ArrowDown')
  await accept(k, /^#e2etag-beta/)
  await expect.poll(() => disk()).toContain(' #e2etag-beta\n')
  // A complete tag suggests nothing: ↵ is a new line.
  await k.keyboard.type(' #e2etag-alpha')
  await expect(list(k)).toHaveCount(0)
  await k.keyboard.press('Enter')
  await k.keyboard.type('`#e2etag')
  await expect(list(k)).toHaveCount(0)
  await k.keyboard.type('`\n#')
  await expect(list(k)).toHaveCount(0)
  await k.keyboard.type(' Título')
  await expect.poll(() => disk()).toContain('#e2etag-alpha\n`#e2etag`\n# Título')
})

test('a broken link offers to create the note in this folder; the link then resolves', async () => {
  await k.keyboard.press('Enter')
  await k.keyboard.type('Pendiente: [[Nota que no existe]] y [md](md-nueva.md).')
  await k.locator('.cm-h1').first().click()
  const broken = k.locator('.cm-wikilink-missing', { hasText: 'Nota que no existe' })
  await expect(broken.locator('.cm-wikilink-badge')).toHaveText('no existe · crear')
  await expect(broken.getByRole('button', { name: 'crear' })).toHaveAttribute('title', 'Crear «Nota que no existe» en e2e-ac')
  await k.screenshot({ path: `${SHOTS}/create-link-light.png`, animations: 'disabled' })
  await broken.getByRole('button', { name: 'crear' }).click()

  await expect(k).toHaveURL(/\?note=e2e-ac%2FNota\+que\+no\+existe\.md/)
  await expect(k.locator('.cm-h1')).toHaveText('Nota que no existe')
  // Just the title (opening it adds the uid to the frontmatter).
  expect(disk(`${DIR}/Nota que no existe.md`)).toMatch(/(^|---\n)# Nota que no existe\n$/)
  // The tree knows it too.
  await expect(k.getByRole('row', { name: 'Nota que no existe' })).toBeVisible()

  await k.goBack().catch(() => {})
  await k.goto(`/?note=${encodeURIComponent(SOURCE)}`)
  await expect(k.locator('.cm-wikilink-resolved', { hasText: 'Nota que no existe' })).toBeVisible()
  const links = await (await k.request.get(`/api/note/links?path=${encodeURIComponent(SOURCE)}`)).json() as { outgoing: { raw: string; status: string; dst_path: string }[] }
  expect(links.outgoing.find((l) => l.raw === '[[Nota que no existe]]')).toMatchObject({ status: 'resolved', dst_path: `${DIR}/Nota que no existe.md` })

  // A Markdown link to a missing .md: created where it points.
  const md = k.locator('.cm-wikilink-missing').filter({ has: k.getByRole('button', { name: 'crear' }) })
  await expect(md).toHaveCount(1)
  await md.getByRole('button', { name: 'crear' }).click()
  await expect(k).toHaveURL(/\?note=e2e-ac%2Fmd-nueva\.md/)
  expect(disk(`${DIR}/md-nueva.md`)).toMatch(/(^|---\n)# md-nueva\n$/)
})

test('never overwrites: if the note appeared meanwhile and the link leads there, it opens it', async () => {
  await k.goto(`/?note=${encodeURIComponent(SOURCE)}`)
  await typeAtEnd(k, ' [[Carrera]]')
  await k.locator('.cm-h1').first().click()
  const broken = k.locator('.cm-wikilink-missing', { hasText: 'Carrera' })
  await expect(broken.getByRole('button', { name: 'crear' })).toBeVisible()
  // Someone else creates it first, with other text.
  expect((await k.request.post('/api/note', { data: { path: `${DIR}/Carrera.md`, text: '# Carrera\n\nDe otra persona.\n' } })).status()).toBe(201)
  await broken.getByRole('button', { name: 'crear' }).click()
  await expect(k).toHaveURL(/\?note=e2e-ac%2FCarrera\.md/)
  expect(disk(`${DIR}/Carrera.md`)).toMatch(/(^|---\n)# Carrera\n\nDe otra persona\.\n$/)
})

test('with templates configured, «create» asks which one', async () => {
  mkdirSync(`${NOTES}/${TEMPLATES}`, { recursive: true })
  writeFileSync(`${NOTES}/${TEMPLATES}/Reunión.md`, '# {{title}}\n\nAsistentes:\n')
  writeFileSync(`${NOTES}/thoth.yaml`, `templates: ${TEMPLATES}\n`)
  await expect.poll(async () => (await (await k.request.get('/api/workspace')).json() as { templates: string | null }).templates).toBe(TEMPLATES)
  await expect.poll(async () => {
    const { notes } = await (await k.request.get('/api/tree')).json() as { notes: { path: string }[] }
    return notes.some((n) => n.path === `${TEMPLATES}/Reunión.md`)
  }).toBe(true)
  await k.goto(`/?note=${encodeURIComponent(SOURCE)}`)
  await typeAtEnd(k, ' [[Acta del lunes]]')
  await k.locator('.cm-h1').first().click()
  const create = k.locator('.cm-wikilink-missing', { hasText: 'Acta del lunes' }).getByRole('button', { name: 'crear' })
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
  await expect(menu).toContainText('Crear «Acta del lunes» en e2e-ac')
  await expect(menu.getByRole('menuitem', { name: 'Nota en blanco' })).toBeFocused()
  await k.screenshot({ path: `${SHOTS}/create-link-template-light.png`, animations: 'disabled' })
  await menu.getByRole('menuitem', { name: 'Reunión' }).click()
  await expect(k).toHaveURL(/\?note=e2e-ac%2FActa\+del\+lunes\.md/)
  await expect.poll(() => disk(`${DIR}/Acta del lunes.md`)).toMatch(/(^|---\n)# Acta del lunes\n\nAsistentes:\n$/)
  rmSync(`${NOTES}/thoth.yaml`, { force: true })
})

test('dark theme: the suggestion list', async () => {
  await k.goto(`/?note=${encodeURIComponent(SOURCE)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  const theme = k.getByRole('button', { name: /Cambiar a tema/ })
  if (await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).count()) await theme.click()
  await typeAtEnd(k, ' [[p')
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
  await page.locator('.cm-h1').first().tap()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('Móvil ')
  await page.getByRole('toolbar', { name: 'Formato' }).getByRole('button', { name: 'Enlazar nota' }).tap()
  await expect(list(page)).toBeVisible()
  await page.keyboard.type('destino')
  const opt = option(page, /^Destino/)
  await expect(list(page).getByRole('option', { selected: true })).toHaveText(/^Destino/)
  const box = await list(page).boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  expect((await opt.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await page.screenshot({ path: `${SHOTS}/autocomplete-mobile.png`, animations: 'disabled' })
  await opt.tap()
  await expect.poll(() => disk()).toMatch(/\nMóvil \[\[Destino\]\]\n?$/)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await ctx.close()
})
