// «Home» and «On opening», for a new member: Home lists their
// recent notes, what others changed where they read and what was shared with
// them lately; the logo always leads there; the settings pages have «Back» to
// where they were; and «On opening» opens Home, the last note, a chosen one or
// today's (only if it exists).
import { expect, test, type Browser, type Page } from '@playwright/test'
import { ADMIN, E2E_DIR, specMother } from './env.ts'
import { literally, newUser, signIn, usePermissions } from './helpers.ts'

const m = specMother(import.meta.url)
const SLOW = { timeout: 20_000 }
const SHOTS = process.env.SHOTS ?? `${E2E_DIR}/shots`
const USER = m.aUser({ role: 'member' })
const SPACE = m.aSpaceName()
const SERIES = { id: m.anId(), folder: m.aFolder() }
const mine = (title: string) => `people/${USER.username}/${title}.md`
const q = encodeURIComponent

let k: Page
let u: Page

/** A request as `page`'s person; expects `status`. */
async function call(page: Page, method: 'get' | 'post' | 'put', url: string, data?: unknown, status = 200) {
  const r = await page.request[method](url, data === undefined ? {} : { data })
  expect(r.status(), `${method} ${url}: ${await r.text()}`).toBe(status)
  return r.json() as Promise<Record<string, any>>
}
const home = (p: Page) => p.getByRole('heading', { name: 'Inicio', level: 1 })
const card = (p: Page, name: string) => p.locator('section.home-card', { has: p.getByRole('heading', { name, exact: true }) })
const crumbsName = (p: Page) => p.locator('.crumbs b')

async function openPrefs(p: Page) {
  await p.getByRole('button', { name: 'Preferencias' }).click()
  return p.getByRole('dialog', { name: 'Preferencias' })
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  k = await signIn(browser, ADMIN)
  await newUser(k, USER)
  u = await signIn(browser, USER)
})

test.afterAll(async () => {
  await usePermissions()
  await u.context().close()
})

test('Home: recent notes, others\' changes with their name, and what was shared lately; nothing else', async ({ browser }) => {
  await expect(home(u)).toBeVisible()
  await expect(card(u, 'Tus notas recientes')).toContainText('Aquí verás las notas que escribas.')
  await expect(card(u, 'Compartido contigo hace poco')).toContainText('Nadie te ha compartido nada')

  // The admin makes a space with them in it and writes a note there; they write one of their own.
  const space = (await call(k, 'post', '/api/spaces', { name: SPACE, members: { [USER.username]: 'edit' } }, 201)).space.path as string
  const theirs = m.aTitle()
  await call(k, 'post', '/api/note', { path: `${space}/${theirs}.md`, text: `# ${theirs}\n\n${m.aSentence()}\n` }, 201)
  const own = m.aTitle()
  await call(u, 'post', '/api/note', { path: mine(own), text: `# ${own}\n\n${m.aSentence()}\n` }, 201)

  await expect(async () => {
    await u.reload()
    await expect(card(u, 'Cambios de otros').getByRole('link', { name: new RegExp(`^${literally(theirs)}`) })).toBeVisible({ timeout: 1000 })
    await expect(card(u, 'Tus notas recientes').getByRole('link', { name: new RegExp(`^${literally(own)}`) })).toBeVisible({ timeout: 1000 })
  }).toPass(SLOW)
  await expect(card(u, 'Cambios de otros')).toContainText(ADMIN.username)
  await expect(card(u, 'Compartido contigo hace poco')).toContainText(SPACE)
  await expect(card(u, 'Compartido contigo hace poco')).toContainText(`Espacio · ${ADMIN.username} te ha añadido`)
  // Nothing of the admin's own space, which they don't read.
  const adminNote = m.aTitle()
  await call(k, 'post', '/api/note', { path: `people/${ADMIN.username}/${adminNote}.md`, text: `# ${adminNote}\n` }, 201)
  await u.reload()
  await expect(home(u)).toBeVisible()
  await expect(u.getByText(adminNote)).toHaveCount(0)
  await shots(browser, u, 'home')

  // A note from Home; the logo goes back to Home.
  await card(u, 'Tus notas recientes').getByRole('link', { name: new RegExp(`^${literally(own)}`) }).click()
  await expect(crumbsName(u)).toHaveText(own)
  await u.getByRole('link', { name: 'vihko: Inicio' }).click()
  await expect(home(u)).toBeVisible()
  await expect(u).not.toHaveURL(/note=/)
})

test('«Back» on the settings pages goes where the person was: a note, or Home', async () => {
  const own = m.aTitle()
  await call(u, 'post', '/api/note', { path: mine(own), text: `# ${own}\n` }, 201)
  await u.goto(`/?note=${q(mine(own))}`)
  await expect(crumbsName(u)).toHaveText(own)
  // Account, then Agents from the preferences: Back still goes to the note.
  await (await openPrefs(u)).getByRole('button', { name: 'Cuenta' }).click()
  await expect(u.getByRole('heading', { name: 'Cuenta', level: 1 })).toBeVisible()
  await (await openPrefs(u)).getByRole('button', { name: 'Agentes y API' }).click()
  await expect(u.getByRole('heading', { name: 'Agentes y API', level: 1 })).toBeVisible()
  await u.getByRole('button', { name: 'Volver' }).click()
  await expect(crumbsName(u)).toHaveText(own)
  // From Home to the alerts (what was shared with them): Back to Home.
  await u.getByRole('link', { name: 'vihko: Inicio' }).click()
  await u.locator('.sidebar-alerts').click()
  await expect(u.getByRole('heading', { name: 'Avisos', level: 1 })).toBeVisible()
  await u.getByRole('button', { name: 'Volver' }).click()
  await expect(home(u)).toBeVisible()
  // Home itself has no «Back».
  await expect(u.getByRole('button', { name: 'Volver' })).toHaveCount(0)
})

test('«On opening»: the last note, a chosen one, today\'s only if it exists, and Home', async () => {
  const [last, chosen] = [m.aTitle(), m.aTitle()]
  for (const t of [last, chosen]) await call(u, 'post', '/api/note', { path: mine(t), text: `# ${t}\n` }, 201)

  // The last note opened on this device.
  let prefs = await openPrefs(u)
  await expect(prefs.getByRole('radio', { name: 'Inicio, la portada de vihko' })).toBeChecked()
  // No daily series for them yet: «today's» isn't offered.
  await expect(prefs.getByRole('radio', { name: 'La nota de hoy, si ya existe' })).toHaveCount(0)
  await prefs.getByRole('radio', { name: 'La última nota (en este dispositivo)' }).check()
  await prefs.getByRole('button', { name: 'Guardar' }).click()
  await u.goto(`/?note=${q(mine(last))}`)
  await expect(crumbsName(u)).toHaveText(last)
  // Opened, not only asked for: the breadcrumbs show the address before the server has answered, and only an opened note is the last one.
  await expect(u.locator('.cm-content')).toBeVisible()
  await u.goto('/')
  await expect(crumbsName(u)).toHaveText(last)

  // A note chosen by its name.
  prefs = await openPrefs(u)
  await prefs.getByRole('radio', { name: 'Una nota concreta' }).check()
  await prefs.getByPlaceholder('Busca una nota por su nombre').fill(chosen.slice(0, Math.max(3, chosen.length - 2)))
  await prefs.getByRole('button', { name: new RegExp(`^${literally(chosen)}`) }).click()
  await expect(prefs.getByRole('status')).toContainText(chosen)
  await u.screenshot({ path: `${SHOTS}/home-on-opening-light.png` })
  await prefs.getByRole('button', { name: 'Guardar' }).click()
  await u.goto('/')
  await expect(crumbsName(u)).toHaveText(chosen)

  // Today's note: offered once they have a series; not there, Home; there, it.
  await usePermissions({ config: `daily:\n  ${SERIES.id}:\n    folder: ${JSON.stringify(`people/{user}/${SERIES.folder}`)}\n` })
  // The grants don't change: what says vihko read the file is the series it offers them.
  await expect.poll(async () => ((await call(u, 'get', '/api/workspace')).daily as unknown[]).length, SLOW).toBe(1)
  await u.goto('/')
  prefs = await openPrefs(u)
  await prefs.getByRole('radio', { name: 'La nota de hoy, si ya existe' }).check()
  await expect(prefs.getByText('Solo si ya existe: al entrar nunca se crea una nota. Si no, Inicio.')).toBeVisible()
  await prefs.getByRole('button', { name: 'Guardar' }).click()
  await u.goto('/')
  await expect(home(u)).toBeVisible()
  const today = (await call(u, 'get', '/api/daily')) as { path: string; exists: boolean }
  expect(today.exists).toBe(false)
  await call(u, 'post', '/api/daily', {}, 201)
  await u.goto('/')
  await expect(crumbsName(u)).toHaveText(today.path.slice(today.path.lastIndexOf('/') + 1, -3))

  // Home.
  prefs = await openPrefs(u)
  await prefs.getByRole('radio', { name: 'Inicio, la portada de vihko' }).check()
  await prefs.getByRole('button', { name: 'Guardar' }).click()
  await u.goto('/')
  await expect(home(u)).toBeVisible()
})

test('a space called like Home is never taken for it: the page has its house, every space its mark, and «On opening» says which', async () => {
  // Literal: the name the page has is the case under test.
  const space = (await call(k, 'post', '/api/spaces', { name: 'Inicio', members: { [USER.username]: 'edit' } }, 201)).space.path as string
  try {
    await u.goto('/')
    await expect(home(u)).toBeVisible()
    const house = await u.locator('.home-title svg').innerHTML()
    const section = u.locator('nav.sidebar section.space-section', { has: u.getByRole('button', { name: 'Inicio', exact: true }) })
    await expect(section.locator('.space-kind svg')).toBeVisible()
    expect(await section.locator('.space-kind svg').innerHTML()).not.toBe(house)
    // «My notes» has a mark of its own too, another one.
    const mineMark = await u.locator('nav.sidebar section.space-section-mine .space-kind svg').innerHTML()
    expect(new Set([house, mineMark, await section.locator('.space-kind svg').innerHTML()]).size).toBe(3)
    // The theme is this device's (an earlier test chose one): its button, as `shots` does.
    await u.screenshot({ path: `${SHOTS}/home-vs-space-light.png` })
    await u.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
    await u.screenshot({ path: `${SHOTS}/home-vs-space-dark.png` })
    await u.getByRole('button', { name: 'Cambiar a tema claro' }).click()
    const prefs = await openPrefs(u)
    await expect(prefs.getByRole('radio', { name: 'Inicio, la portada de vihko' })).toBeVisible()
    await prefs.getByRole('button', { name: 'Cancelar' }).click()
  } finally {
    await k.request.delete(`/api/spaces?path=${q(space)}&trash=true`)
  }
})

/** Home, light and dark, on a computer and on a phone. */
async function shots(browser: Browser, p: Page, name: string) {
  await p.screenshot({ path: `${SHOTS}/${name}-desktop-light.png` })
  await p.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await p.screenshot({ path: `${SHOTS}/${name}-desktop-dark.png` })
  await p.getByRole('button', { name: 'Cambiar a tema claro' }).click()
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'es-ES', storageState: await p.context().storageState() })
  const phone = await ctx.newPage()
  for (const theme of ['light', 'dark']) {
    // The theme is this device's (theme.ts): set before the page loads.
    await phone.addInitScript((t) => localStorage.setItem('vihko.theme', t), theme)
    await phone.goto('/')
    await expect(home(phone)).toBeVisible()
    await expect(phone.locator('.home-list li').first()).toBeVisible()
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await phone.screenshot({ path: `${SHOTS}/${name}-phone-${theme}.png`, fullPage: true })
  }
  await ctx.close()
}
