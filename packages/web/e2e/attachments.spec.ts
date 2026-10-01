// Per-note attachments (vihko.yaml `attachments.mode: per-note`, D-031.5): a
// pasted image lands in the note's own folder, and renaming the note renames
// that folder, with the preview saying so and every link into it rewritten.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { markdownDest } from '../../core/src/images.ts'
import { ADMIN, E2E_DIR, NOTES, SPACE_NAME, inVault, specMother } from './env.ts'
import { literally, png, sendFiles, signIn, writeWorkspace } from './helpers.ts'

const m = specMother(import.meta.url)
const FOLDER = m.aFolder()
const DIR = inVault(FOLDER)
/** The folder as the UI shows it: the space's name, then the folder. */
const SHOWN = `${SPACE_NAME} / ${FOLDER}`
const TITLE = m.aTitle()
const NOTE = `${DIR}/${TITLE}.md`
const OTHER = m.aNotePath(DIR)
const PROBE = m.aNotePath(DIR)
/** The new name, and the note's attachments folder before and after, as Markdown links write them. */
const RENAMED = m.aTitle()
const ASSETS = markdownDest(`${TITLE}.assets`)
const RENAMED_ASSETS = markdownDest(`${RENAMED}.assets`)
const read = (p: string) => (existsSync(`${NOTES}/${p}`) ? readFileSync(`${NOTES}/${p}`, 'utf8') : null)
const BLUE = png(320, 120, [30, 74, 134])

test.describe.configure({ mode: 'serial' })
let k: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  writeFileSync(`${NOTES}/${NOTE}`, `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
  writeFileSync(`${NOTES}/${PROBE}`, `# ${m.aHeading()}\n`)
  writeWorkspace('attachments:\n  mode: per-note\n')
  k = await signIn(browser, ADMIN, NOTE)
  // Until vihko.yaml is read again (watcher or rescan), uploads still go next to the note.
  await expect.poll(async () => {
    const r = await k.request.post(`/api/attachments?note=${encodeURIComponent(PROBE)}`, { data: BLUE, headers: { 'content-type': 'image/png' } })
    return ((await r.json()) as { path: string }).path.startsWith(`${PROBE.replace(/\.md$/, '')}.assets/`)
  }, { timeout: 15_000 }).toBe(true)
})

test.afterAll(() => writeWorkspace())

test('a pasted image goes to the note\'s own folder; renaming the note takes the folder along', async () => {
  await k.locator('.cm-h1').click()
  await k.keyboard.press('Control+End')
  await k.keyboard.press('Enter')
  await sendFiles(k, 'paste', [{ name: 'image.png', bytes: BLUE }])
  await expect.poll(() => read(NOTE)).toMatch(new RegExp(`!\\[\\]\\(${literally(ASSETS)}/\\d{4}-\\d{2}-\\d{2}-\\d{4}\\.png\\)`))
  const name = new RegExp(`${literally(ASSETS)}/([\\d-]+\\.png)`).exec(read(NOTE)!)![1]!
  expect(readdirSync(`${NOTES}/${DIR}/${TITLE}.assets`)).toEqual([name])

  // Another note uses it too; once the index knows, the preview lists that link.
  writeFileSync(`${NOTES}/${OTHER}`, `# ${m.aHeading()}\n\n![](${ASSETS}/${name})\n`)
  const preview = async () => (await (await k.request.post('/api/note/move', { data: { from: NOTE, to: `${DIR}/${RENAMED}.md`, dryRun: true } })).json()) as { images: { folder: unknown }; relinked: unknown[] }
  await expect.poll(async () => (await preview()).relinked.length, { timeout: 15_000 }).toBe(2)

  await k.getByRole('button', { name: 'Más acciones' }).click()
  await k.getByRole('menuitem', { name: 'Renombrar o mover…' }).click()
  const dialog = k.getByRole('dialog')
  await dialog.getByLabel('Nuevo nombre').fill(RENAMED)
  // In words, never Markdown nor paths on disk.
  await expect(dialog.locator('.preview-line', { hasText: 'carpeta de imágenes' })).toHaveText(`La carpeta de imágenes de la nota (1 archivo) va con ella a ${SHOWN} / ${RENAMED}.assets.`)
  await expect(dialog.locator('.preview-line', { hasText: `la imagen ${name} se enlaza en su nuevo sitio` })).toHaveCount(2)
  await expect(dialog.locator('.preview')).not.toContainText('![')
  await k.screenshot({ path: `${E2E_DIR}/shots/move-assets-folder.png` })
  await dialog.getByRole('button', { name: 'Renombrar y actualizar 2 enlaces' }).click()
  await expect(k.locator('.crumbs')).toHaveText(`${SHOWN} / ${RENAMED}`)

  expect(existsSync(`${NOTES}/${DIR}/${TITLE}.assets`)).toBe(false)
  expect(readFileSync(`${NOTES}/${DIR}/${RENAMED}.assets/${name}`)).toEqual(BLUE)
  await expect.poll(() => read(OTHER)).toContain(`![](${RENAMED_ASSETS}/${name})`)
  expect(read(`${DIR}/${RENAMED}.md`)).toContain(`![](${RENAMED_ASSETS}/${name})`)
  await k.locator('.cm-h1').click()
  await expect.poll(() => k.locator('.cm-image img').evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).naturalWidth))).toEqual([320])
})
