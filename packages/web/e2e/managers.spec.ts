// Managing from above (D-040 3.5), with two sessions: two people who manage a
// folder together; one gives a subfolder permissions of its own without the
// other, who keeps seeing and managing it, and the dialog says why. The
// dialog's texts: a folder with no grants is seen only by whoever manages it
// from above; only a personal folder ({user} rule) is closed to everyone,
// the admin included. It works in its own folder, `gestores/`.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { E2E_DIR, PASSWORD, unique } from './env.ts'
import { signIn, usePermissions } from './helpers.ts'

const SHOTS = `${E2E_DIR}/shots`
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled' })
const row = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(`^${name}\\b`) })
/** Someone this spec creates: a name of this run (a deleted user's stays reserved). */
const CARLA = unique('carla')
const RULES = {
  'gestores/viajes': { ana: 'manage', [CARLA]: 'manage' },
  'gestores/personas/{user}': { '{user}': 'manage' },
} as const
const NOTES_IN: Record<string, string> = {
  'gestores/viajes/Ruta.md': '# Ruta\n\nPor la costa.\n',
  'gestores/viajes/sorpresa/Regalo.md': '# Regalo\n\nUn mapa antiguo.\n',
  'gestores/cerrada/Nota.md': '# Nota\n\nNada más.\n',
  'gestores/personas/antigua/Vieja.md': '# Vieja\n\nDe alguien que ya no está.\n',
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

/** A member created by the admin and signed up through their link, with the tests' password. */
async function newMember(browser: Browser, username: string) {
  const r = await k.request.post('/api/admin/users', { data: { username, role: 'member' } })
  expect(r.status(), await r.text()).toBe(201)
  const { link } = await r.json() as { link: { token: string } }
  const ctx = await browser.newContext()
  expect((await ctx.request.post(`/api/invite/${link.token}`, { data: { password: PASSWORD } })).status()).toBe(200)
  await ctx.close()
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(90_000)
  mkdirSync(SHOTS, { recursive: true })
  k = await signIn(browser, 'noa')
  for (const [path, text] of Object.entries(NOTES_IN)) {
    const r = await k.request.post('/api/note', { data: { path, text } })
    expect(r.status(), await r.text()).toBe(201)
  }
  await newMember(browser, CARLA)
  await usePermissions({ rules: RULES })
  await expect.poll(async () => {
    const r = await k.request.get('/api/permissions?folder=gestores%2Fviajes')
    return r.ok() && (await r.json()).own !== null
  }, { timeout: 15_000 }).toBe(true)
  await k.reload()
})

test.afterAll(async () => {
  test.setTimeout(90_000)
  await usePermissions()
  await expect.poll(async () => (await (await k.request.get('/api/permissions?folder=gestores%2Fviajes')).json()).own, { timeout: 15_000 }).toBe(null)
  const tree = await (await k.request.get('/api/tree')).json() as { notes: { path: string }[]; folders: string[] }
  for (const n of tree.notes.filter((x) => x.path.startsWith('gestores/'))) await k.request.delete(`/api/note?path=${encodeURIComponent(n.path)}`)
  for (const f of tree.folders.filter((x) => x === 'gestores' || x.startsWith('gestores/')).sort().reverse()) await k.request.delete(`/api/folder?path=${encodeURIComponent(f)}`)
})

test('two co-managers: one gives a subfolder permissions of its own without the other, who keeps seeing and managing it', async ({ browser }) => {
  const ana = await signIn(browser, 'ana')
  const carla = await signIn(browser, CARLA)
  await openFolders(ana, 'gestores', 'viajes')
  await rowMenu(ana, 'sorpresa', 'Permisos…')
  const dialog = ana.getByRole('dialog', { name: 'Permisos de «sorpresa»' })
  await dialog.getByRole('button', { name: 'Cambiar permisos' }).click()
  await dialog.getByRole('button', { name: `Quitar a ${CARLA}` }).click()
  // Only her in its grants, but not «nobody else»: whoever manages above keeps managing it, and it says who.
  await expect(dialog).not.toContainText('Nadie más puede ver esta carpeta.')
  await expect(dialog.locator('.perm-managers')).toHaveText(`Quien gestiona una carpeta de arriba también gestiona esta, digan lo que digan sus permisos: ana (en /gestores/viajes), ${CARLA} (en /gestores/viajes), noa (en /).`)
  await expect(dialog).toContainText('quien gestiona esta carpeta sigue gestionando las de debajo, salvo las carpetas personales')
  await shot(ana, 'managers-dialog-light')
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Guardado.')
  await dialog.getByRole('button', { name: 'Cerrar' }).click()
  await expect(row(ana, 'sorpresa').getByRole('img', { name: 'Permisos propios' })).toBeVisible()

  // Carla, in her own session: the subfolder is still there, with its note, and its permissions are hers to change.
  await carla.reload()
  await openFolders(carla, 'gestores', 'viajes', 'sorpresa')
  await row(carla, 'Regalo').click()
  await expect(carla.locator('.cm-content')).toContainText('Un mapa antiguo.')
  await rowMenu(carla, 'sorpresa', 'Permisos…')
  const hers = carla.getByRole('dialog', { name: 'Permisos de «sorpresa»' })
  await expect(hers.getByRole('button', { name: 'Restaurar herencia' })).toBeVisible()
  await hers.getByRole('tab', { name: 'Quién tiene acceso' }).click()
  const who = hers.getByRole('list', { name: 'Quién tiene acceso' }).getByRole('listitem')
  await expect(who.filter({ hasText: CARLA })).toHaveText(new RegExp(`${CARLA}GestionarDirectamente · gestiona /gestores/viajes$`))
  await shot(carla, 'managers-access-light')
  // She puts herself back in its grants.
  await hers.getByRole('tab', { name: 'Permisos' }).click()
  await hers.getByRole('combobox', { name: 'Persona o grupo' }).selectOption(CARLA)
  await hers.getByRole('button', { name: 'Añadir' }).click()
  await hers.getByRole('button', { name: 'Guardar' }).click()
  await expect(hers.getByRole('status')).toHaveText('Guardado.')
  expect((await (await carla.request.get('/api/permissions?folder=gestores%2Fviajes%2Fsorpresa')).json()).own.grants).toEqual({ ana: 'manage', [CARLA]: 'read' })
  await hers.getByRole('button', { name: 'Cerrar' }).click()
  await ana.context().close()
  await carla.context().close()
})

test('the texts of a folder nobody is granted: seen only by whoever manages it from above; a personal folder, by nobody, the admin neither', async () => {
  await k.reload()
  await openFolders(k, 'gestores')
  await rowMenu(k, 'cerrada', 'Permisos…')
  const dialog = k.getByRole('dialog', { name: 'Permisos de «cerrada»' })
  await dialog.getByRole('button', { name: 'Cambiar permisos' }).click()
  await dialog.getByRole('button', { name: 'Quitar a ana' }).click()
  await dialog.getByRole('button', { name: 'Quitar a noa' }).click()
  await expect(dialog.locator('.perm-nobody')).toHaveText('Sin permisos aquí: solo la ve quien la gestiona por encima.')
  await expect(dialog.locator('.perm-managers')).toContainText('noa (en /)')
  await expect(dialog).not.toContainText('tampoco el administrador')
  await shot(k, 'managers-nobody-light')
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Guardado.')
  // He still manages it, from the root: the dialog stays his, and says why.
  await dialog.getByRole('tab', { name: 'Quién tiene acceso' }).click()
  await expect(dialog.getByRole('list', { name: 'Quién tiene acceso' }).getByRole('listitem')).toHaveText([/noaGestionarDirectamente · gestiona \/$/])
  await dialog.getByRole('button', { name: 'Cerrar' }).click()

  // A personal folder named like nobody: the admin opens its permissions (the name, never what's in it).
  await k.goto('/?view=users')
  await k.getByRole('button', { name: 'Permisos de /gestores/personas/antigua' }).click()
  const personal = k.getByRole('dialog', { name: 'Permisos de «antigua»' })
  await expect(personal.locator('.perm-nobody')).toHaveText('Nadie puede ver esta carpeta, tampoco el administrador.')
  await expect(personal.locator('.perm-managers')).toHaveCount(0)
  await shot(k, 'managers-personal-light')
  await personal.getByRole('button', { name: 'Cerrar' }).click()
})
