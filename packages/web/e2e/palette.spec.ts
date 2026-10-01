// "Search or create" palette: searching the index, recent notes, creating a
// note in the current folder, commands, and the mobile version.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { ADMIN, MEMBER, NOTES, SPACE, SPACE_NAME, freshFolder, inVault, personal, specMother } from './env.ts'
import { literally, signIn, spaceTree, usePermissions } from './helpers.ts'

const m = specMother(import.meta.url)

// The notes it searches and the folder it creates in (hogar, where Red is) are testdata/vault's,
// in the vault's space (SPACE).
const RED = inVault('hogar/Red.md')
test.describe.configure({ mode: 'serial' })
let k: Page

test.beforeAll(async ({ browser }) => {
  k = await signIn(browser, ADMIN)
})

const palette = () => k.getByRole('dialog', { name: 'Buscar o crear' })
const field = () => palette().getByRole('textbox')

/** The heading a note was created with (after the frontmatter with its uid). */
const h1 = (path: string) => readFileSync(`${NOTES}/${path}`, 'utf8').split('\n').find((l) => l.startsWith('# '))

/**
 * The other specs share the notes folder: a note made in a new folder goes to
 * the trash, and the folder with it. Then back to hogar, where the next tests create.
 */
async function removeNote(folder: string, name: string) {
  await k.goto(`/?note=${encodeURIComponent(RED)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  expect((await k.request.delete(`/api/note?path=${encodeURIComponent(`${folder}/${name}.md`)}`)).status()).toBe(200)
  expect((await k.request.delete(`/api/folder?path=${encodeURIComponent(folder)}`)).status()).toBe(200)
}

test('⌘K searches ignoring accents, highlights, and opens the note with ↵', async () => {
  await k.keyboard.press('Control+k')
  await expect(field()).toBeFocused()
  await field().fill('cafe')
  const first = palette().getByRole('option').first()
  await expect(first).toContainText(/Cafe\u0301|Café/)
  await expect(first).toContainText('recetas /')
  // Its space beside it: it isn't the admin's own.
  await expect(first.locator('.palette-space')).toHaveText(SPACE_NAME)
  await expect(first.locator('mark').first()).toBeVisible()
  await k.keyboard.press('Enter')
  await expect(palette()).toHaveCount(0)
  // The test file is in NFD on purpose: it's compared normalized.
  await expect.poll(async () => (await k.locator('.crumbs b').innerText()).normalize('NFC')).toBe('Café')
  await expect(k.locator('.cm-content')).toBeVisible()
})

test('with an empty query shows recents; esc closes', async () => {
  await k.goto(`/?note=${encodeURIComponent(RED)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  await k.getByRole('button', { name: 'Buscar o crear…' }).click()
  await expect(palette().getByRole('group', { name: 'Recientes' }).getByRole('option', { name: /Cafe\u0301|Café/ })).toBeVisible()
  await k.keyboard.press('Escape')
  await expect(palette()).toHaveCount(0)
})

test('creates the note in the current folder, refreshes the tree, and opens it', async () => {
  await k.keyboard.press('Control+k')
  const name = m.aTitle()
  await field().fill(name)
  const create = palette().getByRole('option', { name: `Crear «${name}» en ${SPACE_NAME} / hogar` })
  await expect(create).toBeVisible()
  await expect(create).toContainText('carpeta actual')
  await create.click()
  await expect(k.locator('.crumbs b')).toHaveText(name)
  await expect(k.locator('.cm-h1')).toHaveText(name)
  expect(h1(inVault(`hogar/${name}.md`))).toBe(`# ${name}`)
  await spaceTree(k, SPACE_NAME).getByRole('row', { name: 'hogar' }).click()
  await k.keyboard.press('ArrowRight')
  await expect(spaceTree(k, SPACE_NAME).getByRole('row', { name, exact: true })).toBeVisible()
})

test('a «/» in the name is a folder: created under the current one (missing folders too), titled with the name alone', async () => {
  await k.goto(`/?note=${encodeURIComponent(RED)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  await k.keyboard.press('Control+k')
  const [folder, name] = [m.aFolder(), m.aTitle()]
  await field().fill(`${folder}/${name}`)
  const create = palette().getByRole('option', { name: `Crear «${name}» en ${SPACE_NAME} / hogar / ${folder}` })
  await expect(create).toBeVisible()
  await expect(create).not.toContainText('carpeta actual')
  await create.click()
  await expect(k.locator('.crumbs b')).toHaveText(name)
  await expect(k.locator('.cm-h1')).toHaveText(name)
  expect(h1(inVault(`hogar/${folder}/${name}.md`))).toBe(`# ${name}`)
  await expect(spaceTree(k, SPACE_NAME).getByRole('row', { name: folder, exact: true })).toBeVisible()
  await removeNote(inVault(`hogar/${folder}`), name)
})

test('a leading «/» creates it from the root of the current space (D-056: never the notes root)', async () => {
  await k.keyboard.press('Control+k')
  const [folder, name] = [freshFolder(() => m.aFolder()), m.aTitle()]
  await field().fill(`/${folder}/${name}`)
  await palette().getByRole('option', { name: `Crear «${name}» en ${SPACE_NAME} / ${folder}` }).click()
  await expect(k.locator('.crumbs b')).toHaveText(name)
  expect(h1(inVault(`${folder}/${name}.md`))).toBe(`# ${name}`)
  await removeNote(inVault(folder), name)
})

/**
 * A folder of the admin's own space shared with the member to read only
 * (D-056: in the vault's space she edits, and sharing only adds), with a note
 * in it; the member's grant is waited for.
 */
async function readOnlyFolder() {
  const folder = `${personal(ADMIN)}/${freshFolder(() => m.aFolder(), { in: personal(ADMIN) })}`
  const note = `${folder}/${m.aTitle()}.md`
  expect((await k.request.post('/api/note', { data: { path: note, text: `# ${m.aHeading()}\n` } })).status()).toBe(201)
  await usePermissions({ rules: { [folder]: { [MEMBER.username]: 'read' } } })
  // Rules other than the space's: waited for here (usePermissions waits for the space's).
  await expect.poll(async () => {
    const r = await k.request.get(`/api/permissions?folder=${encodeURIComponent(folder)}`)
    return r.ok() ? ((await r.json()) as { own: { grants: Record<string, string> | null } }).own.grants : r.status()
  }, { timeout: 15_000 }).toEqual({ [MEMBER.username]: 'read' })
  return { folder, note }
}

/** Takes the folder away again: its rule, then the folder and its notes. */
async function dropFolder(folder: string, note: string) {
  await usePermissions()
  await k.request.delete(`/api/note?path=${encodeURIComponent(note)}`)
  await k.request.delete(`/api/folder?path=${encodeURIComponent(folder)}`)
}

test('a folder where one can only read: the note is not created, and the palette says why', async ({ browser }) => {
  const { folder, note } = await readOnlyFolder()
  const name = m.aTitle()
  const member = await signIn(browser, MEMBER, note)
  try {
    await member.keyboard.press('Control+k')
    const dialog = member.getByRole('dialog', { name: 'Buscar o crear' })
    await dialog.getByRole('textbox').fill(name)
    // The folder as the member sees it: the owner's space, then the folder.
    await dialog.getByRole('option', { name: `Crear «${name}» en ${ADMIN.username} / ${folder.slice(folder.lastIndexOf('/') + 1)}` }).click()
    await expect(dialog.getByRole('alert')).toHaveText('No tienes permiso para hacer esto.')
    expect(existsSync(`${NOTES}/${folder}/${name}.md`)).toBe(false)
  } finally {
    await member.context().close()
    await dropFolder(folder, note)
  }
})

test('creating one that already exists shows the translated error', async () => {
  await k.keyboard.press('Control+k')
  await field().fill('Red')
  await palette().getByRole('option', { name: /^Crear «Red»/ }).click()
  await expect(palette().getByRole('alert')).toHaveText('Ese nombre no está disponible aquí.')
  await k.keyboard.press('Escape')
})

test('the "+" button asks for the name and creates in the current folder', async () => {
  await k.getByRole('button', { name: 'Nueva nota' }).click()
  const dialog = k.getByRole('dialog', { name: 'Nueva nota' })
  const title = m.aTitle()
  await dialog.getByRole('textbox').fill(title)
  await k.keyboard.press('Enter')
  await expect(k.locator('.crumbs b')).toHaveText(title)
  expect(existsSync(`${NOTES}/${inVault('hogar')}/${title}.md`)).toBe(true)
})

test('command mode with ">": dark theme and new note', async () => {
  await k.keyboard.press('Control+k')
  await field().fill('>tema')
  await expect(palette().getByRole('option')).toHaveCount(1)
  await k.keyboard.press('Enter')
  await expect(k.locator('html')).toHaveAttribute('data-theme', 'dark')
  await k.keyboard.press('Control+k')
  await field().fill('> nueva nota')
  await k.keyboard.press('Enter')
  await expect(k.getByRole('dialog', { name: 'Nueva nota' })).toBeVisible()
  await k.keyboard.press('Escape')
  await k.keyboard.press('Control+k')
  await field().fill('>tema claro')
  await k.keyboard.press('Enter')
  await expect(k.locator('html')).toHaveAttribute('data-theme', 'light')
})

test('command «new folder»: in the open note\'s folder, or the root with none; the tree shows it', async () => {
  // A name no folder in hogar has yet.
  let name = m.aFolder()
  while (existsSync(`${NOTES}/${inVault('hogar')}/${name}`)) name = m.aFolder()
  await k.goto(`/?note=${encodeURIComponent(RED)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  await k.keyboard.press('Control+k')
  await field().fill('>nueva carpeta')
  await expect(palette().getByRole('option')).toHaveCount(1)
  await k.keyboard.press('Enter')
  await expect(palette()).toHaveCount(0)
  const dialog = k.getByRole('dialog', { name: 'Nueva carpeta' })
  await expect(dialog.getByLabel('Espacio')).toHaveValue(SPACE)
  await expect(dialog.getByLabel('Carpeta')).toHaveValue('hogar')
  await dialog.getByLabel('Nombre').fill(name)
  await dialog.getByRole('button', { name: 'Crear carpeta' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(spaceTree(k, SPACE_NAME).getByRole('row', { name, exact: true })).toBeVisible()
  expect(existsSync(`${NOTES}/${inVault('hogar')}/${name}`)).toBe(true)
  expect((await k.request.delete(`/api/folder?path=${encodeURIComponent(inVault(`hogar/${name}`))}`)).status()).toBe(200)

  // With no note open, at the root of one's own space.
  await k.goto('/')
  await expect(k.getByRole('treegrid').first()).toBeVisible()
  await k.keyboard.press('Control+k')
  await field().fill('>nueva carpeta')
  await k.keyboard.press('Enter')
  await expect(dialog.getByLabel('Espacio')).toHaveValue(personal(ADMIN))
  await expect(dialog.getByLabel('Carpeta')).toHaveValue('')
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await expect(dialog).toHaveCount(0)
})

test('command «new folder» from a folder one only reads: it creates in one\'s own space (D-056: there is always somewhere to create)', async ({ browser }) => {
  const { folder, note } = await readOnlyFolder()
  const member = await signIn(browser, MEMBER)
  try {
    // Where she may create is known once her folders' levels have arrived.
    const levels = member.waitForResponse((r) => new URL(r.url()).pathname === '/api/permissions/folders')
    await member.goto(`/?note=${encodeURIComponent(note)}`)
    await levels
    await expect(member.locator('.cm-content')).toBeVisible()
    await member.keyboard.press('Control+k')
    const dialog = member.getByRole('dialog', { name: 'Buscar o crear' })
    await dialog.getByRole('textbox').fill('>nueva')
    await expect(dialog.getByRole('option', { name: 'nueva nota' })).toBeVisible()
    await dialog.getByRole('option', { name: 'nueva carpeta' }).click()
    const create = member.getByRole('dialog', { name: 'Nueva carpeta' })
    await expect(create.getByLabel('Espacio')).toHaveValue(personal(MEMBER))
    await expect(create.getByLabel('Carpeta')).toHaveValue('')
  } finally {
    await member.context().close()
    await dropFolder(folder, note)
  }
})

test('mobile: the palette fills the screen and opens from the header', async ({ browser }) => {
  const phone = await signIn(browser, MEMBER, RED)
  await phone.setViewportSize({ width: 390, height: 844 })
  await phone.getByRole('button', { name: 'Buscar', exact: true }).click()
  const dialog = phone.getByRole('dialog', { name: 'Buscar o crear' })
  await dialog.getByRole('textbox').fill('proxy red')
  await expect(dialog.getByRole('option').first()).toContainText('Proxy')
  const box = await phone.locator('.palette').boundingBox()
  expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 844 })
  const create = dialog.getByRole('option', { name: new RegExp(`^Crear «proxy red» en ${literally(SPACE_NAME)} / hogar`) })
  expect((await create.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await expect(dialog).toHaveCount(0)
})
