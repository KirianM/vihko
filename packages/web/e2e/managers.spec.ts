// Managing from above (D-040 3.5), with two sessions: two people who manage a
// folder together; one gives a subfolder permissions of its own without the
// other, who keeps seeing and managing it, and the dialog says why. The
// dialog's texts: a folder with no grants is seen only by whoever manages it
// from above; only a personal folder ({user} rule) is closed to everyone,
// the admin included. It works in a folder of its own.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { ADMIN, E2E_DIR, MEMBER, specMother } from './env.ts'
import { literally, signIn, usePermissions } from './helpers.ts'

const m = specMother(import.meta.url)
const SHOTS = `${E2E_DIR}/shots`
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled' })
/** A tree row by its name, exactly (a name may be the start of another's, «Mesa» and «Mesa roja»). */
const row = (page: Page, name: string) => page.getByRole('row').filter({ has: page.locator('.tree-label', { hasText: new RegExp(`^${literally(name)}$`, 'u') }) })
/** The spec's folder; in it, one two people manage (with a subfolder), one nobody is granted, and the people's. */
const ROOT = m.aFolder()
const SHARED = m.aFolder()
const SUB = m.aFolder()
const CLOSED = m.aFolder()
const PEOPLE = m.aFolder()
const MANAGED = `${ROOT}/${SHARED}`
/** Someone this spec creates, who manages MANAGED with the member. */
const CO_MANAGER = m.aUser({ role: 'member' })
/** A name nobody has: `<ROOT>/<PEOPLE>/<it>` is a personal folder of no one. */
const NOBODY = m.aUsername()
/** The note in the subfolder, and what it says. */
const GIFT = m.aTitle()
const GIFT_TEXT = m.aSentence()
// The member first, then the co-manager: the dialog lists who manages from above in this order.
const RULES = {
  [MANAGED]: { [MEMBER.username]: 'manage', [CO_MANAGER.username]: 'manage' },
  [`${ROOT}/${PEOPLE}/{user}`]: { '{user}': 'manage' },
} as const
const note = (title: string, text = m.aSentence()) => `# ${title}\n\n${text}\n`
const NOTES_IN: Record<string, string> = {
  [m.aNotePath(MANAGED)]: note(m.aTitle()),
  [`${MANAGED}/${SUB}/${GIFT}.md`]: note(GIFT, GIFT_TEXT),
  [m.aNotePath(`${ROOT}/${CLOSED}`)]: note(m.aTitle()),
  [m.aNotePath(`${ROOT}/${PEOPLE}/${NOBODY}`)]: note(m.aTitle()),
}

test.describe.configure({ mode: 'serial' })
let k: Page

async function rowMenu(page: Page, name: string, item: string) {
  await row(page, name).click({ button: 'right' })
  await page.getByRole('menuitem', { name: item }).click()
}

async function openFolders(page: Page, ...names: string[]) {
  for (const n of names) {
    const r = row(page, n)
    if ((await r.getAttribute('aria-expanded')) !== 'true') await r.click()
  }
}

/** A member created by the admin and signed up through their link, with their password. */
async function newMember(browser: Browser, user: { username: string; password: string }) {
  const r = await k.request.post('/api/admin/users', { data: { username: user.username, role: 'member' } })
  expect(r.status(), await r.text()).toBe(201)
  const { link } = await r.json() as { link: { token: string } }
  const ctx = await browser.newContext()
  expect((await ctx.request.post(`/api/invite/${link.token}`, { data: { password: user.password } })).status()).toBe(200)
  await ctx.close()
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(90_000)
  mkdirSync(SHOTS, { recursive: true })
  k = await signIn(browser, ADMIN)
  for (const [path, text] of Object.entries(NOTES_IN)) {
    const r = await k.request.post('/api/note', { data: { path, text } })
    expect(r.status(), await r.text()).toBe(201)
  }
  await newMember(browser, CO_MANAGER)
  await usePermissions({ rules: RULES })
  await expect.poll(async () => {
    const r = await k.request.get(`/api/permissions?folder=${encodeURIComponent(MANAGED)}`)
    return r.ok() && (await r.json()).own !== null
  }, { timeout: 15_000 }).toBe(true)
  await k.reload()
})

test.afterAll(async () => {
  test.setTimeout(90_000)
  await usePermissions()
  await expect.poll(async () => (await (await k.request.get(`/api/permissions?folder=${encodeURIComponent(MANAGED)}`)).json()).own, { timeout: 15_000 }).toBe(null)
  const tree = await (await k.request.get('/api/tree')).json() as { notes: { path: string }[]; folders: string[] }
  for (const n of tree.notes.filter((x) => x.path.startsWith(`${ROOT}/`))) await k.request.delete(`/api/note?path=${encodeURIComponent(n.path)}`)
  for (const f of tree.folders.filter((x) => x === ROOT || x.startsWith(`${ROOT}/`)).sort().reverse()) await k.request.delete(`/api/folder?path=${encodeURIComponent(f)}`)
})

test('two co-managers: one gives a subfolder permissions of its own without the other, who keeps seeing and managing it', async ({ browser }) => {
  const member = await signIn(browser, MEMBER)
  const coManager = await signIn(browser, CO_MANAGER)
  await openFolders(member, ROOT, SHARED)
  await rowMenu(member, SUB, 'Permisos…')
  const dialog = member.getByRole('dialog', { name: `Permisos de «${SUB}»` })
  await dialog.getByRole('button', { name: 'Cambiar permisos' }).click()
  await dialog.getByRole('button', { name: `Quitar a ${CO_MANAGER.username}`, exact: true }).click()
  // Only her in its grants, but not «nobody else»: whoever manages above keeps managing it, and it says who.
  await expect(dialog).not.toContainText('Nadie más puede ver esta carpeta.')
  await expect(dialog.locator('.perm-managers')).toHaveText(`Quien gestiona una carpeta de arriba también gestiona esta, digan lo que digan sus permisos: ${MEMBER.username} (en /${MANAGED}), ${CO_MANAGER.username} (en /${MANAGED}), ${ADMIN.username} (en /).`)
  await expect(dialog).toContainText('quien gestiona esta carpeta sigue gestionando las de debajo, salvo las carpetas personales')
  await shot(member, 'managers-dialog-light')
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Guardado.')
  await dialog.getByRole('button', { name: 'Cerrar' }).click()
  await expect(row(member, SUB).getByRole('img', { name: 'Permisos propios' })).toBeVisible()

  // The co-manager, in her own session: the subfolder is still there, with its note, and its permissions are hers to change.
  await coManager.reload()
  await openFolders(coManager, ROOT, SHARED, SUB)
  await row(coManager, GIFT).click()
  await expect(coManager.locator('.cm-content')).toContainText(GIFT_TEXT)
  await rowMenu(coManager, SUB, 'Permisos…')
  const hers = coManager.getByRole('dialog', { name: `Permisos de «${SUB}»` })
  await expect(hers.getByRole('button', { name: 'Restaurar herencia' })).toBeVisible()
  await hers.getByRole('tab', { name: 'Quién tiene acceso' }).click()
  const who = hers.getByRole('list', { name: 'Quién tiene acceso' }).getByRole('listitem')
  // Her row: the one whose name is exactly hers (its text starts with an avatar letter).
  const herName = coManager.locator('.perm-name', { hasText: new RegExp(`^${literally(CO_MANAGER.username)}$`, 'u') })
  await expect(who.filter({ has: herName })).toHaveText(new RegExp(`${literally(CO_MANAGER.username)}GestionarDirectamente · gestiona /${literally(MANAGED)}$`, 'u'))
  await shot(coManager, 'managers-access-light')
  // She puts herself back in its grants.
  await hers.getByRole('tab', { name: 'Permisos' }).click()
  await hers.getByRole('combobox', { name: 'Persona o grupo' }).selectOption(CO_MANAGER.username)
  await hers.getByRole('button', { name: 'Añadir' }).click()
  await hers.getByRole('button', { name: 'Guardar' }).click()
  await expect(hers.getByRole('status')).toHaveText('Guardado.')
  expect((await (await coManager.request.get(`/api/permissions?folder=${encodeURIComponent(`${MANAGED}/${SUB}`)}`)).json()).own.grants).toEqual({ [MEMBER.username]: 'manage', [CO_MANAGER.username]: 'read' })
  await hers.getByRole('button', { name: 'Cerrar' }).click()
  await member.context().close()
  await coManager.context().close()
})

test('the texts of a folder nobody is granted: seen only by whoever manages it from above; a personal folder, by nobody, the admin neither', async () => {
  await k.reload()
  await openFolders(k, ROOT)
  await rowMenu(k, CLOSED, 'Permisos…')
  const dialog = k.getByRole('dialog', { name: `Permisos de «${CLOSED}»` })
  await dialog.getByRole('button', { name: 'Cambiar permisos' }).click()
  await dialog.getByRole('button', { name: `Quitar a ${MEMBER.username}`, exact: true }).click()
  await dialog.getByRole('button', { name: `Quitar a ${ADMIN.username}`, exact: true }).click()
  await expect(dialog.locator('.perm-nobody')).toHaveText('Sin permisos aquí: solo la ve quien la gestiona por encima.')
  await expect(dialog.locator('.perm-managers')).toContainText(`${ADMIN.username} (en /)`)
  await expect(dialog).not.toContainText('tampoco el administrador')
  await shot(k, 'managers-nobody-light')
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Guardado.')
  // He still manages it, from the root: the dialog stays his, and says why.
  await dialog.getByRole('tab', { name: 'Quién tiene acceso' }).click()
  await expect(dialog.getByRole('list', { name: 'Quién tiene acceso' }).getByRole('listitem')).toHaveText([new RegExp(`${literally(ADMIN.username)}GestionarDirectamente · gestiona /$`, 'u')])
  await dialog.getByRole('button', { name: 'Cerrar' }).click()

  // A personal folder named like nobody: the admin opens its permissions (the name, never what's in it).
  await k.goto('/?view=users')
  await k.getByRole('button', { name: `Permisos de /${ROOT}/${PEOPLE}/${NOBODY}` }).click()
  const personal = k.getByRole('dialog', { name: `Permisos de «${NOBODY}»` })
  await expect(personal.locator('.perm-nobody')).toHaveText('Nadie puede ver esta carpeta, tampoco el administrador.')
  await expect(personal.locator('.perm-managers')).toHaveCount(0)
  await shot(k, 'managers-personal-light')
  await personal.getByRole('button', { name: 'Cerrar' }).click()
})
