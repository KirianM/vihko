// Spaces (D-056, spec §8.4), with two and three people in their own
// sessions: a folder of one's own space shared with someone, who pins it,
// comments and can't change it; a shared space created from the sidebar for
// a group, edited by three at once, which one can't leave through the group
// and stops seeing when taken out of it; a note moved from one's own space
// into a shared one, and its links; a link to what someone can't read,
// broken for them whether it exists or not; the name a move can't take; the
// last manager leaving and the admin assigning another from the directory,
// which never shows what's inside; a deleted person's space made a shared
// space, and another one transferred; a new member's empty «My notes»; and
// the phone's drawer.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { ADMIN, MEMBER, NOTES, personal, specMother } from './env.ts'
import { literally, newUser, signIn, spaceTree } from './helpers.ts'

const m = specMother(import.meta.url)
const q = encodeURIComponent
const SLOW = { timeout: 20_000 }
/** A third person, and two more who will be deleted. */
const OTHER = m.aUser({ role: 'member' })
const GONE = m.aUser({ role: 'member' })
const LEFT = m.aUser({ role: 'member' })
const FRESH = m.aUser({ role: 'member' })
const GROUP = m.aGroupName()
const CASA = m.aSpaceName()
const MOBILE_SPACE = m.aSpaceName()
/** A folder of the member's own space, shared with OTHER; a note in it. */
const SHARED = m.aFolder()
const SHARED_NOTE = `${personal(MEMBER)}/${SHARED}/${m.aTitle()}.md`
const LINE = `${m.aSentence().slice(0, -1)} ${m.aUniqueWord()}.`
const COMMENT = `${m.aSentence().slice(0, -1)} ${m.aUniqueWord()}.`
const disk = (p: string) => readFileSync(`${NOTES}/${p}`, 'utf8')
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/, '')

/** A request as `page`'s person; expects `status`. */
async function call(page: Page, method: 'get' | 'post' | 'put' | 'delete', url: string, data?: unknown, status = 200) {
  const r = await page.request[method](url, data === undefined ? {} : { data })
  expect(r.status(), `${method} ${url}: ${await r.text()}`).toBe(status)
  return r.json() as Promise<Record<string, unknown>>
}
const note = (page: Page, path: string, text: string) => call(page, 'post', '/api/note', { path, text }, 201)
const folder = (page: Page, path: string) => call(page, 'post', '/api/folder', { path }, 201)
/** A shared space's root, by its name, as `page`'s person reaches it. */
async function spaceRoot(page: Page, name: string): Promise<string> {
  const r = await call(page, 'get', '/api/spaces') as { spaces: { path: string; name: string }[] }
  const s = r.spaces.find((x) => x.name === name)
  expect(s, `space ${name}`).toBeTruthy()
  return s!.path
}
async function userId(admin: Page, username: string): Promise<string> {
  const { users } = await call(admin, 'get', '/api/admin/users') as { users: { id: string; username: string }[] }
  return users.find((u) => u.username === username)!.id
}
const linkStatus = async (page: Page, path: string, raw: string): Promise<Record<string, unknown> & { status?: string; dstPath?: string | null } | null> => {
  const r = await call(page, 'get', `/api/note/links?path=${q(path)}`) as { outgoing: { raw: string; status: string; dstPath: string | null }[] }
  return r.outgoing.find((l) => l.raw === raw) ?? null
}
/** A section's menu in the sidebar, by its title («Casa», «viajes · de ana»). */
async function sectionMenu(page: Page, title: string, item: string) {
  await page.getByRole('button', { name: `Acciones de «${title}»`, exact: true }).first().click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

test.describe.configure({ mode: 'serial' })
let k: Page
let a: Page
let o: Page
let casa: string

test.beforeAll(async ({ browser }) => {
  k = await signIn(browser, ADMIN)
  for (const u of [OTHER, GONE, LEFT, FRESH]) await newUser(k, u)
  a = await signIn(browser, MEMBER)
  o = await signIn(browser, OTHER)
})

test('two people: the member shares a folder of her own space to comment; the other pins it, comments, and can\'t change it; she sees the comment live', async () => {
  await folder(a, `${personal(MEMBER)}/${SHARED}`)
  await note(a, SHARED_NOTE, `# ${baseName(SHARED_NOTE)}\n\n${LINE}\n`)
  await a.reload()
  const mine = spaceTree(a, 'Mis notas')
  await mine.getByRole('row', { name: SHARED, exact: true }).click({ button: 'right' })
  await a.getByRole('menuitem', { name: 'Compartir…' }).click()
  const dialog = a.getByRole('dialog', { name: `Compartir «${SHARED}»` })
  await expect(dialog.getByText('Todo lo de dentro, también lo que se añada después', { exact: false })).toBeVisible()
  await dialog.getByRole('combobox', { name: 'Persona o grupo' }).selectOption(OTHER.username)
  await dialog.getByRole('combobox', { name: 'Nivel', exact: true }).selectOption('comment')
  await dialog.getByRole('button', { name: 'Añadir' }).click()
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Guardado.')
  await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click()
  // The folder carries the «shared» mark in her tree.
  await expect(mine.getByRole('row', { name: SHARED, exact: true }).getByRole('img', { name: 'Compartida' })).toBeVisible()

  // The other is told, and finds it in «Shared with me», with its owner.
  await o.reload()
  await expect(o.getByRole('status').filter({ hasText: `${MEMBER.username} ha compartido contigo «${SHARED}» · de ${MEMBER.username}` })).toBeVisible()
  await o.getByRole('button', { name: 'Compartido conmigo' }).click()
  const title = `${SHARED} · de ${MEMBER.username}`
  await sectionMenu(o, title, 'Fijar en la barra')
  // Pinned: a section of its own at the top, open.
  const pinned = spaceTree(o, title).first()
  await expect(pinned.getByRole('row', { name: baseName(SHARED_NOTE), exact: true })).toBeVisible()
  // Received: not renamed, moved or deleted from here; no «Renombrar» in its menu.
  await o.getByRole('button', { name: `Acciones de «${title}»`, exact: true }).first().click()
  await expect(o.getByRole('menuitem', { name: 'Quitar de la barra' })).toBeVisible()
  await expect(o.getByRole('menuitem', { name: /Renombrar/ })).toHaveCount(0)
  await o.keyboard.press('Escape')
  const move = await o.request.post('/api/folder/move', { data: { from: `${personal(MEMBER)}/${SHARED}`, to: `${personal(MEMBER)}/${m.aFolder()}` } })
  expect(move.status()).toBe(403)

  // Comments: read-only editor; a comment of theirs reaches the member live.
  await pinned.getByRole('row', { name: baseName(SHARED_NOTE), exact: true }).click()
  await expect(o.locator('.cm-content')).toBeVisible()
  await expect(o.locator('.status-readonly')).toHaveText('Solo comentarios')
  await expect(o.locator('.crumbs')).toContainText(`${MEMBER.username} / ${SHARED} / ${baseName(SHARED_NOTE)}`)
  await a.goto(`/?note=${q(SHARED_NOTE)}`)
  await expect(a.locator('.cm-content')).toBeVisible()
  await expect(a.locator('.crumbs')).toContainText(`Mis notas / ${SHARED} / ${baseName(SHARED_NOTE)}`)
  const panel = (p: Page) => p.getByRole('complementary', { name: 'Comentarios y contexto' })
  await o.locator('.cm-line', { hasText: LINE }).click()
  await panel(o).getByRole('button', { name: 'Comentar la selección' }).click()
  await panel(o).getByPlaceholder('Escribe un comentario…').fill(COMMENT)
  await panel(o).locator('.thread-draft').getByRole('button', { name: 'Comentar' }).click()
  await expect(panel(a).locator('.thread', { hasText: COMMENT })).toBeVisible(SLOW)
  await expect.poll(() => disk(SHARED_NOTE)).toContain(COMMENT)
})

test('three people: the admin creates a space for a group; the three edit a note at once; one can\'t leave through the group and stops seeing it when taken out', async () => {
  const group = await call(k, 'post', '/api/admin/groups', { name: GROUP }, 201) as { group: { id: string } }
  for (const u of [MEMBER, OTHER]) await call(k, 'post', `/api/admin/groups/${group.group.id}/members`, { userId: await userId(k, u.username) })
  await k.reload()
  await k.getByRole('button', { name: 'Nuevo espacio' }).click()
  const dialog = k.getByRole('dialog', { name: 'Nuevo espacio compartido' })
  await dialog.getByLabel('Nombre', { exact: true }).fill(CASA)
  await dialog.getByRole('combobox', { name: 'Persona o grupo' }).selectOption(`@${GROUP}`)
  await dialog.getByRole('combobox', { name: 'Nivel', exact: true }).selectOption('edit')
  await dialog.getByRole('button', { name: 'Añadir' }).click()
  await dialog.getByRole('button', { name: 'Crear espacio' }).click()
  await expect(spaceTree(k, CASA)).toBeVisible()
  casa = await spaceRoot(k, CASA)
  expect(casa).toMatch(/^spaces\/[^/]+-[a-z0-9]{6}$/)

  const shared = `${casa}/${m.aTitle()}.md`
  await note(k, shared, `# ${baseName(shared)}\n\n${m.aSentence()}\n`)
  for (const p of [k, a, o]) await p.goto(`/?note=${q(shared)}`)
  for (const p of [k, a, o]) await expect(p.locator('.presence .avatar')).toHaveCount(3, SLOW)
  const typed = { k: m.aUniqueWord(), a: m.aUniqueWord(), o: m.aUniqueWord() }
  for (const [p, w] of [[k, typed.k], [a, typed.a], [o, typed.o]] as const) {
    await p.locator('.cm-content').click()
    await p.keyboard.press('Control+End')
    await p.keyboard.type(`\n${w}`)
  }
  await expect.poll(() => disk(shared), SLOW).toContain(typed.k)
  await expect.poll(() => disk(shared), SLOW).toContain(typed.a)
  await expect.poll(() => disk(shared), SLOW).toContain(typed.o)
  await expect(o.locator('.crumbs')).toContainText(`${CASA} / ${baseName(shared)}`)

  // Through the group: leaving says so, and nothing changes.
  await sectionMenu(o, CASA, 'Salir')
  const leave = o.getByRole('alertdialog', { name: `¿Salir de «${CASA}»?` })
  await leave.getByRole('button', { name: 'Salir del espacio' }).click()
  await expect(leave.getByRole('alert')).toHaveText(`Lo ves por @${GROUP}: pide al admin que te saque del grupo.`)
  await leave.getByRole('button', { name: 'Cancelar' }).click()

  // The admin takes them out of the group: the open note goes at once.
  await call(k, 'delete', `/api/admin/groups/${group.group.id}/members/${await userId(k, OTHER.username)}`)
  await expect(o.getByText('Esta nota no existe o no tienes acceso.')).toBeVisible(SLOW)
  await o.reload()
  await expect(spaceTree(o, CASA)).toHaveCount(0)
})

test('the member moves a note of her own into the space: it stops being hers, her links by name are written across spaces, and her diary\'s link still leads to it', async () => {
  const dir = `${personal(MEMBER)}/${m.aFolder()}`
  const moved = `${dir}/${m.aTitle()}.md`
  const target = `${dir}/${m.aTitle()}.md`
  const diary = `${personal(MEMBER)}/${m.aTitle()}.md`
  await note(a, target, `# ${baseName(target)}\n`)
  await note(a, moved, `# ${baseName(moved)}\n\n[[${baseName(target)}]]\n`)
  await note(a, diary, `# ${baseName(diary)}\n\n[[${baseName(moved)}]]\n`)
  await a.goto(`/?note=${q(moved)}`)
  await expect(a.locator('.cm-content')).toBeVisible()
  await a.getByRole('button', { name: 'Más acciones' }).click()
  await a.getByRole('menuitem', { name: 'Renombrar o mover…' }).click()
  const dialog = a.getByRole('dialog')
  await dialog.getByRole('combobox', { name: 'Espacio' }).selectOption({ label: CASA })
  const warning = dialog.getByRole('group', { name: 'Cambia de espacio' })
  await expect(warning).toContainText(`Dejará de ser tuya: será de los miembros de ${CASA}.`)
  await expect(warning).toContainText(ADMIN.username)
  const submit = dialog.getByRole('button', { name: /^Mover/ })
  await expect(submit).toBeDisabled()
  await warning.getByRole('checkbox', { name: 'Entiendo que cambia quién puede verlo' }).check()
  await submit.click()
  const to = `${casa}/${baseName(moved)}.md`
  await expect(a.locator('.crumbs')).toContainText(`${CASA} / ${baseName(moved)}`, SLOW)
  expect(existsSync(`${NOTES}/${moved}`)).toBe(false)
  // Its link by name to a note of her space: now from the notes root, with the name to show.
  await expect.poll(() => disk(to)).toContain(`[[${target.replace(/\.md$/, '')}|${baseName(target)}]]`)
  // Her diary's link names it where it is now, and still leads there.
  await expect.poll(() => disk(diary)).toContain(`[[${to.replace(/\.md$/, '')}|${baseName(moved)}]]`)
  await expect.poll(async () => (await linkStatus(a, diary, `[[${to.replace(/\.md$/, '')}|${baseName(moved)}]]`))?.dstPath).toBe(to)
})

test('a link to what someone can\'t read is broken for them, whether it exists or not; nothing offers to create it in someone else\'s space', async () => {
  // The admin's own folder, shared with the other (not in the space): a note linking into the space.
  const dir = `${personal(ADMIN)}/${m.aFolder()}`
  const inCasa = `${casa}/${m.aTitle()}.md`
  const nowhere = `${casa}/${m.aTitle()}.md`
  const linking = `${dir}/${m.aTitle()}.md`
  await note(k, inCasa, `# ${baseName(inCasa)}\n`)
  const real = `[[${inCasa.replace(/\.md$/, '')}]]`
  const none = `[[${nowhere.replace(/\.md$/, '')}]]`
  await note(k, linking, `# ${baseName(linking)}\n\n${real}\n\n${none}\n`)
  const perms = await call(k, 'get', `/api/permissions?folder=${q(dir)}`) as { etag: string }
  await call(k, 'put', '/api/permissions', { folder: dir, grants: { [OTHER.username]: 'read' }, ifMatch: perms.etag })
  // For the admin, it leads there; for the other, both are the same: broken.
  await expect.poll(async () => (await linkStatus(k, linking, real))?.status).toBe('resolved')
  await expect.poll(async () => (await linkStatus(o, linking, real))?.status, SLOW).toBe('missing')
  // The same answer, but for where each is in the text and what it names.
  const shape = (l: Record<string, unknown> | null) => { const { raw: _r, target: _t, posFrom: _p, ...rest } = l ?? {}; return rest }
  expect(shape(await linkStatus(o, linking, real))).toEqual(shape(await linkStatus(o, linking, none)))
  await o.goto(`/?note=${q(linking)}`)
  await expect(o.locator('.cm-content')).toBeVisible()
  const badges = o.locator('.cm-wikilink-badge')
  await expect(badges).toHaveCount(2)
  await expect(badges.first()).toHaveText('no existe')
  await expect(badges.nth(1)).toHaveText('no existe')
  await expect(o.locator('.cm-content').getByRole('button', { name: 'crear', exact: true })).toHaveCount(0)
  // Probing a path of the admin's by writing a link in one's own note tells nothing either.
  const probe = `${personal(OTHER)}/${m.aTitle()}.md`
  const hidden = `[[${personal(ADMIN)}/${m.aFolder()}/${m.aTitle()}]]`
  const exists = `[[${linking.replace(/\.md$/, '')}]]`
  const privateNote = `${personal(ADMIN)}/${m.aFolder()}/${m.aTitle()}.md`
  await note(k, privateNote, `# ${baseName(privateNote)}\n`)
  const secret = `[[${privateNote.replace(/\.md$/, '')}]]`
  await note(o, probe, `# ${baseName(probe)}\n\n${hidden}\n\n${secret}\n\n${exists}\n`)
  await expect.poll(async () => (await linkStatus(o, probe, secret))?.status, SLOW).toBe('missing')
  expect((await linkStatus(o, probe, hidden))?.status).toBe('missing')
  expect((await linkStatus(o, probe, exists))?.status).toBe('resolved')
})

test('a rename that would take someone\'s link to a note the renamer can\'t see is refused as a name that isn\'t available', async () => {
  // The admin shares a folder with the other to edit; in it, [[<name>]] leads to a private note of the admin's.
  const privateDir = `${personal(ADMIN)}/${m.aFolder()}`
  const sharedDir = `${personal(ADMIN)}/${m.aFolder()}`
  const name = m.aTitle()
  await note(k, `${privateDir}/${name}.md`, `# ${name}\n`)
  const linking = `${sharedDir}/${m.aTitle()}.md`
  const renamed = `${sharedDir}/${m.aTitle()}.md`
  await note(k, linking, `# ${baseName(linking)}\n\n[[${name}]]\n`)
  await note(k, renamed, `# ${baseName(renamed)}\n`)
  const perms = await call(k, 'get', `/api/permissions?folder=${q(sharedDir)}`) as { etag: string }
  await call(k, 'put', '/api/permissions', { folder: sharedDir, grants: { [OTHER.username]: 'edit' }, ifMatch: perms.etag })
  await expect.poll(async () => (await linkStatus(k, linking, `[[${name}]]`))?.dstPath).toBe(`${privateDir}/${name}.md`)
  await o.goto(`/?note=${q(renamed)}`)
  await expect(o.locator('.cm-content')).toBeVisible(SLOW)
  await o.getByRole('button', { name: 'Más acciones' }).click()
  await o.getByRole('menuitem', { name: 'Renombrar o mover…' }).click()
  const dialog = o.getByRole('dialog')
  await dialog.getByLabel('Nuevo nombre').fill(name)
  await expect(dialog.getByRole('alert')).toHaveText('Ese nombre no está disponible aquí.', SLOW)
  await expect(dialog.getByRole('button', { name: /^Renombrar/ })).toBeDisabled()
  // A name that is simply taken says the same.
  await dialog.getByLabel('Nuevo nombre').fill(baseName(linking))
  await expect(dialog.getByRole('alert')).toHaveText('Ese nombre no está disponible aquí.', SLOW)
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  expect(disk(linking)).toContain(`[[${name}]]`)
})

test('the last manager leaves the space; the admin is told and assigns another from the directory, which never shows what\'s inside', async () => {
  await k.goto('/')
  await sectionMenu(k, CASA, 'Salir')
  await k.getByRole('alertdialog', { name: `¿Salir de «${CASA}»?` }).getByRole('button', { name: 'Salir del espacio' }).click()
  await expect(spaceTree(k, CASA)).toHaveCount(0)
  await k.goto('/?view=alerts')
  await expect(k.locator('.alert-card', { hasText: `Nadie gestiona ${CASA}` })).toBeVisible(SLOW)

  await k.goto('/?view=spaces')
  const row = k.getByRole('row', { name: new RegExp(`^${literally(CASA)}`) })
  await expect(row).toContainText('Sin gestores')
  const inside = (await call(a, 'get', '/api/tree') as { notes: { path: string; title: string }[] }).notes.filter((n) => n.path.startsWith(`${casa}/`))
  expect(inside.length).toBeGreaterThan(0)
  for (const n of inside) await expect(k.locator('main')).not.toContainText(n.title)
  await row.getByRole('button', { name: 'Asignar gestor…' }).click()
  const dialog = k.getByRole('alertdialog', { name: `Asignar quien gestione «${CASA}»` })
  await dialog.getByRole('combobox', { name: 'Persona' }).selectOption({ label: MEMBER.username })
  await dialog.getByLabel('Tu contraseña').fill(ADMIN.password)
  await dialog.getByRole('button', { name: 'Asignar' }).click()
  await expect(k.getByRole('status')).toHaveText(`«${CASA}» ya tiene quien lo gestione.`)
  await expect(row).toContainText(MEMBER.username)
  await a.goto('/?view=alerts')
  await expect(a.locator('.alert-card', { hasText: `ha hecho que ${MEMBER.username} gestione ${CASA}` })).toBeVisible(SLOW)
})

test('the admin deletes two people: their spaces close; one becomes a shared space its members see, the other goes to someone, with the warning about links', async ({ browser }) => {
  // What they have before going.
  const g = await signIn(browser, GONE)
  const gNote = `${personal(GONE)}/${m.aFolder()}/${m.aTitle()}.md`
  await note(g, gNote, `# ${baseName(gNote)}\n`)
  const l = await signIn(browser, LEFT)
  const lNote = `${personal(LEFT)}/${m.aTitle()}.md`
  await note(l, lNote, `# ${baseName(lNote)}\n`)
  await g.context().close()
  await l.context().close()
  for (const u of [GONE, LEFT]) {
    const id = await userId(k, u.username)
    await call(k, 'post', `/api/admin/users/${id}/disable`)
    await call(k, 'delete', `/api/admin/users/${id}`)
  }
  await k.goto('/?view=spaces')
  const closed = (u: { username: string }) => k.locator('.group-card', { hasText: `Espacio de ${u.username}` })

  // Made a shared space: the member manages it and sees it.
  const name = m.aSpaceName()
  await closed(GONE).getByRole('button', { name: 'Convertir en espacio compartido…' }).click()
  let dialog = k.getByRole('alertdialog', { name: `Convertir el espacio de ${GONE.username} en compartido` })
  await expect(dialog).toContainText(`Sus miembros verán todo lo que tenía ${GONE.username}`)
  await dialog.getByLabel('Nombre', { exact: true }).fill(name)
  await dialog.getByRole('combobox', { name: 'Persona o grupo' }).selectOption(MEMBER.username)
  await dialog.getByRole('combobox', { name: 'Nivel', exact: true }).selectOption('manage')
  await dialog.getByRole('button', { name: 'Añadir' }).click()
  await expect(dialog).toContainText('Contiene 1 nota, 0 archivos.')
  await dialog.getByLabel('Tu contraseña').fill(ADMIN.password)
  await dialog.getByRole('button', { name: 'Convertir' }).click()
  await expect(k.getByRole('status')).toContainText(GONE.username)
  await a.goto('/')
  await expect(spaceTree(a, name)).toBeVisible(SLOW)

  // Transferred to the member: into her space, as a folder; the dialog warns about broken links.
  await closed(LEFT).getByRole('button', { name: 'Traspasar…' }).click()
  dialog = k.getByRole('alertdialog', { name: `Traspasar el espacio de ${LEFT.username}` })
  await expect(dialog).toContainText('Algún enlace roto de sus notas puede empezar a llevar a una nota de quien lo recibe')
  await dialog.getByRole('combobox', { name: 'A quién' }).selectOption({ label: MEMBER.username })
  await expect(dialog).toContainText('Contiene 1 nota, 0 archivos.')
  await dialog.getByLabel('Tu contraseña').fill(ADMIN.password)
  await dialog.getByRole('button', { name: 'Traspasar' }).click()
  await expect(k.locator('.group-card', { hasText: `Espacio de ${LEFT.username}` })).toHaveCount(0)
  await expect.poll(() => existsSync(`${NOTES}/${personal(MEMBER)}/${LEFT.username}/${baseName(lNote)}.md`)).toBe(true)
})

test('someone new sees «My notes» empty and creates their first note there', async ({ browser }) => {
  const f = await signIn(browser, FRESH)
  const mine = f.locator('.space-section', { has: f.getByRole('button', { name: 'Mis notas' }) })
  await expect(mine.getByText('Aquí van tus notas')).toBeVisible()
  await mine.getByRole('button', { name: 'Crea tu primera nota' }).click()
  const title = m.aTitle()
  await f.getByRole('dialog', { name: 'Nueva nota' }).getByRole('textbox').fill(title)
  await f.getByRole('option', { name: `Crear «${title}» en Mis notas` }).click()
  await expect(f.locator('.cm-content')).toBeVisible()
  await expect(f.locator('.crumbs')).toContainText(`Mis notas / ${title}`)
  await expect.poll(() => existsSync(`${NOTES}/${personal(FRESH)}/${title}.md`)).toBe(true)
  await f.context().close()
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('from the drawer: a new space, and pinning a folder shared with them', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    const p = await ctx.newPage()
    await p.goto('/')
    await p.getByLabel('Nombre de usuario').fill(OTHER.username)
    await p.getByLabel('Contraseña').fill(OTHER.password)
    await p.getByRole('button', { name: 'Entrar' }).last().click()
    // Their notices come first (what was shared with them): said, then the drawer.
    await p.getByRole('button', { name: 'Cerrar aviso' }).tap()
    await p.getByRole('button', { name: 'Abrir carpetas' }).tap()
    const drawer = p.getByRole('dialog', { name: 'Carpetas' })
    await expect(drawer).toBeVisible()
    await drawer.getByRole('button', { name: 'Nuevo espacio' }).tap()
    const dialog = p.getByRole('dialog', { name: 'Nuevo espacio compartido' })
    await dialog.getByLabel('Nombre', { exact: true }).fill(MOBILE_SPACE)
    await dialog.getByRole('button', { name: 'Crear espacio' }).tap()
    await p.getByRole('button', { name: 'Abrir carpetas' }).tap()
    await expect(p.getByRole('dialog', { name: 'Carpetas' }).getByRole('button', { name: MOBILE_SPACE, exact: true })).toBeVisible()
    // The admin's folder shared with them (to read): pinned from the drawer.
    const d = p.getByRole('dialog', { name: 'Carpetas' })
    await d.getByRole('button', { name: 'Compartido conmigo' }).tap()
    const entry = d.getByRole('button', { name: new RegExp(`^Acciones de «.* · de ${literally(ADMIN.username)}»$`) }).first()
    const label = (await entry.getAttribute('aria-label'))!.replace(/^Acciones de «|»$/g, '')
    await entry.tap()
    await p.getByRole('menuitem', { name: 'Fijar en la barra' }).tap()
    // Pinned: its own section, open, at the top of the drawer.
    await expect(d.getByRole('treegrid', { name: label })).toBeVisible()
    await p.screenshot({ path: `${process.env.SHOTS ?? '/tmp'}/spaces-drawer.png` })
    await ctx.close()
  })
})
