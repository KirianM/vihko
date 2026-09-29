// OAuth consent (m3 §7): registration is off until the admin turns it on,
// right under the MCP server's switch (D-049); a registered client sends the person to
// /oauth/authorize; they sign in, see who asks and where it goes back to,
// and answer with the choices of a new key (read-only and every folder by
// default). The browser goes back to the client with a code (or
// access_denied), the code becomes tokens, and the authorization shows in
// «Agents and API» as one more key, which revoking ends. Also on a phone,
// and with a client this vihko doesn't know.
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { ADMIN, BASE_URL, E2E_DIR, MEMBER, PUBLIC_URL, specMother } from './env.ts'
import { signIn } from './helpers.ts'

const SHOTS = `${E2E_DIR}/shots`
const m = specMother(import.meta.url)
/**
 * Where the client waits for the answer: on this machine (the consent page
 * says so for a loopback address). Nothing listens there: the browser's
 * arrival is caught (`backToClient`).
 */
const CALLBACK = 'http://127.0.0.1:4439/callback'
/** The client's name, as it registers itself (and its key's name). */
const NAME = m.aKeyName()
/** An OAuth `state`: whatever the client chose, sent back as it was. */
const aState = () => m.aSecret(16)

test.describe.configure({ mode: 'serial' })

let clientId = ''

/** The admin's session, for setup and cleanup. */
async function admin(browser: Browser) {
  const page = await signIn(browser, ADMIN)
  return page
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true })
  const page = await admin(browser)
  // Registration stays as on a new vihko (off) for the first test; a member approves on a phone, so members may create keys.
  expect((await page.request.put('/api/admin/integrations', { data: { mcp: true, oauthRegistration: false, membersCanCreateKeys: true } })).status()).toBe(200)
  await page.context().close()
})

test.afterAll(async ({ browser }) => {
  const page = await admin(browser)
  for (const k of (await (await page.request.get('/api/keys?all=1')).json()).keys as { id: string; name: string; status: string }[]) {
    if (k.name === NAME && k.status === 'active') await page.request.delete(`/api/keys/${k.id}`)
  }
  await page.request.put('/api/admin/integrations', { data: { api: false, mcp: false, membersCanCreateKeys: false, oauthRegistration: false } })
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

async function login(page: Page, user: { username: string; password: string }) {
  await expect(page.getByText('Inicia sesión para decidir si una aplicación puede usar tus notas.')).toBeVisible()
  await page.getByLabel('Nombre de usuario').fill(user.username)
  await page.getByLabel('Contraseña').fill(user.password)
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
  data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: NAME, version: '1' } } },
})

const card = (page: Page) => page.locator('.key-card', { has: page.getByRole('heading', { name: NAME, exact: true }) })

let token = ''

test('no client registers itself until the admin turns it on, right under the MCP server', async ({ browser, request }) => {
  const register = () => request.post(`${BASE_URL}/oauth/register`, { data: { client_name: NAME, redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' } })
  const metadata = async () => (await (await request.get(`${BASE_URL}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>
  // Off, with the MCP server on and a public URL: the address doesn't exist and the metadata doesn't offer it.
  expect((await register()).status()).toBe(404)
  expect((await metadata()).registration_endpoint).toBeUndefined()
  expect((await metadata()).client_id_metadata_document_supported).toBe(true)

  const page = await admin(browser)
  await page.goto('/?view=agents')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agentes y API')
  const switches = page.locator('.switches label.switch')
  await expect(switches.nth(1)).toContainText('Servidor MCP')
  await expect(switches.nth(2)).toContainText('Las aplicaciones OAuth pueden registrarse solas')
  await expect(switches.nth(2)).toContainText('Hace falta para conectar claude.ai o mcp-remote')
  const registration = page.getByRole('switch', { name: /Las aplicaciones OAuth pueden registrarse solas/ })
  await expect(registration).not.toBeChecked()
  const needs = page.getByText('claude.ai y mcp-remote se registran solas antes de pedir acceso', { exact: false })
  await expect(needs).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/oauth-registration-off.png`, fullPage: true, animations: 'disabled' })
  await switches.nth(2).click()
  await expect(registration).toBeChecked()
  await expect(needs).toHaveCount(0)
  await page.context().close()

  // On: the client registers itself, as claude.ai or mcp-remote do.
  expect((await metadata()).registration_endpoint).toBe(`${PUBLIC_URL}/oauth/register`)
  const r = await register()
  expect(r.status()).toBe(201)
  clientId = (await r.json()).client_id
})

test('a client asks: the person signs in, sees who asks, and approves it read-only; it becomes a key', async ({ browser, request }) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const hosts = new Set<string>()
  page.on('request', (r) => { const u = new URL(r.url()); if (u.protocol.startsWith('http')) hosts.add(u.origin) })
  const { verifier, challenge } = pkce()
  const back = await backToClient(page)
  const state = aState()
  await page.goto(authorizePath(clientId, challenge, state))
  await login(page, ADMIN)

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`«${NAME}» quiere acceder a tus notas`)
  await expect(page.getByText(`Si lo autorizas, podrá usar vihko por MCP en tu nombre (${ADMIN.username})`)).toBeVisible()
  const who = page.locator('.consent-who')
  await expect(who).toContainText(NAME)
  await expect(who).toContainText(CALLBACK)
  // It registered itself: its name is only what it says, and it goes back to this computer.
  await expect(who).toContainText('Sin comprobar: la aplicación se registró sola')
  await expect(page.getByRole('note').filter({ hasText: 'Volverá a un programa de este mismo ordenador' })).toBeVisible()
  // As a new key: read-only, every folder.
  await expect(page.getByRole('checkbox', { name: /Puede escribir/ })).not.toBeChecked()
  await expect(page.getByRole('radio', { name: 'Todas las carpetas que ves' })).toBeChecked()
  await expect(page.getByText(`Has iniciado sesión como ${ADMIN.username}.`)).toBeVisible()
  // Saying yes is confirmed at the moment (D-036), even just signed in: the password, without a second factor.
  await expect(page.getByRole('button', { name: 'Autorizar' })).toBeDisabled()
  await page.getByLabel('Tu contraseña').fill(ADMIN.password)
  await page.screenshot({ path: `${SHOTS}/consent-light.png`, fullPage: true, animations: 'disabled' })

  await page.getByRole('button', { name: 'Autorizar' }).click()
  const answer = await back()
  expect(answer.searchParams.get('state')).toBe(state)
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
  await expect(k).not.toContainText('vihko_…')
  // An authorization is revoked, never rotated: it has no key to rotate.
  await expect(k.getByRole('button', { name: 'Rotar' })).toHaveCount(0)
  await expect(k.getByRole('button', { name: 'Revocar' })).toBeVisible()
  // Where remote clients connect, to copy.
  await expect(page.getByLabel('Dirección del servidor MCP para asistentes remotos')).toHaveText(`${PUBLIC_URL}/mcp`)
  await expect(page.getByRole('switch', { name: /Las aplicaciones OAuth pueden registrarse solas/ })).toBeChecked()
  await k.screenshot({ path: `${SHOTS}/consent-key-light.png`, animations: 'disabled' })
  await ctx.close()
})

test('revoking the authorization asks first, and its tokens stop at once', async ({ browser, request }) => {
  const page = await signIn(browser, ADMIN)
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
  const page = await signIn(browser, ADMIN)
  const back = await backToClient(page)
  const { verifier, challenge } = pkce()
  // Already signed in: straight to the question.
  await page.goto(authorizePath(clientId, challenge, aState()))
  await page.getByRole('checkbox', { name: /Puede escribir/ }).check()
  await page.getByRole('radio', { name: /Solo estas carpetas/ }).check()
  await expect(page.getByRole('button', { name: 'Autorizar' })).toBeDisabled()
  await page.getByRole('checkbox', { name: 'proyectos', exact: true }).check()
  await page.getByLabel('Tu contraseña').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Autorizar' }).click()
  const tokens = await exchange(request, (await back()).searchParams.get('code')!, verifier)
  expect(tokens.scope).toBe('read write')
  await page.goto('/?view=agents')
  await expect(card(page)).toContainText('Lee y escribe')
  await expect(card(page)).toContainText('proyectos/')

  const denied = await browser.newContext()
  const other = await denied.newPage()
  const deniedBack = await backToClient(other)
  const state = aState()
  await other.goto(authorizePath(clientId, pkce().challenge, state))
  await login(other, ADMIN)
  await other.getByRole('button', { name: 'Denegar' }).click()
  const answer = await deniedBack()
  expect([answer.searchParams.get('error'), answer.searchParams.get('state'), answer.searchParams.get('code')]).toEqual(['access_denied', state, null])
  await denied.close()
  await page.context().close()
})

test('on a phone, in dark mode: the question fits and works', async ({ browser, request }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'es-ES', colorScheme: 'dark' })
  const page = await ctx.newPage()
  const back = await backToClient(page)
  const { verifier, challenge } = pkce()
  await page.goto(authorizePath(clientId, challenge, aState()))
  await login(page, MEMBER)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`«${NAME}» quiere acceder a tus notas`)
  await expect(page.getByText(`Si lo autorizas, podrá usar vihko por MCP en tu nombre (${MEMBER.username})`)).toBeVisible()
  await page.getByRole('radio', { name: /Solo estas carpetas/ }).check()
  await expect(page.getByRole('checkbox', { name: 'proyectos', exact: true })).toBeVisible()
  await page.getByRole('radio', { name: 'Todas las carpetas que ves' }).check()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  // The answer buttons fill the width, easy to tap.
  const approve = await page.getByRole('button', { name: 'Autorizar' }).boundingBox()
  expect(approve!.width).toBeGreaterThan(300)
  await page.getByLabel('Tu contraseña').fill(MEMBER.password)
  await page.screenshot({ path: `${SHOTS}/consent-mobile-dark.png`, fullPage: true, animations: 'disabled' })
  await page.getByRole('button', { name: 'Autorizar' }).tap()
  const tokens = await exchange(request, (await back()).searchParams.get('code')!, verifier)
  expect((await initialize(request, tokens.access_token)).status()).toBe(200)
  await ctx.close()
})

test('a client named by its metadata document: the page shows the domain that describes it', async ({ browser }) => {
  const page = await signIn(browser, ADMIN)
  const host = m.aHost()
  const client = m.aKeyName()
  const id = `https://${host}/oauth/client.json`
  // What the server answers once it fetched the document (the fetch itself is tested on the server, against a local HTTPS site).
  await page.route((url) => url.pathname === '/api/oauth/authorize', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { client: { id, name: client, redirectUri: `https://${host}/api/mcp/auth_callback`, host }, canAuthorize: true } })
    : route.continue())
  await page.goto(authorizePath(id, pkce().challenge, aState()))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`«${client}» quiere acceder a tus notas`)
  const who = page.locator('.consent-who')
  await expect(who.locator('dt', { hasText: 'Dominio' })).toBeVisible()
  await expect(who).toContainText(host)
  await expect(who).toContainText('vihko ha leído la descripción de la aplicación en este dominio')
  await expect(who).not.toContainText('Sin comprobar')
  await expect(page.getByText('Volverá a un programa de este mismo ordenador')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/consent-cimd-light.png`, fullPage: true, animations: 'disabled' })
  await page.context().close()
})

test('a metadata document vihko won\'t fetch (its host is this machine): the page says so and sends the browser nowhere', async ({ browser }) => {
  const page = await signIn(browser, ADMIN)
  // `localhost` resolves to a loopback address, so the real server refuses to fetch it.
  await page.goto(authorizePath('https://localhost/oauth/client.json', pkce().challenge, aState()))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('No se puede autorizar esta aplicación')
  await expect(page.getByRole('alert')).toContainText('no ha podido leer una descripción válida de esta aplicación en localhost')
  await expect(page).toHaveURL(/\/oauth\/authorize\?/)
  await page.context().close()
})

// Registration is open, so a registered address proves nothing: a request
// that isn't valid is shown to the person, never bounced to the client.
test('a registered client\'s request that isn\'t valid: the page says so and sends the browser nowhere', async ({ browser }) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  let bounced = false
  await page.route(`${CALLBACK}**`, (route) => { bounced = true; return route.fulfill({ status: 200, body: '' }) })
  await page.goto(authorizePath(clientId, pkce().challenge, aState()).replace('response_type=code', 'response_type=token'))
  await expect(page).toHaveURL(/\/oauth\/authorize\?/)
  await login(page, ADMIN)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('No se puede autorizar esta aplicación')
  await expect(page.getByRole('alert')).toContainText('La petición de la aplicación no es válida')
  await expect(page).toHaveURL(/\/oauth\/authorize\?/)
  expect(bounced).toBe(false)
  await ctx.close()
})

test('a client this vihko doesn\'t know: the page says so and sends the browser nowhere', async ({ browser }) => {
  const page = await signIn(browser, ADMIN)
  await page.goto(authorizePath(m.anId(), pkce().challenge, aState()))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('No se puede autorizar esta aplicación')
  await expect(page.getByRole('alert')).toContainText('no está registrada en este vihko')
  await expect(page).toHaveURL(/\/oauth\/authorize\?/)
  await page.context().close()
})
