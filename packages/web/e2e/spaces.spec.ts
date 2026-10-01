// Spaces, with two and three people in their own
// sessions: a folder of one's own space shared with someone, who pins it,
// comments and can't change it; a shared space created from the sidebar for
// a group, edited by three at once, which one can't leave through the group
// and stops seeing when taken out of it; a note moved from one's own space
// into a shared one, with the links it leaves broken (links never cross
// spaces); a link to what someone can't read,
// broken for them whether it exists or not; the name a move can't take; the
// last manager leaving and the admin assigning another from the directory,
// which never shows what's inside; a deleted person's space made a shared
// space, and another one transferred; a new member's empty «My notes»; and
// the phone's drawer.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, MEMBER, NOTES, personal, specMother } from './env.ts'
import { literally, newUser, noteInUrl, signIn, spaceTree } from './helpers.ts'
import { readablePart } from '@vihko/core/spaces'

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
  await expect(o.getByRole('menuitem', { name: 'Compartir…' })).toHaveCount(0)
  // Who has access, read-only: the owner and them, nothing to change.
  await o.getByRole('menuitem', { name: 'Quién tiene acceso…' }).click()
  const access = o.getByRole('dialog', { name: `Quién tiene acceso a «${SHARED}»` })
  await expect(access.getByRole('listitem')).toHaveText([
    new RegExp(`${literally(MEMBER.username)}.*Gestionar.*Es su espacio`),
    new RegExp(`${literally(OTHER.username)}.*\\(tú\\).*Comentar.*Directamente`),
  ])
  await expect(access.getByRole('combobox')).toHaveCount(0)
  await expect(access.getByRole('button', { name: 'Guardar' })).toHaveCount(0)
  await access.getByRole('button', { name: 'Cerrar' }).click()
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
  expect(casa).toBe(`spaces/${CASA}`)

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

  // A member who doesn't manage it sees who's in and at what level, through the group, and can't change it (they already see the others' edits and presence).
  await sectionMenu(o, CASA, 'Miembros…')
  const membersOf = o.getByRole('dialog', { name: `Miembros de ${CASA}` })
  await expect(membersOf.getByRole('listitem')).toHaveCount(3)
  await expect(membersOf.getByRole('listitem').filter({ hasText: ADMIN.username })).toContainText('Gestionar')
  await expect(membersOf.getByRole('listitem').filter({ hasText: OTHER.username })).toContainText(new RegExp(`Editar.*Por @${literally(GROUP)}`))
  await expect(membersOf.getByRole('button', { name: 'Guardar' })).toHaveCount(0)
  await o.screenshot({ path: `${process.env.SHOTS ?? '/tmp'}/spaces-members-readonly.png` })
  await membersOf.getByRole('button', { name: 'Cerrar' }).click()

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

test('members of a space: changes not saved are never lost unawares, and the manager\'s own row offers «Leave», not a ×', async () => {
  const name = m.aSpaceName()
  const space = (await call(a, 'post', '/api/spaces', { name, members: { [OTHER.username]: 'edit' } }, 201) as { space: { path: string } }).space.path
  await a.goto('/')
  await sectionMenu(a, name, 'Miembros…')
  const dialog = a.getByRole('dialog', { name: `Miembros de ${name}` })
  const row = (who: string) => dialog.getByRole('listitem').filter({ hasText: who })
  // One's own row: no × that would lock them out, but «Leave»; the others' rows keep theirs.
  await expect(row(MEMBER.username).getByRole('button', { name: `Quitar a ${MEMBER.username}` })).toHaveCount(0)
  await expect(row(MEMBER.username).getByRole('button', { name: 'Salir' })).toBeVisible()
  await expect(row(OTHER.username).getByRole('button', { name: `Quitar a ${OTHER.username}` })).toBeVisible()

  // A change, then Escape: asked first, and «Keep editing» keeps it.
  await dialog.getByRole('combobox', { name: `Nivel de ${OTHER.username}` }).selectOption('read')
  await a.keyboard.press('Escape')
  const prompt = dialog.getByRole('alertdialog')
  await expect(prompt).toContainText('Hay cambios sin guardar: si sigues, se perderán.')
  for (const theme of ['light', 'dark'] as const) {
    await a.emulateMedia({ colorScheme: theme })
    await dialog.screenshot({ path: `${E2E_DIR}/shots/members-unsaved-${theme}.png` })
  }
  await a.emulateMedia({ colorScheme: null })
  await prompt.getByRole('button', { name: 'Seguir editando' }).click()
  await expect(prompt).toHaveCount(0)
  await expect(dialog.getByRole('combobox', { name: `Nivel de ${OTHER.username}` })).toHaveValue('read')
  // Its own button asks too; «Discard changes» closes with nothing saved.
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await prompt.getByRole('button', { name: 'Descartar los cambios' }).click()
  await expect(dialog).toHaveCount(0)
  const level = async () => ((await call(a, 'get', `/api/permissions?folder=${q(space)}`)) as { own: { grants: Record<string, string> } }).own.grants[OTHER.username]
  expect(await level()).toBe('edit')
  // Again, with a press outside: «Save and close» saves it.
  await sectionMenu(a, name, 'Miembros…')
  await dialog.getByRole('combobox', { name: `Nivel de ${OTHER.username}` }).selectOption('read')
  await a.mouse.click(5, 5)
  await prompt.getByRole('button', { name: 'Guardar y cerrar' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await level()).toBe('read')

  // «Leave» on one's own row opens the usual dialog.
  await sectionMenu(a, name, 'Miembros…')
  await row(MEMBER.username).getByRole('button', { name: 'Salir' }).click()
  const leave = a.getByRole('alertdialog', { name: `¿Salir de «${name}»?` })
  await expect(leave).toBeVisible()
  await leave.getByRole('button', { name: 'Cancelar' }).click()
  await call(a, 'delete', `/api/spaces?path=${q(space)}&trash=true`)
})

test('the member moves a note of her own into the space: it stops being hers, the dialog says in words which links will be broken, and nothing is rewritten across spaces', async () => {
  const dir = `${personal(MEMBER)}/${m.aFolder()}`
  const moved = `${dir}/${m.aTitle()}.md`
  const target = `${dir}/${m.aTitle()}.md`
  const diary = `${personal(MEMBER)}/${m.aTitle()}.md`
  await note(a, target, `# ${baseName(target)}\n`)
  await note(a, moved, `# ${baseName(moved)}\n\n[[${baseName(target)}]]\n`)
  await note(a, diary, `# ${baseName(diary)}\n\n[[${baseName(moved)}]]\n`)
  await a.goto(`/?note=${q(moved)}`)
  await expect(a.locator('.cm-content')).toBeVisible()
  // The address names her space without its system folder, and the old one was replaced.
  await expect(a).toHaveURL(new RegExp(noteInUrl(moved)))
  expect(a.url()).not.toContain('people')
  await a.getByRole('button', { name: 'Más acciones' }).click()
  await a.getByRole('menuitem', { name: 'Renombrar o mover…' }).click()
  const dialog = a.getByRole('dialog')
  await dialog.getByRole('combobox', { name: 'Espacio' }).selectOption({ label: CASA })
  const warning = dialog.getByRole('group', { name: 'Cambia de espacio' })
  await expect(warning).toContainText(`Dejará de ser tuya: será de los miembros de ${CASA}.`)
  await expect(warning).toContainText(ADMIN.username)
  // The links it leaves broken, both ways (by where they are on disk: her space before the shared one), in plain
  // words: no Markdown, no path on disk.
  const broken = warning.getByRole('group', { name: '2 enlaces quedarán rotos' })
  await expect(broken.getByRole('listitem')).toHaveText([
    `En Mis notas / ${baseName(diary)}, el enlace a ${baseName(moved)} quedará roto (ahora está en ${CASA}).`,
    `En ${CASA} / ${baseName(moved)}, el enlace a ${baseName(target)} quedará roto (${baseName(target)} se queda en Mis notas).`,
  ])
  await expect(dialog).not.toContainText('[[')
  await expect(dialog).not.toContainText('people/')
  await expect(dialog).not.toContainText('spaces/')
  await a.screenshot({ path: `${process.env.SHOTS ?? '/tmp'}/move-across-spaces.png` })
  const submit = dialog.getByRole('button', { name: /^Mover/ })
  await expect(submit).toBeDisabled()
  await warning.getByRole('checkbox', { name: 'Entiendo que cambia quién puede verlo' }).check()
  await submit.click()
  const to = `${casa}/${baseName(moved)}.md`
  await expect(a.locator('.crumbs')).toContainText(`${CASA} / ${baseName(moved)}`, SLOW)
  expect(existsSync(`${NOTES}/${moved}`)).toBe(false)
  await expect(a).toHaveURL(new RegExp(noteInUrl(to)))
  expect(a.url()).not.toContain('spaces')
  // Nothing rewritten: its link by name stays, and so does her diary's; both are broken now.
  await expect.poll(() => disk(to)).toContain(`\n[[${baseName(target)}]]\n`)
  expect(disk(diary)).toContain(`\n[[${baseName(moved)}]]\n`)
  await expect.poll(async () => (await linkStatus(a, diary, `[[${baseName(moved)}]]`))?.status).toBe('missing')
  await expect.poll(async () => (await linkStatus(a, to, `[[${baseName(target)}]]`))?.status).toBe('missing')
})

test('a link to what someone can\'t read is broken for them, whether it exists or not; nothing offers to create it in someone else\'s space; and no link reaches another space', async () => {
  // The admin's own folder, shared with the other: a note linking to a note of the admin's they can't read, and to nothing.
  const dir = `${personal(ADMIN)}/${m.aFolder()}`
  const privateNote = `${personal(ADMIN)}/${m.aFolder()}/${m.aTitle()}.md`
  const nowhere = `${personal(ADMIN)}/${m.aFolder()}/${m.aTitle()}.md`
  const linking = `${dir}/${m.aTitle()}.md`
  await note(k, privateNote, `# ${baseName(privateNote)}\n`)
  const real = `[[${privateNote.replace(/\.md$/, '')}]]`
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
  // A link from one's own space to another space never resolves, even to a note one reads (the shared one above),
  // and offers nothing to create there.
  const probe = `${personal(OTHER)}/${m.aTitle()}.md`
  const hidden = `[[${personal(ADMIN)}/${m.aFolder()}/${m.aTitle()}]]`
  const readable = `[[${linking.replace(/\.md$/, '')}]]`
  await note(o, probe, `# ${baseName(probe)}\n\n${hidden}\n\n${real}\n\n${readable}\n`)
  await expect.poll(async () => (await linkStatus(o, probe, readable))?.status, SLOW).toBe('missing')
  expect((await linkStatus(o, probe, hidden))?.status).toBe('missing')
  expect((await linkStatus(o, probe, real))?.status).toBe('missing')
  await o.goto(`/?note=${q(probe)}`)
  await expect(o.locator('.cm-wikilink-badge')).toHaveCount(3)
  await expect(o.locator('.cm-content').getByRole('button', { name: 'crear', exact: true })).toHaveCount(0)
})

test('a rename that would take someone\'s link, in a note the renamer reads, to a note they can\'t see is refused as a name that isn\'t available (the preview doesn\'t check)', async () => {
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
  // The preview tells nothing: the refusal comes when renaming, as for a taken name.
  const rename = dialog.getByRole('button', { name: /^Renombrar/ })
  await expect(rename).toBeEnabled(SLOW)
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await rename.click()
  await expect(dialog.getByRole('alert')).toHaveText('Ese nombre no está disponible aquí.', SLOW)
  // A name that is simply taken says the same.
  await dialog.getByLabel('Nuevo nombre').fill(baseName(linking))
  await expect(dialog.getByRole('alert')).toHaveText('Ese nombre no está disponible aquí.', SLOW)
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  expect(disk(linking)).toContain(`[[${name}]]`)
})

test('a subfolder can\'t be closed, so it moves out: «Move to a new space» makes it a space of its own, which the others stop seeing', async () => {
  const name = m.aFolder()
  const dir = `${casa}/${name}`
  const inside = `${dir}/${m.aTitle()}.md`
  await folder(k, dir)
  await note(k, inside, `# ${baseName(inside)}\n`)
  await k.goto('/')
  const row = spaceTree(k, CASA).getByRole('row', { name, exact: true })
  // Its share dialog says why it can't be closed, and offers the way out.
  await row.click({ button: 'right' })
  await k.getByRole('menuitem', { name: 'Compartir…' }).click()
  const share = k.getByRole('dialog', { name: `Compartir «${name}»` })
  await expect(share.getByText('Una subcarpeta no se puede cerrar a quien ve la de arriba', { exact: false })).toBeVisible()
  await expect(share.getByRole('button', { name: 'Mover a Mis notas…' })).toBeVisible()
  await share.getByRole('button', { name: 'Mover a un espacio nuevo…' }).click()
  const dialog = k.getByRole('dialog').filter({ has: k.getByRole('heading', { name: `¿Mover «${name}» a un espacio nuevo?` }) })
  await expect(dialog.getByLabel('Nombre', { exact: true })).toHaveValue(name)
  // The usual confirmation: who stops seeing it.
  const warning = dialog.getByRole('group', { name: 'Cambia de espacio' })
  await expect(warning).toContainText(MEMBER.username, SLOW)
  const submit = dialog.getByRole('button', { name: 'Mover al espacio nuevo' })
  await expect(submit).toBeDisabled()
  await warning.getByRole('checkbox', { name: 'Entiendo que cambia quién puede verlo' }).check()
  await submit.click()
  // A space of its own, theirs to manage, with the note at its root.
  await expect(spaceTree(k, name)).toBeVisible(SLOW)
  await expect(spaceTree(k, name).getByRole('row', { name: baseName(inside), exact: true })).toBeVisible()
  await expect(spaceTree(k, CASA).getByRole('row', { name, exact: true })).toHaveCount(0)
  const root = await spaceRoot(k, name)
  expect(existsSync(`${NOTES}/${root}/${baseName(inside)}.md`)).toBe(true)
  // The member, who saw it through Casa, doesn't any more.
  await a.goto('/')
  await expect(spaceTree(a, CASA)).toBeVisible()
  await expect(spaceTree(a, CASA).getByRole('row', { name, exact: true })).toHaveCount(0)
  await expect(spaceTree(a, name)).toHaveCount(0)

  // From the folder's menu too; to one's own space, the move of always with «My notes» as its destination.
  const other = m.aFolder()
  await folder(k, `${casa}/${other}`)
  await k.reload()
  await spaceTree(k, CASA).getByRole('row', { name: other, exact: true }).click({ button: 'right' })
  await expect(k.getByRole('menuitem', { name: 'Mover a un espacio nuevo…' })).toBeVisible()
  await k.getByRole('menuitem', { name: 'Mover a Mis notas…' }).click()
  const move = k.getByRole('dialog').filter({ has: k.getByRole('heading', { name: new RegExp(literally(other)) }) })
  await expect(move.getByRole('combobox', { name: 'Espacio' })).toHaveValue(personal(ADMIN))
  await move.getByRole('button', { name: 'Cancelar' }).click()
})

test('sharing a folder of one\'s own space to edit says that whoever edits may work out names of notes linked from it', async () => {
  const dir = `${personal(MEMBER)}/${m.aFolder()}`
  await folder(a, dir)
  await a.goto('/')
  await spaceTree(a, 'Mis notas').getByRole('row', { name: baseName(dir), exact: true }).click({ button: 'right' })
  await a.getByRole('menuitem', { name: 'Compartir…' }).click()
  const dialog = a.getByRole('dialog', { name: `Compartir «${baseName(dir)}»` })
  const probes = dialog.getByText('Quien edita aquí puede averiguar cómo se llaman otras notas de tu espacio', { exact: false })
  await dialog.getByRole('combobox', { name: 'Persona o grupo' }).selectOption(OTHER.username)
  await dialog.getByRole('combobox', { name: 'Nivel', exact: true }).selectOption('comment')
  await dialog.getByRole('button', { name: 'Añadir' }).click()
  await expect(probes).toHaveCount(0)
  await dialog.getByRole('combobox', { name: `Nivel de ${OTHER.username}` }).selectOption('edit')
  await expect(probes).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
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

test('the admin deletes two people: one\'s space closes, the admin is reminded, and it becomes a shared space its members see; the other\'s goes to someone from the delete dialog itself, with the warning about links', async ({ browser }) => {
  // What they have before going.
  const g = await signIn(browser, GONE)
  const gNote = `${personal(GONE)}/${m.aFolder()}/${m.aTitle()}.md`
  await note(g, gNote, `# ${baseName(gNote)}\n`)
  const l = await signIn(browser, LEFT)
  const lNote = `${personal(LEFT)}/${m.aTitle()}.md`
  await note(l, lNote, `# ${baseName(lNote)}\n`)
  await g.context().close()
  await l.context().close()
  for (const u of [GONE, LEFT]) await call(k, 'post', `/api/admin/users/${await userId(k, u.username)}/disable`)
  await call(k, 'delete', `/api/admin/users/${await userId(k, GONE.username)}`)
  // Undecided, the admin is reminded, and goes from there to «Spaces».
  await k.goto('/?view=alerts')
  const reminder = k.locator('.alert-card', { hasText: GONE.username }).filter({ hasText: 'nadie los ve, tampoco tú' })
  await expect(reminder).toBeVisible(SLOW)
  await reminder.getByRole('button', { name: 'Ir a Espacios' }).click()
  await expect(k.getByRole('heading', { name: 'Espacios', level: 1 })).toBeVisible()
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

  await k.goto('/?view=alerts')
  await expect(k.getByRole('heading', { name: 'Avisos', level: 1 })).toBeVisible()
  await expect(k.locator('.alert-card', { hasText: GONE.username })).toHaveCount(0)

  // Transferred to the member right from the delete dialog: into her space, as a folder; it warns about broken links.
  await k.goto('/?view=users')
  await k.getByRole('row', { name: new RegExp(`^${literally(LEFT.username)}(?![\\p{L}\\p{N}._-])`, 'u') }).getByRole('button', { name: `Acciones para ${LEFT.username}` }).click()
  await k.getByRole('menuitem', { name: 'Borrar' }).click()
  dialog = k.getByRole('alertdialog', { name: `¿Borrar a ${LEFT.username}?` })
  await dialog.getByRole('radio', { name: 'Traspasarlo a alguien' }).check()
  await expect(dialog).toContainText('Algún enlace roto de sus notas puede empezar a llevar a una nota de quien lo recibe')
  await dialog.getByRole('combobox', { name: 'A quién' }).selectOption({ label: MEMBER.username })
  await expect(dialog).toContainText('Contiene 1 nota, 0 archivos.', SLOW)
  const go = dialog.getByRole('button', { name: 'Borrar y decidir su espacio' })
  await expect(go).toBeDisabled()
  await dialog.getByLabel('Tu contraseña').fill(ADMIN.password)
  await go.click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => existsSync(`${NOTES}/${personal(MEMBER)}/${LEFT.username}/${baseName(lNote)}.md`)).toBe(true)
  await k.goto('/?view=spaces')
  await expect(k.locator('.group-card', { hasText: `Espacio de ${LEFT.username}` })).toHaveCount(0)
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

test('a space\'s folder is its name: renaming it moves the open note\'s address, a taken name is refused by name, and an rc.1 or rc.2 address finds it', async () => {
  const before = m.aSpaceName()
  const after = m.aSpaceName()
  const created = await call(a, 'post', '/api/spaces', { name: before }, 201) as { space: { path: string } }
  expect(created.space.path).toBe(`spaces/${before}`)
  const inner = `${m.aFolder()}/${m.aTitle()}.md`
  await note(a, `spaces/${before}/${inner}`, `# ${baseName(inner)}\n\n${m.aSentence()}\n`)
  await a.goto(`/?note=${q(`${before}/${inner}`)}`)
  await expect(a.locator('.cm-content')).toBeVisible()
  await sectionMenu(a, before, 'Renombrar…')
  const dialog = a.getByRole('dialog', { name: `Renombrar «${before}»` })
  await expect(dialog.getByText('Todos en vihko ven los nombres de los espacios compartidos', { exact: false })).toBeVisible()
  await dialog.getByLabel('Nombre', { exact: true }).fill(after)
  await dialog.getByRole('button', { name: 'Renombrar', exact: true }).click()
  await expect(spaceTree(a, after)).toBeVisible()
  // The open note follows its folder: the address names the space by its new name.
  await expect(a).toHaveURL(new RegExp(noteInUrl(`spaces/${after}/${inner}`)))
  await expect(a.locator('.crumbs')).toContainText(`${after} / `)
  await expect.poll(() => existsSync(`${NOTES}/spaces/${after}/${inner}`)).toBe(true)
  expect(existsSync(`${NOTES}/spaces/${before}`)).toBe(false)

  // Another person, in no space of that name, is told it's taken, by its name.
  await o.getByRole('button', { name: 'Nuevo espacio' }).click()
  const fresh = o.getByRole('dialog', { name: 'Nuevo espacio compartido' })
  await fresh.getByLabel('Nombre', { exact: true }).fill(after.toLowerCase() === after ? after.toUpperCase() : after.toLowerCase())
  await fresh.getByRole('button', { name: 'Crear espacio' }).click()
  await expect(fresh.getByRole('alert')).toHaveText(`Ya hay un espacio llamado «${after}»: elige otro nombre.`)
  await fresh.getByRole('button', { name: 'Cancelar' }).click()

  // An address of the folder rc.1 or rc.2 would have made for it leads to the space it is now.
  const legacy = `${readablePart(after)}-${m.pick(['k3v9q2', '7k2q9x', 'qa23l6'])}`
  await a.goto(`/?note=${q(`${legacy}/${inner}`)}`)
  await expect(a.locator('.cm-content')).toBeVisible(SLOW)
  await expect(a).toHaveURL(new RegExp(noteInUrl(`spaces/${after}/${inner}`)))
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
