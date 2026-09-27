// "Search or create" palette: searching the index, recent notes, creating a
// note in the current folder, commands, and the mobile version.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { ADMIN, MEMBER, NOTES } from './env.ts'
import { signIn } from './helpers.ts'

test.describe.configure({ mode: 'serial' })
let k: Page

test.beforeAll(async ({ browser }) => {
  k = await signIn(browser, ADMIN)
})

const palette = () => k.getByRole('dialog', { name: 'Buscar o crear' })
const field = () => palette().getByRole('textbox')

test('⌘K searches ignoring accents, highlights, and opens the note with ↵', async () => {
  await k.keyboard.press('Control+k')
  await expect(field()).toBeFocused()
  await field().fill('cafe')
  const first = palette().getByRole('option').first()
  await expect(first).toContainText(/Cafe\u0301|Café/)
  await expect(first).toContainText('recetas /')
  await expect(first.locator('mark').first()).toBeVisible()
  await k.keyboard.press('Enter')
  await expect(palette()).toHaveCount(0)
  // The test file is in NFD on purpose: it's compared normalized.
  await expect.poll(async () => (await k.locator('.crumbs b').innerText()).normalize('NFC')).toBe('Café')
  await expect(k.locator('.cm-content')).toBeVisible()
})

test('with an empty query shows recents; esc closes', async () => {
  await k.goto('/?note=hogar/Red.md')
  await expect(k.locator('.cm-content')).toBeVisible()
  await k.getByRole('button', { name: 'Buscar o crear…' }).click()
  await expect(palette().getByRole('group', { name: 'Recientes' }).getByRole('option', { name: /Cafe\u0301|Café/ })).toBeVisible()
  await k.keyboard.press('Escape')
  await expect(palette()).toHaveCount(0)
})

test('creates the note in the current folder, refreshes the tree, and opens it', async () => {
  await k.keyboard.press('Control+k')
  await field().fill('Nota de prueba/e2e')
  const create = palette().getByRole('option', { name: 'Crear «Nota de prueba-e2e» en hogar' })
  await expect(create).toBeVisible()
  await create.click()
  await expect(k.locator('.crumbs b')).toHaveText('Nota de prueba-e2e')
  await expect(k.locator('.cm-content')).toContainText('Nota de prueba/e2e')
  const file = `${NOTES}/hogar/Nota de prueba-e2e.md`
  expect(existsSync(file)).toBe(true)
  expect(readFileSync(file, 'utf8')).toContain('# Nota de prueba/e2e\n')
  await k.getByRole('row', { name: 'hogar' }).click()
  await k.keyboard.press('ArrowRight')
  await expect(k.getByRole('row', { name: 'Nota de prueba-e2e' })).toBeVisible()
})

test('creating one that already exists shows the translated error', async () => {
  await k.keyboard.press('Control+k')
  await field().fill('Red')
  await palette().getByRole('option', { name: /^Crear «Red»/ }).click()
  await expect(palette().getByRole('alert')).toHaveText('Ya existe una nota con ese nombre.')
  await k.keyboard.press('Escape')
})

test('the "+" button asks for the name and creates in the current folder', async () => {
  await k.getByRole('button', { name: 'Nueva nota' }).click()
  const dialog = k.getByRole('dialog', { name: 'Nueva nota' })
  await dialog.getByRole('textbox').fill('Desde el más')
  await k.keyboard.press('Enter')
  await expect(k.locator('.crumbs b')).toHaveText('Desde el más')
  expect(existsSync(`${NOTES}/hogar/Desde el más.md`)).toBe(true)
})

test('command mode with ">": dark theme and new note', async () => {
  await k.keyboard.press('Control+k')
  await field().fill('>tema')
  await expect(palette().getByRole('option')).toHaveCount(1)
  await k.keyboard.press('Enter')
  await expect(k.locator('html')).toHaveAttribute('data-theme', 'dark')
  await k.keyboard.press('Control+k')
  await field().fill('> nueva')
  await k.keyboard.press('Enter')
  await expect(k.getByRole('dialog', { name: 'Nueva nota' })).toBeVisible()
  await k.keyboard.press('Escape')
  await k.keyboard.press('Control+k')
  await field().fill('>tema claro')
  await k.keyboard.press('Enter')
  await expect(k.locator('html')).toHaveAttribute('data-theme', 'light')
})

test('mobile: the palette fills the screen and opens from the header', async ({ browser }) => {
  const m = await signIn(browser, MEMBER, 'hogar/Red.md')
  await m.setViewportSize({ width: 390, height: 844 })
  await m.getByRole('button', { name: 'Buscar', exact: true }).click()
  const dialog = m.getByRole('dialog', { name: 'Buscar o crear' })
  await dialog.getByRole('textbox').fill('proxy red')
  await expect(dialog.getByRole('option').first()).toContainText('Proxy')
  const box = await m.locator('.palette').boundingBox()
  expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 844 })
  const create = dialog.getByRole('option', { name: /^Crear «proxy red» en hogar/ })
  expect((await create.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await expect(dialog).toHaveCount(0)
})
