// Paleta «Buscar o crear»: búsqueda en el índice, notas recientes, crear una
// nota en la carpeta actual, comandos y la versión móvil.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { NOTES } from './env.ts'
import { signIn } from './helpers.ts'

test.describe.configure({ mode: 'serial' })
let k: Page

test.beforeAll(async ({ browser }) => {
  k = await signIn(browser, 'noa')
})

const palette = () => k.getByRole('dialog', { name: 'Buscar o crear' })
const field = () => palette().getByRole('textbox')

test('⌘K busca sin tildes, resalta y abre la nota con ↵', async () => {
  await k.keyboard.press('Control+k')
  await expect(field()).toBeFocused()
  await field().fill('cafe')
  const first = palette().getByRole('option').first()
  await expect(first).toContainText(/Cafe\u0301|Café/)
  await expect(first).toContainText('recetas /')
  await expect(first.locator('mark').first()).toBeVisible()
  await k.keyboard.press('Enter')
  await expect(palette()).toHaveCount(0)
  // El archivo de prueba está en NFD a propósito: se compara normalizado.
  await expect.poll(async () => (await k.locator('.crumbs b').innerText()).normalize('NFC')).toBe('Café')
  await expect(k.locator('.cm-content')).toBeVisible()
})

test('con la consulta vacía muestra las recientes; esc cierra', async () => {
  await k.goto('/?note=hogar/Red.md')
  await expect(k.locator('.cm-content')).toBeVisible()
  await k.getByRole('button', { name: 'Buscar o crear…' }).click()
  await expect(palette().getByRole('group', { name: 'Recientes' }).getByRole('option', { name: /Cafe\u0301|Café/ })).toBeVisible()
  await k.keyboard.press('Escape')
  await expect(palette()).toHaveCount(0)
})

test('crea la nota en la carpeta actual, refresca el árbol y la abre', async () => {
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

test('crear una que ya existe muestra el error traducido', async () => {
  await k.keyboard.press('Control+k')
  await field().fill('Red')
  await palette().getByRole('option', { name: /^Crear «Red»/ }).click()
  await expect(palette().getByRole('alert')).toHaveText('Ya existe una nota con ese nombre.')
  await k.keyboard.press('Escape')
})

test('el botón «+» pide el nombre y crea en la carpeta actual', async () => {
  await k.getByRole('button', { name: 'Nueva nota' }).click()
  const dialog = k.getByRole('dialog', { name: 'Nueva nota' })
  await dialog.getByRole('textbox').fill('Desde el más')
  await k.keyboard.press('Enter')
  await expect(k.locator('.crumbs b')).toHaveText('Desde el más')
  expect(existsSync(`${NOTES}/hogar/Desde el más.md`)).toBe(true)
})

test('modo comandos con «>»: tema oscuro y nueva nota', async () => {
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

test('móvil: la paleta ocupa la pantalla y se abre desde la cabecera', async ({ browser }) => {
  const m = await signIn(browser, 'ana', 'hogar/Red.md')
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
