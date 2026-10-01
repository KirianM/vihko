// Note settings of a person and of a shared space: one's own, edited from
// Preferences, give a daily-note series and a templates folder in one's own
// space, used by «Today» and «New note»; a space's, edited by its managers
// from the space's menu, decide where its new images go. A member who
// doesn't manage the space reads them (to apply them) but can't change them,
// and isn't offered the menu entry. A hand edit with a mistake is an alert to
// whom the file belongs, never to anyone else.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, MEMBER, NOTES, SPACE, SPACE_NAME, personal, specMother } from './env.ts'
import { editorText, png, signIn } from './helpers.ts'

const m = specMother(import.meta.url)
const SHOTS = `${E2E_DIR}/shots`
/** The admin's series folder and templates folder, inside their own space. */
const JOURNAL = m.aFolder()
const TEMPLATES = m.aFolder()
const TEMPLATE = m.aTitle()
const LABEL = m.aHeading()
/** What the template writes before the user's name. */
const BY = m.aSentence(m.anInt(1, 3)).slice(0, -1)
/** The space's images folder, and a note of the space to upload into. */
const IMAGES = m.aFolder()
const PROBE_DIR = `${SPACE}/${m.aFolder()}`
const PROBE = `${PROBE_DIR}/${m.aTitle()}.md`
const MINE = personal(ADMIN)
const settingsFile = (root: string) => `${NOTES}/${root}/.vihko/settings.yaml`
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null)
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

let k: Page

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${MINE}/${TEMPLATES}`, { recursive: true })
  writeFileSync(`${NOTES}/${MINE}/${TEMPLATES}/${TEMPLATE}.md`, `# {{title}}\n\n${BY} {{user}}.\n`)
  mkdirSync(`${NOTES}/${PROBE_DIR}`, { recursive: true })
  writeFileSync(`${NOTES}/${PROBE}`, `# ${m.aHeading()}\n`)
  k = await signIn(browser, ADMIN)
  expect((await k.request.put('/api/profile', { data: { timezone: 'UTC', dailySeries: null } })).ok()).toBe(true)
})

// Everything goes as it was: the notes «Today» made go through the trash (they were open), then the folders and the files.
test.afterAll(async () => {
  const { notes } = await (await k.request.get('/api/tree')).json() as { notes: { path: string }[] }
  for (const n of notes) if (n.path.startsWith(`${MINE}/${JOURNAL}/`) || n.path.startsWith(`${PROBE_DIR}/`)) await k.request.delete(`/api/note?path=${encodeURIComponent(n.path)}`)
  for (const dir of [`${MINE}/${JOURNAL}`, `${MINE}/${TEMPLATES}`, PROBE_DIR, `${SPACE}/${IMAGES}`]) rmSync(`${NOTES}/${dir}`, { recursive: true, force: true })
  for (const root of [MINE, personal(MEMBER), SPACE]) rmSync(settingsFile(root), { force: true })
  await k.context().close()
})

test('one\'s own settings, from Preferences: a series and a templates folder in one\'s space, used by «Today» and «New note»', async () => {
  await k.goto('/')
  await expect(k.locator('nav.sidebar').getByRole('button', { name: 'Nota de hoy' })).toHaveCount(0)
  await k.getByRole('button', { name: 'Preferencias' }).click()
  // Choosing one's series and defining one's own sit together, each with its line; with no series yet, it says where to make one.
  const group = k.getByRole('dialog', { name: 'Preferencias' }).getByRole('group', { name: 'Notas del día y plantillas' })
  await expect(group).toContainText('Aún no tienes ninguna serie de notas del día')
  await expect(group.getByRole('button', { name: 'Ajustes de tus notas' })).toHaveAccessibleDescription(/^Define las tuyas: series de notas del día/)
  await group.getByRole('button', { name: 'Ajustes de tus notas' }).click()
  const dialog = k.getByRole('dialog', { name: 'Ajustes de tus notas' })
  await dialog.getByRole('button', { name: 'Añadir una serie' }).click()
  const series = dialog.getByRole('group', { name: 'Serie 1' })
  await series.getByLabel('Nombre', { exact: true }).fill(LABEL)
  await series.getByLabel('Carpeta', { exact: true }).fill(`${JOURNAL}/{YYYY}`)
  await series.getByLabel('Plantilla (opcional)').fill(`${TEMPLATES}/${TEMPLATE}`)
  await dialog.getByLabel('Carpetas de plantillas').fill(TEMPLATES)
  await k.screenshot({ path: `${SHOTS}/note-settings.png` })
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog).toHaveCount(0)

  // The file, in one's own space, with the paths as written.
  const file = read(settingsFile(MINE))!
  expect(file).toMatch(/^version: 1\n/)
  expect(file).toContain(`folder: ${JOURNAL}/{YYYY}`)
  expect(file).toContain(`templates: ${TEMPLATES}`)

  // «Today»: the note of the personal series, from the personal template.
  const todayButton = k.locator('nav.sidebar').getByRole('button', { name: 'Nota de hoy' })
  await todayButton.click()
  const date = today()
  await expect(k.locator('.crumbs b')).toHaveText(date)
  await expect.poll(() => editorText(k)).toContain(`${BY} ${ADMIN.username}.`)
  expect(existsSync(`${NOTES}/${MINE}/${JOURNAL}/${date.slice(0, 4)}/${date}.md`)).toBe(true)

  // «New note»: the personal template is offered.
  await k.locator('nav.sidebar').getByRole('button', { name: 'Nueva nota' }).click()
  const title = m.aTitle()
  await k.getByRole('dialog').getByRole('textbox').fill(title)
  await expect(k.getByRole('option', { name: `Crear «${title}» con la plantilla ${TEMPLATE}` })).toBeVisible()
  await k.keyboard.press('Escape')

  // Preferences now offer the series to choose, next to where it was made (both themes, for a look).
  await k.getByRole('button', { name: 'Preferencias' }).click()
  await expect(group.getByLabel('Serie de la nota del día')).toContainText(LABEL)
  for (const theme of ['light', 'dark'] as const) {
    await k.emulateMedia({ colorScheme: theme })
    await k.screenshot({ path: `${SHOTS}/preferences-${theme}.png` })
  }
  await k.emulateMedia({ colorScheme: null })
  // Opened again, the form has what was saved.
  await group.getByRole('button', { name: 'Ajustes de tus notas' }).click()
  await expect(k.getByRole('dialog', { name: 'Ajustes de tus notas' }).getByRole('group', { name: 'Serie 1' }).getByLabel('Nombre', { exact: true })).toHaveValue(LABEL)
  await k.getByRole('dialog', { name: 'Ajustes de tus notas' }).getByRole('button', { name: 'Cancelar' }).click()
})

test('one\'s own settings go by one name: «Your note settings» in Preferences and in the menu of «My notes»', async () => {
  await k.goto('/')
  await k.getByRole('button', { name: 'Acciones de «Mis notas»' }).click()
  await expect(k.getByRole('menuitem', { name: 'Ajustes…' })).toHaveCount(0)
  for (const theme of ['light', 'dark'] as const) {
    await k.emulateMedia({ colorScheme: theme })
    await k.screenshot({ path: `${SHOTS}/mine-menu-${theme}.png`, clip: { x: 0, y: 0, width: 640, height: 480 } })
  }
  await k.emulateMedia({ colorScheme: null })
  await k.getByRole('menuitem', { name: 'Ajustes de tus notas…' }).click()
  const dialog = k.getByRole('dialog', { name: 'Ajustes de tus notas' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
})

test('a space\'s settings, by its manager from the space\'s menu: where its new images go; a member reads them and can\'t change them', async ({ browser }) => {
  await k.goto('/')
  await k.getByRole('button', { name: `Acciones de «${SPACE_NAME}»` }).click()
  await k.getByRole('menuitem', { name: 'Ajustes…' }).click()
  const dialog = k.getByRole('dialog', { name: `Ajustes de «${SPACE_NAME}»` })
  await dialog.getByLabel('Imágenes nuevas').selectOption('folder')
  await dialog.getByLabel('Carpeta de imágenes').fill(IMAGES)
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  await expect(dialog).toHaveCount(0)
  expect(read(settingsFile(SPACE))).toContain(`folder: ${IMAGES}`)

  // A new image of a note of the space goes to the space's folder.
  const up = await k.request.post(`/api/attachments?note=${encodeURIComponent(PROBE)}`, { data: png(40, 20, [30, 74, 134]), headers: { 'content-type': 'image/png' } })
  expect(up.ok(), await up.text()).toBe(true)
  expect(((await up.json()) as { path: string }).path.startsWith(`${SPACE}/${IMAGES}/`)).toBe(true)

  // The member edits in the space but doesn't manage it: no «Settings…», and the API says so.
  const a = await signIn(browser, MEMBER)
  await a.getByRole('button', { name: `Acciones de «${SPACE_NAME}»` }).click()
  await expect(a.getByRole('menuitem', { name: 'Miembros…' })).toBeVisible()
  await expect(a.getByRole('menuitem', { name: 'Ajustes…' })).toHaveCount(0)
  await a.keyboard.press('Escape')
  const got = await (await a.request.get(`/api/settings?space=${encodeURIComponent(SPACE)}`)).json() as { canEdit: boolean; etag: string; settings: unknown }
  expect(got.canEdit).toBe(false)
  const put = await a.request.put('/api/settings', { data: { space: SPACE, settings: got.settings, ifMatch: got.etag } })
  expect(put.status()).toBe(403)
  await a.context().close()
})

test('a guide for agents that names no note: said on saving, and an alert until the note exists', async () => {
  const guide = m.aTitle()
  await k.goto('/')
  await k.getByRole('button', { name: 'Preferencias' }).click()
  await k.getByRole('dialog', { name: 'Preferencias' }).getByRole('button', { name: 'Ajustes de tus notas' }).click()
  const dialog = k.getByRole('dialog', { name: 'Ajustes de tus notas' })
  await dialog.getByLabel('Guía para agentes (una nota)').fill(guide)
  await dialog.getByRole('button', { name: 'Guardar' }).click()
  // Saved, and the dialog stays to say the note isn't there.
  await expect(dialog.getByRole('status')).toHaveText(`Guardado. Aún no hay ninguna nota «${guide}»: los agentes no reciben nada de ella hasta que la crees.`)
  expect(read(settingsFile(MINE))).toContain(`agents: ${guide}`)
  for (const theme of ['light', 'dark'] as const) {
    await k.emulateMedia({ colorScheme: theme })
    await dialog.screenshot({ path: `${SHOTS}/guide-missing-${theme}.png` })
  }
  await k.emulateMedia({ colorScheme: null })
  await dialog.getByRole('button', { name: 'Cerrar' }).click()
  await expect(dialog).toHaveCount(0)
  // Opened again, the field says so too.
  await k.getByRole('button', { name: 'Preferencias' }).click()
  await k.getByRole('dialog', { name: 'Preferencias' }).getByRole('button', { name: 'Ajustes de tus notas' }).click()
  await expect(dialog.getByRole('note')).toHaveText(`Aún no hay ninguna nota «${guide}» aquí: los agentes no reciben nada de ella hasta que la crees.`)
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  // The alert, until the note exists.
  await k.goto('/?view=alerts')
  await expect(k.getByText('Tu guía para agentes no existe')).toBeVisible()
  await expect(k.locator('.mono', { hasText: guide })).toHaveText(`Mis notas / ${guide}`)
  for (const theme of ['light', 'dark'] as const) {
    await k.emulateMedia({ colorScheme: theme })
    await k.screenshot({ path: `${SHOTS}/alert-guide-missing-${theme}.png` })
  }
  await k.emulateMedia({ colorScheme: null })
  const path = `${MINE}/${guide}.md`
  expect((await k.request.post('/api/note', { data: { path, text: `# ${guide}\n\n${m.aSentence()}\n` } })).ok()).toBe(true)
  const codes = async () => ((await (await k.request.get('/api/alerts')).json()) as { alerts: { code: string }[] }).alerts.map((x) => x.code)
  await expect.poll(codes).not.toContain('settings_guide_missing')
  await k.request.delete(`/api/note?path=${encodeURIComponent(path)}`)
})

test('a hand edit with a mistake is an alert to whom the file belongs, and to nobody else', async ({ browser }) => {
  const a = await signIn(browser, MEMBER)
  mkdirSync(`${NOTES}/${personal(MEMBER)}/.vihko`, { recursive: true })
  // Literal: the wrong value is the case under test.
  writeFileSync(settingsFile(personal(MEMBER)), `version: 1\ntemplates: ../${m.aFolder()}\n`)
  const codes = async (page: Page) => ((await (await page.request.get('/api/alerts')).json()) as { alerts: { code: string }[] }).alerts.map((x) => x.code)
  await expect.poll(() => codes(a)).toContain('settings_invalid')
  expect(await codes(k)).not.toContain('settings_invalid')
  await a.goto('/?view=alerts')
  await expect(a.getByText('Los ajustes de tus notas tienen algo mal')).toBeVisible()
  await a.context().close()
})
