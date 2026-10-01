// Purging and paths typed by people (rc.2), in a real browser: the admin
// types a note as they see it («Mis notas / carpeta / nota») in other
// capitals and purges it, with no path of the disk asked or shown; two notes
// that differ only in capitals are offered to choose from; a note deleted
// earlier is purged from its «deleted» line in Recent changes, and one just
// deleted from the notice that offers to restore it; and a folder typed in
// other capitals, where a note is moved, is the folder that is there.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADMIN, E2E_DIR, MEMBER, NOTES, freshFolder, personal, specMother } from './env.ts'
import { signIn } from './helpers.ts'

const m = specMother(import.meta.url)
const SHOTS = `${E2E_DIR}/shots`
const MINE = personal(ADMIN)
/** A folder of the admin's own space, this spec's, and what goes in it. */
const DIR_NAME = freshFolder(() => m.aFolder(), { in: MINE })
const DIR = `${MINE}/${DIR_NAME}`
const TYPED = `${DIR}/${m.aTitle()}.md`
const TWIN = m.aTitle().toLowerCase()
const TWINS = [`${DIR}/${TWIN}.md`, `${DIR}/${TWIN.toUpperCase()}.md`]
const DELETED = `${DIR}/${m.aTitle()}.md`
const TRASHED = `${DIR}/${m.aTitle()}.md`
const SUB_NAME = m.aFolder()
const SUB = `${DIR}/${SUB_NAME}`
const MOVING = `${DIR}/${m.aTitle()}.md`
/** A note's name: its file's, without `.md`. */
const title = (path: string) => path.slice(path.lastIndexOf('/') + 1, -3)
/** Every letter's case flipped: someone who doesn't remember the capitals. */
const flip = (s: string) => [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('')
/** How the admin sees a path of their own space. */
const shown = (path: string) => ['Mis notas', ...path.slice(MINE.length + 1).replace(/\.md$/, '').split('/')].join(' / ')

test.describe.configure({ mode: 'serial', timeout: 120_000 })

let admin: Page

const versions = async (path: string) => ((await (await admin.request.get(`/api/history/versions?path=${encodeURIComponent(path)}`)).json()).versions ?? []).length as number

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true })
  admin = await signIn(browser, ADMIN)
  for (const path of [TYPED, DELETED, TRASHED, MOVING, `${SUB}/${m.aTitle()}.md`]) {
    expect((await admin.request.post('/api/note', { data: { path, text: `# ${m.aHeading()}\n\n${m.aSentence()}\n` } })).status()).toBe(201)
  }
  // Two notes whose names differ only in capitals: only from the disk (vihko never makes them).
  for (const path of TWINS) writeFileSync(join(NOTES, path), `# ${m.aHeading()}\n\n${m.aSentence()}\n`)
  await admin.request.post('/api/admin/rescan', { data: {} })
  // Each note's version reaches the history once the typing calms down.
  for (const path of [TYPED, DELETED, TRASHED, ...TWINS]) await expect.poll(() => versions(path), { timeout: 30_000 }).toBeGreaterThan(0)
})

test.afterAll(async () => {
  await admin.request.delete(`/api/folder?path=${encodeURIComponent(DIR)}`)
  await admin.context().close()
})

async function purgeForm() {
  await admin.goto('/?view=changes')
  await expect(admin.getByRole('heading', { level: 1 })).toHaveText('Cambios recientes')
  await admin.getByRole('button', { name: 'Purgar del historial…' }).click()
  return admin.getByRole('dialog', { name: 'Purgar del historial' })
}

/** The confirmation: what goes; nothing to confirm with (the admin reads it); then it's purged. */
async function confirmPurge(path: string, shot?: string) {
  const dialog = admin.getByRole('alertdialog')
  await expect(dialog.getByRole('heading')).toHaveText(`¿Purgar el historial de ${shown(path)}?`)
  const go = dialog.getByRole('button', { name: 'Purgar el historial' })
  await expect(go).toBeEnabled()
  await expect(dialog.getByLabel('Tu contraseña')).toHaveCount(0)
  await expect(dialog).not.toContainText('people/')
  if (shot) await admin.screenshot({ path: `${SHOTS}/${shot}.png`, animations: 'disabled' })
  await go.click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(() => versions(path), { timeout: 30_000 }).toBe(0)
}

test('the admin types a note as they see it, in other capitals: it is found, and purged', async () => {
  const form = await purgeForm()
  // What the history holds that they read is offered, never a path of the disk.
  await expect(form).not.toContainText('people/')
  await form.getByLabel('Ruta (nota o carpeta)').fill(`mis notas/ ${flip(DIR_NAME)} /${flip(title(TYPED))}`)
  await admin.screenshot({ path: `${SHOTS}/purge-form-light.png`, animations: 'disabled' })
  await form.getByRole('button', { name: 'Purgar…' }).click()
  await confirmPurge(TYPED, 'purge-confirm-light')
  await expect(admin.locator('.changes-page .alerts-done')).toContainText(`Historial de ${shown(TYPED)} purgado`)
})

test('two notes that differ only in capitals: both offered, as the admin sees them; the one chosen is purged', async () => {
  const form = await purgeForm()
  await form.getByLabel('Ruta (nota o carpeta)').fill(`Mis notas / ${DIR_NAME} / ${TWIN}`)
  await form.getByRole('button', { name: 'Purgar…' }).click()
  const which = form.getByRole('group', { name: 'Hay varias que solo se distinguen por las mayúsculas. ¿Cuál?' })
  await expect(which.getByRole('button')).toHaveText(TWINS.map((p) => `${shown(p)} nota`).sort())
  await admin.screenshot({ path: `${SHOTS}/purge-several-light.png`, animations: 'disabled' })
  await which.getByRole('button', { name: `${shown(TWINS[1]!)} nota`, exact: true }).click()
  await confirmPurge(TWINS[1]!)
  expect(await versions(TWINS[0]!)).toBeGreaterThan(0)
})

test('nothing with history there: said plainly, without asking for anything', async () => {
  const form = await purgeForm()
  await form.getByLabel('Ruta (nota o carpeta)').fill(`Mis notas / ${DIR_NAME} / ${m.aTitle()}`)
  await form.getByRole('button', { name: 'Purgar…' }).click()
  await expect(form.getByRole('alert')).toContainText('No hay nada en el historial en Mis notas')
  await expect(admin.getByRole('alertdialog')).toHaveCount(0)
  await form.getByRole('button', { name: 'Cancelar' }).click()
})

test('a note deleted earlier: purged from its «deleted» line in Recent changes', async () => {
  expect((await admin.request.delete(`/api/note?path=${encodeURIComponent(DELETED)}`)).ok()).toBe(true)
  const deletedLine = async () => {
    const { changes } = await (await admin.request.get('/api/history/changes')).json() as { changes: { files: { path: string; change: string }[] }[] }
    return changes.some((c) => c.files.some((f) => f.path === DELETED && f.change === 'deleted'))
  }
  await expect.poll(deletedLine, { timeout: 30_000 }).toBe(true)
  await admin.goto('/?view=changes')
  const purge = admin.getByRole('button', { name: `Purgar ${shown(DELETED)} del historial…` })
  await expect(purge).toBeVisible()
  await admin.screenshot({ path: `${SHOTS}/purge-changes-row-light.png`, animations: 'disabled' })
  await purge.click()
  await confirmPurge(DELETED)
  await expect(admin.locator('.changes-page .alerts-done')).toContainText('purgado')
})

test('a note just deleted: purged from the notice that offers to restore it', async () => {
  await admin.goto(`/?note=${encodeURIComponent(TRASHED)}`)
  await expect(admin.locator('.cm-content')).toBeVisible()
  await admin.getByRole('button', { name: 'Más acciones' }).click()
  await admin.getByRole('menuitem', { name: 'Mover a la papelera' }).click()
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Mover a la papelera' }).click()
  const toast = admin.locator('.toast')
  await expect(toast).toContainText(`«${title(TRASHED)}» está en la papelera.`)
  await toast.getByRole('button', { name: 'Purgar del historial…' }).click()
  await confirmPurge(TRASHED)
  await expect(toast).toContainText(`Historial de ${shown(TRASHED)} purgado`)
  await admin.screenshot({ path: `${SHOTS}/purge-trash-light.png`, animations: 'disabled' })
  await expect(toast.getByRole('button', { name: 'Restaurar' })).toBeVisible()
})

test('a member purges, from the trash notice, a note two folders down in their own space: `manage` comes from the space above', async ({ browser }) => {
  const member = await signIn(browser, MEMBER)
  try {
    const note = `${personal(MEMBER)}/${m.aFolder()}/${m.aFolder()}/${m.aTitle()}.md`
    expect((await member.request.post('/api/note', { data: { path: note, text: `# ${m.aHeading()}\n\n${m.aSentence()}\n` } })).status()).toBe(201)
    const theirVersions = async () => ((await (await member.request.get(`/api/history/versions?path=${encodeURIComponent(note)}`)).json()).versions ?? []).length as number
    await expect.poll(theirVersions, { timeout: 30_000 }).toBeGreaterThan(0)
    await member.goto(`/?note=${encodeURIComponent(note)}`)
    await expect(member.locator('.cm-content')).toBeVisible()
    await member.getByRole('button', { name: 'Más acciones' }).click()
    await member.getByRole('menuitem', { name: 'Mover a la papelera' }).click()
    await member.getByRole('alertdialog').getByRole('button', { name: 'Mover a la papelera' }).click()
    const toast = member.locator('.toast')
    await expect(toast).toContainText(`«${title(note)}» está en la papelera.`)
    await toast.getByRole('button', { name: 'Purgar del historial…' }).click()
    const dialog = member.getByRole('alertdialog')
    await dialog.getByRole('button', { name: 'Purgar el historial' }).click()
    await expect(dialog).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(theirVersions, { timeout: 30_000 }).toBe(0)
  } finally {
    await member.context().close()
  }
})

test('moving a note to a folder typed in other capitals: into the folder that is there, not a new one', async () => {
  await admin.goto(`/?note=${encodeURIComponent(MOVING)}`)
  await expect(admin.locator('.cm-content')).toBeVisible()
  await admin.getByRole('button', { name: 'Más acciones' }).click()
  await admin.getByRole('menuitem', { name: 'Renombrar o mover…' }).click()
  const dialog = admin.getByRole('dialog')
  await dialog.getByLabel('Carpeta').fill(`${flip(DIR_NAME)} / ${flip(SUB_NAME)}`)
  await admin.screenshot({ path: `${SHOTS}/purge-move-case-light.png`, animations: 'disabled' })
  await dialog.getByRole('button', { name: /^Mover/ }).click()
  const to = `${SUB}/${title(MOVING)}.md`
  await expect.poll(async () => (await admin.request.get(`/api/note?path=${encodeURIComponent(to)}`)).status(), { timeout: 15_000 }).toBe(200)
})
