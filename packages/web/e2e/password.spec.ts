// «Change password…» in Account: its dialog (the current password, the new
// one twice, and what else ends with the old one), its defaults (the other
// sessions signed out, keys and apps left alone), what each box ends, the
// current session always staying, and the dialog on a phone.
import { expect, request, test, type Browser, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { ADMIN, BASE_URL, E2E_DIR, specMother } from './env.ts'
import { dismissNotices, dismissNoticesOf, newUser, signIn } from './helpers.ts'

const m = specMother(import.meta.url)
const SHOTS = `${E2E_DIR}/shots`
/** A member who changes their password, test after test: `password` is the one in force. */
const PERSON = m.aUser({ role: 'member' })
let password = PERSON.password

const SESSIONS = 'Cerrar mis otras sesiones'
const KEYS = 'Revocar también mis claves de API y las aplicaciones autorizadas (MCP)'

const dialog = (page: Page) => page.getByRole('dialog')
const opener = (page: Page) => page.getByRole('button', { name: 'Cambiar la contraseña…', exact: true })

/** Account, and its «Change password…» dialog, the current password focused. */
async function openDialog(page: Page) {
  await page.goto('/?view=account')
  await opener(page).click()
  await expect(dialog(page).getByRole('heading', { name: 'Cambiar la contraseña', exact: true })).toBeVisible()
  await expect(dialog(page).getByLabel('Contraseña actual')).toBeFocused()
}

/** The current password and a new one, twice. */
async function fill(page: Page, current: string, next: string, repeat = next) {
  const d = dialog(page)
  await d.getByLabel('Contraseña actual').fill(current)
  await d.getByLabel('Contraseña nueva').fill(next)
  await d.getByLabel('Repite la contraseña').fill(repeat)
}

/** A key of the person's, made with `page`'s session (confirmed with their password). */
async function newKey(page: Page): Promise<string> {
  const r = await page.request.post('/api/keys', { data: { name: m.aKeyName(), confirm: password } })
  expect(r.status(), await r.text()).toBe(201)
  return ((await r.json()) as { token: string }).token
}

/** What a request with this key gets: with no session, only the key. */
async function withKey(token: string): Promise<number> {
  const api = await request.newContext({ baseURL: BASE_URL })
  try {
    return (await api.get('/api/tree', { headers: { Authorization: `Bearer ${token}` } })).status()
  } finally {
    await api.dispose()
  }
}

/** The person's keys that work now. */
async function activeKeys(page: Page): Promise<number> {
  const { keys } = await (await page.request.get('/api/keys')).json() as { keys: { status: string }[] }
  return keys.filter((k) => k.status === 'active').length
}

const signedIn = async (page: Page) => (await page.request.get('/api/auth/me')).status()

test.describe.configure({ mode: 'serial' })

let admin: Page
test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true })
  admin = await signIn(browser, ADMIN)
  await newUser(admin, PERSON)
  // The person's keys: the API on and members allowed keys, both off for every other spec.
  expect((await admin.request.put('/api/admin/integrations', { data: { api: true, membersCanCreateKeys: true } })).status()).toBe(200)
})
test.afterAll(async () => {
  expect((await admin.request.put('/api/admin/integrations', { data: { api: false, membersCanCreateKeys: false } })).status()).toBe(200)
  // Every key made on an account is told to its person: not left for later specs.
  await dismissNoticesOf({ username: PERSON.username, password })
  await admin.context().close()
})

test('the dialog opens from Account: other sessions ticked, keys and apps not; the passwords must match; Escape closes it', async ({ browser }) => {
  const page = await signIn(browser, PERSON)
  await openDialog(page)
  const d = dialog(page)
  await expect(d.getByRole('checkbox', { name: SESSIONS })).toBeChecked()
  await expect(d.getByRole('checkbox', { name: KEYS })).not.toBeChecked()
  await page.screenshot({ path: `${SHOTS}/password-dialog-light.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: `${SHOTS}/password-dialog-dark.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'light' })

  // Two different new passwords: nothing is sent.
  await fill(page, password, m.aPassword(), m.aPassword())
  await d.getByRole('button', { name: 'Cambiar la contraseña', exact: true }).click()
  await expect(d.getByRole('alert')).toHaveText('Las dos contraseñas no coinciden.')

  await page.keyboard.press('Escape')
  await expect(d).toHaveCount(0)
  await expect(opener(page)).toBeFocused()
  await page.context().close()
})

test('with the defaults, another browser is signed out and a key keeps working; this session stays', async ({ browser }) => {
  const other = await signIn(browser, { username: PERSON.username, password })
  const page = await signIn(browser, { username: PERSON.username, password })
  await dismissNotices(page.request)
  const key = await newKey(page)
  await openDialog(page)
  const renewed = m.aPassword()
  await fill(page, password, renewed)
  await dialog(page).getByRole('button', { name: 'Cambiar la contraseña', exact: true }).click()

  const d = dialog(page)
  await expect(d.getByRole('heading', { name: 'Contraseña cambiada' })).toBeVisible()
  password = renewed
  await expect(d.getByRole('status')).toContainText(/Otras sesiones cerradas: [1-9]\d*\. Esta sigue abierta\./)
  await expect(d.getByRole('status')).toContainText('Tus claves y aplicaciones siguen funcionando.')
  await page.screenshot({ path: `${SHOTS}/password-changed.png`, animations: 'disabled' })
  expect(await signedIn(other)).toBe(401)
  expect(await signedIn(page)).toBe(200)
  expect(await withKey(key)).toBe(200)

  // «Done»: back to Account, which lists this session alone now.
  await expect(d.getByRole('button', { name: 'Hecho' })).toBeFocused()
  await d.getByRole('button', { name: 'Hecho' }).click()
  await expect(d).toHaveCount(0)
  await expect(page.locator('.session')).toHaveCount(1)
  await expect(page.locator('.session')).toContainText('Esta sesión')
  for (const p of [other, page]) await p.context().close()
})

test('with both boxes, another browser is signed out and every key is revoked; this session stays', async ({ browser }) => {
  const other = await signIn(browser, { username: PERSON.username, password })
  const page = await signIn(browser, { username: PERSON.username, password })
  await dismissNotices(page.request)
  const key = await newKey(page)
  const keys = await activeKeys(page)
  expect(keys).toBeGreaterThanOrEqual(2)
  await openDialog(page)
  const renewed = m.aPassword()
  await fill(page, password, renewed)
  await dialog(page).getByRole('checkbox', { name: KEYS }).check()
  await dialog(page).getByRole('button', { name: 'Cambiar la contraseña', exact: true }).click()

  const d = dialog(page)
  await expect(d.getByRole('heading', { name: 'Contraseña cambiada' })).toBeVisible()
  password = renewed
  await expect(d.getByRole('status')).toContainText(/Otras sesiones cerradas: [1-9]\d*\. Esta sigue abierta\./)
  await expect(d.getByRole('status')).toContainText(`Claves y aplicaciones revocadas: ${keys}.`)
  expect(await signedIn(other)).toBe(401)
  expect(await signedIn(page)).toBe(200)
  expect(await withKey(key)).toBe(401)
  expect(await activeKeys(page)).toBe(0)
  for (const p of [other, page]) await p.context().close()
})

/** The person signed in on a phone (390×844, touch). */
async function onPhone(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'es-ES' })
  const page = await ctx.newPage()
  // The notices of the keys made above would come in with the session, as a toast.
  expect((await ctx.request.post('/api/auth/login', { data: { username: PERSON.username, password } })).status()).toBe(200)
  await dismissNotices(ctx.request)
  await page.goto('/?view=account')
  await expect(page.getByRole('heading', { name: 'Cuenta', level: 1 })).toBeVisible()
  return page
}

test('on a phone (390 px) the dialog fits the screen, and its boxes and buttons work by touch', async ({ browser }) => {
  const page = await onPhone(browser)
  await opener(page).tap()
  const d = dialog(page)
  await expect(d.getByLabel('Contraseña actual')).toBeFocused()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  const box = (await d.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: `${SHOTS}/password-dialog-phone.png`, animations: 'disabled' })
  await d.screenshot({ path: `${SHOTS}/password-dialog-phone-whole.png`, animations: 'disabled' })

  const renewed = m.aPassword()
  await fill(page, password, renewed)
  // Each box and the buttons, reachable and tappable.
  const keys = d.getByRole('checkbox', { name: KEYS })
  await keys.tap()
  await expect(keys).toBeChecked()
  await keys.tap()
  await expect(keys).not.toBeChecked()
  await d.getByRole('button', { name: 'Cambiar la contraseña', exact: true }).tap()
  await expect(d.getByRole('heading', { name: 'Contraseña cambiada' })).toBeVisible()
  password = renewed
  await expect(d.getByRole('status')).toContainText('Tus claves y aplicaciones siguen funcionando.')
  await d.getByRole('button', { name: 'Hecho' }).tap()
  await expect(d).toHaveCount(0)
  await page.context().close()
})
