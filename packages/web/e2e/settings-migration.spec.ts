// A key vihko retired, migrated at start: on the locked server the admin's
// own settings named templates folders (serve.ts wrote them as an older
// vihko left them). Its start marked the notes of the folder that's there as
// templates, removed the key, and told the admin: said on coming in, and in
// Alerts with the file and the folder that was gone.
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, LOCKED_TEMPLATES, LOCKED_URL, personal } from './env.ts'

const SHOTS = `${E2E_DIR}/shots`
const HOME = `${E2E_DIR}/locked/notes/${personal(ADMIN)}`

test('templates folders in someone\'s settings: converted at start, the key gone, and they are told what was done', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: LOCKED_URL })
  const page = await ctx.newPage()
  await expect.poll(async () => (await page.request.get('/api/health').catch(() => null))?.status(), { timeout: 30_000 }).toBe(200)
  // Done by the start, before anyone came in.
  expect(readFileSync(`${HOME}/.vihko/settings.yaml`, 'utf8')).toBe('version: 1\n')
  expect(readFileSync(`${HOME}/${LOCKED_TEMPLATES.folder}/${LOCKED_TEMPLATES.note}.md`, 'utf8')).toMatch(/^---\ntemplate: true\n(uid: \S+\n)?---\n# \{\{title\}\}\n$/)

  await page.goto('/')
  await page.getByLabel('Nombre de usuario').fill(ADMIN.username)
  await page.getByLabel('Contraseña').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(page.getByRole('treegrid').first()).toBeVisible()
  // Said on coming in.
  await expect(page.getByText('Tus carpetas de plantillas se han convertido').first()).toBeVisible()

  await page.goto('/?view=alerts')
  const card = page.locator('.alert-card', { hasText: 'Tus carpetas de plantillas se han convertido' })
  await expect(card).toContainText(`vihko marcó como plantilla 1 nota de las carpetas que ~${ADMIN.username}/.vihko/settings.yaml nombraba en «templates»`)
  await expect(card).toContainText('Estas carpetas que nombraba ya no existen')
  await expect(card.getByRole('listitem')).toHaveText(LOCKED_TEMPLATES.gone)
  // Nothing else to warn about in the file.
  await expect(page.locator('.alert-card', { hasText: 'Los ajustes de tus notas tienen algo mal' })).toHaveCount(0)
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await card.screenshot({ path: `${SHOTS}/settings-migrated-${theme}.png` })
  }
  await page.emulateMedia({ colorScheme: null })
  await card.getByRole('button', { name: 'Entendido' }).click()
  await expect(card).toHaveCount(0)
  await ctx.close()
})
