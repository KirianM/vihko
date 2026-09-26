// The history (M2) in the browser: the «History» tab with each version's
// author (a person, outside thoth, the system after a rename), a version with
// its diff, restoring it with two people in the note, «Recent changes» with
// its author filter, a phone and the dark theme. The e2e server closes a
// typed version after 3 s of calm (THOTH_HISTORY_QUIET_SECONDS).
import { expect, test, type Locator, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { E2E_DIR, NOTES, PASSWORD } from './env.ts'
import { editorText, png, signIn } from './helpers.ts'

const DIR = 'historial'
const NOTE = `${DIR}/Viaje.md`
const RENAMED = `${DIR}/Viaje a Roma.md`
const INDEX = `${DIR}/Indice.md`
const IMAGE = `${DIR}/foto.png`
const SHOTS = `${E2E_DIR}/shots`
const TYPED = 'Segundo día en el Trastévere.'
const OUTSIDE = 'Añadido con otro editor.'
const read = (p: string) => readFileSync(`${NOTES}/${p}`, 'utf8')
const q = encodeURIComponent
/** Versions and pending work appear after a flush and some calm: more than the default 5 s. */
const SLOW = { timeout: 20_000 }

test.describe.configure({ mode: 'serial' })
let k: Page
let a: Page

const panelOf = (page: Page) => page.getByRole('complementary', { name: 'Comentarios y contexto' })
const rows = (page: Page) => panelOf(page).locator('.h-row')
const band = (page: Page) => page.locator('.v-band')
/** «Compare with: Previous | Current» (a toggle group: radios or pressed buttons). */
const compareWith = (page: Page, name: 'Anterior' | 'Actual') => band(page).getByRole('radio', { name }).or(band(page).getByRole('button', { name, exact: true }))

async function openHistory(page: Page) {
  await panelOf(page).getByRole('tab', { name: 'Historial' }).click()
  await expect(panelOf(page).getByRole('tab', { name: 'Historial' })).toHaveAttribute('aria-selected', 'true')
}

/** The newest version in the API, to know when the recorder has it. */
async function newest(page: Page, path: string) {
  const r = await page.request.get(`/api/history/versions?path=${q(path)}`)
  return ((await r.json()) as { versions: { id: string; authors: { kind: string; name: string }[]; change: string }[] }).versions[0] ?? null
}

async function typeLine(page: Page, text: string) {
  await page.locator('.cm-line', { hasText: 'Primer día en Roma.' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(`\n\n${text}`)
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(`${NOTES}/${NOTE}`, '# Viaje\n\nPrimer día en Roma.\n')
  writeFileSync(`${NOTES}/${INDEX}`, '# Índice\n\n- [[Viaje]]\n')
  writeFileSync(`${NOTES}/${IMAGE}`, png(24, 24, [200, 80, 40]))
  k = await signIn(browser, 'noa')
  // Until the recorder sees the new files there is nothing to show.
  await expect.poll(async () => (await newest(k, NOTE))?.change, SLOW).toBe('created')
})

test('a note written by another tool: «Outside thoth», created', async () => {
  await k.goto(`/?note=${q(NOTE)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  await openHistory(k)
  const first = rows(k).first()
  await expect(first).toContainText('Fuera de thoth')
  await expect(first).toContainText('Creada')
  await expect(panelOf(k).getByRole('heading', { name: 'Hoy' })).toBeVisible()
})

test('typing in the editor: «In progress», then a version by whoever typed it', async () => {
  await typeLine(k, `${TYPED} ![](foto.png)`)
  await expect(panelOf(k).getByText('En curso · se guarda en unos segundos')).toBeVisible({ timeout: 10_000 })
  await expect(panelOf(k).locator('.h-pending')).toContainText('noa')
  await panelOf(k).screenshot({ path: `${SHOTS}/history-tab-pending.png`, animations: 'disabled' })
  const mine = rows(k).filter({ hasText: 'noa' }).first()
  await expect(mine).toBeVisible(SLOW)
  await expect(panelOf(k).locator('.h-pending')).toHaveCount(0)
  // The person's dot and name, and what the version added.
  await expect(mine.locator('.h-dot')).toBeVisible()
  await expect(mine.locator('.h-add')).toHaveText(/^\+\d+$/)
  // What +N counts, said in full: to screen readers and as a tooltip on the numbers.
  await expect(mine).toHaveAccessibleName(/\d+ palabras y signos añadidos/)
  await expect(mine.locator('.h-counts > [aria-hidden]')).toHaveAttribute('title', /^\d+ palabras y signos añadidos/)
})

test('a change made with another editor shows up as «Outside thoth»', async () => {
  await expect.poll(() => read(NOTE)).toContain(TYPED)
  writeFileSync(`${NOTES}/${NOTE}`, read(NOTE) + `\n${OUTSIDE}\n`)
  await expect.poll(() => editorText(k)).toContain(OUTSIDE)
  const first = rows(k).first()
  await expect(first).toContainText('Fuera de thoth', SLOW)
  await expect(first).not.toContainText('Creada')
  await expect(first.locator('.h-add')).toHaveText(/^\+\d+$/)
  await k.screenshot({ path: `${SHOTS}/history-tab-light.png`, animations: 'disabled' })
})

test('a version opens in the main area: read only, its diff, compared with the previous one or the current note', async () => {
  await rows(k).filter({ hasText: 'noa' }).first().click()
  await expect(k).toHaveURL(/[?&]version=[0-9a-f]{40}/)
  await expect(band(k).getByRole('heading')).toHaveText(/^Versión del /)
  await expect(band(k)).toContainText('noa')
  await expect(rows(k).filter({ hasText: 'noa' }).first()).toHaveAttribute('aria-current', 'true')
  // The editor gives way to the version (read only: no editor on screen).
  await expect(k.locator('.cm-content')).toBeHidden()
  const text = k.locator('.v-text')
  // What was typed, and the uid the note got when it was first opened (D-015).
  await expect(text.locator('ins').filter({ hasText: TYPED })).toHaveCount(1)
  await expect(text.locator('ins').filter({ hasText: /^---\nuid: \w+\n---$/ })).toHaveCount(1)
  await expect(text).not.toContainText(OUTSIDE)
  await expect(band(k).getByText('Cambio 1 de 2')).toBeVisible()
  await band(k).getByRole('button', { name: 'Cambio siguiente' }).click()
  await expect(band(k).getByText('Cambio 2 de 2')).toBeVisible()
  await expect(text.locator('ins.v-cur')).toContainText(TYPED)
  // Screen readers are told where an insertion starts and ends.
  expect(await text.locator('ins').first().evaluate((el) => getComputedStyle(el, '::before').content)).toBe('"[añadido: "')
  await k.screenshot({ path: `${SHOTS}/history-version-light.png`, animations: 'disabled' })

  // Against the current note: what the current note has and this version doesn't is struck out.
  await compareWith(k, 'Actual').click()
  await expect(text.locator('del')).toContainText(OUTSIDE)
  await expect(text.locator('ins')).toHaveCount(0)

  // Esc goes back to the note, and so does the URL.
  await k.keyboard.press('Escape')
  await expect(k.locator('.cm-content')).toBeVisible()
  await expect(k.locator('.version')).toHaveCount(0)
  await expect(k).not.toHaveURL(/version=/)
})

test('the back button closes a version, and a link opens it', async () => {
  await rows(k).filter({ hasText: 'noa' }).first().click()
  await expect(k.locator('.version')).toBeVisible()
  const url = k.url()
  await k.goBack()
  await expect(k.locator('.version')).toHaveCount(0)
  await expect(k.locator('.cm-content')).toBeVisible()
  await expect(k).not.toHaveURL(/version=/)
  await k.goto(url)
  await expect(k.locator('.v-text ins').filter({ hasText: TYPED })).toBeVisible()
  await expect(panelOf(k).getByRole('tab', { name: 'Historial' })).toHaveAttribute('aria-selected', 'true')
  await band(k).getByRole('button', { name: 'Volver a la nota' }).click()
  await expect(k.locator('.cm-content')).toBeVisible()
})

test('restoring with two people in the note: asked first, and the other one gets it live', async ({ browser }) => {
  a = await signIn(browser, 'ana', NOTE)
  await expect(k.locator('.presence .avatar')).toHaveCount(2)
  expect(await editorText(a)).toContain(OUTSIDE)
  await rows(k).filter({ hasText: 'noa' }).first().click()
  await band(k).getByRole('button', { name: 'Restaurar esta versión' }).click()
  const dialog = k.getByRole('alertdialog')
  await expect(dialog.getByRole('heading')).toHaveText('¿Restaurar esta versión?')
  await expect(dialog).toContainText('El texto actual se sustituye para todos los que tienen la nota abierta. Queda como una versión nueva y se puede deshacer desde el historial.')
  // Cancel first: nothing changes.
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await expect(dialog).toHaveCount(0)
  expect(read(NOTE)).toContain(OUTSIDE)
  await band(k).getByRole('button', { name: 'Restaurar esta versión' }).click()
  await k.getByRole('alertdialog').getByRole('button', { name: 'Restaurar esta versión' }).click()
  // Back to the note, with the notice.
  await expect(k.getByRole('status').filter({ hasText: 'Versión restaurada.' })).toBeVisible()
  await expect(k.locator('.version')).toHaveCount(0)
  await expect.poll(() => editorText(k)).not.toContain(OUTSIDE)
  await expect.poll(() => editorText(a)).not.toContain(OUTSIDE)
  expect(await editorText(a)).toContain(TYPED)
  await expect.poll(() => read(NOTE), SLOW).not.toContain(OUTSIDE)
  // The restore is a version of its own, by whoever restored it.
  const first = rows(k).first()
  await expect(first).toContainText(/Restaurada desde la versión del \d+ \S+, \d\d:\d\d/, SLOW)
  await expect(first).toContainText('noa')
})

test('restoring brings back the images that version linked and that are gone', async () => {
  rmSync(`${NOTES}/${IMAGE}`)
  // The image's removal is recorded before the restore looks for it.
  await expect.poll(async () => {
    const r = await k.request.get('/api/history/changes')
    const { changes } = (await r.json()) as { changes: { files: { path: string; change: string }[] }[] }
    return changes.some((c) => c.files.some((f) => f.path === IMAGE && f.change === 'deleted'))
  }, SLOW).toBe(true)
  await rows(k).filter({ hasText: 'noa' }).filter({ hasNotText: 'Restaurada' }).first().click()
  await band(k).getByRole('button', { name: 'Restaurar esta versión' }).click()
  await k.getByRole('alertdialog').getByRole('button', { name: 'Restaurar esta versión' }).click()
  await expect(k.getByRole('status').filter({ hasText: 'Versión restaurada.' })).toContainText('Se ha recuperado 1 imagen que ya no estaba: foto.png.')
  expect(existsSync(`${NOTES}/${IMAGE}`)).toBe(true)
  await k.getByRole('button', { name: 'Cerrar aviso' }).click()
})

test('a rename: the move by whoever did it, and the links rewritten by the system for them', async () => {
  await a.close()
  await k.getByRole('button', { name: 'Más acciones' }).click()
  await k.getByRole('menuitem', { name: 'Renombrar o mover…' }).click()
  const dialog = k.getByRole('dialog')
  await dialog.getByLabel('Nuevo nombre').fill('Viaje a Roma')
  const submit = dialog.getByRole('button', { name: /^Renombrar/ })
  await expect(submit).toBeEnabled({ timeout: 15_000 })
  await submit.click()
  await expect(k.locator('.crumbs b')).toHaveText('Viaje a Roma', { timeout: 15_000 })
  await openHistory(k)
  const moved = rows(k).first()
  await expect(moved).toContainText('Renombrada: «Viaje» → «Viaje a Roma»', SLOW)
  await expect(moved).toContainText('noa')
  // Older versions are still there: the history follows the note.
  await expect(rows(k).filter({ hasText: 'Creada' })).toHaveCount(1)

  await k.goto(`/?note=${q(INDEX)}`)
  await openHistory(k)
  const system = rows(k).first()
  await expect(system).toContainText('Enlaces actualizados al renombrar «Viaje» como «Viaje a Roma», por noa', SLOW)
  // The system: thoth's mark and the words, no person's dot.
  await expect(system.locator('.h-system svg')).toBeVisible()
  await expect(system.locator('.h-dot')).toHaveCount(0)
  await system.click()
  await expect(k.locator('.v-text ins').filter({ hasText: 'Roma' })).toHaveCount(1)
  await expect(k.locator('.v-text')).toContainText('[[Viaje a Roma]]')
})

test('«Recent changes»: by day, with authors and files, filtered by author; a note opens at that change', async () => {
  await k.getByRole('link', { name: 'Cambios recientes' }).click()
  await expect(k).toHaveURL(/view=changes/)
  await expect(k.getByRole('heading', { name: 'Cambios recientes', level: 1 })).toBeVisible()
  await expect(k.getByRole('heading', { name: 'Hoy', level: 2 })).toBeVisible()
  const cards = k.locator('.c-change')
  await expect(cards.filter({ hasText: 'Enlaces actualizados al renombrar «Viaje» como «Viaje a Roma», por noa' })).toHaveCount(1)
  await k.screenshot({ path: `${SHOTS}/history-changes-light.png`, animations: 'disabled' })

  const filter = k.getByLabel('Autor')
  await filter.selectOption({ label: 'Fuera de thoth' })
  await expect(cards.first()).toContainText('Fuera de thoth')
  await expect(cards.filter({ hasNotText: 'Fuera de thoth' })).toHaveCount(0)
  await expect(cards.filter({ has: k.locator('.h-dot') })).toHaveCount(0)

  await filter.selectOption({ label: 'noa' })
  await expect(cards.first()).toContainText('noa')
  await expect(cards.filter({ hasText: 'Fuera de thoth' })).toHaveCount(0)
  await expect(cards.filter({ hasNotText: 'noa' })).toHaveCount(0)

  // A version of the note from before its rename opens where the note is now.
  const typed = cards.filter({ has: k.getByRole('link', { name: 'historial / Viaje' , exact: true }) }).last()
  await typed.getByRole('link', { name: 'historial / Viaje', exact: true }).click()
  await expect(k).toHaveURL(new RegExp(`note=${q(RENAMED).replace(/%20/g, '(%20|\\+)')}.*version=`))
  await expect(k.locator('.crumbs b')).toHaveText('Viaje a Roma')
  await expect(k.locator('.v-text')).toBeVisible()
})

test('dark theme: the tab, a version and «Recent changes»', async () => {
  await k.goto(`/?note=${q(RENAMED)}`)
  await openHistory(k)
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  // The restore took out what the other editor added: struck out against the previous version.
  await rows(k).filter({ hasText: 'Restaurada desde' }).first().click()
  await expect(k.locator('.v-text del')).toContainText(OUTSIDE)
  await expect(panelOf(k).locator('.h-row[aria-current]')).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/history-version-dark.png`, animations: 'disabled' })
  await k.getByRole('link', { name: 'Cambios recientes' }).click()
  await expect(k.locator('.c-change').first()).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/history-changes-dark.png`, animations: 'disabled' })
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
})

test.describe('phone', () => {
  let m: Page
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'es-ES' })
    m = await ctx.newPage()
    await m.goto(`/?note=${q(RENAMED)}`)
    await m.getByLabel('Nombre de usuario').fill('noa')
    await m.getByLabel('Contraseña').fill(PASSWORD)
    await m.getByRole('button', { name: 'Entrar' }).last().tap()
    await expect(m.locator('.cm-content')).toBeVisible()
  })
  test.afterAll(async () => { await m.context().close() })

  const noHorizontalScroll = (page: Page) =>
    expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  const tapRow = async (row: Locator) => { await row.scrollIntoViewIfNeeded(); await row.tap() }

  test('the tab in the panel sheet, a version full screen, and back', async () => {
    await m.getByRole('button', { name: 'Mostrar el panel lateral' }).tap()
    await panelOf(m).getByRole('tab', { name: 'Historial' }).tap()
    await expect(rows(m).first()).toBeVisible()
    const box = await rows(m).first().boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(44)
    await m.screenshot({ path: `${SHOTS}/history-mobile-tab.png`, animations: 'disabled' })
    await tapRow(rows(m).filter({ hasText: 'noa' }).filter({ hasNotText: 'Restaurada' }).filter({ hasNotText: 'Renombrada' }).first())
    // The sheet closes: the version takes the whole screen.
    await expect(panelOf(m)).toHaveCount(0)
    await expect(m.locator('.v-text ins').first()).toBeVisible()
    const version = await m.locator('.version').boundingBox()
    expect(version!.width).toBeGreaterThanOrEqual(389)
    for (const name of ['Restaurar esta versión', 'Volver a la nota']) {
      const b = await band(m).getByRole('button', { name }).boundingBox()
      expect(b!.height).toBeGreaterThanOrEqual(44)
    }
    await noHorizontalScroll(m)
    await m.screenshot({ path: `${SHOTS}/history-mobile-version.png`, animations: 'disabled' })
    // The phone's back gesture closes the version.
    await m.goBack()
    await expect(m.locator('.version')).toHaveCount(0)
    await expect(m.locator('.cm-content')).toBeVisible()
  })

  test('dark theme and «Recent changes» from the drawer', async () => {
    await m.emulateMedia({ colorScheme: 'dark' })
    await m.getByRole('button', { name: 'Mostrar el panel lateral' }).tap()
    await panelOf(m).getByRole('tab', { name: 'Historial' }).tap()
    await tapRow(rows(m).filter({ hasText: 'Renombrada' }).first())
    await expect(m.locator('.version')).toBeVisible()
    await m.screenshot({ path: `${SHOTS}/history-mobile-version-dark.png`, animations: 'disabled' })
    await m.goBack()
    await m.getByRole('button', { name: 'Abrir carpetas' }).tap()
    await m.getByRole('dialog', { name: 'Carpetas' }).getByRole('link', { name: 'Cambios recientes' }).tap()
    await expect(m.getByRole('heading', { name: 'Cambios recientes', level: 1 })).toBeVisible()
    await expect(m.locator('.c-change').first()).toBeVisible()
    await noHorizontalScroll(m)
    await m.screenshot({ path: `${SHOTS}/history-mobile-changes-dark.png`, animations: 'disabled' })
    await m.emulateMedia({ colorScheme: 'light' })
  })
})
