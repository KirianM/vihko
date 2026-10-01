// Images in notes (D-028): pasted, dropped and picked files land next to the
// note and render in the editor; an image URL is copied or linked; external
// images carry a mark; a missing one shows a broken state.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { markdownDest } from '../../core/src/images.ts'
import { ADMIN, E2E_DIR, EXTERNAL_PORT, NOTES, inVault, specMother } from './env.ts'
import { literally, png, sendFiles, signIn } from './helpers.ts'

const m = specMother(import.meta.url)
const DIR = inVault(m.aFolder())
const TITLE = m.aTitle()
const NOTE = `${DIR}/${TITLE}.md`
/** Images on the "external" server, one it has and one it doesn't; two missing from the vault. */
const [REMOTE, REMOTE_MISSING, MISSING, MISSING_EMBED] = Array.from({ length: 4 }, () => `${m.aUniqueWord()}.png`) as [string, string, string, string]
const FILE = `${NOTES}/${NOTE}`
const SHOTS = `${E2E_DIR}/shots`
const EXTERNAL = `http://localhost:${EXTERNAL_PORT}`
const disk = () => readFileSync(FILE, 'utf8')
/** The images stored next to the note: named after it and the time. */
const stored = () => readdirSync(`${NOTES}/${DIR}`).filter((f) => new RegExp(`^${literally(TITLE)}-\\d{4}-\\d{2}-\\d{2}-\\d{4}(-\\d+)?\\.png$`, 'u').test(f)).sort()
/** How the editor links a stored image. */
const link = (name: string) => `![](${markdownDest(name)})`

const BLUE = png(320, 120, [30, 74, 134])
const GREEN = png(240, 90, [60, 140, 90])
const ORANGE = png(200, 80, [210, 120, 40])

test.describe.configure({ mode: 'serial' })
let k: Page
let external: Server

test.beforeAll(async ({ browser }) => {
  external = createServer((req, res) => {
    if (req.url === `/${encodeURI(REMOTE)}`) { res.setHeader('content-type', 'image/png'); res.end(ORANGE) } else { res.statusCode = 404; res.end() }
  })
  await new Promise<void>((r) => external.listen(EXTERNAL_PORT, '127.0.0.1', r))
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  writeFileSync(FILE, `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
  k = await signIn(browser, ADMIN, NOTE)
})

test.afterAll(() => { external.closeAllConnections(); external.close() })

async function pasteText(page: Page, text: string) {
  await page.locator('.cm-content').evaluate((el, text) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', text)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, text)
}

/** Cursor at the end of the note (clicking the title: the middle may land on an image). */
async function toEnd(page: Page) {
  await page.locator('.cm-h1').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
}

test('a pasted image is stored next to the note, linked relatively and shown', async () => {
  await toEnd(k)
  await sendFiles(k, 'paste', [{ name: 'image.png', bytes: BLUE }])
  await expect.poll(stored).toHaveLength(1)
  const [name] = stored()
  expect(readFileSync(`${NOTES}/${DIR}/${name}`)).toEqual(BLUE)
  await expect.poll(disk).toContain(link(name!))
  // Out of the image: it replaces its source.
  await k.locator('.cm-h1').click()
  const img = k.locator('.cm-image img').first()
  await expect(img).toBeVisible()
  expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(320)
  await expect(k.locator('.cm-line', { hasText: link(name!) })).toHaveCount(0)
})

test('a dropped image and one picked from «Insertar imagen» land the same way', async () => {
  await toEnd(k)
  await sendFiles(k, 'drop', [{ name: 'soltada.png', bytes: GREEN }])
  await expect.poll(stored).toHaveLength(2)
  await toEnd(k)
  await k.getByRole('button', { name: 'Más acciones' }).click()
  await k.getByRole('menuitem', { name: 'Insertar imagen…' }).click()
  await expect(k.getByRole('dialog')).toContainText('Insertar imagen')
  await k.locator('input[type=file]').setInputFiles({ name: 'elegida.png', mimeType: 'image/png', buffer: ORANGE })
  await expect.poll(stored).toHaveLength(3)
  for (const name of stored()) await expect.poll(disk).toContain(link(name))
  await k.locator('.cm-h1').click()
  await expect(k.locator('.cm-image img')).toHaveCount(3)
})

test('«insertar imagen» from the palette opens the same dialog', async () => {
  await k.keyboard.press('Control+k')
  await k.keyboard.type('>insertar imagen')
  await k.keyboard.press('Enter')
  await expect(k.getByRole('dialog', { name: 'Insertar imagen' })).toBeVisible()
  await k.keyboard.press('Escape')
  await expect(k.getByRole('dialog')).toHaveCount(0)
})

test('a pasted image URL: «Enlazar al origen» keeps the address and shows it as external', async () => {
  await toEnd(k)
  await pasteText(k, `${EXTERNAL}/${REMOTE}`)
  const dialog = k.getByRole('dialog')
  await expect(dialog).toContainText('Has pegado la dirección de una imagen')
  await expect(dialog.getByRole('button', { name: 'Guardar copia' })).toBeFocused()
  await dialog.getByRole('button', { name: 'Enlazar al origen' }).click()
  await expect.poll(disk).toContain(`![](${EXTERNAL}/${REMOTE})`)
  await k.locator('.cm-h1').click()
  const ext = k.locator('.cm-image-external')
  await expect(ext.locator('img')).toBeVisible()
  await expect(ext.locator('.cm-image-mark')).toHaveText('externa')
})

test('a pasted image URL: «Guardar copia» downloads it on the server; «Pegar como texto» pastes the text', async () => {
  await toEnd(k)
  await pasteText(k, `${EXTERNAL}/${REMOTE}`)
  await k.keyboard.press('Enter') // the default: save a copy
  await expect.poll(stored).toHaveLength(4)
  const copy = stored().find((n) => readFileSync(`${NOTES}/${DIR}/${n}`).equals(ORANGE) && disk().includes(link(n)))
  expect(copy).toBeTruthy()

  await toEnd(k)
  await pasteText(k, `${EXTERNAL}/${REMOTE_MISSING}`)
  await k.getByRole('button', { name: 'Pegar como texto' }).click()
  await expect.poll(disk).toMatch(new RegExp(`\\n${literally(`${EXTERNAL}/${REMOTE_MISSING}`)}\\n?$`, 'u'))
})

test('a missing image shows a broken state, and image links are not broken note links', async () => {
  writeFileSync(FILE, `${disk()}\n![](${MISSING})\n\n![[${MISSING_EMBED}]]\n`)
  await expect(k.locator('.cm-image-missing')).toHaveCount(2)
  await expect(k.locator('.cm-image-missing').first()).toHaveText(`Imagen no encontrada · ${MISSING}`)
  await expect(k.locator('.cm-wikilink-missing')).toHaveCount(0)
  await expect(k.locator('.cm-image img')).toHaveCount(5)
})

test('screenshots: light, dark and 390 px', async () => {
  await k.locator('.cm-h1').click()
  await k.screenshot({ path: `${SHOTS}/images-light.png` })
  await k.locator('.cm-image-missing').last().scrollIntoViewIfNeeded()
  await k.screenshot({ path: `${SHOTS}/images-states-light.png` })
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await k.screenshot({ path: `${SHOTS}/images-dark.png` })
  await k.setViewportSize({ width: 390, height: 844 })
  // On a phone, the editor bar has its own button for it.
  await k.getByRole('toolbar').getByRole('button', { name: 'Insertar imagen' }).click()
  await expect(k.getByRole('dialog', { name: 'Insertar imagen' })).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/images-insert-390.png` })
  await k.keyboard.press('Escape')
  await k.screenshot({ path: `${SHOTS}/images-390.png` })
  await k.setViewportSize({ width: 1280, height: 800 })
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
})

// Inserting never goes inside another image's or a link's syntax (insertAt.ts):
// the cursor can be in it while it's hidden, or after a click on a preview.
test('an image inserted from the dialog right after pasting another, and a look at its preview: both references stay whole', async ({ browser }) => {
  const title = m.aTitle()
  const note = `${DIR}/${title}.md`
  const text = () => readFileSync(`${NOTES}/${note}`, 'utf8')
  writeFileSync(`${NOTES}/${note}`, `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
  const p = await signIn(browser, ADMIN, note)
  await toEnd(p)
  await sendFiles(p, 'paste', [{ name: 'image.png', bytes: GREEN }])
  const mine = () => readdirSync(`${NOTES}/${DIR}`).filter((f) => f.startsWith(`${title}-`) && f.endsWith('.png'))
  await expect.poll(mine).toHaveLength(1)
  const pasted = link(mine()[0]!)
  await expect.poll(text).toContain(pasted)
  // A click on its preview, and some typing: the reference isn't split.
  await p.locator('.cm-image img').click()
  const typed = m.aUniqueWord()
  await p.keyboard.type(typed)
  await expect.poll(text).toContain(typed)
  expect(text()).toContain(pasted)
  // Another one from the dialog, from where the cursor is.
  const url = `${EXTERNAL}/${REMOTE}`
  await p.getByRole('button', { name: 'Más acciones' }).click()
  await p.getByRole('menuitem', { name: 'Insertar imagen…' }).click()
  await p.getByRole('dialog').getByLabel('Dirección de la imagen').fill(url)
  await p.getByRole('dialog').getByRole('button', { name: 'Enlazar al origen' }).click()
  await expect.poll(text).toContain(`![](${url})`)
  expect(text()).toContain(pasted)
  await p.context().close()
})

test('with the cursor inside a link\'s syntax, an inserted image goes after the link', async ({ browser }) => {
  const title = m.aTitle()
  const note = `${DIR}/${title}.md`
  const text = () => readFileSync(`${NOTES}/${note}`, 'utf8')
  const linked = `[${m.aWord()}](${encodeURIComponent(m.aTitle())}.md)`
  writeFileSync(`${NOTES}/${note}`, `# ${m.aHeading()}\n\n${linked}\n`)
  const p = await signIn(browser, ADMIN, note)
  // At the end of the link's line (its syntax shows), then into its destination.
  await p.locator('.cm-h1').click()
  await p.keyboard.press('Control+End')
  await p.keyboard.press('ArrowUp')
  await p.keyboard.press('End')
  for (let i = 0; i < 3; i++) await p.keyboard.press('ArrowLeft')
  const url = `${EXTERNAL}/${REMOTE}`
  await p.getByRole('button', { name: 'Más acciones' }).click()
  await p.getByRole('menuitem', { name: 'Insertar imagen…' }).click()
  await p.getByRole('dialog').getByLabel('Dirección de la imagen').fill(url)
  await p.getByRole('dialog').getByRole('button', { name: 'Enlazar al origen' }).click()
  await expect.poll(text).toContain(`${linked}![](${url})\n`)
  await p.context().close()
})
