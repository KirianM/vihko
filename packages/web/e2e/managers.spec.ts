// Managing a shared space together (D-056), with two sessions: two people
// manage a space; one shares a subfolder with someone from outside it, and
// the other keeps seeing and managing it: what the space gives is shown as
// inherited, can't be taken away there, and no level below it is offered
// (sharing only adds, D-056.7). The admin role counts for nothing: the admin
// isn't a member, sees nothing of it until the subfolder is shared with him,
// and then gets it in «Shared with me». In one's own space, a folder with no
// one else says so, and the space's root is never shared whole.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { ADMIN, E2E_DIR, MEMBER, personal, specMother } from './env.ts'
import { dismissNotices, literally, newUser, signIn, spaceTree, usePermissions } from './helpers.ts'

const m = specMother(import.meta.url)
const SHOTS = `${E2E_DIR}/shots`
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled' })
/** A tree row by its name, exactly (a name may be the start of another's, «Mesa» and «Mesa roja»). */
const row = (scope: Page | ReturnType<Page['locator']>, page: Page, name: string) => scope.getByRole('row').filter({ has: page.locator('.tree-label', { hasText: new RegExp(`^${literally(name)}$`, 'u') }) })

/** The space the member creates and manages with the co-manager; its folder (`spaces/<readable>-<id>`) is vihko's to choose. */
const SPACE_TWO_NAME = m.aSpaceName()
let SPACE_TWO = ''
const SUB = m.aFolder()
/** Someone this spec creates, who manages the space with the member. */
const CO_MANAGER = m.aUser({ role: 'member' })
/** The note in the subfolder, and what it says. */
const GIFT = m.aTitle()
const GIFT_TEXT = m.aSentence()
/** A folder of the admin's own space nobody else is given. */
const ALONE = m.aFolder()

test.describe.configure({ mode: 'serial' })
let k: Page

async function rowMenu(scope: Page | ReturnType<Page['locator']>, page: Page, name: string, item: string) {
  await row(scope, page, name).click({ button: 'right' })
  await page.getByRole('menuitem', { name: item }).click()
}

const grantsOf = async (page: Page, folder: string) => {
  const r = await page.request.get(`/api/permissions?folder=${encodeURIComponent(folder)}`)
  return r.ok() ? ((await r.json()) as { own: { grants: Record<string, string> | null } }).own.grants : r.status()
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(90_000)
  mkdirSync(SHOTS, { recursive: true })
  k = await signIn(browser, ADMIN)
  await newUser(k, CO_MANAGER)
  // The member creates it (she manages it) with the co-manager managing it too.
  const member = await signIn(browser, MEMBER)
  const made = await member.request.post('/api/spaces', { data: { name: SPACE_TWO_NAME, members: { [CO_MANAGER.username]: 'manage' } } })
  expect(made.status(), await made.text()).toBe(201)
  SPACE_TWO = ((await made.json()) as { space: { path: string } }).space.path
  await expect.poll(() => grantsOf(member, SPACE_TWO), { timeout: 15_000 }).toEqual({ [MEMBER.username]: 'manage', [CO_MANAGER.username]: 'manage' })
  for (const [path, text] of [[m.aNotePath(SPACE_TWO), m.aSentence()], [`${SPACE_TWO}/${SUB}/${GIFT}.md`, GIFT_TEXT]]) {
    const r = await member.request.post('/api/note', { data: { path, text: `# ${m.aHeading()}\n\n${text}\n` } })
    expect(r.status(), await r.text()).toBe(201)
  }
  await member.context().close()
  expect((await k.request.post('/api/folder', { data: { path: `${personal(ADMIN)}/${ALONE}` } })).status()).toBe(201)
})

test.afterAll(async ({ browser }) => {
  test.setTimeout(90_000)
  // Its managers delete it (to the trash), then vihko.yaml goes back to the baseline.
  const member = await signIn(browser, MEMBER)
  await member.request.delete(`/api/spaces?path=${encodeURIComponent(SPACE_TWO)}&trash=true`)
  await member.context().close()
  // What was shared with the admin is told to him: not left for other specs.
  await dismissNotices(k.request)
  await usePermissions()
  await k.request.delete(`/api/folder?path=${encodeURIComponent(`${personal(ADMIN)}/${ALONE}`)}`)
})

test('two co-managers: one shares a subfolder with someone from outside; the other keeps seeing and managing it; nothing above is taken away', async ({ browser }) => {
  // Being admin gives nothing: he isn't a member, so for him the space doesn't exist.
  expect(await grantsOf(k, SPACE_TWO)).toBe(404)
  expect(await grantsOf(k, `${SPACE_TWO}/${SUB}`)).toBe(404)

  const member = await signIn(browser, MEMBER)
  const coManager = await signIn(browser, CO_MANAGER)
  const tree = spaceTree(member, SPACE_TWO_NAME)
  await rowMenu(tree, member, SUB, 'Compartir…')
  const dialog = member.getByRole('dialog', { name: `Compartir «${SUB}»` })
  // What the space gives, read-only: nobody can be taken out of the subfolder.
  const above = dialog.getByRole('list', { name: `Por ${SPACE_TWO_NAME}` })
  await expect(above.getByRole('listitem')).toHaveCount(2)
  await expect(above.getByRole('button')).toHaveCount(0)
  await expect(above.getByRole('combobox')).toHaveCount(0)
  await expect(dialog).toContainText('Aquí solo se puede añadir gente')
  // Who already manages it above isn't offered: nothing could be added for them.
  const who = dialog.getByRole('combobox', { name: 'Persona o grupo' })
  await expect(who.locator('option', { hasText: new RegExp(`^${literally(CO_MANAGER.username)}$`, 'u') })).toHaveCount(0)
  await who.selectOption(ADMIN.username)
  await dialog.getByRole('combobox', { name: 'Nivel' }).selectOption('read')
  await dialog.getByRole('button', { name: 'Añadir' }).click()
  await shot(member, 'managers-dialog-light')
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Guardado.')
  await dialog.getByRole('button', { name: 'Cerrar' }).click()
  await expect(row(tree, member, SUB).getByRole('img', { name: 'Compartida' })).toBeVisible()

  // The co-manager, in her own session: the subfolder is still there, with its note, and she manages it.
  await coManager.reload()
  const hersTree = spaceTree(coManager, SPACE_TWO_NAME)
  await row(hersTree, coManager, SUB).click()
  await row(hersTree, coManager, GIFT).click()
  await expect(coManager.locator('.cm-content')).toContainText(GIFT_TEXT)
  await rowMenu(hersTree, coManager, SUB, 'Compartir…')
  const hers = coManager.getByRole('dialog', { name: `Compartir «${SUB}»` })
  await expect(hers.getByRole('list', { name: 'Quién tiene permiso' })).toContainText(ADMIN.username)
  await hers.getByRole('tab', { name: 'Quién tiene acceso' }).click()
  const access = hers.getByRole('list', { name: 'Quién tiene acceso' }).getByRole('listitem')
  const herName = coManager.locator('.perm-name', { hasText: new RegExp(`^${literally(CO_MANAGER.username)}$`, 'u') })
  await expect(access.filter({ has: herName })).toHaveText(new RegExp(`${literally(CO_MANAGER.username)}GestionarDirectamente · en ${literally(SPACE_TWO_NAME)}$`, 'u'))
  await shot(coManager, 'managers-access-light')
  await hers.getByRole('button', { name: 'Cerrar' }).click()
  await member.context().close()
  await coManager.context().close()

  // The admin reads the subfolder now, and only it: in «Shared with me», with its space.
  await expect.poll(async () => ((await (await k.request.get('/api/spaces')).json()) as { shared: { path: string; space?: { name: string } }[] }).shared
    .find((s) => s.path === `${SPACE_TWO}/${SUB}`)?.space?.name, { timeout: 15_000 }).toBe(SPACE_TWO_NAME)
  expect(await grantsOf(k, SPACE_TWO)).toBe(404)
  await k.reload()
  await k.getByRole('button', { name: 'Compartido conmigo' }).click()
  await expect(k.getByRole('button', { name: `Acciones de «${SUB} · ${SPACE_TWO_NAME}»` })).toBeVisible()
})

test('in one\'s own space: a folder with nobody else says so, and the space itself is never shared whole', async () => {
  await k.reload()
  const mine = spaceTree(k, 'Mis notas')
  await rowMenu(mine, k, ALONE, 'Compartir…')
  const dialog = k.getByRole('dialog', { name: `Compartir «${ALONE}»` })
  await expect(dialog.locator('.perm-nobody')).toHaveText('Nadie más puede ver esta carpeta.')
  await shot(k, 'managers-nobody-light')
  await dialog.getByRole('button', { name: 'Cerrar' }).click()

  // The root of «My notes»: only its agents' switch, never people.
  await k.getByRole('button', { name: 'Acciones de «Mis notas»' }).click()
  await k.getByRole('menuitem', { name: 'Agentes…' }).click()
  const root = k.getByRole('dialog', { name: 'Tus notas y los agentes' })
  await expect(root.locator('.perm-nobody')).toHaveText('Tu espacio no se comparte entero: comparte una carpeta de dentro, o crea un espacio compartido para lo que es de varios.')
  await expect(root.getByRole('combobox', { name: 'Persona o grupo' })).toHaveCount(0)
  await expect(root.getByRole('switch', { name: 'Cerrada a los agentes' })).toBeVisible()
  await shot(k, 'managers-personal-light')
  await root.getByRole('button', { name: 'Cerrar' }).click()
})
