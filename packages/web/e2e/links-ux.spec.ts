// Link fixes (D-031): an ambiguous link opens a picker of its candidates
// (open one, or pin the link to it), and a note renamed outside thoth raises
// an alert whose «Update links» rewrites the links left behind.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, NOTES, specMother } from './env.ts'
import { editorText, signIn } from './helpers.ts'

const m = specMother(import.meta.url)
const DIR = m.aFolder()
const SHOTS = `${E2E_DIR}/shots`
const disk = (path: string) => readFileSync(`${NOTES}/${path}`, 'utf8')

test.describe.configure({ mode: 'serial' })
test.beforeAll(() => { mkdirSync(`${NOTES}/${DIR}`, { recursive: true }); mkdirSync(SHOTS, { recursive: true }) })

/** Words around the ambiguous link, on its line. */
const BEFORE = m.aWord()
const AFTER = m.aSentence()
/**
 * A note with an ambiguous [[Tareas]]: testdata/vault's proyectos/thoth and
 * proyectos/blog both have one, as close from here (an integration over the vault).
 */
function ambiguousNote(name: string, text = `# ${name}\n\n${BEFORE} [[Tareas]] ${AFTER}\n`) {
  const path = `${DIR}/${name}.md`
  writeFileSync(`${NOTES}/${path}`, text)
  return path
}

const picker = (page: Page) => page.getByRole('dialog', { name: '«Tareas» puede llevar a:' })
const ambiguousLink = (page: Page) => page.locator('.cm-wikilink-ambiguous a', { hasText: 'Tareas' })

test('the picker lists the candidates by title and path; «Pin» rewrites that link without leaving', async ({ browser }) => {
  const title = m.aTitle()
  const note = ambiguousNote(title)
  const k = await signIn(browser, ADMIN, note)
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
  await expect.poll(() => disk(note)).toContain(`${BEFORE} [[blog/Tareas]] ${AFTER}`)
  // Still here, and the link now resolves (it navigates on click).
  await expect(k.locator('.crumbs b')).toHaveText(title)
  await expect(k.locator('.cm-wikilink-resolved a', { hasText: 'blog/Tareas' })).toBeVisible()
  await k.context().close()
})

test('opening a candidate goes there and offers «Pin this destination», which rewrites the link in the note you came from', async ({ browser }) => {
  const title = m.aTitle()
  const label = m.aWord()
  const rest = m.aWord()
  const note = ambiguousNote(title, `# ${title}\n\n- [[Tareas|${label}]] ${rest}\n`)
  const k = await signIn(browser, ADMIN, note)
  await k.locator('.cm-wikilink-ambiguous a', { hasText: label }).click()
  await picker(k).getByRole('row', { name: /Tareas de thoth/ }).click()
  await expect(k.locator('.crumbs')).toHaveText('proyectos / thoth / Tareas')
  const offer = k.locator('.pin-offer')
  await expect(offer).toContainText(`Has llegado desde «Tareas», un enlace ambiguo de «${title}».`)
  await offer.getByRole('button', { name: 'Fijar este destino' }).click()
  await expect(offer).toContainText(`Fijado: en «${title}» el enlace ahora es [[thoth/Tareas|${label}]]`)
  expect(disk(note)).toContain(`- [[thoth/Tareas|${label}]] ${rest}`)
  // Nothing is written without that press: going elsewhere drops the offer.
  await k.goto(`/?note=${encodeURIComponent(note)}`)
  await expect(k.locator('.pin-offer')).toHaveCount(0)
  await k.context().close()
})

test('from the panel, with the keyboard: the picker opens on the link, arrows and Enter open a candidate', async ({ browser }) => {
  const note = ambiguousNote(m.aTitle())
  const k = await signIn(browser, ADMIN, note)
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
  expect(disk(note), 'opening writes nothing').toContain(`${BEFORE} [[Tareas]] ${AFTER}`)
  // Escape closes the picker without doing anything.
  await k.goto(`/?note=${encodeURIComponent(note)}`)
  await ambiguousLink(k).click()
  await expect(picker(k)).toBeVisible()
  await k.keyboard.press('Escape')
  await expect(picker(k)).toHaveCount(0)
  await k.context().close()
})

test('screenshots of the picker: light, dark and a phone', async ({ browser }) => {
  const note = ambiguousNote(m.aTitle())
  const k = await signIn(browser, ADMIN, note)
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
  const phone = await ctx.newPage()
  await phone.goto(`/?note=${encodeURIComponent(note)}`)
  await phone.getByLabel('Nombre de usuario').fill(ADMIN.username)
  await phone.getByLabel('Contraseña').fill(ADMIN.password)
  await phone.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(phone.locator('.cm-content')).toBeVisible()
  await ambiguousLink(phone).tap()
  const p = picker(phone)
  await expect(p).toBeVisible()
  const box = await p.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  // Full touch targets.
  expect((await p.getByRole('row').first().boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await phone.screenshot({ path: `${SHOTS}/selector-movil.png`, animations: 'disabled' })
  await ctx.close()
})

// --- A note renamed outside thoth -------------------------------------------------

test('renamed on disk: the alert says where it went and how many links point to the old path; «Update links» fixes them', async ({ browser }) => {
  // A note linked by name and by a heading, with a text of its own.
  const [name, renamedName, section, label, w1, w2] = [m.aTitle(), m.aTitle(), m.aHeading(), m.aUniqueWord(), m.aWord(), m.aWord()]
  const dest = `${DIR}/${name}.md`
  const origin = m.aNotePath(DIR)
  writeFileSync(`${NOTES}/${dest}`, `# ${name}\n\n## ${section}\n\n${m.aSentence()}\n`)
  writeFileSync(`${NOTES}/${origin}`, `# ${m.aHeading()}\n\n- [[${name}]] ${w1}\n- [[${name}#${section}|${label}]] ${w2}\n`)
  const k = await signIn(browser, ADMIN, origin)
  await expect(k.locator('.cm-wikilink-resolved a', { hasText: label })).toBeVisible()
  // Another tool renames it.
  renameSync(`${NOTES}/${dest}`, `${NOTES}/${DIR}/${renamedName}.md`)
  await k.goto('/?view=avisos')
  const card = k.locator('.alert-card', { hasText: 'se movió fuera de thoth' })
  await expect(async () => {
    await k.reload()
    await expect(card).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 20_000 })
  await expect(card.getByRole('heading')).toHaveText(`${dest} se movió fuera de thoth a ${DIR}/${renamedName}.md`)
  await expect(card).toContainText('2 enlaces siguen apuntando a la ruta antigua')
  expect(disk(origin), 'nothing rewritten on its own').toContain(`[[${name}]] ${w1}`)

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
  await expect(dialog).toContainText(`[[${name}#${section}|${label}]] → [[${renamedName}#${section}|${label}]]`)
  await k.screenshot({ path: `${SHOTS}/movida-fuera-vista-previa.png`, animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Actualizar 2 enlaces' }).click()
  await expect(k.getByRole('status').filter({ hasText: 'Enlaces actualizados: 2.' })).toBeVisible()
  await expect(card).toHaveCount(0)
  expect(disk(origin)).toContain(`- [[${renamedName}]] ${w1}\n- [[${renamedName}#${section}|${label}]] ${w2}`)
  // The links resolve again: open it and follow one.
  await k.goto(`/?note=${encodeURIComponent(origin)}`)
  await k.locator('.cm-wikilink-resolved a', { hasText: label }).click()
  await expect(k.locator('.crumbs b')).toHaveText(renamedName)
  await k.context().close()
})

test('the open note renamed on disk: the editor follows it (URL, tree), keeps what was typed, and offers to update the links', async ({ browser }) => {
  const [name, renamedName, w1] = [m.aTitle(), m.aTitle(), m.aWord()]
  const note = `${DIR}/${name}.md`
  const renamed = `${DIR}/${renamedName}.md`
  const origin = m.aNotePath(DIR)
  /** Lines typed: saved before the rename, sent just before it, and after it. */
  const [saved, sent, later] = [m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord()]
  writeFileSync(`${NOTES}/${note}`, `# ${name}\n\n${m.aSentence()}\n`)
  writeFileSync(`${NOTES}/${origin}`, `# ${m.aHeading()}\n\n- [[${name}]] ${w1}\n`)
  const k = await signIn(browser, ADMIN, note)
  await expect.poll(async () => (await (await k.request.get(`/api/note/links?path=${encodeURIComponent(note)}`)).json()).backlinks.length, { timeout: 20_000 }).toBe(1)
  await k.locator('.cm-h1').click()
  await k.keyboard.press('Control+End')
  await k.keyboard.type(`\n${saved}`)
  await expect.poll(() => disk(note)).toContain(saved)
  // Typed and sent, but not yet on disk, when another tool renames the file.
  await k.keyboard.type(`\n${sent}`)
  renameSync(`${NOTES}/${note}`, `${NOTES}/${renamed}`)

  await expect(k.locator('.crumbs b')).toHaveText(renamedName, { timeout: 15_000 })
  expect(new URL(k.url()).searchParams.get('note')).toBe(renamed)
  await expect(k.getByRole('row', { name: renamedName, exact: true })).toBeVisible()
  await expect(k.getByRole('row', { name, exact: true })).toHaveCount(0)
  await expect(k.locator('.cm-content')).toContainText(sent)
  await expect(k.getByRole('alert').filter({ hasText: 'se ha borrado fuera' })).toHaveCount(0)
  const toast = k.getByRole('status').filter({ hasText: 'se ha movido fuera de thoth' })
  await expect(toast).toHaveText(`«${name}» se ha movido fuera de thoth a ${renamed}: la nota lo ha seguido y lo que escribías está a salvo. 1 enlace sigue apuntando a la ruta antigua.`)
  await k.screenshot({ path: `${SHOTS}/movida-fuera-abierta.png`, animations: 'disabled' })

  // Editing goes on at the new path; everything is there once, and the old path stays gone.
  await k.locator('.cm-h1').click()
  await k.keyboard.press('Control+End')
  await k.keyboard.type(`\n${later}`)
  await expect.poll(() => disk(renamed)).toContain(later)
  for (const line of [saved, sent, later]) {
    expect(disk(renamed).split('\n').filter((l) => l === line), line).toHaveLength(1)
  }
  expect(existsSync(`${NOTES}/${note}`)).toBe(false)

  // «See alerts»: the alert offers to update the link left behind.
  await k.getByRole('button', { name: 'Ver avisos' }).click()
  const card = k.locator('.alert-card', { hasText: `${note} se movió fuera de thoth` })
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: 'Actualizar enlaces' }).click()
  await k.getByRole('dialog', { name: 'Actualizar enlaces' }).getByRole('button', { name: 'Actualizar 1 enlace' }).click()
  await expect(card).toHaveCount(0)
  expect(disk(origin)).toContain(`- [[${renamedName}]] ${w1}`)
  await k.context().close()
})

test("the other tool fixing the links itself makes the alert go away", async ({ browser }) => {
  const [name, renamedName, heading] = [m.aTitle(), m.aTitle(), m.aHeading()]
  const dest = `${DIR}/${name}.md`
  const origin = m.aNotePath(DIR)
  writeFileSync(`${NOTES}/${dest}`, `# ${name}\n`)
  writeFileSync(`${NOTES}/${origin}`, `# ${heading}\n\n[[${name}]]\n`)
  const k = await signIn(browser, ADMIN)
  // Indexed before it moves (the rescan runs every 5 s, the watcher sooner).
  await expect.poll(async () => (await k.request.get(`/api/note/links?path=${encodeURIComponent(origin)}`)).ok(), { timeout: 20_000 }).toBe(true)
  renameSync(`${NOTES}/${dest}`, `${NOTES}/${DIR}/${renamedName}.md`)
  await k.goto('/?view=avisos')
  const card = k.locator('.alert-card', { hasText: `${dest} se movió` })
  await expect(async () => { await k.reload(); await expect(card).toBeVisible({ timeout: 1000 }) }).toPass({ timeout: 20_000 })
  writeFileSync(`${NOTES}/${origin}`, `# ${heading}\n\n[[${renamedName}]]\n`)
  await expect(async () => { await k.reload(); await expect(card).toHaveCount(0, { timeout: 1000 }) }).toPass({ timeout: 20_000 })
  await k.context().close()
})
