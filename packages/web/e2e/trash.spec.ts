// The trash screen (`?view=trash`, «Papelera» next to «Cambios recientes»),
// with two sessions: a shared space's manager and a member who edits it. The
// member deletes a note and restores it from the trash, but is never offered
// to delete it for good; the manager is, and empties the space's part of the
// trash, confirmed with their password; a note whose name was taken while it
// was in the trash comes back under another name; a deleted space is one
// entry that comes back whole; and the screen at 390 px, the empty one too.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { ADMIN, E2E_DIR, MEMBER, personal, specMother } from './env.ts'
import { dismissNotices, dismissNoticesOf, literally, newUser, signIn, spaceTree } from './helpers.ts'

const m = specMother(import.meta.url)
const SHOTS = `${E2E_DIR}/shots`
const SLOW = { timeout: 20_000 }
const q = encodeURIComponent
/** The manager is the servers' member, who makes the space; the member, someone new who edits it; and someone with an empty trash. */
const MANAGER = MEMBER
const EDITOR = m.aUser({ role: 'member' })
const FRESH = m.aUser({ role: 'member' })
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/, '')

async function call(page: Page, method: 'get' | 'post' | 'delete', url: string, data?: unknown, status = 200) {
  const r = await page.request[method](url, data === undefined ? {} : { data })
  expect(r.status(), `${method} ${url}: ${await r.text()}`).toBe(status)
  return r.json() as Promise<Record<string, unknown>>
}
const note = (page: Page, path: string) => call(page, 'post', '/api/note', { path, text: `# ${baseName(path)}\n\n${m.aParagraph()}\n` }, 201)
const trash = (page: Page, path: string) => call(page, 'delete', `/api/note?path=${q(path)}`)
/** The trash's line of an entry, by its name. */
const item = (page: Page, name: string) => page.locator('.trash-item').filter({ has: page.locator('.trash-name', { hasText: new RegExp(`^${literally(name)}$`, 'u') }) })

/** Opens the trash from the sidebar's link, as a person would. */
async function openTrash(page: Page) {
  await page.goto('/')
  await page.getByRole('link', { name: 'Papelera', exact: true }).click()
  await expect(page).toHaveURL(/[?&]view=trash/)
  await expect(page.getByRole('heading', { name: 'Papelera', level: 1 })).toBeVisible()
}

test.describe.configure({ mode: 'serial' })
let manager: Page
let editor: Page
let spaceName: string
let space: string

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true })
  const admin = await signIn(browser, ADMIN)
  for (const u of [EDITOR, FRESH]) await newUser(admin, u)
  await admin.context().close()
  manager = await signIn(browser, MANAGER)
  await dismissNotices(manager.request)
  spaceName = m.aSpaceName()
  space = ((await call(manager, 'post', '/api/spaces', { name: spaceName, members: { [EDITOR.username]: 'edit' } }, 201)) as { space: { path: string } }).space.path
  editor = await signIn(browser, EDITOR)
  await dismissNotices(editor.request)
})

test.afterAll(async () => {
  // What this spec leaves in the trash and in the notices: not for other specs.
  await call(manager, 'post', '/api/trash/empty', { confirm: MANAGER.password }).catch(() => {})
  await dismissNoticesOf(MANAGER, EDITOR)
})

test('a member deletes a note, finds it in the trash with where it was, who and how much, and restores it; never «Borrar para siempre»', async () => {
  const path = `${space}/${m.aTitle()}.md`
  const name = baseName(path)
  await note(manager, path)
  await trash(editor, path)

  await openTrash(editor)
  const line = item(editor, name)
  await expect(line).toBeVisible()
  await expect(line.locator('.trash-where')).toHaveText(spaceName)
  await expect(line.locator('.trash-meta')).toContainText(`Lo borró ${EDITOR.username}`)
  // A size in words: «51 bytes», «1,2 KB», never «51 byte».
  await expect(line.locator('.trash-meta')).toContainText(/\d+ bytes|\d+(,\d)? KB/)
  await expect(line.getByRole('button', { name: `Borrar «${name}» para siempre` })).toHaveCount(0)
  await expect(editor.getByRole('button', { name: /^Vaciar/ })).toHaveCount(0)
  await expect(editor.getByText('Nada sale de la papelera por sí solo.')).toBeVisible()

  await line.getByRole('button', { name: `Restaurar «${name}»` }).click()
  await expect(editor.getByRole('status').filter({ hasText: `«${name}» está de vuelta.` })).toBeVisible()
  await expect(line).toHaveCount(0)
  await editor.getByRole('button', { name: 'Abrir', exact: true }).click()
  await expect(editor.locator('.cm-content')).toContainText(name)
  expect(await call(editor, 'get', `/api/note?path=${q(path)}`)).toMatchObject({ path })

  // Deleted again: the member may only restore it; its manager may delete it for good.
  await trash(editor, path)
  await openTrash(editor)
  await expect(item(editor, name).getByRole('button', { name: `Restaurar «${name}»` })).toBeVisible()
  await expect(item(editor, name).getByRole('button', { name: `Borrar «${name}» para siempre` })).toHaveCount(0)
  await openTrash(manager)
  await expect(item(manager, name).getByRole('button', { name: `Borrar «${name}» para siempre` })).toBeVisible()
  await manager.screenshot({ path: `${SHOTS}/trash-desktop-light.png`, animations: 'disabled' })
  await manager.emulateMedia({ colorScheme: 'dark' })
  await manager.screenshot({ path: `${SHOTS}/trash-desktop-dark.png`, animations: 'disabled' })
  await manager.emulateMedia({ colorScheme: 'light' })
})

test('the manager deletes one entry for good and empties the space\'s part of the trash, confirming with their password; what is theirs elsewhere stays', async () => {
  const one = `${space}/${m.aTitle()}.md`
  const two = `${space}/${m.aTitle()}.md`
  const mine = `${personal(MANAGER)}/${m.aTitle()}.md`
  for (const p of [one, two]) { await note(manager, p); await trash(editor, p) }
  await note(manager, mine)
  await trash(manager, mine)

  await openTrash(manager)
  // One for good: asked, with the password (no confirmation lasts yet in this browser).
  await item(manager, baseName(one)).getByRole('button', { name: `Borrar «${baseName(one)}» para siempre` }).click()
  const ask = manager.getByRole('alertdialog', { name: `¿Borrar «${baseName(one)}» para siempre?` })
  await expect(ask).toContainText('No se puede deshacer.')
  await expect(ask.getByRole('button', { name: 'Borrar para siempre' })).toBeDisabled()
  await ask.getByLabel('Tu contraseña').fill(MANAGER.password)
  await ask.screenshot({ path: `${SHOTS}/trash-confirm.png`, animations: 'disabled' })
  await ask.getByRole('button', { name: 'Borrar para siempre' }).click()
  await expect(manager.getByRole('status').filter({ hasText: `«${baseName(one)}» se ha borrado para siempre.` })).toBeVisible()
  await expect(item(manager, baseName(one))).toHaveCount(0)

  // The space's part: filtered by it, then emptied (the confirmation lasts now: nothing more is asked).
  await manager.getByLabel('Espacio', { exact: true }).selectOption({ label: spaceName })
  await expect(item(manager, baseName(mine))).toHaveCount(0)
  await manager.getByRole('button', { name: `Vaciar lo de ${spaceName}…` }).click()
  const empty = manager.getByRole('alertdialog', { name: `¿Vaciar la papelera de ${spaceName}?` })
  await expect(empty).toContainText(/Se borran? para siempre/)
  await expect(empty.getByLabel('Tu contraseña')).toHaveCount(0)
  await empty.getByRole('button', { name: 'Vaciar', exact: true }).click()
  await expect(manager.getByRole('status').filter({ hasText: 'Papelera vaciada' })).toBeVisible()
  await expect(item(manager, baseName(two))).toHaveCount(0)
  // Nothing of that space left: every space again, with what is theirs elsewhere still there.
  await expect(item(manager, baseName(mine))).toBeVisible()
  // The member sees none of it any more.
  await openTrash(editor)
  for (const p of [one, two]) await expect(item(editor, baseName(p))).toHaveCount(0)
  await call(manager, 'post', '/api/trash/empty', { space: personal(MANAGER) })
})

test('a note whose name was taken while in the trash comes back under another name, never over the other note', async () => {
  const path = `${space}/${m.aTitle()}.md`
  const name = baseName(path)
  await note(manager, path)
  await trash(editor, path)
  // Someone writes another note with its name meanwhile.
  const other = m.aSentence()
  await call(manager, 'post', '/api/note', { path, text: `${other}\n` }, 201)

  await openTrash(editor)
  await item(editor, name).getByRole('button', { name: `Restaurar «${name}»` }).click()
  const dialog = editor.getByRole('dialog', { name: `Ya hay una nota «${name}» ahí` })
  await expect(dialog.getByLabel('Nuevo nombre')).toHaveValue(`${name} (restaurada)`)
  await dialog.getByRole('button', { name: 'Restaurar', exact: true }).click()
  await expect(editor.getByRole('status').filter({ hasText: `«${name} (restaurada)» está de vuelta.` })).toBeVisible()
  expect(await call(editor, 'get', `/api/note?path=${q(path)}`)).toMatchObject({ text: expect.stringContaining(other) })
  await call(editor, 'get', `/api/note?path=${q(`${space}/${name} (restaurada).md`)}`)

  // Or somewhere else: a folder of the space that doesn't exist yet.
  const again = `${space}/${m.aTitle()}.md`
  await note(manager, again)
  await trash(editor, again)
  await call(manager, 'post', '/api/note', { path: again, text: `${m.aSentence()}\n` }, 201)
  const folder = m.aFolder()
  await openTrash(editor)
  await item(editor, baseName(again)).getByRole('button', { name: `Restaurar «${baseName(again)}»` }).click()
  const there = editor.getByRole('dialog', { name: `Ya hay una nota «${baseName(again)}» ahí` })
  await there.getByLabel('Nuevo nombre').fill(baseName(again))
  await there.getByLabel('Carpeta').fill(folder)
  await there.getByRole('button', { name: 'Restaurar', exact: true }).click()
  await expect(editor.getByRole('status').filter({ hasText: `«${baseName(again)}» está de vuelta.` })).toBeVisible()
  await call(editor, 'get', `/api/note?path=${q(`${space}/${folder}/${baseName(again)}.md`)}`)
})

test('a deleted space is one entry in its manager\'s trash, and comes back whole from it; its member doesn\'t see it', async () => {
  const name = m.aSpaceName()
  const root = ((await call(manager, 'post', '/api/spaces', { name, members: { [EDITOR.username]: 'edit' } }, 201)) as { space: { path: string } }).space.path
  const inside = [`${root}/${m.aTitle()}.md`, `${root}/${m.aTitle()}.md`]
  for (const p of inside) await note(manager, p)
  await call(manager, 'delete', `/api/spaces?path=${q(root)}&trash=true`)

  await openTrash(manager)
  const line = item(manager, name)
  await expect(line.locator('.trash-where')).toHaveText('Espacio compartido entero')
  await expect(line.locator('.trash-meta')).toContainText('2 elementos')
  for (const p of inside) await expect(item(manager, baseName(p))).toHaveCount(0)
  await openTrash(editor)
  await expect(item(editor, name)).toHaveCount(0)

  await line.getByRole('button', { name: `Restaurar «${name}»` }).click()
  await expect(manager.getByRole('status').filter({ hasText: `${name} restaurado.` })).toBeVisible()
  await expect(line).toHaveCount(0)
  await expect(spaceTree(manager, name)).toBeVisible(SLOW)
  for (const p of inside) await call(editor, 'get', `/api/note?path=${q(p)}`)
  await call(manager, 'delete', `/api/spaces?path=${q(root)}&trash=true`)
})

test('at 390 px: the list, its actions and the empty trash fit the phone, with nothing scrolling sideways', async ({ browser }) => {
  const path = `${space}/${m.aTitle()} ${m.aTitle()}.md`
  await note(manager, path)
  await trash(editor, path)
  const phone = async (user: { username: string; password: string }, dark = false) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'es-ES', colorScheme: dark ? 'dark' : 'light' })
    expect((await ctx.request.post('/api/auth/login', { data: { username: user.username, password: user.password } })).status()).toBe(200)
    await dismissNotices(ctx.request)
    const page = await ctx.newPage()
    await page.goto('/?view=trash')
    await expect(page.getByRole('heading', { name: 'Papelera', level: 1 })).toBeVisible()
    return page
  }
  const wide = (page: Page) => expect.poll(() => page.evaluate(() => {
    const el = document.querySelector('.trash-page')!
    return Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, el.scrollWidth - el.clientWidth)
  })).toBe(0)

  const page = await phone(MANAGER)
  const line = item(page, baseName(path))
  await expect(line).toBeVisible()
  const restore = await line.getByRole('button', { name: `Restaurar «${baseName(path)}»` }).boundingBox()
  expect(restore!.height).toBeGreaterThanOrEqual(44)
  expect(restore!.x + restore!.width).toBeLessThanOrEqual(390)
  await wide(page)
  await page.screenshot({ path: `${SHOTS}/trash-mobile.png`, animations: 'disabled' })
  // From the drawer, too.
  await page.goto('/')
  await page.getByRole('button', { name: 'Abrir carpetas' }).tap()
  await page.getByRole('dialog', { name: 'Carpetas' }).getByRole('link', { name: 'Papelera', exact: true }).tap()
  await expect(page.getByRole('heading', { name: 'Papelera', level: 1 })).toBeVisible()
  await page.context().close()

  const empty = await phone(FRESH, true)
  await expect(empty.getByText('La papelera está vacía.')).toBeVisible()
  await wide(empty)
  await empty.screenshot({ path: `${SHOTS}/trash-empty-mobile-dark.png`, animations: 'disabled' })
  await empty.context().close()
})
