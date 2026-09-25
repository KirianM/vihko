// Avisos del espacio: lo que detecta el servidor en la carpeta de notas, las
// acciones según el rol y la cuenta de la barra lateral.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { E2E_DIR, NOTES } from './env.ts'
import { signIn } from './helpers.ts'

const DIR = `${NOTES}/e2e-avisos`
const SHOTS = `${E2E_DIR}/shots`

test.describe.configure({ mode: 'serial' })
test.beforeAll(() => mkdirSync(DIR, { recursive: true }))
// Las demás pruebas comparten carpeta de notas: se deja como estaba.
test.afterAll(() => rmSync(DIR, { recursive: true, force: true }))

const card = (page: Page, text: string) => page.locator('.alert-card', { hasText: text })
const sidebarCount = async (page: Page) => Number((await page.locator('.sidebar-alerts').innerText()).match(/\d+/)?.[0])

/** Recarga la página de avisos hasta que aparezca uno (el servidor reescanea cada 5 s). */
async function waitForCard(page: Page, text: string) {
  await expect(async () => {
    await page.reload()
    await expect(card(page, text)).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 20_000 })
}

test('uid repetido: aparece tras el reescaneo y se abren las dos notas', async ({ browser }) => {
  writeFileSync(`${DIR}/Original.md`, '---\nuid: E2E-AVISOS\n---\n# Original\n')
  writeFileSync(`${DIR}/Copia.md`, '---\nuid: E2E-AVISOS\n---\n# Copia\n')
  const k = await signIn(browser, 'noa')
  await k.locator('.sidebar-alerts').click()
  await expect(k).toHaveURL(/\?view=avisos$/)
  await expect(k.getByRole('heading', { level: 1 })).toHaveText('Avisos del espacio')
  await waitForCard(k, 'E2E-AVISOS')
  const uid = card(k, 'E2E-AVISOS')
  await expect(uid.getByRole('heading')).toHaveText('Mismo identificador en 2 notas')
  await expect(uid.getByRole('button')).toHaveCount(0) // se arregla en el frontmatter, no con un botón (D-015)
  await uid.getByRole('link', { name: 'e2e-avisos/Copia.md' }).click()
  await expect(k.locator('.crumbs b')).toHaveText('Copia')
  await expect(k).toHaveURL(/\?note=e2e-avisos%2FCopia\.md$/)
  await expect(k.locator('.cm-content')).toBeVisible()
  await k.goto('/?view=avisos')
  await card(k, 'E2E-AVISOS').getByRole('link', { name: 'e2e-avisos/Original.md' }).click()
  await expect(k.locator('.crumbs b')).toHaveText('Original')
  rmSync(`${DIR}/Copia.md`)
  await k.context().close()
})

test('copia pendiente de una nota borrada fuera: se conserva desde la página y la cuenta baja', async ({ browser }) => {
  const NOTE = 'e2e-avisos/Borrada.md'
  const file = `${NOTES}/${NOTE}`
  writeFileSync(file, '# Borrada\n')
  const k = await signIn(browser, 'noa', NOTE)
  await k.locator('.cm-content').click()
  await k.keyboard.press('Control+End')
  await k.keyboard.type('\nescrito antes del borrado')
  await expect.poll(() => (existsSync(file) ? readFileSync(file, 'utf8') : '')).toContain('antes del borrado')
  rmSync(file)
  await expect(k.getByRole('alert')).toContainText('se ha borrado fuera')

  // Se cierra el editor sin decidir: la copia queda como aviso (D-022).
  await k.goto('/?view=avisos')
  const orphan = card(k, 'Copia pendiente de «e2e-avisos / Borrada»')
  await expect(orphan).toBeVisible()
  const before = await sidebarCount(k)
  await orphan.getByRole('button', { name: 'Conservar la copia' }).click()
  await expect(orphan).toHaveCount(0)
  expect(readFileSync(file, 'utf8')).toContain('antes del borrado')
  await expect.poll(() => sidebarCount(k)).toBe(before - 1)
  await k.context().close()
})

test('conflicto de sincronización: ver la copia y abrir la nota; un miembro también lo ve', async ({ browser }) => {
  const a = await signIn(browser, 'ana')
  await a.goto('/?view=avisos')
  const sync = card(a, 'Conflicto de sincronización')
  await expect(sync).toContainText('Plan.sync-conflict-20260924-120000-ABCDEFG.md')
  await expect(sync).toContainText('proyectos / thoth / Plan')
  await sync.getByRole('button', { name: 'Ver la copia' }).click()
  await expect(sync.locator('pre')).toContainText(/\S/)
  await sync.getByRole('button', { name: 'Ocultar la copia' }).click()
  await expect(sync.locator('pre')).toHaveCount(0)
  await sync.getByRole('button', { name: 'Abrir la nota' }).click()
  await expect(a.locator('.crumbs b')).toHaveText('Plan')
  await a.context().close()
})

// El borrado masivo es difícil de provocar sin romper las demás pruebas (se
// prueba contra el servidor en http.test.ts): aquí se simula la respuesta.
const SCAN = { code: 'scan_aborted_mass_delete', removing: 214, total: 260 }
const FIXTURE = [
  { ...SCAN, actions: ['rescan', 'confirm_removal'] },
  { code: 'orphaned_note', path: 'hogar/Proxy.md', actions: ['keep_copy', 'discard_copy'] },
  { code: 'uid_conflict', uid: '01J8X4M2K9QZ', paths: ['uid/copia.md', 'uid/original.md'], actions: [] },
  { code: 'sync_conflict', path: 'proyectos/thoth/Plan.sync-conflict-20260924-120000-ABCDEFG.md', note: 'proyectos/thoth/Plan.md', actions: [] },
]
const mockAlerts = (page: Page, alerts: unknown[]) =>
  page.route('**/api/alerts', (route) => route.fulfill({ json: { alerts } }))

test('escaneo detenido: el admin confirma con la cifra que ve; un miembro no tiene acciones', async ({ browser }) => {
  const k = await signIn(browser, 'noa')
  await mockAlerts(k, FIXTURE)
  let sent: unknown = null
  await k.route('**/api/admin/rescan', async (route) => {
    sent = route.request().postDataJSON()
    await route.fulfill({ json: { aborted: null } })
  })
  await k.goto('/?view=avisos')
  const scan = card(k, 'Escaneo detenido')
  await expect(scan.getByRole('heading')).toHaveText('Escaneo detenido: iba a retirar 214 notas de 260')
  await scan.getByRole('button', { name: 'Sí, las he borrado yo' }).click()
  await expect.poll(() => sent).toEqual({ confirmRemoval: 214 })
  await scan.getByRole('button', { name: 'Volver a comprobar' }).click()
  await expect.poll(() => sent).toEqual({})
  await k.context().close()

  const a = await signIn(browser, 'ana')
  await mockAlerts(a, [{ ...SCAN, actions: [] }])
  await a.goto('/?view=avisos')
  const member = card(a, 'Escaneo detenido')
  await expect(member).toContainText('Lo decide un administrador.')
  await expect(member.getByRole('button')).toHaveCount(0)
  await a.context().close()
})

test('estado vacío', async ({ browser }) => {
  const k = await signIn(browser, 'noa')
  await mockAlerts(k, [])
  await k.goto('/?view=avisos')
  await expect(k.getByText('No hay avisos')).toBeVisible()
  await expect(k.locator('.sidebar-alerts')).toHaveCount(0)
  await k.context().close()
})

test('capturas: claro, oscuro y móvil', async ({ browser }) => {
  const k = await signIn(browser, 'noa')
  await mockAlerts(k, FIXTURE)
  await k.setViewportSize({ width: 1440, height: 900 })
  await k.goto('/?view=avisos')
  await expect(card(k, 'Escaneo detenido')).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/avisos-claro.png`, fullPage: true })
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await card(k, 'Conflicto de sincronización').getByRole('button', { name: 'Ver la copia' }).click()
  await expect(k.locator('.alert-copy')).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/avisos-oscuro.png`, fullPage: true })
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
  await k.setViewportSize({ width: 390, height: 844 })
  await k.screenshot({ path: `${SHOTS}/avisos-movil.png`, fullPage: true })
  expect(await k.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await k.context().close()
})
