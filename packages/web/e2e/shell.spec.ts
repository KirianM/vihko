import { expect, test } from '@playwright/test'
import { ADMIN, specMother } from './env.ts'
import { signIn } from './helpers.ts'

const m = specMother(import.meta.url)

test('failed login, sign in, tree, theme and sign out', async ({ page, browser }) => {
  await page.goto('/')
  await page.getByLabel('Nombre de usuario').fill(ADMIN.username)
  await page.getByLabel('Contraseña').fill(m.aPassword())
  await page.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(page.getByRole('alert')).toHaveText('Usuario o contraseña incorrectos.')

  const k = await signIn(browser, ADMIN)
  // Folders first, even one with no notes (adjuntos only holds images). Other
  // specs leave folders of their own at the root: the order is what's checked,
  // not which folder comes first.
  const top = k.locator('[role="row"][aria-level="1"]')
  await expect(top.filter({ hasText: /^adjuntos$/ })).toBeVisible()
  const keys = await top.evaluateAll((els) => els.map((e) => e.getAttribute('data-key') ?? ''))
  const firstNote = keys.findIndex((key) => key.startsWith('n:'))
  expect(keys.indexOf('d:adjuntos')).toBeGreaterThanOrEqual(0)
  if (firstNote >= 0) expect(keys.slice(firstNote).some((key) => key.startsWith('d:'))).toBe(false)
  await k.getByRole('row', { name: 'diario' }).click()
  await k.keyboard.press('ArrowRight')
  await expect(k.getByRole('row', { name: '2026-09-24' })).toBeVisible()

  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await expect(k.locator('html')).toHaveAttribute('data-theme', 'dark')
  await k.reload()
  await expect(k.locator('html')).toHaveAttribute('data-theme', 'dark')

  await k.getByRole('button', { name: 'Cerrar sesión' }).click()
  await expect(k.getByRole('heading', { name: 'Entrar' })).toBeVisible()
})
