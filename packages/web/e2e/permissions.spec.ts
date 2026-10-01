// Sharing (D-056), with several browsers at once: the admin shares a folder
// of his own space with a member (the dialog, the mark in the tree); links in
// it to his notes she can't read are broken like a note that doesn't exist,
// with nothing to create, and opening them says the neutral «doesn't exist or
// no access» (D-056.15, .21); a move to another space says whose it becomes
// and who loses it, and waits for a confirmation; a member closes her space
// to agents and shares a folder of it with someone new, who finds it in
// «Shared with me» and can only read it, while the admin sees none of it; the
// effective access of a folder, a person and a key; vihko.yaml changed
// meanwhile, or not writable by vihko. On a phone and in dark mode too.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, MEMBER, NOTES, PERMISSIONS, SPACE_NAME, inVault, personal, specMother } from './env.ts'
import { dismissNotices, literally, newUser, signIn, spaceTree, usePermissions } from './helpers.ts'

const m = specMother(import.meta.url)
const SHOTS = `${E2E_DIR}/shots`
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled' })
type Scope = Page | ReturnType<Page['locator']>
/** A tree row by its name, exactly (a name may be the start of another's, «Mesa» and «Mesa roja»). */
const row = (scope: Scope, name: string) => scope.getByRole('row').filter({ has: ('page' in scope ? scope.page() : scope).locator('.tree-label', { hasText: new RegExp(`^${literally(name)}$`, 'u') }) })
/** A row of «Users and groups»: the name first, then something that can't continue a username. */
const userRow = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(`^${literally(name)}(?![\\p{L}\\p{N}._-])`, 'u') })
/** A subject as vihko writes it in vihko.yaml: plain when that reads back the same, quoted otherwise. */
const yamlSubject = (s: string) => (/^[\p{L}\p{N}_][\p{L}\p{N}._-]*$/u.test(s) && !/^(true|false|null|yes|no|on|off|y|n|~)$/i.test(s) && !/^[\d.+-]/.test(s) ? s : JSON.stringify(s))
/** A folder as vihko writes it as a key of vihko.yaml (core's yamlKey with PLAIN_KEY). */
const yamlFolder = (s: string) => (/^[\p{L}\p{N}_][\p{L}\p{N}_ ./-]*(?<! )$/u.test(s) && !/^(true|false|null|yes|no|on|off|y|n|~)$/i.test(s) && !/^[\d.+-]/.test(s) ? s : JSON.stringify(s))

/** In the vault's space: the spec's folder, with a subfolder of two notes (one moves). */
const ROOT = m.aFolder()
const SHARED = m.aFolder()
const MOVING = m.aTitle()
/** In the admin's space: a folder nobody else sees, and one he shares with the member. */
const TEAM = m.aFolder()
const OPEN = m.aFolder()
/** In the member's: a kitchen she shares, and a diary she doesn't. */
const KITCHEN = m.aFolder()
const DIARY = m.aFolder()
const PLAN = m.aTitle()
const SECRET = m.aTitle()
const INDEX = m.aTitle()
const RECIPE = m.aTitle()
const RECIPE_TEXT = m.aSentence()
/** The key that reads the vault's subfolder. */
const KEY = m.aKeyName()
/** Someone this spec creates, whom the member shares a folder with. */
const OUTSIDER = m.aUser({ role: 'member' })
const ADMINS = personal(ADMIN)
const MINE = personal(MEMBER)
const INDEX_PATH = `${ADMINS}/${OPEN}/${INDEX}.md`
const SECRET_PATH = `${ADMINS}/${TEAM}/${SECRET}.md`
const note = (title: string, text = m.aParagraph()) => `# ${title}\n\n${text}\n`
const ADMIN_NOTES: Record<string, string> = {
  [inVault(`${ROOT}/${SHARED}/${MOVING}.md`)]: note(MOVING),
  [inVault(m.aNotePath(`${ROOT}/${SHARED}`))]: note(m.aTitle()),
  [`${ADMINS}/${TEAM}/${PLAN}.md`]: note(PLAN),
  [SECRET_PATH]: note(SECRET),
  // Links by name to his notes of another folder of his space: the member won't read them.
  [INDEX_PATH]: note(INDEX, `${m.aSentence()} [[${SECRET}]] ${m.aSentence()} [[${PLAN}]].`),
}
const MEMBER_NOTES: Record<string, string> = {
  [`${MINE}/${KITCHEN}/${RECIPE}.md`]: note(RECIPE, RECIPE_TEXT),
  [m.aNotePath(`${MINE}/${DIARY}`)]: note(m.aTitle()),
}

test.describe.configure({ mode: 'serial' })
let k: Page
let keyId: string | null = null

/** Opens the menu of a tree row and picks an item. */
async function rowMenu(page: Page, scope: Scope, name: string, item: string) {
  await row(scope, name).click({ button: 'right' })
  await page.getByRole('menuitem', { name: item }).click()
}

/** Expands the tree down to a folder (each part clicked open). */
async function openFolders(scope: Scope, ...names: string[]) {
  for (const n of names) {
    const r = row(scope, n)
    if ((await r.getAttribute('aria-expanded')) !== 'true') await r.click()
  }
}

const vault = (page: Page) => spaceTree(page, SPACE_NAME)
const mine = (page: Page) => spaceTree(page, 'Mis notas')

async function create(page: Page, notes: Record<string, string>) {
  for (const [path, text] of Object.entries(notes)) {
    const r = await page.request.post('/api/note', { data: { path, text } })
    expect(r.status(), await r.text()).toBe(201)
  }
}

test.beforeAll(async ({ browser }) => {
  // Seven notes written (and kept in the history): more than a click, under load.
  test.setTimeout(90_000)
  mkdirSync(SHOTS, { recursive: true })
  k = await signIn(browser, ADMIN)
  await create(k, ADMIN_NOTES)
  const member = await signIn(browser, MEMBER)
  await create(member, MEMBER_NOTES)
  await member.context().close()
  await k.reload()
})

test.afterAll(async ({ browser }) => {
  test.setTimeout(90_000)
  await usePermissions()
  if (keyId) await k.request.delete(`/api/keys/${keyId}`)
  // Through the API (never rm): a note may still be open in an editor. Each in their own space.
  const member = await signIn(browser, MEMBER)
  for (const [page, under] of [[k, [inVault(ROOT), `${ADMINS}/${TEAM}`, `${ADMINS}/${OPEN}`]], [member, [`${MINE}/${KITCHEN}`, `${MINE}/${DIARY}`]]] as const) {
    const tree = await (await page.request.get('/api/tree')).json() as { notes: { path: string }[]; folders: string[] }
    const inside = (p: string) => under.some((u) => p === u || p.startsWith(`${u}/`))
    for (const n of tree.notes.filter((x) => inside(x.path))) await page.request.delete(`/api/note?path=${encodeURIComponent(n.path)}`)
    for (const f of tree.folders.filter(inside).sort().reverse()) await page.request.delete(`/api/folder?path=${encodeURIComponent(f)}`)
  }
  // What was shared with her is told to her: not left for other specs.
  await dismissNotices(member.request)
  await member.context().close()
})

test('the admin shares a folder of his space with a member: links in it to his notes she can\'t read are broken, with nothing to create, and open as «doesn\'t exist or no access»', async ({ browser }) => {
  await rowMenu(k, mine(k), OPEN, 'Compartir…')
  const dialog = k.getByRole('dialog', { name: `Compartir «${OPEN}»` })
  // His space, and nobody else yet.
  await expect(dialog.locator('.perm-path')).toHaveText(`Mis notas / ${OPEN}`)
  await expect(dialog.locator('.perm-nobody')).toHaveText('Nadie más puede ver esta carpeta.')
  await expect(dialog).toContainText('Aquí solo se puede añadir gente')
  await expect(dialog.getByRole('button', { name: 'Guardar' })).toBeDisabled()
  await dialog.getByRole('combobox', { name: 'Persona o grupo' }).selectOption(MEMBER.username)
  await dialog.getByRole('combobox', { name: 'Nivel' }).selectOption('comment')
  await dialog.getByRole('button', { name: 'Añadir' }).click()
  await expect(dialog.getByRole('combobox', { name: `Nivel de ${MEMBER.username}`, exact: true })).toHaveValue('comment')
  await shot(k, 'permissions-dialog-light')
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Guardado.')
  expect(readFileSync(`${NOTES}/vihko.yaml`, 'utf8')).toBe(PERMISSIONS + `  ${yamlFolder(`${ADMINS}/${OPEN}`)}:\n    grants: { ${yamlSubject(MEMBER.username)}: comment }\n`)
  // Who has access, and why: the space's owner, and her grant here.
  await dialog.getByRole('tab', { name: 'Quién tiene acceso' }).click()
  await expect(dialog.getByRole('list', { name: 'Quién tiene acceso' }).getByRole('listitem')).toHaveText([
    new RegExp(`${literally(ADMIN.username)}GestionarEs su espacio$`, 'u'),
    new RegExp(`${literally(MEMBER.username)}ComentarDirectamente · en Mis notas / ${literally(OPEN)}$`, 'u'),
  ])
  await dialog.getByRole('button', { name: 'Cerrar' }).click()
  await expect(row(mine(k), OPEN).getByRole('img', { name: 'Compartida' })).toBeVisible()

  const member = await signIn(browser, MEMBER, INDEX_PATH)
  // Shown as where it is for her: his space, then the folder.
  await expect(member.locator('.crumbs-path')).toHaveText(`${ADMIN.username} / ${OPEN} / `)
  // Links to notes she can't read: as broken as one to a note that doesn't exist, and in someone else's space never «create».
  await expect(member.locator('.cm-wikilink-missing')).toHaveCount(2)
  await expect(member.locator('.cm-wikilink-missing').first()).toContainText(SECRET)
  await expect(member.locator('.cm-wikilink-create')).toHaveCount(0)
  // Opening it, or a note that doesn't exist, in his space or in the vault's: the same neutral message.
  for (const path of [SECRET_PATH, m.aNotePath(`${ADMINS}/${m.aFolder()}`), inVault(m.aNotePath(m.aFolder()))]) {
    await member.goto(`/?note=${encodeURIComponent(path)}`)
    await expect(member.getByRole('alert')).toContainText('Esta nota no existe o no tienes acceso')
  }
  await shot(member, 'permissions-no-access-light')
  await member.context().close()
})

test('moving a note to another space says whose it becomes and who loses it, and waits for a confirmation', async ({ browser }) => {
  await openFolders(vault(k), ROOT, SHARED)
  await rowMenu(k, vault(k), MOVING, 'Renombrar o mover…')
  const dialog = k.getByRole('dialog')
  await dialog.getByLabel('Espacio').selectOption({ label: 'Mis notas' })
  const warning = dialog.getByRole('group', { name: 'Cambia de espacio' })
  await expect(warning).toContainText('Pasará a tu espacio')
  await expect(warning).toContainText(`Lo pierden${MEMBER.username}`)
  const move = dialog.getByRole('button', { name: 'Mover' })
  await expect(move).toBeDisabled()
  await shot(k, 'permissions-move-warning-light')
  await warning.getByLabel('Entiendo que cambia quién puede verlo').check()
  await expect(move).toBeEnabled()
  // Another destination asks again.
  await dialog.getByLabel('Carpeta').fill(TEAM)
  await expect(warning).toContainText(`Lo pierden${MEMBER.username}`)
  await expect(move).toBeDisabled()
  await warning.getByLabel('Entiendo que cambia quién puede verlo').check()
  await move.click()
  await expect(dialog).toHaveCount(0)
  await openFolders(mine(k), TEAM)
  await expect(row(mine(k), MOVING)).toBeVisible()

  const member = await signIn(browser, MEMBER)
  await openFolders(vault(member), ROOT, SHARED)
  await expect(row(vault(member), MOVING)).toHaveCount(0)
  await member.context().close()
})

test('a member closes her space to agents and shares a folder of it with someone new: he finds it in «Shared with me» and can only read it; the admin sees none of it', async ({ browser }) => {
  await newUser(k, OUTSIDER)
  // Someone new: his own space, empty, and he can create in it from the first moment.
  const outsider = await (await browser.newContext()).newPage()
  await outsider.goto('/')
  await outsider.getByLabel('Nombre de usuario').fill(OUTSIDER.username)
  await outsider.getByLabel('Contraseña').fill(OUTSIDER.password)
  await outsider.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(outsider.getByRole('button', { name: 'Crea tu primera nota' })).toBeVisible()
  await expect(outsider.getByRole('button', { name: 'Nueva nota' })).toBeVisible()

  const member = await signIn(browser, MEMBER)
  // Her whole space, closed to agents.
  await member.getByRole('button', { name: 'Acciones de «Mis notas»' }).click()
  await member.getByRole('menuitem', { name: 'Agentes…' }).click()
  let dialog = member.getByRole('dialog', { name: 'Tus notas y los agentes' })
  // React Aria's switch: its input is hidden, the label takes the click.
  await dialog.locator('label.switch', { hasText: 'Cerrada a los agentes' }).click()
  await expect(dialog.getByRole('switch', { name: /Cerrada a los agentes/ })).toBeChecked()
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Guardado.')
  await dialog.getByRole('button', { name: 'Cerrar' }).click()
  await expect(row(mine(member), KITCHEN).getByRole('img', { name: 'Cerrada a los agentes' })).toBeVisible()

  // Shares the kitchen with the outsider, to read.
  await rowMenu(member, mine(member), KITCHEN, 'Compartir…')
  dialog = member.getByRole('dialog', { name: `Compartir «${KITCHEN}»` })
  await expect(dialog.getByRole('switch', { name: /Cerrada a los agentes/ })).toBeDisabled()
  await expect(dialog).toContainText('Cerrada desde Mis notas')
  await expect(dialog.locator('.perm-nobody')).toHaveText('Nadie más puede ver esta carpeta.')
  await dialog.getByRole('combobox', { name: 'Persona o grupo' }).selectOption(OUTSIDER.username)
  await dialog.getByRole('button', { name: 'Añadir' }).click()
  await expect(dialog.getByRole('combobox', { name: `Nivel de ${OUTSIDER.username}`, exact: true })).toHaveValue('read')
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Guardado.')
  await dialog.getByRole('tab', { name: 'Quién tiene acceso' }).click()
  // Sorted by level (manage first), then by name.
  await expect(dialog.getByRole('list', { name: 'Quién tiene acceso' }).getByRole('listitem')).toHaveText([
    new RegExp(`${literally(MEMBER.username)}GestionarEs su espacio$`, 'u'),
    new RegExp(`${literally(OUTSIDER.username)}LeerDirectamente · en Mis notas / ${literally(KITCHEN)}$`, 'u'),
  ])
  await shot(member, 'permissions-access-light')
  await dialog.getByRole('button', { name: 'Cerrar' }).click()

  // The outsider, after reloading: in «Shared with me», with its owner; to read, and nothing to do in it.
  await outsider.reload()
  await outsider.getByRole('button', { name: 'Compartido conmigo' }).click()
  const section = `${KITCHEN} · de ${MEMBER.username}`
  await outsider.getByRole('button', { name: KITCHEN, exact: false }).filter({ hasText: `de ${MEMBER.username}` }).click()
  const tree = spaceTree(outsider, section)
  await expect(row(tree, RECIPE).getByRole('button', { name: /Acciones/ })).toHaveCount(0)
  await expect(row(outsider, DIARY)).toHaveCount(0)
  await outsider.getByRole('button', { name: `Acciones de «${section}»` }).click()
  await expect(outsider.getByRole('menuitem', { name: 'Compartir…' })).toHaveCount(0)
  await expect(outsider.getByRole('menuitem', { name: 'Fijar en la barra' })).toBeVisible()
  await outsider.keyboard.press('Escape')
  await row(tree, RECIPE).click()
  await expect(outsider.locator('.cm-content')).toContainText(RECIPE_TEXT)
  await expect(outsider.locator('.crumbs-path')).toHaveText(`${MEMBER.username} / ${KITCHEN} / `)
  await shot(outsider, 'permissions-shared-tree-light')

  // The admin sees none of it: not in his spaces, and not in what the outsider reaches as he's shown it.
  expect(((await (await k.request.get('/api/spaces')).json()) as { shared: { path: string }[] }).shared.map((s) => s.path)).not.toContain(`${MINE}/${KITCHEN}`)
  await k.goto('/?view=users')
  await userRow(k, OUTSIDER.username).getByRole('button', { name: `Acciones para ${OUTSIDER.username}` }).click()
  await k.getByRole('menuitem', { name: 'Ver a qué carpetas llega' }).click()
  const access = k.getByRole('dialog', { name: `Acceso de ${OUTSIDER.username}` })
  await expect(access).toContainText('No llega a ninguna carpeta.')
  await expect(access).not.toContainText(KITCHEN)
  await access.getByRole('button', { name: 'Cerrar' }).click()
  // The member's, among the folders the admin reads too: the vault's space, never hers.
  await userRow(k, MEMBER.username).getByRole('button', { name: `Acciones para ${MEMBER.username}` }).click()
  await k.getByRole('menuitem', { name: 'Ver a qué carpetas llega' }).click()
  const hers = k.getByRole('dialog', { name: `Acceso de ${MEMBER.username}` })
  await expect(hers.getByRole('listitem').filter({ hasText: new RegExp(`^${literally(SPACE_NAME)}Editar$`, 'u') })).toBeVisible()
  await expect(hers).not.toContainText(KITCHEN)
  await shot(k, 'permissions-user-access-light')
  await hers.getByRole('button', { name: 'Cerrar' }).click()
  await member.context().close()
  await outsider.context().close()
})

test('a key\'s effective access, from «Agents and API»', async () => {
  const r = await k.request.post('/api/keys', { data: { name: KEY, folders: [inVault(`${ROOT}/${SHARED}`)], confirm: ADMIN.password } })
  expect(r.status(), await r.text()).toBe(201)
  keyId = (await r.json() as { key: { id: string } }).key.id
  await k.goto('/?view=agents')
  await k.locator('.key-card', { has: k.getByRole('heading', { name: KEY, exact: true }) }).getByRole('button', { name: 'Qué ve' }).click()
  const dialog = k.getByRole('dialog', { name: `Qué ve «${KEY}»` })
  await expect(dialog.getByRole('listitem')).toHaveText([`${SPACE_NAME}solo el camino`, `${ROOT}solo el camino`, `${SHARED}Leer`])
  await dialog.getByRole('button', { name: 'Cerrar' }).click()
})

test('vihko.yaml changed meanwhile: the dialog loads it again and says so; one vihko can\'t write is explained', async () => {
  // From the header of a note in the folder.
  await k.goto(`/?note=${encodeURIComponent(INDEX_PATH)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  await k.getByRole('button', { name: `Compartir Mis notas / ${OPEN}` }).click()
  const dialog = k.getByRole('dialog', { name: `Compartir «${OPEN}»` })
  await dialog.getByRole('combobox', { name: `Nivel de ${MEMBER.username}`, exact: true }).selectOption('edit')
  // Someone else edits the file meanwhile.
  writeFileSync(`${NOTES}/vihko.yaml`, '# edited by hand\n' + readFileSync(`${NOTES}/vihko.yaml`, 'utf8'))
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('alert')).toContainText('vihko.yaml cambió mientras tanto')
  await expect(dialog.getByRole('combobox', { name: `Nivel de ${MEMBER.username}`, exact: true })).toHaveValue('comment')
  // A section vihko can't use: it is fixed by hand.
  const good = readFileSync(`${NOTES}/vihko.yaml`, 'utf8')
  // The admin's level in the vault's space, however the key is written, becomes one that doesn't exist.
  const broken = good.replace(new RegExp(`("?${literally(ADMIN.username)}"?): manage`, 'u'), '$1: owner')
  expect(broken).not.toBe(good)
  writeFileSync(`${NOTES}/vihko.yaml`, broken)
  await dialog.getByRole('button', { name: 'Cerrar' }).click()
  await rowMenu(k, mine(k), OPEN, 'Compartir…')
  await dialog.getByRole('combobox', { name: `Nivel de ${MEMBER.username}`, exact: true }).selectOption('edit')
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Hay que corregirlo a mano')
  await shot(k, 'permissions-config-invalid-light')
  writeFileSync(`${NOTES}/vihko.yaml`, good)
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
})

test('on a phone and in dark mode: the dialog, the marks and the warning fit', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'es-ES' })
  // What was shared with her earlier comes as a notice, which would close the drawer first.
  expect((await ctx.request.post('/api/auth/login', { data: { username: MEMBER.username, password: MEMBER.password } })).status()).toBe(200)
  await dismissNotices(ctx.request)
  await ctx.clearCookies()
  const page = await ctx.newPage()
  await page.goto('/')
  await page.getByLabel('Nombre de usuario').fill(MEMBER.username)
  await page.getByLabel('Contraseña').fill(MEMBER.password)
  await page.getByRole('button', { name: 'Entrar' }).last().tap()
  await expect(mine(page)).toBeVisible()
  await expect(row(mine(page), KITCHEN).getByRole('img', { name: 'Compartida' })).toBeVisible()
  await shot(page, 'permissions-tree-mobile-dark')
  await row(mine(page), KITCHEN).getByRole('button', { name: `Acciones de la carpeta «${KITCHEN}»` }).tap()
  await page.getByRole('menuitem', { name: 'Compartir…' }).tap()
  const dialog = page.getByRole('dialog', { name: `Compartir «${KITCHEN}»` })
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
  await openFolders(mine(d), TEAM)
  await rowMenu(d, mine(d), MOVING, 'Renombrar o mover…')
  await d.getByRole('dialog').getByLabel('Espacio').selectOption({ label: SPACE_NAME })
  await expect(d.getByRole('group', { name: 'Cambia de espacio' })).toBeVisible()
  await shot(d, 'permissions-move-warning-dark')
  await d.getByRole('dialog').getByRole('button', { name: 'Cancelar' }).click()
  await rowMenu(d, mine(d), OPEN, 'Compartir…')
  await expect(d.getByRole('dialog', { name: `Compartir «${OPEN}»` }).getByRole('list', { name: 'Quién tiene permiso' })).toContainText(MEMBER.username)
  await shot(d, 'permissions-dialog-dark')
  await dark.close()
})
