// The privacy page: reached from Preferences and from «Agents and API», it
// says how things stand (nothing gets in or out with the integrations off;
// with them, which keys can read what), and what it promises holds: the UI
// only talks to its own server, no referrer goes to other sites, and a key
// can't have the server download an image.
import { expect, test, type Browser } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { ADMIN, BASE_URL, E2E_DIR, MEMBER, specMother } from './env.ts'
import { signIn } from './helpers.ts'

const SHOTS = `${E2E_DIR}/shots`
const m = specMother(import.meta.url)
/** The keys this spec makes: the admin's (reads `proyectos/` of the test vault) and the member's. */
const KEY = { admins: m.aKeyName(), members: m.aKeyName() }

test.describe.configure({ mode: 'serial' })
test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }))

async function admin(browser: Browser) {
  const page = await signIn(browser, ADMIN)
  return { page, request: page.request }
}
test.afterAll(async ({ browser }) => {
  const { page, request } = await admin(browser)
  for (const k of (await (await request.get('/api/keys?all=1')).json()).keys as { id: string; name: string; status: string }[]) {
    if ((k.name === KEY.admins || k.name === KEY.members) && k.status === 'active') await request.delete(`/api/keys/${k.id}`)
  }
  await request.put('/api/admin/integrations', { data: { api: false, mcp: false, membersCanCreateKeys: true } })
  await page.context().close()
})

test('with the integrations off, nothing gets in or out; and the UI talks only to its server', async ({ browser }) => {
  const page = await signIn(browser, ADMIN)
  const hosts = new Set<string>()
  page.on('request', (r) => { const u = new URL(r.url()); if (u.protocol !== 'data:' && u.protocol !== 'blob:') hosts.add(u.origin) })
  await page.getByRole('button', { name: 'Preferencias' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Privacidad' }).click()
  await expect(page).toHaveURL(/\?view=privacy$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacidad')
  const now = page.locator('section', { has: page.getByRole('heading', { name: 'Ahora mismo, en este servidor' }) })
  await expect(now).toContainText('La API y el MCP están apagados: ninguna clave funciona')
  await expect(page.getByText('vihko no envía estadísticas ni informes de errores, y no busca actualizaciones.')).toBeVisible()
  // What an agent knows of a note hidden from it, in plain words.
  await expect(page.getByText('Solo sabe que una existe si ya tiene su nombre', { exact: false })).toBeVisible()
  // External images are allowed on the test server, and the page says how to block them.
  await expect(page.getByText('VIHKO_EXTERNAL_IMAGES=block')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacidad')
  expect([...hosts]).toEqual([BASE_URL])

  // What the page promises, checked against the server: its CSP keeps the
  // browser on this origin (images aside), and no referrer leaves it.
  const res = await page.request.get('/')
  const csp = res.headers()['content-security-policy'] ?? ''
  expect(csp).toContain("default-src 'self'")
  expect(csp).toContain("connect-src 'self'")
  expect(csp).toMatch(/img-src 'self' data: blob: https: http:/)
  expect(res.headers()['referrer-policy']).toBe('same-origin')
  await page.context().close()
})

test('with them, the keys that can read and how; a key can’t download images', async ({ browser, request }) => {
  const k = await admin(browser)
  await k.request.put('/api/admin/integrations', { data: { api: true, mcp: true } })
  const mine = await (await k.request.post('/api/keys', { data: { confirm: ADMIN.password, name: KEY.admins, folders: ['proyectos'] } })).json() as { token: string }
  const member = await signIn(browser, MEMBER)
  const hers = await (await member.request.post('/api/keys', { data: { confirm: MEMBER.password, name: KEY.members, canWrite: true } })).json() as { token: string }
  expect((await request.get(`${BASE_URL}/api/tree`, { headers: { Authorization: `Bearer ${mine.token}` } })).status()).toBe(200)
  // Downloading an image by URL is only for a person who asks: a key doesn't even find the route.
  const fetchByKey = await request.post(`${BASE_URL}/api/attachments/fetch`, { headers: { Authorization: `Bearer ${hers.token}` }, data: { note: 'Plan.md', url: 'http://127.0.0.1:9/x.png' } })
  expect(fetchByKey.status()).toBe(404)

  // From «Agents and API», the link in its introduction.
  await k.page.goto('/?view=agents')
  await k.page.getByRole('link', { name: 'Qué sale de vihko y adónde' }).click()
  await expect(k.page).toHaveURL(/\?view=privacy$/)
  const now = k.page.locator('section', { has: k.page.getByRole('heading', { name: 'Ahora mismo, en este servidor' }) })
  await expect(now).toContainText('Integraciones activas: API · MCP. Estas claves pueden leer notas ahora mismo:')
  await expect(now.getByRole('listitem').filter({ hasText: KEY.admins })).toContainText('solo lee · en proyectos/ · último uso el')
  await expect(now.getByRole('listitem').filter({ hasText: KEY.admins })).toContainText('por la API')
  await expect(now.getByRole('listitem').filter({ hasText: KEY.members })).toContainText(`(de ${MEMBER.username}): lee y escribe · en todas las carpetas de su usuario · sin usar todavía`)
  await k.page.screenshot({ path: `${SHOTS}/privacy-light.png`, fullPage: true, animations: 'disabled' })

  // A member sees their own keys, and is told there may be others.
  await member.goto('/?view=privacy')
  const hersNow = member.locator('section', { has: member.getByRole('heading', { name: 'Ahora mismo, en este servidor' }) })
  await expect(hersNow).toContainText('Tus claves activas pueden leer esto')
  // Hers only (other specs may have left keys of hers; never the admin's).
  await expect(hersNow.getByRole('listitem').filter({ hasText: KEY.members }).first()).toBeVisible()
  await expect(hersNow).not.toContainText(KEY.admins)
  await k.page.getByRole('link', { name: 'Gestionar las claves en «Agentes y API»' }).click()
  await expect(k.page).toHaveURL(/\?view=agents$/)
  await member.context().close()
  await k.page.context().close()
})

test('on a phone, in dark mode', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'es-ES' })
  const page = await ctx.newPage()
  await page.goto('/?view=privacy')
  await page.getByLabel('Nombre de usuario').fill(ADMIN.username)
  await page.getByLabel('Contraseña').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Entrar' }).last().tap()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacidad')
  await expect(page.getByText('Estas claves pueden leer notas ahora mismo:')).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await page.screenshot({ path: `${SHOTS}/privacy-mobile-dark.png`, fullPage: true, animations: 'disabled' })
  await ctx.close()
})
