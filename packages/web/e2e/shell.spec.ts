import { expect, test } from '@playwright/test'
import { ADMIN, SPACE_NAME, inVault, specMother } from './env.ts'
import { signIn, spaceTree } from './helpers.ts'

const m = specMother(import.meta.url)

test('failed login, sign in, tree, theme and sign out', async ({ page, browser }) => {
  await page.goto('/')
  await page.getByLabel('Nombre de usuario').fill(ADMIN.username)
  await page.getByLabel('Contraseña').fill(m.aPassword())
  await page.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(page.getByRole('alert')).toHaveText('Usuario o contraseña incorrectos.')

  const k = await signIn(browser, ADMIN)
  // The vault's space: folders first, even one with no notes (adjuntos only
  // holds images). Other specs leave folders of their own there: the order is
  // what's checked, not which folder comes first.
  const tree = spaceTree(k, SPACE_NAME)
  const top = tree.locator('[role="row"][aria-level="1"]')
  await expect(top.filter({ hasText: /^adjuntos$/ })).toBeVisible()
  const keys = await top.evaluateAll((els) => els.map((e) => e.getAttribute('data-key') ?? ''))
  const firstNote = keys.findIndex((key) => key.startsWith('n:'))
  expect(keys.indexOf(`d:${inVault('adjuntos')}`)).toBeGreaterThanOrEqual(0)
  if (firstNote >= 0) expect(keys.slice(firstNote).some((key) => key.startsWith('d:'))).toBe(false)
  await tree.getByRole('row', { name: 'diario' }).click()
  await k.keyboard.press('ArrowRight')
  await expect(tree.getByRole('row', { name: '2026-09-24' })).toBeVisible()

  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await expect(k.locator('html')).toHaveAttribute('data-theme', 'dark')
  await k.reload()
  await expect(k.locator('html')).toHaveAttribute('data-theme', 'dark')

  await k.getByRole('button', { name: 'Cerrar sesión' }).click()
  await expect(k.getByRole('heading', { name: 'Entrar' })).toBeVisible()
})
