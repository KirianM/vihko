// The UI's language, a preference of the account: chosen in Preferences →
// Account or with ⌘K, applied at once, saved on the server (it follows the
// person to another browser) with a copy in the browser for the sign-in
// screen; automatic is the browser's language.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { ADMIN, specMother } from './env.ts'
import { newUser, signIn } from './helpers.ts'

const m = specMother(import.meta.url)
// Someone of this spec's own: every other spec's people keep the browser's language (es-ES).
const person = m.aUser({ role: 'member' })

test.describe.configure({ mode: 'serial' })
const pages: Page[] = []

test.beforeAll(async ({ browser }) => {
  const admin = await signIn(browser, ADMIN)
  await newUser(admin, person)
  await admin.context().close()
})

test.afterAll(async () => {
  for (const p of pages) await p.context().close()
})

/** A new browser with this locale, at the sign-in screen. */
async function browserAt(browser: Browser, locale: string): Promise<Page> {
  const page = await (await browser.newContext({ locale })).newPage()
  pages.push(page)
  await page.goto('/')
  return page
}

const TEXTS = {
  es: { user: 'Nombre de usuario', password: 'Contraseña', signIn: 'Entrar', prefs: 'Preferencias', account: 'Cuenta', language: 'Idioma' },
  en: { user: 'Username', password: 'Password', signIn: 'Sign in', prefs: 'Preferences', account: 'Account', language: 'Language' },
}
type Lang = keyof typeof TEXTS

/** Signs in from a sign-in screen in `lang`; the person has no folders, so vihko is ready when its preferences are. */
async function signInIn(page: Page, lang: Lang, after: Lang = lang) {
  const t = TEXTS[lang]
  await expect(page.getByRole('heading', { name: t.signIn })).toBeVisible()
  await page.getByLabel(t.user).fill(person.username)
  await page.getByLabel(t.password).fill(person.password)
  await page.getByRole('button', { name: t.signIn }).last().click()
  await expect(page.getByRole('button', { name: TEXTS[after].prefs })).toBeEnabled()
}

/** The UI is in `lang`, and so is <html lang>. */
async function expectLang(page: Page, lang: Lang) {
  await expect(page.getByRole('button', { name: TEXTS[lang].prefs })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', lang)
}

const stored = (page: Page) => page.evaluate(() => localStorage.getItem('vihko.lang'))
const saved = async (page: Page) => ((await (await page.request.get('/api/profile')).json()) as { language: string | null }).language

let first: Page

test('Preferences → Account: English at once, and still after a reload', async ({ browser }) => {
  first = await browserAt(browser, 'es-ES')
  await signInIn(first, 'es')
  await expectLang(first, 'es')
  await first.getByRole('button', { name: 'Preferencias' }).click()
  await first.getByRole('dialog').getByRole('button', { name: 'Cuenta' }).click()
  const select = first.getByRole('combobox', { name: 'Idioma' })
  await expect(select).toHaveValue('auto')
  // Each language named in itself, automatic in the UI's.
  await expect(select.getByRole('option')).toHaveText(['Automático (el del navegador)', 'English', 'Español'])
  await select.selectOption('en')
  await expect(first.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible()
  await expectLang(first, 'en')
  await expect(first.getByRole('combobox', { name: 'Language' })).toHaveValue('en')
  expect(await saved(first)).toBe('en')
  expect(await stored(first)).toBe('en')
  await first.reload()
  await expect(first.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible()
  await expectLang(first, 'en')
})

test('another browser: its own language until signing in, then the account’s; signing out keeps it', async ({ browser }) => {
  const second = await browserAt(browser, 'es-ES')
  await expect(second.locator('html')).toHaveAttribute('lang', 'es')
  await signInIn(second, 'es', 'en')
  await expectLang(second, 'en')
  expect(await stored(second)).toBe('en')
  // The sign-in screen of this browser is now in the person's language.
  await second.getByRole('button', { name: 'Sign out' }).click()
  await expect(second.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await expect(second.locator('html')).toHaveAttribute('lang', 'en')
})

test('automatic: the language of each browser, and no copy kept', async ({ browser }) => {
  await first.goto('/?view=account')
  await first.getByRole('combobox', { name: 'Language' }).selectOption({ label: "Automatic (browser's language)" })
  await expect(first.getByRole('heading', { level: 1, name: 'Cuenta' })).toBeVisible()
  await expectLang(first, 'es')
  await expect(first.getByRole('combobox', { name: 'Idioma' })).toHaveValue('auto')
  expect(await saved(first)).toBeNull()
  expect(await stored(first)).toBeNull()
  // The same account in a browser in English.
  const english = await browserAt(browser, 'en-US')
  await signInIn(english, 'en')
  await expectLang(english, 'en')
  expect(await stored(english)).toBeNull()
})

test('⌘K: a language, and automatic again', async () => {
  const palette = (name: string) => first.getByRole('dialog', { name })
  await first.keyboard.press('Control+k')
  await palette('Buscar o crear').getByRole('textbox').fill('>idioma')
  const options = palette('Buscar o crear').getByRole('option')
  // Automatic is the one in use: only the others are offered.
  await expect(options).toHaveText(['idioma: English', 'idioma: Español'])
  await options.filter({ hasText: 'English' }).click()
  await expect(palette('Buscar o crear')).toHaveCount(0)
  await expectLang(first, 'en')
  expect(await saved(first)).toBe('en')
  expect(await stored(first)).toBe('en')

  await first.keyboard.press('Control+k')
  await palette('Search or create').getByRole('textbox').fill('>language')
  await expect(palette('Search or create').getByRole('option')).toHaveText(["language: automatic (browser's language)", 'language: Español'])
  await palette('Search or create').getByRole('option', { name: /automatic/ }).click()
  await expectLang(first, 'es')
  expect(await saved(first)).toBeNull()
  expect(await stored(first)).toBeNull()
})
