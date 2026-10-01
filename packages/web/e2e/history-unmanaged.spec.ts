// The history in unmanaged mode (vihko.yaml `history.mode: unmanaged`): the
// notes folder's own git repository, read and never written. A commit shows
// up with its author, the tab says only what has been committed shows up,
// and what is typed doesn't become a version. At the end the folder goes
// back to the managed history the other specs use.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { AUTHOR, userGit } from '../../server/test/_userGit.ts'
import { ADMIN, NOTES, inVault, specMother } from './env.ts'
import { signIn, writeWorkspace } from './helpers.ts'

const m = specMother(import.meta.url)
const DIR = inVault(m.aFolder())
const TEXT = m.aSentence()
const NOTE = m.aNotePath(DIR)
const status = async (page: Page) => (await (await page.request.get('/api/history/status')).json()) as { mode: string; available: boolean }

test.describe.configure({ mode: 'serial' })
let k: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  writeFileSync(`${NOTES}/${NOTE}`, `# ${m.aHeading()}\n\n${TEXT}\n`)
  // The folder is a repository with one commit, by someone (a git author, not a vihko user), of this note only.
  const repo = userGit(NOTES, { since: Date.now() - 120_000 })
  repo.run(['add', '--', NOTE])
  repo.commit(m.aSentence(), AUTHOR, { add: false })
  writeWorkspace('history:\n  mode: unmanaged\n')
  k = await signIn(browser, ADMIN)
  await expect.poll(() => status(k), { timeout: 20_000 }).toEqual({ mode: 'unmanaged', available: true, error: null })
})

test.afterAll(async () => {
  writeWorkspace()
  await expect.poll(async () => (await status(k)).mode, { timeout: 20_000 }).toBe('managed')
  rmSync(`${NOTES}/.git`, { recursive: true, force: true })
  await k.context().close()
})

test('a commit of the folder\'s own git, with its author; only what has a commit shows up', async () => {
  await k.goto(`/?note=${encodeURIComponent(NOTE)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  const panel = k.getByRole('complementary', { name: 'Comentarios y contexto' })
  await panel.getByRole('tab', { name: 'Historial' }).click()
  await expect(panel.getByText('Historial del git de la carpeta de notas: solo aparece lo que tiene commit.')).toBeVisible()
  const rows = panel.locator('.h-row')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText(AUTHOR.name)
  await expect(rows.first()).toContainText('Creada')
  // A git author: the commit icon and the name, no presence dot.
  await expect(rows.first().locator('.h-dot')).toHaveCount(0)

  // What is typed isn't a version until someone commits it: nothing «in progress» either.
  await k.locator('.cm-line', { hasText: TEXT }).click()
  await k.keyboard.press('End')
  await k.keyboard.type(` ${m.aSentence()}`)
  await expect(k.getByText('Guardado en disco')).toBeVisible({ timeout: 10_000 })
  await k.waitForTimeout(4_000) // longer than the e2e server's quiet time
  await expect(panel.locator('.h-pending')).toHaveCount(0)
  await expect(rows).toHaveCount(1)

  await rows.first().click()
  await expect(k.locator('.v-band')).toContainText(AUTHOR.name)
  await expect(k.locator('.v-text ins')).toContainText(TEXT)
})
