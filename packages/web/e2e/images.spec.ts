// Images in notes (D-028): pasted, dropped and picked files land next to the
// note and render in the editor; an image URL is copied or linked; external
// images carry a mark; a missing one shows a broken state.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { crc32, deflateSync } from 'node:zlib'
import { E2E_DIR, NOTES } from './env.ts'
import { signIn } from './helpers.ts'

const DIR = 'imagenes'
const NOTE = `${DIR}/galeria.md`
const FILE = `${NOTES}/${NOTE}`
const SHOTS = `${E2E_DIR}/shots`
// Another origin for "external" images: a server in the test process.
const EXTERNAL_PORT = 8132
const EXTERNAL = `http://localhost:${EXTERNAL_PORT}`
const disk = () => readFileSync(FILE, 'utf8')
const stored = () => readdirSync(`${NOTES}/${DIR}`).filter((f) => /^galeria-\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?\.png$/.test(f)).sort()

/** A solid-colour PNG, so the browser really decodes and shows something. */
function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8) // 8 bits, RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const BLUE = png(320, 120, [30, 74, 134])
const GREEN = png(240, 90, [60, 140, 90])
const ORANGE = png(200, 80, [210, 120, 40])

test.describe.configure({ mode: 'serial' })
let k: Page
let external: Server

test.beforeAll(async ({ browser }) => {
  external = createServer((req, res) => {
    if (req.url === '/grafico.png') { res.setHeader('content-type', 'image/png'); res.end(ORANGE) } else { res.statusCode = 404; res.end() }
  })
  await new Promise<void>((r) => external.listen(EXTERNAL_PORT, '127.0.0.1', r))
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  writeFileSync(FILE, '# Galería\n\nImágenes de prueba.\n')
  k = await signIn(browser, 'noa', NOTE)
})

test.afterAll(() => { external.closeAllConnections(); external.close() })

/** Dispatches a paste (or a drop) with these files, as the browser does with a screenshot on the clipboard. */
async function sendFiles(page: Page, kind: 'paste' | 'drop', files: { name: string; bytes: Buffer }[]) {
  await page.locator('.cm-content').evaluate((el, { kind, files }) => {
    const dt = new DataTransfer()
    for (const f of files) dt.items.add(new File([Uint8Array.from(f.bytes)], f.name, { type: 'image/png' }))
    if (kind === 'paste') {
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    } else {
      const line = el.querySelector('.cm-line:last-child')!.getBoundingClientRect()
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: line.left + 5, clientY: line.top + 5 }))
    }
  }, { kind, files: files.map((f) => ({ name: f.name, bytes: [...f.bytes] })) })
}

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
  await expect.poll(disk).toContain(`![](${name})`)
  // Out of the image: it replaces its source.
  await k.locator('.cm-h1').click()
  const img = k.locator('.cm-image img').first()
  await expect(img).toBeVisible()
  expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(320)
  await expect(k.locator('.cm-line', { hasText: `![](${name})` })).toHaveCount(0)
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
  for (const name of stored()) await expect.poll(disk).toContain(`![](${name})`)
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
  await pasteText(k, `${EXTERNAL}/grafico.png`)
  const dialog = k.getByRole('dialog')
  await expect(dialog).toContainText('Has pegado la dirección de una imagen')
  await expect(dialog.getByRole('button', { name: 'Guardar copia' })).toBeFocused()
  await dialog.getByRole('button', { name: 'Enlazar al origen' }).click()
  await expect.poll(disk).toContain(`![](${EXTERNAL}/grafico.png)`)
  await k.locator('.cm-h1').click()
  const ext = k.locator('.cm-image-external')
  await expect(ext.locator('img')).toBeVisible()
  await expect(ext.locator('.cm-image-mark')).toHaveText('externa')
})

test('a pasted image URL: «Guardar copia» downloads it on the server; «Pegar como texto» pastes the text', async () => {
  await toEnd(k)
  await pasteText(k, `${EXTERNAL}/grafico.png`)
  await k.keyboard.press('Enter') // the default: save a copy
  await expect.poll(stored).toHaveLength(4)
  const copy = stored().find((n) => readFileSync(`${NOTES}/${DIR}/${n}`).equals(ORANGE) && disk().includes(`![](${n})`))
  expect(copy).toBeTruthy()

  await toEnd(k)
  await pasteText(k, `${EXTERNAL}/otra.png`)
  await k.getByRole('button', { name: 'Pegar como texto' }).click()
  await expect.poll(disk).toMatch(new RegExp(`\\n${EXTERNAL}/otra\\.png\\n?$`))
})

test('a missing image shows a broken state, and image links are not broken note links', async () => {
  writeFileSync(FILE, `${disk()}\n![](no-existe.png)\n\n![[tampoco.png]]\n`)
  await expect(k.locator('.cm-image-missing')).toHaveCount(2)
  await expect(k.locator('.cm-image-missing').first()).toHaveText('Imagen no encontrada · no-existe.png')
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
  await k.getByRole('button', { name: 'Más acciones' }).click()
  await k.getByRole('menuitem', { name: 'Insertar imagen…' }).click()
  await k.screenshot({ path: `${SHOTS}/images-insert-390.png` })
  await k.keyboard.press('Escape')
  await k.screenshot({ path: `${SHOTS}/images-390.png` })
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
  await k.setViewportSize({ width: 1280, height: 800 })
})
