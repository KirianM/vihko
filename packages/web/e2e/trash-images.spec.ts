// The trash and the files that aren't notes: a pasted image goes to the trash
// with its note and comes back with it, so its folder can then be deleted from
// the tree; a folder that holds files besides notes shows them, and sends
// them to the trash with its notes in one step, all of it restorable.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { markdownDest } from '../../core/src/images.ts'
import { ADMIN, E2E_DIR, NOTES, freshFolder, inVault, specMother } from './env.ts'
import { png, sendFiles, signIn } from './helpers.ts'

const m = specMother(import.meta.url)
/** The folder of the note with the pasted image, and the one that holds more than notes. */
const DIR_NAME = freshFolder(m.aFolder)
const FULL_NAME = freshFolder(m.aFolder)
const DIR = inVault(DIR_NAME)
const FULL = inVault(FULL_NAME)
const TITLE = m.aTitle()
const NOTE = `${DIR}/${TITLE}.md`
const INSIDE = `${FULL}/${m.aTitle()}.md`
const PDF = `${m.aUniqueWord()}.pdf`
const PDF_BYTES = Buffer.from(`%PDF-1.4\n${m.aSentence()}\n`)
// A hidden file someone put there: its name is the case under test.
const KEEP = '.keep'
const BLUE = png(160, 60, [30, 74, 134])

const read = (p: string) => (existsSync(`${NOTES}/${p}`) ? readFileSync(`${NOTES}/${p}`, 'utf8') : null)
const images = () => (existsSync(`${NOTES}/${DIR}`) ? readdirSync(`${NOTES}/${DIR}`).filter((f) => f.endsWith('.png')) : [])
const row = (page: Page, name: string) => page.getByRole('row', { name, exact: true })
const shot = (page: Page, name: string) => page.screenshot({ path: `${E2E_DIR}/shots/${name}.png`, animations: 'disabled' })

/** Opens a folder's delete dialog: what it holds is named before anything goes. */
async function deleteFolder(page: Page, name: string) {
  await row(page, name).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Eliminar carpeta' }).click()
}

test.describe.configure({ mode: 'serial' })
let k: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  writeFileSync(`${NOTES}/${NOTE}`, `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
  k = await signIn(browser, ADMIN, NOTE)
})

test.afterAll(async () => {
  // Through the API (never rm): whatever a failed test left, to the trash.
  for (const dir of [DIR, FULL]) await k.request.delete(`/api/folder?path=${encodeURIComponent(dir)}&trash=true`)
})

test('a pasted image goes to the trash with its note; the folder can then be deleted, and «Restaurar» brings both back', async () => {
  await k.locator('.cm-h1').click()
  await k.keyboard.press('Control+End')
  await k.keyboard.press('Enter')
  await sendFiles(k, 'paste', [{ name: 'image.png', bytes: BLUE }])
  await expect.poll(images).toHaveLength(1)
  const [image] = images() as [string]
  await expect.poll(() => read(NOTE)).toContain(`![](${markdownDest(image)})`)

  await k.getByRole('button', { name: 'Más acciones' }).click()
  await k.getByRole('menuitem', { name: 'Mover a la papelera' }).click()
  await k.getByRole('alertdialog').getByRole('button', { name: 'Mover a la papelera' }).click()
  const toast = k.locator('.toast', { hasText: `«${TITLE}» está en la papelera.` })
  await expect(toast).toBeVisible()
  // Gone: polled, as the open editor lets go of it just after the answer.
  await expect.poll(() => read(NOTE), { timeout: 5_000 }).toBeNull()
  expect(images()).toEqual([])

  // Nothing is left in its folder: it goes at once.
  await deleteFolder(k, DIR_NAME)
  await k.getByRole('alertdialog').getByRole('button', { name: 'Eliminar', exact: true }).click()
  await expect(row(k, DIR_NAME)).toHaveCount(0)
  expect(existsSync(`${NOTES}/${DIR}`)).toBe(false)

  await toast.getByRole('button', { name: 'Restaurar' }).click()
  await expect(k.locator('.crumbs b')).toHaveText(TITLE)
  expect(readFileSync(`${NOTES}/${DIR}/${image}`)).toEqual(BLUE)
  expect(read(NOTE)).toContain(`![](${markdownDest(image)})`)
  await k.locator('.cm-h1').click()
  await expect(k.locator('.cm-image img')).toBeVisible()
  expect(await k.locator('.cm-image img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(160)
})

test('a folder with files besides its notes lists them, and sends them to the trash with its notes; «Restaurar» brings it all back', async () => {
  mkdirSync(`${NOTES}/${FULL}`, { recursive: true })
  writeFileSync(`${NOTES}/${INSIDE}`, `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
  writeFileSync(`${NOTES}/${FULL}/${PDF}`, PDF_BYTES)
  writeFileSync(`${NOTES}/${FULL}/${KEEP}`, '')
  await expect.poll(async () => (await (await k.request.get('/api/tree')).json() as { folders: string[] }).folders.includes(FULL), { timeout: 15_000 }).toBe(true)
  await k.reload()

  await deleteFolder(k, FULL_NAME)
  const dialog = k.getByRole('alertdialog')
  await expect(dialog.getByText('Contiene 1 nota y 2 archivos. Van a la papelera con ella y se pueden restaurar desde allí:')).toBeVisible()
  await expect(dialog.getByRole('list', { name: 'Sus notas' })).toHaveText(INSIDE.slice(FULL.length + 1))
  await expect(dialog.getByRole('list', { name: 'Sus archivos' }).getByRole('listitem')).toHaveText([KEEP, PDF])
  await shot(k, 'folder-delete-contents-light')
  expect(read(INSIDE)).not.toBeNull()

  await dialog.getByRole('button', { name: 'Mandar a la papelera y eliminar' }).click()
  await expect(row(k, FULL_NAME)).toHaveCount(0)
  expect(existsSync(`${NOTES}/${FULL}`)).toBe(false)
  const toast = k.locator('.toast', { hasText: `La carpeta «${FULL_NAME}» se ha eliminado; lo que contenía está en la papelera.` })
  await toast.getByRole('button', { name: 'Restaurar' }).click()
  await expect(toast).toHaveCount(0)
  await expect(row(k, FULL_NAME)).toBeVisible()
  expect(read(INSIDE)).toContain('# ')
  expect(readFileSync(`${NOTES}/${FULL}/${PDF}`)).toEqual(PDF_BYTES)
  expect(existsSync(`${NOTES}/${FULL}/${KEEP}`)).toBe(true)
})

test('hidden folders vihko doesn\'t show are named before anything goes (the known ones by what they are), go to the trash with the folder and come back', async () => {
  // Other programs' hidden folders: their names are the case under test.
  const other = `.${m.aUniqueWord()}`
  const hidden = { '.obsidian/app.json': `{"theme":"${m.aWord()}"}`, '.git/HEAD': m.aSentence(), [`${other}/x`]: m.aSentence() }
  for (const [p, text] of Object.entries(hidden)) {
    mkdirSync(`${NOTES}/${FULL}/${p.slice(0, p.lastIndexOf('/'))}`, { recursive: true })
    writeFileSync(`${NOTES}/${FULL}/${p}`, text)
  }
  await deleteFolder(k, FULL_NAME)
  const dialog = k.getByRole('alertdialog')
  await expect(dialog.getByText('También van a la papelera estas carpetas ocultas, que vihko no muestra (3 archivos):')).toBeVisible()
  // In the order of their paths, as listed.
  const named = [['.git/', 'Repositorio de Git (.git)'], ['.obsidian/', 'Ajustes de Obsidian (.obsidian)'], [`${other}/`, other]].sort(([a], [b]) => (a! < b! ? -1 : 1)).map(([, label]) => label!)
  await expect(dialog.getByRole('list', { name: 'Carpetas ocultas' }).getByRole('listitem')).toHaveText(named)
  for (const theme of ['light', 'dark'] as const) {
    await k.emulateMedia({ colorScheme: theme })
    await dialog.screenshot({ path: `${E2E_DIR}/shots/folder-delete-hidden-${theme}.png` })
  }
  await k.emulateMedia({ colorScheme: null })
  await dialog.getByRole('button', { name: 'Mandar a la papelera y eliminar' }).click()
  await expect(row(k, FULL_NAME)).toHaveCount(0)
  expect(existsSync(`${NOTES}/${FULL}`)).toBe(false)
  const toast = k.locator('.toast', { hasText: `La carpeta «${FULL_NAME}» se ha eliminado; lo que contenía está en la papelera.` })
  await toast.getByRole('button', { name: 'Restaurar' }).click()
  await expect(toast).toHaveCount(0)
  await expect(row(k, FULL_NAME)).toBeVisible()
  for (const [p, text] of Object.entries(hidden)) expect(read(`${FULL}/${p}`)).toBe(text)
  for (const dir of ['.obsidian', '.git', other]) rmSync(`${NOTES}/${FULL}/${dir}`, { recursive: true })
})

test('a link vihko never follows keeps the folder, and the dialog says why without offering to delete', async () => {
  const link = m.aUniqueWord()
  symlinkSync(`${NOTES}/${INSIDE}`, `${NOTES}/${FULL}/${link}`)
  await deleteFolder(k, FULL_NAME)
  const dialog = k.getByRole('alertdialog')
  await expect(dialog.getByText('vihko nunca sigue ni borra los enlaces', { exact: false })).toBeVisible()
  await expect(dialog.getByRole('list', { name: 'Lo que vihko no toca' })).toHaveText(link)
  await expect(dialog.getByRole('button', { name: /Eliminar|Mandar/ })).toHaveCount(0)
  await shot(k, 'folder-delete-kept-light')
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  expect(read(INSIDE)).not.toBeNull()
  // For the cleanup through the API.
  rmSync(`${NOTES}/${FULL}/${link}`)
})
