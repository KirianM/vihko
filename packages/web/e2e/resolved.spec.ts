// Resolved comment threads from the history (D-032.5), with two people at
// once: resolving without asking (managed history), «Resolved» with who did
// it, reopening through the editor (the other one sees it come back live), a
// thread whose text is gone, and the history off as before.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, MEMBER, NOTES } from './env.ts'
import { literally, signIn, writeWorkspace } from './helpers.ts'

const NOTE = 'resueltos/Hilos.md'
const FILE = `${NOTES}/${NOTE}`
const FIRST = `<!-- @${MEMBER.username} 2026-09-20T10:00Z · ¿seguro? -->`
const REPLY = `<!-- @${ADMIN.username} 2026-09-20T10:05Z · ↳ sí, seguro -->`
const SECOND = `<!-- @${MEMBER.username} 2026-09-21T09:00Z · sobra -->`
const BODY = `# Hilos

Primera frase comentada.${FIRST}
${REPLY}

Segunda frase que se borrará.${SECOND}

Fin.
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
  mkdirSync(`${NOTES}/resueltos`, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(FILE, BODY)
  k = await signIn(browser, ADMIN, NOTE)
  a = await signIn(browser, MEMBER, NOTE)
})

test.afterAll(async () => {
  writeWorkspace()
  await expect.poll(() => status(k), { timeout: 20_000 }).toBe('managed')
})

test('with the history kept by thoth, resolving deletes at once; «Resolved» says who did it, for both', async () => {
  for (const p of [k, a]) await expect(panel(p).locator('.panel-note')).toContainText('quedan en el historial')
  await panel(k).locator('.thread', { hasText: '¿seguro?' }).getByRole('button', { name: 'Resolver' }).click()
  await expect(panel(k).locator('.thread-confirm')).toHaveCount(0)
  await expect.poll(disk).not.toContain('¿seguro?')
  expect(disk()).toContain(`\nPrimera frase comentada.\n\nSegunda frase que se borrará.<!-- @${MEMBER.username} `)
  await expect(panel(a).locator('.thread', { hasText: '¿seguro?' })).toHaveCount(0)

  // Folded, with the count. The member didn't resolve it: theirs comes from the history, once the text is saved.
  for (const p of [k, a]) {
    const toggle = resolvedToggle(p)
    await expect(toggle).toHaveText('Resueltos (1)', { timeout: 15_000 })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(panel(p).locator('.resolved-thread')).toHaveCount(0)
    await toggle.click()
    const card = panel(p).locator('.resolved-thread')
    await expect(card.locator('.resolved-quote')).toHaveText('«Primera frase comentada.»')
    await expect(named(card.locator('.comment').first(), MEMBER.username).first()).toBeVisible()
    await expect(card.locator('.comment').first()).toContainText('¿seguro?')
    await expect(card.locator('.resolved-by')).toHaveText(new RegExp(`^Resuelto por ${literally(ADMIN.username)} · (ahora mismo|hace \\d+ min)$`))
    // The replies, on demand.
    await expect(card.locator('.comment-reply')).toHaveCount(0)
    await card.getByRole('button', { name: 'Ver 1 respuesta' }).click()
    await expect(card.locator('.comment-reply')).toContainText('sí, seguro')
    await expect(card.getByRole('button', { name: 'Reabrir' })).toBeVisible()
  }
  await k.screenshot({ path: `${SHOTS}/resolved-light.png`, animations: 'disabled' })
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await k.screenshot({ path: `${SHOTS}/resolved-dark.png`, animations: 'disabled' })
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
})

test('reopening puts the thread back after its sentence, as it was; the other session sees it come back', async () => {
  await panel(a).locator('.resolved-thread', { hasText: '¿seguro?' }).getByRole('button', { name: 'Reabrir' }).click()
  await expect.poll(disk).toContain(`Primera frase comentada.${FIRST}\n${REPLY}\n\nSegunda`)
  for (const p of [k, a]) {
    await expect(panel(p).locator('.thread', { hasText: '¿seguro?' })).toBeVisible()
    await expect(resolvedToggle(p)).toHaveCount(0)
  }
  await expect(panel(a).locator('.thread-active')).toContainText('¿seguro?')
  await expect(k.locator('.cm-commented').first()).toHaveText('Primera frase comentada.')
})

test('a thread whose sentence was deleted can be read but not reopened; the sentence back, it can', async () => {
  await panel(k).locator('.thread', { hasText: 'sobra' }).getByRole('button', { name: 'Resolver' }).click()
  await expect.poll(disk).not.toContain('sobra')
  // The member deletes the sentence.
  await a.locator('.cm-line', { hasText: 'Segunda frase que se borrará.' }).click()
  await a.keyboard.press('End')
  await a.keyboard.press('Shift+Home')
  await a.keyboard.press('Backspace')
  await expect.poll(disk).not.toContain('Segunda frase')
  const toggle = resolvedToggle(k)
  await expect(toggle).toHaveText('Resueltos (1)', { timeout: 15_000 })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  const card = panel(k).locator('.resolved-thread', { hasText: 'sobra' })
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
  await expect(panel(a).locator('.resolved-thread', { hasText: 'sobra' }).getByRole('button', { name: 'Reabrir' })).toBeVisible()
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
  const thread = panel(k).locator('.thread', { hasText: '¿seguro?' })
  await thread.getByRole('button', { name: 'Resolver' }).click()
  await expect(thread.locator('.thread-confirm p')).toHaveText('¿Resolver? Se borrará de la nota y, sin historial, no se podrá recuperar.')
  await k.screenshot({ path: `${SHOTS}/comment-resolve-confirm.png`, animations: 'disabled' })
  await thread.getByRole('button', { name: 'Resolver y borrar' }).click()
  await expect.poll(disk).not.toContain('¿seguro?')
  await expect(resolvedToggle(k)).toHaveCount(0)
})
