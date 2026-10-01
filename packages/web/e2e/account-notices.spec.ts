// Notices addressed to a person (M4.1, D-040 3.1 and 3.6) in real browsers:
// the admin resets a member's second factor, confirming with his own
// password; the member sees it when she signs in, and so does the other
// admin, in theirs. The admin purges from the history, in «Recent changes»,
// a note she wrote in, and one of hers he can't read (confirming again): she is told who and
// what, never the content. Users and notes of their own, removed at the end.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { createHmac } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { ADMIN, E2E_DIR, SPACE_NAME, freshFolder, inVault, personal, specMother } from './env.ts'
import { literally, newUser, signIn, usePermissions } from './helpers.ts'

const m = specMother(import.meta.url)
const SHOTS = `${E2E_DIR}/shots`
/** The member whose second factor the admin resets, and another admin: people of this spec. */
const PERSON = m.aUser({ role: 'member' })
const OTHER_ADMIN = m.aUser({ role: 'admin' })
/** A folder of this spec, and a note in it the member writes in. */
const SHARED_NAME = freshFolder(() => m.aFolder())
const SHARED_DIR = inVault(SHARED_NAME)
const SHARED = m.aNotePath(SHARED_DIR)
// A folder of the member's own space: the admin, who manages the vault's space, can't read it (D-056).
const PRIVATE_NAME = m.aFolder()
const PRIVATE_DIR = `${personal(PERSON)}/${PRIVATE_NAME}`
const PRIVATE = m.aNotePath(PRIVATE_DIR)
/** A note's name: its file's, without `.md`. */
const title = (path: string) => path.slice(path.lastIndexOf('/') + 1, -3)
/** A word in each note: a notice must never carry what the notes said. */
const SHARED_WORD = m.aUniqueWord()
const PRIVATE_WORD = m.aUniqueWord()

test.describe.configure({ mode: 'serial', timeout: 120_000 })

let admin: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true })
  // The member edits the vault's space, and has her own space that nobody else reads, the admin included.
  await usePermissions({ grants: { [PERSON.username]: 'edit', [OTHER_ADMIN.username]: 'read' } })
  admin = await signIn(browser, ADMIN)
  for (const u of [PERSON, OTHER_ADMIN]) await newUser(admin, u)
})

test.afterAll(async ({ browser }) => {
  const person = await password(browser, PERSON)
  for (const path of [SHARED, PRIVATE]) await person.request.delete(`/api/note?path=${encodeURIComponent(path)}`)
  // Each folder, by whoever manages it: the member hers, the admin the other one.
  await person.request.delete(`/api/folder?path=${encodeURIComponent(PRIVATE_DIR)}`)
  await admin.request.delete(`/api/folder?path=${encodeURIComponent(SHARED_DIR)}`)
  await person.context().close()
  await usePermissions()
  for (const u of (await (await admin.request.get('/api/admin/users')).json()).users as { id: string; username: string }[]) {
    if (u.username !== PERSON.username && u.username !== OTHER_ADMIN.username) continue
    await admin.request.post(`/api/admin/users/${u.id}/disable`)
    await admin.request.delete(`/api/admin/users/${u.id}`)
  }
  await admin.context().close()
})

/** Signs in with the password alone, in a browser of its own (`options`: a phone, dark mode…). */
async function password(browser: Browser, user: { username: string; password: string }, options: Parameters<Browser['newContext']>[0] = {}) {
  const page = await (await browser.newContext({ locale: 'es-ES', ...options })).newPage()
  await page.goto('/')
  await page.getByLabel('Nombre de usuario').fill(user.username)
  await page.getByLabel('Contraseña').fill(user.password)
  await page.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(page.getByRole('treegrid').first()).toBeVisible()
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

/** A user's row: its name comes first, then something that can't continue a username. */
const row = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(`^${literally(name)}(?![\\p{L}\\p{N}._-])`, 'u') })

async function openUsers(page: Page) {
  await page.getByRole('button', { name: 'Preferencias' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Usuarios y grupos' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Usuarios y grupos')
}

test('the admin resets a member\'s second factor with his own password; she is told when she signs in, and so is the other admin', async ({ browser }) => {
  // The member sets up her second factor (through the API: the UI of it has its own spec).
  const personSetup = await password(browser, PERSON)
  const s = await (await personSetup.request.post('/api/account/2fa/setup', { data: { password: PERSON.password } })).json() as { secret: string }
  expect((await personSetup.request.post('/api/account/2fa/enable', { data: { code: totp(s.secret) } })).status()).toBe(200)
  await personSetup.context().close()

  await openUsers(admin)
  await row(admin, PERSON.username).getByRole('button', { name: `Acciones para ${PERSON.username}` }).click()
  await admin.getByRole('menuitem', { name: 'Restablecer la verificación en dos pasos' }).click()
  const dialog = admin.getByRole('alertdialog')
  await expect(dialog.getByRole('heading')).toHaveText(`¿Restablecer la verificación en dos pasos de ${PERSON.username}?`)
  await expect(dialog).toContainText(`${PERSON.username} verá un aviso al entrar, y los demás administradores también.`)
  await expect(dialog.getByRole('button', { name: 'Restablecer' })).toBeDisabled()
  await dialog.getByLabel('Tu contraseña').fill(m.aPassword())
  await dialog.getByRole('button', { name: 'Restablecer' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('La contraseña actual no es correcta.')
  await dialog.getByLabel('Tu contraseña').fill(ADMIN.password)
  await admin.screenshot({ path: `${SHOTS}/notices-reset-confirm-light.png`, animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Restablecer' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(row(admin, PERSON.username)).not.toContainText('Activada')

  // The member signs in (with her password alone now): the notice says it at once, and stays in «Avisos».
  const person = await password(browser, PERSON)
  const toast = person.locator('.toast', { hasText: `${ADMIN.username} restableció tu verificación en dos pasos` })
  await expect(toast).toBeVisible()
  await toast.getByRole('button', { name: 'Ver avisos' }).click()
  await expect(person).toHaveURL(/\?view=alerts$/)
  const card = person.getByRole('region', { name: `${ADMIN.username} restableció tu verificación en dos pasos` })
  await expect(card).toContainText('Tu app de autenticación y tus códigos de recuperación ya no valen')
  await person.screenshot({ path: `${SHOTS}/notices-member-light.png`, animations: 'disabled', fullPage: true })

  // The other admin, in dark mode: his own notice, about the member.
  const otherAdmin = await password(browser, OTHER_ADMIN, { colorScheme: 'dark' })
  await expect(otherAdmin.locator('.toast', { hasText: `${ADMIN.username} restableció la verificación en dos pasos de ${PERSON.username}` })).toBeVisible()
  await otherAdmin.goto('/?view=alerts')
  const his = otherAdmin.getByRole('region', { name: `${ADMIN.username} restableció la verificación en dos pasos de ${PERSON.username}` })
  await expect(his).toContainText(`${PERSON.username} también recibe un aviso.`)
  await otherAdmin.screenshot({ path: `${SHOTS}/notices-admin-dark.png`, animations: 'disabled', fullPage: true })

  // Each dismisses their own: the member's goes, the other admin's stays; the admin who did it got none.
  await card.getByRole('button', { name: 'Entendido' }).click()
  await expect(card).toHaveCount(0)
  await otherAdmin.reload()
  await expect(his).toBeVisible()
  await admin.goto('/?view=alerts')
  await expect(admin.getByRole('heading', { level: 1 })).toHaveText('Avisos')
  await expect(admin.getByRole('region', { name: /restableció/ })).toHaveCount(0)
  await person.context().close()
  await otherAdmin.context().close()
})

test('a purge tells whoever wrote in it, without the content; what the admin can\'t read, he confirms first', async ({ browser }) => {
  const person = await password(browser, PERSON)
  for (const [path, word] of [[SHARED, SHARED_WORD], [PRIVATE, PRIVATE_WORD]] as const) {
    const text = `# ${m.aHeading()}\n\n${m.aSentence()} ${word}.\n`
    await expect.poll(async () => (await person.request.post('/api/note', { data: { path, text } })).status(), { timeout: 15_000 }).toBe(201)
  }
  // Each note's version reaches the history once the typing calms down (3 s here).
  for (const path of [SHARED, PRIVATE]) {
    await expect.poll(async () => ((await (await person.request.get(`/api/history/versions?path=${encodeURIComponent(path)}`)).json()).versions ?? []).length, { timeout: 30_000 }).toBeGreaterThan(0)
  }
  await person.context().close()

  // The admin purges from «Recent changes»: the shared note (he reads it: no confirmation) at his desk,
  // and the member's own (he can't: his password) on a phone.
  await admin.goto('/?view=changes')
  await expect(admin.getByRole('heading', { level: 1 })).toHaveText('Cambios recientes')
  for (const path of [SHARED, PRIVATE]) {
    if (path === PRIVATE) await admin.setViewportSize({ width: 390, height: 844 })
    await admin.getByRole('button', { name: 'Purgar del historial…' }).click()
    const form = admin.getByRole('dialog', { name: 'Purgar del historial' })
    // As the admin sees it (D-056.29): the space by its name, or the person's whose it is; never `people/` nor `spaces/`.
    const typed = path === PRIVATE ? `${PERSON.username} / ${PRIVATE_NAME} / ${title(PRIVATE)}` : `${SPACE_NAME} / ${SHARED_NAME} / ${title(SHARED)}`
    await form.getByLabel('Ruta (nota o carpeta)').fill(typed)
    await admin.screenshot({ path: `${SHOTS}/notices-purge-form-${path === PRIVATE ? 'mobile' : 'light'}.png`, animations: 'disabled' })
    await form.getByRole('button', { name: 'Purgar…' }).click()
    // Where he can't read, nothing tells a note from a folder of that name: he says which.
    if (path === PRIVATE) await form.getByRole('button', { name: `${typed} nota`, exact: true }).click()
    await expect(form).toHaveCount(0)
    const dialog = admin.getByRole('alertdialog')
    const go = dialog.getByRole('button', { name: 'Purgar el historial' })
    await expect(go).toBeVisible()
    if (path === PRIVATE) {
      await expect(dialog).toContainText('Incluye algo que no puedes leer: confírmalo en el momento.')
      await expect(go).toBeDisabled()
      await dialog.getByLabel('Tu contraseña').fill(ADMIN.password)
      await admin.screenshot({ path: `${SHOTS}/notices-purge-confirm-light.png`, animations: 'disabled' })
    } else {
      await expect(dialog.getByLabel('Tu contraseña')).toHaveCount(0)
    }
    await go.click()
    // Rewriting the whole history takes a while on a server whose history every spec has written.
    await expect(dialog).toHaveCount(0, { timeout: 30_000 })
    await expect(admin.locator('.changes-page .alerts-done')).toContainText('purgado')
    // The list comes back without what went, once the history has rewritten it (never an error meanwhile).
    await expect(admin.locator('.changes-page')).not.toContainText('Cargando…', { timeout: 30_000 })
    await expect(admin.locator('.changes-page').getByRole('alert')).toHaveCount(0)
  }
  expect(await admin.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await admin.screenshot({ path: `${SHOTS}/notices-purge-done-mobile.png`, animations: 'disabled' })
  await admin.setViewportSize({ width: 1280, height: 800 })

  // The member, on her phone: who purged what she wrote, and where (she can read both); never the content.
  const phone = await password(browser, PERSON, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await expect(phone.locator('.toast')).toContainText('Tienes 2 avisos nuevos')
  await phone.screenshot({ path: `${SHOTS}/notices-toast-mobile.png`, animations: 'disabled' })
  await phone.locator('.toast').getByRole('button', { name: 'Ver avisos' }).tap()
  await expect(phone).toHaveURL(/\?view=alerts$/)
  await expect(phone.getByRole('region', { name: `${ADMIN.username} purgó del historial ${SPACE_NAME} / ${SHARED_NAME} / ${title(SHARED)}, donde escribiste` })).toBeVisible()
  await expect(phone.getByRole('region', { name: `${ADMIN.username} purgó del historial Mis notas / ${PRIVATE_NAME} / ${title(PRIVATE)}, donde escribiste` })).toBeVisible()
  await expect(phone.locator('.alerts-page')).not.toContainText(SHARED_WORD)
  await expect(phone.locator('.alerts-page')).not.toContainText(PRIVATE_WORD)
  expect(await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await phone.screenshot({ path: `${SHOTS}/notices-purge-mobile.png`, animations: 'disabled', fullPage: true })
  await phone.context().close()
})
