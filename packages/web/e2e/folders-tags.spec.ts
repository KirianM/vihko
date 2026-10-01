// Folders and tags in the sidebar: create, drag, rename and delete folders
// (links rewritten on disk), the tags view and the `tag:`/`path:` filters in
// ⌘K, on a desktop and in the phone drawer. It works in its own folder.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { markdownDest } from '../../core/src/images.ts'
import { ADMIN, E2E_DIR, SPACE_NAME, VAULT, inVault, specMother } from './env.ts'
import { literally, openPath, signIn } from './helpers.ts'

const m = specMother(import.meta.url)
const fold = (s: string) => s.toLowerCase()
const names: string[] = []
/** A new name (a note's title or a folder's) that is not part of any other of this spec, nor has one inside: a row or an option found by it is that one. */
function distinct(make: () => string, ok: (s: string) => boolean = () => true): string {
  for (;;) {
    const n = make()
    if (ok(n) && !names.some((o) => fold(o).includes(fold(n)) || fold(n).includes(fold(o)))) return names.push(n), n
  }
}
const DIR = distinct(m.aFolder)
const DIR2 = distinct(m.aFolder)
/** The note that moves; the one that links to it (by name and by a relative path); one outside the folder. */
const MOVABLE = distinct(m.aTitle)
const LINKS = distinct(m.aTitle)
const OUTSIDE = distinct(m.aTitle)
/** Folders made in the test: the second one with a space, which links encode. */
const ARCHIVE = distinct(m.aFolder)
const ARCHIVE2 = distinct(m.aFolder, (f) => f.includes(' '))
const EMPTY = distinct(m.aFolder)
/** A tag, and one nested under it. */
const TAG = m.aTag()
const SUB = m.aTag()
/** A word only the movable note has; a Markdown link's text. */
const WORD = m.aUniqueWord()
const LABEL = m.aWord()
const MOVABLE_TEXT = `${m.aSentence()} ${WORD}.`
/** The folders of the ambiguous link, and the notes: the two with one name, the one that links to it. */
const TOPIC = distinct(m.aFolder)
const OTHER = distinct(m.aFolder)
const SCREEN = distinct(m.aTitle)
const USES = distinct(m.aTitle)
const read = (p: string) => (existsSync(`${VAULT}/${p}`) ? readFileSync(`${VAULT}/${p}`, 'utf8') : null)
const shot = (page: Page, name: string) => page.screenshot({ path: `${E2E_DIR}/shots/${name}.png`, animations: 'disabled' })
const row = (page: Page, name: string) => page.getByRole('row', { name, exact: true })

/**
 * Drags a row onto another. Both are brought into view first: a drag that
 * has to scroll the tree between pressing and dropping may pick up the row
 * that scrolled under the pointer (the tree is longer or shorter with every
 * run's names).
 */
async function drag(page: Page, from: string, to: string) {
  await row(page, to).scrollIntoViewIfNeeded()
  await row(page, from).scrollIntoViewIfNeeded()
  await expect(row(page, to)).toBeInViewport()
  await row(page, from).dragTo(row(page, to))
}

test.describe.configure({ mode: 'serial' })
let k: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${VAULT}/${DIR}`, { recursive: true })
  writeFileSync(`${VAULT}/${DIR}/${MOVABLE}.md`, `---\ntags: [${TAG}]\n---\n# ${MOVABLE}\n\n${MOVABLE_TEXT}\n`)
  writeFileSync(`${VAULT}/${DIR}/${LINKS}.md`, `# ${LINKS}\n\n- [[${MOVABLE}]] ${m.aWord()}.\n- [${LABEL}](${markdownDest(`${MOVABLE}.md`)}) ${m.aWord()}.\n\n#${TAG}/${SUB}\n`)
  writeFileSync(`${VAULT}/${OUTSIDE}.md`, `# ${OUTSIDE}\n\n- [[${DIR}/${LINKS}]] ${m.aWord()}.\n`)
  k = await signIn(browser, ADMIN)
  // Until the index sees the links (watcher or rescan), the preview does not know them.
  await expect.poll(async () => (await (await k.request.get(`/api/note/links?path=${encodeURIComponent(inVault(`${DIR}/${MOVABLE}.md`))}`)).json()).backlinks.length, { timeout: 15_000 }).toBe(2)
  await k.reload()
  await expect(row(k, DIR)).toBeVisible()
})

test.afterAll(async () => {
  // Through the API (never rm): a note may still be open in an editor.
  const tree = await (await k.request.get('/api/tree')).json() as { notes: { path: string }[]; folders: string[] }
  for (const n of tree.notes.filter((x) => x.path.startsWith(inVault(`${DIR}/`)) || x.path.startsWith(inVault(`${DIR2}/`)) || x.path === inVault(`${OUTSIDE}.md`))) {
    await k.request.delete(`/api/note?path=${encodeURIComponent(n.path)}`)
  }
  for (const f of tree.folders.filter((x) => x.startsWith(inVault(`${DIR}/`)) || x === inVault(DIR)).sort().reverse()) {
    await k.request.delete(`/api/folder?path=${encodeURIComponent(f)}`)
  }
})

test('create a folder: an empty folder shows in the tree and survives a reload', async () => {
  await row(k, DIR).click()
  await expect(row(k, MOVABLE)).toBeVisible()
  await row(k, DIR).click({ button: 'right' })
  await k.getByRole('menuitem', { name: 'Nueva carpeta dentro…' }).click()
  const dialog = k.getByRole('dialog')
  await expect(dialog.getByLabel('Carpeta')).toHaveValue(DIR)
  await dialog.getByLabel('Nombre').fill(ARCHIVE)
  await dialog.getByRole('button', { name: 'Crear carpeta' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(row(k, ARCHIVE)).toBeVisible()
  expect(existsSync(`${VAULT}/${DIR}/${ARCHIVE}`)).toBe(true)
  await k.reload()
  await row(k, DIR).click()
  await expect(row(k, ARCHIVE)).toBeVisible()
  await shot(k, 'folders-tree-light')
})

test('drag a linked note into a folder: the move dialog previews the link, which is rewritten on disk', async () => {
  await drag(k, MOVABLE, ARCHIVE)
  const dialog = k.getByRole('dialog')
  await expect(dialog.getByRole('heading')).toHaveText(`Renombrar o mover «${MOVABLE}»`)
  await expect(dialog.getByLabel('Carpeta')).toHaveValue(`${DIR}/${ARCHIVE}`)
  await expect(dialog.locator('.preview-line:not(.preview-kept)')).toContainText(`el enlace a ${MOVABLE} se actualiza para que siga funcionando`)
  await expect(dialog.locator('.preview-kept')).toContainText(`el enlace a ${MOVABLE} sigue funcionando: no se toca`)
  await expect(dialog.locator('.preview')).not.toContainText(`](`)
  await shot(k, 'folders-drop-dialog-light')
  await dialog.getByRole('button', { name: 'Mover y actualizar 1 enlace' }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => read(`${DIR}/${ARCHIVE}/${MOVABLE}.md`)).toContain(`# ${MOVABLE}`)
  expect(read(`${DIR}/${MOVABLE}.md`)).toBeNull()
  expect(read(`${DIR}/${LINKS}.md`)).toContain(`- [${LABEL}](${markdownDest(`${ARCHIVE}/${MOVABLE}.md`)}) `)
  expect(read(`${DIR}/${LINKS}.md`)).toContain(`- [[${MOVABLE}]] `)
  // The tree shows it where it went.
  await expect(row(k, MOVABLE)).toBeVisible()
  await expect(row(k, MOVABLE)).toHaveAttribute('aria-level', '3')
})

test('a drop that changes no link moves at once, without a dialog', async () => {
  // From the root's notes, below every folder, up to a folder: a tall window, so both rows fit in it.
  await k.setViewportSize({ width: 1280, height: 1600 })
  await drag(k, OUTSIDE, DIR)
  await k.setViewportSize({ width: 1280, height: 800 })
  await expect.poll(() => read(`${DIR}/${OUTSIDE}.md`)).toContain(`# ${OUTSIDE}`)
  // The destination is written before the source goes: wait for both.
  await expect.poll(() => read(`${OUTSIDE}.md`)).toBeNull()
  await expect(k.getByRole('dialog')).toHaveCount(0)
})

test('rename a folder from its context menu: every note goes along and links elsewhere follow', async () => {
  await row(k, ARCHIVE).click({ button: 'right' })
  await shot(k, 'folders-menu-light')
  await k.getByRole('menuitem', { name: 'Renombrar o mover…' }).click()
  const dialog = k.getByRole('dialog')
  await expect(dialog.getByRole('heading')).toHaveText(`Renombrar o mover la carpeta «${ARCHIVE}»`)
  await dialog.getByLabel('Nombre').fill(ARCHIVE2)
  await expect(dialog.getByText('Van con ella 1 nota y 0 archivos.')).toBeVisible()
  await expect(dialog.locator('.preview-line')).toContainText(`el enlace a ${MOVABLE} se actualiza para que siga funcionando`)
  await dialog.getByRole('button', { name: 'Renombrar y actualizar 1 enlace' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(row(k, ARCHIVE2)).toBeVisible()
  await expect(row(k, MOVABLE)).toBeVisible()
  expect(existsSync(`${VAULT}/${DIR}/${ARCHIVE}`)).toBe(false)
  expect(read(`${DIR}/${ARCHIVE2}/${MOVABLE}.md`)).toContain(`# ${MOVABLE}`)
  expect(read(`${DIR}/${LINKS}.md`)).toContain(`- [${LABEL}](${markdownDest(`${ARCHIVE2}/${MOVABLE}.md`)}) `)
})

test('moving the folder of the open note keeps it open at its new path', async () => {
  await row(k, MOVABLE).click()
  await expect(k.locator('.crumbs b')).toHaveText(MOVABLE)
  await row(k, DIR).click({ button: 'right' })
  await k.getByRole('menuitem', { name: 'Renombrar o mover…' }).click()
  const dialog = k.getByRole('dialog')
  await dialog.getByLabel('Nombre').fill(DIR2)
  // The outside note's [[DIR/LINKS]] lives inside the folder now: it keeps resolving by name.
  await expect(dialog.getByText('Van con ella 3 notas y 0 archivos.')).toBeVisible()
  await dialog.getByRole('button', { name: /^Renombrar/ }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => openPath(k)).toBe(inVault(`${DIR2}/${ARCHIVE2}/${MOVABLE}.md`))
  await expect(k.locator('.crumbs')).toHaveText(`${SPACE_NAME} / ${DIR2} / ${ARCHIVE2} / ${MOVABLE}`)
  await expect(k.locator('.cm-content')).toContainText(MOVABLE_TEXT)
  expect(existsSync(`${VAULT}/${DIR}`)).toBe(false)
  // Put it back for the rest of the tests.
  const r = await k.request.post('/api/folder/move', { data: { from: inVault(DIR2), to: inVault(DIR) } })
  expect(r.status()).toBe(200)
  // To its path now: a reload could still carry the old one, if it came before the page followed the move.
  await k.goto(`/?note=${encodeURIComponent(inVault(`${DIR}/${ARCHIVE2}/${MOVABLE}.md`))}`)
  await expect(k.locator('.crumbs')).toHaveText(`${SPACE_NAME} / ${DIR} / ${ARCHIVE2} / ${MOVABLE}`)
})

test('delete: a folder with notes shows them before anything goes; an empty one goes', async () => {
  await row(k, ARCHIVE2).click({ button: 'right' })
  await k.getByRole('menuitem', { name: 'Eliminar carpeta' }).click()
  const dialog = k.getByRole('alertdialog')
  await dialog.getByRole('button', { name: 'Eliminar' }).click()
  await expect(dialog.getByText('Contiene 1 nota. Van a la papelera con ella y se pueden restaurar desde allí:')).toBeVisible()
  await expect(dialog.getByRole('list', { name: 'Sus notas' })).toHaveText(`${MOVABLE}.md`)
  await expect(dialog.getByRole('button', { name: 'Mandar a la papelera y eliminar' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  expect(read(`${DIR}/${ARCHIVE2}/${MOVABLE}.md`)).toContain(`# ${MOVABLE}`)

  // From the space's menu: a new folder at its root, then typed into DIR.
  await k.getByRole('button', { name: `Acciones de «${SPACE_NAME}»` }).click()
  await k.getByRole('menuitem', { name: 'Nueva carpeta dentro…' }).click()
  await expect(k.getByRole('dialog').getByLabel('Carpeta')).toHaveValue('')
  await k.getByRole('dialog').getByLabel('Nombre').fill(EMPTY)
  await k.getByRole('dialog').getByLabel('Carpeta').fill(DIR)
  await k.getByRole('dialog').getByRole('button', { name: 'Crear carpeta' }).click()
  await expect(row(k, EMPTY)).toBeVisible()
  await row(k, EMPTY).click({ button: 'right' })
  await k.getByRole('menuitem', { name: 'Eliminar carpeta' }).click()
  await k.getByRole('alertdialog').getByRole('button', { name: 'Eliminar' }).click()
  await expect(row(k, EMPTY)).toHaveCount(0)
  expect(existsSync(`${VAULT}/${DIR}/${EMPTY}`)).toBe(false)
})

test('the context-menu key opens the focused row\'s menu', async () => {
  // With a note open (a selected row), a press on another row still opens it.
  await row(k, LINKS).click()
  await expect(k.locator('.crumbs b')).toHaveText(LINKS)
  await row(k, LINKS).focus()
  await k.keyboard.press('Shift+F10')
  await expect(k.getByRole('menuitem', { name: 'Mover a la papelera' })).toBeVisible()
  await k.keyboard.press('Escape')
  await expect(k.getByRole('menu')).toHaveCount(0)
})

test('tags view: counts, nested tags as a tree, and the notes of a tag', async () => {
  await k.getByRole('tab', { name: 'Tags' }).click()
  const tags = k.getByRole('treegrid', { name: 'Tags' })
  const tag = tags.getByRole('row', { name: TAG, exact: true })
  await expect(tag).toContainText('2')
  await tag.getByRole('button', { name: /Expandir/ }).click()
  await expect(tags.getByRole('row', { name: SUB, exact: true })).toContainText('1')
  await shot(k, 'tags-light')
  await tag.click()
  const list = k.getByRole('listbox', { name: `Notas con #${TAG}` })
  await expect(list.getByRole('option')).toHaveCount(2)
  await expect(list.getByRole('option', { name: new RegExp(literally(MOVABLE), 'u') })).toContainText(`${SPACE_NAME} / ${DIR} / ${ARCHIVE2}`)
  await list.getByRole('option', { name: new RegExp(literally(MOVABLE), 'u') }).click()
  await expect(k.locator('.crumbs b')).toHaveText(MOVABLE)
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).first().click()
  await shot(k, 'tags-dark')
  await k.getByRole('button', { name: 'Todos los tags' }).click()
  await expect(tags).toBeVisible()
  await k.getByRole('tab', { name: 'Carpetas' }).click()
  await row(k, ARCHIVE2).click({ button: 'right' })
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
  await input.fill(`tag:${TAG.toUpperCase()}`)
  await expect(titles()).toHaveCount(2)
  await expect(k.getByText('Crear', { exact: true })).toHaveCount(0)
  await shot(k, 'palette-filter-light')
  await input.fill(`tag:${TAG} -tag:${TAG}/${SUB}`)
  await expect(titles()).toHaveCount(1)
  await expect(titles().first()).toContainText(MOVABLE)
  await input.fill(`path:"${inVault(DIR)}/${ARCHIVE2}/"`)
  await expect(titles()).toHaveCount(1)
  await input.fill(`${WORD} path:"${inVault(DIR)}/"`)
  await expect(titles()).toHaveCount(1)
  await expect(titles().first()).toContainText(MOVABLE)
  await expect(k.locator('.palette-list mark').first()).toHaveText(WORD)
  await input.fill(`${WORD} path:"${inVault('hogar')}"`) // a folder of the vault (testdata/vault)
  await expect(k.locator('.palette-empty')).toHaveText('Ninguna nota coincide.')
  await k.keyboard.press('Escape')
})

test('phone: tabs in the drawer, the tags view, and a long press opens a row\'s menu', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await k.context().storageState() })
  const phone = await ctx.newPage()
  await phone.goto('/')
  // Home first; the drawer behind the menu.
  await phone.getByRole('button', { name: 'Abrir carpetas' }).tap()
  await expect(phone.getByRole('dialog', { name: 'Carpetas' })).toBeVisible()
  const drawer = phone.getByRole('dialog', { name: 'Carpetas' })
  await drawer.getByRole('row', { name: DIR, exact: true }).click()
  const target = drawer.getByRole('row', { name: LINKS, exact: true })
  await expect(target).toBeVisible()
  // A long press (touch pointer held still): the menu opens and the note does not.
  const box = (await target.locator('.tree-label').boundingBox())!
  const at = { pointerType: 'touch', isPrimary: true, pointerId: 7, clientX: box.x + 5, clientY: box.y + 5, bubbles: true }
  await target.locator('.tree-label').dispatchEvent('pointerdown', at)
  await phone.waitForTimeout(700)
  await target.locator('.tree-label').dispatchEvent('pointerup', at)
  await expect(phone.getByRole('menuitem', { name: 'Renombrar o mover…' })).toBeVisible()
  await shot(phone, 'mobile-longpress')
  await phone.keyboard.press('Escape')
  await expect(phone).not.toHaveURL(/note=/)
  await drawer.getByRole('tab', { name: 'Tags' }).click()
  await expect(drawer.getByRole('row', { name: TAG, exact: true })).toBeVisible()
  await shot(phone, 'mobile-tags')
  await drawer.getByRole('row', { name: TAG, exact: true }).click()
  await drawer.getByRole('option', { name: new RegExp(literally(LINKS), 'u') }).click()
  await expect(phone.getByRole('dialog', { name: 'Carpetas' })).toHaveCount(0)
  await expect(phone.locator('.crumbs b')).toHaveText(LINKS)
  await ctx.close()
})

test('a folder move that would resolve an ambiguous link lists it in the preview and in the notice', async () => {
  // Two notes with the same name, in two folders: a link to it by name is ambiguous.
  mkdirSync(`${VAULT}/${DIR}/${TOPIC}`, { recursive: true })
  mkdirSync(`${VAULT}/${DIR}/${OTHER}`, { recursive: true })
  writeFileSync(`${VAULT}/${DIR}/${TOPIC}/${SCREEN}.md`, `# ${m.aHeading()}\n`)
  writeFileSync(`${VAULT}/${DIR}/${OTHER}/${SCREEN}.md`, `# ${m.aHeading()}\n`)
  const uses = `# ${USES}\n\n- [[${SCREEN}]] ${m.aWord()}.\n`
  writeFileSync(`${VAULT}/${DIR}/${USES}.md`, uses)
  const shifted = async () => (await (await k.request.post('/api/folder/move', { data: { from: inVault(`${DIR}/${OTHER}`), to: inVault(`${DIR}/${TOPIC}/${OTHER}`), dryRun: true } })).json()).shifted.length
  await expect.poll(shifted, { timeout: 15_000 }).toBe(1)
  await k.reload()
  await expect(row(k, DIR)).toBeVisible()
  if ((await row(k, DIR).getAttribute('aria-expanded')) !== 'true') await row(k, DIR).click()
  await row(k, OTHER).click({ button: 'right' })
  await k.getByRole('menuitem', { name: 'Renombrar o mover…' }).click()
  const dialog = k.getByRole('dialog')
  await dialog.getByLabel('Carpeta').fill(`${DIR}/${TOPIC}`)
  const shifts = dialog.locator('.shifts')
  await expect(shifts.locator('strong')).toHaveText('Un enlace no se reescribe pero cambiará adónde lleva')
  await expect(shifts.locator('.shifts-src')).toHaveText(`${SPACE_NAME} / ${DIR} / ${USES}1 enlace`)
  await expect(shifts.locator('.shifts-row')).toHaveText(`El enlace «${SCREEN}» era ambiguo; llevará a ${SPACE_NAME} / ${DIR} / ${TOPIC} / ${SCREEN}`)
  await shot(k, 'folder-shifts-light')
  await dialog.getByRole('button', { name: 'Mover' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(k.getByRole('alert').filter({ hasText: 'lleva ahora a otra parte' })).toHaveText(
    `«${OTHER}» ya está en su sitio. Un enlace que no se ha reescrito lleva ahora a otra parte, en: ${USES}.`)
  expect(read(`${DIR}/${USES}.md`)).toBe(uses)
  expect(existsSync(`${VAULT}/${DIR}/${TOPIC}/${OTHER}/${SCREEN}.md`)).toBe(true)
  await k.getByRole('button', { name: 'Cerrar aviso' }).click()
})
