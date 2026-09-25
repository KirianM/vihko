// Link fixes (D-031): an ambiguous link opens a picker of its candidates
// (open one, or pin the link to it), and a note renamed outside thoth raises
// an alert whose «Update links» rewrites the links left behind.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { E2E_DIR, NOTES } from './env.ts'
import { editorText, signIn } from './helpers.ts'

const DIR = 'e2e-enlaces'
const SHOTS = `${E2E_DIR}/shots`
const disk = (path: string) => readFileSync(`${NOTES}/${path}`, 'utf8')

test.describe.configure({ mode: 'serial' })
test.beforeAll(() => { mkdirSync(`${NOTES}/${DIR}`, { recursive: true }); mkdirSync(SHOTS, { recursive: true }) })

/** A note with an ambiguous [[Tareas]] (proyectos/thoth and proyectos/blog are as close from here). */
function ambiguousNote(name: string, text = `# ${name}\n\nPrimero [[Tareas]] y después el resto.\n`) {
  const path = `${DIR}/${name}.md`
  writeFileSync(`${NOTES}/${path}`, text)
  return path
}

const picker = (page: Page) => page.getByRole('dialog', { name: '«Tareas» puede llevar a:' })
const ambiguousLink = (page: Page) => page.locator('.cm-wikilink-ambiguous a', { hasText: 'Tareas' })

test('the picker lists the candidates by title and path; «Pin» rewrites that link without leaving', async ({ browser }) => {
  const note = ambiguousNote('Fijar aquí')
  const k = await signIn(browser, 'noa', note)
  await ambiguousLink(k).click()
  const p = picker(k)
  await expect(p).toBeVisible()
  const rows = p.getByRole('row')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('Tareas de blog')
  await expect(rows.nth(0)).toContainText('proyectos/blog/Tareas.md')
  await expect(rows.nth(1)).toContainText('Tareas de thoth')
  await p.getByRole('button', { name: 'Fijar el enlace a proyectos/blog/Tareas.md' }).click()
  await expect(p).toHaveCount(0)
  await expect(k.getByRole('status').filter({ hasText: 'Fijado' })).toContainText('[[blog/Tareas]]')
  await expect.poll(() => disk(note)).toContain('Primero [[blog/Tareas]] y después')
  // Still here, and the link now resolves (it navigates on click).
  await expect(k.locator('.crumbs b')).toHaveText('Fijar aquí')
  await expect(k.locator('.cm-wikilink-resolved a', { hasText: 'blog/Tareas' })).toBeVisible()
  await k.context().close()
})

test('opening a candidate goes there and offers «Pin this destination», which rewrites the link in the note you came from', async ({ browser }) => {
  const note = ambiguousNote('Abrir y fijar', '# Abrir y fijar\n\n- [[Tareas|las tareas]] con texto\n')
  const k = await signIn(browser, 'noa', note)
  await k.locator('.cm-wikilink-ambiguous a', { hasText: 'las tareas' }).click()
  await picker(k).getByRole('row', { name: /Tareas de thoth/ }).click()
  await expect(k.locator('.crumbs')).toHaveText('proyectos / thoth / Tareas')
  const offer = k.locator('.pin-offer')
  await expect(offer).toContainText('Has llegado desde «Tareas», un enlace ambiguo de «Abrir y fijar».')
  await offer.getByRole('button', { name: 'Fijar este destino' }).click()
  await expect(offer).toContainText('Fijado: en «Abrir y fijar» el enlace ahora es [[thoth/Tareas|las tareas]]')
  expect(disk(note)).toContain('- [[thoth/Tareas|las tareas]] con texto')
  // Nothing is written without that press: going elsewhere drops the offer.
  await k.goto(`/?note=${encodeURIComponent(note)}`)
  await expect(k.locator('.pin-offer')).toHaveCount(0)
  await k.context().close()
})

test('from the panel, with the keyboard: the picker opens on the link, arrows and Enter open a candidate', async ({ browser }) => {
  const note = ambiguousNote('Desde el panel')
  const k = await signIn(browser, 'noa', note)
  await k.getByRole('tab', { name: /Enlaces/ }).click()
  const panel = k.getByRole('complementary', { name: 'Comentarios y contexto' })
  await panel.getByRole('button', { name: /Tareas\s*ambiguo · 2/ }).click()
  const p = picker(k)
  await expect(p).toBeVisible()
  await expect(p.getByRole('row').first()).toBeFocused()
  await k.keyboard.press('ArrowDown')
  await k.keyboard.press('Enter')
  await expect(k.locator('.crumbs')).toHaveText('proyectos / thoth / Tareas')
  await expect(k.locator('.pin-offer')).toBeVisible()
  expect(disk(note), 'opening writes nothing').toContain('Primero [[Tareas]] y')
  // Escape closes the picker without doing anything.
  await k.goto(`/?note=${encodeURIComponent(note)}`)
  await ambiguousLink(k).click()
  await expect(picker(k)).toBeVisible()
  await k.keyboard.press('Escape')
  await expect(picker(k)).toHaveCount(0)
  await k.context().close()
})

test('screenshots of the picker: light, dark and a phone', async ({ browser }) => {
  const note = ambiguousNote('Capturas del selector')
  const k = await signIn(browser, 'noa', note)
  await k.setViewportSize({ width: 1280, height: 800 })
  await ambiguousLink(k).click()
  await expect(picker(k)).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/selector-claro.png`, animations: 'disabled' })
  await k.keyboard.press('Escape')
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await ambiguousLink(k).click()
  await expect(picker(k)).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/selector-oscuro.png`, animations: 'disabled' })
  await k.keyboard.press('Escape')
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
  await k.context().close()

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const m = await ctx.newPage()
  await m.goto(`/?note=${encodeURIComponent(note)}`)
  await m.getByLabel('Nombre de usuario').fill('noa')
  await m.getByLabel('Contraseña').fill('contraseña-larga')
  await m.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(m.locator('.cm-content')).toBeVisible()
  await ambiguousLink(m).tap()
  const p = picker(m)
  await expect(p).toBeVisible()
  const box = await p.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  // Full touch targets.
  expect((await p.getByRole('row').first().boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await m.screenshot({ path: `${SHOTS}/selector-movil.png`, animations: 'disabled' })
  await ctx.close()
})

// --- A note renamed outside thoth -------------------------------------------------

test('renamed on disk: the alert says where it went and how many links point to the old path; «Update links» fixes them', async ({ browser }) => {
  const dest = `${DIR}/Destino.md`
  const origin = `${DIR}/Origen.md`
  writeFileSync(`${NOTES}/${dest}`, '# Destino\n\n## Sección\n\nTexto.\n')
  writeFileSync(`${NOTES}/${origin}`, '# Origen\n\n- [[Destino]] por nombre\n- [[Destino#Sección|la sección]] con ancla\n')
  const k = await signIn(browser, 'noa', origin)
  await expect(k.locator('.cm-wikilink-resolved a', { hasText: 'la sección' })).toBeVisible()
  // Another tool renames it.
  renameSync(`${NOTES}/${dest}`, `${NOTES}/${DIR}/Destino renombrado.md`)
  await k.goto('/?view=avisos')
  const card = k.locator('.alert-card', { hasText: 'se movió fuera de thoth' })
  await expect(async () => {
    await k.reload()
    await expect(card).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 20_000 })
  await expect(card.getByRole('heading')).toHaveText(`${dest} se movió fuera de thoth a ${DIR}/Destino renombrado.md`)
  await expect(card).toContainText('2 enlaces siguen apuntando a la ruta antigua')
  expect(disk(origin), 'nothing rewritten on its own').toContain('[[Destino]] por nombre')

  await k.setViewportSize({ width: 1440, height: 900 })
  await k.screenshot({ path: `${SHOTS}/movida-fuera-claro.png`, fullPage: true, animations: 'disabled' })
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await k.screenshot({ path: `${SHOTS}/movida-fuera-oscuro.png`, fullPage: true, animations: 'disabled' })
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
  await k.setViewportSize({ width: 390, height: 844 })
  await k.screenshot({ path: `${SHOTS}/movida-fuera-movil.png`, fullPage: true, animations: 'disabled' })
  expect(await k.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await k.setViewportSize({ width: 1280, height: 800 })

  await card.getByRole('button', { name: 'Actualizar enlaces' }).click()
  const dialog = k.getByRole('dialog', { name: 'Actualizar enlaces' })
  await expect(dialog.locator('.preview-row')).toHaveCount(2)
  await expect(dialog).toContainText('[[Destino#Sección|la sección]] → [[Destino renombrado#Sección|la sección]]')
  await k.screenshot({ path: `${SHOTS}/movida-fuera-vista-previa.png`, animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Actualizar 2 enlaces' }).click()
  await expect(k.getByRole('status').filter({ hasText: 'Enlaces actualizados: 2.' })).toBeVisible()
  await expect(card).toHaveCount(0)
  expect(disk(origin)).toContain('- [[Destino renombrado]] por nombre\n- [[Destino renombrado#Sección|la sección]] con ancla')
  // The links resolve again: open it and follow one.
  await k.goto(`/?note=${encodeURIComponent(origin)}`)
  await k.locator('.cm-wikilink-resolved a', { hasText: 'la sección' }).click()
  await expect(k.locator('.crumbs b')).toHaveText('Destino renombrado')
  await k.context().close()
})

test("the other tool fixing the links itself makes the alert go away", async ({ browser }) => {
  const dest = `${DIR}/Otra.md`
  const origin = `${DIR}/Enlaza a otra.md`
  writeFileSync(`${NOTES}/${dest}`, '# Otra\n')
  writeFileSync(`${NOTES}/${origin}`, '# Enlaza\n\n[[Otra]]\n')
  const k = await signIn(browser, 'noa')
  // Indexed before it moves (the rescan runs every 5 s, the watcher sooner).
  await expect.poll(async () => (await k.request.get(`/api/note/links?path=${encodeURIComponent(origin)}`)).ok(), { timeout: 20_000 }).toBe(true)
  renameSync(`${NOTES}/${dest}`, `${NOTES}/${DIR}/Otra más.md`)
  await k.goto('/?view=avisos')
  const card = k.locator('.alert-card', { hasText: `${dest} se movió` })
  await expect(async () => { await k.reload(); await expect(card).toBeVisible({ timeout: 1000 }) }).toPass({ timeout: 20_000 })
  writeFileSync(`${NOTES}/${origin}`, '# Enlaza\n\n[[Otra más]]\n')
  await expect(async () => { await k.reload(); await expect(card).toHaveCount(0, { timeout: 1000 }) }).toPass({ timeout: 20_000 })
  await k.context().close()
})
