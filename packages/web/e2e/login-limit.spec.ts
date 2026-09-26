// Login limits: after too many failures the server answers 429 with how long
// to wait; the login screen says so and keeps the button off until then, on
// the normal login and on the OAuth consent page. The admin's alert.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { BASE_URL, E2E_DIR, PUBLIC_URL } from './env.ts'
import { signIn } from './helpers.ts'

const SHOTS = `${E2E_DIR}/shots`
const CALLBACK = 'http://127.0.0.1:4439/callback'

test.describe.configure({ mode: 'serial' })

let clientId = ''

test.beforeAll(async ({ browser, request }) => {
  mkdirSync(SHOTS, { recursive: true })
  // The consent page exists while the MCP server is on (the test server has THOTH_PUBLIC_URL).
  const k = await signIn(browser, 'noa')
  expect((await k.request.put('/api/admin/integrations', { data: { mcp: true, oauthRegistration: true } })).status()).toBe(200)
  await k.context().close()
  const r = await request.post(`${BASE_URL}/oauth/register`, { data: { client_name: 'Límites e2e', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' } })
  expect(r.status()).toBe(201)
  clientId = (await r.json()).client_id
})

test.afterAll(async ({ browser }) => {
  const k = await signIn(browser, 'noa')
  await k.request.put('/api/admin/integrations', { data: { api: false, mcp: false } })
  await k.context().close()
})

async function tryPassword(page: Page, user: string, password: string, button = 'Entrar') {
  await page.getByLabel('Nombre de usuario').fill(user)
  await page.getByLabel('Contraseña').fill(password)
  await page.getByRole('button', { name: button }).last().click()
}

test('login: after five failures the wait shows, the button waits with it, and it doubles', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage()
  // A name nobody has, so no other spec's account is held back.
  const user = `limite-${Date.now().toString(36)}`
  await page.goto('/')
  for (let i = 0; i < 5; i++) {
    await tryPassword(page, user, `mala-${i}`)
    await expect(page.getByRole('alert')).toHaveText('Usuario o contraseña incorrectos.')
  }
  const submit = page.locator('button[type=submit]')
  // The sixth failure starts a wait of 1 s, the seventh one of 2 s, the eighth one of 4 s.
  for (const seconds of [1, 2, 4]) {
    await expect(submit).toBeEnabled({ timeout: 10_000 })
    await tryPassword(page, user, 'mala-otra')
    await expect(page.getByRole('alert')).toHaveText(`Demasiados intentos fallidos. Podrás volver a intentarlo dentro de ${seconds} s.`)
  }
  await expect(submit).toBeDisabled()
  await expect(submit).toHaveText(/^Espera [1-4] s$/)
  await page.screenshot({ path: `${SHOTS}/login-espera.png`, animations: 'disabled' })
  // Once the wait is over, the button is back and the message goes.
  await expect(submit).toHaveText('Entrar', { timeout: 10_000 })
  await expect(submit).toBeEnabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.context().close()
})

test('OAuth consent: signing in there shows the wait too, in minutes (English)', async ({ browser }) => {
  const ctx = await browser.newContext()
  await ctx.addInitScript(() => localStorage.setItem('thoth.lang', 'en'))
  const page = await ctx.newPage()
  // A wait longer than a minute, as the server gives after many failures.
  await page.route('**/api/auth/login', (route) => route.fulfill({
    status: 429, headers: { 'retry-after': '125' },
    json: { error: 'too_many_attempts', message: 'too many failed attempts', retryAfter: 125 },
  }))
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's', resource: `${PUBLIC_URL}/mcp` })
  await page.goto(`/oauth/authorize?${q}`)
  await expect(page.getByText('Sign in to decide whether an app may use your notes.')).toBeVisible()
  await page.getByLabel('Username').fill('noa')
  await page.getByLabel('Password').fill('whatever-password')
  await page.getByRole('button', { name: 'Sign in' }).last().click()
  await expect(page.getByRole('alert')).toHaveText('Too many failed attempts. You can try again in 2 min 5 s.')
  const submit = page.locator('button[type=submit]')
  await expect(submit).toBeDisabled()
  await expect(submit).toHaveText(/^Wait 2 min [0-5] s$/)
  await page.screenshot({ path: `${SHOTS}/consent-espera.png`, animations: 'disabled' })
  await ctx.close()
})

test('the admin’s alert when someone may be guessing passwords', async ({ browser }) => {
  const k = await signIn(browser, 'noa')
  await k.route('**/api/alerts', (route) => route.fulfill({ json: { alerts: [{ code: 'login_attempts_blocked', attempts: 143, since: '2026-09-26T12:10:00Z', actions: [] }] } }))
  await k.goto('/?view=avisos')
  const card = k.locator('.alert-card', { hasText: 'intentos de entrar' })
  // The date in the person's timezone (another spec may have changed it): 25, 26 or 27 September.
  await expect(card.getByRole('heading')).toHaveText(/^143 intentos de entrar fallidos o frenados desde el 2[5-7] sept, \d{2}:\d{2}$/)
  await expect(card).toContainText('THOTH_TRUSTED_PROXIES')
  await k.screenshot({ path: `${SHOTS}/avisos-login.png`, fullPage: true, animations: 'disabled' })
  await k.context().close()
})
