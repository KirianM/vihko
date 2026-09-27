// «Users and groups» (M4, D-038.3 and .8), with two browsers: the admin
// creates a member and copies the one-time link; the member opens it in
// another session, chooses a password and is in, with a note open; the
// admin disables them and their session is cut at once (their open note
// included); the link doesn't work twice; deleting says what goes. Groups,
// and one's own account.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { BASE_URL, E2E_DIR, NOTES, PASSWORD, PERMISSIONS, PUBLIC_URL } from './env.ts'
import { signIn, writeWorkspace } from './helpers.ts'

const SHOTS = `${E2E_DIR}/shots`
const NOTE = 'hogar/Proxy.md'

test.describe.configure({ mode: 'serial' })
test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true })
  // A member sees nothing until something is granted (D-038): marta, once she exists, edits everything.
  writeFileSync(`${NOTES}/thoth.yaml`, PERMISSIONS.replace('ana: edit }', 'ana: edit, marta: edit }'))
})
test.afterAll(() => writeWorkspace())

/** From the sidebar: Preferences → one of the settings pages. */
async function openSettings(page: Page, link: string, view: string) {
  await page.getByRole('button', { name: 'Preferencias' }).click()
  await page.getByRole('dialog').getByRole('button', { name: link }).click()
  await expect(page).toHaveURL(new RegExp(`\\?view=${view}$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(link)
}

const row = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(`^${name}\\b`) })

test('the admin invites a member by link, the member joins in another browser, and disabling them cuts their session at once', async ({ browser }) => {
  const admin = await signIn(browser, 'noa')
  await admin.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await openSettings(admin, 'Usuarios y grupos', 'users')
  await expect(row(admin, 'noa')).toContainText('(tú)')
  await expect(row(admin, 'ana')).toContainText('Miembro')

  // A new member: a name and a role, then the link, shown once.
  await admin.getByRole('button', { name: 'Nuevo usuario' }).click()
  const create = admin.getByRole('dialog')
  await create.getByLabel('Nombre de usuario').fill('marta')
  await expect(create.getByRole('radio', { name: /Miembro/ })).toBeChecked()
  await create.getByRole('button', { name: 'Crear y obtener el enlace' }).click()
  const linkDialog = admin.getByRole('dialog', { name: 'Enlace de invitación para marta' })
  await expect(linkDialog).toContainText('Solo se muestra ahora')
  // With THOTH_PUBLIC_URL (as this server has), the link is given for it.
  const shown = (await linkDialog.getByLabel('Enlace').innerText()).trim()
  expect(shown.startsWith(`${PUBLIC_URL}/invite/`)).toBe(true)
  expect(shown).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/)
  await linkDialog.getByRole('button', { name: 'Copiar el enlace' }).click()
  await expect(linkDialog.getByRole('status')).toHaveText('Copiado')
  expect(await admin.evaluate(() => navigator.clipboard.readText())).toBe(shown)
  // Nothing answers at the public URL here: the same path on this server.
  const url = BASE_URL + new URL(shown).pathname
  await admin.screenshot({ path: `${SHOTS}/users-link.png`, animations: 'disabled' })
  await linkDialog.getByRole('button', { name: 'Listo' }).click()
  await expect(row(admin, 'marta')).toContainText('Invitación pendiente')

  // The member, in a browser of their own: the link, a password, and they're in.
  const member = await (await browser.newContext()).newPage()
  await member.goto(url)
  await expect(member.getByRole('heading', { name: 'Te damos la bienvenida' })).toBeVisible()
  await expect(member.getByText('Elige la contraseña de tu cuenta, marta.')).toBeVisible()
  await member.getByLabel('Contraseña', { exact: true }).fill('marta-contraseña-larga')
  await member.getByLabel('Repite la contraseña').fill('otra-cosa-distinta')
  await member.getByRole('button', { name: 'Guardar y entrar' }).click()
  await expect(member.getByRole('alert')).toHaveText('Las dos contraseñas no coinciden.')
  await member.getByLabel('Repite la contraseña').fill('marta-contraseña-larga')
  await member.getByRole('button', { name: 'Guardar y entrar' }).click()
  await expect(member.getByRole('treegrid')).toBeVisible()
  await expect(member).toHaveURL(/\/$/)
  await member.goto(`/?note=${encodeURIComponent(NOTE)}`)
  await expect(member.locator('.cm-content')).toBeVisible()

  await admin.reload()
  await expect(row(admin, 'marta')).toContainText('Activo')

  // Disabled: the confirmation says what happens, and the member's session (their open note too) ends now.
  await row(admin, 'marta').getByRole('button', { name: 'Acciones para marta' }).click()
  await admin.getByRole('menuitem', { name: 'Desactivar' }).click()
  const confirm = admin.getByRole('alertdialog')
  await expect(confirm.getByRole('heading')).toHaveText('¿Desactivar a marta?')
  await expect(confirm).toContainText('Sus sesiones se cierran ahora mismo, también una nota que tenga abierta')
  await expect(confirm).toContainText('Sus claves de agente y las aplicaciones que autorizó dejan de funcionar')
  await admin.screenshot({ path: `${SHOTS}/users-disable.png`, animations: 'disabled' })
  await confirm.getByRole('button', { name: 'Desactivar' }).click()
  await expect(row(admin, 'marta')).toContainText('Desactivado')

  // No reload, no click: the hub tells the open note, and the member is back at the login.
  await expect(member.getByRole('button', { name: 'Entrar' }).last()).toBeVisible({ timeout: 10_000 })
  await expect(member.getByRole('alert')).toHaveText('Tu sesión ha caducado. Vuelve a entrar.')
  await member.getByLabel('Nombre de usuario').fill('marta')
  await member.getByLabel('Contraseña').fill('marta-contraseña-larga')
  await member.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(member.getByRole('alert')).toHaveText('Usuario o contraseña incorrectos.')

  // The link was used: the same neutral message as any link that doesn't work.
  await member.goto(url)
  await expect(member.getByRole('heading', { name: 'Este enlace no sirve' })).toBeVisible()
  await expect(member.getByRole('alert')).toHaveText('No existe, ya se usó o ha caducado. Pide uno nuevo a quien administra thoth.')
  await member.screenshot({ path: `${SHOTS}/invite-invalid.png`, animations: 'disabled' })

  // Deleting (only someone disabled) lists what goes, and can't be undone.
  await row(admin, 'marta').getByRole('button', { name: 'Acciones para marta' }).click()
  await admin.getByRole('menuitem', { name: 'Borrar' }).click()
  const del = admin.getByRole('alertdialog')
  await expect(del.getByRole('heading')).toHaveText('¿Borrar a marta?')
  await expect(del).toContainText('no se puede deshacer')
  await expect(del).toContainText('el historial sigue diciendo qué escribió')
  await del.getByRole('button', { name: 'Borrar para siempre' }).click()
  await expect(row(admin, 'marta')).toHaveCount(0)

  // The filters.
  await admin.getByRole('button', { name: /^Invitación pendiente/ }).click()
  await expect(admin.getByText('Nadie coincide.')).toBeVisible()
  await admin.getByRole('button', { name: /^Todos/ }).click()
  await expect(row(admin, 'ana')).toBeVisible()
  await member.context().close()
  await admin.context().close()
})

test('groups: the admin creates one, adds a member, renames it and deletes it; members only see names', async ({ browser }) => {
  const admin = await signIn(browser, 'noa')
  await openSettings(admin, 'Usuarios y grupos', 'users')
  await admin.getByRole('button', { name: 'Nuevo grupo' }).click()
  await admin.getByRole('dialog').getByLabel('Nombre').fill('familia')
  await admin.getByRole('dialog').getByRole('button', { name: 'Crear' }).click()
  const card = admin.locator('.group-card', { hasText: '@familia' })
  await expect(card).toContainText('Sin miembros.')
  await card.getByRole('combobox', { name: 'Añadir a @familia' }).selectOption({ label: 'ana' })
  await expect(card.getByRole('list', { name: 'Miembros de @familia' })).toHaveText('ana')
  await expect(row(admin, 'ana')).toContainText('@familia')
  await admin.screenshot({ path: `${SHOTS}/users-groups.png`, animations: 'disabled', fullPage: true })

  const ana = await signIn(browser, 'ana')
  // Names only (other specs on this server add people of their own).
  const directory = await (await ana.request.get('/api/directory')).json()
  expect(directory.groups).toEqual(['familia'])
  expect(directory.users).toEqual(expect.arrayContaining(['ana', 'noa']))
  expect(directory.users.every((u: unknown) => typeof u === 'string')).toBe(true)
  expect((await ana.request.get('/api/admin/users')).status()).toBe(403)
  // A member doesn't get the page either.
  await ana.goto('/?view=users')
  await expect(ana.getByRole('heading', { name: 'Usuarios y grupos' })).toHaveCount(0)
  await ana.context().close()

  await card.getByRole('button', { name: 'Renombrar' }).click()
  await admin.getByRole('dialog').getByLabel('Nombre').fill('casa')
  await admin.getByRole('dialog').getByRole('button', { name: 'Renombrar' }).click()
  const renamed = admin.locator('.group-card', { hasText: '@casa' })
  await renamed.getByRole('button', { name: 'Quitar a ana de @casa' }).click()
  await expect(renamed).toContainText('Sin miembros.')
  await renamed.getByRole('button', { name: 'Borrar' }).click()
  const confirm = admin.getByRole('alertdialog')
  await expect(confirm).toContainText('Se quitan los permisos de @casa en las carpetas')
  await confirm.getByRole('button', { name: 'Borrar el grupo' }).click()
  await expect(admin.getByText('Aún no hay grupos.')).toBeVisible()
  await admin.context().close()
})

test('one\'s account: sessions with this one marked, signing out another, and a wrong current password', async ({ browser }) => {
  const other = await signIn(browser, 'ana')
  const page = await signIn(browser, 'ana')
  await openSettings(page, 'Cuenta', 'account')
  const sessions = page.locator('.session')
  // This one and the other one at least (earlier specs signed in as ana too).
  await expect(sessions.filter({ hasText: 'Esta sesión' })).toHaveCount(1)
  expect(await sessions.count()).toBeGreaterThanOrEqual(2)
  await expect(sessions.first()).toContainText('Chrome')
  await page.screenshot({ path: `${SHOTS}/account.png`, animations: 'disabled', fullPage: true })
  // One, then the rest.
  const before = await sessions.count()
  await sessions.filter({ hasNotText: 'Esta sesión' }).first().getByRole('button', { name: 'Cerrar' }).click()
  await expect(sessions).toHaveCount(before - 1)
  await page.getByRole('button', { name: 'Cerrar las demás' }).click()
  await expect(sessions).toHaveCount(1)
  await expect(sessions).toContainText('Esta sesión')
  expect((await other.request.get('/api/auth/me')).status()).toBe(401)
  expect((await page.request.get('/api/auth/me')).status()).toBe(200)

  await page.getByLabel('Contraseña actual').fill('no-es-la-mia-para-nada')
  await page.getByLabel('Contraseña nueva').fill('una-contraseña-nueva')
  await page.getByLabel('Repite la contraseña').fill('una-contraseña-nueva')
  await page.getByRole('button', { name: 'Cambiar la contraseña' }).click()
  await expect(page.getByRole('alert')).toHaveText('La contraseña actual no es correcta.')

  // On a phone, dark: the users page fits (the table scrolls within its box).
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, hasTouch: true })
  const phone = await ctx.newPage()
  await phone.goto('/')
  await phone.getByLabel('Nombre de usuario').fill('noa')
  await phone.getByLabel('Contraseña').fill(PASSWORD)
  await phone.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(phone.getByRole('button', { name: 'Entrar' })).toHaveCount(0)
  await phone.goto('/?view=users')
  await expect(phone.getByRole('heading', { level: 1 })).toHaveText('Usuarios y grupos')
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await phone.screenshot({ path: `${SHOTS}/users-phone-dark.png`, animations: 'disabled' })
  await ctx.close()
  await other.context().close()
  await page.context().close()
})
