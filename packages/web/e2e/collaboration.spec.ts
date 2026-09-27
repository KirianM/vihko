// Collaboration between people (M4), with two sessions of different users:
// someone who may only comment next to someone who edits (a read-only editor
// that says so, comments written by the server and seen live by the other),
// presence by person, access changed while the note is open, and a manager
// purging a version of a note, with the admin's notice.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { E2E_DIR, NOTES } from './env.ts'
import { editorText, signIn, writeWorkspace } from './helpers.ts'

const DIR = 'colab'
const NOTE = `${DIR}/Receta.md`
const SECRET_NOTE = `${DIR}/Secreto.md`
const SECRET = 'CLAVE-E2E-7731'
const SHOTS = `${E2E_DIR}/shots`
const disk = (p = NOTE) => readFileSync(`${NOTES}/${p}`, 'utf8')
const q = encodeURIComponent
const SLOW = { timeout: 20_000 }

/**
 * thoth.yaml: both edit the root, and `colab` is Ana's, shared with Noa at
 * `level`. Noa doesn't manage the root here: whoever does keeps managing
 * everything under it (D-040 3.5).
 */
function rules(level: 'read' | 'comment') {
  writeFileSync(`${NOTES}/thoth.yaml`, `permissions:\n  "":\n    grants: { noa: edit, ana: edit }\n  ${DIR}:\n    grants: { ana: manage, noa: ${level} }\n`)
}

const level = async (p: Page, path = NOTE) => ((await (await p.request.get(`/api/note?path=${q(path)}`)).json()) as { level?: string }).level
const panel = (p: Page) => p.getByRole('complementary', { name: 'Comentarios y contexto' })
const avatars = (p: Page) => p.locator('.presence .avatar')

test.describe.configure({ mode: 'serial' })
let k: Page
let a: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(`${NOTES}/${NOTE}`, '# Receta\n\nCon manzana.\n\nAl horno.\n')
  writeFileSync(`${NOTES}/${SECRET_NOTE}`, '# Secreto\n\nNada que ver aquí.\n')
  rules('comment')
  a = await signIn(browser, 'ana')
  await expect.poll(() => level(a), SLOW).toBe('manage')
  await a.goto(`/?note=${q(NOTE)}`)
  await expect(a.locator('.cm-content')).toBeVisible()
  k = await signIn(browser, 'noa', NOTE)
})

test.afterAll(async () => {
  writeWorkspace()
  await expect.poll(() => level(k), SLOW).toBe('manage')
})

test('with comment, the editor is read-only and says so; each person is in the note once, by who they are', async () => {
  await expect(k.locator('.status-readonly')).toHaveText('Solo comentarios')
  await expect(a.locator('.status-readonly')).toHaveCount(0)
  // Nothing typed goes in; no actions that write, no history.
  await k.locator('.cm-line', { hasText: 'Al horno.' }).click()
  await k.keyboard.type('NOA-TECLEA')
  await expect(k.locator('.cm-content')).not.toContainText('NOA-TECLEA')
  await expect(k.getByRole('button', { name: 'Más acciones' })).toHaveCount(0)
  await expect(panel(k).getByRole('tab', { name: 'Historial' })).toHaveCount(0)
  await expect(panel(a).getByRole('tab', { name: 'Historial' })).toBeVisible()

  // Presence: two people, each once, with their colour; another tab of Ana's is still Ana.
  for (const p of [k, a]) await expect(avatars(p)).toHaveCount(2)
  await expect(avatars(k).nth(0)).toHaveAttribute('title', 'ana')
  await expect(avatars(k).nth(1)).toHaveAttribute('title', 'noa')
  const again = await a.context().newPage()
  await again.goto(`/?note=${q(NOTE)}`)
  await expect(again.locator('.cm-content')).toBeVisible()
  await expect(avatars(again)).toHaveCount(2)
  await expect(avatars(k)).toHaveCount(2)
  await again.close()
  await k.screenshot({ path: `${SHOTS}/comment-only-light.png`, animations: 'disabled' })
})

test('a comment by someone who may only comment reaches the other editor live; they reply to others and resolve only their own', async () => {
  // Noa comments the sentence his cursor is in.
  await k.locator('.cm-line', { hasText: 'Con manzana.' }).click()
  await panel(k).getByRole('button', { name: 'Comentar la selección' }).click()
  await panel(k).getByPlaceholder('Escribe un comentario…').fill('Mejor con pera')
  await panel(k).locator('.thread-draft').getByRole('button', { name: 'Comentar' }).click()
  await expect(panel(a).locator('.thread', { hasText: 'Mejor con pera' })).toBeVisible()
  await expect(panel(k).locator('.thread', { hasText: 'Mejor con pera' })).toBeVisible()
  await expect.poll(() => disk()).toMatch(/Con manzana\.<!-- @noa \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z · Mejor con pera -->/)

  // Ana comments in her editor (she edits): Noa may reply to it, not resolve it.
  await a.locator('.cm-line', { hasText: 'Al horno.' }).click()
  await panel(a).getByRole('button', { name: 'Comentar la selección' }).click()
  await panel(a).getByPlaceholder('Escribe un comentario…').fill('¿Cuánto rato?')
  await panel(a).locator('.thread-draft').getByRole('button', { name: 'Comentar' }).click()
  const hers = panel(k).locator('.thread', { hasText: '¿Cuánto rato?' })
  await expect(hers).toBeVisible()
  await expect(hers.getByRole('button', { name: 'Resolver' })).toHaveCount(0)
  await hers.getByRole('button', { name: 'Responder' }).click()
  await hers.getByPlaceholder('Escribe una respuesta…').fill('Cuarenta minutos')
  await hers.getByRole('button', { name: 'Responder' }).click()
  await expect(panel(a).locator('.thread', { hasText: '¿Cuánto rato?' })).toContainText('Cuarenta minutos')

  // His own he resolves (asked first: he can't see the history to bring it back).
  const his = panel(k).locator('.thread', { hasText: 'Mejor con pera' })
  await his.getByRole('button', { name: 'Resolver' }).click()
  await his.getByRole('button', { name: 'Resolver y borrar' }).click()
  await expect(panel(a).locator('.thread', { hasText: 'Mejor con pera' })).toHaveCount(0)
  await expect.poll(() => disk()).not.toContain('Mejor con pera')
  // One of his with a reply from Ana: resolving it would take her words out too, so it isn't his to do (D-040 3.7).
  await k.locator('.cm-line', { hasText: 'Con manzana.' }).click()
  await panel(k).getByRole('button', { name: 'Comentar la selección' }).click()
  await panel(k).getByPlaceholder('Escribe un comentario…').fill('¿Y canela?')
  await panel(k).locator('.thread-draft').getByRole('button', { name: 'Comentar' }).click()
  const canela = (p: Page) => panel(p).locator('.thread', { hasText: '¿Y canela?' })
  await expect(canela(k).getByRole('button', { name: 'Resolver' })).toBeVisible()
  await canela(a).getByRole('button', { name: 'Responder' }).click()
  await canela(a).getByPlaceholder('Escribe una respuesta…').fill('Un poco')
  await canela(a).getByRole('button', { name: 'Responder' }).click()
  await expect(canela(k)).toContainText('Un poco')
  await expect(canela(k).getByRole('button', { name: 'Resolver' })).toHaveCount(0)
  await expect(canela(k).getByRole('button', { name: 'Responder' })).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/comment-resolve-others-light.png`, animations: 'disabled' })
  await canela(a).getByRole('button', { name: 'Resolver' }).click()
  await expect(canela(k)).toHaveCount(0)
  // Ana (edit) resolves anyone's.
  await expect(panel(a).locator('.thread', { hasText: '¿Cuánto rato?' }).getByRole('button', { name: 'Resolver' })).toBeVisible()
  expect(await editorText(a)).not.toContain('NOA-TECLEA')
})

test('access changed while the note is open: the editor reopens with the new mode at once', async () => {
  rules('read')
  await expect(k.locator('.status-readonly')).toHaveText('Solo lectura', SLOW)
  await expect(panel(k).getByRole('button', { name: 'Comentar la selección' })).toHaveCount(0)
  await expect(panel(k).locator('.thread', { hasText: '¿Cuánto rato?' }).getByRole('button', { name: 'Responder' })).toHaveCount(0)
  await expect(panel(k).locator('.panel-note')).toHaveText('Puedes leer los comentarios de esta nota, pero no añadirlos ni resolverlos.')
  await k.screenshot({ path: `${SHOTS}/read-only-light.png`, animations: 'disabled' })
  rules('comment')
  await expect(k.locator('.status-readonly')).toHaveText('Solo comentarios', SLOW)
  await expect(panel(k).getByRole('button', { name: 'Comentar la selección' })).toBeVisible()
  // And the text is still there, live: what Ana types reaches him.
  await a.locator('.cm-line', { hasText: 'Al horno.' }).click()
  await a.keyboard.press('End')
  await a.keyboard.type('\nANA-DESPUES')
  await expect(k.locator('.cm-content')).toContainText('ANA-DESPUES')
})

test('whoever manages the folder purges a version from the UI; the admin gets the notice, without the content', async () => {
  await a.goto(`/?note=${q(SECRET_NOTE)}`)
  await expect(a.locator('.cm-content')).toBeVisible()
  const versions = async () => ((await (await a.request.get(`/api/history/versions?path=${q(SECRET_NOTE)}`)).json()) as { versions: { id: string; authors: { name: string }[] }[] }).versions
  await expect.poll(async () => (await versions()).length, SLOW).toBeGreaterThan(0)
  const before = (await versions()).length
  // A secret pasted by mistake, and taken out of the note right after.
  await a.locator('.cm-line', { hasText: 'Nada que ver aquí.' }).click()
  await a.keyboard.press('End')
  await a.keyboard.type(`\nClave: ${SECRET}`)
  await expect.poll(async () => (await versions()).length, SLOW).toBe(before + 1)
  await a.keyboard.press('Home')
  await a.keyboard.press('Shift+End')
  await a.keyboard.type('Sin secreto.')
  await expect.poll(async () => (await versions()).length, SLOW).toBe(before + 2)

  await panel(a).getByRole('tab', { name: 'Historial' }).click()
  const rows = panel(a).locator('.h-row')
  await expect(rows).toHaveCount(before + 2)
  await rows.nth(1).click()
  await expect(a.locator('.v-band')).toBeVisible()
  await a.locator('.v-band').getByRole('button', { name: 'Purgar esta versión…' }).click()
  const dialog = a.getByRole('alertdialog')
  await expect(dialog.getByRole('heading')).toHaveText('¿Purgar esta versión de colab / Secreto?')
  await expect(dialog).toContainText('Versiones afectadas (1)')
  await expect(dialog).toContainText('No se puede deshacer.')
  await expect(dialog).not.toContainText(SECRET)
  await a.screenshot({ path: `${SHOTS}/purge-version-light.png`, animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Purgar la versión' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(a.locator('.v-band')).toHaveCount(0)
  await expect(rows).toHaveCount(before + 1)
  for (const v of await versions()) {
    const text = ((await (await a.request.get(`/api/history/version?path=${q(SECRET_NOTE)}&id=${v.id}`)).json()) as { text: string | null }).text ?? ''
    expect(text).not.toContain(SECRET)
  }

  // The admin: who purged what, never the content; dismissed, it's gone.
  await k.goto('/?view=avisos')
  const card = k.locator('.alert-card', { hasText: 'ana purgó una versión del historial' })
  await expect(card).toBeVisible()
  await expect(card).toContainText(SECRET_NOTE)
  await expect(k.locator('.alerts-page')).not.toContainText(SECRET)
  await k.screenshot({ path: `${SHOTS}/purge-alert-light.png`, animations: 'disabled' })
  await card.getByRole('button', { name: 'Entendido' }).click()
  await expect(card).toHaveCount(0)
  // Ana, who isn't the admin, never had it.
  await a.goto('/?view=avisos')
  await expect(a.locator('.alerts-page h1')).toBeVisible()
  await expect(a.locator('.alert-card', { hasText: 'purgó' })).toHaveCount(0)
})
