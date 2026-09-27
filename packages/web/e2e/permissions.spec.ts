// The permissions UI (M4, D-038), with several browsers at once: the admin
// takes a folder away from a member (the lock shows; the member no longer sees
// it, a note there answers the neutral «doesn't exist or no access», and a
// link to it keeps its lock); a move that changes who sees a note asks first;
// a member shares a folder of her own ({user} rule) with a third person, who
// sees it after reloading, the folders above only as the way, and nothing to
// do in it; the effective access of a folder, a person and a key; thoth.yaml
// changed meanwhile, or not writable by thoth. On a phone and in dark mode
// too. It works in its own folder, `acceso/`.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { E2E_DIR, NOTES, PASSWORD, PERMISSIONS } from './env.ts'
import { signIn, writeWorkspace } from './helpers.ts'

const SHOTS = `${E2E_DIR}/shots`
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled' })
/** A tree row by its name (a folder's name may be followed by its marks). */
const row = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(`^${name}\\b`) })
const RULES = PERMISSIONS + '  "acceso/personas/{user}":\n    grants: { "{user}": manage }\n'
const NOTES_IN: Record<string, string> = {
  'acceso/equipo/Plan del equipo.md': '# Plan del equipo\n\nObjetivos del trimestre.\n',
  'acceso/equipo/Secreto.md': '# Secreto\n\nSolo para quien gestiona el equipo.\n',
  'acceso/compartida/Índice.md': '# Índice\n\nVer [[Secreto]] y [[Plan del equipo]].\n',
  'acceso/compartida/Para mover.md': '# Para mover\n\nUna nota que cambia de sitio.\n',
  'acceso/personas/ana/cocina/Tortilla.md': '# Tortilla\n\nHuevos, patatas y paciencia.\n',
  'acceso/personas/ana/diario/Hoy.md': '# Hoy\n\nSolo mío.\n',
  'acceso/personas/noa/Notas.md': '# Notas de noa\n',
}

test.describe.configure({ mode: 'serial' })
let k: Page
let keyId: string | null = null

/** Opens the menu of a tree row and picks an item. */
async function rowMenu(page: Page, name: string, item: string) {
  await row(page, name).click({ button: 'right' })
  await page.getByRole('menuitem', { name: item }).click()
}

/** Expands the tree down to a folder (each part clicked open). */
async function openFolders(page: Page, ...names: string[]) {
  for (const n of names) {
    const r = row(page, n)
    if ((await r.getAttribute('aria-expanded')) !== 'true') await r.click()
  }
}

/** Waits until thoth has read thoth.yaml with the `{user}` rule (or without it). */
async function rulesInForce(page: Page, personal: boolean) {
  await expect.poll(async () => {
    const r = await page.request.get('/api/permissions?folder=acceso%2Fpersonas%2Fkirian')
    return r.ok() && (await r.json()).userRule !== null
  }, { timeout: 15_000 }).toBe(personal)
}

test.beforeAll(async ({ browser }) => {
  // Seven notes written (and kept in the history) and thoth.yaml read again: more than a click, under load.
  test.setTimeout(90_000)
  mkdirSync(SHOTS, { recursive: true })
  k = await signIn(browser, 'noa')
  // The notes, through the API while noa still manages everything; then the rules.
  for (const [path, text] of Object.entries(NOTES_IN)) {
    const r = await k.request.post('/api/note', { data: { path, text } })
    expect(r.status(), await r.text()).toBe(201)
  }
  writeFileSync(`${NOTES}/thoth.yaml`, RULES)
  await rulesInForce(k, true)
  await k.reload()
})

test.afterAll(async () => {
  test.setTimeout(90_000)
  writeWorkspace()
  await rulesInForce(k, false)
  if (keyId) await k.request.delete(`/api/keys/${keyId}`)
  // Through the API (never rm): a note may still be open in an editor.
  const tree = await (await k.request.get('/api/tree')).json() as { notes: { path: string }[]; folders: string[] }
  for (const n of tree.notes.filter((x) => x.path.startsWith('acceso/'))) await k.request.delete(`/api/note?path=${encodeURIComponent(n.path)}`)
  for (const f of tree.folders.filter((x) => x === 'acceso' || x.startsWith('acceso/')).sort().reverse()) await k.request.delete(`/api/folder?path=${encodeURIComponent(f)}`)
})

test('the admin takes a folder away from a member: a lock in the tree; she no longer sees it, a note there is «doesn\'t exist or no access», a link to it keeps its lock', async ({ browser }) => {
  await openFolders(k, 'acceso')
  await expect(row(k, 'personas')).toBeVisible()
  await rowMenu(k, 'equipo', 'Permisos…')
  const dialog = k.getByRole('dialog', { name: 'Permisos de «equipo»' })
  // Inherited: rows with where they come from, not editable here; the cascade said plainly.
  await expect(dialog).toContainText('Hereda de /')
  const rows = dialog.getByRole('list', { name: 'Quién tiene permiso' })
  await expect(rows.getByRole('listitem')).toHaveCount(2)
  await expect(rows.getByRole('listitem').filter({ hasText: 'ana' })).toContainText('EditarHeredado de /')
  await expect(rows.getByRole('combobox')).toHaveCount(0)
  await expect(dialog).toContainText('Las subcarpetas heredan estos permisos salvo que tengan los suyos.')
  await expect(dialog.getByRole('button', { name: 'Guardar' })).toBeDisabled()
  // Own permissions start from the inherited ones.
  await dialog.getByRole('button', { name: 'Cambiar permisos' }).click()
  await expect(dialog).toContainText('Permisos propios')
  await expect(dialog.getByRole('combobox', { name: 'Nivel de ana' })).toHaveValue('edit')
  await dialog.getByRole('button', { name: 'Quitar a ana' }).click()
  await expect(dialog).toContainText('Nadie más puede ver esta carpeta.')
  await shot(k, 'permissions-dialog-light')
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Guardado.')
  await expect(dialog.getByRole('button', { name: 'Restaurar herencia' })).toBeVisible()
  expect(readFileSync(`${NOTES}/thoth.yaml`, 'utf8')).toBe(RULES + '  acceso/equipo:\n    grants: { noa: manage }\n')
  // Who has access, and why.
  await dialog.getByRole('tab', { name: 'Quién tiene acceso' }).click()
  // Its own grant, and managing the root, which reaches under it whatever this folder says (D-040 3.5).
  await expect(dialog.getByRole('list', { name: 'Quién tiene acceso' }).getByRole('listitem')).toHaveText([/kirianGestionarDirectamente · en \/acceso\/equipoDirectamente · gestiona \/$/])
  await dialog.getByRole('button', { name: 'Cerrar' }).click()
  await expect(row(k, 'equipo').getByRole('img', { name: 'Permisos propios' })).toBeVisible()

  const ana = await signIn(browser, 'ana', 'acceso/compartida/Índice.md')
  await openFolders(ana, 'acceso')
  await expect(row(ana, 'compartida')).toBeVisible()
  await expect(row(ana, 'equipo')).toHaveCount(0)
  // Links to notes she can't read: dimmed, with a lock, never «create».
  await expect(ana.locator('.cm-wikilink-no_access')).toHaveText(['Secretosin acceso', 'Plan del equiposin acceso'])
  await expect(ana.locator('.cm-wikilink-create')).toHaveCount(0)
  // Opening it, or a note that doesn't exist: the same neutral message.
  for (const path of ['acceso/equipo/Secreto.md', 'acceso/no/existe.md']) {
    await ana.goto(`/?note=${encodeURIComponent(path)}`)
    await expect(ana.getByRole('alert')).toContainText('Esta nota no existe o no tienes acceso')
  }
  await shot(ana, 'permissions-no-access-light')
  await ana.context().close()
})

test('moving a note where someone loses access says who and waits for a confirmation', async ({ browser }) => {
  await openFolders(k, 'acceso', 'compartida')
  await rowMenu(k, 'Para mover', 'Renombrar o mover…')
  const dialog = k.getByRole('dialog')
  await dialog.getByLabel('Carpeta').fill('acceso/personas/noa')
  const warning = dialog.getByRole('group', { name: 'Cambia quién puede verlo' })
  await expect(warning).toContainText('Lo pierdenana')
  const move = dialog.getByRole('button', { name: 'Mover' })
  await expect(move).toBeDisabled()
  await shot(k, 'permissions-move-warning-light')
  await warning.getByLabel('Entiendo que cambia quién puede verlo').check()
  await expect(move).toBeEnabled()
  // Another destination asks again.
  await dialog.getByLabel('Carpeta').fill('acceso/equipo')
  await expect(warning).toContainText('Lo pierdenana')
  await expect(move).toBeDisabled()
  await warning.getByLabel('Entiendo que cambia quién puede verlo').check()
  await move.click()
  await expect(dialog).toHaveCount(0)
  await openFolders(k, 'equipo')
  await expect(row(k, 'Para mover')).toBeVisible()

  const ana = await signIn(browser, 'ana')
  await openFolders(ana, 'acceso', 'compartida')
  await expect(row(ana, 'Índice')).toBeVisible()
  await expect(row(ana, 'Para mover')).toHaveCount(0)
  await ana.context().close()
})

/** A member created by the admin and signed up through their link, with the tests' password. */
async function newMember(browser: Browser, username: string) {
  const r = await k.request.post('/api/admin/users', { data: { username, role: 'member' } })
  expect(r.status(), await r.text()).toBe(201)
  const { link } = await r.json() as { link: { token: string } }
  const ctx = await browser.newContext()
  expect((await ctx.request.post(`/api/invite/${link.token}`, { data: { password: PASSWORD } })).status()).toBe(200)
  await ctx.close()
}

test('a member shares a folder of her own with someone else: he sees it after reloading, the folders above only as the way, and can only read it', async ({ browser }) => {
  await newMember(browser, 'bruno')
  // Nothing is his yet: no tree to wait for.
  const bruno = await (await browser.newContext()).newPage()
  await bruno.goto('/')
  await bruno.getByLabel('Nombre de usuario').fill('bruno')
  await bruno.getByLabel('Contraseña').fill(PASSWORD)
  await bruno.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(bruno.getByRole('status').filter({ hasText: 'Todavía no tienes acceso a ninguna carpeta' })).toBeVisible()
  await expect(bruno.getByRole('button', { name: 'Nueva nota' })).toHaveCount(0)

  const ana = await signIn(browser, 'ana')
  await openFolders(ana, 'acceso', 'personas', 'ana')
  // Her own folder: the {user} rule decides; she closes it to agents.
  await rowMenu(ana, 'ana', 'Permisos…')
  let dialog = ana.getByRole('dialog', { name: 'Permisos de «ana»' })
  await expect(dialog).toContainText('Carpeta personal: la regla acceso/personas/{user} decide quién entra')
  // React Aria's switch: its input is hidden, the label takes the click.
  await dialog.locator('label.switch', { hasText: 'Cerrada a los agentes' }).click()
  await expect(dialog.getByRole('switch', { name: /Cerrada a los agentes/ })).toBeChecked()
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Guardado.')
  await dialog.getByRole('button', { name: 'Cerrar' }).click()
  await expect(row(ana, 'ana').getByRole('img', { name: 'Cerrada a los agentes' })).toBeVisible()
  await expect(row(ana, 'cocina').getByRole('img', { name: 'Cerrada a los agentes' })).toBeVisible()

  // Shares «cocina» with bruno, to read.
  await rowMenu(ana, 'cocina', 'Permisos…')
  dialog = ana.getByRole('dialog', { name: 'Permisos de «cocina»' })
  await expect(dialog).toContainText('Hereda de /acceso/personas/ana (regla acceso/personas/{user})')
  await expect(dialog.getByRole('switch', { name: /Cerrada a los agentes/ })).toBeDisabled()
  await expect(dialog).toContainText('Cerrada desde /acceso/personas/ana')
  await dialog.getByRole('button', { name: 'Cambiar permisos' }).click()
  await expect(dialog).toContainText('Nadie más puede ver esta carpeta.')
  await dialog.getByRole('combobox', { name: 'Persona o grupo' }).selectOption('bruno')
  await dialog.getByRole('button', { name: 'Añadir' }).click()
  await expect(dialog.getByRole('combobox', { name: 'Nivel de bruno' })).toHaveValue('read')
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Guardado.')
  await dialog.getByRole('tab', { name: 'Quién tiene acceso' }).click()
  const who = dialog.getByRole('list', { name: 'Quién tiene acceso' }).getByRole('listitem')
  await expect(who).toHaveText([/anaGestionarDirectamente · en \/acceso\/personas\/ana\/cocinaDirectamente · gestiona \/acceso\/personas\/ana$/, /brunoLeerDirectamente · en \/acceso\/personas\/ana\/cocina$/])
  await shot(ana, 'permissions-access-light')
  await dialog.getByRole('button', { name: 'Cerrar' }).click()

  // Bruno, after reloading: the way to it muted and with nothing to do; the folder, to read.
  await bruno.reload()
  await openFolders(bruno, 'acceso', 'personas', 'ana', 'cocina')
  await expect(row(bruno, 'acceso').locator('.tree-row')).toHaveAttribute('title', 'Solo el camino hasta lo que compartieron contigo')
  await expect(row(bruno, 'cocina').locator('.tree-row')).not.toHaveAttribute('title', /.*/)
  await expect(row(bruno, 'ana').getByRole('button', { name: /Acciones/ })).toHaveCount(0)
  await expect(row(bruno, 'cocina').getByRole('button', { name: /Acciones/ })).toHaveCount(0)
  await expect(row(bruno, 'diario')).toHaveCount(0)
  await row(bruno, 'Tortilla').click()
  await expect(bruno.locator('.cm-content')).toContainText('Huevos, patatas y paciencia.')
  await expect(bruno.getByRole('button', { name: 'Nueva nota' })).toHaveCount(0)
  await shot(bruno, 'permissions-shared-tree-light')

  // The admin doesn't see her folder in the tree; in «Users and groups», its name, and bruno's access.
  await k.reload()
  await openFolders(k, 'acceso', 'personas')
  await expect(row(k, 'noa')).toBeVisible()
  await expect(row(k, 'ana')).toHaveCount(0)
  await k.goto('/?view=users')
  const folders = k.getByRole('list', { name: 'Carpetas' })
  await expect(folders.getByRole('listitem').filter({ hasText: /^cocina/ })).toBeVisible()
  await k.getByRole('row', { name: /^bruno\b/ }).getByRole('button', { name: 'Acciones para bruno' }).click()
  await k.getByRole('menuitem', { name: 'Ver a qué carpetas llega' }).click()
  const access = k.getByRole('dialog', { name: 'Acceso de bruno' })
  await expect(access.getByRole('list', { name: 'Carpetas a las que llega' }).getByRole('listitem')).toHaveText(['accesosolo el camino', 'personassolo el camino', 'anasolo el camino', 'cocinaLeer'])
  await shot(k, 'permissions-user-access-light')
  await access.getByRole('button', { name: 'Cerrar' }).click()
  await ana.context().close()
  await bruno.context().close()
})

test('a key\'s effective access, from «Agents and API»', async () => {
  const r = await k.request.post('/api/keys', { data: { name: 'Lector del equipo', folders: ['acceso/equipo'], confirm: PASSWORD } })
  expect(r.status(), await r.text()).toBe(201)
  keyId = (await r.json() as { key: { id: string } }).key.id
  await k.goto('/?view=agents')
  await k.getByRole('listitem').filter({ hasText: 'Lector del equipo' }).getByRole('button', { name: 'Qué ve' }).click()
  const dialog = k.getByRole('dialog', { name: 'Qué ve «Lector del equipo»' })
  await expect(dialog.getByRole('listitem')).toHaveText(['accesosolo el camino', 'equipoLeer'])
  await dialog.getByRole('button', { name: 'Cerrar' }).click()
})

test('thoth.yaml changed meanwhile: the dialog loads it again and says so; one thoth can\'t write is explained', async () => {
  // From the header of a note in the folder.
  await k.goto(`/?note=${encodeURIComponent('acceso/compartida/Índice.md')}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  await k.getByRole('button', { name: 'Permisos de la carpeta /acceso/compartida' }).click()
  const dialog = k.getByRole('dialog', { name: 'Permisos de «compartida»' })
  await dialog.getByRole('button', { name: 'Cambiar permisos' }).click()
  await dialog.getByRole('combobox', { name: 'Nivel de ana' }).selectOption('read')
  // Someone else edits the file meanwhile.
  writeFileSync(`${NOTES}/thoth.yaml`, '# edited by hand\n' + readFileSync(`${NOTES}/thoth.yaml`, 'utf8'))
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('alert')).toContainText('thoth.yaml cambió mientras tanto')
  await expect(dialog).toContainText('Hereda de /')
  // A section thoth can't use: it is fixed by hand.
  const good = readFileSync(`${NOTES}/thoth.yaml`, 'utf8')
  writeFileSync(`${NOTES}/thoth.yaml`, good.replace('noa: manage, ana: edit', 'noa: owner, ana: edit'))
  await dialog.getByRole('button', { name: 'Cerrar' }).click()
  await rowMenu(k, 'compartida', 'Permisos…')
  await dialog.getByRole('button', { name: 'Cambiar permisos' }).click()
  await dialog.getByRole('combobox', { name: 'Nivel de ana' }).selectOption('read')
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Hay que corregirlo a mano')
  await shot(k, 'permissions-config-invalid-light')
  writeFileSync(`${NOTES}/thoth.yaml`, good)
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
})

test('on a phone and in dark mode: the dialog, the locks and the warning fit', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'es-ES' })
  const page = await ctx.newPage()
  await page.goto('/')
  await page.getByLabel('Nombre de usuario').fill('ana')
  await page.getByLabel('Contraseña').fill(PASSWORD)
  await page.getByRole('button', { name: 'Entrar' }).last().tap()
  await expect(page.getByRole('treegrid')).toBeVisible()
  await openFolders(page, 'acceso', 'personas', 'ana')
  await expect(row(page, 'cocina').getByRole('img', { name: 'Permisos propios' })).toBeVisible()
  await shot(page, 'permissions-tree-mobile-dark')
  await row(page, 'cocina').getByRole('button', { name: 'Acciones de la carpeta «cocina»' }).tap()
  await page.getByRole('menuitem', { name: 'Permisos…' }).tap()
  const dialog = page.getByRole('dialog', { name: 'Permisos de «cocina»' })
  await expect(dialog.getByRole('combobox', { name: 'Nivel de bruno' })).toHaveValue('read')
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await shot(page, 'permissions-dialog-mobile-dark')
  await dialog.getByRole('tab', { name: 'Quién tiene acceso' }).tap()
  await shot(page, 'permissions-access-mobile-dark')
  await dialog.getByRole('button', { name: 'Cerrar' }).tap()
  await ctx.close()

  // The move warning in dark mode, on a desktop.
  const dark = await browser.newContext({ colorScheme: 'dark', locale: 'es-ES' })
  const d = await dark.newPage()
  await d.goto('/')
  await d.getByLabel('Nombre de usuario').fill('noa')
  await d.getByLabel('Contraseña').fill(PASSWORD)
  await d.getByRole('button', { name: 'Entrar' }).last().click()
  await openFolders(d, 'acceso', 'compartida')
  await rowMenu(d, 'Índice', 'Renombrar o mover…')
  await d.getByRole('dialog').getByLabel('Carpeta').fill('acceso/personas/noa')
  await expect(d.getByRole('group', { name: 'Cambia quién puede verlo' })).toBeVisible()
  await shot(d, 'permissions-move-warning-dark')
  await d.getByRole('dialog').getByRole('button', { name: 'Cancelar' }).click()
  await rowMenu(d, 'equipo', 'Permisos…')
  await expect(d.getByRole('dialog', { name: 'Permisos de «equipo»' })).toContainText('Permisos propios')
  await shot(d, 'permissions-dialog-dark')
  await dark.close()
})
