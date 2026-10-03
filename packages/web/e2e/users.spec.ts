// «Users and groups», with two browsers: the admin
// creates a member and copies the one-time link; the member opens it in
// another session, chooses a password and is in, with a note open; the
// admin disables them and their session is cut at once (their open note
// included); the link doesn't work twice; deleting says what goes. A new
// admin is confirmed at the moment. Groups, and one's own account.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { ADMIN, BASE_URL, E2E_DIR, MEMBER, PUBLIC_URL, inVault, specMother } from './env.ts'
import { literally, signIn, usePermissions } from './helpers.ts'

const m = specMother(import.meta.url)
const SHOTS = `${E2E_DIR}/shots`
const NOTE = inVault('hogar/Proxy.md')
// People and groups of this spec (a deleted user's name stays reserved, and other specs make their own).
const NEWCOMER = m.aUser({ role: 'member' })
/** Someone the admin makes admin from the start: only invited, then removed. */
const LEAD = m.aUser({ role: 'admin' })
const FAMILY = m.aGroupName()
const HOME = m.aGroupName()

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true })
  // A member sees only their own space until something is shared: the newcomer, once she exists, edits the vault's space.
  await usePermissions({ grants: { [NEWCOMER.username]: 'edit' } })
})
test.afterAll(() => usePermissions())

/** From the sidebar: Preferences → one of the settings pages. */
async function openSettings(page: Page, link: string, view: string) {
  await page.getByRole('button', { name: 'Preferencias' }).click()
  await page.getByRole('dialog').getByRole('button', { name: link }).click()
  await expect(page).toHaveURL(new RegExp(`\\?view=${view}$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(link)
}

/** A user's row: its name comes first, then something that can't continue a username. */
const row = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(`^${literally(name)}(?![\\p{L}\\p{N}._-])`, 'u') })

test('the admin invites a member by link, the member joins in another browser, and disabling them cuts their session at once', async ({ browser }) => {
  const admin = await signIn(browser, ADMIN)
  await admin.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await openSettings(admin, 'Usuarios y grupos', 'users')
  await expect(row(admin, ADMIN.username)).toContainText('(tú)')
  await expect(row(admin, MEMBER.username)).toContainText('Miembro')

  // A new member: a name and a role, then the link, shown once.
  await admin.getByRole('button', { name: 'Nuevo usuario' }).click()
  const create = admin.getByRole('dialog')
  await create.getByLabel('Nombre de usuario').fill(NEWCOMER.username)
  await expect(create.getByRole('radio', { name: /Miembro/ })).toBeChecked()
  await create.getByRole('button', { name: 'Crear y obtener el enlace' }).click()
  const linkDialog = admin.getByRole('dialog', { name: `Enlace de invitación para ${NEWCOMER.username}` })
  await expect(linkDialog).toContainText('Solo se muestra ahora')
  // With VIHKO_PUBLIC_URL (as this server has), the link is given for it.
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
  await expect(row(admin, NEWCOMER.username)).toContainText('Invitación pendiente')

  // The member, in a browser of their own: the link, a password, and they're in.
  const member = await (await browser.newContext()).newPage()
  await member.goto(url)
  await expect(member.getByRole('heading', { name: 'Te damos la bienvenida' })).toBeVisible()
  await expect(member.getByText(`Elige la contraseña de tu cuenta, ${NEWCOMER.username}.`)).toBeVisible()
  await member.getByLabel('Contraseña', { exact: true }).fill(NEWCOMER.password)
  await member.getByLabel('Repite la contraseña').fill(m.aPassword())
  await member.getByRole('button', { name: 'Guardar y entrar' }).click()
  await expect(member.getByRole('alert')).toHaveText('Las dos contraseñas no coinciden.')
  await member.getByLabel('Repite la contraseña').fill(NEWCOMER.password)
  await member.getByRole('button', { name: 'Guardar y entrar' }).click()
  await expect(member.getByRole('treegrid').first()).toBeVisible()
  await expect(member).toHaveURL(/\/$/)
  await member.goto(`/?note=${encodeURIComponent(NOTE)}`)
  await expect(member.locator('.cm-content')).toBeVisible()

  await admin.reload()
  await expect(row(admin, NEWCOMER.username)).toContainText('Activo')

  // Disabled: the confirmation says what happens, and the member's session (their open note too) ends now.
  await row(admin, NEWCOMER.username).getByRole('button', { name: `Acciones para ${NEWCOMER.username}` }).click()
  await admin.getByRole('menuitem', { name: 'Desactivar' }).click()
  const confirm = admin.getByRole('alertdialog')
  await expect(confirm.getByRole('heading')).toHaveText(`¿Desactivar a ${NEWCOMER.username}?`)
  await expect(confirm).toContainText('Sus sesiones se cierran ahora mismo, también una nota que tenga abierta')
  await expect(confirm).toContainText('Sus claves de agente y las aplicaciones que autorizó dejan de funcionar')
  await expect(confirm).toContainText('Los demás administradores reciben un aviso.')
  // Confirmed at the moment, with the admin's own password.
  await expect(confirm.getByRole('button', { name: 'Desactivar' })).toBeDisabled()
  await confirm.getByLabel('Tu contraseña').fill(ADMIN.password)
  await admin.screenshot({ path: `${SHOTS}/users-disable.png`, animations: 'disabled' })
  await confirm.getByRole('button', { name: 'Desactivar' }).click()
  await expect(row(admin, NEWCOMER.username)).toContainText('Desactivado')

  // No reload, no click: the hub tells the open note, and the member is back at the login.
  await expect(member.getByRole('button', { name: 'Entrar' }).last()).toBeVisible({ timeout: 10_000 })
  await expect(member.getByRole('alert')).toHaveText('Tu sesión ha caducado. Vuelve a entrar.')
  await member.getByLabel('Nombre de usuario').fill(NEWCOMER.username)
  await member.getByLabel('Contraseña').fill(NEWCOMER.password)
  await member.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(member.getByRole('alert')).toHaveText('Usuario o contraseña incorrectos.')

  // The link was used: the same neutral message as any link that doesn't work.
  await member.goto(url)
  await expect(member.getByRole('heading', { name: 'Este enlace no sirve' })).toBeVisible()
  await expect(member.getByRole('alert')).toHaveText('No existe, ya se usó o ha caducado. Pide uno nuevo a quien administra vihko.')
  await member.screenshot({ path: `${SHOTS}/invite-invalid.png`, animations: 'disabled' })

  // Deleting (only someone disabled) lists what goes, and can't be undone.
  await row(admin, NEWCOMER.username).getByRole('button', { name: `Acciones para ${NEWCOMER.username}` }).click()
  await admin.getByRole('menuitem', { name: 'Borrar' }).click()
  const del = admin.getByRole('alertdialog')
  await expect(del.getByRole('heading')).toHaveText(`¿Borrar a ${NEWCOMER.username}?`)
  await expect(del).toContainText('no se puede deshacer')
  await expect(del).toContainText('el historial sigue diciendo qué escribió')
  // Confirmed a moment ago (disabling them), in this browser: it doesn't ask again.
  await expect(del.getByLabel('Tu contraseña')).toHaveCount(0)
  await expect(del.getByRole('button', { name: 'Borrar para siempre' })).toBeEnabled()
  await del.getByRole('button', { name: 'Borrar para siempre' }).click()
  await expect(row(admin, NEWCOMER.username)).toHaveCount(0)

  // The filters.
  await admin.getByRole('button', { name: /^Invitación pendiente/ }).click()
  // Only people still invited (none of this spec's; other specs may have some).
  await expect(row(admin, MEMBER.username)).toHaveCount(0)
  await expect(row(admin, ADMIN.username)).toHaveCount(0)
  await admin.getByRole('button', { name: /^Todos/ }).click()
  await expect(row(admin, MEMBER.username)).toBeVisible()
  await member.context().close()
  await admin.context().close()
})

test('a new admin is confirmed at the moment: the dialog asks for the admin\'s password, and a wrong one creates nobody; so is enabling one again', async ({ browser }) => {
  const admin = await signIn(browser, ADMIN)
  await openSettings(admin, 'Usuarios y grupos', 'users')
  await admin.getByRole('button', { name: 'Nuevo usuario' }).click()
  const create = admin.getByRole('dialog')
  await expect(create.getByLabel('Nombre de usuario')).toHaveAttribute('autocapitalize', 'none')
  await create.getByLabel('Nombre de usuario').fill(LEAD.username)
  // A member asks nothing more; an admin, the admin's own password (they have no second factor).
  await expect(create.getByLabel('Tu contraseña')).toHaveCount(0)
  await create.getByRole('radio', { name: /^Administrador/ }).check()
  const secret = create.getByLabel('Tu contraseña')
  await expect(secret).toBeVisible()
  await expect(create).toContainText('Un admin nuevo se confirma en el momento')
  const submit = create.getByRole('button', { name: 'Crear y obtener el enlace' })
  await expect(submit).toBeDisabled()
  await secret.fill(m.aPassword())
  await submit.click()
  await expect(create.getByRole('alert')).toHaveText('La contraseña actual no es correcta.')
  expect((await (await admin.request.get('/api/admin/users')).json()).users.some((u: { username: string }) => u.username === LEAD.username)).toBe(false)
  await admin.screenshot({ path: `${SHOTS}/users-new-admin.png`, animations: 'disabled' })
  await secret.fill(ADMIN.password)
  await submit.click()
  await expect(admin.getByRole('dialog', { name: `Enlace de invitación para ${LEAD.username}` })).toBeVisible()
  await admin.getByRole('button', { name: 'Listo' }).click()
  await expect(row(admin, LEAD.username)).toContainText('Administrador')
  await expect(row(admin, LEAD.username)).toContainText('Invitación pendiente')

  // Disabled, an admin comes back only confirmed at the moment too.
  const { users } = await (await admin.request.get('/api/admin/users')).json() as { users: { id: string; username: string }[] }
  const id = users.find((u) => u.username === LEAD.username)!.id
  expect((await admin.request.post(`/api/admin/users/${id}/disable`, { data: { confirm: ADMIN.password } })).status()).toBe(200)
  // In a browser of its own: this one confirmed a moment ago, and wouldn't ask.
  const fresh = await signIn(browser, ADMIN)
  await openSettings(fresh, 'Usuarios y grupos', 'users')
  await expect(row(fresh, LEAD.username)).toContainText('Desactivado')
  await row(fresh, LEAD.username).getByRole('button', { name: `Acciones para ${LEAD.username}` }).click()
  await fresh.getByRole('menuitem', { name: 'Reactivar' }).click()
  const enable = fresh.getByRole('alertdialog')
  await expect(enable.getByRole('heading')).toHaveText(`¿Reactivar a ${LEAD.username}, que es administrador?`)
  await expect(enable.getByRole('button', { name: 'Reactivar' })).toBeDisabled()
  await enable.getByLabel('Tu contraseña').fill(ADMIN.password)
  await enable.getByRole('button', { name: 'Reactivar' }).click()
  await expect(row(fresh, LEAD.username)).toContainText('Invitación pendiente')
  await fresh.context().close()

  // Removed: disabled, then deleted.
  expect((await admin.request.post(`/api/admin/users/${id}/disable`, { data: { confirm: ADMIN.password } })).status()).toBe(200)
  expect((await admin.request.delete(`/api/admin/users/${id}`, { data: { confirm: ADMIN.password } })).status()).toBe(200)
  await admin.context().close()
})

test('groups: the admin creates one, adds a member, renames it and deletes it; members only see names', async ({ browser }) => {
  const admin = await signIn(browser, ADMIN)
  await openSettings(admin, 'Usuarios y grupos', 'users')
  await admin.getByRole('button', { name: 'Nuevo grupo' }).click()
  await admin.getByRole('dialog').getByLabel('Nombre').fill(FAMILY)
  await admin.getByRole('dialog').getByRole('button', { name: 'Crear' }).click()
  const card = admin.locator('.group-card', { hasText: `@${FAMILY}` })
  await expect(card).toContainText('Sin miembros.')
  await card.getByRole('combobox', { name: `Añadir a @${FAMILY}` }).selectOption({ label: MEMBER.username })
  await expect(card.getByRole('list', { name: `Miembros de @${FAMILY}` })).toHaveText(MEMBER.username)
  await expect(row(admin, MEMBER.username)).toContainText(`@${FAMILY}`)
  await admin.screenshot({ path: `${SHOTS}/users-groups.png`, animations: 'disabled', fullPage: true })

  const member = await signIn(browser, MEMBER)
  // Names only (other specs on this server add people of their own).
  const directory = await (await member.request.get('/api/directory')).json()
  expect(directory.groups).toContain(FAMILY)
  expect(directory.users).toEqual(expect.arrayContaining([MEMBER.username, ADMIN.username]))
  expect(directory.users.every((u: unknown) => typeof u === 'string')).toBe(true)
  expect((await member.request.get('/api/admin/users')).status()).toBe(403)
  // A member doesn't get the page either.
  await member.goto('/?view=users')
  await expect(member.getByRole('heading', { name: 'Usuarios y grupos' })).toHaveCount(0)
  await member.context().close()

  await card.getByRole('button', { name: 'Renombrar' }).click()
  await admin.getByRole('dialog').getByLabel('Nombre').fill(HOME)
  await admin.getByRole('dialog').getByRole('button', { name: 'Renombrar' }).click()
  const renamed = admin.locator('.group-card', { hasText: `@${HOME}` })
  await renamed.getByRole('button', { name: `Quitar a ${MEMBER.username} de @${HOME}` }).click()
  await expect(renamed).toContainText('Sin miembros.')
  await renamed.getByRole('button', { name: 'Borrar' }).click()
  const confirm = admin.getByRole('alertdialog')
  await expect(confirm).toContainText(`Se quitan los permisos de @${HOME} en las carpetas`)
  await confirm.getByRole('button', { name: 'Borrar el grupo' }).click()
  await expect(renamed).toHaveCount(0)
  expect((await (await admin.request.get('/api/directory')).json()).groups).not.toContain(HOME)
  await admin.context().close()
})

test('one\'s account: sessions with this one marked, signing out another, and a wrong current password', async ({ browser }) => {
  const other = await signIn(browser, MEMBER)
  const page = await signIn(browser, MEMBER)
  await openSettings(page, 'Cuenta', 'account')
  const sessions = page.locator('.session')
  // This one and the other one at least (earlier specs signed in as the member too).
  await expect(sessions.filter({ hasText: 'Esta sesión' })).toHaveCount(1)
  expect(await sessions.count()).toBeGreaterThanOrEqual(2)
  await expect(sessions.first()).toContainText('Chrome')
  // At the end, vihko's version: the server's, as it tells whoever signed in.
  const { version } = await (await page.request.get('/api/config')).json()
  expect(version).toMatch(/^\d+\.\d+\.\d+/)
  await expect(page.getByRole('region', { name: 'Acerca de' }).getByText(`vihko ${version}`, { exact: true })).toBeVisible()
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

  // A wrong current password, in «Change password…»: the dialog says so and stays open.
  const unchanged = m.aPassword()
  await page.getByRole('button', { name: 'Cambiar la contraseña…', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Contraseña actual').fill(m.aPassword())
  await dialog.getByLabel('Contraseña nueva').fill(unchanged)
  await dialog.getByLabel('Repite la contraseña').fill(unchanged)
  await dialog.getByRole('button', { name: 'Cambiar la contraseña', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('La contraseña actual no es correcta.')
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await expect(dialog).toHaveCount(0)

  // On a phone, dark: the users page fits (the table scrolls within its box).
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, hasTouch: true })
  const phone = await ctx.newPage()
  await phone.goto('/')
  await phone.getByLabel('Nombre de usuario').fill(ADMIN.username)
  await phone.getByLabel('Contraseña').fill(ADMIN.password)
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
