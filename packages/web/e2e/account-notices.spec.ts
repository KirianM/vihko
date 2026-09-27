// Notices addressed to a person (M4.1, D-040 3.1 and 3.6) in real browsers:
// the admin resets a member's second factor, confirming with his own
// password; the member sees it when she signs in, and so does the other
// admin, in theirs. The admin purges from the history a note she wrote in,
// and one of hers he can't read (confirming again): she is told who and
// what, never the content. Users and notes of their own, removed at the end.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { createHmac } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { E2E_DIR, PASSWORD, unique } from './env.ts'
import { signIn, usePermissions } from './helpers.ts'

const SHOTS = `${E2E_DIR}/shots`
const CARMEN = unique('avi-carmen')
const BRUNO = unique('avi-bruno')
const SHARED = 'avisos-e2e/lista.md'
// A personal folder: the only kind the admin, managing the root, can't read (D-040 3.5).
const PRIVATE = `avisos-personas/${CARMEN}/diario.md`

test.describe.configure({ mode: 'serial', timeout: 120_000 })

let admin: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true })
  // Carmen edits everywhere and has a folder of her own that nobody else reads, the admin included.
  await usePermissions({ grants: { [CARMEN]: 'edit', [BRUNO]: 'read' }, rules: { 'avisos-personas/{user}': { '{user}': 'manage' } } })
  admin = await signIn(browser, 'noa')
  for (const [username, role] of [[CARMEN, 'member'], [BRUNO, 'admin']]) {
    expect((await admin.request.post('/api/admin/users', { data: { username, role, password: `${username}-contraseña` } })).status()).toBe(201)
  }
})

test.afterAll(async ({ browser }) => {
  const carmen = await password(browser, CARMEN)
  for (const path of [SHARED, PRIVATE]) await carmen.request.delete(`/api/note?path=${encodeURIComponent(path)}`)
  // Each folder, by whoever manages it: Carmen hers, the admin the other one.
  await carmen.request.delete(`/api/folder?path=${encodeURIComponent(`avisos-personas/${CARMEN}`)}`)
  await admin.request.delete('/api/folder?path=avisos-e2e')
  await carmen.context().close()
  await usePermissions()
  for (const u of (await (await admin.request.get('/api/admin/users')).json()).users as { id: string; username: string }[]) {
    if (u.username !== CARMEN && u.username !== BRUNO) continue
    await admin.request.post(`/api/admin/users/${u.id}/disable`)
    await admin.request.delete(`/api/admin/users/${u.id}`)
  }
  await admin.context().close()
})

/** Signs in with the password alone, in a browser of its own (`options`: a phone, dark mode…). */
async function password(browser: Browser, user: string, options: Parameters<Browser['newContext']>[0] = {}) {
  const page = await (await browser.newContext({ locale: 'es-ES', ...options })).newPage()
  await page.goto('/')
  await page.getByLabel('Nombre de usuario').fill(user)
  await page.getByLabel('Contraseña').fill(`${user}-contraseña`)
  await page.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(page.getByRole('treegrid')).toBeVisible()
  return page
}

/** A TOTP code (RFC 6238) for a base32 secret, as the authenticator app computes it. */
function totp(secretText: string, step = Math.floor(Date.now() / 30_000)): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const ch of secretText.replace(/\s/g, '').toUpperCase()) {
    value = ((value << 5) | alphabet.indexOf(ch)) & 0xffff
    bits += 5
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(step))
  const h = createHmac('sha1', Buffer.from(bytes)).update(msg).digest()
  const o = h[h.length - 1]! & 15
  return String((((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000).padStart(6, '0')
}

const row = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(`^${name}\\b`) })

async function openUsers(page: Page) {
  await page.getByRole('button', { name: 'Preferencias' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Usuarios y grupos' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Usuarios y grupos')
}

test('the admin resets a member\'s second factor with his own password; she is told when she signs in, and so is the other admin', async ({ browser }) => {
  // Carmen sets up her second factor (through the API: the UI of it has its own spec).
  const carmenSetup = await password(browser, CARMEN)
  const s = await (await carmenSetup.request.post('/api/account/2fa/setup', { data: { password: `${CARMEN}-contraseña` } })).json() as { secret: string }
  expect((await carmenSetup.request.post('/api/account/2fa/enable', { data: { code: totp(s.secret) } })).status()).toBe(200)
  await carmenSetup.context().close()

  await openUsers(admin)
  await row(admin, CARMEN).getByRole('button', { name: `Acciones para ${CARMEN}` }).click()
  await admin.getByRole('menuitem', { name: 'Restablecer la verificación en dos pasos' }).click()
  const dialog = admin.getByRole('alertdialog')
  await expect(dialog.getByRole('heading')).toHaveText(`¿Restablecer la verificación en dos pasos de ${CARMEN}?`)
  await expect(dialog).toContainText(`${CARMEN} verá un aviso al entrar, y los demás administradores también.`)
  await expect(dialog.getByRole('button', { name: 'Restablecer' })).toBeDisabled()
  await dialog.getByLabel('Tu contraseña').fill('no-es-la-mia-para-nada')
  await dialog.getByRole('button', { name: 'Restablecer' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('La contraseña actual no es correcta.')
  await dialog.getByLabel('Tu contraseña').fill(PASSWORD)
  await admin.screenshot({ path: `${SHOTS}/notices-reset-confirm-light.png`, animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Restablecer' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(row(admin, CARMEN)).not.toContainText('Activada')

  // Carmen signs in (with her password alone now): the notice says it at once, and stays in «Avisos».
  const carmen = await password(browser, CARMEN)
  const toast = carmen.locator('.toast', { hasText: `noa restableció tu verificación en dos pasos` })
  await expect(toast).toBeVisible()
  await toast.getByRole('button', { name: 'Ver avisos' }).click()
  await expect(carmen).toHaveURL(/\?view=avisos$/)
  const card = carmen.getByRole('region', { name: 'noa restableció tu verificación en dos pasos' })
  await expect(card).toContainText('Tu app de autenticación y tus códigos de recuperación ya no valen')
  await carmen.screenshot({ path: `${SHOTS}/notices-member-light.png`, animations: 'disabled', fullPage: true })

  // Bruno, the other admin, in dark mode: his own notice, about Carmen.
  const bruno = await password(browser, BRUNO, { colorScheme: 'dark' })
  await expect(bruno.locator('.toast', { hasText: `noa restableció la verificación en dos pasos de ${CARMEN}` })).toBeVisible()
  await bruno.goto('/?view=avisos')
  const his = bruno.getByRole('region', { name: `noa restableció la verificación en dos pasos de ${CARMEN}` })
  await expect(his).toContainText(`${CARMEN} también recibe un aviso.`)
  await bruno.screenshot({ path: `${SHOTS}/notices-admin-dark.png`, animations: 'disabled', fullPage: true })

  // Each dismisses their own: Carmen's goes, Bruno's stays; the admin who did it got none.
  await card.getByRole('button', { name: 'Entendido' }).click()
  await expect(card).toHaveCount(0)
  await bruno.reload()
  await expect(his).toBeVisible()
  await admin.goto('/?view=avisos')
  await expect(admin.getByRole('heading', { level: 1 })).toHaveText('Avisos del espacio')
  await expect(admin.getByRole('region', { name: /restableció/ })).toHaveCount(0)
  await carmen.context().close()
  await bruno.context().close()
})

test('a purge tells whoever wrote in it, without the content; what the admin can\'t read, he confirms first', async ({ browser }) => {
  const carmen = await password(browser, CARMEN)
  for (const [path, text] of [[SHARED, '# Lista\n\nPan y Turquesa.\n'], [PRIVATE, '# Diario\n\nSecreto Ámbar.\n']]) {
    await expect.poll(async () => (await carmen.request.post('/api/note', { data: { path, text } })).status(), { timeout: 15_000 }).toBe(201)
  }
  // Each note's version reaches the history once the typing calms down (3 s here).
  for (const path of [SHARED, PRIVATE]) {
    await expect.poll(async () => ((await (await carmen.request.get(`/api/history/versions?path=${encodeURIComponent(path)}`)).json()).versions ?? []).length, { timeout: 30_000 }).toBeGreaterThan(0)
  }
  await carmen.context().close()

  // The admin purges the shared note (he reads it: no confirmation) and Carmen's own (he can't: his password).
  await openUsers(admin)
  const form = admin.getByRole('region', { name: 'Purgar del historial' })
  for (const path of [SHARED, PRIVATE]) {
    await form.getByLabel('Ruta (nota o carpeta)').fill(path)
    await form.getByRole('button', { name: 'Purgar…' }).click()
    const dialog = admin.getByRole('alertdialog')
    const go = dialog.getByRole('button', { name: 'Purgar el historial' })
    await expect(go).toBeVisible()
    if (path === PRIVATE) {
      await expect(dialog).toContainText('Incluye algo que no puedes leer: confírmalo en el momento.')
      await expect(go).toBeDisabled()
      await dialog.getByLabel('Tu contraseña').fill(PASSWORD)
      await admin.screenshot({ path: `${SHOTS}/notices-purge-confirm-light.png`, animations: 'disabled' })
    } else {
      await expect(dialog.getByLabel('Tu contraseña')).toHaveCount(0)
    }
    await go.click()
    await expect(dialog).toHaveCount(0)
    await expect(form.getByRole('status')).toContainText('purgado')
  }

  // Carmen, on her phone: who purged what she wrote, and where (she can read both); never the content.
  const phone = await password(browser, CARMEN, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await expect(phone.locator('.toast')).toContainText('Tienes 2 avisos nuevos')
  await phone.screenshot({ path: `${SHOTS}/notices-toast-mobile.png`, animations: 'disabled' })
  await phone.locator('.toast').getByRole('button', { name: 'Ver avisos' }).tap()
  await expect(phone).toHaveURL(/\?view=avisos$/)
  await expect(phone.getByRole('region', { name: `noa purgó del historial ${SHARED}, donde escribiste` })).toBeVisible()
  await expect(phone.getByRole('region', { name: `noa purgó del historial ${PRIVATE}, donde escribiste` })).toBeVisible()
  await expect(phone.locator('.alerts-page')).not.toContainText('Turquesa')
  await expect(phone.locator('.alerts-page')).not.toContainText('Ámbar')
  expect(await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await phone.screenshot({ path: `${SHOTS}/notices-purge-mobile.png`, animations: 'disabled', fullPage: true })
  await phone.context().close()
})
