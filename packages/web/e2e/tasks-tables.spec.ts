// GFM tasks and tables in the editor: a checkbox that changes one character of
// the file (also with two people toggling at once), Enter and Ctrl+Enter on
// tasks, tables drawn outside the cursor with their source inside it, a table
// in a code block that stays code, and the phone layout.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { E2E_DIR, NOTES, PASSWORD } from './env.ts'
import { signIn } from './helpers.ts'

const DIR = 'tareas'
const NOTE = `${DIR}/Tareas y tablas.md`
const FILE = `${NOTES}/${NOTE}`
const SHOTS = `${E2E_DIR}/shots`
const disk = () => readFileSync(FILE, 'utf8')

const WIDE = `| ${Array.from({ length: 8 }, (_, i) => `Columna ${i + 1}`).join(' | ')} |\n|${'---|'.repeat(8)}\n| ${Array.from({ length: 8 }, (_, i) => `valor bastante largo ${i + 1}`).join(' | ')} |\n`
const SOURCE = `---
uid: 01K5TASKSTAB7ES00000000000
---
# Tareas y tablas

- [ ] Comprar té
- [x] Llamar a Ana
- [ ] Revisar la tabla

| Producto | Cantidad | Nota |
|:---------|---------:|:----:|
| **Té verde** | 2 | \`oolong\` |
| Café | 10 | [[Proxy]] |

\`\`\`
| a | b |
|---|---|
| no es | tabla |
\`\`\`

${WIDE}
Fin.
`

/** Where two texts differ: each index with a different character (same length required). */
function diff(a: string, b: string) {
  expect(b.length).toBe(a.length)
  return [...a].flatMap((c, i) => (c === b[i] ? [] : [i]))
}

test.describe.configure({ mode: 'serial' })
let k: Page
let a: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(FILE, SOURCE)
  k = await signIn(browser, 'noa', NOTE)
  a = await signIn(browser, 'ana', NOTE)
})

test.afterAll(async () => {
  await a.context().close()
  const res = await k.request.delete(`/api/note?path=${encodeURIComponent(NOTE)}`)
  expect(res.ok()).toBe(true)
  await k.context().close()
})

const boxes = (p: Page) => p.locator('.cm-task input')

test('tasks show a checkbox in place of the marker; done ones are struck through', async () => {
  await expect(boxes(k)).toHaveCount(3)
  await expect(boxes(k).nth(0)).not.toBeChecked()
  await expect(boxes(k).nth(1)).toBeChecked()
  await expect(k.locator('.cm-line', { hasText: 'Comprar té' })).toHaveText('Comprar té')
  await expect(k.locator('.cm-task-done')).toHaveText('Llamar a Ana')
  expect(await k.locator('.cm-task-done').evaluate((e) => getComputedStyle(e).textDecorationLine)).toBe('line-through')
})

test('clicking a checkbox changes one character of the file', async () => {
  const before = disk()
  await boxes(k).nth(0).click()
  await expect(boxes(k).nth(0)).toBeChecked()
  await expect.poll(disk).toContain('- [x] Comprar té')
  expect(diff(before, disk())).toEqual([before.indexOf('- [ ] Comprar té') + 3])
  // The cursor did not move there: the checkbox is still a checkbox.
  await expect(boxes(k)).toHaveCount(3)
  await expect(boxes(a).nth(0)).toBeChecked()
})

test('two people toggling different tasks at the same time: both changes land', async () => {
  const before = disk()
  await Promise.all([boxes(k).nth(1).click(), boxes(a).nth(2).click()])
  await expect.poll(disk).toContain('- [ ] Llamar a Ana')
  await expect.poll(disk).toContain('- [x] Revisar la tabla')
  expect(diff(before, disk())).toHaveLength(2)
  for (const p of [k, a]) {
    await expect(boxes(p).nth(1)).not.toBeChecked()
    await expect(boxes(p).nth(2)).toBeChecked()
  }
})

test('keyboard: Ctrl+Enter toggles the task on the cursor line; Enter continues with a new task', async () => {
  await k.locator('.cm-line', { hasText: 'Llamar a Ana' }).click()
  await k.keyboard.press('End')
  // Typing in the task's text keeps the checkbox.
  await expect(boxes(k)).toHaveCount(3)
  await k.keyboard.press('Control+Enter')
  await expect.poll(disk).toContain('- [x] Llamar a Ana\n')
  await k.keyboard.press('Enter')
  await k.keyboard.type('Nueva tarea')
  await expect.poll(disk).toContain('- [x] Llamar a Ana\n- [ ] Nueva tarea\n- [x] Revisar la tabla')
  // Enter on the empty task ends the list.
  await k.keyboard.press('Enter')
  await k.keyboard.press('Enter')
  await expect.poll(disk).toContain('- [ ] Nueva tarea\n\n- [x] Revisar la tabla')
  await k.keyboard.press('Backspace')
  await expect.poll(disk).toContain('- [ ] Nueva tarea\n- [x] Revisar la tabla')
})

test('a table renders with the alignment of its delimiter row and inline Markdown as text', async () => {
  await k.locator('.cm-h1').click()
  const table = k.locator('.cm-table').first()
  await expect(table).toBeVisible()
  await expect(table.locator('th')).toHaveText(['Producto', 'Cantidad', 'Nota'])
  const align = await table.locator('th').evaluateAll((els) => els.map((e) => getComputedStyle(e).textAlign))
  expect(align).toEqual(['left', 'right', 'center'])
  await expect(table.locator('td strong')).toHaveText('Té verde')
  await expect(table.locator('td code')).toHaveText('oolong')
  await expect(table.locator('td .cm-link')).toHaveText('Proxy')
  await expect(k.locator('.cm-line', { hasText: '|---' })).toHaveCount(1) // only the one in the code block
})

test('a table in a code block stays code', async () => {
  await expect(k.locator('.cm-codeblock', { hasText: '| no es | tabla |' })).toBeVisible()
  await expect(k.locator('.cm-table')).toHaveCount(2) // the product table and the wide one
})

test('clicking a cell shows the source with the cursor in that cell', async () => {
  await k.locator('.cm-table td', { hasText: 'Café' }).click()
  await expect(k.locator('.cm-line', { hasText: '|:---------|' })).toBeVisible()
  await expect(k.locator('.cm-table')).toHaveCount(1)
  await k.keyboard.type('Buen ')
  await expect.poll(disk).toContain('| Buen Café | 10 | [[Proxy]] |')
  // Leaving the table draws it again, from the text as written (not reformatted).
  await k.locator('.cm-h1').click()
  await expect(k.locator('.cm-table')).toHaveCount(2)
  await expect(k.locator('.cm-table td', { hasText: 'Buen Café' })).toBeVisible()
  expect(disk()).toContain('|:---------|---------:|:----:|\n| **Té verde** | 2 | `oolong` |')
  // The other person sees it drawn too.
  await expect(a.locator('.cm-table td', { hasText: 'Buen Café' })).toBeVisible()
})

test('screenshots: light and dark', async () => {
  await k.locator('.cm-h1').click()
  expect(await k.locator('.cm-scroller').evaluate((e) => e.scrollWidth - e.clientWidth)).toBe(0)
  await k.screenshot({ path: `${SHOTS}/tasks-tables-light.png` })
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await k.screenshot({ path: `${SHOTS}/tasks-tables-dark.png` })
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
})

test('phone: a wide table scrolls inside itself and a tap toggles a task', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'es-ES' })
  const page = await ctx.newPage()
  await page.goto(`/?note=${encodeURIComponent(NOTE)}`)
  await page.getByLabel('Nombre de usuario').fill('noa')
  await page.getByLabel('Contraseña').fill(PASSWORD)
  await page.getByRole('button', { name: 'Entrar' }).last().tap()
  await expect(page.locator('.cm-table').last()).toBeVisible()
  const wrap = page.locator('.cm-table-wrap').last()
  const sizes = await wrap.evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }))
  expect(sizes.scroll).toBeGreaterThan(sizes.client)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  // Nor does the editor itself scroll sideways: the table stays within the text column.
  expect(await page.locator('.cm-scroller').evaluate((e) => e.scrollWidth - e.clientWidth)).toBe(0)
  // The touch area around the checkbox is at least 44 px.
  const area = await page.locator('.cm-task').first().evaluate((e) => {
    const s = getComputedStyle(e, '::after')
    return [parseFloat(s.width), parseFloat(s.height)]
  })
  expect(Math.min(...area)).toBeGreaterThanOrEqual(44)
  const before = disk()
  // A tap next to the box, inside that area, toggles it.
  const box = (await page.locator('.cm-task input').first().boundingBox())!
  await page.touchscreen.tap(box.x - 8, box.y + box.height / 2)
  await expect.poll(disk).not.toBe(before)
  // The first task's, not its neighbour's: their touch areas don't overlap.
  expect(diff(before, disk())).toEqual([before.indexOf('] Comprar té') - 1])
  await wrap.evaluate((e) => { e.scrollLeft = 200 })
  await page.screenshot({ path: `${SHOTS}/tasks-tables-390.png`, animations: 'disabled' })
  await ctx.close()
})
