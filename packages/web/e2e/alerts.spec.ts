// Workspace alerts: what the server detects in the notes folder, the actions
// depending on role, and the sidebar count.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { E2E_DIR, NOTES } from './env.ts'
import { signIn } from './helpers.ts'

const DIR = `${NOTES}/e2e-avisos`
const SHOTS = `${E2E_DIR}/shots`

test.describe.configure({ mode: 'serial' })
test.beforeAll(() => mkdirSync(DIR, { recursive: true }))
// The other tests share the notes folder: it's left as it was.
test.afterAll(() => rmSync(DIR, { recursive: true, force: true }))

const card = (page: Page, text: string) => page.locator('.alert-card', { hasText: text })
const sidebarCount = async (page: Page) => Number((await page.locator('.sidebar-alerts').innerText()).match(/\d+/)?.[0])

/** Reloads the alerts page until one appears (the server rescans every 5s). */
async function waitForCard(page: Page, text: string) {
  await expect(async () => {
    await page.reload()
    await expect(card(page, text)).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 20_000 })
}

test('duplicate uid: appears after the rescan and both notes open', async ({ browser }) => {
  writeFileSync(`${DIR}/Original.md`, '---\nuid: E2E-AVISOS\n---\n# Original\n')
  writeFileSync(`${DIR}/Copia.md`, '---\nuid: E2E-AVISOS\n---\n# Copia\n')
  const k = await signIn(browser, 'noa')
  await k.locator('.sidebar-alerts').click()
  await expect(k).toHaveURL(/\?view=avisos$/)
  await expect(k.getByRole('heading', { level: 1 })).toHaveText('Avisos del espacio')
  await waitForCard(k, 'E2E-AVISOS')
  const uid = card(k, 'E2E-AVISOS')
  await expect(uid.getByRole('heading')).toHaveText('Mismo identificador en 2 notas')
  await expect(uid.getByRole('button')).toHaveCount(0) // fixed in the frontmatter, not with a button
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

test('pending copy of a note deleted externally: kept from the page and the count drops', async ({ browser }) => {
  const NOTE = 'e2e-avisos/Borrada.md'
  const file = `${NOTES}/${NOTE}`
  writeFileSync(file, '# Borrada\n')
  const k = await signIn(browser, 'noa', NOTE)
  await k.locator('.cm-content').click()
  await k.keyboard.press('Control+End')
  await k.keyboard.type('\nescrito antes del borrado')
  await expect.poll(() => (existsSync(file) ? readFileSync(file, 'utf8') : '')).toContain('antes del borrado')
  rmSync(file)
  await expect(k.getByRole('alert')).toContainText('se ha borrado fuera', { timeout: 15_000 }) // after the grace for a move (6 s)

  // The editor is closed without deciding: the copy stays as an alert.
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

test('sync conflict: viewing the copy and opening the note; a member sees it too', async ({ browser }) => {
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

// Mass deletion is hard to trigger without breaking the other tests (it's
// tested against the server in http.test.ts): here the response is mocked.
const SCAN = { code: 'scan_aborted_mass_delete', removing: 214, total: 260 }
const FIXTURE = [
  { ...SCAN, actions: ['rescan', 'confirm_removal'] },
  { code: 'orphaned_note', path: 'hogar/Proxy.md', actions: ['keep_copy', 'discard_copy'] },
  { code: 'uid_conflict', uid: '01J8X4M2K9QZ', paths: ['uid/copia.md', 'uid/original.md'], actions: [] },
  { code: 'sync_conflict', path: 'proyectos/thoth/Plan.sync-conflict-20260924-120000-ABCDEFG.md', note: 'proyectos/thoth/Plan.md', actions: [] },
]
const mockAlerts = (page: Page, alerts: unknown[]) =>
  page.route('**/api/alerts', (route) => route.fulfill({ json: { alerts } }))

test('scan stopped: the admin confirms with the figure they see; a member has no actions', async ({ browser }) => {
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

test('history alerts: git failing (with its detail), versions merged at the cap, files over the limit, no repository in unmanaged mode', async ({ browser }) => {
  const k = await signIn(browser, 'noa')
  const big = Array.from({ length: 12 }, (_, i) => `videos/clip-${i}.mp4`)
  await mockAlerts(k, [
    { code: 'history_unavailable', detail: 'git fast-import exited with 128: fatal: write error: No space left on device', actions: [] },
    { code: 'history_versions_merged', versions: 37, since: '2026-03-14T09:30:00Z', actions: [] },
    { code: 'history_files_too_large', paths: big, limitMb: 20, actions: [] },
    { code: 'history_no_repository', actions: [] },
  ])
  await k.goto('/?view=avisos')
  const git = card(k, 'no puede guardar versiones')
  await expect(git).toContainText('Las notas se siguen guardando con normalidad')
  await expect(git.locator('.alert-copy')).toBeHidden()
  await git.getByText('Detalle para quien administra thoth').click()
  await expect(git.locator('.alert-copy')).toContainText('No space left on device')
  const merged = card(k, 'ha juntado')
  await expect(merged.getByRole('heading')).toHaveText('El historial ha juntado 37 versiones')
  // The date in the person's timezone: 14 March, whatever the hour there.
  await expect(merged).toContainText(/Desde el 14 mar/)
  await expect(merged).toContainText('no se pierde texto ni autores')
  const large = card(k, 'no entran en el historial')
  await expect(large.getByRole('heading')).toHaveText('12 archivos no entran en el historial')
  await expect(large).toContainText('límite de 20 MB')
  await expect(large.locator('li')).toHaveCount(11) // ten paths and «and 2 more»
  await expect(large).toContainText('y 2 más')
  await expect(card(k, 'no tiene repositorio git')).toContainText('history.mode: unmanaged')
  await k.setViewportSize({ width: 1440, height: 900 })
  await k.screenshot({ path: `${SHOTS}/avisos-historial.png`, fullPage: true, animations: 'disabled' })
  await k.context().close()
})

test('agents without a managed history: which door is open and what it means', async ({ browser }) => {
  const k = await signIn(browser, 'noa')
  await mockAlerts(k, [{ code: 'integrations_unversioned', mode: 'unmanaged', api: true, mcp: true, actions: [] }])
  await k.goto('/?view=avisos')
  const both = card(k, 'sin historial gestionado')
  await expect(both.getByRole('heading')).toHaveText('La API y el MCP están activos sin historial gestionado')
  await expect(both).toContainText('history.mode: unmanaged')
  await expect(both).toContainText('cambia el modo a managed')
  await expect(both.getByRole('button')).toHaveCount(0)
  await k.setViewportSize({ width: 1440, height: 900 })
  await k.screenshot({ path: `${SHOTS}/avisos-agentes.png`, fullPage: true, animations: 'disabled' })
  await k.unrouteAll({ behavior: 'ignoreErrors' })
  await mockAlerts(k, [{ code: 'integrations_unversioned', mode: 'off', api: false, mcp: true, actions: [] }])
  await k.reload()
  const mcp = card(k, 'sin historial gestionado')
  await expect(mcp.getByRole('heading')).toHaveText('El MCP está activo sin historial gestionado')
  await expect(mcp).toContainText('history.mode: off')
  await k.context().close()
})

test('empty state', async ({ browser }) => {
  const k = await signIn(browser, 'noa')
  await mockAlerts(k, [])
  await k.goto('/?view=avisos')
  await expect(k.getByText('No hay avisos')).toBeVisible()
  await expect(k.locator('.sidebar-alerts')).toHaveCount(0)
  await k.context().close()
})

test('screenshots: light, dark and mobile', async ({ browser }) => {
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
