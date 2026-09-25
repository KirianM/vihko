// thoth.yaml, the person's timezone, templates and the daily note (D-030):
// «Today» creates the note from its template in its series folder and then
// only opens it; previous/next in the header; an unknown key in thoth.yaml is
// ignored with a warning, an invalid file is an alert and the last good one
// keeps working; two timezones, two dates.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { E2E_DIR, NOTES } from './env.ts'
import { editorText, signIn } from './helpers.ts'

const SHOTS = `${E2E_DIR}/shots`
const CONFIG = `# e2e
templates: e2e-plantillas
daily:
  diario:
    label: Diario personal
    folder: e2e-diario/{user}
    template: e2e-plantillas/Diario
  equipo:
    label: Equipo
    folder: e2e-equipo
`
// UTC+14 and UTC-11: never on the same date, whatever the time of the run.
const EAST = 'Pacific/Kiritimati'
const WEST = 'Pacific/Pago_Pago'

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  mkdirSync(`${NOTES}/e2e-plantillas`, { recursive: true })
  mkdirSync(`${NOTES}/e2e-diario/noa`, { recursive: true })
  writeFileSync(`${NOTES}/e2e-plantillas/Diario.md`, '---\ntags: [diario]\n---\n# {{date:DD/MM/YYYY}}\n\nEscrito por {{user}}. {{desconocida}}\n')
  writeFileSync(`${NOTES}/e2e-diario/noa/2020-01-01.md`, '# Hace tiempo\n')
  writeFileSync(`${NOTES}/thoth.yaml`, CONFIG)
})

// The other tests share the notes folder and the users: everything is left as it was.
// Notes that were open in an editor go through thoth's trash, so none is left as a pending copy.
test.afterAll(async ({ browser }) => {
  rmSync(`${NOTES}/thoth.yaml`, { force: true })
  const dirs = ['e2e-plantillas', 'e2e-diario', 'e2e-equipo']
  for (const user of ['noa', 'ana']) {
    const page = await signIn(browser, user)
    await page.request.put('/api/profile', { data: { dailySeries: null, openDailyOnStart: false } })
    if (user === 'noa') {
      const { notes } = await (await page.request.get('/api/tree')).json() as { notes: { path: string }[] }
      for (const n of notes) if (dirs.some((d) => n.path.startsWith(`${d}/`))) await page.request.delete(`/api/note?path=${encodeURIComponent(n.path)}`)
    }
    await page.context().close()
  }
  for (const dir of dirs) rmSync(`${NOTES}/${dir}`, { recursive: true, force: true })
})

/** Today's date (YYYY-MM-DD) in a timezone. */
const dateIn = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const ddmmyyyy = (iso: string) => iso.split('-').reverse().join('/')

/** Signs in and sets the profile timezone, after the first-sign-in one from the browser. */
async function signInAt(browser: Browser, user: string, timeZone: string, note?: string): Promise<Page> {
  const page = await signIn(browser, user, note)
  await expect.poll(async () => (await (await page.request.get('/api/profile')).json()).timezone).not.toBeNull()
  const res = await page.request.put('/api/profile', { data: { timezone: timeZone } })
  expect(res.ok()).toBe(true)
  return page
}

const todayButton = (page: Page) => page.locator('nav.sidebar').getByRole('button', { name: 'Nota de hoy' })

let k: Page

test('first sign-in: the profile takes the browser\'s timezone', async ({ browser }) => {
  // As if ana had never signed in: no timezone yet.
  const before = await signIn(browser, 'ana')
  await expect.poll(async () => (await (await before.request.get('/api/profile')).json()).timezone).not.toBeNull()
  await before.request.put('/api/profile', { data: { timezone: null } })
  await before.context().close()

  const ctx = await browser.newContext({ timezoneId: 'America/Bogota' })
  const page = await ctx.newPage()
  await page.goto('/')
  await page.getByLabel('Nombre de usuario').fill('ana')
  await page.getByLabel('Contraseña').fill('contraseña-larga')
  await page.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(page.getByRole('treegrid')).toBeVisible()
  await expect.poll(async () => (await (await page.request.get('/api/profile')).json()).timezone).toBe('America/Bogota')
  await ctx.close()
})

test('«Today» creates the note from the template in the series folder, then only opens it', async ({ browser }) => {
  k = await signInAt(browser, 'noa', EAST)
  const today = dateIn(EAST)
  const path = `e2e-diario/noa/${today}.md`
  await expect(todayButton(k)).toBeVisible()
  await todayButton(k).click()
  await expect(k.locator('.crumbs b')).toHaveText(today)
  await expect(k).toHaveURL(new RegExp(`\\?note=${encodeURIComponent(path).replace(/\./g, '\\.')}$`))
  await expect.poll(() => editorText(k)).toContain(`Escrito por noa. {{desconocida}}`)
  const onDisk = readFileSync(`${NOTES}/${path}`, 'utf8')
  expect(onDisk).toMatch(new RegExp(`^---\\ntags: \\[diario\\]\\nuid: \\w+\\n---\\n# ${ddmmyyyy(today).replace(/\//g, '\\/')}\\n`))
  // The tree shows it where it is.
  await expect(k.getByRole('row', { name: today })).toHaveAttribute('aria-selected', 'true')

  // Written in, then «Today» again (the shortcut, from another note): the same note, untouched.
  await k.locator('.cm-content').click()
  await k.keyboard.press('Control+End')
  await k.keyboard.type('\nsegunda visita')
  await expect.poll(() => readFileSync(`${NOTES}/${path}`, 'utf8')).toContain('segunda visita')
  await k.goto('/?note=Plan.md')
  await expect(k.locator('.crumbs b')).toHaveText('Plan')
  await expect(todayButton(k)).toBeVisible() // thoth.yaml read: the shortcut is live
  await k.keyboard.press('Control+Alt+d')
  await expect(k.locator('.crumbs b')).toHaveText(today)
  await expect.poll(() => editorText(k)).toContain('segunda visita')
  await todayButton(k).click()
  await expect(k.locator('.crumbs b')).toHaveText(today)
  expect(readFileSync(`${NOTES}/${path}`, 'utf8')).toContain('segunda visita')
})

test('previous and next in the header: the nearest notes of the series that exist', async () => {
  const today = dateIn(EAST)
  const prev = k.getByRole('button', { name: 'Nota anterior de la serie' })
  const next = k.getByRole('button', { name: 'Nota siguiente de la serie' })
  await expect(next).toBeDisabled()
  await prev.click()
  await expect(k.locator('.crumbs b')).toHaveText('2020-01-01')
  await expect(prev).toBeDisabled()
  await next.click()
  await expect(k.locator('.crumbs b')).toHaveText(today)
  // A note outside every series has no such buttons.
  await k.goto('/?note=Plan.md')
  await expect(k.locator('.crumbs b')).toHaveText('Plan')
  await expect(prev).toHaveCount(0)
})

test('palette: «today\'s note» command and a new note from a template', async () => {
  await k.goto('/?note=Plan.md')
  await expect(todayButton(k)).toBeVisible()
  await k.keyboard.press('Control+k')
  await k.getByRole('dialog').getByRole('textbox').fill('>hoy')
  await k.getByRole('option', { name: 'nota de hoy' }).click()
  await expect(k.locator('.crumbs b')).toHaveText(dateIn(EAST))

  await k.goto('/?note=Plan.md')
  await k.locator('nav.sidebar').getByRole('button', { name: 'Nueva nota' }).click()
  await k.getByRole('dialog').getByRole('textbox').fill('Reunión e2e')
  const option = k.getByRole('option', { name: 'Crear «Reunión e2e» con la plantilla Diario' })
  await expect(option).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/daily-palette-template.png` })
  await option.click()
  await expect(k.locator('.crumbs b')).toHaveText('Reunión e2e')
  await expect.poll(() => editorText(k)).toContain('Escrito por noa.')
  expect(readFileSync(`${NOTES}/Reunión e2e.md`, 'utf8')).toContain(`# ${ddmmyyyy(dateIn(EAST))}`)
  expect((await k.request.delete(`/api/note?path=${encodeURIComponent('Reunión e2e.md')}`)).ok()).toBe(true)
})

test('another timezone near midnight gets another date', async ({ browser }) => {
  const ana = await signInAt(browser, 'ana', WEST)
  await todayButton(ana).click()
  const hers = dateIn(WEST)
  expect(hers).not.toBe(dateIn(EAST))
  await expect(ana.locator('.crumbs b')).toHaveText(hers)
  expect(existsSync(`${NOTES}/e2e-diario/ana/${hers}.md`)).toBe(true)
  expect(existsSync(`${NOTES}/e2e-diario/ana/${dateIn(EAST)}.md`)).toBe(false)
  await ana.context().close()
})

test('preferences: series and «open on start», which never creates a note', async ({ browser }) => {
  await k.goto('/')
  await k.getByRole('button', { name: 'Preferencias' }).click()
  const dialog = k.getByRole('dialog', { name: 'Preferencias' })
  await expect(dialog.getByLabel('Zona horaria')).toHaveValue(EAST)
  await dialog.getByLabel('Serie de la nota del día').selectOption('equipo')
  await dialog.getByLabel('Abrir la nota de hoy al entrar').check()
  await k.screenshot({ path: `${SHOTS}/daily-preferences-light.png` })
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog).toHaveCount(0)

  // The team series has no note today yet: opening thoth doesn't create it.
  await k.goto('/')
  await expect(k.getByRole('treegrid')).toBeVisible()
  await expect(k.getByText('Elige una nota en el árbol.')).toBeVisible()
  expect(existsSync(`${NOTES}/e2e-equipo/${dateIn(EAST)}.md`)).toBe(false)
  // «Today» does, in the chosen series, without a template: empty but for the uid.
  await todayButton(k).click()
  await expect(k.locator('.crumbs b')).toHaveText(dateIn(EAST))
  await expect(k.locator('.crumbs-path')).toContainText('e2e-equipo')
  expect(readFileSync(`${NOTES}/e2e-equipo/${dateIn(EAST)}.md`, 'utf8')).toMatch(/^---\nuid: \w+\n---\n$/)
  // Now it exists, so opening thoth opens it; a note in the URL wins.
  await k.goto('/')
  await expect(k.locator('.crumbs b')).toHaveText(dateIn(EAST))
  await k.goto('/?note=Plan.md')
  await expect(k.locator('.crumbs b')).toHaveText('Plan')
  void browser
})

test('thoth.yaml: an unknown key is ignored with a warning; an invalid file keeps the last good one', async () => {
  // A misspelt key: left out, and the rest applies.
  writeFileSync(`${NOTES}/thoth.yaml`, CONFIG.replace('templates:', 'templtes:'))
  await expect(async () => {
    await k.goto('/?view=avisos')
    await expect(k.locator('.alert-card', { hasText: 'salvo algunas partes' })).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 20_000 })
  const warnings = k.locator('.alert-card', { hasText: 'salvo algunas partes' })
  await expect(warnings).toContainText('Lo que aparece aquí no se aplica')
  await expect(warnings.getByRole('listitem')).toHaveText('línea 2 · templtes Clave desconocida (¿una errata, o de una versión más nueva de thoth?): se ignora.')
  await k.screenshot({ path: `${SHOTS}/config-warnings-light.png` })
  await todayButton(k).click()
  await expect(k.locator('.crumbs b')).toHaveText(dateIn(EAST))

  // A wrong value in a known key: the whole file waits, the last good one stays.
  writeFileSync(`${NOTES}/thoth.yaml`, CONFIG.replace('folder: e2e-equipo', 'folder: ../e2e-equipo'))
  await expect(async () => {
    await k.goto('/?view=avisos')
    await expect(k.locator('.alert-card', { hasText: 'no se puede usar' })).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 20_000 })
  const card = k.locator('.alert-card', { hasText: 'no se puede usar' })
  await expect(card).toContainText('thoth sigue con la última versión válida')
  await expect(card.getByRole('listitem')).toHaveText('línea 10 · daily.equipo.folder Ruta no válida: relativa a la carpeta de notas, sin «..» ni carpetas ocultas.')
  await k.screenshot({ path: `${SHOTS}/daily-alert-light.png` })
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await k.screenshot({ path: `${SHOTS}/daily-alert-dark.png` })
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
  await todayButton(k).click()
  await expect(k.locator('.crumbs b')).toHaveText(dateIn(EAST))

  // Fixed: the alerts go away on their own.
  writeFileSync(`${NOTES}/thoth.yaml`, CONFIG)
  await expect(async () => {
    await k.goto('/?view=avisos')
    await expect(k.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 1000 })
    await expect(k.locator('.alert-card', { hasText: /no se puede usar|salvo algunas partes/ })).toHaveCount(0, { timeout: 1000 })
  }).toPass({ timeout: 20_000 })
  await k.request.put('/api/profile', { data: { dailySeries: 'diario', openDailyOnStart: false } })
})

test('screenshots: note header with previous/next, light and dark', async () => {
  await k.goto(`/?note=${encodeURIComponent(`e2e-diario/noa/${dateIn(EAST)}.md`)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/daily-note-light.png` })
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await k.getByRole('button', { name: 'Preferencias' }).click()
  await k.screenshot({ path: `${SHOTS}/daily-preferences-dark.png` })
  await k.keyboard.press('Escape')
  await k.screenshot({ path: `${SHOTS}/daily-note-dark.png` })
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
  await k.context().close()
})

test('phone: «Today» from the drawer, previous/next in the header', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'es-ES' })
  const page = await ctx.newPage()
  await page.goto('/')
  await page.getByLabel('Nombre de usuario').fill('noa')
  await page.getByLabel('Contraseña').fill('contraseña-larga')
  await page.getByRole('button', { name: 'Entrar' }).last().click()
  const drawer = page.getByRole('dialog', { name: 'Carpetas' })
  await expect(drawer.getByRole('button', { name: 'Nota de hoy' })).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/daily-mobile-drawer.png`, animations: 'disabled' })
  await drawer.getByRole('button', { name: 'Nota de hoy' }).tap()
  await expect(drawer).toHaveCount(0)
  await expect(page.locator('.crumbs b')).toHaveText(dateIn(EAST))
  await expect(page.getByRole('button', { name: 'Nota anterior de la serie' })).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/daily-mobile-note.png`, animations: 'disabled' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.getByRole('button', { name: 'Nota anterior de la serie' }).tap()
  await expect(page.locator('.crumbs b')).toHaveText('2020-01-01')
  // Preferences from the drawer's user row.
  await page.getByRole('button', { name: 'Abrir carpetas' }).tap()
  await drawer.getByRole('button', { name: 'Preferencias' }).tap()
  await expect(page.getByRole('dialog', { name: 'Preferencias' })).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/daily-mobile-preferences.png`, animations: 'disabled' })
  await ctx.close()
})
