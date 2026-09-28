// M1 «done when», in a real browser over the generated 1,000-note vault:
// search from ⌘K, edit, a change made with another editor showing up live,
// and renaming the most linked note from the UI with its backlinks rewritten
// on disk and in an open editor.
import { expect, test, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { ACC_DIR, ADMIN, MEMBER, NOTES } from './env.ts'
import { editorText, signIn } from '../e2e/helpers.ts'

interface Vault { hub: string; markers: { word: string; path: string }[] }

test.describe.configure({ mode: 'serial' })
let vault: Vault
let k: Page
let a: Page
/** A note that links to the hub by name, open by the member during the rename. */
let source = ''
const read = (p: string) => readFileSync(`${NOTES}/${p}`, 'utf8')
const note = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/, '').normalize('NFC')
const report = (name: string, ms: number) => {
  test.info().annotations.push({ type: name, description: `${Math.round(ms)} ms` })
  console.log(`[acceptance:ui] ${name}: ${Math.round(ms)} ms`)
}

test.beforeAll(async ({ browser }) => {
  vault = JSON.parse(readFileSync(`${ACC_DIR}/vault.json`, 'utf8'))
  const t0 = Date.now()
  k = await signIn(browser, ADMIN)
  report('sign in → tree of 1,000 notes', Date.now() - t0)
  const links = await (await k.request.get(`/api/note/links?path=${encodeURIComponent(vault.hub)}`)).json() as { backlinks: { path: string; raw: string }[] }
  expect(links.backlinks.length).toBeGreaterThan(200)
  source = links.backlinks.find((b) => b.raw.startsWith('[[Arquitectura') && !b.path.includes('/.') && b.path === b.path.normalize('NFC'))!.path
  a = await signIn(browser, MEMBER, source)
})

test('⌘K finds a note among 1,000 and opens it', async () => {
  for (const m of vault.markers.slice(0, 5)) {
    const t0 = Date.now()
    await k.keyboard.press('Control+k')
    const palette = k.getByRole('dialog', { name: 'Buscar o crear' })
    await palette.getByRole('textbox').fill(m.word)
    await expect(palette.getByRole('option').first()).toContainText(m.word.slice(0, 6), { ignoreCase: true })
    await k.keyboard.press('Enter')
    await expect.poll(async () => (await k.locator('.crumbs b').innerText()).normalize('NFC')).toBe(note(m.path))
    await expect(k.locator('.cm-content')).toBeVisible()
    report(`search and open «${m.word}»`, Date.now() - t0)
  }
})

test('typing in the browser reaches the file and the other editor', async () => {
  await k.goto(`/?note=${encodeURIComponent(source)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  await k.locator('.cm-h1').first().click()
  await k.keyboard.press('Control+End')
  const t0 = Date.now()
  await k.keyboard.type('\nEscrito en el navegador.')
  await expect.poll(() => editorText(a)).toContain('Escrito en el navegador.')
  report('keystrokes → the other editor', Date.now() - t0)
  await expect.poll(() => read(source), { timeout: 10_000 }).toContain('Escrito en el navegador.')
  report('keystrokes → the file', Date.now() - t0)
})

test('a change made with another editor shows up live', async () => {
  const t0 = Date.now()
  writeFileSync(`${NOTES}/${source}`, read(source) + '\nCambio desde otro editor.\n')
  await expect.poll(() => editorText(a)).toContain('Cambio desde otro editor.')
  await expect.poll(() => editorText(k)).toContain('Cambio desde otro editor.')
  report('file written outside → both editors', Date.now() - t0)
})

test('renaming the most linked note from the UI rewrites its backlinks, on disk and in an open editor', async () => {
  await k.goto(`/?note=${encodeURIComponent(vault.hub)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  await k.getByRole('button', { name: 'Más acciones' }).click()
  await k.getByRole('menuitem', { name: 'Renombrar o mover…' }).click()
  const dialog = k.getByRole('dialog')
  await dialog.getByLabel('Nuevo nombre').fill('Arquitectura del sistema')
  const submit = dialog.getByRole('button', { name: /Renombrar y actualizar \d+ enlaces/ })
  await expect(submit).toBeEnabled({ timeout: 15_000 })
  const count = Number((await submit.innerText()).match(/\d+/)![0])
  expect(count).toBeGreaterThan(200)
  const t0 = Date.now()
  await submit.click()
  await expect(k.locator('.crumbs b')).toHaveText('Arquitectura del sistema', { timeout: 30_000 })
  report(`rename rewriting ${count} links`, Date.now() - t0)
  await expect.poll(() => editorText(a)).toContain('Arquitectura del sistema')
  await expect.poll(() => read(source), { timeout: 10_000 }).toContain('[[Arquitectura del sistema')
  expect(read(source)).toContain('Escrito en el navegador.')
  expect(read(source)).toContain('Cambio desde otro editor.')
})
