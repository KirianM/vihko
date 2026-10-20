// vihko.yaml, the person's timezone, templates and the daily note:
// «Today» creates the note from its template in its series folder and then
// only opens it; previous/next in the header; an unknown key in vihko.yaml is
// ignored with a warning, an invalid file is an alert and the last good one
// keeps working; two timezones, two dates.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, MEMBER, NOTES, inVault, personal, specMother } from './env.ts'
import { editorText, literally, noteInUrl, signIn, writeWorkspace } from './helpers.ts'

type Person = { username: string; password: string }

const SHOTS = `${E2E_DIR}/shots`
const m = specMother(import.meta.url)
/** A series id (vihko's: ASCII letters, digits, `_` and `-`). */
const seriesId = () => m.anId()
/** The templates folder, the template, and two series: each person's own, and a team one. */
const TEMPLATES = inVault(m.aFolder())
const TEMPLATE = m.aTitle()
/** Each person's series is in their own space (`people/{user}/…`); the team's, in the vault's shared space. */
const OWN = { id: seriesId(), label: m.aHeading(), folder: m.aFolder() }
const TEAM_NAME = m.aFolder()
const TEAM = { id: seriesId(), label: m.aHeading(), folder: inVault(TEAM_NAME) }
/** Where a person's own series keeps its notes. */
const ownFolder = (user: Person) => `${personal(user)}/${OWN.folder}`
const TEMPLATE_TAG = m.aTag()
/** A placeholder the template language doesn't know ({{letters}}): left as it is. */
const UNKNOWN = `{{${m.faker.string.alpha({ length: 10 })}}}`
/** What the template writes before the user's name. */
const BY = m.aSentence(m.anInt(1, 3)).slice(0, -1)
const q = JSON.stringify
// Line 9 is the team's folder: the alerts below name it.
const CONFIG = `# e2e
daily:
  ${OWN.id}:
    label: ${q(OWN.label)}
    folder: ${q(`people/{user}/${OWN.folder}`)}
    template: ${q(`${TEMPLATES}/${TEMPLATE}`)}
  ${TEAM.id}:
    label: ${q(TEAM.label)}
    folder: ${q(TEAM.folder)}
`
// UTC+14 and UTC-11: never on the same date, whatever the time of the run.
const EAST = 'Pacific/Kiritimati'
const WEST = 'Pacific/Pago_Pago'

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  mkdirSync(`${NOTES}/${TEMPLATES}`, { recursive: true })
  mkdirSync(`${NOTES}/${ownFolder(ADMIN)}`, { recursive: true })
  // Marked as a template: «New note» offers it; the series uses it either way.
  writeFileSync(`${NOTES}/${TEMPLATES}/${TEMPLATE}.md`, `---\ntemplate: true\ntags: [${TEMPLATE_TAG}]\n---\n# {{date:DD/MM/YYYY}}\n\n${BY} {{user}}. ${UNKNOWN}\n`)
  // An older note of the series, for previous/next.
  writeFileSync(`${NOTES}/${ownFolder(ADMIN)}/2020-01-01.md`, `# ${m.aHeading()}\n`)
  writeWorkspace(CONFIG)
})

// The other tests share the notes folder and the users: everything is left as it was.
// Notes that were open in an editor go through vihko's trash, so none is left as a pending copy.
test.afterAll(async ({ browser }) => {
  writeWorkspace()
  const dirs = [TEMPLATES, ownFolder(ADMIN), ownFolder(MEMBER), TEAM.folder]
  for (const user of [ADMIN, MEMBER]) {
    const page = await signIn(browser, user)
    // The time zone back to the browser's, as a first sign-in leaves it: nothing to offer in the other specs.
    await page.request.put('/api/profile', { data: { dailySeries: null, openDailyOnStart: false, timezone: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone) } })
    if (user === ADMIN) {
      const { notes } = await (await page.request.get('/api/tree')).json() as { notes: { path: string }[] }
      for (const n of notes) if (dirs.some((d) => n.path.startsWith(`${d}/`))) await page.request.delete(`/api/note?path=${encodeURIComponent(n.path)}`)
    }
    await page.context().close()
  }
  for (const dir of dirs) rmSync(`${NOTES}/${dir}`, { recursive: true, force: true, maxRetries: 10 })
})

/** Today's date (YYYY-MM-DD) in a timezone. */
const dateIn = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const ddmmyyyy = (iso: string) => iso.split('-').reverse().join('/')
/** A zone as the browser reports it (the canonical name of an alias). */
const canonical = (timeZone: string) => new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone

/** Signs in and sets the profile timezone, after the first-sign-in one from the browser. */
async function signInAt(browser: Browser, user: Person, timeZone: string, note?: string): Promise<Page> {
  const page = await signIn(browser, user, note)
  await expect.poll(async () => (await (await page.request.get('/api/profile')).json()).timezone).not.toBeNull()
  const res = await page.request.put('/api/profile', { data: { timezone: timeZone } })
  expect(res.ok()).toBe(true)
  return page
}

const todayButton = (page: Page) => page.locator('nav.sidebar').getByRole('button', { name: 'Nota de hoy' })

let k: Page

test('first sign-in: the profile takes the browser\'s timezone', async ({ browser }) => {
  // As if the member had never signed in: no timezone yet.
  const before = await signIn(browser, MEMBER)
  await expect.poll(async () => (await (await before.request.get('/api/profile')).json()).timezone).not.toBeNull()
  await before.request.put('/api/profile', { data: { timezone: null } })
  await before.context().close()

  const zone = m.aTimeZone()
  const ctx = await browser.newContext({ timezoneId: zone })
  const page = await ctx.newPage()
  await page.goto('/')
  await page.getByLabel('Nombre de usuario').fill(MEMBER.username)
  await page.getByLabel('Contraseña').fill(MEMBER.password)
  await page.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(page.getByRole('treegrid').first()).toBeVisible()
  await expect.poll(async () => (await (await page.request.get('/api/profile')).json()).timezone).toBe(canonical(zone))
  // A first sign-in offers nothing: the browser's zone is the one saved.
  await expect(page.locator('.timezone-offer')).toHaveCount(0)
  await ctx.close()
})

test('someone travelling: a browser in another time zone is offered once, never applied by itself', async ({ browser }) => {
  // Saved: one zone; the browser: another, never at the same time of day.
  const before = await signIn(browser, MEMBER)
  expect((await before.request.put('/api/profile', { data: { timezone: EAST } })).ok()).toBe(true)
  await before.context().close()
  const timezone = async (page: Page) => (await (await page.request.get('/api/profile')).json()).timezone as string
  const signInFrom = async (zone: string) => {
    const ctx = await browser.newContext({ timezoneId: zone })
    const page = await ctx.newPage()
    await page.goto('/')
    await page.getByLabel('Nombre de usuario').fill(MEMBER.username)
    await page.getByLabel('Contraseña').fill(MEMBER.password)
    await page.getByRole('button', { name: 'Entrar' }).last().click()
    await expect(page.getByRole('treegrid').first()).toBeVisible()
    return page
  }
  const shown = (z: string) => canonical(z).replaceAll('_', ' ')
  const page = await signInFrom(WEST)
  const offer = page.locator('.timezone-offer')
  await expect(offer).toContainText(`Tu navegador está en la zona horaria ${shown(WEST)}, y tus notas usan ${shown(EAST)} para decidir qué día es hoy.`)
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await offer.screenshot({ path: `${SHOTS}/timezone-offer-${theme}.png` })
  }
  await page.emulateMedia({ colorScheme: null })
  expect(await timezone(page)).toBe(canonical(EAST))
  // Kept: not asked again in this browser.
  await offer.getByRole('button', { name: 'Mantener' }).click()
  await expect(offer).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('treegrid').first()).toBeVisible()
  await expect(offer).toHaveCount(0)
  expect(await timezone(page)).toBe(canonical(EAST))
  await page.context().close()
  // Another browser on the same trip: offered there too, and taken.
  const other = await signInFrom(WEST)
  await other.locator('.timezone-offer').getByRole('button', { name: `Usar ${shown(WEST)}` }).click()
  await expect(other.locator('.timezone-offer')).toHaveCount(0)
  await expect.poll(() => timezone(other)).toBe(canonical(WEST))
  await other.context().close()
})

test('«Today» creates the note from the template in the series folder, then only opens it', async ({ browser }) => {
  k = await signInAt(browser, ADMIN, EAST)
  const today = dateIn(EAST)
  const path = `${ownFolder(ADMIN)}/${today}.md`
  await expect(todayButton(k)).toBeVisible()
  await todayButton(k).click()
  await expect(k.locator('.crumbs b')).toHaveText(today)
  // The page writes the path with URLSearchParams: a space as `+`.
  await expect(k).toHaveURL(new RegExp(`\\?${noteInUrl(path)}$`))
  await expect.poll(() => editorText(k)).toContain(`${BY} ${ADMIN.username}. ${UNKNOWN}`)
  const onDisk = readFileSync(`${NOTES}/${path}`, 'utf8')
  expect(onDisk).toMatch(new RegExp(`^---\\ntags: \\[${literally(TEMPLATE_TAG)}\\]\\nuid: \\w+\\n---\\n# ${literally(ddmmyyyy(today))}\\n`))
  // The tree shows it where it is.
  await expect(k.getByRole('row', { name: today })).toHaveAttribute('aria-selected', 'true')

  // Written in, then «Today» again (the shortcut, from another note): the same note, untouched.
  await k.locator('.cm-content').click()
  await k.keyboard.press('Control+End')
  const again = m.aUniqueWord()
  await k.keyboard.type(`\n${again}`)
  await expect.poll(() => readFileSync(`${NOTES}/${path}`, 'utf8')).toContain(again)
  await k.goto(`/?note=${encodeURIComponent(inVault('Plan.md'))}`)
  await expect(k.locator('.crumbs b')).toHaveText('Plan')
  await expect(todayButton(k)).toBeVisible() // vihko.yaml read: the shortcut is live
  await k.keyboard.press('Control+Alt+d')
  await expect(k.locator('.crumbs b')).toHaveText(today)
  await expect.poll(() => editorText(k)).toContain(again)
  await todayButton(k).click()
  await expect(k.locator('.crumbs b')).toHaveText(today)
  expect(readFileSync(`${NOTES}/${path}`, 'utf8')).toContain(again)
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
  await k.goto(`/?note=${encodeURIComponent(inVault('Plan.md'))}`)
  await expect(k.locator('.crumbs b')).toHaveText('Plan')
  await expect(prev).toHaveCount(0)
})

test('one name for «Today\'s note»: the sidebar\'s button and its tooltip, Home and the ⌘K box', async () => {
  await k.goto('/')
  await expect(k.getByRole('group', { name: 'Accesos rápidos' }).getByRole('button', { name: 'Nota de hoy' })).toBeVisible()
  // The sidebar's icon says it on hover, with its shortcut (Chromium on Linux: Ctrl). React Aria
  // shows tooltips on hover once it knows a mouse is in use: a click on the page first.
  await k.locator('.home-top h1').click()
  await todayButton(k).hover()
  await expect(k.getByRole('tooltip')).toHaveText('Nota de hoy (Ctrl+Alt+D)')
  for (const theme of ['light', 'dark'] as const) {
    await k.emulateMedia({ colorScheme: theme })
    await k.screenshot({ path: `${SHOTS}/today-tooltip-${theme}.png`, clip: { x: 0, y: 0, width: 640, height: 320 } })
  }
  await k.emulateMedia({ colorScheme: null })
  await k.mouse.move(800, 600)
  await k.keyboard.press('Control+k')
  await expect(k.getByRole('dialog').getByText('> nota de hoy')).toBeVisible()
  await k.keyboard.press('Escape')
})

test('palette: «today\'s note» command and a new note from a template', async () => {
  await k.goto(`/?note=${encodeURIComponent(inVault('Plan.md'))}`)
  await expect(todayButton(k)).toBeVisible()
  await k.keyboard.press('Control+k')
  await k.getByRole('dialog').getByRole('textbox').fill('>hoy')
  await k.getByRole('option', { name: 'nota de hoy' }).click()
  await expect(k.locator('.crumbs b')).toHaveText(dateIn(EAST))

  await k.goto(`/?note=${encodeURIComponent(inVault('Plan.md'))}`)
  await k.locator('nav.sidebar').getByRole('button', { name: 'Nueva nota' }).click()
  const title = m.aTitle()
  await k.getByRole('dialog').getByRole('textbox').fill(title)
  const option = k.getByRole('option', { name: `Crear «${title}» con la plantilla ${TEMPLATE}` })
  await expect(option).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/daily-palette-template.png` })
  await option.click()
  await expect(k.locator('.crumbs b')).toHaveText(title)
  await expect.poll(() => editorText(k)).toContain(`${BY} ${ADMIN.username}.`)
  expect(readFileSync(`${NOTES}/${inVault(title)}.md`, 'utf8')).toContain(`# ${ddmmyyyy(dateIn(EAST))}`)
  expect((await k.request.delete(`/api/note?path=${encodeURIComponent(`${inVault(title)}.md`)}`)).ok()).toBe(true)
})

test('the series chosen is gone: «Today» asks which one to use, never another by itself, and the answer stays', async () => {
  // A choice that no longer exists (a series removed, a space left or renamed).
  expect((await k.request.put('/api/profile', { data: { dailySeries: seriesId() } })).ok()).toBe(true)
  await k.goto(`/?note=${encodeURIComponent(inVault('Plan.md'))}`)
  await expect(k.locator('.crumbs b')).toHaveText('Plan')
  await todayButton(k).click()
  const dialog = k.getByRole('dialog', { name: '¿Qué serie usa «Nota de hoy»?' })
  await expect(dialog).toBeVisible()
  await expect(k.locator('.crumbs b')).toHaveText('Plan')
  // Each series with where it writes.
  await expect(dialog.getByRole('radio')).toHaveCount(2)
  await expect(dialog.getByRole('radio', { name: OWN.label })).toBeVisible()
  await expect(dialog).toContainText(`Mis notas / ${OWN.folder}`)
  await expect(dialog.getByRole('button', { name: 'Usar y abrir' })).toBeDisabled()
  for (const theme of ['light', 'dark'] as const) {
    await k.emulateMedia({ colorScheme: theme })
    await dialog.screenshot({ path: `${SHOTS}/series-gone-${theme}.png` })
  }
  await k.emulateMedia({ colorScheme: null })
  await dialog.getByRole('radio', { name: OWN.label }).check()
  await dialog.getByRole('button', { name: 'Usar y abrir' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(k.locator('.crumbs b')).toHaveText(dateIn(EAST))
  await expect.poll(async () => (await (await k.request.get('/api/profile')).json()).dailySeries).toBe(OWN.id)
})

test('never chose, and no series in one\'s own space: the first «Today» asks which one, never a shared space\'s by itself', async () => {
  const daily = async () => ((await (await k.request.get('/api/workspace')).json()).daily as { id: string }[]).map((s) => s.id)
  const inTeam = async () => ((await (await k.request.get('/api/tree')).json()).notes as { path: string }[]).filter((n) => n.path.startsWith(`${TEAM.folder}/`)).length
  // Only the team's series, in the vault's shared space; no choice made.
  writeWorkspace(`# e2e\ndaily:\n  ${TEAM.id}:\n    label: ${q(TEAM.label)}\n    folder: ${q(TEAM.folder)}\n`)
  try {
    await expect.poll(daily, { timeout: 20_000 }).toEqual([TEAM.id])
    expect((await k.request.put('/api/profile', { data: { dailySeries: null } })).ok()).toBe(true)
    const before = await inTeam()
    await k.goto(`/?note=${encodeURIComponent(inVault('Plan.md'))}`)
    await expect(k.locator('.crumbs b')).toHaveText('Plan')
    await todayButton(k).click()
    const dialog = k.getByRole('dialog', { name: '¿Qué serie usa «Nota de hoy»?' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Las series que tienes escriben en un espacio compartido, y vihko no elige por ti dónde escribir')
    await expect(dialog.getByRole('radio', { name: TEAM.label })).toBeVisible()
    await dialog.screenshot({ path: `${SHOTS}/series-first.png` })
    await k.setViewportSize({ width: 390, height: 844 })
    await expect(dialog.getByRole('button', { name: 'Usar y abrir' })).toBeVisible()
    await k.screenshot({ path: `${SHOTS}/series-first-phone.png` })
    await k.setViewportSize({ width: 1280, height: 800 })
    await dialog.getByRole('button', { name: 'Cancelar' }).click()
    await expect(dialog).toHaveCount(0)
    expect(await inTeam()).toBe(before)
    await expect(k.locator('.crumbs b')).toHaveText('Plan')
  } finally {
    writeWorkspace(CONFIG)
    await expect.poll(daily, { timeout: 20_000 }).toEqual([OWN.id, TEAM.id])
    expect((await k.request.put('/api/profile', { data: { dailySeries: OWN.id } })).ok()).toBe(true)
  }
})

test('another timezone near midnight gets another date', async ({ browser }) => {
  const member = await signInAt(browser, MEMBER, WEST)
  await todayButton(member).click()
  const theirs = dateIn(WEST)
  expect(theirs).not.toBe(dateIn(EAST))
  await expect(member.locator('.crumbs b')).toHaveText(theirs)
  expect(existsSync(`${NOTES}/${ownFolder(MEMBER)}/${theirs}.md`)).toBe(true)
  expect(existsSync(`${NOTES}/${ownFolder(MEMBER)}/${dateIn(EAST)}.md`)).toBe(false)
  await member.context().close()
})

test('preferences: series and «On opening: today\'s note», which never creates a note', async ({ browser }) => {
  await k.goto('/')
  await k.getByRole('button', { name: 'Preferencias' }).click()
  const dialog = k.getByRole('dialog', { name: 'Preferencias' })
  await expect(dialog.getByLabel('Zona horaria')).toHaveValue(EAST)
  await dialog.getByLabel('Serie de la nota del día').selectOption(TEAM.id)
  await dialog.getByRole('radio', { name: 'La nota de hoy, si ya existe' }).check()
  await k.screenshot({ path: `${SHOTS}/daily-preferences-light.png` })
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog).toHaveCount(0)

  // The team series has no note today yet: opening vihko doesn't create it.
  await k.goto('/')
  await expect(k.getByRole('treegrid').first()).toBeVisible()
  await expect(k.getByRole('heading', { name: 'Inicio', level: 1 })).toBeVisible()
  expect(existsSync(`${NOTES}/${TEAM.folder}/${dateIn(EAST)}.md`)).toBe(false)
  // «Today» does, in the chosen series, without a template: empty but for the uid.
  await todayButton(k).click()
  await expect(k.locator('.crumbs b')).toHaveText(dateIn(EAST))
  await expect(k.locator('.crumbs-path')).toContainText(TEAM_NAME)
  expect(readFileSync(`${NOTES}/${TEAM.folder}/${dateIn(EAST)}.md`, 'utf8')).toMatch(/^---\nuid: \w+\n---\n$/)
  // Now it exists, so opening vihko opens it; a note in the URL wins.
  await k.goto('/')
  await expect(k.locator('.crumbs b')).toHaveText(dateIn(EAST))
  await k.goto(`/?note=${encodeURIComponent(inVault('Plan.md'))}`)
  await expect(k.locator('.crumbs b')).toHaveText('Plan')
  void browser
})

test('vihko.yaml: an unknown key is ignored with a warning; an invalid file keeps the last good one', async () => {
  // A key vihko doesn't know: left out, and the rest applies.
  const unknown = m.aUniqueWord()
  writeWorkspace(CONFIG.replace('# e2e\n', `# e2e\n${unknown}: ${q(TEMPLATES)}\n`))
  await expect(async () => {
    await k.goto('/?view=alerts')
    await expect(k.locator('.alert-card', { hasText: 'salvo algunas partes' })).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 20_000 })
  const warnings = k.locator('.alert-card', { hasText: 'salvo algunas partes' })
  await expect(warnings).toContainText('Lo que aparece aquí no se aplica')
  await expect(warnings.getByRole('listitem')).toHaveText(`en vihko.yaml: línea 2 · ${unknown} Clave desconocida (¿una errata, o de una versión más nueva de vihko?): se ignora.`)
  await k.screenshot({ path: `${SHOTS}/config-warnings-light.png` })
  await todayButton(k).click()
  await expect(k.locator('.crumbs b')).toHaveText(dateIn(EAST))

  // A wrong value in a known key: the whole file waits, the last good one stays.
  writeWorkspace(CONFIG.replace(`folder: ${q(TEAM.folder)}`, `folder: ${q(`../${TEAM.folder}`)}`))
  await expect(async () => {
    await k.goto('/?view=alerts')
    await expect(k.locator('.alert-card', { hasText: 'no se puede usar' })).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 20_000 })
  const card = k.locator('.alert-card', { hasText: 'no se puede usar' })
  await expect(card).toContainText('vihko sigue con la última versión válida')
  await expect(card.getByRole('listitem')).toHaveText(`en vihko.yaml: línea 9 · daily.${TEAM.id}.folder Ruta no válida: relativa a la carpeta de notas, sin «..» ni carpetas ocultas.`)
  await k.screenshot({ path: `${SHOTS}/daily-alert-light.png` })
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await k.screenshot({ path: `${SHOTS}/daily-alert-dark.png` })
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
  await todayButton(k).click()
  await expect(k.locator('.crumbs b')).toHaveText(dateIn(EAST))

  // Fixed: the alerts go away on their own.
  writeWorkspace(CONFIG)
  await expect(async () => {
    await k.goto('/?view=alerts')
    await expect(k.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 1000 })
    await expect(k.locator('.alert-card', { hasText: /no se puede usar|salvo algunas partes/ })).toHaveCount(0, { timeout: 1000 })
  }).toPass({ timeout: 20_000 })
  await k.request.put('/api/profile', { data: { dailySeries: OWN.id, openDailyOnStart: false } })
})

test('screenshots: note header with previous/next, light and dark', async () => {
  await k.goto(`/?note=${encodeURIComponent(`${ownFolder(ADMIN)}/${dateIn(EAST)}.md`)}`)
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
  // A phone in the admin's own time zone: nothing to offer about it.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'es-ES', timezoneId: EAST })
  const page = await ctx.newPage()
  await page.goto('/')
  await page.getByLabel('Nombre de usuario').fill(ADMIN.username)
  await page.getByLabel('Contraseña').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Entrar' }).last().click()
  // A phone opens at Home too: the drawer is behind the menu.
  await expect(page.getByRole('heading', { name: 'Inicio', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'Abrir carpetas' }).tap()
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
