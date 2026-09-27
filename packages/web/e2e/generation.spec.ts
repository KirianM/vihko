// A tab that loses its connection while the note is closed in thoth.
//
// If the hub then loses its saved state, the tab's copy belongs to another
// generation of the document: it must not merge it (the note would duplicate);
// it reopens the note and offers to keep what it couldn't send as a copy.
//
// If the hub keeps its saved state and the file is changed with another
// editor meanwhile (thoth running), the change is merged into that state and
// the tab's copy merges as usual: no copy, nothing twice (D-032.4).
import { expect, test, type Browser, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, MEMBER, NOTES } from './env.ts'
import { editorText, signIn } from './helpers.ts'

const DIR = 'generation-tests'
const state = (note: string) => `${E2E_DIR}/state/collab/${encodeURIComponent(note)}.ystate`
const count = (text: string, line: string) => text.split(line).length - 1

/**
 * Opens `note` (a new one with `First line.`) in a tab whose network is under
 * the test's control, and types `Sent line.`, which reaches the file.
 */
async function openTab(browser: Browser, note: string) {
  const file = `${NOTES}/${note}`
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  writeFileSync(file, `# ${note.slice(DIR.length + 1, -3)}\n\nFirst line.\n`)
  const page = await (await browser.newContext()).newPage()
  // While offline, every connection to /collab is dropped.
  let offline = false
  const live: { close(): void }[] = []
  await page.routeWebSocket(/\/collab$/, (ws) => {
    if (offline) return void ws.close()
    live.push(ws, ws.connectToServer())
  })
  await page.goto(`/?note=${encodeURIComponent(note)}`)
  await page.getByLabel('Nombre de usuario').fill(ADMIN.username)
  await page.getByLabel('Contraseña').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(page.locator('.cm-content')).toBeVisible()
  await page.locator('.cm-h1').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nSent line.')
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('Sent line.')
  return {
    page, file,
    /** The connection drops. Resolves once the hub has closed the note and saved its state. */
    async drop() {
      rmSync(state(note), { force: true })
      offline = true
      for (const c of live.splice(0)) c.close()
      await expect(page.locator('.status')).toContainText('Sin conexión')
      await expect.poll(() => existsSync(state(note)), { timeout: 15_000 }).toBe(true)
    },
    reconnect() { offline = false },
  }
}

/** Another editor adds a line to the file, below `First line.`. */
function editOutside(file: string) {
  writeFileSync(file, readFileSync(file, 'utf8').replace('First line.\n', 'First line.\nExternal line.\n'))
}

/**
 * The tab drops its connection, the hub's saved state is lost, the tab types
 * `Unsent line.` and comes back online. Resolves once the notice is shown.
 */
async function staleTab(browser: Browser, note: string): Promise<Page> {
  const { page, file, drop, reconnect } = await openTab(browser, note)
  await drop()
  rmSync(state(note))
  await page.keyboard.type('\nUnsent line.')
  reconnect()

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

/** Every line once, in each of `texts`. */
function once(texts: string[], lines: string[]) {
  for (const t of texts) for (const line of lines) expect(count(t, line), `${line} in:\n${t}`).toBe(1)
}

test('changed with another editor while a tab is offline: what the tab typed merges, with no copy and nothing twice', async ({ browser }) => {
  const note = `${DIR}/Offline merge.md`
  const { page, file, drop, reconnect } = await openTab(browser, note)
  await drop()
  editOutside(file)
  await page.keyboard.type('\nUnsent line.')
  reconnect()

  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 30_000 }).toContain('Unsent line.')
  await expect.poll(() => editorText(page)).toContain('External line.')
  await expect(page.locator('.status')).toHaveText('Guardado en disco')
  await expect(page.getByRole('alert')).toHaveCount(0)
  once([await editorText(page), readFileSync(file, 'utf8')], ['First line.', 'External line.', 'Sent line.', 'Unsent line.'])
})

test('two sessions: someone opens the note while a tab is offline; the tab merges and both see everything once', async ({ browser }) => {
  const note = `${DIR}/Two sessions.md`
  const { page, file, drop, reconnect } = await openTab(browser, note)
  await drop()
  editOutside(file)
  await page.keyboard.type('\nUnsent line.')

  // The member opens it meanwhile: the other editor's change is there, and they type.
  const member = await signIn(browser, MEMBER, note)
  await expect.poll(() => editorText(member)).toContain('External line.')
  await member.locator('.cm-h1').click()
  await member.keyboard.press('Control+End')
  await member.keyboard.type('\nMember line.')
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('Member line.')

  reconnect()
  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 30_000 }).toContain('Unsent line.')
  await expect.poll(() => editorText(member)).toContain('Unsent line.')
  await expect.poll(() => editorText(page)).toContain('Member line.')
  for (const p of [page, member]) {
    await expect(p.locator('.status')).toHaveText('Guardado en disco')
    await expect(p.getByRole('alert')).toHaveCount(0)
  }
  await page.screenshot({ path: 'test-results/generation-offline-merge.png' })
  once([await editorText(page), await editorText(member), readFileSync(file, 'utf8')],
    ['First line.', 'External line.', 'Sent line.', 'Unsent line.', 'Member line.'])
})
