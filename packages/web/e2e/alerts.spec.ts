// Workspace alerts: what the server detects in the notes folder, the actions
// depending on role, and the sidebar count.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ADMIN, E2E_DIR, MEMBER, NOTES, freshFolder, specMother } from './env.ts'
import { literally, signIn, usePermissions } from './helpers.ts'

const m = specMother(import.meta.url)
/** A path as the UI shows it: `a/b.md` → `a / b`. */
const label = (path: string) => path.replace(/\.md$/i, '').split('/').join(' / ')

const FOLDER = freshFolder(() => m.aFolder())
const DIR = `${NOTES}/${FOLDER}`
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
  const [original, copy] = [m.aTitle(), m.aTitle()]
  const uid = m.aUniqueWord().toUpperCase()
  writeFileSync(`${DIR}/${original}.md`, `---\nuid: ${uid}\n---\n# ${original}\n`)
  writeFileSync(`${DIR}/${copy}.md`, `---\nuid: ${uid}\n---\n# ${copy}\n`)
  const k = await signIn(browser, ADMIN)
  await k.locator('.sidebar-alerts').click()
  await expect(k).toHaveURL(/\?view=alerts$/)
  await expect(k.getByRole('heading', { level: 1 })).toHaveText('Avisos del espacio')
  await waitForCard(k, uid)
  const both = card(k, uid)
  await expect(both.getByRole('heading')).toHaveText('Mismo identificador en 2 notas')
  await expect(both.getByRole('button')).toHaveCount(0) // fixed in the frontmatter, not with a button
  await both.getByRole('link', { name: `${FOLDER}/${copy}.md` }).click()
  await expect(k.locator('.crumbs b')).toHaveText(copy)
  await expect(k).toHaveURL(new RegExp(`\\?note=${literally(encodeURIComponent(`${FOLDER}/${copy}.md`)).replace(/%20/g, '(?:\\+|%20)')}$`))
  await expect(k.locator('.cm-content')).toBeVisible()
  await k.goto('/?view=alerts')
  await card(k, uid).getByRole('link', { name: `${FOLDER}/${original}.md` }).click()
  await expect(k.locator('.crumbs b')).toHaveText(original)
  rmSync(`${DIR}/${copy}.md`)
  await k.context().close()
})

test('pending copy of a note deleted externally: kept from the page and the count drops', async ({ browser }) => {
  const NOTE = m.aNotePath(FOLDER)
  const file = `${NOTES}/${NOTE}`
  const typed = m.aUniqueWord()
  writeFileSync(file, `# ${m.aHeading()}\n`)
  const k = await signIn(browser, ADMIN, NOTE)
  await k.locator('.cm-content').click()
  await k.keyboard.press('Control+End')
  await k.keyboard.type(`\n${typed}`)
  await expect.poll(() => (existsSync(file) ? readFileSync(file, 'utf8') : '')).toContain(typed)
  rmSync(file)
  await expect(k.getByRole('alert')).toContainText('se ha borrado fuera', { timeout: 15_000 }) // after the grace for a move (6 s)

  // The editor is closed without deciding: the copy stays as an alert.
  await k.goto('/?view=alerts')
  const orphan = card(k, `Copia pendiente de «${label(NOTE)}»`)
  await expect(orphan).toBeVisible()
  const before = await sidebarCount(k)
  await orphan.getByRole('button', { name: 'Conservar la copia' }).click()
  await expect(orphan).toHaveCount(0)
  expect(readFileSync(file, 'utf8')).toContain(typed)
  await expect.poll(() => sidebarCount(k)).toBe(before - 1)
  await k.context().close()
})

test('sync conflict: viewing the copy and opening the note; a member sees it too', async ({ browser }) => {
  const a = await signIn(browser, MEMBER)
  await a.goto('/?view=alerts')
  const sync = card(a, 'Conflicto de sincronización')
  await expect(sync).toContainText('Plan.sync-conflict-20260924-120000-ABCDEFG.md')
  await expect(sync).toContainText('proyectos / vihko / Plan')
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
// The fixture's notes are the test vault's.
const removing = m.anInt(2, 900)
const SCAN = { code: 'scan_aborted_mass_delete', removing, total: removing + m.anInt(1, 900) }
const FIXTURE = [
  { ...SCAN, actions: ['rescan', 'confirm_removal'] },
  { code: 'orphaned_note', path: 'hogar/Proxy.md', actions: ['keep_copy', 'discard_copy'] },
  { code: 'uid_conflict', uid: '01J8X4M2K9QZ', paths: ['uid/copia.md', 'uid/original.md'], actions: [] },
  { code: 'sync_conflict', path: 'proyectos/vihko/Plan.sync-conflict-20260924-120000-ABCDEFG.md', note: 'proyectos/vihko/Plan.md', actions: [] },
]
const mockAlerts = (page: Page, alerts: unknown[]) =>
  page.route('**/api/alerts', (route) => route.fulfill({ json: { alerts } }))

test('scan stopped: the admin confirms with the figure they see; a member has no actions', async ({ browser }) => {
  const k = await signIn(browser, ADMIN)
  await mockAlerts(k, FIXTURE)
  let sent: unknown = null
  await k.route('**/api/admin/rescan', async (route) => {
    sent = route.request().postDataJSON()
    await route.fulfill({ json: { aborted: null } })
  })
  await k.goto('/?view=alerts')
  const scan = card(k, 'Escaneo detenido')
  await expect(scan.getByRole('heading')).toHaveText(`Escaneo detenido: iba a retirar ${SCAN.removing} notas de ${SCAN.total}`)
  await scan.getByRole('button', { name: 'Sí, las he borrado yo' }).click()
  await expect.poll(() => sent).toEqual({ confirmRemoval: SCAN.removing })
  await scan.getByRole('button', { name: 'Volver a comprobar' }).click()
  await expect.poll(() => sent).toEqual({})
  await k.context().close()

  const a = await signIn(browser, MEMBER)
  await mockAlerts(a, [{ ...SCAN, actions: [] }])
  await a.goto('/?view=alerts')
  const member = card(a, 'Escaneo detenido')
  await expect(member).toContainText('Lo decide un administrador.')
  await expect(member.getByRole('button')).toHaveCount(0)
  await a.context().close()
})

test('history alerts: git failing (with its detail), versions merged at the cap, files over the limit, no repository in unmanaged mode', async ({ browser }) => {
  const k = await signIn(browser, ADMIN)
  // Twelve files: ten are listed, and «and 2 more».
  const folder = m.aFolder()
  const big = Array.from({ length: 12 }, () => `${folder}/${m.aTitle()}.mp4`)
  const detail = m.aSentence()
  const versions = m.anInt(2, 999)
  const limitMb = m.anInt(1, 100)
  await mockAlerts(k, [
    { code: 'history_unavailable', detail, actions: [] },
    // Shown as a date in the admin's timezone (the browser's UTC, or UTC+14 from daily.spec): the 14th either way.
    { code: 'history_versions_merged', versions, since: '2026-03-14T09:30:00Z', actions: [] },
    { code: 'history_files_too_large', paths: big, limitMb, actions: [] },
    { code: 'history_no_repository', actions: [] },
  ])
  await k.goto('/?view=alerts')
  const git = card(k, 'no puede guardar versiones')
  await expect(git).toContainText('Las notas se siguen guardando con normalidad')
  await expect(git.locator('.alert-copy')).toBeHidden()
  await git.getByText('Detalle para quien administra vihko').click()
  await expect(git.locator('.alert-copy')).toContainText(detail)
  const merged = card(k, 'ha juntado')
  await expect(merged.getByRole('heading')).toHaveText(`El historial ha juntado ${versions} versiones`)
  // The date in the person's timezone: 14 March, whatever the hour there.
  await expect(merged).toContainText(/Desde el 14 mar/)
  await expect(merged).toContainText('no se pierde texto ni autores')
  const large = card(k, 'no entran en el historial')
  await expect(large.getByRole('heading')).toHaveText('12 archivos no entran en el historial')
  await expect(large).toContainText(`límite de ${limitMb} MB`)
  await expect(large.locator('li')).toHaveCount(11) // ten paths and «and 2 more»
  await expect(large).toContainText('y 2 más')
  await expect(card(k, 'no tiene repositorio git')).toContainText('history.mode: unmanaged')
  await k.setViewportSize({ width: 1440, height: 900 })
  await k.screenshot({ path: `${SHOTS}/avisos-historial.png`, fullPage: true, animations: 'disabled' })
  await k.context().close()
})

test('agents without a managed history: which door is open and what it means', async ({ browser }) => {
  const k = await signIn(browser, ADMIN)
  await mockAlerts(k, [{ code: 'integrations_unversioned', mode: 'unmanaged', api: true, mcp: true, actions: [] }])
  await k.goto('/?view=alerts')
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

test('permissions: rejected, notes held after a move outside vihko, and images all in one folder', async ({ browser }) => {
  const k = await signIn(browser, ADMIN)
  const parent = m.aFolder()
  const held = { id: m.aSecret(8), folder: `${parent}/${m.aFolder()}`, to: `${parent}/${m.aFolder()}`, notes: m.anInt(2, 40) }
  await mockAlerts(k, [
    { code: 'permissions_rejected', fallback: 'closed', actions: [] },
    { code: 'permissions_held', ...held, personal: false, actions: ['move_permissions', 'release'] },
    // One note, without a destination: nothing to move the permissions to (the owner of the personal folder it came from sees it so).
    { code: 'permissions_held', id: m.aSecret(8), folder: `${m.aFolder()}/${m.aUsername()}`, to: null, notes: 1, personal: true, actions: ['release'] },
    { code: 'attachments_shared_folder', folder: m.aFolder(), actions: [] },
  ])
  const sent: { url: string; body: unknown }[] = []
  await k.route('**/api/permissions/holds/*', (route) => { sent.push({ url: route.request().url(), body: route.request().postDataJSON() }); return route.fulfill({ json: { ok: true } }) })
  await k.goto('/?view=alerts')
  const rejected = card(k, 'no se pueden usar')
  await expect(rejected.getByRole('heading')).toHaveText('Los permisos de vihko.yaml no se pueden usar')
  await expect(rejected).toContainText('nadie puede leer ninguna nota')
  const many = card(k, `${held.notes} notas retenidas`)
  await expect(many).toContainText(held.folder)
  await expect(many).toContainText(held.to)
  await many.getByRole('button', { name: 'Mover sus permisos' }).click()
  await expect.poll(() => sent.length).toBe(1)
  expect(sent[0]).toEqual({ url: expect.stringMatching(new RegExp(`/api/permissions/holds/${held.id}$`)), body: { action: 'move_permissions' } })
  const one = card(k, 'Una nota retenida')
  await expect(one.getByRole('button', { name: 'Mover sus permisos' })).toHaveCount(0)
  await one.getByRole('button', { name: 'Soltarlas' }).click()
  await expect.poll(() => sent.length).toBe(2)
  expect(sent[1]!.body).toEqual({ action: 'release' })
  await expect(card(k, 'Las imágenes nuevas van todas a')).toContainText('per-note')
  await k.setViewportSize({ width: 1440, height: 900 })
  await k.screenshot({ path: `${SHOTS}/avisos-permisos.png`, fullPage: true, animations: 'disabled' })
  await k.setViewportSize({ width: 390, height: 844 })
  expect(await k.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await k.context().close()
})

test('notes held after leaving a personal folder: its owner releases them; the admin is told they exist, and nothing more', async ({ browser }) => {
  test.setTimeout(120_000)
  // A `{user}` rule inside the spec's folder: the member's personal folder, with a note (and its uid) that another program moves out.
  const people = `${FOLDER}/${m.aFolder()}`
  const mine = `${people}/${MEMBER.username}`
  const title = m.aTitle()
  const word = m.aUniqueWord()
  const from = `${mine}/${m.aFolder()}/${title}.md`
  const landed = `${FOLDER}/${m.aFolder()}/${title}.md`
  const owner = await signIn(browser, MEMBER)
  const admin = await signIn(browser, ADMIN)
  /** Whether vihko has read vihko.yaml with the `{user}` rule (the root's grants stay the same: usePermissions can't tell). */
  const personalRule = async () => {
    const r = await admin.request.get(`/api/permissions?folder=${encodeURIComponent(mine)}`)
    return r.ok() && (await r.json()).userRule !== null
  }
  await usePermissions({ rules: { [`${people}/{user}`]: { '{user}': 'manage' } } })
  try {
    await expect.poll(personalRule, { timeout: 15_000 }).toBe(true)
    mkdirSync(dirname(`${NOTES}/${from}`), { recursive: true })
    writeFileSync(`${NOTES}/${from}`, `---\nuid: ${m.faker.string.ulid()}\n---\n# ${title}\n\n${m.aSentence()} ${word}.\n`)
    const note = (path: string) => `/api/note?path=${encodeURIComponent(path)}`
    // Indexed (the tree lists it): only a note vihko knew can be recognised where it lands.
    const indexed = async () => ((await (await owner.request.get('/api/tree')).json()).notes as { path: string }[]).some((n) => n.path === from)
    await expect.poll(indexed, { timeout: 20_000 }).toBe(true)
    mkdirSync(dirname(`${NOTES}/${landed}`), { recursive: true })
    renameSync(`${NOTES}/${from}`, `${NOTES}/${landed}`)

    // The admin: one held note from that personal folder, whose it is to decide, and no button.
    await admin.goto('/?view=alerts')
    await waitForCard(admin, mine)
    const told = card(admin, mine)
    await expect(told.getByRole('heading')).toHaveText('Una nota retenida tras moverse fuera de vihko')
    await expect(told).toContainText('Salieron de una carpeta personal')
    await expect(told).toContainText('solo ella puede soltarlas')
    await expect(told.getByRole('button')).toHaveCount(0)
    await expect(told).not.toContainText(word)
    await expect(told).not.toContainText(`${title}.md`)
    await admin.setViewportSize({ width: 1440, height: 900 })
    await admin.screenshot({ path: `${SHOTS}/avisos-retenida-personal.png`, fullPage: true, animations: 'disabled' })
    // Nor through the API.
    const held = ((await (await admin.request.get('/api/alerts')).json()).alerts as { code: string; id: string; folder: string }[])
      .find((a) => a.code === 'permissions_held' && a.folder === mine)!
    const refused = await admin.request.post(`/api/permissions/holds/${held.id}`, { data: { action: 'release' } })
    expect([refused.status(), (await refused.json()).error]).toEqual([403, 'hold_owner_only'])
    expect((await admin.request.get(note(landed))).status()).toBe(404)

    // The owner: the same alert, with «Release them».
    await owner.goto('/?view=alerts')
    await waitForCard(owner, mine)
    const theirs = card(owner, mine)
    await expect(theirs).not.toContainText('Salieron de una carpeta personal')
    await expect(theirs.getByRole('button', { name: 'Mover sus permisos' })).toHaveCount(0)
    await theirs.getByRole('button', { name: 'Soltarlas' }).click()
    await expect(theirs).toHaveCount(0)
    // Released: the folder it's in applies (the member edits there), and the admin's alert is gone.
    await owner.goto(`/?note=${encodeURIComponent(landed)}`)
    await expect(owner.locator('.cm-content')).toContainText(word)
    await admin.goto('/?view=alerts')
    await expect(card(admin, mine)).toHaveCount(0)
  } finally {
    await usePermissions()
    await expect.poll(personalRule, { timeout: 15_000 }).toBe(false)
    await owner.context().close()
    await admin.context().close()
  }
})

test('vihko.yaml rewritten to the current format at start: what changed and where the copy is, until dismissed; and a start that couldn\'t', async ({ browser }) => {
  const k = await signIn(browser, ADMIN)
  const id = m.aSecret(8)
  const done = { id: m.anId(), description: m.aSentence() }
  const failed = { id: m.anId(), description: m.aSentence() }
  const detail = m.aSentence()
  // The copy's name is the time of the rewrite: the case under test is a long path without spaces.
  const backup = 'config-backups/vihko.yaml.2026-03-14T09-30-00.000Z'
  await mockAlerts(k, [
    // Shown as a date in the admin's timezone: the 14th whatever it is.
    { code: 'config_migrated', id, file: 'vihko.yaml', migrations: [done], backup, at: '2026-03-14T09:30:00Z', actions: ['dismiss'] },
    { code: 'config_migration_failed', file: 'vihko.yaml', migration: failed, detail, actions: [] },
  ])
  const sent: string[] = []
  await k.route('**/api/admin/config-migrations/*', (route) => {
    sent.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.fulfill({ json: { ok: true } })
  })
  await k.goto('/?view=alerts')
  const rewritten = card(k, 'vihko actualizó')
  await expect(rewritten.getByRole('heading')).toHaveText('vihko actualizó vihko.yaml al formato actual')
  await expect(rewritten).toContainText(/el 14 mar/)
  await expect(rewritten).toContainText('comentarios incluidos, sigue como estaba')
  await expect(rewritten).toContainText(backup)
  await expect(rewritten.locator('li')).toHaveText(`${done.id} ${done.description}`)
  const notDone = card(k, 'no pudo actualizar')
  await expect(notDone.getByRole('heading')).toHaveText('vihko no pudo actualizar vihko.yaml al formato actual')
  await expect(notDone).toContainText('lo sigue leyendo así')
  await expect(notDone.locator('li')).toHaveText(`${failed.id} ${failed.description}`)
  await expect(notDone.getByRole('button')).toHaveCount(0)
  await expect(notDone.locator('.alert-copy')).toBeHidden()
  await notDone.getByText('Detalle para quien administra vihko').click()
  await expect(notDone.locator('.alert-copy')).toContainText(detail)
  await k.setViewportSize({ width: 1440, height: 900 })
  await k.screenshot({ path: `${SHOTS}/avisos-formato.png`, fullPage: true, animations: 'disabled' })
  await k.setViewportSize({ width: 390, height: 844 })
  expect(await k.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await rewritten.getByRole('button', { name: 'Entendido' }).click()
  await expect.poll(() => sent).toEqual([`DELETE /api/admin/config-migrations/${id}`])
  await k.context().close()
})

test('empty state', async ({ browser }) => {
  const k = await signIn(browser, ADMIN)
  await mockAlerts(k, [])
  await k.goto('/?view=alerts')
  await expect(k.getByText('No hay avisos')).toBeVisible()
  await expect(k.locator('.sidebar-alerts')).toHaveCount(0)
  await k.context().close()
})

test('the alerts page has an English address, and its earlier one still opens it', async ({ browser }) => {
  const k = await signIn(browser, ADMIN)
  await mockAlerts(k, [])
  await k.goto('/?view=avisos')
  await expect(k.getByRole('heading', { level: 1 })).toHaveText('Avisos del espacio')
  await expect(k).toHaveURL(/\?view=alerts$/)
  await k.context().close()
})

test('screenshots: light, dark and mobile', async ({ browser }) => {
  const k = await signIn(browser, ADMIN)
  await mockAlerts(k, FIXTURE)
  await k.setViewportSize({ width: 1440, height: 900 })
  await k.goto('/?view=alerts')
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
