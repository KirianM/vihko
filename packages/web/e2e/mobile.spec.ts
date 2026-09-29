// Phone layout (390×844, touch): the folder drawer, the note header, the
// editor bar, the side panel as a sheet, alerts, palette, theme and sign out.
// Also the web app manifest and its icons (installable, no service worker).
import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, NOTES, specMother } from './env.ts'

const m = specMother(import.meta.url)
const FOLDER = m.aFolder()
const DIR = `${NOTES}/${FOLDER}`
/** A long name (at least 36 characters): the header must show it whole, not a couple of letters. */
let LONG = m.aTitle()
while (LONG.length < 36) LONG += ` ${m.aWord()}`
const NOTE = `${FOLDER}/${LONG}.md`
const FILE = `${NOTES}/${NOTE}`
const FIRST = m.aSentence()
/** Two notes with one uid, for an alert. */
const TWINS = [`${m.aTitle()}.md`, `${m.aTitle()}.md`]
const UID = m.aUniqueWord()
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
const SHOTS = `${E2E_DIR}/shots`

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  mkdirSync(DIR, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(FILE, `# ${m.aHeading()}\n\n${FIRST}\n`)
  // Two notes with the same uid: a workspace alert, reachable from the drawer.
  for (const twin of TWINS) writeFileSync(`${DIR}/${twin}`, `---\nuid: ${UID}\n---\n# ${m.aHeading()}\n`)
})
// The note stays (deleting a note that was just open would leave a pending copy); the alert goes.
test.afterAll(() => { for (const f of TWINS) rmSync(`${DIR}/${f}`, { force: true }) })

const drawer = (page: Page) => page.getByRole('dialog', { name: 'Carpetas' })
const noHorizontalScroll = (page: Page) =>
  expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)

async function signIn(page: Page) {
  await page.goto('/')
  // A phone keyboard neither capitalises nor corrects a user's name.
  const name = page.getByLabel('Nombre de usuario')
  await expect(name).toHaveAttribute('autocapitalize', 'none')
  await expect(name).toHaveAttribute('autocorrect', 'off')
  await expect(name).toHaveAttribute('spellcheck', 'false')
  await name.fill(ADMIN.username)
  await page.getByLabel('Contraseña').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Entrar' }).last().tap()
}

let page: Page
test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'es-ES' })
  page = await ctx.newPage()
})
test.afterAll(async () => { await page.context().close() })

test('no sidebar; with nothing open the folder drawer is the first screen', async () => {
  await signIn(page)
  await expect(drawer(page)).toBeVisible()
  await expect(page.locator('nav.sidebar')).toHaveCount(0)
  await expect(drawer(page).getByRole('treegrid', { name: 'Carpetas' })).toBeVisible()
  await expect(drawer(page).getByRole('button', { name: 'Nueva nota' })).toBeVisible()
  await expect(drawer(page).getByRole('button', { name: 'Cerrar sesión' })).toBeVisible()
  // Touch targets: tree rows and buttons at least 44px tall.
  const row = await drawer(page).getByRole('row').first().boundingBox()
  expect(row!.height).toBeGreaterThanOrEqual(44)
  await noHorizontalScroll(page)
  await page.screenshot({ path: `${SHOTS}/mobile-drawer-light.png`, animations: 'disabled' })
})

test('open a note from the tree: the drawer closes and the header shows the full name', async () => {
  await drawer(page).getByRole('row', { name: FOLDER, exact: true }).tap()
  await drawer(page).getByRole('row', { name: LONG, exact: true }).tap()
  await expect(drawer(page)).toHaveCount(0)
  await expect(page.locator('.cm-content')).toBeVisible()
  await expect.poll(() => noteParam(page)).toBe(NOTE)
  const crumbs = page.locator('.main-head .crumbs')
  await expect(crumbs.locator('.crumbs-path')).toHaveText(`${FOLDER} / `)
  await expect(crumbs.locator('b')).toHaveText(LONG)
  await page.screenshot({ path: `${SHOTS}/mobile-open-light.png`, animations: 'disabled' })
  // Not clipped to a couple of letters: the name gets all the width the header buttons leave it.
  const width = await crumbs.locator('b').evaluate((b) => b.getBoundingClientRect().width)
  expect(width).toBeGreaterThan(110)
  await noHorizontalScroll(page)
})

test('edit with the keyboard and the editor bar ([[, #, bulleted list); the save state is in the bar', async () => {
  const line = page.locator('.cm-line', { hasText: FIRST })
  await line.tap()
  await toLineEnd(line)
  const word = m.aWord()
  const tag = m.aTag()
  await page.keyboard.type(` ${word} `)
  const bar = page.getByRole('toolbar', { name: 'Formato' })
  await bar.getByRole('button', { name: 'Enlazar nota' }).tap()
  await page.keyboard.type('Plan') // the vault's Plan (testdata/vault)
  await page.keyboard.press('End')
  await bar.getByRole('button', { name: 'Añadir tag' }).tap()
  await page.keyboard.type(tag)
  await bar.getByRole('button', { name: 'Lista con viñetas' }).tap()
  await expect.poll(() => readFileSync(FILE, 'utf8')).toContain(`- ${FIRST} ${word} [[Plan]] #${tag}`)
  // The bar's buttons don't take the focus: the keyboard would close.
  await expect(page.locator('.cm-content')).toBeFocused()
  await expect(bar.getByText('Guardado en disco')).toBeVisible()
  const barBox = await bar.boundingBox()
  expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(844)
  await page.screenshot({ path: `${SHOTS}/mobile-note-light.png`, animations: 'disabled' })
})

test('the side panel opens as a full-width sheet; back closes it and keeps the note', async () => {
  await page.getByRole('button', { name: 'Mostrar el panel lateral' }).tap()
  const panel = page.getByRole('complementary', { name: 'Comentarios y contexto' })
  await expect(panel).toBeVisible()
  const box = await panel.boundingBox()
  expect(box!.width).toBe(390)
  await panel.getByRole('tab', { name: /Enlaces/ }).tap()
  await expect(panel.getByText('Plan', { exact: false }).first()).toBeVisible()
  await noHorizontalScroll(page)
  await page.screenshot({ path: `${SHOTS}/mobile-panel-light.png`, animations: 'disabled' })
  await page.goBack()
  await expect(panel).toHaveCount(0)
  await expect.poll(() => noteParam(page)).toBe(NOTE)
  await expect(page.locator('.cm-content')).toBeVisible()
})

test('the drawer: back and Escape close it; the note it was opened over stays', async () => {
  await page.getByRole('button', { name: 'Abrir carpetas' }).tap()
  await expect(drawer(page)).toBeVisible()
  // It shows where the open note is.
  await expect(drawer(page).getByRole('row', { name: LONG, exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.goBack()
  await expect(drawer(page)).toHaveCount(0)
  await expect.poll(() => noteParam(page)).toBe(NOTE)
  await page.getByRole('button', { name: 'Abrir carpetas' }).tap()
  await expect(drawer(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer(page)).toHaveCount(0)
  await expect.poll(() => noteParam(page)).toBe(NOTE)
})

test('palette: full screen from the header, back closes it', async () => {
  await page.getByRole('button', { name: 'Buscar' }).tap()
  const input = page.getByRole('textbox', { name: 'Buscar' })
  await expect(input).toBeVisible()
  await input.fill('plan')
  await expect(page.getByRole('option').first()).toBeVisible()
  await noHorizontalScroll(page)
  await page.goBack()
  await expect(input).toHaveCount(0)
  await expect.poll(() => noteParam(page)).toBe(NOTE)
})

test('alerts from the drawer', async () => {
  // The server finds the duplicate uid on its next rescan (every 5s).
  await expect(async () => {
    await page.reload()
    await page.getByRole('button', { name: 'Abrir carpetas' }).tap()
    await expect(drawer(page).getByRole('link', { name: /avisos del espacio/ })).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 20_000 })
  await drawer(page).getByRole('link', { name: /avisos del espacio/ }).tap()
  await expect(drawer(page)).toHaveCount(0)
  await expect(page).toHaveURL(/\?view=alerts$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Avisos del espacio')
  await expect(page.locator('.alert-card', { hasText: UID })).toBeVisible()
  await noHorizontalScroll(page)
  // From the alerts page, the drawer is still reachable.
  await expect(page.getByRole('button', { name: 'Abrir carpetas' })).toBeVisible()
})

test('dark theme from the drawer, and new note', async () => {
  await page.goto(`/?note=${encodeURIComponent(NOTE)}`)
  await expect(page.locator('.cm-content')).toBeVisible()
  await page.getByRole('button', { name: 'Abrir carpetas' }).tap()
  await drawer(page).getByRole('button', { name: 'Cambiar a tema oscuro' }).tap()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  // The browser bar follows the chosen theme (colour from the tokens).
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', bg)
  await page.screenshot({ path: `${SHOTS}/mobile-drawer-dark.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')
  await page.screenshot({ path: `${SHOTS}/mobile-note-dark.png`, animations: 'disabled' })

  await page.getByRole('button', { name: 'Abrir carpetas' }).tap()
  await drawer(page).getByRole('button', { name: 'Nueva nota' }).tap()
  await expect(drawer(page)).toHaveCount(0)
  await expect(page.locator('.palette-input')).toBeFocused()
  await page.getByRole('button', { name: 'Cancelar' }).tap()
  await page.getByRole('button', { name: 'Abrir carpetas' }).tap()
  await drawer(page).getByRole('button', { name: 'Cambiar a tema claro' }).tap()
})

test('sign out from the drawer', async () => {
  await drawer(page).getByRole('button', { name: 'Cerrar sesión' }).tap()
  await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible()
})

test('tablet (768px): sidebar and header fit, the note name is not clipped', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 768, height: 1024 }, hasTouch: true, locale: 'es-ES' })
  const t = await ctx.newPage()
  await t.goto(`/?note=${encodeURIComponent('proyectos/vihko/Plan.md')}`)
  await t.getByLabel('Nombre de usuario').fill(ADMIN.username)
  await t.getByLabel('Contraseña').fill(ADMIN.password)
  await t.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(t.locator('.cm-content')).toBeVisible()
  await expect(t.locator('nav.sidebar')).toBeVisible()
  const name = t.locator('.main-head .crumbs b')
  await expect(name).toHaveText('Plan')
  expect(await name.evaluate((b) => b.scrollWidth <= b.clientWidth)).toBe(true)
  await noHorizontalScroll(t)
  await t.screenshot({ path: `${SHOTS}/tablet-note.png`, animations: 'disabled' })
  await ctx.close()
})

test('web app manifest: installable fields and icons that exist', async ({ request }) => {
  const html = await (await request.get('/')).text()
  expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"')
  expect(html).toMatch(/<meta name="theme-color" media="\(prefers-color-scheme: light\)" content="#[0-9A-Fa-f]{6}"/)
  expect(html).toMatch(/<meta name="theme-color" media="\(prefers-color-scheme: dark\)" content="#[0-9A-Fa-f]{6}"/)
  expect(html).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png"')

  const res = await request.get('/manifest.webmanifest')
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toMatch(/^application\/manifest\+json/)
  const manifest = await res.json() as { name: string; short_name: string; start_url: string; display: string; theme_color: string; background_color: string; icons: { src: string; sizes: string; type: string; purpose: string }[] }
  expect(manifest).toMatchObject({ name: 'vihko', short_name: 'vihko', start_url: '/', display: 'standalone' })
  expect(manifest.theme_color).toMatch(/^#[0-9A-Fa-f]{6}$/)
  expect(manifest.background_color).toMatch(/^#[0-9A-Fa-f]{6}$/)
  // Chrome needs a 192 and a 512 icon; one maskable for Android's shapes.
  expect(manifest.icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))
  expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true)
  for (const icon of [...manifest.icons, { src: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }]) {
    const r = await request.get(icon.src)
    expect(r.status(), icon.src).toBe(200)
    expect(r.headers()['content-type']).toBe('image/png')
    // PNG header: width and height (big-endian) at bytes 16 and 20.
    const png = await r.body()
    const [w, h] = icon.sizes.split('x').map(Number)
    expect([png.readUInt32BE(16), png.readUInt32BE(20)], icon.src).toEqual([w, h])
  }
  // No service worker: nothing is cached for offline use.
  expect(html).not.toContain('serviceWorker')
})
