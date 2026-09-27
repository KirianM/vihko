// The second factor (D-036) in a real browser: a member sets it up from
// «Account» with a code this test computes from the secret on the page,
// signs in with a code and with a recovery code, and confirms a new key with
// the current code. Then the admin makes it required: someone invited sets
// it up before getting in (on a phone, in dark mode), and the admin resets
// it. Users of their own, removed at the end, and the policy back to
// optional: the other specs sign in with a password alone.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { createHmac } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { E2E_DIR, NOTES, PASSWORD, PERMISSIONS, PUBLIC_URL } from './env.ts'
import { signIn, writeWorkspace } from './helpers.ts'

const SHOTS = `${E2E_DIR}/shots`
const LUCIA = 'tfa-lucia'
const PABLO = 'tfa-pablo'

// A code works once per 30-second step: some tests wait for the app's next one.
test.describe.configure({ mode: 'serial', timeout: 120_000 })
/**
 * The admin's session from before any policy: it stays open when the policy
 * becomes required (the admin has no second factor), so the end can always
 * put things back.
 */
let keeper: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true })
  // A member sees nothing until something is granted (D-038): the two of them read everything.
  writeFileSync(`${NOTES}/thoth.yaml`, PERMISSIONS.replace('ana: edit }', `ana: edit, ${LUCIA}: read, ${PABLO}: read }`))
  keeper = await signIn(browser, 'noa')
})

test.afterAll(async () => {
  const admin = keeper
  await admin.request.put('/api/admin/settings', { data: { twoFactor: 'optional', confirm: PASSWORD } })
  for (const u of (await (await admin.request.get('/api/admin/users')).json()).users as { id: string; username: string }[]) {
    if (u.username !== LUCIA && u.username !== PABLO) continue
    await admin.request.post(`/api/admin/users/${u.id}/disable`)
    await admin.request.delete(`/api/admin/users/${u.id}`)
  }
  await admin.context().close()
  writeWorkspace()
})

// --- TOTP, as the authenticator app computes it (RFC 6238) -------------------

function base32(s: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of s.replace(/\s/g, '').toUpperCase()) {
    value = ((value << 5) | alphabet.indexOf(ch)) & 0xffff
    bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return Buffer.from(out)
}

function codeAt(secret: Buffer, step: number): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(step))
  const h = createHmac('sha1', secret).update(msg).digest()
  const o = h[h.length - 1]! & 15
  return String((((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000).padStart(6, '0')
}

const stepNow = () => Math.floor(Date.now() / 30_000)

/**
 * The app on a phone: a code the server takes, never one already used (it
 * accepts one step either side, and each step once). Waits for the clock only
 * when every step in the window is spent.
 */
function authenticator(secretText: string) {
  const secret = base32(secretText)
  let used = -1
  return {
    async next(): Promise<string> {
      let step = Math.max(used + 1, stepNow())
      while (step > stepNow() + 1) await new Promise((r) => setTimeout(r, 500))
      step = Math.max(step, stepNow() - 1)
      used = step
      return codeAt(secret, step)
    },
    /** The code the setup was verified with (the server spent its step). */
    first(): string {
      used = stepNow()
      return codeAt(secret, used)
    },
  }
}

// --- Helpers ---------------------------------------------------------------------

async function openSettings(page: Page, link: string, view: string) {
  await page.getByRole('button', { name: 'Preferencias' }).click()
  await page.getByRole('dialog').getByRole('button', { name: link }).click()
  await expect(page).toHaveURL(new RegExp(`\\?view=${view}$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(link)
}

/** The password step of signing in, in a browser of its own. */
async function password(browser: Browser, user: string, pw: string) {
  const page = await (await browser.newContext()).newPage()
  await page.goto('/')
  await page.getByLabel('Nombre de usuario').fill(user)
  await page.getByLabel('Contraseña').fill(pw)
  await page.getByRole('button', { name: 'Entrar' }).last().click()
  return page
}

const row = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(`^${name}\\b`) })

let lucia: ReturnType<typeof authenticator>
let recovery: string[] = []

test('a member sets it up from «Account»: nothing is on until a code from the app is verified; then the recovery codes, once', async ({ browser }) => {
  const admin = await signIn(browser, 'noa')
  expect((await admin.request.post('/api/admin/users', { data: { username: LUCIA, role: 'member', password: 'lucia-contraseña-larga' } })).status()).toBe(201)
  await admin.context().close()

  const page = await password(browser, LUCIA, 'lucia-contraseña-larga')
  await expect(page.getByRole('treegrid')).toBeVisible()
  await openSettings(page, 'Cuenta', 'account')
  const section = page.getByRole('region', { name: 'Verificación en dos pasos' })
  await expect(section).toContainText('un código de 6 cifras de una app de autenticación')
  await section.getByRole('button', { name: 'Activar' }).click()

  // The password first: a session left open can't lock its owner out.
  const dialog = page.getByRole('dialog', { name: 'Activar la verificación en dos pasos' })
  await dialog.getByLabel('Contraseña actual').fill('no-es-la-mia-para-nada')
  await dialog.getByRole('button', { name: 'Seguir' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('La contraseña actual no es correcta.')
  await dialog.getByLabel('Contraseña actual').fill('lucia-contraseña-larga')
  await dialog.getByRole('button', { name: 'Seguir' }).click()

  // The QR code, the secret as text, and the app's link.
  await expect(dialog.getByRole('img', { name: 'Código QR para la app de autenticación' })).toBeVisible()
  const secret = (await dialog.getByLabel('Clave secreta').innerText()).trim()
  expect(secret).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/)
  const uri = await dialog.getByRole('link', { name: 'Abrir en la app de este dispositivo' }).getAttribute('href')
  // Named after the installation's public address (THOTH_PUBLIC_URL), so that two thoths tell apart in the app.
  expect(uri).toBe(`otpauth://totp/thoth:${LUCIA}%40${new URL(PUBLIC_URL).host}?secret=${secret.replace(/ /g, '')}&issuer=thoth&algorithm=SHA1&digits=6&period=30`)
  await page.screenshot({ path: `${SHOTS}/twofa-setup-light.png`, animations: 'disabled' })
  // A wrong code turns nothing on.
  await dialog.getByLabel('Código de verificación').fill('000000')
  await dialog.getByRole('button', { name: 'Verificar y activar' }).click()
  await expect(dialog.getByRole('alert')).toContainText('El código no es correcto')
  expect((await (await page.request.get('/api/account/2fa')).json()).enabled).toBe(false)

  lucia = authenticator(secret)
  await dialog.getByLabel('Código de verificación').fill(lucia.first())
  await dialog.getByRole('button', { name: 'Verificar y activar' }).click()
  const codes = page.getByRole('dialog', { name: 'Guarda tus códigos de recuperación' })
  await expect(codes.getByRole('note')).toContainText('Solo se muestran ahora')
  recovery = (await codes.getByRole('list', { name: 'Códigos de recuperación' }).getByRole('listitem').allInnerTexts()).map((c) => c.trim())
  expect(recovery).toHaveLength(10)
  for (const c of recovery) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/)
  await page.screenshot({ path: `${SHOTS}/twofa-codes-light.png`, animations: 'disabled' })
  await codes.getByRole('button', { name: 'Ya los he guardado' }).click()
  await expect(section).toContainText('Activada')
  await expect(section).toContainText('Te quedan 10 códigos de recuperación.')
  await page.screenshot({ path: `${SHOTS}/twofa-account-light.png`, animations: 'disabled', fullPage: true })
  await page.context().close()
})

test('signing in: the password, then the app\'s code; or a recovery code, which says how many are left', async ({ browser }) => {
  const page = await password(browser, LUCIA, 'lucia-contraseña-larga')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Verificación en dos pasos')
  await expect(page.getByText(`Escribe el código de 6 cifras que muestra tu app de autenticación, ${LUCIA}.`)).toBeVisible()
  await page.getByLabel('Código de verificación').fill('000000')
  await page.getByRole('button', { name: 'Verificar' }).click()
  await expect(page.getByRole('alert')).toContainText('El código no es correcto')
  await page.screenshot({ path: `${SHOTS}/twofa-login-light.png`, animations: 'disabled' })
  await page.getByLabel('Código de verificación').fill(await lucia.next())
  await page.getByRole('button', { name: 'Verificar' }).click()
  await expect(page.getByRole('treegrid')).toBeVisible()
  await page.context().close()

  const other = await password(browser, LUCIA, 'lucia-contraseña-larga')
  await other.getByRole('button', { name: '¿No tienes el móvil? Usa un código de recuperación' }).click()
  await other.getByLabel('Código de recuperación').fill(recovery[0]!.toUpperCase())
  await other.getByRole('button', { name: 'Verificar' }).click()
  await expect(other.getByRole('heading', { level: 1 })).toHaveText('Has usado un código de recuperación')
  await expect(other.getByRole('status')).toHaveText('Te quedan 9 códigos de recuperación.')
  await other.getByRole('button', { name: 'Continuar' }).click()
  await expect(other.getByRole('treegrid')).toBeVisible()
  await other.context().close()

  // A recovery code works once.
  const again = await password(browser, LUCIA, 'lucia-contraseña-larga')
  await again.getByRole('button', { name: '¿No tienes el móvil? Usa un código de recuperación' }).click()
  await again.getByLabel('Código de recuperación').fill(recovery[0]!)
  await again.getByRole('button', { name: 'Verificar' }).click()
  await expect(again.getByRole('alert')).toContainText('El código no es correcto')
  await again.context().close()
})

test('a new key asks for the app\'s current code, even with a session; the password is not enough', async ({ browser }) => {
  const page = await password(browser, LUCIA, 'lucia-contraseña-larga')
  await page.getByLabel('Código de verificación').fill(await lucia.next())
  await page.getByRole('button', { name: 'Verificar' }).click()
  await expect(page.getByRole('treegrid')).toBeVisible()
  await openSettings(page, 'Agentes y API', 'agents')
  await page.getByRole('button', { name: 'Nueva clave' }).click()
  const dialog = page.getByRole('dialog', { name: 'Nueva clave' })
  await dialog.getByLabel('Nombre').fill('Clave 2FA e2e')
  const confirm = dialog.getByLabel('Código de tu app de autenticación')
  await expect(dialog.getByText('Una clave da acceso a tus notas: confirma que eres tú, aunque ya hayas entrado.')).toBeVisible()
  await confirm.fill('lucia-contraseña-larga')
  await dialog.getByRole('button', { name: 'Crear la clave' }).click()
  await expect(dialog.getByRole('alert')).toContainText('El código no es correcto')
  await confirm.fill(await lucia.next())
  await page.screenshot({ path: `${SHOTS}/twofa-key-confirm-light.png`, animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Crear la clave' }).click()
  const shown = page.getByRole('dialog', { name: 'Clave para «Clave 2FA e2e»' })
  await expect(shown.locator('.token')).toBeVisible()
  await shown.getByRole('button', { name: 'Ya la he guardado' }).click()
  await page.context().close()
})

test('required: an invited member sets it up before getting in; the admin sees who has it and resets it', async ({ browser }) => {
  const admin = await signIn(browser, 'noa')
  await openSettings(admin, 'Usuarios y grupos', 'users')
  // A new policy is confirmed at the moment (D-040 3.4a): the admin's password, without a second factor.
  await admin.getByRole('radio', { name: /Obligatoria/ }).click()
  const policy = admin.getByRole('alertdialog')
  await expect(policy.getByRole('heading')).toHaveText('¿Cambiar la verificación en dos pasos a «Obligatoria»?')
  await expect(admin.getByRole('radio', { name: /Opcional/ })).toBeChecked()
  await policy.getByLabel('Tu contraseña').fill(PASSWORD)
  await policy.getByRole('button', { name: 'Cambiar' }).click()
  await expect(admin.getByRole('radio', { name: /Obligatoria/ })).toBeChecked()
  expect((await (await admin.request.get('/api/admin/settings')).json()).twoFactor).toBe('required')
  const { link } = await (await admin.request.post('/api/admin/users', { data: { username: PABLO, role: 'member' } })).json() as { link: { path: string } }

  // The invitation, on a phone in dark mode: the password, then the second factor, then in.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'es-ES' })
  const phone = await ctx.newPage()
  await phone.goto(link.path)
  await phone.getByLabel('Contraseña', { exact: true }).fill('pablo-contraseña-larga')
  await phone.getByLabel('Repite la contraseña').fill('pablo-contraseña-larga')
  await phone.getByRole('button', { name: 'Guardar y entrar' }).click()
  await expect(phone.getByRole('heading', { level: 1 })).toHaveText('Activa la verificación en dos pasos')
  await expect(phone.getByText(`Quien administra thoth la exige para entrar, ${PABLO}.`)).toBeVisible()
  await expect(phone.getByRole('treegrid')).toHaveCount(0)
  expect((await phone.request.get('/api/auth/me')).status(), 'no session before it is set up').toBe(401)
  await expect(phone.getByRole('img', { name: 'Código QR para la app de autenticación' })).toBeVisible()
  expect(await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await phone.screenshot({ path: `${SHOTS}/twofa-required-mobile-dark.png`, fullPage: true, animations: 'disabled' })
  const pablo = authenticator(await phone.getByLabel('Clave secreta').innerText())
  await phone.getByLabel('Código de verificación').fill(pablo.first())
  await phone.getByRole('button', { name: 'Verificar y activar' }).tap()
  await expect(phone.getByRole('heading', { level: 1 })).toHaveText('Guarda tus códigos de recuperación')
  await expect(phone.getByRole('list', { name: 'Códigos de recuperación' }).getByRole('listitem')).toHaveCount(10)
  await phone.getByRole('button', { name: 'Continuar' }).tap()
  await expect(phone.getByRole('treegrid')).toBeVisible()
  await ctx.close()

  // The admin: who has it, who will set it up at sign-in (the admin too), and a reset.
  await admin.reload()
  await expect(row(admin, PABLO)).toContainText('Activada')
  await expect(row(admin, LUCIA)).toContainText('Activada')
  await expect(row(admin, 'noa')).toContainText('Al entrar')
  await admin.screenshot({ path: `${SHOTS}/twofa-users-light.png`, animations: 'disabled', fullPage: true })
  await row(admin, PABLO).getByRole('button', { name: `Acciones para ${PABLO}` }).click()
  await admin.getByRole('menuitem', { name: 'Restablecer la verificación en dos pasos' }).click()
  const confirm = admin.getByRole('alertdialog')
  await expect(confirm.getByRole('heading')).toHaveText(`¿Restablecer la verificación en dos pasos de ${PABLO}?`)
  await expect(confirm).toContainText('Como es obligatoria, la configurará de nuevo la próxima vez que entre.')
  await expect(confirm).toContainText(`${PABLO} verá un aviso al entrar, y los demás administradores también.`)
  await confirm.getByLabel('Tu contraseña').fill(PASSWORD)
  await confirm.getByRole('button', { name: 'Restablecer' }).click()
  await expect(row(admin, PABLO)).toContainText('Al entrar')

  await admin.getByRole('radio', { name: /Opcional/ }).click()
  await admin.getByRole('alertdialog').getByLabel('Tu contraseña').fill(PASSWORD)
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Cambiar' }).click()
  await expect(row(admin, 'noa')).not.toContainText('Al entrar')
  await admin.context().close()
})
