// The trash and the files that aren't notes: a pasted image goes to the trash
// with its note and comes back with it, so its folder can then be deleted from
// the tree; a folder that holds files besides notes shows them, and sends
// them to the trash with its notes in one step, all of it restorable.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { markdownDest } from '../../core/src/images.ts'
import { ADMIN, E2E_DIR, NOTES, freshFolder, specMother } from './env.ts'
import { png, sendFiles, signIn } from './helpers.ts'

const m = specMother(import.meta.url)
/** The folder of the note with the pasted image, and the one that holds more than notes. */
const DIR = freshFolder(m.aFolder)
const FULL = freshFolder(m.aFolder)
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

async function deleteFolder(page: Page, name: string) {
  await row(page, name).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Eliminar carpeta' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Eliminar' }).click()
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
  expect(read(NOTE)).toBeNull()
  expect(images()).toEqual([])

  // Nothing is left in its folder: it goes at once.
  await deleteFolder(k, DIR)
  await expect(row(k, DIR)).toHaveCount(0)
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

  await deleteFolder(k, FULL)
  const dialog = k.getByRole('alertdialog')
  await expect(dialog.getByText('Contiene 1 nota y 2 archivos. Van a la papelera con ella y se pueden restaurar desde allí:')).toBeVisible()
  await expect(dialog.getByRole('list', { name: 'Sus notas' })).toHaveText(INSIDE.slice(FULL.length + 1))
  await expect(dialog.getByRole('list', { name: 'Sus archivos' }).getByRole('listitem')).toHaveText([KEEP, PDF])
  await shot(k, 'folder-delete-contents-light')
  expect(read(INSIDE)).not.toBeNull()

  await dialog.getByRole('button', { name: 'Mandar a la papelera y eliminar' }).click()
  await expect(row(k, FULL)).toHaveCount(0)
  expect(existsSync(`${NOTES}/${FULL}`)).toBe(false)
  const toast = k.locator('.toast', { hasText: `La carpeta «${FULL}» se ha eliminado; lo que contenía está en la papelera.` })
  await toast.getByRole('button', { name: 'Restaurar' }).click()
  await expect(toast).toHaveCount(0)
  await expect(row(k, FULL)).toBeVisible()
  expect(read(INSIDE)).toContain('# ')
  expect(readFileSync(`${NOTES}/${FULL}/${PDF}`)).toEqual(PDF_BYTES)
  expect(existsSync(`${NOTES}/${FULL}/${KEEP}`)).toBe(true)
})

test('what vihko never touches keeps the folder, and the dialog says why without offering to delete', async () => {
  // Another program's hidden folder: its name is the case under test.
  mkdirSync(`${NOTES}/${FULL}/.obsidian`, { recursive: true })
  writeFileSync(`${NOTES}/${FULL}/.obsidian/app.json`, '{}')
  await deleteFolder(k, FULL)
  const dialog = k.getByRole('alertdialog')
  await expect(dialog.getByText('vihko nunca toca las carpetas ocultas ni los enlaces', { exact: false })).toBeVisible()
  await expect(dialog.getByRole('list', { name: 'Lo que vihko no toca' })).toHaveText('.obsidian/')
  await expect(dialog.getByRole('button', { name: /Eliminar|Mandar/ })).toHaveCount(0)
  await shot(k, 'folder-delete-kept-light')
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  expect(read(INSIDE)).not.toBeNull()
  // For the cleanup through the API.
  rmSync(`${NOTES}/${FULL}/.obsidian`, { recursive: true })
})
