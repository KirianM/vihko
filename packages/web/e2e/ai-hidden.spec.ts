// A note hidden from agents (`ai: false`, D-014) says so, discreetly, in its
// header, with why on hover (or on a press, on a phone). An unreadable
// frontmatter hides it the same way, and says so. It follows the text: a
// change to the frontmatter shows or removes it once saved. And it is true:
// a key doesn't find the note.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { BASE_URL, E2E_DIR, PASSWORD } from './env.ts'
import { signIn } from './helpers.ts'

const SHOTS = `${E2E_DIR}/shots`
const LIVE = 'e2e-oculta/Cambia.md'

test.describe.configure({ mode: 'serial' })
test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }))

const badge = (page: Page) => page.getByRole('button', { name: 'Oculta a los agentes' })
const open = async (page: Page, path: string) => {
  await page.goto(`/?note=${encodeURIComponent(path)}`)
  await expect(page.locator('.cm-content')).toBeVisible()
}

test('ai: false and an unreadable frontmatter show it, with why; other notes don’t', async ({ browser, request }) => {
  const page = await signIn(browser, 'noa')
  await open(page, 'privado/sin-ia.md')
  await expect(badge(page)).toBeVisible()
  // React Aria shows tooltips on hover once it knows a mouse is in use (after a first press on the page).
  await page.locator('.crumbs b').click()
  await badge(page).hover()
  await expect(page.getByRole('tooltip')).toContainText('Esta nota tiene ai: false en el frontmatter')
  await page.screenshot({ path: `${SHOTS}/ai-hidden-light.png`, animations: 'disabled' })
  await page.mouse.move(0, 0)
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  // A press says it too (on a phone there is no hover).
  await badge(page).click()
  await expect(page.getByRole('dialog', { name: 'Oculta a los agentes' })).toContainText('Para los agentes no existe.')
  await page.keyboard.press('Escape')

  await open(page, 'frontmatter/invalido.md')
  await page.locator('.crumbs b').click()
  await badge(page).hover()
  await expect(page.getByRole('tooltip')).toContainText('no se puede leer')

  await open(page, 'Plan.md')
  await expect(page.locator('.cm-content')).toContainText('Plan')
  await expect(badge(page)).toHaveCount(0)

  // What it says holds: a key doesn't find the note.
  await page.request.put('/api/admin/integrations', { data: { api: true } })
  const { key, token } = await (await page.request.post('/api/keys', { data: { name: 'Oculta e2e' } })).json() as { key: { id: string }; token: string }
  const auth = { Authorization: `Bearer ${token}` }
  expect((await request.get(`${BASE_URL}/api/note?path=${encodeURIComponent('privado/sin-ia.md')}`, { headers: auth })).status()).toBe(404)
  expect((await request.get(`${BASE_URL}/api/note?path=${encodeURIComponent('frontmatter/invalido.md')}`, { headers: auth })).status()).toBe(404)
  expect((await request.get(`${BASE_URL}/api/note?path=Plan.md`, { headers: auth })).status()).toBe(200)
  await page.request.delete(`/api/keys/${key.id}`)
  await page.request.put('/api/admin/integrations', { data: { api: false } })
  await page.context().close()
})

test('it follows the frontmatter: shown once ai: false is saved, gone once it isn’t', async ({ browser }) => {
  const page = await signIn(browser, 'noa')
  const created = await page.request.post('/api/note', { data: { path: LIVE, text: '---\nai: true\n---\n# Cambia\n\nTexto.\n' } })
  expect(created.status()).toBe(201)
  await open(page, LIVE)
  await expect(page.locator('.cm-content')).toContainText('Texto.')
  await expect(badge(page)).toHaveCount(0)
  // Changed while it is open (by the same person in another tab: an edit by operation).
  const edit = (find: string, replace: string) => page.request.post('/api/note/edit', { data: { path: LIVE, ops: [{ op: 'find_replace', find, replace }] } })
  expect((await edit('ai: true', 'ai: false')).status()).toBe(200)
  await expect(badge(page)).toBeVisible({ timeout: 10_000 })
  expect((await edit('ai: false', 'ai: yes')).status()).toBe(200)
  await expect(badge(page)).toHaveCount(0, { timeout: 10_000 })
  await page.context().close()
})

test('on a phone, in dark mode: the icon alone, and a press says why', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'es-ES' })
  const page = await ctx.newPage()
  await page.goto(`/?note=${encodeURIComponent('privado/sin-ia.md')}`)
  await page.getByLabel('Nombre de usuario').fill('noa')
  await page.getByLabel('Contraseña').fill(PASSWORD)
  await page.getByRole('button', { name: 'Entrar' }).last().tap()
  await expect(badge(page)).toBeVisible()
  const box = (await badge(page).boundingBox())!
  expect(box.width).toBeGreaterThanOrEqual(44)
  expect(box.height).toBeGreaterThanOrEqual(44)
  await badge(page).tap()
  await expect(page.getByRole('dialog', { name: 'Oculta a los agentes' })).toContainText('ninguna clave')
  await page.screenshot({ path: `${SHOTS}/ai-hidden-mobile-dark.png`, animations: 'disabled' })
  await ctx.close()
})
