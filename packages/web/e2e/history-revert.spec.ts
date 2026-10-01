// «Revert this change» and «Content only» in the browser (D-034.1): another
// writer's version (written through the API, as an agent would) is undone on
// the note as it is now, with what the person wrote after it kept; a piece
// changed afterwards is shown in the preview and left alone; the other editor
// gets the revert live; a revert can be reverted; the version's text without
// marks, to copy; and a phone.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, MEMBER, NOTES, inVault, specMother } from './env.ts'
import { editorText, signIn } from './helpers.ts'

const m = specMother(import.meta.url)
/** Words of a sentence, without its full stop. */
const words = (n: number) => m.aSentence(n).slice(0, -1)
const DIR = inVault(m.aFolder())
const NOTE = m.aNotePath(DIR)
const SHOTS = `${E2E_DIR}/shots`
/**
 * The note: two sections. The agent changes a word at the end of each of the
 * first section's two lines (FILES → REPLACED, INDEX → REPLACED_INDEX, both
 * with SHARED in them), then the second section's heading (+ VERSION) and the
 * word WAS (→ NOW). Words nothing else has, so what the diff shows is exact.
 */
const [STORE, SYNC] = [m.aHeading(), m.aHeading()]
const [LINE1, LINE2, TAIL] = [words(4), words(3), m.aWord()]
const u = () => m.aUniqueWord()
const [FILES, INDEX, SHARED, WAS, NOW] = [u(), u(), u(), u(), u()]
const REPLACED = `${u()} ${u()} ${SHARED}`
const REPLACED_INDEX = `${SHARED} ${u()}`
const VERSION = `(${u()})`
const BEFORE = `# ${m.aHeading()}\n\n## ${STORE}\n\n${LINE1} ${FILES}.\n${LINE2} ${INDEX}.\n\n## ${SYNC}\n\n${WAS} ${TAIL}.\n`
/** What the person writes after the agent. */
const PERSON = `¿${words(5)}?`
const read = () => readFileSync(`${NOTES}/${NOTE}`, 'utf8')
const q = encodeURIComponent

/**
 * The caret at the very end of a line of the editor (which must have the
 * focus). End stops where a long line wraps, and generated text may wrap
 * anywhere: the DOM selection instead, which the editor takes as its own.
 */
async function toLineEnd(line: Locator) {
  await line.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
  })
}
/** Versions appear after a flush and some calm (3 s on the e2e server): more than the default 5 s. */
const SLOW = { timeout: 20_000 }

test.describe.configure({ mode: 'serial' })
let k: Page
let a: Page
/** A name as a whole element (an author's), never as part of another name nor of the text around it. */
const named = (scope: Page | Locator, name: string) => scope.getByText(name, { exact: true })

const panelOf = (page: Page) => page.getByRole('complementary', { name: 'Comentarios y contexto' })
const rows = (page: Page) => panelOf(page).locator('.h-row')
const band = (page: Page) => page.locator('.v-band')
const dialogOf = (page: Page) => page.getByRole('alertdialog')
/** A toggle button of the band (radios or pressed buttons, as React Aria renders them). */
const toggle = (page: Page, name: string) => band(page).getByRole('radio', { name, exact: true }).or(band(page).getByRole('button', { name, exact: true }))

type V = { id: string; authors: { name: string }[]; change: string; reason: { code: string } | null }
async function versions(page: Page): Promise<V[]> {
  const r = await page.request.get(`/api/history/versions?path=${q(NOTE)}`)
  return ((await r.json()) as { versions: V[] }).versions
}
async function newest(page: Page) {
  return (await versions(page))[0] ?? null
}
/** The agent's version, then what the person typed after it, both closed: the member then the admin (a plain edit), newest first. */
async function typedAfterAgent(page: Page) {
  const [first, second] = await versions(page)
  return !!first && !!second && first.reason === null && first.authors.map((x) => x.name).join() === ADMIN.username && second.authors.map((x) => x.name).join() === MEMBER.username
}

/** «The agent»: the member writes through the API, while the note is open. */
async function agentEdit(find: string, replace: string) {
  const r = await a.request.post('/api/note/edit', { data: { path: NOTE, ops: [{ op: 'find_replace', find, replace }] } })
  expect(r.status(), await r.text()).toBe(200)
}

async function openHistory(page: Page) {
  const tab = panelOf(page).getByRole('tab', { name: 'Historial' })
  if (await tab.getAttribute('aria-selected') !== 'true') await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

/** The newest version by the member (after the calm, the newest may be someone else's). */
const memberRow = (page: Page): Locator => rows(page).filter({ has: named(page, MEMBER.username) }).first()

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(`${NOTES}/${NOTE}`, BEFORE)
  k = await signIn(browser, ADMIN)
  await expect.poll(async () => (await newest(k))?.change, SLOW).toBe('created')
  a = await signIn(browser, MEMBER, NOTE)
  await k.goto(`/?note=${q(NOTE)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  await expect(k.locator('.presence .avatar')).toHaveCount(2)
})

test('reverting the agent\'s version keeps what the person wrote after it, and the other editor gets it live', async () => {
  await agentEdit(`${FILES}.\n${LINE2} ${INDEX}.`, `${REPLACED}.\n${LINE2} ${REPLACED_INDEX}.`)
  await expect.poll(() => editorText(k)).toContain(`${REPLACED_INDEX}.`)
  // The person writes after it, right below the agent's section.
  const line = k.locator('.cm-line', { hasText: `${LINE2} ${REPLACED_INDEX}.` })
  await line.click()
  await toLineEnd(line)
  await k.keyboard.type(`\n\n${PERSON}`)
  await expect.poll(() => typedAfterAgent(k), SLOW).toBe(true)

  await openHistory(k)
  await expect(named(rows(k).nth(1), MEMBER.username).first()).toBeVisible(SLOW)
  await memberRow(k).click()
  await expect(band(k).getByRole('heading')).toHaveText(/^Versión del /)
  await expect(named(band(k), MEMBER.username).first()).toBeVisible()
  await band(k).getByRole('button', { name: 'Revertir este cambio' }).click()
  const dialog = dialogOf(k)
  await expect(dialog.getByRole('heading')).toHaveText('¿Revertir este cambio?')
  await expect(dialog).toContainText('Se deshace solo lo que cambió esta versión, sobre el texto de ahora: lo que se escribió después se queda.')
  await expect(dialog.locator('.preview-head')).toHaveText('Se deshace (2)')
  await expect(dialog.locator('.rv-piece del')).toHaveText([REPLACED, REPLACED_INDEX])
  await expect(dialog.locator('.rv-piece ins')).toHaveText([FILES, INDEX])
  await expect(dialog.locator('.rv-skipped')).toHaveCount(0)
  await k.screenshot({ path: `${SHOTS}/revert-preview-light.png`, animations: 'disabled' })
  // Cancel first: nothing changes.
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await expect(dialog).toHaveCount(0)
  expect(read()).toContain(`${REPLACED_INDEX}.`)

  await band(k).getByRole('button', { name: 'Revertir este cambio' }).click()
  await dialogOf(k).getByRole('button', { name: 'Revertir este cambio' }).click()
  await expect(k.getByRole('status').filter({ hasText: 'Cambio revertido.' })).toBeVisible()
  await expect(k.locator('.version')).toHaveCount(0)
  const expected = `${LINE1} ${FILES}.\n${LINE2} ${INDEX}.\n\n${PERSON}\n\n## ${SYNC}`
  // Both editors, at once; then the file.
  await expect.poll(() => editorText(k)).toContain(`${LINE2} ${INDEX}.`)
  await expect.poll(() => editorText(a)).toContain(`${LINE2} ${INDEX}.`)
  expect(await editorText(a)).toContain(PERSON)
  expect(await editorText(a)).not.toContain(SHARED)
  await expect.poll(read, SLOW).toContain(expected)
  // A version of its own, by whoever reverted, saying which change it undid.
  const first = rows(k).first()
  await expect(first).toContainText(/Deshace el cambio del \d+ \S+, \d\d:\d\d/, SLOW)
  await expect(named(first, ADMIN.username).first()).toBeVisible()
})

test('a piece changed afterwards is shown in the preview and left as it is; the notice says so', async () => {
  await agentEdit(`## ${SYNC}\n\n${WAS} ${TAIL}.`, `## ${SYNC} ${VERSION}\n\n${NOW} ${TAIL}.`)
  await expect.poll(() => editorText(k)).toContain(`${NOW} ${TAIL}.`)
  // The person changes the very word the agent wrote.
  await k.locator('.cm-line', { hasText: `${NOW} ${TAIL}.` }).click()
  await k.keyboard.press('Home')
  for (let i = 0; i < NOW.length; i++) await k.keyboard.press('ArrowRight')
  await k.keyboard.type('2')
  await expect.poll(() => read(), SLOW).toContain(`${NOW}2 ${TAIL}.`)
  await expect.poll(() => typedAfterAgent(k), SLOW).toBe(true)
  // The panel's list has them too (it asks again every few seconds).
  await expect(named(rows(k).nth(1), MEMBER.username).first()).toBeVisible(SLOW)
  await expect(rows(k).first()).not.toContainText('Deshace')

  await memberRow(k).click()
  await expect(named(band(k), MEMBER.username).first()).toBeVisible()
  await band(k).getByRole('button', { name: 'Revertir este cambio' }).click()
  const dialog = dialogOf(k)
  await expect(dialog.locator('.preview-head')).toHaveText('Se deshace (1)')
  const skipped = dialog.locator('.rv-skipped')
  await expect(skipped).toContainText('No se deshace (1)')
  await expect(skipped).toContainText('Se volvió a cambiar después de esta versión, así que se deja como está.')
  await expect(skipped).toContainText(`Esta versión cambió «${WAS}» por «${NOW}».`)
  await expect(skipped.locator('mark')).toHaveText(`${NOW}2`)
  await k.screenshot({ path: `${SHOTS}/revert-preview-skipped-light.png`, animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Revertir este cambio' }).click()
  const notice = k.getByRole('alert').filter({ hasText: 'Cambio revertido.' })
  await expect(notice).toContainText(`No se ha deshecho una parte porque se cambió después: «${NOW}2».`)
  await k.screenshot({ path: `${SHOTS}/revert-notice-light.png`, animations: 'disabled' })
  await k.getByRole('button', { name: 'Cerrar aviso' }).click()
  // The other editor (the admin's caret, with their name, sits inside that word: the file says the rest).
  await expect.poll(() => editorText(a)).not.toContain(VERSION)
  await expect.poll(read, SLOW).toContain(`## ${SYNC}\n\n${NOW}2 ${TAIL}.`)
})

test('nothing left to undo: the preview says so and the button stays off', async () => {
  await rows(k).filter({ has: named(k, MEMBER.username) }).last().click()
  await band(k).getByRole('button', { name: 'Revertir este cambio' }).click()
  const dialog = dialogOf(k)
  await expect(dialog.locator('.rv-nothing')).toHaveText('No hay nada que deshacer: el texto de ahora ya no tiene los cambios de esta versión.')
  await expect(dialog.getByRole('button', { name: 'Revertir este cambio' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await band(k).getByRole('button', { name: 'Volver a la nota' }).click()
})

test('reverting a revert brings the agent\'s change back, with what the person wrote', async () => {
  await expect.poll(async () => (await newest(k))?.reason?.code, SLOW).toBe('reverted')
  await rows(k).filter({ hasText: 'Deshace el cambio' }).last().click()
  await band(k).getByRole('button', { name: 'Revertir este cambio' }).click()
  await expect(dialogOf(k).locator('.preview-head')).toHaveText('Se deshace (2)')
  await dialogOf(k).getByRole('button', { name: 'Revertir este cambio' }).click()
  await expect(k.getByRole('status').filter({ hasText: 'Cambio revertido.' })).toBeVisible()
  await expect.poll(() => editorText(a)).toContain(`${LINE2} ${REPLACED_INDEX}.`)
  expect(await editorText(a)).toContain(PERSON)
  await expect.poll(read, SLOW).toContain(`${REPLACED}.\n${LINE2} ${REPLACED_INDEX}.\n\n${PERSON}`)
})

test('«Content only»: the version\'s text without marks, to copy', async () => {
  await k.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await memberRow(k).click()
  await expect(k.locator('.v-text del').first()).toBeVisible()
  await toggle(k, 'Solo contenido').click()
  const plain = k.locator('.v-plain')
  await expect(plain).toContainText(`## ${SYNC} ${VERSION}`)
  await expect(plain).toContainText(`${NOW} ${TAIL}.`)
  await expect(plain).not.toContainText(`${WAS} ${TAIL}`)
  await expect(k.locator('.v-scroll ins, .v-scroll del')).toHaveCount(0)
  // Nothing about the diff while it's shown.
  await expect(toggle(k, 'Anterior')).toHaveCount(0)
  await expect(band(k).getByText(/^Cambio \d+ de \d+$/)).toHaveCount(0)
  const versionId = new URL(k.url()).searchParams.get('version')!
  const text = ((await (await k.request.get(`/api/history/version?path=${q(NOTE)}&id=${versionId}`)).json()) as { text: string }).text
  await band(k).getByRole('button', { name: 'Copiar el texto' }).click()
  await expect(band(k).getByRole('status')).toHaveText('Texto copiado.')
  expect(await k.evaluate(() => navigator.clipboard.readText())).toBe(text)
  await k.screenshot({ path: `${SHOTS}/version-content-light.png`, animations: 'disabled' })
  // Back to the changes.
  await toggle(k, 'Cambios').click()
  await expect(k.locator('.v-text del').first()).toBeVisible()
})

test('dark theme: the preview and «Content only»', async () => {
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  // The agent's first version: its change is back in the note, so there is something to undo.
  await rows(k).filter({ has: named(k, MEMBER.username) }).last().click()
  await band(k).getByRole('button', { name: 'Revertir este cambio' }).click()
  await expect(dialogOf(k).locator('.preview-head')).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/revert-preview-dark.png`, animations: 'disabled' })
  await dialogOf(k).getByRole('button', { name: 'Cancelar' }).click()
  await toggle(k, 'Solo contenido').click()
  await expect(k.locator('.v-plain')).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/version-content-dark.png`, animations: 'disabled' })
  await toggle(k, 'Cambios').click()
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
  await band(k).getByRole('button', { name: 'Volver a la nota' }).click()
})

test('«Recent changes» says what a revert undid', async () => {
  await k.getByRole('link', { name: 'Cambios recientes' }).click()
  await expect(k.locator('.c-change').filter({ hasText: /Deshace el cambio del \d+ \S+, \d\d:\d\d/ }).first()).toBeVisible()
  await k.goto(`/?note=${q(NOTE)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
})

test.describe('phone', () => {
  let phone: Page
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'es-ES' })
    phone = await ctx.newPage()
    await phone.goto(`/?note=${q(NOTE)}`)
    await phone.getByLabel('Nombre de usuario').fill(ADMIN.username)
    await phone.getByLabel('Contraseña').fill(ADMIN.password)
    await phone.getByRole('button', { name: 'Entrar' }).last().tap()
    await expect(phone.locator('.cm-content')).toBeVisible()
  })
  test.afterAll(async () => { await phone.context().close() })

  const noHorizontalScroll = (page: Page) =>
    expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)

  test('the band\'s buttons, the preview and «Content only» on a phone', async () => {
    await phone.getByRole('button', { name: 'Mostrar el panel lateral' }).tap()
    await panelOf(phone).getByRole('tab', { name: 'Historial' }).tap()
    const row = rows(phone).filter({ has: named(phone, MEMBER.username) }).last()
    await row.scrollIntoViewIfNeeded()
    await row.tap()
    await expect(phone.locator('.version')).toBeVisible()
    for (const name of ['Revertir este cambio', 'Restaurar esta versión', 'Volver a la nota']) {
      const b = await band(phone).getByRole('button', { name }).boundingBox()
      expect(b!.height).toBeGreaterThanOrEqual(44)
    }
    await noHorizontalScroll(phone)
    await phone.screenshot({ path: `${SHOTS}/revert-mobile-version.png`, animations: 'disabled' })
    await band(phone).getByRole('button', { name: 'Revertir este cambio' }).tap()
    const dialog = dialogOf(phone)
    await expect(dialog.locator('.preview-head')).toHaveText('Se deshace (2)')
    const box = await dialog.boundingBox()
    expect(box!.width).toBeLessThanOrEqual(390)
    await noHorizontalScroll(phone)
    await phone.screenshot({ path: `${SHOTS}/revert-mobile-preview.png`, animations: 'disabled' })
    await dialog.getByRole('button', { name: 'Cancelar' }).tap()
    await toggle(phone, 'Solo contenido').tap()
    await expect(phone.locator('.v-plain')).toBeVisible()
    await noHorizontalScroll(phone)
    await phone.screenshot({ path: `${SHOTS}/version-content-mobile.png`, animations: 'disabled' })
  })
})
