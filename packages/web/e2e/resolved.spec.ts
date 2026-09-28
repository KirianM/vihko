// Resolved comment threads from the history (D-032.5), with two people at
// once: resolving without asking (managed history), «Resolved» with who did
// it, reopening through the editor (the other one sees it come back live), a
// thread whose text is gone, and the history off as before.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, MEMBER, NOTES, specMother } from './env.ts'
import { literally, signIn, writeWorkspace } from './helpers.ts'

const m = specMother(import.meta.url)
const DIR = m.aFolder()
const NOTE = m.aNotePath(DIR)
/** The commented sentences, and the comments: the first thread (with a reply) and the second. */
const [S1, S2] = [m.aSentence(), m.aSentence()]
const [C1, C2, C3] = [m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord()]
const FILE = `${NOTES}/${NOTE}`
const FIRST = `<!-- @${MEMBER.username} 2026-09-20T10:00Z · ${C1} -->`
const REPLY = `<!-- @${ADMIN.username} 2026-09-20T10:05Z · ↳ ${C2} -->`
const SECOND = `<!-- @${MEMBER.username} 2026-09-21T09:00Z · ${C3} -->`
const BODY = `# ${m.aHeading()}

${S1}${FIRST}
${REPLY}

${S2}${SECOND}

${m.aSentence()}
`
const disk = () => readFileSync(FILE, 'utf8')
const SHOTS = `${E2E_DIR}/shots`
const status = async (p: Page) => ((await (await p.request.get('/api/history/status')).json()) as { mode: string }).mode

test.describe.configure({ mode: 'serial' })
let k: Page
let a: Page
/** A name as a whole element (an author's), never as part of another name nor of the text around it. */
const named = (scope: Page | Locator, name: string) => scope.getByText(name, { exact: true })
const panel = (p: Page) => p.getByRole('complementary', { name: 'Comentarios y contexto' })
const resolvedToggle = (p: Page) => panel(p).getByRole('button', { name: /^Resueltos \(\d+\)$/ })

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(FILE, BODY)
  k = await signIn(browser, ADMIN, NOTE)
  a = await signIn(browser, MEMBER, NOTE)
})

test.afterAll(async () => {
  writeWorkspace()
  await expect.poll(() => status(k), { timeout: 20_000 }).toBe('managed')
})

test('with the history kept by vihko, resolving deletes at once; «Resolved» says who did it, for both', async () => {
  for (const p of [k, a]) await expect(panel(p).locator('.panel-note')).toContainText('quedan en el historial')
  await panel(k).locator('.thread', { hasText: C1 }).getByRole('button', { name: 'Resolver' }).click()
  await expect(panel(k).locator('.thread-confirm')).toHaveCount(0)
  await expect.poll(disk).not.toContain(C1)
  expect(disk()).toContain(`\n${S1}\n\n${S2}<!-- @${MEMBER.username} `)
  await expect(panel(a).locator('.thread', { hasText: C1 })).toHaveCount(0)

  // Folded, with the count. The member didn't resolve it: theirs comes from the history, once the text is saved.
  for (const p of [k, a]) {
    const toggle = resolvedToggle(p)
    await expect(toggle).toHaveText('Resueltos (1)', { timeout: 15_000 })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(panel(p).locator('.resolved-thread')).toHaveCount(0)
    await toggle.click()
    const card = panel(p).locator('.resolved-thread')
    await expect(card.locator('.resolved-quote')).toHaveText(`«${S1}»`)
    await expect(named(card.locator('.comment').first(), MEMBER.username).first()).toBeVisible()
    await expect(card.locator('.comment').first()).toContainText(C1)
    await expect(card.locator('.resolved-by')).toHaveText(new RegExp(`^Resuelto por ${literally(ADMIN.username)} · (ahora mismo|hace \\d+ min)$`))
    // The replies, on demand.
    await expect(card.locator('.comment-reply')).toHaveCount(0)
    await card.getByRole('button', { name: 'Ver 1 respuesta' }).click()
    await expect(card.locator('.comment-reply')).toContainText(C2)
    await expect(card.getByRole('button', { name: 'Reabrir' })).toBeVisible()
  }
  await k.screenshot({ path: `${SHOTS}/resolved-light.png`, animations: 'disabled' })
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await k.screenshot({ path: `${SHOTS}/resolved-dark.png`, animations: 'disabled' })
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
})

test('reopening puts the thread back after its sentence, as it was; the other session sees it come back', async () => {
  await panel(a).locator('.resolved-thread', { hasText: C1 }).getByRole('button', { name: 'Reabrir' }).click()
  await expect.poll(disk).toContain(`${S1}${FIRST}\n${REPLY}\n\n${S2}`)
  for (const p of [k, a]) {
    await expect(panel(p).locator('.thread', { hasText: C1 })).toBeVisible()
    await expect(resolvedToggle(p)).toHaveCount(0)
  }
  await expect(panel(a).locator('.thread-active')).toContainText(C1)
  await expect(k.locator('.cm-commented').first()).toHaveText(S1)
})

test('a thread whose sentence was deleted can be read but not reopened; the sentence back, it can', async () => {
  await panel(k).locator('.thread', { hasText: C3 }).getByRole('button', { name: 'Resolver' }).click()
  await expect.poll(disk).not.toContain(C3)
  // The member deletes the sentence.
  // The whole line selected (End and Home stop where a long line wraps): the DOM selection, which the editor takes.
  const line = a.locator('.cm-line', { hasText: S2 })
  await line.click()
  await line.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
  })
  await a.keyboard.press('Backspace')
  await expect.poll(disk).not.toContain(S2)
  const toggle = resolvedToggle(k)
  await expect(toggle).toHaveText('Resueltos (1)', { timeout: 15_000 })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  const card = panel(k).locator('.resolved-thread', { hasText: C3 })
  await expect(card.locator('.resolved-gone')).toHaveText('El texto comentado ya no está.')
  await expect(card.getByRole('button', { name: 'Reabrir' })).toHaveCount(0)
  // The member undoes it: it can be reopened again, live.
  await a.keyboard.press('Control+z')
  await expect(card.getByRole('button', { name: 'Reabrir' })).toBeVisible()
  await expect(card.locator('.resolved-gone')).toHaveCount(0)

  // On a phone, in the panel over the note.
  await a.setViewportSize({ width: 390, height: 800 })
  await a.getByRole('button', { name: 'Mostrar el panel lateral' }).click()
  await resolvedToggle(a).click()
  await expect(panel(a).locator('.resolved-thread', { hasText: C3 }).getByRole('button', { name: 'Reabrir' })).toBeVisible()
  await a.screenshot({ path: `${SHOTS}/resolved-390.png`, animations: 'disabled' })
  await panel(a).getByRole('button', { name: 'Ocultar el panel lateral' }).click()
  await a.setViewportSize({ width: 1280, height: 800 })
})

test('with the history off, resolving asks as before, and there is no «Resolved»', async () => {
  writeWorkspace('history:\n  mode: off\n')
  await expect.poll(() => status(k), { timeout: 20_000 }).toBe('off')
  const asked = k.waitForResponse((r) => r.url().includes('/api/history/status'))
  await k.reload()
  await expect(k.locator('.cm-content')).toBeVisible()
  await asked
  await expect(panel(k).locator('.panel-note')).toHaveText('Los comentarios se guardan dentro de la nota; al resolver se borran y, sin historial, no se pueden recuperar.')
  await expect(resolvedToggle(k)).toHaveCount(0)
  const thread = panel(k).locator('.thread', { hasText: C1 })
  await thread.getByRole('button', { name: 'Resolver' }).click()
  await expect(thread.locator('.thread-confirm p')).toHaveText('¿Resolver? Se borrará de la nota y, sin historial, no se podrá recuperar.')
  await k.screenshot({ path: `${SHOTS}/comment-resolve-confirm.png`, animations: 'disabled' })
  await thread.getByRole('button', { name: 'Resolver y borrar' }).click()
  await expect.poll(disk).not.toContain(C1)
  await expect(resolvedToggle(k)).toHaveCount(0)
})
