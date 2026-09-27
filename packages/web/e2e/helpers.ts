import { expect, type Browser, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'
import { NOTES, PASSWORD, PERMISSIONS } from './env.ts'

/** Writes thoth.yaml with `text` and the permissions every spec runs under (env.ts); with nothing, only those. */
export function writeWorkspace(text = '') {
  writeFileSync(`${NOTES}/thoth.yaml`, (text === '' || text.endsWith('\n') ? text : text + '\n') + PERMISSIONS)
}

/** Own session (isolated context) with the person already signed in and the note open. */
export async function signIn(browser: Browser, user: string, note?: string): Promise<Page> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(note ? `/?note=${encodeURIComponent(note)}` : '/')
  await page.getByLabel('Nombre de usuario').fill(user)
  await page.getByLabel('Contraseña').fill(PASSWORD)
  await page.getByRole('button', { name: 'Entrar' }).last().click()
  if (note) await expect(page.locator('.cm-content')).toBeVisible()
  else await expect(page.getByRole('treegrid')).toBeVisible()
  return page
}

export const editorText = (page: Page) => page.locator('.cm-content').innerText()

/** A solid-colour PNG, so the browser really decodes and shows something. */
export function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
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

/** Dispatches a paste (or a drop) with these files, as the browser does with a screenshot on the clipboard. */
export async function sendFiles(page: Page, kind: 'paste' | 'drop', files: { name: string; bytes: Buffer }[]) {
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
