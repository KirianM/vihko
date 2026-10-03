// What happens to a shared space and the people in it, told to them as it
// happens, with two and three sessions: a space deleted and brought back
// whole («Undo», the admin's «Spaces»), its members told at once and never
// offered a «Restore» that would fail; a space renamed and someone taken out
// of it; a folder inside a space shared only above what its members have;
// the admin joining only a space nobody manages; a version of a note that
// had the same name before, restored as a new note; vihko.yaml losing its
// permissions and getting them back; a note too large to edit live; and the
// admin's people: a folder adopted, an unused invitation renamed, and who has
// access to what a deleted person shared. (A new password: password.spec.ts.)
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ADMIN, E2E_DIR, MEMBER, NOTES, SPACE, personal, specMother } from './env.ts'
import { dismissNotices, dismissNoticesOf, literally, newUser, signIn, spaceTree, usePermissions, writeWorkspace } from './helpers.ts'

const m = specMother(import.meta.url)
const SHOTS = `${E2E_DIR}/shots`
const SLOW = { timeout: 20_000 }
const q = encodeURIComponent
/** Another member, in the spaces the member makes; someone the admin deletes. */
const OTHER = m.aUser({ role: 'member' })
const GONE = m.aUser({ role: 'member' })
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/, '')

/** A request as `page`'s person; expects `status`. */
async function call(page: Page, method: 'get' | 'post' | 'put' | 'delete', url: string, data?: unknown, status = 200) {
  const r = await page.request[method](url, data === undefined ? {} : { data })
  expect(r.status(), `${method} ${url}: ${await r.text()}`).toBe(status)
  return r.json() as Promise<Record<string, unknown>>
}
const note = (page: Page, path: string, text: string) => call(page, 'post', '/api/note', { path, text }, 201)
/** A new shared space made by `page`'s person, with `members`; its root. */
async function newSpace(page: Page, name: string, members: Record<string, string>): Promise<string> {
  return ((await call(page, 'post', '/api/spaces', { name, members }, 201)) as { space: { path: string } }).space.path
}
/** A section's menu in the sidebar, by its title. */
async function sectionMenu(page: Page, title: string, item: string) {
  await page.getByRole('button', { name: `Acciones de «${title}»`, exact: true }).first().click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}
/** A tree row by its name, exactly. */
const treeRow = (page: Page, tree: string, name: string) =>
  spaceTree(page, tree).getByRole('row').filter({ has: page.locator('.tree-label', { hasText: new RegExp(`^${literally(name)}$`, 'u') }) })
/** A row of «Users and groups»: the name first, then something that can't continue a username. */
const userRow = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(`^${literally(name)}(?![\\p{L}\\p{N}._-])`, 'u') })
async function userId(admin: Page, username: string): Promise<string> {
  const { users } = await call(admin, 'get', '/api/admin/users') as { users: { id: string; username: string }[] }
  return users.find((u) => u.username === username)!.id
}
/** The toast that says `text`. */
const toast = (page: Page, text: string) => page.locator('.toast', { hasText: text })

test.describe.configure({ mode: 'serial' })
let k: Page
let a: Page
let o: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true })
  k = await signIn(browser, ADMIN)
  for (const u of [OTHER, GONE]) await newUser(k, u)
  await dismissNotices(k.request)
  a = await signIn(browser, MEMBER)
  await dismissNotices(a.request)
  o = await signIn(browser, OTHER)
})

test.afterAll(async () => {
  await usePermissions()
  // What this spec told the admin and the member: not left for other specs.
  await dismissNoticesOf(ADMIN, MEMBER)
})

test('a space deleted comes back whole: «Undo» at once, and later from the admin\'s «Spaces»; its other member is told live and never offered a «Restore» that would fail', async () => {
  const name = m.aSpaceName()
  const space = await newSpace(a, name, { [OTHER.username]: 'edit' })
  const inside = `${space}/${m.aTitle()}.md`
  const line = `${m.aSentence().slice(0, -1)} ${m.aUniqueWord()}.`
  await note(a, inside, `# ${baseName(inside)}\n\n${line}\n`)
  await o.goto(`/?note=${q(inside)}`)
  await expect(o.locator('.cm-content')).toContainText(line)

  await a.goto('/')
  await sectionMenu(a, name, 'Borrar espacio…')
  const ask = a.getByRole('alertdialog', { name: `¿Borrar el espacio «${name}»?` })
  await expect(ask).toContainText(`Quienes lo gestionan (${MEMBER.username}) pueden recuperarlo entero, con sus miembros`)
  await ask.getByRole('button', { name: 'Borrar espacio' }).click()
  const undo = toast(a, `Espacio ${name} borrado.`)
  await expect(undo).toBeVisible()
  await expect(spaceTree(a, name)).toHaveCount(0)
  await a.screenshot({ path: `${SHOTS}/space-deleted-undo.png`, animations: 'disabled' })

  // The other member: the open note goes, said as the space's deletion, with no «Restore» (it's the space's to bring back);
  // and the notice, live.
  const gone = toast(o, `${MEMBER.username} ha borrado el espacio con «${baseName(inside)}».`)
  await expect(gone).toBeVisible(SLOW)
  await expect(gone.getByRole('button', { name: 'Restaurar' })).toHaveCount(0)
  await expect(toast(o, `${MEMBER.username} borró el espacio ${name}`)).toBeVisible(SLOW)
  await o.screenshot({ path: `${SHOTS}/space-deleted-member.png`, animations: 'disabled' })

  // «Undo»: back whole, members too; the other member is told.
  await undo.getByRole('button', { name: 'Deshacer' }).click()
  await expect(spaceTree(a, name)).toBeVisible(SLOW)
  await expect(toast(o, `${MEMBER.username} restauró el espacio ${name}`)).toBeVisible(SLOW)
  await call(o, 'get', `/api/note?path=${q(inside)}`)

  // Deleted again; the admin brings it back from «Spaces», without becoming a member of it.
  const { deleted } = await call(a, 'delete', `/api/spaces?path=${q(space)}&trash=true`) as { deleted: string }
  expect(deleted).toBeTruthy()
  await k.goto('/?view=spaces')
  const list = k.getByRole('region', { name: 'Espacios borrados' })
  const card = list.locator('.group-card', { hasText: name })
  await expect(card).toContainText(`Lo borró ${MEMBER.username}`)
  await card.scrollIntoViewIfNeeded()
  await k.screenshot({ path: `${SHOTS}/spaces-deleted-admin.png`, animations: 'disabled' })
  await card.getByRole('button', { name: 'Restaurar espacio' }).click()
  await expect(k.getByRole('status').filter({ hasText: `${name} restaurado.` })).toBeVisible()
  await expect(card).toHaveCount(0)
  expect(((await call(k, 'get', '/api/spaces')) as { spaces: { name: string }[] }).spaces.map((s) => s.name)).not.toContain(name)
  expect(await call(o, 'get', `/api/note?path=${q(inside)}`)).toMatchObject({ text: expect.stringContaining(line) })
  await call(a, 'delete', `/api/spaces?path=${q(space)}&trash=true`)
})

test('a space renamed, and someone taken out of it: told to them as it happens', async () => {
  const name = m.aSpaceName()
  const space = await newSpace(a, name, { [OTHER.username]: 'edit' })
  await note(a, `${space}/${m.aTitle()}.md`, `# ${m.aHeading()}\n`)
  await dismissNotices(o.request)
  await o.goto('/')
  await expect(spaceTree(o, name)).toBeVisible()

  const renamed = m.aSpaceName()
  await a.goto('/')
  await sectionMenu(a, name, 'Renombrar…')
  const dialog = a.getByRole('dialog', { name: `Renombrar «${name}»` })
  await dialog.getByLabel('Nombre', { exact: true }).fill(renamed)
  await dialog.getByRole('button', { name: 'Renombrar' }).click()
  await expect(toast(o, `${name} ahora se llama ${renamed}`)).toBeVisible(SLOW)
  await expect(spaceTree(o, renamed)).toBeVisible(SLOW)
  await o.screenshot({ path: `${SHOTS}/space-renamed-notice.png`, animations: 'disabled' })

  // Taken out from «Members…»: the dialog says what goes with it.
  await sectionMenu(a, renamed, 'Miembros…')
  const members = a.getByRole('dialog', { name: `Miembros de ${renamed}` })
  await members.getByRole('button', { name: `Quitar a ${OTHER.username}` }).click()
  await expect(members.getByRole('note').filter({ hasText: 'Quien sale del espacio pierde también lo que tenía compartido aparte en sus carpetas.' })).toBeVisible()
  await members.screenshot({ path: `${SHOTS}/space-remove-member.png`, animations: 'disabled' })
  await members.getByRole('button', { name: 'Guardar' }).click()
  await expect(toast(o, `${MEMBER.username} te sacó de ${renamed}`)).toBeVisible(SLOW)
  await expect(spaceTree(o, renamed)).toHaveCount(0, SLOW)
  await members.getByRole('button', { name: 'Cerrar' }).click()

  await o.goto('/?view=alerts')
  await expect(o.locator('.alert-card', { hasText: `${name} ahora se llama ${renamed}` })).toContainText(`por ${MEMBER.username}`)
  await expect(o.locator('.alert-card', { hasText: `${MEMBER.username} te sacó de ${renamed}` })).toContainText('Ya no está en tu barra lateral.')
  await o.screenshot({ path: `${SHOTS}/space-notices.png`, animations: 'disabled', fullPage: true })
  await dismissNotices(o.request)
  const root = ((await call(a, 'get', '/api/spaces')) as { spaces: { path: string; name: string }[] }).spaces.find((s) => s.name === renamed)!.path
  expect(root).not.toBe(space)
  await call(a, 'delete', `/api/spaces?path=${q(root)}&trash=true`)
})

test('a folder inside a space is shared only above what its members already have there, in the dialog and the API', async () => {
  const name = m.aSpaceName()
  const space = await newSpace(a, name, { [OTHER.username]: 'edit' })
  const sub = m.aFolder()
  await note(a, `${space}/${sub}/${m.aTitle()}.md`, `# ${m.aHeading()}\n`)
  await a.goto('/')
  await treeRow(a, name, sub).click({ button: 'right' })
  await a.getByRole('menuitem', { name: 'Compartir…' }).click()
  const dialog = a.getByRole('dialog', { name: `Compartir «${sub}»` })
  await expect(dialog).toContainText('A quien ya es miembro del espacio, aquí solo se le puede dar más de lo que tiene en él.')
  await dialog.getByRole('combobox', { name: 'Persona o grupo' }).selectOption(OTHER.username)
  // They edit the whole space: only «Manage» is above it.
  await expect(dialog.getByRole('combobox', { name: 'Nivel', exact: true }).locator('option')).toHaveText(['Gestionar'])
  await dialog.screenshot({ path: `${SHOTS}/space-share-raise-only.png`, animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Cerrar' }).click()

  // The API says the same, with its code; one level up is taken.
  const folder = `${space}/${sub}`
  const { etag } = await call(a, 'get', `/api/permissions?folder=${q(folder)}`) as { etag: string }
  const refused = await call(a, 'put', '/api/permissions', { folder, grants: { [OTHER.username]: 'edit' }, ifMatch: etag }, 400)
  expect(refused.error).toBe('grant_not_higher')
  await call(a, 'put', '/api/permissions', { folder, grants: { [OTHER.username]: 'manage' }, ifMatch: etag })
  await call(a, 'delete', `/api/spaces?path=${q(space)}&trash=true`)
})

test('the admin joins a shared space only to rescue it, when nobody manages it', async () => {
  const name = m.aSpaceName()
  const space = await newSpace(a, name, { [OTHER.username]: 'edit' })
  await k.goto('/?view=spaces')
  const row = k.locator('main').getByRole('row', { name: new RegExp(`^${literally(name)} `) })
  await expect(row).toBeVisible()
  await expect(row.getByRole('button', { name: 'Entrar…' })).toHaveCount(0)
  // The API refuses it too.
  const r = await k.request.post('/api/admin/spaces/join', { data: { path: space, confirm: ADMIN.password } })
  expect(r.status()).toBe(409)
  expect((await r.json()).error).toBe('space_has_managers')

  // Its last manager leaves: now the admin may.
  const { etag } = await call(a, 'get', `/api/permissions?folder=${q(space)}`) as { etag: string }
  await call(a, 'put', '/api/permissions', { folder: space, grants: { [OTHER.username]: 'edit' }, ifMatch: etag })
  await k.reload()
  await expect(row.getByRole('button', { name: 'Entrar…' })).toBeVisible()
  await expect(row.getByRole('button', { name: 'Asignar gestor…' })).toBeVisible()
  await row.getByRole('button', { name: 'Asignar gestor…' }).click()
  const assign = k.getByRole('alertdialog', { name: `Asignar quien gestione «${name}»` })
  await assign.getByRole('combobox', { name: 'Persona' }).selectOption({ label: OTHER.username })
  await assign.getByLabel('Tu contraseña').fill(ADMIN.password)
  await assign.getByRole('button', { name: 'Asignar' }).click()
  await expect(row.getByRole('button', { name: 'Entrar…' })).toHaveCount(0)
  await call(o, 'delete', `/api/spaces?path=${q(space)}&trash=true`)
})

test('a version of the note that had this name before, another one, is restored as a new note beside it, never over it', async () => {
  const path = `${personal(MEMBER)}/${m.aTitle()}.md`
  const first = `${m.aSentence().slice(0, -1)} ${m.aUniqueWord()}.`
  await note(a, path, `---\nuid: ${m.anId()}\n---\n# ${m.aHeading()}\n\n${first}\n`)
  await expect.poll(async () => ((await call(a, 'get', `/api/history/versions?path=${q(path)}`)) as { versions: unknown[] }).versions.length, SLOW).toBeGreaterThan(0)
  await call(a, 'delete', `/api/note?path=${q(path)}`)
  await note(a, path, `---\nuid: ${m.anId()}\n---\n# ${m.aHeading()}\n\n${m.aSentence()}\n`)
  let old: string | undefined
  await expect.poll(async () => {
    // The changes first, newest first, and then the versions: until the new note's creation is a
    // version, the path's versions are still those of the note deleted from it.
    const { changes } = await call(a, 'get', '/api/history/changes?limit=100') as { changes: { id: string; files: { path: string; change: string }[] }[] }
    const created = changes.filter((c) => c.files.some((f) => f.path === path && f.change === 'created')).map((c) => c.id)
    const now = ((await call(a, 'get', `/api/history/versions?path=${q(path)}`)) as { versions: { id: string }[] }).versions.map((v) => v.id)
    old = created[0] !== undefined && now.includes(created[0]) ? created.find((id) => !now.includes(id)) : undefined
    return old
  }, SLOW).toBeTruthy()

  await a.goto(`/?note=${q(path)}&version=${old}`)
  await expect(a.locator('.v-text')).toContainText(first)
  await a.locator('.v-band').getByRole('button', { name: 'Restaurar esta versión' }).click()
  const ask = a.getByRole('alertdialog')
  await ask.getByRole('button', { name: 'Restaurar esta versión' }).click()
  await expect(ask.getByRole('heading')).toHaveText('¿Restaurarla como una nota nueva?')
  await expect(ask).toContainText(`Esta versión es de otra nota que se llamaba «${baseName(path)}» antes`)
  await ask.screenshot({ path: `${SHOTS}/version-as-new.png`, animations: 'disabled' })
  await ask.getByRole('button', { name: 'Restaurar como nota nueva' }).click()
  const restored = `${personal(MEMBER)}/${baseName(path)} (restaurada).md`
  await expect(a.locator('.cm-content')).toContainText(first, SLOW)
  await expect(a.locator('.crumbs b')).toHaveText(`${baseName(path)} (restaurada)`)
  expect(readFileSync(`${NOTES}/${restored}`, 'utf8')).toContain(first)
  // The note there now is as it was.
  expect(readFileSync(`${NOTES}/${path}`, 'utf8')).not.toContain(first)
})

test('vihko.yaml loses its permissions: the admin is told, and puts the last ones back with a button', async () => {
  writeWorkspace('', '')
  await expect.poll(async () => ((await call(k, 'get', '/api/alerts')) as { alerts: { code: string }[] }).alerts.some((x) => x.code === 'permissions_missing'), SLOW).toBe(true)
  await k.goto('/?view=alerts')
  const card = k.locator('.alert-card', { hasText: 'vihko.yaml no tiene permisos: no hay nada compartido' })
  await expect(card).toContainText('todos los espacios y carpetas compartidos están cerrados')
  await card.screenshot({ path: `${SHOTS}/permissions-missing.png`, animations: 'disabled' })
  await card.getByRole('button', { name: 'Restaurar los permisos anteriores' }).click()
  const ask = k.getByRole('alertdialog', { name: '¿Restaurar los permisos anteriores?' })
  await ask.getByRole('button', { name: 'Restaurar' }).click()
  await expect(card).toHaveCount(0, SLOW)
  const yaml = readFileSync(`${NOTES}/vihko.yaml`, 'utf8')
  expect(yaml).toContain('permissions:')
  expect(yaml).toContain(SPACE)
  await usePermissions()
})

test('a note over notes.maxSize opens as plain text with a download, never live; the admin is told', async () => {
  writeWorkspace('notes:\n  maxSize: 0.05\n')
  const path = `${personal(ADMIN)}/${m.aTitle()}.md`
  const head = `# ${baseName(path)}\n\n${m.aSentence()}\n`
  let text = head
  while (text.length < 80_000) text += `${m.aParagraph()}\n\n`
  mkdirSync(dirname(`${NOTES}/${path}`), { recursive: true })
  writeFileSync(`${NOTES}/${path}`, text)
  await expect.poll(async () => {
    const r = await k.request.get(`/api/note?path=${q(path)}`)
    return r.ok() ? ((await r.json()) as { tooLarge?: boolean }).tooLarge === true : false
  }, SLOW).toBe(true)

  await k.goto(`/?note=${q(path)}`)
  const shown = k.locator('.note-too-large')
  await expect(shown).toContainText('Esta nota es demasiado grande para editarla aquí')
  await expect(shown.locator('.too-large-text')).toContainText(baseName(path))
  await expect(k.locator('.cm-content')).toHaveCount(0)
  await k.screenshot({ path: `${SHOTS}/note-too-large.png`, animations: 'disabled' })
  const [download] = await Promise.all([k.waitForEvent('download'), shown.getByRole('button', { name: 'Descargar' }).click()])
  expect(download.suggestedFilename()).toBe(`${baseName(path)}.md`)

  // Writing more to it through the API is refused, with its code.
  const r = await k.request.post('/api/note/edit', { data: { path, ops: [{ op: 'append', text: m.aSentence() }] } })
  expect([r.status(), (await r.json()).error]).toEqual([413, 'note_too_large'])

  await k.goto('/?view=alerts')
  await expect(k.locator('.alert-card', { hasText: 'Notas demasiado grandes para indexarlas o editarlas en vivo' })).toContainText(baseName(path), SLOW)
  await call(k, 'delete', `/api/note?path=${q(path)}`)
  await usePermissions()
})

test('people: a folder already in people/ is adopted only when the admin chooses it; an unused invitation is renamed, its folder following', async () => {
  const name = m.aUsername()
  const kept = `people/${name}/${m.aTitle()}.md`
  mkdirSync(dirname(`${NOTES}/${kept}`), { recursive: true })
  writeFileSync(`${NOTES}/${kept}`, `# ${m.aHeading()}\n`)
  await k.goto('/?view=users')
  await k.getByRole('button', { name: 'Nuevo usuario' }).click()
  const create = k.getByRole('dialog')
  await create.getByLabel('Nombre de usuario').fill(name)
  await create.getByRole('button', { name: 'Crear y obtener el enlace' }).click()
  const adopt = create.getByRole('alert').filter({ hasText: `Ya hay una carpeta ${name}` })
  await expect(adopt).toContainText(`people/${name} existe con notas dentro`)
  await create.screenshot({ path: `${SHOTS}/users-adopt.png`, animations: 'disabled' })
  await adopt.getByRole('button', { name: 'Adoptar su carpeta' }).click()
  await k.getByRole('dialog', { name: `Enlace de invitación para ${name}` }).getByRole('button', { name: 'Listo' }).click()
  await expect(userRow(k, name)).toContainText('Invitación pendiente')

  const renamed = m.aUsername()
  await userRow(k, name).getByRole('button', { name: `Acciones para ${name}` }).click()
  await k.getByRole('menuitem', { name: 'Renombrar…' }).click()
  const dialog = k.getByRole('dialog', { name: `Renombrar a ${name}` })
  await dialog.getByLabel('Nombre de usuario').fill(renamed)
  await dialog.screenshot({ path: `${SHOTS}/users-rename.png`, animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Renombrar' }).click()
  await expect(userRow(k, renamed)).toContainText('Invitación pendiente')
  await expect.poll(() => existsSync(`${NOTES}/people/${renamed}/${kept.slice(kept.lastIndexOf('/') + 1)}`)).toBe(true)
  expect(existsSync(`${NOTES}/people/${name}`)).toBe(false)
  // Someone who used their invitation keeps their name.
  await userRow(k, MEMBER.username).getByRole('button', { name: `Acciones para ${MEMBER.username}` }).click()
  await expect(k.getByRole('menuitem', { name: 'Desactivar' })).toBeVisible()
  await expect(k.getByRole('menuitem', { name: 'Renombrar…' })).toHaveCount(0)
  await k.keyboard.press('Escape')

  // Gone again, with the folder.
  const id = await userId(k, renamed)
  await call(k, 'post', `/api/admin/users/${id}/disable`, { confirm: ADMIN.password })
  await call(k, 'delete', `/api/admin/users/${id}`, { confirm: ADMIN.password })
  await call(k, 'post', `/api/admin/users/${id}/space`, { action: 'delete', confirm: ADMIN.password })
})

test('deleting someone who shared a folder: the dialog says who has access to what, and it stays shared until the admin decides', async ({ browser }) => {
  const g = await signIn(browser, GONE)
  const folder = `${personal(GONE)}/${m.aFolder()}`
  const shared = `${folder}/${m.aTitle()}.md`
  await note(g, shared, `# ${baseName(shared)}\n`)
  const { etag } = await call(g, 'get', `/api/permissions?folder=${q(folder)}`) as { etag: string }
  await call(g, 'put', '/api/permissions', { folder, grants: { [MEMBER.username]: 'edit' }, ifMatch: etag })
  await g.context().close()
  const id = await userId(k, GONE.username)
  await call(k, 'post', `/api/admin/users/${id}/disable`, { confirm: ADMIN.password })

  await k.goto('/?view=users')
  await userRow(k, GONE.username).getByRole('button', { name: `Acciones para ${GONE.username}` }).click()
  await k.getByRole('menuitem', { name: 'Borrar' }).click()
  const dialog = k.getByRole('alertdialog', { name: `¿Borrar a ${GONE.username}?` })
  const who = dialog.locator('.delete-shared')
  await expect(who).toContainText('Quién tiene acceso a lo que compartía:')
  // The admin doesn't read it: the folder isn't named, who sees it is.
  await expect(who.getByRole('listitem')).toHaveText([`Una carpeta suya: ${MEMBER.username} (Editar)`])
  await dialog.screenshot({ path: `${SHOTS}/users-delete-who-has-what.png`, animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Borrar para siempre' }).click()
  await expect(userRow(k, GONE.username)).toHaveCount(0)
  // Still shared until the admin decides.
  await call(a, 'get', `/api/note?path=${q(shared)}`)
  await call(k, 'post', `/api/admin/users/${id}/space`, { action: 'delete', confirm: ADMIN.password })
  await expect.poll(async () => (await a.request.get(`/api/note?path=${q(shared)}`)).status()).toBe(404)
})
