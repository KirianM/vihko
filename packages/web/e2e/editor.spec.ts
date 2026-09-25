// Coedición de extremo a extremo: dos personas en la misma nota, el archivo en
// disco como verdad, cambios y borrados hechos fuera de thoth.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { NOTES } from './env.ts'
import { editorText, signIn } from './helpers.ts'

const NOTE = 'hogar/Proxy.md'
const FILE = `${NOTES}/${NOTE}`
const disk = () => (existsSync(FILE) ? readFileSync(FILE, 'utf8') : '')

test.describe.configure({ mode: 'serial' })
let k: Page
let a: Page

test.beforeAll(async ({ browser }) => {
  k = await signIn(browser, 'noa', NOTE)
  a = await signIn(browser, 'ana', NOTE)
})

test('al abrir: presencia con colores distintos, guardado, frontmatter plegado y sin marcas', async () => {
  const avatars = k.locator('.presence .avatar')
  await expect(avatars).toHaveCount(2)
  const bgs = await avatars.evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor))
  expect(bgs[0]).not.toBe(bgs[1])
  await expect(k.locator('.status')).toHaveText('Guardado en disco')
  await expect(k.locator('.cm-frontmatter-chip')).toHaveText('frontmatter · 1 clave')
  await expect(k.locator('.cm-h1')).toHaveText('Proxy')
})

test('dos personas escriben a la vez y el archivo converge con uid y frontmatter intacto', async () => {
  await k.locator('.cm-content').click()
  await k.keyboard.press('Control+End')
  await k.keyboard.type('\nEscrito por noa con **negrita** y [[Red]].')
  await a.locator('.cm-line', { hasText: 'Red' }).first().click()
  await a.keyboard.press('End')
  await a.keyboard.type('\nvmbr0 escrito por ana')

  await expect.poll(disk).toContain('Escrito por noa con **negrita** y [[Red]].')
  await expect.poll(disk).toContain('vmbr0 escrito por ana')
  expect(disk()).toMatch(/^---\naliases: \[gw, Hipervisor\]\n/)
  expect(disk()).toMatch(/\nuid: [0-9A-Z]{26}\n/)
  await expect(k.locator('.status')).toHaveText('Guardado en disco')
  await expect.poll(() => editorText(a)).toContain('Escrito por noa')
  await expect.poll(() => editorText(k)).toContain('vmbr0 escrito por ana')
  await expect(k.locator('.cm-ySelectionCaret').first()).toBeAttached()
})

test('un cambio hecho fuera de thoth aparece en vivo', async () => {
  writeFileSync(FILE, disk().replace('## Almacenamiento', '## Almacenamiento (editado fuera)'))
  await expect.poll(() => editorText(a)).toContain('(editado fuera)')
})

test('vista previa: marcas ocultas fuera del cursor y wikilink resuelto', async () => {
  await k.locator('.cm-h1').click()
  await expect(k.locator('.cm-line', { hasText: 'Escrito por noa' })).toHaveText('Escrito por noa con negrita y Red.')
  await expect(k.locator('.cm-wikilink-resolved a', { hasText: 'Red' })).toBeVisible()
})

test('estados de enlaces y navegación por alias', async () => {
  await k.goto('/?note=hogar/enlaces.md')
  await expect(k.locator('.cm-wikilink-missing').first()).toBeVisible()
  await k.locator('.cm-wikilink-resolved a', { hasText: 'gw' }).click()
  await expect(k.locator('.crumbs b')).toHaveText('Proxy')
})

test('borrado fuera con la nota abierta: aviso, no se recrea, y la copia se conserva', async () => {
  await a.locator('.cm-content').click()
  await a.keyboard.press('Control+End')
  await a.keyboard.type('\nlínea antes del borrado')
  await expect.poll(disk).toContain('antes del borrado')
  rmSync(FILE)
  await expect(a.getByRole('alert')).toContainText('se ha borrado fuera')
  await a.keyboard.type('\nlínea después del borrado')
  await a.waitForTimeout(2000)
  expect(existsSync(FILE)).toBe(false)
  await a.getByRole('button', { name: 'Conservar mi copia' }).click()
  await expect.poll(disk).toContain('después del borrado')
  expect(disk()).toContain('antes del borrado')
  await expect(a.locator('.banner')).toHaveCount(0)
})
