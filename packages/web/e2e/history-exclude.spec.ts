// A note kept out of the history by vihko.yaml (`history.exclude`): vihko still
// opens and edits it, and its history tab says why it has no versions instead
// of looking empty. At the end the folder goes back to having no vihko.yaml.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, NOTES, specMother } from './env.ts'
import { signIn, writeWorkspace } from './helpers.ts'

const m = specMother(import.meta.url)
const DIR = m.aFolder()
const NOTE = m.aNotePath(DIR)
const TEXT = m.aSentence()
const excluded = async (page: Page) => {
  const q = new URLSearchParams()
  q.set('path', NOTE)
  return ((await (await page.request.get(`/api/history/versions?${q}`)).json()) as { excluded?: boolean }).excluded
}

test.describe.configure({ mode: 'serial' })
let k: Page

test.beforeAll(async ({ browser }) => {
  k = await signIn(browser, ADMIN)
  // The pattern first: the note is never in the history.
  writeWorkspace(`history:\n  exclude:\n    - ${JSON.stringify(`${DIR}/**`)}\n`)
  await expect.poll(() => excluded(k), { timeout: 20_000 }).toBe(true)
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  writeFileSync(`${NOTES}/${NOTE}`, `# ${m.aHeading()}\n\n${TEXT}\n`)
})

test.afterAll(async () => {
  // Gone while still excluded: it never reaches the history the other specs read.
  await k.goto('/')
  const q = new URLSearchParams()
  q.set('path', NOTE)
  expect((await k.request.delete(`/api/note?${q}`)).ok()).toBe(true)
  writeWorkspace()
  await expect.poll(() => excluded(k), { timeout: 20_000 }).toBe(false)
  await k.context().close()
})

test('an excluded note: its history tab says it is kept out, and typing makes no version', async () => {
  const q = new URLSearchParams()
  q.set('note', NOTE)
  await k.goto(`/?${q}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  const panel = k.getByRole('complementary', { name: 'Comentarios y contexto' })
  await panel.getByRole('tab', { name: 'Historial' }).click()
  const notice = panel.getByText('Este archivo está fuera del historial (history.exclude en vihko.yaml): sus cambios no se guardan como versiones.')
  await expect(notice).toBeVisible()
  await expect(panel.getByText('Esta nota aún no tiene versiones.')).toHaveCount(0)
  mkdirSync(`${E2E_DIR}/shots`, { recursive: true })
  await panel.screenshot({ path: `${E2E_DIR}/shots/history-tab-excluded.png`, animations: 'disabled' })

  // Still a note like any other: it is edited and saved.
  await k.locator('.cm-line', { hasText: TEXT }).click()
  await k.keyboard.press('End')
  await k.keyboard.type(` ${m.aSentence()}`)
  await expect(k.getByText('Guardado en disco')).toBeVisible({ timeout: 10_000 })
  await k.waitForTimeout(4_000) // longer than the e2e server's quiet time
  await expect(panel.locator('.h-pending')).toHaveCount(0)
  await expect(panel.locator('.h-row')).toHaveCount(0)
  await expect(notice).toBeVisible()
})
