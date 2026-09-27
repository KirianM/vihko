// Per-note attachments (thoth.yaml `attachments.mode: per-note`, D-031.5): a
// pasted image lands in the note's own folder, and renaming the note renames
// that folder, with the preview saying so and every link into it rewritten.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { E2E_DIR, NOTES } from './env.ts'
import { png, sendFiles, signIn, writeWorkspace } from './helpers.ts'

const DIR = 'adjuntos'
const NOTE = `${DIR}/plan.md`
const OTHER = `${DIR}/otra.md`
const read = (p: string) => (existsSync(`${NOTES}/${p}`) ? readFileSync(`${NOTES}/${p}`, 'utf8') : null)
const BLUE = png(320, 120, [30, 74, 134])

test.describe.configure({ mode: 'serial' })
let k: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  writeFileSync(`${NOTES}/${NOTE}`, '# Plan\n\nCon imágenes.\n')
  writeFileSync(`${NOTES}/${DIR}/sonda.md`, '# Sonda\n')
  writeWorkspace('attachments:\n  mode: per-note\n')
  k = await signIn(browser, 'noa', NOTE)
  // Until thoth.yaml is read again (watcher or rescan), uploads still go next to the note.
  await expect.poll(async () => {
    const r = await k.request.post(`/api/attachments?note=${encodeURIComponent(`${DIR}/sonda.md`)}`, { data: BLUE, headers: { 'content-type': 'image/png' } })
    return ((await r.json()) as { path: string }).path.startsWith(`${DIR}/sonda.assets/`)
  }, { timeout: 15_000 }).toBe(true)
})

test.afterAll(() => writeWorkspace())

test('a pasted image goes to the note\'s own folder; renaming the note takes the folder along', async () => {
  await k.locator('.cm-h1').click()
  await k.keyboard.press('Control+End')
  await k.keyboard.press('Enter')
  await sendFiles(k, 'paste', [{ name: 'image.png', bytes: BLUE }])
  await expect.poll(() => read(NOTE)).toMatch(/!\[\]\(plan\.assets\/\d{4}-\d{2}-\d{2}-\d{4}\.png\)/)
  const name = /plan\.assets\/([\d-]+\.png)/.exec(read(NOTE)!)![1]!
  expect(readdirSync(`${NOTES}/${DIR}/plan.assets`)).toEqual([name])

  // Another note uses it too; once the index knows, the preview lists that link.
  writeFileSync(`${NOTES}/${OTHER}`, `# Otra\n\n![](plan.assets/${name})\n`)
  const preview = async () => (await (await k.request.post('/api/note/move', { data: { from: NOTE, to: `${DIR}/hoja de ruta.md`, dryRun: true } })).json()) as { images: { folder: unknown }; relinked: unknown[] }
  await expect.poll(async () => (await preview()).relinked.length, { timeout: 15_000 }).toBe(2)

  await k.getByRole('button', { name: 'Más acciones' }).click()
  await k.getByRole('menuitem', { name: 'Renombrar o mover…' }).click()
  const dialog = k.getByRole('dialog')
  await dialog.getByLabel('Nuevo nombre').fill('hoja de ruta')
  await expect(dialog.locator('.preview-image')).toHaveText('adjuntos / plan.assets /carpeta de la nota (1 archivo): va con ella como adjuntos / hoja de ruta.assets /')
  await expect(dialog.locator('.preview-change', { hasText: `![](plan.assets/${name}) → ![](hoja%20de%20ruta.assets/${name})` })).toHaveCount(2)
  await k.screenshot({ path: `${E2E_DIR}/shots/move-assets-folder.png` })
  await dialog.getByRole('button', { name: 'Renombrar y actualizar 2 enlaces' }).click()
  await expect(k.locator('.crumbs')).toHaveText('adjuntos / hoja de ruta')

  expect(existsSync(`${NOTES}/${DIR}/plan.assets`)).toBe(false)
  expect(readFileSync(`${NOTES}/${DIR}/hoja de ruta.assets/${name}`)).toEqual(BLUE)
  await expect.poll(() => read(OTHER)).toContain(`![](hoja%20de%20ruta.assets/${name})`)
  expect(read(`${DIR}/hoja de ruta.md`)).toContain(`![](hoja%20de%20ruta.assets/${name})`)
  await k.locator('.cm-h1').click()
  await expect.poll(() => k.locator('.cm-image img').evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).naturalWidth))).toEqual([320])
})
