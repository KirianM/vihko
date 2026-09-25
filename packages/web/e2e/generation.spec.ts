// A tab whose copy of a note belongs to another generation of the hub's
// document: the hub lost the saved state while the tab was offline. The tab
// must not merge its copy (the note would duplicate); it reopens the note and
// offers to keep what it couldn't send as a copy.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { E2E_DIR, NOTES, PASSWORD } from './env.ts'
import { editorText } from './helpers.ts'

const DIR = 'generation-tests'
const state = (note: string) => `${E2E_DIR}/state/collab/${encodeURIComponent(note)}.ystate`
const count = (text: string, line: string) => text.split(line).length - 1

/**
 * Opens `note` (a new one with `First line.`), types a line that reaches the
 * file, then drops the connection, loses the hub's saved state, types
 * `Unsent line.` and comes back online. Resolves once the notice is shown.
 */
async function staleTab(browser: Browser, note: string): Promise<Page> {
  const file = `${NOTES}/${note}`
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  writeFileSync(file, `# ${note.slice(DIR.length + 1, -3)}\n\nFirst line.\n`)
  const page = await (await browser.newContext()).newPage()
  // The network, under the test's control: while offline, every connection to /collab is dropped.
  let offline = false
  const live: { close(): void }[] = []
  await page.routeWebSocket(/\/collab$/, (ws) => {
    if (offline) return void ws.close()
    live.push(ws, ws.connectToServer())
  })
  await page.goto(`/?note=${encodeURIComponent(note)}`)
  await page.getByLabel('Nombre de usuario').fill('noa')
  await page.getByLabel('Contraseña').fill(PASSWORD)
  await page.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(page.locator('.cm-content')).toBeVisible()
  await page.locator('.cm-h1').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nSent line.')
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('Sent line.')

  // The connection drops; the hub closes the note and saves its state… which is then lost.
  offline = true
  for (const c of live.splice(0)) c.close()
  await expect(page.locator('.status')).toContainText('Sin conexión')
  await expect.poll(() => existsSync(state(note)), { timeout: 15_000 }).toBe(true)
  rmSync(state(note))
  await page.keyboard.type('\nUnsent line.')
  offline = false

  // Back online: the tab gets the note as the hub has it, and a notice.
  await expect(page.getByRole('alert')).toContainText('no llegaron a guardarse', { timeout: 30_000 })
  await expect(page.locator('.status')).toHaveText('Guardado en disco')
  const text = await editorText(page)
  const disk = readFileSync(file, 'utf8')
  for (const t of [text, disk]) {
    expect(t).not.toContain('Unsent line.')
    expect(count(t, 'Sent line.')).toBe(1)
    expect(count(t, 'First line.')).toBe(1)
  }
  return page
}

test('the saved state is lost while a tab is offline: no duplication, and its unsent text is kept as a copy', async ({ browser }) => {
  const note = `${DIR}/Stale tab.md`
  const page = await staleTab(browser, note)
  await page.screenshot({ path: 'test-results/generation-notice.png' })
  // Keep my version as a copy: a new note next to it, with its own uid, is opened.
  await page.getByRole('alert').getByRole('button', { name: 'Guardar mi versión como copia' }).click()
  await expect(page.locator('.crumbs b')).toContainText('Stale tab (sin enviar')
  await expect.poll(() => editorText(page)).toContain('Unsent line.')
  const copies = readdirSync(`${NOTES}/${DIR}`).filter((f) => f.startsWith('Stale tab (sin enviar '))
  expect(copies).toHaveLength(1)
  const copy = readFileSync(`${NOTES}/${DIR}/${copies[0]}`, 'utf8')
  expect(copy).toContain('Sent line.')
  expect(copy).toContain('Unsent line.')
  const uid = (t: string) => /^uid: (\S+)$/m.exec(t)?.[1]
  expect(uid(copy)).toBeTruthy()
  expect(uid(copy)).not.toBe(uid(readFileSync(`${NOTES}/${note}`, 'utf8')))
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('discarding the unsent text: the notice goes, no copy is made and editing goes on', async ({ browser }) => {
  const note = `${DIR}/Discarded tab.md`
  const page = await staleTab(browser, note)
  await page.getByRole('alert').getByRole('button', { name: 'Descartar' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(readdirSync(`${NOTES}/${DIR}`).filter((f) => f.startsWith('Discarded tab ('))).toHaveLength(0)
  await page.locator('.cm-h1').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nStill live.')
  await expect.poll(() => readFileSync(`${NOTES}/${note}`, 'utf8')).toContain('Still live.')
  await expect(page.locator('.status')).toHaveText('Guardado en disco')
})
