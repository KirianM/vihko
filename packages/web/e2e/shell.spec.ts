import { expect, test } from '@playwright/test'
import { signIn } from './helpers.ts'

test('failed login, sign in, tree, theme and sign out', async ({ page, browser }) => {
  await page.goto('/')
  await page.getByLabel('Nombre de usuario').fill('noa')
  await page.getByLabel('Contraseña').fill('mala-contraseña')
  await page.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(page.getByRole('alert')).toHaveText('Usuario o contraseña incorrectos.')

  const k = await signIn(browser, 'noa')
  const rows = k.getByRole('row')
  await expect(rows.first()).toHaveText('diario')
  await rows.first().click()
  await k.keyboard.press('ArrowRight')
  await expect(k.getByRole('row', { name: '2026-09-24' })).toBeVisible()

  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await expect(k.locator('html')).toHaveAttribute('data-theme', 'dark')
  await k.reload()
  await expect(k.locator('html')).toHaveAttribute('data-theme', 'dark')

  await k.getByRole('button', { name: 'Cerrar sesión' }).click()
  await expect(k.getByRole('heading', { name: 'Entrar' })).toBeVisible()
})
