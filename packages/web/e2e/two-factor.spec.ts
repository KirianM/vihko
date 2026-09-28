// The second factor (D-036) in a real browser: a member sets it up from
// «Account» with a code this test computes from the secret on the page,
// signs in with a code and with a recovery code, and confirms a new key with
// the current code. Then the admin makes it required: someone invited sets
// it up before getting in (on a phone, in dark mode), and the admin resets
// it. Users of their own, removed at the end, and the policy back to
// optional: the other specs sign in with a password alone.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { createHmac } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { ADMIN, E2E_DIR, PUBLIC_URL, specMother } from './env.ts'
import { literally, signIn, usePermissions } from './helpers.ts'

const m = specMother(import.meta.url)
const SHOTS = `${E2E_DIR}/shots`
/** A member who sets it up herself, and one invited while it's required: people of this spec. */
const PERSON = m.aUser({ role: 'member' })
const INVITED = m.aUser({ role: 'member' })

test.describe.configure({ mode: 'serial' })
/**
 * The admin's session from before any policy: it stays open when the policy
 * becomes required (the admin has no second factor), so the end can always
 * put things back.
 */
let keeper: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true })
  // A member sees nothing until something is granted (D-038): the two of them read everything.
  await usePermissions({ grants: { [PERSON.username]: 'read', [INVITED.username]: 'read' } })
  keeper = await signIn(browser, ADMIN)
})

test.afterAll(async () => {
  const admin = keeper
  await admin.request.put('/api/admin/settings', { data: { twoFactor: 'optional', confirm: ADMIN.password } })
  for (const u of (await (await admin.request.get('/api/admin/users')).json()).users as { id: string; username: string }[]) {
    if (u.username !== PERSON.username && u.username !== INVITED.username) continue
    await admin.request.post(`/api/admin/users/${u.id}/disable`)
    await admin.request.delete(`/api/admin/users/${u.id}`)
  }
  await admin.context().close()
  await usePermissions()
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

const STEP_MS = 30_000

/**
 * The app on a phone: a code the server takes, never one already used. The
 * server accepts one step either side of now, each once and only after the
 * last one it took: the previous step's code first, then the current one's,
 * then the next one's. Three codes without waiting for the clock, which is
 * all this spec needs; a fourth would wait for the next step.
 */
function authenticator(secretText: string) {
  const secret = base32(secretText)
  let used = -Infinity
  return {
    async next(): Promise<string> {
      for (;;) {
        const now = Date.now()
        const current = Math.floor(now / STEP_MS)
        const step = Math.max(used + 1, current - 1)
        // The previous step's code stops working when this step ends: not in its last seconds.
        const lasts = step >= current || now % STEP_MS < STEP_MS - 3000
        if (step <= current + 1 && lasts) {
          used = step
          return codeAt(secret, step)
        }
        await new Promise((r) => setTimeout(r, 250))
      }
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

/** The password step of signing in, in a browser of its own (or again in `page`'s). */
async function password(browser: Browser | Page, user: string, pw: string) {
  const page = 'newContext' in browser ? await (await browser.newContext()).newPage() : browser
  await page.goto('/')
  await page.getByLabel('Nombre de usuario').fill(user)
  await page.getByLabel('Contraseña').fill(pw)
  await page.getByRole('button', { name: 'Entrar' }).last().click()
  return page
}

/** A user's row: its name comes first, then something that can't continue a username. */
const row = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(`^${literally(name)}(?![\\p{L}\\p{N}._-])`, 'u') })

let app: ReturnType<typeof authenticator>
let recovery: string[] = []
/** The member's session from a recovery code, for the next test: a new key asks for the app's code even with one. */
let session: Page

test('a member sets it up from «Account»: nothing is on until a code from the app is verified; then the recovery codes, once', async ({ browser }) => {
  const admin = await signIn(browser, ADMIN)
  expect((await admin.request.post('/api/admin/users', { data: { username: PERSON.username, role: 'member', password: PERSON.password } })).status()).toBe(201)
  await admin.context().close()

  const page = await password(browser, PERSON.username, PERSON.password)
  await expect(page.getByRole('treegrid')).toBeVisible()
  await openSettings(page, 'Cuenta', 'account')
  const section = page.getByRole('region', { name: 'Verificación en dos pasos' })
  await expect(section).toContainText('un código de 6 cifras de una app de autenticación')
  await section.getByRole('button', { name: 'Activar' }).click()

  // The password first: a session left open can't lock its owner out.
  const dialog = page.getByRole('dialog', { name: 'Activar la verificación en dos pasos' })
  await dialog.getByLabel('Contraseña actual').fill(m.aPassword())
  await dialog.getByRole('button', { name: 'Seguir' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('La contraseña actual no es correcta.')
  await dialog.getByLabel('Contraseña actual').fill(PERSON.password)
  await dialog.getByRole('button', { name: 'Seguir' }).click()

  // The QR code, the secret as text, and the app's link.
  await expect(dialog.getByRole('img', { name: 'Código QR para la app de autenticación' })).toBeVisible()
  const secret = (await dialog.getByLabel('Clave secreta').innerText()).trim()
  expect(secret).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/)
  const uri = await dialog.getByRole('link', { name: 'Abrir en la app de este dispositivo' }).getAttribute('href')
  // Named after the installation's public address (VIHKO_PUBLIC_URL), so that two vihko installations tell apart in the app.
  expect(uri).toBe(`otpauth://totp/vihko:${encodeURIComponent(PERSON.username)}%40${new URL(PUBLIC_URL).host}?secret=${secret.replace(/ /g, '')}&issuer=vihko&algorithm=SHA1&digits=6&period=30`)
  await page.screenshot({ path: `${SHOTS}/twofa-setup-light.png`, animations: 'disabled' })
  // A wrong code turns nothing on.
  await dialog.getByLabel('Código de verificación').fill('000000')
  await dialog.getByRole('button', { name: 'Verificar y activar' }).click()
  await expect(dialog.getByRole('alert')).toContainText('El código no es correcto')
  expect((await (await page.request.get('/api/account/2fa')).json()).enabled).toBe(false)

  app = authenticator(secret)
  await dialog.getByLabel('Código de verificación').fill(await app.next())
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

test('signing in: the password, then the app\'s code, which works once; or a recovery code, which says how many are left', async ({ browser }) => {
  const page = await password(browser, PERSON.username, PERSON.password)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Verificación en dos pasos')
  await expect(page.getByText(`Escribe el código de 6 cifras que muestra tu app de autenticación, ${PERSON.username}.`)).toBeVisible()
  await page.getByLabel('Código de verificación').fill('000000')
  await page.getByRole('button', { name: 'Verificar' }).click()
  await expect(page.getByRole('alert')).toContainText('El código no es correcto')
  await page.screenshot({ path: `${SHOTS}/twofa-login-light.png`, animations: 'disabled' })
  const code = await app.next()
  await page.getByLabel('Código de verificación').fill(code)
  await page.getByRole('button', { name: 'Verificar' }).click()
  await expect(page.getByRole('treegrid')).toBeVisible()
  // The same code again, still within its window: refused. In the same browser,
  // whose failures count for this account there and not for the whole address
  // (which every spec's sign-ins share).
  expect((await page.request.post('/api/auth/logout')).status()).toBe(200)
  await password(page, PERSON.username, PERSON.password)
  await page.getByLabel('Código de verificación').fill(code)
  await page.getByRole('button', { name: 'Verificar' }).click()
  await expect(page.getByRole('alert')).toContainText('Ese código ya se ha usado')
  await page.context().close()

  const other = await password(browser, PERSON.username, PERSON.password)
  await other.getByRole('button', { name: '¿No tienes el móvil? Usa un código de recuperación' }).click()
  await other.getByLabel('Código de recuperación').fill(recovery[0]!.toUpperCase())
  await other.getByRole('button', { name: 'Verificar' }).click()
  await expect(other.getByRole('heading', { level: 1 })).toHaveText('Has usado un código de recuperación')
  await expect(other.getByRole('status')).toHaveText('Te quedan 9 códigos de recuperación.')
  await other.getByRole('button', { name: 'Continuar' }).click()
  await expect(other.getByRole('treegrid')).toBeVisible()
  session = other

  // A recovery code works once.
  const again = await password(browser, PERSON.username, PERSON.password)
  await again.getByRole('button', { name: '¿No tienes el móvil? Usa un código de recuperación' }).click()
  await again.getByLabel('Código de recuperación').fill(recovery[0]!)
  await again.getByRole('button', { name: 'Verificar' }).click()
  await expect(again.getByRole('alert')).toContainText('El código no es correcto')
  await again.context().close()
})

test('a new key asks for the app\'s current code, even with a session; the password is not enough', async () => {
  const page = session
  await openSettings(page, 'Agentes y API', 'agents')
  await page.getByRole('button', { name: 'Nueva clave' }).click()
  const dialog = page.getByRole('dialog', { name: 'Nueva clave' })
  const keyName = m.aKeyName()
  await dialog.getByLabel('Nombre').fill(keyName)
  const confirm = dialog.getByLabel('Código de tu app de autenticación')
  await expect(dialog.getByText('Una clave da acceso a tus notas: confirma que eres tú, aunque ya hayas entrado.')).toBeVisible()
  await confirm.fill(PERSON.password)
  await dialog.getByRole('button', { name: 'Crear la clave' }).click()
  await expect(dialog.getByRole('alert')).toContainText('El código no es correcto')
  await confirm.fill(await app.next())
  await page.screenshot({ path: `${SHOTS}/twofa-key-confirm-light.png`, animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Crear la clave' }).click()
  const shown = page.getByRole('dialog', { name: `Clave para «${keyName}»` })
  await expect(shown.locator('.token')).toBeVisible()
  await shown.getByRole('button', { name: 'Ya la he guardado' }).click()
  await page.context().close()
})

test('required: an invited member sets it up before getting in; the admin sees who has it and resets it', async ({ browser }) => {
  const admin = await signIn(browser, ADMIN)
  await openSettings(admin, 'Usuarios y grupos', 'users')
  // A new policy is confirmed at the moment (D-040 3.4a): the admin's password, without a second factor.
  await admin.getByRole('radio', { name: /Obligatoria/ }).click()
  const policy = admin.getByRole('alertdialog')
  await expect(policy.getByRole('heading')).toHaveText('¿Cambiar la verificación en dos pasos a «Obligatoria»?')
  await expect(admin.getByRole('radio', { name: /Opcional/ })).toBeChecked()
  await policy.getByLabel('Tu contraseña').fill(ADMIN.password)
  await policy.getByRole('button', { name: 'Cambiar' }).click()
  await expect(admin.getByRole('radio', { name: /Obligatoria/ })).toBeChecked()
  expect((await (await admin.request.get('/api/admin/settings')).json()).twoFactor).toBe('required')
  const { link } = await (await admin.request.post('/api/admin/users', { data: { username: INVITED.username, role: 'member' } })).json() as { link: { path: string } }

  // The invitation, on a phone in dark mode: the password, then the second factor, then in.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'es-ES' })
  const phone = await ctx.newPage()
  await phone.goto(link.path)
  await phone.getByLabel('Contraseña', { exact: true }).fill(INVITED.password)
  await phone.getByLabel('Repite la contraseña').fill(INVITED.password)
  await phone.getByRole('button', { name: 'Guardar y entrar' }).click()
  await expect(phone.getByRole('heading', { level: 1 })).toHaveText('Activa la verificación en dos pasos')
  await expect(phone.getByText(`Quien administra vihko la exige para entrar, ${INVITED.username}.`)).toBeVisible()
  await expect(phone.getByRole('treegrid')).toHaveCount(0)
  expect((await phone.request.get('/api/auth/me')).status(), 'no session before it is set up').toBe(401)
  await expect(phone.getByRole('img', { name: 'Código QR para la app de autenticación' })).toBeVisible()
  expect(await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await phone.screenshot({ path: `${SHOTS}/twofa-required-mobile-dark.png`, fullPage: true, animations: 'disabled' })
  const invited = authenticator(await phone.getByLabel('Clave secreta').innerText())
  await phone.getByLabel('Código de verificación').fill(await invited.next())
  await phone.getByRole('button', { name: 'Verificar y activar' }).tap()
  await expect(phone.getByRole('heading', { level: 1 })).toHaveText('Guarda tus códigos de recuperación')
  await expect(phone.getByRole('list', { name: 'Códigos de recuperación' }).getByRole('listitem')).toHaveCount(10)
  await phone.getByRole('button', { name: 'Continuar' }).tap()
  await expect(phone.getByRole('treegrid')).toBeVisible()
  await ctx.close()

  // The admin: who has it, who will set it up at sign-in (the admin too), and a reset.
  await admin.reload()
  await expect(row(admin, INVITED.username)).toContainText('Activada')
  await expect(row(admin, PERSON.username)).toContainText('Activada')
  await expect(row(admin, ADMIN.username)).toContainText('Al entrar')
  await admin.screenshot({ path: `${SHOTS}/twofa-users-light.png`, animations: 'disabled', fullPage: true })
  await row(admin, INVITED.username).getByRole('button', { name: `Acciones para ${INVITED.username}` }).click()
  await admin.getByRole('menuitem', { name: 'Restablecer la verificación en dos pasos' }).click()
  const confirm = admin.getByRole('alertdialog')
  await expect(confirm.getByRole('heading')).toHaveText(`¿Restablecer la verificación en dos pasos de ${INVITED.username}?`)
  await expect(confirm).toContainText('Como es obligatoria, la configurará de nuevo la próxima vez que entre.')
  await expect(confirm).toContainText(`${INVITED.username} verá un aviso al entrar, y los demás administradores también.`)
  await confirm.getByLabel('Tu contraseña').fill(ADMIN.password)
  await confirm.getByRole('button', { name: 'Restablecer' }).click()
  await expect(row(admin, INVITED.username)).toContainText('Al entrar')

  await admin.getByRole('radio', { name: /Opcional/ }).click()
  await admin.getByRole('alertdialog').getByLabel('Tu contraseña').fill(ADMIN.password)
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Cambiar' }).click()
  await expect(row(admin, ADMIN.username)).not.toContainText('Al entrar')
  await admin.context().close()
})
