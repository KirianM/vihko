// «Users and groups» → Retention: off by default; turning a period on shows
// first what the next run would remove (counts, never a path) and asks for
// the admin's password; a longer period, or off, is saved at once; what is
// saved is what the page shows after a reload. «Run now» applies what is
// saved at once, with the same preview and confirmation. On a phone too.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { ADMIN, E2E_DIR, specMother } from './env.ts'
import { signIn } from './helpers.ts'

const m = specMother(import.meta.url)
const SHOTS = `${E2E_DIR}/shots`

test.describe.configure({ mode: 'serial' })
test.beforeAll(() => { mkdirSync(SHOTS, { recursive: true }) })
// Both off again, whatever happened: the other specs run on this server.
test.afterAll(async ({ browser }) => {
  const page = await signIn(browser, ADMIN)
  const r = await page.request.put('/api/admin/settings', { data: { trashRetentionDays: null, historyRetentionDays: null } })
  expect(r.ok()).toBe(true)
  await page.context().close()
})

const section = (page: Page) => page.getByRole('region', { name: 'Retención' })
const trashSwitch = (page: Page) => section(page).getByRole('switch', { name: /Vaciar la papelera/ })
const historySwitch = (page: Page) => section(page).getByRole('switch', { name: /Borrar versiones del historial/ })
/** React Aria's switch: its input is hidden, the label takes the click. */
const flip = (page: Page, name: string) => section(page).locator('label.switch', { hasText: name }).click()
const flipTrash = (page: Page) => flip(page, 'Vaciar la papelera')
const flipHistory = (page: Page) => flip(page, 'Borrar versiones del historial')

async function open(page: Page) {
  await page.goto('/?view=users')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Usuarios y grupos')
  await expect(section(page)).toBeVisible()
}

test('the admin turns retention on after a preview and the password, lengthens it at once, and turns it off', async ({ browser }) => {
  const page = await signIn(browser, ADMIN)
  await open(page)
  await expect(trashSwitch(page)).not.toBeChecked()
  await expect(historySwitch(page)).not.toBeChecked()

  // On: how long, then the preview and the password.
  await flipTrash(page)
  const trashDays = section(page).getByRole('textbox', { name: 'Días en la papelera' })
  await expect(trashDays).toHaveValue('30')
  await trashDays.fill('7')
  await flipHistory(page)
  await section(page).getByRole('textbox', { name: 'Antigüedad de las versiones' }).fill('6')
  await expect(section(page).getByRole('combobox', { name: 'Unidad' })).toHaveValue('months')
  await section(page).getByRole('button', { name: 'Guardar' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByRole('heading')).toHaveText('¿Borrar más a partir de la próxima vez?')
  const preview = dialog.getByTestId('retention-preview')
  await expect(preview).toContainText('papelera')
  await expect(preview).toContainText('historial')
  await expect(preview).toContainText('cada semana')
  await page.screenshot({ path: `${SHOTS}/retention-confirm.png` })
  const confirm = dialog.getByRole('button', { name: 'Guardar y borrar' })
  await expect(confirm).toBeDisabled()
  await dialog.getByLabel('Tu contraseña').fill(m.aPassword())
  await confirm.click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await dialog.getByLabel('Tu contraseña').fill(ADMIN.password)
  await confirm.click()
  await expect(dialog).toBeHidden()
  await expect(section(page).getByRole('button', { name: 'Guardar' })).toBeHidden()

  // Saved: what the page shows after a reload.
  await page.reload()
  await expect(trashSwitch(page)).toBeChecked()
  await expect(section(page).getByRole('textbox', { name: 'Días en la papelera' })).toHaveValue('7')
  await expect(section(page).getByRole('textbox', { name: 'Antigüedad de las versiones' })).toHaveValue('6')
  await expect(section(page).getByRole('combobox', { name: 'Unidad' })).toHaveValue('months')
  await expect(section(page).getByTestId('retention-status')).toContainText('Aún no se ha aplicado.')
  await expect(section(page).getByTestId('retention-status')).toContainText('Próxima:')
  await section(page).screenshot({ path: `${SHOTS}/retention-on.png` })

  // Run now: the same preview and confirmation, then the last run says so.
  await section(page).getByRole('button', { name: 'Aplicar ahora' }).click()
  const run = page.getByRole('alertdialog')
  await expect(run.getByRole('heading')).toHaveText('¿Aplicar la retención ahora?')
  await expect(run.getByTestId('retention-preview')).toContainText('papelera')
  await expect(run.getByTestId('retention-preview')).not.toContainText('cada semana')
  await run.getByLabel('Tu contraseña').fill(m.aPassword())
  await run.getByRole('button', { name: 'Borrar ahora' }).click()
  await expect(run.getByRole('alert')).toBeVisible()
  await run.getByLabel('Tu contraseña').fill(ADMIN.password)
  await run.getByRole('button', { name: 'Borrar ahora' }).click()
  await expect(run).toBeHidden()
  await expect(section(page).getByTestId('retention-status')).toContainText('Última vez:')

  // Longer: saved at once, nothing to confirm.
  await section(page).getByRole('textbox', { name: 'Días en la papelera' }).fill('60')
  await section(page).getByRole('button', { name: 'Guardar' }).click()
  await expect(section(page).getByRole('button', { name: 'Guardar' })).toBeHidden()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  // Not a number: said, and nothing to save.
  await section(page).getByRole('textbox', { name: 'Días en la papelera' }).fill('0')
  await expect(section(page).getByRole('alert')).toContainText('número entero')
  await expect(section(page).getByRole('button', { name: 'Guardar' })).toBeDisabled()
  await section(page).getByRole('button', { name: 'Cancelar' }).click()
  await expect(section(page).getByRole('textbox', { name: 'Días en la papelera' })).toHaveValue('60')

  // Off: at once too.
  await flipTrash(page)
  await flipHistory(page)
  await section(page).getByRole('button', { name: 'Guardar' }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await page.reload()
  await expect(trashSwitch(page)).not.toBeChecked()
  await expect(historySwitch(page)).not.toBeChecked()
  await expect(section(page).getByTestId('retention-status')).not.toContainText('Próxima:')
  await page.context().close()
})

test('on a phone the section fits the screen', async ({ browser }) => {
  const page = await signIn(browser, ADMIN)
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  await flipTrash(page)
  await flipHistory(page)
  const box = await section(page).boundingBox()
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  const unit = await section(page).getByRole('combobox', { name: 'Unidad' }).boundingBox()
  expect(unit!.x + unit!.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: `${SHOTS}/retention-phone.png`, fullPage: true })
  await page.context().close()
})
