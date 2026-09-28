// Names with control characters: vihko never gives one (the dialog says why),
// and a note another program named that way still opens and saves.
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ADMIN, NOTES, specMother } from './env.ts'
import { editorText, signIn } from './helpers.ts'

const m = specMother(import.meta.url)
const DIR = m.aFolder()
const NOTE = `${DIR}/${m.aTitle()}.md`
/** Named by another program, with a tab in its name (the case under test). */
const TABBED = `${DIR}/${m.aTitle()}\t${m.aWord()}.md`
const BODY = { note: m.aSentence(), tabbed: m.aSentence(), typed: m.aUniqueWord() }

test.beforeAll(() => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  writeFileSync(`${NOTES}/${NOTE}`, `# ${m.aHeading()}\n\n${BODY.note}\n`)
  writeFileSync(`${NOTES}/${TABBED}`, `# ${m.aHeading()}\n\n${BODY.tabbed}\n`)
})

test('renaming a note to a name with a tab says why it cannot, and changes nothing', async ({ browser }) => {
  const k = await signIn(browser, ADMIN, NOTE)
  await k.getByRole('button', { name: 'Más acciones' }).click()
  await k.getByRole('menuitem', { name: 'Renombrar o mover…' }).click()
  const dialog = k.getByRole('dialog')
  // A pasted name can carry a tab; the text field keeps it.
  await dialog.getByLabel('Nuevo nombre').fill(`${m.aTitle()}\t${m.aWord()}`)
  await expect(dialog.getByRole('alert')).toHaveText('Los nombres no pueden llevar caracteres de control, como tabuladores o saltos de línea.')
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  expect(readdirSync(`${NOTES}/${DIR}`).sort()).toEqual([NOTE, TABBED].map((p) => p.slice(DIR.length + 1)).sort())
  await k.context().close()
})

test('a note another program named with a tab opens, and what is typed is saved', async ({ browser }) => {
  const k = await signIn(browser, ADMIN, TABBED)
  await expect.poll(() => editorText(k)).toContain(BODY.tabbed)
  await k.locator('.cm-content').click()
  await k.keyboard.press('Control+End')
  await k.keyboard.type(` ${BODY.typed}`)
  await expect.poll(() => (existsSync(`${NOTES}/${TABBED}`) ? readFileSync(`${NOTES}/${TABBED}`, 'utf8') : ''), { timeout: 15_000 }).toContain(BODY.typed)
  await k.context().close()
})
