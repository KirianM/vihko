// Folders and tags in the sidebar: create, drag, rename and delete folders
// (links rewritten on disk), the tags view and the `tag:`/`path:` filters in
// ⌘K, on a desktop and in the phone drawer. It works in its own folder.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, NOTES } from './env.ts'
import { signIn } from './helpers.ts'

const DIR = 'ft'
const read = (p: string) => (existsSync(`${NOTES}/${p}`) ? readFileSync(`${NOTES}/${p}`, 'utf8') : null)
const shot = (page: Page, name: string) => page.screenshot({ path: `${E2E_DIR}/shots/${name}.png`, animations: 'disabled' })
const row = (page: Page, name: string) => page.getByRole('row', { name, exact: true })

test.describe.configure({ mode: 'serial' })
let k: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  writeFileSync(`${NOTES}/${DIR}/Movible.md`, '---\ntags: [ftproyecto]\n---\n# Movible\n\nUna nota que cambia de carpeta.\n')
  writeFileSync(`${NOTES}/${DIR}/Enlaza.md`, '# Enlaza\n\n- [[Movible]] por nombre.\n- [la movible](Movible.md) relativo.\n\n#ftproyecto/fase1\n')
  writeFileSync(`${NOTES}/Fuera ft.md`, '# Fuera\n\n- [[ft/Enlaza]] con carpeta.\n')
  k = await signIn(browser, ADMIN)
  // Until the index sees the links (watcher or rescan), the preview does not know them.
  await expect.poll(async () => (await (await k.request.get(`/api/note/links?path=${encodeURIComponent(`${DIR}/Movible.md`)}`)).json()).backlinks.length, { timeout: 15_000 }).toBe(2)
  await k.reload()
  await expect(row(k, DIR)).toBeVisible()
})

test.afterAll(async () => {
  // Through the API (never rm): a note may still be open in an editor.
  const tree = await (await k.request.get('/api/tree')).json() as { notes: { path: string }[]; folders: string[] }
  for (const n of tree.notes.filter((x) => x.path.startsWith(`${DIR}/`) || x.path.startsWith('ft2/') || x.path === 'Fuera ft.md')) {
    await k.request.delete(`/api/note?path=${encodeURIComponent(n.path)}`)
  }
  for (const f of tree.folders.filter((x) => x.startsWith(`${DIR}/`) || x === DIR).sort().reverse()) {
    await k.request.delete(`/api/folder?path=${encodeURIComponent(f)}`)
  }
})

test('create a folder: an empty folder shows in the tree and survives a reload', async () => {
  await row(k, DIR).click()
  await expect(row(k, 'Movible')).toBeVisible()
  await row(k, DIR).click({ button: 'right' })
  await k.getByRole('menuitem', { name: 'Nueva carpeta dentro…' }).click()
  const dialog = k.getByRole('dialog')
  await expect(dialog.getByLabel('Dentro de')).toHaveValue(DIR)
  await dialog.getByLabel('Nombre').fill('Archivo')
  await dialog.getByRole('button', { name: 'Crear carpeta' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(row(k, 'Archivo')).toBeVisible()
  expect(existsSync(`${NOTES}/${DIR}/Archivo`)).toBe(true)
  await k.reload()
  await row(k, DIR).click()
  await expect(row(k, 'Archivo')).toBeVisible()
  await shot(k, 'folders-tree-light')
})

test('drag a linked note into a folder: the move dialog previews the link, which is rewritten on disk', async () => {
  await row(k, 'Movible').dragTo(row(k, 'Archivo'))
  const dialog = k.getByRole('dialog')
  await expect(dialog.getByRole('heading')).toHaveText('Renombrar o mover «Movible»')
  await expect(dialog.getByLabel('Carpeta')).toHaveValue(`${DIR}/Archivo`)
  await expect(dialog.locator('.preview-change')).toHaveText('[la movible](Movible.md) → [la movible](Archivo/Movible.md)')
  await expect(dialog.locator('.preview-kept')).toContainText('[[Movible]] sigue funcionando')
  await shot(k, 'folders-drop-dialog-light')
  await dialog.getByRole('button', { name: 'Mover y actualizar 1 enlace' }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => read(`${DIR}/Archivo/Movible.md`)).toContain('# Movible')
  expect(read(`${DIR}/Movible.md`)).toBeNull()
  expect(read(`${DIR}/Enlaza.md`)).toContain('- [la movible](Archivo/Movible.md) relativo.')
  expect(read(`${DIR}/Enlaza.md`)).toContain('- [[Movible]] por nombre.')
  // The tree shows it where it went.
  await expect(row(k, 'Movible')).toBeVisible()
  await expect(row(k, 'Movible')).toHaveAttribute('aria-level', '3')
})

test('a drop that changes no link moves at once, without a dialog', async () => {
  await row(k, 'Fuera ft').dragTo(row(k, DIR))
  await expect.poll(() => read(`${DIR}/Fuera ft.md`)).toContain('# Fuera')
  // The destination is written before the source goes: wait for both.
  await expect.poll(() => read('Fuera ft.md')).toBeNull()
  await expect(k.getByRole('dialog')).toHaveCount(0)
})

test('rename a folder from its context menu: every note goes along and links elsewhere follow', async () => {
  await row(k, 'Archivo').click({ button: 'right' })
  await shot(k, 'folders-menu-light')
  await k.getByRole('menuitem', { name: 'Renombrar o mover…' }).click()
  const dialog = k.getByRole('dialog')
  await expect(dialog.getByRole('heading')).toHaveText('Renombrar o mover la carpeta «Archivo»')
  await dialog.getByLabel('Nombre').fill('Archivo 2026')
  await expect(dialog.getByText('Van con ella 1 nota y 0 archivos.')).toBeVisible()
  await expect(dialog.locator('.preview-change')).toHaveText('[la movible](Archivo/Movible.md) → [la movible](Archivo%202026/Movible.md)')
  await dialog.getByRole('button', { name: 'Renombrar y actualizar 1 enlace' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(row(k, 'Archivo 2026')).toBeVisible()
  await expect(row(k, 'Movible')).toBeVisible()
  expect(existsSync(`${NOTES}/${DIR}/Archivo`)).toBe(false)
  expect(read(`${DIR}/Archivo 2026/Movible.md`)).toContain('# Movible')
  expect(read(`${DIR}/Enlaza.md`)).toContain('- [la movible](Archivo%202026/Movible.md) relativo.')
})

test('moving the folder of the open note keeps it open at its new path', async () => {
  await row(k, 'Movible').click()
  await expect(k.locator('.crumbs b')).toHaveText('Movible')
  await row(k, DIR).click({ button: 'right' })
  await k.getByRole('menuitem', { name: 'Renombrar o mover…' }).click()
  const dialog = k.getByRole('dialog')
  await dialog.getByLabel('Nombre').fill('ft2')
  // [[ft/Enlaza]] in «Fuera ft» lives inside the folder now: it keeps resolving by name.
  await expect(dialog.getByText('Van con ella 3 notas y 0 archivos.')).toBeVisible()
  await dialog.getByRole('button', { name: /^Renombrar/ }).click()
  await expect(dialog).toHaveCount(0)
  await expect(k).toHaveURL(/note=ft2%2FArchivo(\+|%20)2026%2FMovible\.md/)
  await expect(k.locator('.crumbs')).toHaveText('ft2 / Archivo 2026 / Movible')
  await expect(k.locator('.cm-content')).toContainText('Una nota que cambia de carpeta.')
  expect(existsSync(`${NOTES}/${DIR}`)).toBe(false)
  // Put it back for the rest of the tests.
  const r = await k.request.post('/api/folder/move', { data: { from: 'ft2', to: DIR } })
  expect(r.status()).toBe(200)
  // To its path now: a reload could still carry the old one, if it came before the page followed the move.
  await k.goto(`/?note=${encodeURIComponent(`${DIR}/Archivo 2026/Movible.md`)}`)
  await expect(k.locator('.crumbs')).toHaveText('ft / Archivo 2026 / Movible')
})

test('delete: a folder with notes is refused and explained; an empty one goes', async () => {
  await row(k, 'Archivo 2026').click({ button: 'right' })
  await k.getByRole('menuitem', { name: 'Eliminar carpeta' }).click()
  const dialog = k.getByRole('alertdialog')
  await dialog.getByRole('button', { name: 'Eliminar' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('La carpeta no está vacía: mueve sus notas y archivos o mándalos a la papelera antes.')
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  expect(read(`${DIR}/Archivo 2026/Movible.md`)).toContain('# Movible')

  await k.getByRole('button', { name: 'Nueva carpeta' }).click()
  await k.getByRole('dialog').getByLabel('Nombre').fill('Vacía')
  await k.getByRole('dialog').getByLabel('Dentro de').fill(DIR)
  await k.getByRole('dialog').getByRole('button', { name: 'Crear carpeta' }).click()
  await expect(row(k, 'Vacía')).toBeVisible()
  await row(k, 'Vacía').click({ button: 'right' })
  await k.getByRole('menuitem', { name: 'Eliminar carpeta' }).click()
  await k.getByRole('alertdialog').getByRole('button', { name: 'Eliminar' }).click()
  await expect(row(k, 'Vacía')).toHaveCount(0)
  expect(existsSync(`${NOTES}/${DIR}/Vacía`)).toBe(false)
})

test('the context-menu key opens the focused row\'s menu', async () => {
  // With a note open (a selected row), a press on another row still opens it.
  await row(k, 'Enlaza').click()
  await expect(k.locator('.crumbs b')).toHaveText('Enlaza')
  await row(k, 'Enlaza').focus()
  await k.keyboard.press('Shift+F10')
  await expect(k.getByRole('menuitem', { name: 'Mover a la papelera' })).toBeVisible()
  await k.keyboard.press('Escape')
  await expect(k.getByRole('menu')).toHaveCount(0)
})

test('tags view: counts, nested tags as a tree, and the notes of a tag', async () => {
  await k.getByRole('tab', { name: 'Tags' }).click()
  const tags = k.getByRole('treegrid', { name: 'Tags' })
  const tag = tags.getByRole('row', { name: 'ftproyecto', exact: true })
  await expect(tag).toContainText('2')
  await tag.getByRole('button', { name: /Expandir/ }).click()
  await expect(tags.getByRole('row', { name: 'fase1', exact: true })).toContainText('1')
  await shot(k, 'tags-light')
  await tag.click()
  const list = k.getByRole('listbox', { name: 'Notas con #ftproyecto' })
  await expect(list.getByRole('option')).toHaveCount(2)
  await expect(list.getByRole('option', { name: /Movible/ })).toContainText('ft / Archivo 2026')
  await list.getByRole('option', { name: /Movible/ }).click()
  await expect(k.locator('.crumbs b')).toHaveText('Movible')
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).first().click()
  await shot(k, 'tags-dark')
  await k.getByRole('button', { name: 'Todos los tags' }).click()
  await expect(tags).toBeVisible()
  await k.getByRole('tab', { name: 'Carpetas' }).click()
  await row(k, 'Archivo 2026').click({ button: 'right' })
  await shot(k, 'folders-menu-dark')
  await k.keyboard.press('Escape')
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).first().click()
})

test('⌘K: tag: and path: filters, combinable with text and negation; a filter never offers to create', async () => {
  const input = k.getByRole('textbox', { name: 'Buscar' })
  const titles = () => k.locator('.palette-list .palette-title')
  await k.keyboard.press('Control+k')
  await expect(input).toBeFocused()
  await expect(k.locator('.palette-filters')).toContainText('tag:proyecto')
  await input.fill('tag:FTproyecto')
  await expect(titles()).toHaveCount(2)
  await expect(k.getByText('Crear', { exact: true })).toHaveCount(0)
  await shot(k, 'palette-filter-light')
  await input.fill('tag:ftproyecto -tag:ftproyecto/fase1')
  await expect(titles()).toHaveCount(1)
  await expect(titles().first()).toContainText('Movible')
  await input.fill('path:"ft/Archivo 2026/"')
  await expect(titles()).toHaveCount(1)
  await input.fill('carpeta path:ft/')
  await expect(titles()).toHaveCount(1)
  await expect(titles().first()).toContainText('Movible')
  await expect(k.locator('.palette-list mark').first()).toHaveText('carpeta')
  await input.fill('cambia path:hogar')
  await expect(k.locator('.palette-empty')).toHaveText('Ninguna nota coincide.')
  await k.keyboard.press('Escape')
})

test('phone: tabs in the drawer, the tags view, and a long press opens a row\'s menu', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await k.context().storageState() })
  const m = await ctx.newPage()
  await m.goto('/')
  await expect(m.getByRole('dialog', { name: 'Carpetas' })).toBeVisible()
  const drawer = m.getByRole('dialog', { name: 'Carpetas' })
  await drawer.getByRole('row', { name: DIR, exact: true }).click()
  const target = drawer.getByRole('row', { name: 'Enlaza', exact: true })
  await expect(target).toBeVisible()
  // A long press (touch pointer held still): the menu opens and the note does not.
  const box = (await target.locator('.tree-label').boundingBox())!
  const at = { pointerType: 'touch', isPrimary: true, pointerId: 7, clientX: box.x + 5, clientY: box.y + 5, bubbles: true }
  await target.locator('.tree-label').dispatchEvent('pointerdown', at)
  await m.waitForTimeout(700)
  await target.locator('.tree-label').dispatchEvent('pointerup', at)
  await expect(m.getByRole('menuitem', { name: 'Renombrar o mover…' })).toBeVisible()
  await shot(m, 'mobile-longpress')
  await m.keyboard.press('Escape')
  await expect(m).not.toHaveURL(/note=/)
  await drawer.getByRole('tab', { name: 'Tags' }).click()
  await expect(drawer.getByRole('row', { name: 'ftproyecto', exact: true })).toBeVisible()
  await shot(m, 'mobile-tags')
  await drawer.getByRole('row', { name: 'ftproyecto', exact: true }).click()
  await drawer.getByRole('option', { name: /Enlaza/ }).click()
  await expect(m.getByRole('dialog', { name: 'Carpetas' })).toHaveCount(0)
  await expect(m.locator('.crumbs b')).toHaveText('Enlaza')
  await ctx.close()
})

test('a folder move that would resolve an ambiguous link lists it in the preview and in the notice', async () => {
  mkdirSync(`${NOTES}/${DIR}/Tema`, { recursive: true })
  mkdirSync(`${NOTES}/${DIR}/Otro`, { recursive: true })
  writeFileSync(`${NOTES}/${DIR}/Tema/Pantalla.md`, '# Pantalla de Tema\n')
  writeFileSync(`${NOTES}/${DIR}/Otro/Pantalla.md`, '# Pantalla de Otro\n')
  const usa = '# Usa\n\n- [[Pantalla]] ambigua.\n'
  writeFileSync(`${NOTES}/${DIR}/Usa.md`, usa)
  const shifted = async () => (await (await k.request.post('/api/folder/move', { data: { from: `${DIR}/Otro`, to: `${DIR}/Tema/Otro`, dryRun: true } })).json()).shifted.length
  await expect.poll(shifted, { timeout: 15_000 }).toBe(1)
  await k.reload()
  await expect(row(k, DIR)).toBeVisible()
  if ((await row(k, DIR).getAttribute('aria-expanded')) !== 'true') await row(k, DIR).click()
  await row(k, 'Otro').click({ button: 'right' })
  await k.getByRole('menuitem', { name: 'Renombrar o mover…' }).click()
  const dialog = k.getByRole('dialog')
  await dialog.getByLabel('Dentro de').fill(`${DIR}/Tema`)
  const shifts = dialog.locator('.shifts')
  await expect(shifts.locator('strong')).toHaveText('Un enlace no se reescribe pero cambiará adónde lleva')
  await expect(shifts.locator('.shifts-src')).toHaveText('ft / Usa1 enlace')
  await expect(shifts.locator('.shifts-row')).toHaveText('[[Pantalla]] era ambiguo; llevará a ft / Tema / Pantalla')
  await shot(k, 'folder-shifts-light')
  await dialog.getByRole('button', { name: 'Mover' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(k.getByRole('alert').filter({ hasText: 'lleva ahora a otra parte' })).toHaveText(
    '«Otro» ya está en su sitio. Un enlace que no se ha reescrito lleva ahora a otra parte, en: Usa.')
  expect(read(`${DIR}/Usa.md`)).toBe(usa)
  expect(existsSync(`${NOTES}/${DIR}/Tema/Otro/Pantalla.md`)).toBe(true)
  await k.getByRole('button', { name: 'Cerrar aviso' }).click()
})
