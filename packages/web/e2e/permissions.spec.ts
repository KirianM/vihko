// The permissions UI (M4, D-038), with several browsers at once: the admin
// takes a folder away from a member (the lock shows; the member no longer sees
// it, a note there answers the neutral «doesn't exist or no access», and a
// link to it keeps its lock); a move that changes who sees a note asks first;
// a member shares a folder of her own ({user} rule) with a third person, who
// sees it after reloading, the folders above only as the way, and nothing to
// do in it; the effective access of a folder, a person and a key; vihko.yaml
// changed meanwhile, or not writable by vihko. On a phone and in dark mode
// too. It works in a folder of its own.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, MEMBER, NOTES, permissionsSection, specMother } from './env.ts'
import { literally, signIn, usePermissions } from './helpers.ts'

const m = specMother(import.meta.url)
const SHOTS = `${E2E_DIR}/shots`
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled' })
/** A tree row by its name, exactly (a name may be the start of another's, «Mesa» and «Mesa roja»). */
const row = (page: Page, name: string) => page.getByRole('row').filter({ has: page.locator('.tree-label', { hasText: new RegExp(`^${literally(name)}$`, 'u') }) })
/** A row of «Users and groups»: the name first, then something that can't continue a username. */
const userRow = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(`^${literally(name)}(?![\\p{L}\\p{N}._-])`, 'u') })
/** A row of the permissions dialog about someone: the one whose name is exactly theirs (a row's text starts with an avatar letter). */
const about = (page: Page, name: string) => page.locator('.perm-name', { hasText: new RegExp(`^${literally(name)}$`, 'u') })
/** A subject as vihko writes it in vihko.yaml: plain when that reads back the same, quoted otherwise. */
const yamlSubject = (s: string) => (/^[\p{L}\p{N}_][\p{L}\p{N}._-]*$/u.test(s) && !/^(true|false|null|yes|no|on|off|y|n|~)$/i.test(s) && !/^[\d.+-]/.test(s) ? s : JSON.stringify(s))
/** A folder as vihko writes it as a key of vihko.yaml (core's yamlKey with PLAIN_KEY). */
const yamlFolder = (s: string) => (/^[\p{L}\p{N}_][\p{L}\p{N}_ ./-]*(?<! )$/u.test(s) && !/^(true|false|null|yes|no|on|off|y|n|~)$/i.test(s) && !/^[\d.+-]/.test(s) ? s : JSON.stringify(s))
/** The spec's folder, and what's in it: a team's folder, a shared one, the people's (with a kitchen and a diary in the member's). */
const ROOT = m.aFolder()
const TEAM = m.aFolder()
const SHARED = m.aFolder()
const PEOPLE = m.aFolder()
const KITCHEN = m.aFolder()
const DIARY = m.aFolder()
/** The notes' names: two in the team's folder, linked from an index in the shared one, one that moves, a recipe. */
const PLAN = m.aTitle()
const SECRET = m.aTitle()
const INDEX = m.aTitle()
const MOVING = m.aTitle()
const RECIPE = m.aTitle()
const RECIPE_TEXT = m.aSentence()
/** The key that reads the team's folder. */
const KEY = m.aKeyName()
const PERSONAL = { [`${ROOT}/${PEOPLE}/{user}`]: { '{user}': 'manage' } } as const
const RULES = permissionsSection({}, PERSONAL)
/** Someone this spec creates, whom the member shares a folder with. */
const OUTSIDER = m.aUser({ role: 'member' })
/** The member's and the admin's personal folders ({user} rule). */
const MINE = `${ROOT}/${PEOPLE}/${MEMBER.username}`
const ADMINS = `${ROOT}/${PEOPLE}/${ADMIN.username}`
const INDEX_PATH = `${ROOT}/${SHARED}/${INDEX}.md`
const SECRET_PATH = `${ROOT}/${TEAM}/${SECRET}.md`
const note = (title: string, text = m.aParagraph()) => `# ${title}\n\n${text}\n`
const NOTES_IN: Record<string, string> = {
  [`${ROOT}/${TEAM}/${PLAN}.md`]: note(PLAN),
  [SECRET_PATH]: note(SECRET),
  // The links in this order: the member sees both locked.
  [INDEX_PATH]: note(INDEX, `${m.aSentence()} [[${SECRET}]] ${m.aSentence()} [[${PLAN}]].`),
  [`${ROOT}/${SHARED}/${MOVING}.md`]: note(MOVING),
  [`${MINE}/${KITCHEN}/${RECIPE}.md`]: note(RECIPE, RECIPE_TEXT),
  [m.aNotePath(`${MINE}/${DIARY}`)]: note(m.aTitle()),
  [m.aNotePath(ADMINS)]: note(m.aTitle()),
}

test.describe.configure({ mode: 'serial' })
let k: Page
let keyId: string | null = null

/** Opens the menu of a tree row and picks an item. */
async function rowMenu(page: Page, name: string, item: string) {
  await row(page, name).click({ button: 'right' })
  await page.getByRole('menuitem', { name: item }).click()
}

/** Expands the tree down to a folder (each part clicked open). */
async function openFolders(page: Page, ...names: string[]) {
  for (const n of names) {
    const r = row(page, n)
    if ((await r.getAttribute('aria-expanded')) !== 'true') await r.click()
  }
}

/** Waits until vihko has read vihko.yaml with the `{user}` rule (or without it). */
async function rulesInForce(page: Page, personal: boolean) {
  await expect.poll(async () => {
    const r = await page.request.get(`/api/permissions?folder=${encodeURIComponent(ADMINS)}`)
    return r.ok() && (await r.json()).userRule !== null
  }, { timeout: 15_000 }).toBe(personal)
}

test.beforeAll(async ({ browser }) => {
  // Seven notes written (and kept in the history) and vihko.yaml read again: more than a click, under load.
  test.setTimeout(90_000)
  mkdirSync(SHOTS, { recursive: true })
  k = await signIn(browser, ADMIN)
  // The notes, through the API while the admin still manages everything; then the rules.
  for (const [path, text] of Object.entries(NOTES_IN)) {
    const r = await k.request.post('/api/note', { data: { path, text } })
    expect(r.status(), await r.text()).toBe(201)
  }
  await usePermissions({ rules: PERSONAL })
  await rulesInForce(k, true)
  await k.reload()
})

test.afterAll(async () => {
  test.setTimeout(90_000)
  await usePermissions()
  await rulesInForce(k, false)
  if (keyId) await k.request.delete(`/api/keys/${keyId}`)
  // Through the API (never rm): a note may still be open in an editor.
  const tree = await (await k.request.get('/api/tree')).json() as { notes: { path: string }[]; folders: string[] }
  for (const n of tree.notes.filter((x) => x.path.startsWith(`${ROOT}/`))) await k.request.delete(`/api/note?path=${encodeURIComponent(n.path)}`)
  for (const f of tree.folders.filter((x) => x === ROOT || x.startsWith(`${ROOT}/`)).sort().reverse()) await k.request.delete(`/api/folder?path=${encodeURIComponent(f)}`)
})

test('the admin takes a folder away from a member: a lock in the tree; she no longer sees it, a note there is «doesn\'t exist or no access», a link to it keeps its lock', async ({ browser }) => {
  await openFolders(k, ROOT)
  await expect(row(k, PEOPLE)).toBeVisible()
  await rowMenu(k, TEAM, 'Permisos…')
  const dialog = k.getByRole('dialog', { name: `Permisos de «${TEAM}»` })
  // Inherited: rows with where they come from, not editable here; the cascade said plainly.
  await expect(dialog).toContainText('Hereda de /')
  const rows = dialog.getByRole('list', { name: 'Quién tiene permiso' })
  await expect(rows.getByRole('listitem')).toHaveCount(2)
  await expect(rows.getByRole('listitem').filter({ has: about(k, MEMBER.username) })).toContainText('EditarHeredado de /')
  await expect(rows.getByRole('combobox')).toHaveCount(0)
  await expect(dialog).toContainText('Las subcarpetas heredan estos permisos salvo que tengan los suyos.')
  await expect(dialog.getByRole('button', { name: 'Guardar' })).toBeDisabled()
  // Own permissions start from the inherited ones.
  await dialog.getByRole('button', { name: 'Cambiar permisos' }).click()
  await expect(dialog).toContainText('Permisos propios')
  await expect(dialog.getByRole('combobox', { name: `Nivel de ${MEMBER.username}`, exact: true })).toHaveValue('edit')
  await dialog.getByRole('button', { name: `Quitar a ${MEMBER.username}`, exact: true }).click()
  await expect(dialog).toContainText('Nadie más puede ver esta carpeta.')
  await shot(k, 'permissions-dialog-light')
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Guardado.')
  await expect(dialog.getByRole('button', { name: 'Restaurar herencia' })).toBeVisible()
  expect(readFileSync(`${NOTES}/vihko.yaml`, 'utf8')).toBe(RULES + `  ${yamlFolder(`${ROOT}/${TEAM}`)}:\n    grants: { ${yamlSubject(ADMIN.username)}: manage }\n`)
  // Who has access, and why.
  await dialog.getByRole('tab', { name: 'Quién tiene acceso' }).click()
  // Its own grant, and managing the root, which reaches under it whatever this folder says (D-040 3.5).
  await expect(dialog.getByRole('list', { name: 'Quién tiene acceso' }).getByRole('listitem')).toHaveText([new RegExp(`${literally(ADMIN.username)}GestionarDirectamente · en /${literally(`${ROOT}/${TEAM}`)}Directamente · gestiona /$`, 'u')])
  await dialog.getByRole('button', { name: 'Cerrar' }).click()
  await expect(row(k, TEAM).getByRole('img', { name: 'Permisos propios' })).toBeVisible()

  const member = await signIn(browser, MEMBER, INDEX_PATH)
  await openFolders(member, ROOT)
  await expect(row(member, SHARED)).toBeVisible()
  await expect(row(member, TEAM)).toHaveCount(0)
  // Links to notes she can't read: dimmed, with a lock, never «create».
  await expect(member.locator('.cm-wikilink-no_access')).toHaveText([`${SECRET}sin acceso`, `${PLAN}sin acceso`])
  await expect(member.locator('.cm-wikilink-create')).toHaveCount(0)
  // Opening it, or a note that doesn't exist: the same neutral message.
  for (const path of [SECRET_PATH, m.aNotePath(`${ROOT}/${m.aFolder()}`)]) {
    await member.goto(`/?note=${encodeURIComponent(path)}`)
    await expect(member.getByRole('alert')).toContainText('Esta nota no existe o no tienes acceso')
  }
  await shot(member, 'permissions-no-access-light')
  await member.context().close()
})

test('moving a note where someone loses access says who and waits for a confirmation', async ({ browser }) => {
  await openFolders(k, ROOT, SHARED)
  await rowMenu(k, MOVING, 'Renombrar o mover…')
  const dialog = k.getByRole('dialog')
  await dialog.getByLabel('Carpeta').fill(ADMINS)
  const warning = dialog.getByRole('group', { name: 'Cambia quién puede verlo' })
  await expect(warning).toContainText(`Lo pierden${MEMBER.username}`)
  const move = dialog.getByRole('button', { name: 'Mover' })
  await expect(move).toBeDisabled()
  await shot(k, 'permissions-move-warning-light')
  await warning.getByLabel('Entiendo que cambia quién puede verlo').check()
  await expect(move).toBeEnabled()
  // Another destination asks again.
  await dialog.getByLabel('Carpeta').fill(`${ROOT}/${TEAM}`)
  await expect(warning).toContainText(`Lo pierden${MEMBER.username}`)
  await expect(move).toBeDisabled()
  await warning.getByLabel('Entiendo que cambia quién puede verlo').check()
  await move.click()
  await expect(dialog).toHaveCount(0)
  await openFolders(k, TEAM)
  await expect(row(k, MOVING)).toBeVisible()

  const member = await signIn(browser, MEMBER)
  await openFolders(member, ROOT, SHARED)
  await expect(row(member, INDEX)).toBeVisible()
  await expect(row(member, MOVING)).toHaveCount(0)
  await member.context().close()
})

/** A member created by the admin and signed up through their link, with their password. */
async function newMember(browser: Browser, user: { username: string; password: string }) {
  const r = await k.request.post('/api/admin/users', { data: { username: user.username, role: 'member' } })
  expect(r.status(), await r.text()).toBe(201)
  const { link } = await r.json() as { link: { token: string } }
  const ctx = await browser.newContext()
  expect((await ctx.request.post(`/api/invite/${link.token}`, { data: { password: user.password } })).status()).toBe(200)
  await ctx.close()
}

test('a member shares a folder of her own with someone else: he sees it after reloading, the folders above only as the way, and can only read it', async ({ browser }) => {
  await newMember(browser, OUTSIDER)
  // Nothing is his yet: no tree to wait for.
  const outsider = await (await browser.newContext()).newPage()
  await outsider.goto('/')
  await outsider.getByLabel('Nombre de usuario').fill(OUTSIDER.username)
  await outsider.getByLabel('Contraseña').fill(OUTSIDER.password)
  await outsider.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(outsider.getByRole('status').filter({ hasText: 'Todavía no tienes acceso a ninguna carpeta' })).toBeVisible()
  await expect(outsider.getByRole('button', { name: 'Nueva nota' })).toHaveCount(0)

  const member = await signIn(browser, MEMBER)
  await openFolders(member, ROOT, PEOPLE, MEMBER.username)
  // Her own folder: the {user} rule decides; she closes it to agents.
  await rowMenu(member, MEMBER.username, 'Permisos…')
  let dialog = member.getByRole('dialog', { name: `Permisos de «${MEMBER.username}»` })
  await expect(dialog).toContainText(`Carpeta personal: la regla ${ROOT}/${PEOPLE}/{user} decide quién entra`)
  // React Aria's switch: its input is hidden, the label takes the click.
  await dialog.locator('label.switch', { hasText: 'Cerrada a los agentes' }).click()
  await expect(dialog.getByRole('switch', { name: /Cerrada a los agentes/ })).toBeChecked()
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Guardado.')
  await dialog.getByRole('button', { name: 'Cerrar' }).click()
  await expect(row(member, MEMBER.username).getByRole('img', { name: 'Cerrada a los agentes' })).toBeVisible()
  await expect(row(member, KITCHEN).getByRole('img', { name: 'Cerrada a los agentes' })).toBeVisible()

  // Shares the kitchen with the outsider, to read.
  await rowMenu(member, KITCHEN, 'Permisos…')
  dialog = member.getByRole('dialog', { name: `Permisos de «${KITCHEN}»` })
  await expect(dialog).toContainText(`Hereda de /${MINE} (regla ${ROOT}/${PEOPLE}/{user})`)
  await expect(dialog.getByRole('switch', { name: /Cerrada a los agentes/ })).toBeDisabled()
  await expect(dialog).toContainText(`Cerrada desde /${MINE}`)
  await dialog.getByRole('button', { name: 'Cambiar permisos' }).click()
  await expect(dialog).toContainText('Nadie más puede ver esta carpeta.')
  await dialog.getByRole('combobox', { name: 'Persona o grupo' }).selectOption(OUTSIDER.username)
  await dialog.getByRole('button', { name: 'Añadir' }).click()
  await expect(dialog.getByRole('combobox', { name: `Nivel de ${OUTSIDER.username}`, exact: true })).toHaveValue('read')
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Guardado.')
  await dialog.getByRole('tab', { name: 'Quién tiene acceso' }).click()
  const who = dialog.getByRole('list', { name: 'Quién tiene acceso' }).getByRole('listitem')
  // Sorted by level (manage first), then by name.
  await expect(who).toHaveText([
    new RegExp(`${literally(MEMBER.username)}GestionarDirectamente · en /${literally(`${MINE}/${KITCHEN}`)}Directamente · gestiona /${literally(MINE)}$`, 'u'),
    new RegExp(`${literally(OUTSIDER.username)}LeerDirectamente · en /${literally(`${MINE}/${KITCHEN}`)}$`, 'u'),
  ])
  await shot(member, 'permissions-access-light')
  await dialog.getByRole('button', { name: 'Cerrar' }).click()

  // The outsider, after reloading: the way to it muted and with nothing to do; the folder, to read.
  await outsider.reload()
  await openFolders(outsider, ROOT, PEOPLE, MEMBER.username, KITCHEN)
  await expect(row(outsider, ROOT).locator('.tree-row')).toHaveAttribute('title', 'Solo el camino hasta lo que compartieron contigo')
  await expect(row(outsider, KITCHEN).locator('.tree-row')).not.toHaveAttribute('title', /.*/)
  await expect(row(outsider, MEMBER.username).getByRole('button', { name: /Acciones/ })).toHaveCount(0)
  await expect(row(outsider, KITCHEN).getByRole('button', { name: /Acciones/ })).toHaveCount(0)
  await expect(row(outsider, DIARY)).toHaveCount(0)
  await row(outsider, RECIPE).click()
  await expect(outsider.locator('.cm-content')).toContainText(RECIPE_TEXT)
  await expect(outsider.getByRole('button', { name: 'Nueva nota' })).toHaveCount(0)
  await shot(outsider, 'permissions-shared-tree-light')

  // The admin doesn't see her folder in the tree; in «Users and groups», its name, and the outsider's access.
  await k.reload()
  await openFolders(k, ROOT, PEOPLE)
  await expect(row(k, ADMIN.username)).toBeVisible()
  await expect(row(k, MEMBER.username)).toHaveCount(0)
  await k.goto('/?view=users')
  const folders = k.getByRole('list', { name: 'Carpetas' })
  await expect(folders.getByRole('listitem').filter({ has: k.locator('.access-name', { hasText: new RegExp(`^${literally(KITCHEN)}$`, 'u') }) })).toBeVisible()
  await userRow(k, OUTSIDER.username).getByRole('button', { name: `Acciones para ${OUTSIDER.username}` }).click()
  await k.getByRole('menuitem', { name: 'Ver a qué carpetas llega' }).click()
  const access = k.getByRole('dialog', { name: `Acceso de ${OUTSIDER.username}` })
  await expect(access.getByRole('list', { name: 'Carpetas a las que llega' }).getByRole('listitem')).toHaveText([`${ROOT}solo el camino`, `${PEOPLE}solo el camino`, `${MEMBER.username}solo el camino`, `${KITCHEN}Leer`])
  await shot(k, 'permissions-user-access-light')
  await access.getByRole('button', { name: 'Cerrar' }).click()
  await member.context().close()
  await outsider.context().close()
})

test('a key\'s effective access, from «Agents and API»', async () => {
  const r = await k.request.post('/api/keys', { data: { name: KEY, folders: [`${ROOT}/${TEAM}`], confirm: ADMIN.password } })
  expect(r.status(), await r.text()).toBe(201)
  keyId = (await r.json() as { key: { id: string } }).key.id
  await k.goto('/?view=agents')
  await k.locator('.key-card', { has: k.getByRole('heading', { name: KEY, exact: true }) }).getByRole('button', { name: 'Qué ve' }).click()
  const dialog = k.getByRole('dialog', { name: `Qué ve «${KEY}»` })
  await expect(dialog.getByRole('listitem')).toHaveText([`${ROOT}solo el camino`, `${TEAM}Leer`])
  await dialog.getByRole('button', { name: 'Cerrar' }).click()
})

test('vihko.yaml changed meanwhile: the dialog loads it again and says so; one vihko can\'t write is explained', async () => {
  // From the header of a note in the folder.
  await k.goto(`/?note=${encodeURIComponent(INDEX_PATH)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  await k.getByRole('button', { name: `Permisos de la carpeta /${ROOT}/${SHARED}` }).click()
  const dialog = k.getByRole('dialog', { name: `Permisos de «${SHARED}»` })
  await dialog.getByRole('button', { name: 'Cambiar permisos' }).click()
  await dialog.getByRole('combobox', { name: `Nivel de ${MEMBER.username}`, exact: true }).selectOption('read')
  // Someone else edits the file meanwhile.
  writeFileSync(`${NOTES}/vihko.yaml`, '# edited by hand\n' + readFileSync(`${NOTES}/vihko.yaml`, 'utf8'))
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('alert')).toContainText('vihko.yaml cambió mientras tanto')
  await expect(dialog).toContainText('Hereda de /')
  // A section vihko can't use: it is fixed by hand.
  const good = readFileSync(`${NOTES}/vihko.yaml`, 'utf8')
  // The admin's level at the root, however the key is written, becomes one that doesn't exist.
  const broken = good.replace(new RegExp(`("?${literally(ADMIN.username)}"?): manage`, 'u'), '$1: owner')
  expect(broken).not.toBe(good)
  writeFileSync(`${NOTES}/vihko.yaml`, broken)
  await dialog.getByRole('button', { name: 'Cerrar' }).click()
  await rowMenu(k, SHARED, 'Permisos…')
  await dialog.getByRole('button', { name: 'Cambiar permisos' }).click()
  await dialog.getByRole('combobox', { name: `Nivel de ${MEMBER.username}`, exact: true }).selectOption('read')
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Hay que corregirlo a mano')
  await shot(k, 'permissions-config-invalid-light')
  writeFileSync(`${NOTES}/vihko.yaml`, good)
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
})

test('on a phone and in dark mode: the dialog, the locks and the warning fit', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'es-ES' })
  const page = await ctx.newPage()
  await page.goto('/')
  await page.getByLabel('Nombre de usuario').fill(MEMBER.username)
  await page.getByLabel('Contraseña').fill(MEMBER.password)
  await page.getByRole('button', { name: 'Entrar' }).last().tap()
  await expect(page.getByRole('treegrid')).toBeVisible()
  await openFolders(page, ROOT, PEOPLE, MEMBER.username)
  await expect(row(page, KITCHEN).getByRole('img', { name: 'Permisos propios' })).toBeVisible()
  await shot(page, 'permissions-tree-mobile-dark')
  await row(page, KITCHEN).getByRole('button', { name: `Acciones de la carpeta «${KITCHEN}»` }).tap()
  await page.getByRole('menuitem', { name: 'Permisos…' }).tap()
  const dialog = page.getByRole('dialog', { name: `Permisos de «${KITCHEN}»` })
  await expect(dialog.getByRole('combobox', { name: `Nivel de ${OUTSIDER.username}`, exact: true })).toHaveValue('read')
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await shot(page, 'permissions-dialog-mobile-dark')
  await dialog.getByRole('tab', { name: 'Quién tiene acceso' }).tap()
  await shot(page, 'permissions-access-mobile-dark')
  await dialog.getByRole('button', { name: 'Cerrar' }).tap()
  await ctx.close()

  // The move warning in dark mode, on a desktop.
  const dark = await browser.newContext({ colorScheme: 'dark', locale: 'es-ES' })
  const d = await dark.newPage()
  await d.goto('/')
  await d.getByLabel('Nombre de usuario').fill(ADMIN.username)
  await d.getByLabel('Contraseña').fill(ADMIN.password)
  await d.getByRole('button', { name: 'Entrar' }).last().click()
  await openFolders(d, ROOT, SHARED)
  await rowMenu(d, INDEX, 'Renombrar o mover…')
  await d.getByRole('dialog').getByLabel('Carpeta').fill(ADMINS)
  await expect(d.getByRole('group', { name: 'Cambia quién puede verlo' })).toBeVisible()
  await shot(d, 'permissions-move-warning-dark')
  await d.getByRole('dialog').getByRole('button', { name: 'Cancelar' }).click()
  await rowMenu(d, TEAM, 'Permisos…')
  await expect(d.getByRole('dialog', { name: `Permisos de «${TEAM}»` })).toContainText('Permisos propios')
  await shot(d, 'permissions-dialog-dark')
  await dark.close()
})
