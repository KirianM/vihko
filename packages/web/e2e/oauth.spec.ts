// OAuth consent (m3 §7): a registered client sends the person to
// /oauth/authorize; they sign in, see who asks and where it goes back to,
// and answer with the choices of a new key (read-only and every folder by
// default). The browser goes back to the client with a code (or
// access_denied), the code becomes tokens, and the authorization shows in
// «Agents and API» as one more key, which revoking ends. Also on a phone,
// and with a client this thoth doesn't know.
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { BASE_URL, E2E_DIR, PASSWORD, PUBLIC_URL } from './env.ts'
import { signIn } from './helpers.ts'

const SHOTS = `${E2E_DIR}/shots`
/** Where the client waits for the answer. Nothing listens there: the browser's arrival is caught (`backToClient`). */
const CALLBACK = 'http://127.0.0.1:4439/callback'
const NAME = 'Claude e2e'

test.describe.configure({ mode: 'serial' })

let clientId = ''

/** The admin's session, for setup and cleanup. */
async function admin(browser: Browser) {
  const page = await signIn(browser, 'noa')
  return page
}

test.beforeAll(async ({ browser, request }) => {
  mkdirSync(SHOTS, { recursive: true })
  const page = await admin(browser)
  expect((await page.request.put('/api/admin/integrations', { data: { mcp: true, oauthRegistration: true } })).status()).toBe(200)
  await page.context().close()
  // The client registers itself, as claude.ai or mcp-remote do.
  const r = await request.post(`${BASE_URL}/oauth/register`, { data: { client_name: NAME, redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' } })
  expect(r.status()).toBe(201)
  clientId = (await r.json()).client_id
})

test.afterAll(async ({ browser }) => {
  const page = await admin(browser)
  for (const k of (await (await page.request.get('/api/keys?all=1')).json()).keys as { id: string; name: string; status: string }[]) {
    if (k.name === NAME && k.status === 'active') await page.request.delete(`/api/keys/${k.id}`)
  }
  await page.request.put('/api/admin/integrations', { data: { api: false, mcp: false, membersCanCreateKeys: true, oauthRegistration: true } })
  await page.context().close()
})

/** A PKCE pair (S256). */
function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/** The authorization request the client sends the browser to. */
function authorizePath(client: string, challenge: string, state: string) {
  const q = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state, resource: `${PUBLIC_URL}/mcp` })
  return `/oauth/authorize?${q.toString()}`
}

/** Catches the browser going back to the client; returns what it came back with, once it does. */
async function backToClient(page: Page) {
  let back: URL | null = null
  await page.route(`${CALLBACK}**`, (route) => {
    back = new URL(route.request().url())
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Back at the client.</p>' })
  })
  return async () => {
    await expect.poll(() => back !== null, { timeout: 15_000 }).toBe(true)
    return back! as URL
  }
}

async function login(page: Page, user: string) {
  await expect(page.getByText('Inicia sesión para decidir si una aplicación puede usar tus notas.')).toBeVisible()
  await page.getByLabel('Nombre de usuario').fill(user)
  await page.getByLabel('Contraseña').fill(PASSWORD)
  await page.getByRole('button', { name: 'Entrar' }).last().click()
}

/** The client's side: the code for tokens. */
async function exchange(request: APIRequestContext, code: string, verifier: string) {
  const r = await request.post(`${BASE_URL}/oauth/token`, { form: { grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier } })
  expect(r.status()).toBe(200)
  return (await r.json()) as { access_token: string; refresh_token: string; scope: string }
}

const initialize = (request: APIRequestContext, token: string) => request.post(`${BASE_URL}/mcp`, {
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream' },
  data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } },
})

const card = (page: Page) => page.locator('.key-card', { has: page.getByRole('heading', { name: NAME, exact: true }) })

let token = ''

test('a client asks: the person signs in, sees who asks, and approves it read-only; it becomes a key', async ({ browser, request }) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const hosts = new Set<string>()
  page.on('request', (r) => { const u = new URL(r.url()); if (u.protocol.startsWith('http')) hosts.add(u.origin) })
  const { verifier, challenge } = pkce()
  const back = await backToClient(page)
  await page.goto(authorizePath(clientId, challenge, 'st-1'))
  await login(page, 'noa')

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`«${NAME}» quiere acceder a tus notas`)
  await expect(page.getByText('Si lo autorizas, podrá usar thoth por MCP en tu nombre (noa)')).toBeVisible()
  const who = page.locator('.consent-who')
  await expect(who).toContainText(NAME)
  await expect(who).toContainText(CALLBACK)
  // As a new key: read-only, every folder.
  await expect(page.getByRole('checkbox', { name: /Puede escribir/ })).not.toBeChecked()
  await expect(page.getByRole('radio', { name: 'Todas las carpetas que ves' })).toBeChecked()
  await expect(page.getByText('Has iniciado sesión como noa.')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/consent-light.png`, fullPage: true, animations: 'disabled' })

  await page.getByRole('button', { name: 'Autorizar' }).click()
  const answer = await back()
  expect(answer.searchParams.get('state')).toBe('st-1')
  expect(answer.searchParams.get('iss')).toBe(PUBLIC_URL)
  const tokens = await exchange(request, answer.searchParams.get('code')!, verifier)
  expect(tokens.scope).toBe('read')
  token = tokens.access_token
  expect((await initialize(request, token)).status()).toBe(200)
  // Until it went back to the client, the page only talked to this server.
  expect([...hosts].filter((h) => h !== new URL(CALLBACK).origin)).toEqual([BASE_URL])

  // In «Agents and API», one more key: named after the client, OAuth, where it goes back to, used via OAuth.
  await page.goto('/?view=agents')
  const k = card(page)
  await expect(k).toContainText('OAuth')
  await expect(k).toContainText('Solo lectura')
  await expect(k).toContainText('Todas las que ve su usuario')
  await expect(k).toContainText(CALLBACK)
  await expect(k).toContainText('por MCP (OAuth)')
  await expect(k).not.toContainText('thoth_…')
  // Where remote clients connect, to copy.
  await expect(page.getByLabel('Dirección del servidor MCP para asistentes remotos')).toHaveText(`${PUBLIC_URL}/mcp`)
  await expect(page.getByRole('switch', { name: /Las aplicaciones OAuth pueden registrarse solas/ })).toBeChecked()
  await k.screenshot({ path: `${SHOTS}/consent-key-light.png`, animations: 'disabled' })
  await ctx.close()
})

test('revoking the authorization asks first, and its tokens stop at once', async ({ browser, request }) => {
  const page = await signIn(browser, 'noa')
  await page.goto('/?view=agents')
  await card(page).getByRole('button', { name: 'Revocar' }).click()
  const ask = page.getByRole('alertdialog', { name: `¿Revocar «${NAME}»?` })
  await expect(ask).toContainText('La aplicación pierde el acceso al momento')
  await ask.getByRole('button', { name: 'Revocar la autorización' }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect((await initialize(request, token)).status()).toBe(401)
  await page.context().close()
})

test('with write and one folder, the key says so; denying sends the client access_denied', async ({ browser, request }) => {
  const page = await signIn(browser, 'noa')
  const back = await backToClient(page)
  const { verifier, challenge } = pkce()
  // Already signed in: straight to the question.
  await page.goto(authorizePath(clientId, challenge, 'st-2'))
  await page.getByRole('checkbox', { name: /Puede escribir/ }).check()
  await page.getByRole('radio', { name: /Solo estas carpetas/ }).check()
  await expect(page.getByRole('button', { name: 'Autorizar' })).toBeDisabled()
  await page.getByRole('checkbox', { name: 'proyectos', exact: true }).check()
  await page.getByRole('button', { name: 'Autorizar' }).click()
  const tokens = await exchange(request, (await back()).searchParams.get('code')!, verifier)
  expect(tokens.scope).toBe('read write')
  await page.goto('/?view=agents')
  await expect(card(page)).toContainText('Lee y escribe')
  await expect(card(page)).toContainText('proyectos/')

  const denied = await browser.newContext()
  const other = await denied.newPage()
  const deniedBack = await backToClient(other)
  await other.goto(authorizePath(clientId, pkce().challenge, 'st-3'))
  await login(other, 'noa')
  await other.getByRole('button', { name: 'Denegar' }).click()
  const answer = await deniedBack()
  expect([answer.searchParams.get('error'), answer.searchParams.get('state'), answer.searchParams.get('code')]).toEqual(['access_denied', 'st-3', null])
  await denied.close()
  await page.context().close()
})

test('on a phone, in dark mode: the question fits and works', async ({ browser, request }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'es-ES', colorScheme: 'dark' })
  const page = await ctx.newPage()
  const back = await backToClient(page)
  const { verifier, challenge } = pkce()
  await page.goto(authorizePath(clientId, challenge, 'st-4'))
  await login(page, 'ana')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`«${NAME}» quiere acceder a tus notas`)
  await expect(page.getByText('Si lo autorizas, podrá usar thoth por MCP en tu nombre (ana)')).toBeVisible()
  await page.getByRole('radio', { name: /Solo estas carpetas/ }).check()
  await expect(page.getByRole('checkbox', { name: 'proyectos', exact: true })).toBeVisible()
  await page.getByRole('radio', { name: 'Todas las carpetas que ves' }).check()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  // The answer buttons fill the width, easy to tap.
  const approve = await page.getByRole('button', { name: 'Autorizar' }).boundingBox()
  expect(approve!.width).toBeGreaterThan(300)
  await page.screenshot({ path: `${SHOTS}/consent-mobile-dark.png`, fullPage: true, animations: 'disabled' })
  await page.getByRole('button', { name: 'Autorizar' }).tap()
  const tokens = await exchange(request, (await back()).searchParams.get('code')!, verifier)
  expect((await initialize(request, tokens.access_token)).status()).toBe(200)
  await ctx.close()
})

test('a client this thoth doesn\'t know: the page says so and sends the browser nowhere', async ({ browser }) => {
  const page = await signIn(browser, 'noa')
  await page.goto(authorizePath('no-such-client', pkce().challenge, 'st-5'))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('No se puede autorizar esta aplicación')
  await expect(page.getByRole('alert')).toContainText('no está registrada en este thoth')
  await expect(page).toHaveURL(/\/oauth\/authorize\?/)
  await page.context().close()
})
