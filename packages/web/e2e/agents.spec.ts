// «Agents and API» (D-035): the admin turns the integrations on, creates a
// read-only key limited to a folder (shown once, with its MCP
// configurations), uses it over HTTP, edits it (letting it write is
// confirmed, a shorter expiry isn't), revokes it; a member can't create keys
// until the admin lets members (off by default, D-049), nor once it's off
// again; the server's lock (VIHKO_INTEGRATIONS=off); and
// the page on a phone, in dark mode.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { ADMIN, BASE_URL, E2E_DIR, LOCKED_URL, MEMBER, specMother } from './env.ts'
import { signIn } from './helpers.ts'

const m = specMother(import.meta.url)
const SHOTS = `${E2E_DIR}/shots`
/** The keys this spec makes: the admin's for one folder, the member's, one on the locked server, one on a phone, one refused. */
const KEY = m.aKeyName()
const MEMBER_KEY = m.aKeyName()
const LOCKED_KEY = m.aKeyName()
const PHONE_KEY = m.aKeyName()
const REFUSED_KEY = m.aKeyName()
// The admin's key is for `proyectos` of the test vault (which holds `proyectos/vihko`), the phone's for `hogar`.
/** A note the key writes in its folder, and one outside it. */
const INSIDE = m.aNotePath('proyectos')
const OUTSIDE = m.aNotePath('hogar')
const TOKEN = /^vihko_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}$/

test.describe.configure({ mode: 'serial' })
test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }))

/** Signs in on a page of any context (and any server). */
async function login(page: Page, user: { username: string; password: string }, url = '/') {
  await page.goto(url)
  await page.getByLabel('Nombre de usuario').fill(user.username)
  await page.getByLabel('Contraseña').fill(user.password)
  await page.getByRole('button', { name: 'Entrar' }).last().click()
}

/** From the sidebar: Preferences → «Agents and API». */
async function openAgents(page: Page) {
  await page.getByRole('button', { name: 'Preferencias' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Agentes y API' }).click()
  await expect(page).toHaveURL(/\?view=agents$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agentes y API')
}

const card = (page: Page, name: string) => page.locator('.key-card', { has: page.getByRole('heading', { name, exact: true }) })
/** React Aria's switch: its input is hidden, the label takes the click. */
const flip = (page: Page, name: string) => page.locator('label.switch', { hasText: name }).click()
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

/** Leaves the switches as every other spec expects them: all off, as on a new vihko. */
async function resetSwitches(browser: Browser) {
  const page = await signIn(browser, ADMIN)
  const r = await page.request.put('/api/admin/integrations', { data: { api: false, mcp: false, membersCanCreateKeys: false, oauthRegistration: false } })
  expect(r.status()).toBe(200)
  await page.context().close()
}
test.afterAll(async ({ browser }) => resetSwitches(browser))

let token = ''

test('the admin turns on the API and the MCP server', async ({ browser }) => {
  const page = await signIn(browser, ADMIN)
  await openAgents(page)
  const mcp = page.getByRole('switch', { name: /Servidor MCP/ })
  const apiSwitch = page.getByRole('switch', { name: /API HTTP con claves/ })
  await expect(mcp).not.toBeChecked()
  await expect(apiSwitch).not.toBeChecked()
  // Where the MCP server answers, with this server's address.
  await expect(page.getByText(`${BASE_URL}/mcp`)).toBeVisible()
  // What an agent knows of a note hidden from it, in plain words.
  const hidden = page.locator('section', { has: page.getByRole('heading', { name: 'Notas ocultas a los agentes' }) })
  await expect(hidden).toContainText('Solo sabe que una existe si ya tiene su nombre')
  await flip(page, 'Servidor MCP')
  await expect(mcp).toBeChecked()
  await flip(page, 'API HTTP con claves')
  await expect(apiSwitch).toBeChecked()
  const now = await (await page.request.get('/api/integrations')).json()
  expect(now).toMatchObject({ api: true, mcp: true, locked: false })
  // Applied at once and kept: after a reload, still on.
  await page.reload()
  await expect(page.getByRole('switch', { name: /Servidor MCP/ })).toBeChecked()
  await page.context().close()
})

test('a read-only key for one folder: shown once, with its MCP configurations', async ({ browser }) => {
  const page = await signIn(browser, ADMIN)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await openAgents(page)
  await page.getByRole('button', { name: 'Nueva clave' }).click()
  const dialog = page.getByRole('dialog', { name: 'Nueva clave' })
  await dialog.getByLabel('Nombre').fill(KEY)
  // New keys: read-only, every folder, no expiry.
  await expect(dialog.getByRole('checkbox', { name: /Puede escribir/ })).not.toBeChecked()
  await expect(dialog.getByRole('radio', { name: 'Todas las carpetas que ves' })).toBeChecked()
  await expect(dialog.getByRole('combobox', { name: 'Caducidad' })).toHaveValue('none')
  await dialog.getByRole('radio', { name: /Solo estas carpetas/ }).check()
  await expect(dialog.getByRole('button', { name: 'Crear la clave' })).toBeDisabled()
  await expect(dialog.getByText('Elige al menos una carpeta.')).toBeVisible()
  await dialog.getByRole('checkbox', { name: 'proyectos', exact: true }).check()
  // A folder inside a chosen one is chosen with it.
  await expect(dialog.getByRole('checkbox', { name: 'vihko', exact: true })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: 'vihko', exact: true })).toBeDisabled()
  // Without a second factor, a new key is confirmed with the password (D-036), even with a session.
  await expect(dialog.getByRole('button', { name: 'Crear la clave' })).toBeDisabled()
  await expect(dialog.getByText('Una clave da acceso a tus notas: confirma que eres tú, aunque ya hayas entrado.')).toBeVisible()
  await dialog.getByLabel('Tu contraseña').fill(m.aPassword())
  await dialog.getByRole('button', { name: 'Crear la clave' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('La contraseña actual no es correcta.')
  await dialog.getByLabel('Tu contraseña').fill(ADMIN.password)
  await dialog.getByRole('button', { name: 'Crear la clave' }).click()

  const shown = page.getByRole('dialog', { name: `Clave para «${KEY}»` })
  await expect(shown.getByText('no se volverá a mostrar', { exact: false })).toBeVisible()
  token = (await shown.locator('.token').innerText()).trim()
  expect(token).toMatch(TOKEN)
  await shown.getByRole('button', { name: 'Copiar', exact: true }).click()
  await expect(shown.getByText('Copiado')).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token)

  // MCP configurations, ready to paste, with this server's address and the key.
  const block = shown.locator('.cfg-panel:not([hidden]) .cfg-block')
  await expect(block).toHaveText(`claude mcp add --transport http vihko ${BASE_URL}/mcp --header "Authorization: Bearer ${token}"`)
  await shown.getByRole('tab', { name: 'Claude Desktop' }).click()
  // The key goes in a file (never in the process list): its line, to copy, and the configuration naming the file.
  const desktop = JSON.parse(await shown.locator('.cfg-panel:not([hidden]) .cfg-block:not(.cfg-header)').innerText())
  expect(desktop.mcpServers.vihko).toEqual({
    command: 'npx',
    args: ['-y', 'mcp-remote', `${BASE_URL}/mcp`, '--header-file', '/ruta/completa/a/vihko-mcp.txt', '--allow-http'],
  })
  expect(JSON.stringify(desktop)).not.toContain(token)
  await expect(shown.getByLabel('La línea del archivo')).toHaveText(`Authorization: Bearer ${token}`)
  await shown.getByRole('button', { name: 'Copiar la línea del archivo' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`Authorization: Bearer ${token}`)
  await shown.getByRole('tab', { name: 'JSON genérico' }).click()
  const generic = JSON.parse(await block.innerText())
  expect(generic.mcpServers.vihko).toEqual({ type: 'http', url: `${BASE_URL}/mcp`, headers: { Authorization: `Bearer ${token}` } })
  await shown.getByRole('button', { name: 'Copiar configuración MCP' }).click()
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(generic)

  // On plain http in a home network there's no clipboard API: it copies by selection, inside the dialog.
  await page.evaluate(() => {
    (window as unknown as { realClipboard: Clipboard }).realClipboard = navigator.clipboard
    Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: true })
    Object.defineProperty(navigator, 'clipboard', { get: () => undefined, configurable: true })
  })
  await shown.getByRole('tab', { name: 'Claude Code' }).click()
  await shown.getByRole('button', { name: 'Copiar configuración MCP' }).click()
  await expect(shown.locator('.mcp-configs .copy-state')).toHaveText('Copiado')
  expect(await page.evaluate(() => (window as unknown as { realClipboard: Clipboard }).realClipboard.readText()))
    .toBe(`claude mcp add --transport http vihko ${BASE_URL}/mcp --header "Authorization: Bearer ${token}"`)
  await shown.screenshot({ path: `${SHOTS}/agents-token-light.png`, animations: 'disabled' })

  await shown.getByRole('button', { name: 'Ya la he guardado' }).click()
  const k = card(page, KEY)
  await expect(k).toContainText('Solo lectura')
  await expect(k).toContainText('proyectos/')
  await expect(k).toContainText('No caduca')
  await expect(k).toContainText('Nunca')
  await expect(k).toContainText(`vihko_…${token.slice(-4)}`)
  // Never again: not on the page, not from the server.
  await page.reload()
  await expect(card(page, KEY)).toBeVisible()
  expect(await page.content()).not.toContain(token)
  // The secret is everything after `vihko_<id>_`: base64url, so it may hold `_` itself.
  expect(await (await page.request.get('/api/keys')).text()).not.toContain(token.split('_').slice(2).join('_'))
  await page.screenshot({ path: `${SHOTS}/agents-light.png`, fullPage: true, animations: 'disabled' })
  await page.context().close()
})

test('the key works over HTTP: read-only in its folder; edited, it writes there and nowhere else', async ({ browser, request }) => {
  const tree = await request.get(`${BASE_URL}/api/tree`, { headers: bearer(token) })
  expect(tree.status()).toBe(200)
  const { notes } = await tree.json() as { notes: { path: string }[] }
  expect(notes.length).toBeGreaterThan(0)
  expect(notes.every((n) => n.path.startsWith('proyectos/'))).toBe(true)
  const write = await request.post(`${BASE_URL}/api/note`, { headers: bearer(token), data: { path: INSIDE, text: `${m.aSentence()}\n` } })
  expect(write.status()).toBe(403)

  const page = await signIn(browser, ADMIN)
  await page.goto('/?view=agents')
  await expect(card(page, KEY)).toContainText('por la API')

  // Edited: an expiry lets it do less, and asks nothing more.
  await card(page, KEY).getByRole('button', { name: 'Editar' }).click()
  const dialog = page.getByRole('dialog', { name: `Editar «${KEY}»` })
  await expect(dialog.getByRole('radio', { name: /Solo estas carpetas/ })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: 'proyectos', exact: true })).toBeChecked()
  await expect(dialog.getByRole('combobox', { name: 'Caducidad' })).toHaveValue('keep')
  await dialog.getByRole('combobox', { name: 'Caducidad' }).selectOption('7')
  await expect(dialog.getByLabel('Tu contraseña')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Guardar cambios' }).click()
  await expect(dialog).toBeHidden()
  await expect(card(page, KEY)).toContainText('Caduca el')
  // It may write now, still only in its folder: that lets it do more, and is confirmed as a new key is (D-046.2).
  await card(page, KEY).getByRole('button', { name: 'Editar' }).click()
  await dialog.getByRole('checkbox', { name: /Puede escribir/ }).check()
  const secret = dialog.getByLabel('Tu contraseña')
  await expect(secret).toBeVisible()
  await expect(dialog).toContainText('Con este cambio la clave podrá hacer más')
  await expect(dialog.getByRole('button', { name: 'Guardar cambios' })).toBeDisabled()
  await page.screenshot({ path: `${SHOTS}/agents-edit-wider.png`, animations: 'disabled' })
  await secret.fill(ADMIN.password)
  await dialog.getByRole('button', { name: 'Guardar cambios' }).click()
  await expect(dialog).toBeHidden()
  await expect(card(page, KEY)).toContainText('Lee y escribe')
  await expect(card(page, KEY)).toContainText('Caduca el')
  const written = await request.post(`${BASE_URL}/api/note`, { headers: bearer(token), data: { path: INSIDE, text: `${m.aSentence()}\n` } })
  expect(written.status()).toBe(201)
  const outside = await request.post(`${BASE_URL}/api/note`, { headers: bearer(token), data: { path: OUTSIDE, text: `${m.aSentence()}\n` } })
  expect(outside.status()).toBe(404)
  await page.context().close()
})

test('rotating asks first, shows the new key once, and the old one keeps working for a while', async ({ browser, request }) => {
  const page = await signIn(browser, ADMIN)
  await page.goto('/?view=agents')
  const before = await card(page, KEY).locator('.key-meta').innerText()
  await card(page, KEY).getByRole('button', { name: 'Rotar' }).click()
  const ask = page.getByRole('alertdialog', { name: `¿Rotar «${KEY}»?` })
  await expect(ask).toContainText('con sus permisos, sus carpetas y su nombre en el historial')
  await expect(ask).toContainText('seguirá funcionando 10 minutos')
  await ask.getByRole('button', { name: 'Cancelar' }).click()
  await expect(ask).toHaveCount(0)
  await card(page, KEY).getByRole('button', { name: 'Rotar' }).click()
  // A new secret is as good as a new key: confirmed the same way.
  await page.getByRole('alertdialog').getByLabel('Tu contraseña').fill(ADMIN.password)
  await page.getByRole('alertdialog').getByRole('button', { name: 'Rotar la clave' }).click()
  // The new key, once, as when it was created; and until when the old one works.
  const shown = page.getByRole('dialog', { name: `Clave para «${KEY}»` })
  await expect(shown.getByText('no se volverá a mostrar', { exact: false })).toBeVisible()
  await expect(shown.getByText(/La clave anterior sigue valiendo hasta las \d\d:\d\d; después, solo esta\./)).toBeVisible()
  const rotated = (await shown.locator('.token').innerText()).trim()
  expect(rotated).toMatch(TOKEN)
  expect(rotated).not.toBe(token)
  expect(rotated.slice(6, 32), 'the same key').toBe(token.slice(6, 32))
  await page.screenshot({ path: `${SHOTS}/keys-rotated-light.png`, animations: 'disabled' })
  await shown.getByRole('button', { name: 'Ya la he guardado' }).click()
  // Both work for now; the card says until when the old one does, and ends in the new one.
  for (const t of [token, rotated]) expect((await request.get(`${BASE_URL}/api/tree`, { headers: bearer(t) })).status()).toBe(200)
  const k = card(page, KEY)
  await expect(k).toContainText(/Clave anterior\s*vale hasta las \d\d:\d\d/)
  await expect(k).toContainText(`vihko_…${rotated.slice(-4)}`)
  expect(before).not.toContain('Clave anterior')
  await page.context().close()
  token = rotated
})

test('revoking asks first, and the key stops working at once', async ({ browser, request }) => {
  const page = await signIn(browser, ADMIN)
  await page.goto('/?view=agents')
  await card(page, KEY).getByRole('button', { name: 'Revocar' }).click()
  const ask = page.getByRole('alertdialog', { name: `¿Revocar «${KEY}»?` })
  await expect(ask).toContainText('No se puede deshacer')
  await ask.getByRole('button', { name: 'Cancelar' }).click()
  expect((await request.get(`${BASE_URL}/api/tree`, { headers: bearer(token) })).status()).toBe(200)
  await card(page, KEY).getByRole('button', { name: 'Revocar' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revocar la clave' }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect((await request.get(`${BASE_URL}/api/tree`, { headers: bearer(token) })).status()).toBe(401)
  // Revoked keys go to their own list, folded away.
  await expect(card(page, KEY)).toBeHidden()
  await page.locator('section', { has: page.getByRole('heading', { name: 'Tus claves' }) }).getByText(/^Revocadas \(\d+\)$/).click()
  await expect(card(page, KEY)).toContainText('Revocada')
  await expect(card(page, KEY).getByRole('button')).toHaveCount(0)
  await page.context().close()
})

test('members: no keys until the admin allows it; their own keys while allowed; with the setting off again, none new, and the admin revokes theirs', async ({ browser }) => {
  const member = await signIn(browser, MEMBER)
  await openAgents(member)
  // A member sees how things are, not the switches.
  await expect(member.getByRole('switch')).toHaveCount(0)
  await expect(member.getByText('El MCP está activado.')).toBeVisible()
  // Off by default: no «New key», and the API refuses it too.
  await expect(member.getByText('El administrador no permite que los miembros creen claves', { exact: false })).toBeVisible()
  await expect(member.getByRole('button', { name: 'Nueva clave' })).toHaveCount(0)
  expect((await member.request.post('/api/keys', { data: { confirm: MEMBER.password, name: REFUSED_KEY } })).status()).toBe(403)

  // The admin lets members create keys, from the page.
  const admin = await signIn(browser, ADMIN)
  await admin.goto('/?view=agents')
  const members = admin.getByRole('switch', { name: /Los miembros pueden crear claves/ })
  await expect(members).not.toBeChecked()
  await flip(admin, 'Los miembros pueden crear claves')
  await expect(members).toBeChecked()

  await member.reload()
  await member.getByRole('button', { name: 'Nueva clave' }).click()
  const dialog = member.getByRole('dialog', { name: 'Nueva clave' })
  await dialog.getByLabel('Nombre').fill(MEMBER_KEY)
  await dialog.getByRole('checkbox', { name: /Puede escribir/ }).check()
  await dialog.getByRole('combobox', { name: 'Caducidad' }).selectOption('30')
  await dialog.getByLabel('Tu contraseña').fill(MEMBER.password)
  await dialog.getByRole('button', { name: 'Crear la clave' }).click()
  await member.getByRole('button', { name: 'Ya la he guardado' }).click()
  await expect(card(member, MEMBER_KEY)).toContainText('Lee y escribe')
  await expect(card(member, MEMBER_KEY)).toContainText('Caduca el')

  await flip(admin, 'Los miembros pueden crear claves')
  await expect(members).not.toBeChecked()

  await member.reload()
  await expect(member.getByText('El administrador no permite que los miembros creen claves', { exact: false })).toBeVisible()
  await expect(member.getByRole('button', { name: 'Nueva clave' })).toHaveCount(0)
  // Her key still works and she may revoke it, but not change it.
  await expect(card(member, MEMBER_KEY).getByRole('button', { name: 'Editar' })).toHaveCount(0)
  await expect(card(member, MEMBER_KEY).getByRole('button', { name: 'Revocar' })).toBeVisible()
  const refused = await member.request.post('/api/keys', { data: { confirm: MEMBER.password, name: REFUSED_KEY } })
  expect(refused.status()).toBe(403)

  // The admin sees it, with its user, and revokes it.
  await admin.reload()
  const theirs = admin.locator('section', { has: admin.getByRole('heading', { name: 'Claves de los demás' }) })
  await expect(card(admin, MEMBER_KEY)).toContainText(`de ${MEMBER.username}`)
  await theirs.getByRole('button', { name: 'Revocar' }).click()
  const ask = admin.getByRole('alertdialog', { name: `¿Revocar «${MEMBER_KEY}»?` })
  await expect(ask).toContainText(`Es una clave de ${MEMBER.username}.`)
  await ask.getByRole('button', { name: 'Revocar la clave' }).click()
  await expect(theirs.getByText('Nadie más tiene claves activas.')).toBeVisible()
  await member.reload()
  await member.getByText(/^Revocadas \(\d+\)$/).click()
  await expect(card(member, MEMBER_KEY)).toContainText('Revocada')
  await member.context().close()
  await admin.context().close()
})

test('VIHKO_INTEGRATIONS=off: the switches are locked and say why', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: LOCKED_URL })
  const page = await ctx.newPage()
  await expect.poll(async () => (await page.request.get('/api/health').catch(() => null))?.status(), { timeout: 30_000 }).toBe(200)
  await login(page, ADMIN, '/?view=agents')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agentes y API')
  await expect(page.getByRole('note')).toContainText('VIHKO_INTEGRATIONS=off')
  for (const name of [/Servidor MCP/, /API HTTP con claves/]) {
    await expect(page.getByRole('switch', { name })).toBeDisabled()
    await expect(page.getByRole('switch', { name })).not.toBeChecked()
  }
  await expect(page.getByRole('switch', { name: /Los miembros pueden crear claves/ })).toBeEnabled()
  const refused = await page.request.put('/api/admin/integrations', { data: { mcp: true } })
  expect(refused.status()).toBe(409)
  expect((await refused.json()).error).toBe('integrations_locked')
  expect((await page.request.post('/mcp', { data: {} })).status()).toBe(404)
  // A key can still be made, and it says it won't work while the lock lasts.
  await page.getByRole('button', { name: 'Nueva clave' }).click()
  await page.getByRole('dialog').getByLabel('Nombre').fill(LOCKED_KEY)
  await page.getByRole('dialog').getByLabel('Tu contraseña').fill(ADMIN.password)
  await page.getByRole('dialog').getByRole('button', { name: 'Crear la clave' }).click()
  const shown = page.getByRole('dialog', { name: `Clave para «${LOCKED_KEY}»` })
  await expect(shown).toContainText('la clave no funcionará mientras sigan así')
  const locked = (await shown.locator('.token').innerText()).trim()
  expect((await page.request.get('/api/tree', { headers: bearer(locked) })).status()).toBe(404)
  await shown.getByRole('button', { name: 'Ya la he guardado' }).click()
  await page.screenshot({ path: `${SHOTS}/agents-locked.png`, fullPage: true, animations: 'disabled' })
  await ctx.close()
})

test('on a phone, in dark mode: the page, the dialog and the key fit', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'es-ES' })
  const page = await ctx.newPage()
  await login(page, ADMIN, '/?view=agents')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agentes y API')
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'light')
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  await expect.poll(wide).toBe(0)
  await page.screenshot({ path: `${SHOTS}/agents-mobile-dark.png`, fullPage: true, animations: 'disabled' })
  await page.getByRole('button', { name: 'Nueva clave' }).tap()
  const dialog = page.getByRole('dialog', { name: 'Nueva clave' })
  await dialog.getByLabel('Nombre').fill(PHONE_KEY)
  await dialog.getByRole('radio', { name: /Solo estas carpetas/ }).tap()
  await page.screenshot({ path: `${SHOTS}/agents-new-mobile-dark.png`, animations: 'disabled' })
  await dialog.getByRole('checkbox', { name: 'hogar', exact: true }).tap()
  await dialog.getByLabel('Tu contraseña').fill(ADMIN.password)
  await dialog.getByRole('button', { name: 'Crear la clave' }).tap()
  const shown = page.getByRole('dialog', { name: `Clave para «${PHONE_KEY}»` })
  await expect(shown.locator('.token')).toBeVisible()
  const copy = await shown.getByRole('button', { name: 'Copiar', exact: true }).boundingBox()
  expect(copy!.x + copy!.width).toBeLessThanOrEqual(390)
  expect(copy!.height).toBeGreaterThanOrEqual(44)
  await expect.poll(wide).toBe(0)
  await page.screenshot({ path: `${SHOTS}/agents-token-mobile-dark.png`, animations: 'disabled' })
  await shown.getByRole('button', { name: 'Ya la he guardado' }).tap()
  await card(page, PHONE_KEY).getByRole('button', { name: 'Revocar' }).tap()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revocar la clave' }).tap()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await ctx.close()
})

