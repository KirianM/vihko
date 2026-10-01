// GFM tasks and tables in the editor: a checkbox that changes one character of
// the file (also with two people toggling at once), Enter and Ctrl+Enter on
// tasks, tables drawn outside the cursor with their source inside it, a table
// in a code block that stays code, and the phone layout.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, MEMBER, NOTES, inVault, specMother } from './env.ts'
import { signIn } from './helpers.ts'

const m = specMother(import.meta.url)
/** Words of a sentence, without its full stop. */
const words = (n?: number) => m.aSentence(n).slice(0, -1)
/** The tasks: open, done (it names someone), open; and one typed later. */
const BUY = words(3)
const CALL = `Llamar a ${m.aDisplayName()}`
const CHECK = words(3)
const NEW_TASK = words(2)
/** The table's headings and cells (its layout, alignments and Markdown are the case under test). */
const [COL1, COL2, COL3] = [m.aWord(), m.aWord(), m.aWord()]
const BOLD = words(2)
const CODE = m.aUniqueWord()
/**
 * The cell the tests click and type into, found by its text: a unique word, since
 * Playwright's `hasText` matches any part of a cell, in any case, and a title can be
 * one word the wide table's cells also use (`Algeciras` in «Rua algeciras orígenes»).
 */
const CELL = m.aUniqueWord()
const [QTY1, QTY2] = [m.anInt(1, 9), m.anInt(10, 99)]
const TYPED = m.aWord()
/** A table-like text in a code block. */
const [NOT1, NOT2] = [m.aUniqueWord(), m.aUniqueWord()]
const DIR = inVault(m.aFolder())
const NOTE = m.aNotePath(DIR)
const FILE = `${NOTES}/${NOTE}`
const SHOTS = `${E2E_DIR}/shots`
const disk = () => readFileSync(FILE, 'utf8')

/** Eight columns of three words: wider than a phone. */
const WIDE = `| ${Array.from({ length: 8 }, (_, i) => `${m.aWord()} ${i + 1}`).join(' | ')} |\n|${'---|'.repeat(8)}\n| ${Array.from({ length: 8 }, () => words(3)).join(' | ')} |\n`
// With a uid already: opening it doesn't add one, so the file changes only as the tests do.
const SOURCE = `---
uid: ${m.faker.string.ulid({ refDate: '2026-01-01T00:00:00Z' })}
---
# ${m.aHeading()}

- [ ] ${BUY}
- [x] ${CALL}
- [ ] ${CHECK}

| ${COL1} | ${COL2} | ${COL3} |
|:---------|---------:|:----:|
| **${BOLD}** | ${QTY1} | \`${CODE}\` |
| ${CELL} | ${QTY2} | [[Proxy]] |

\`\`\`
| a | b |
|---|---|
| ${NOT1} | ${NOT2} |
\`\`\`

${WIDE}
${m.aSentence()}
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
  k = await signIn(browser, ADMIN, NOTE)
  a = await signIn(browser, MEMBER, NOTE)
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
  await expect(k.locator('.cm-line', { hasText: BUY })).toHaveText(BUY)
  await expect(k.locator('.cm-task-done')).toHaveText(CALL)
  expect(await k.locator('.cm-task-done').evaluate((e) => getComputedStyle(e).textDecorationLine)).toBe('line-through')
})

test('clicking a checkbox changes one character of the file', async () => {
  const before = disk()
  await boxes(k).nth(0).click()
  await expect(boxes(k).nth(0)).toBeChecked()
  await expect.poll(disk).toContain(`- [x] ${BUY}`)
  expect(diff(before, disk())).toEqual([before.indexOf(`- [ ] ${BUY}`) + 3])
  // The cursor did not move there: the checkbox is still a checkbox.
  await expect(boxes(k)).toHaveCount(3)
  await expect(boxes(a).nth(0)).toBeChecked()
})

test('two people toggling different tasks at the same time: both changes land', async () => {
  const before = disk()
  await Promise.all([boxes(k).nth(1).click(), boxes(a).nth(2).click()])
  await expect.poll(disk).toContain(`- [ ] ${CALL}`)
  await expect.poll(disk).toContain(`- [x] ${CHECK}`)
  expect(diff(before, disk())).toHaveLength(2)
  for (const p of [k, a]) {
    await expect(boxes(p).nth(1)).not.toBeChecked()
    await expect(boxes(p).nth(2)).toBeChecked()
  }
})

test('keyboard: Ctrl+Enter toggles the task on the cursor line; Enter continues with a new task', async () => {
  await k.locator('.cm-line', { hasText: CALL }).click()
  await k.keyboard.press('End')
  // Typing in the task's text keeps the checkbox.
  await expect(boxes(k)).toHaveCount(3)
  await k.keyboard.press('Control+Enter')
  await expect.poll(disk).toContain(`- [x] ${CALL}\n`)
  await k.keyboard.press('Enter')
  await k.keyboard.type(NEW_TASK)
  await expect.poll(disk).toContain(`- [x] ${CALL}\n- [ ] ${NEW_TASK}\n- [x] ${CHECK}`)
  // Enter on the empty task ends the list.
  await k.keyboard.press('Enter')
  await k.keyboard.press('Enter')
  await expect.poll(disk).toContain(`- [ ] ${NEW_TASK}\n\n- [x] ${CHECK}`)
  await k.keyboard.press('Backspace')
  await expect.poll(disk).toContain(`- [ ] ${NEW_TASK}\n- [x] ${CHECK}`)
})

test('a table renders with the alignment of its delimiter row and inline Markdown as text', async () => {
  await k.locator('.cm-h1').click()
  const table = k.locator('.cm-table').first()
  await expect(table).toBeVisible()
  await expect(table.locator('th')).toHaveText([COL1, COL2, COL3])
  const align = await table.locator('th').evaluateAll((els) => els.map((e) => getComputedStyle(e).textAlign))
  expect(align).toEqual(['left', 'right', 'center'])
  await expect(table.locator('td strong')).toHaveText(BOLD)
  await expect(table.locator('td code')).toHaveText(CODE)
  await expect(table.locator('td .cm-link')).toHaveText('Proxy')
  await expect(k.locator('.cm-line', { hasText: '|---' })).toHaveCount(1) // only the one in the code block
})

test('a table in a code block stays code', async () => {
  await expect(k.locator('.cm-codeblock', { hasText: `| ${NOT1} | ${NOT2} |` })).toBeVisible()
  await expect(k.locator('.cm-table')).toHaveCount(2) // the product table and the wide one
})

test('clicking a cell shows the source with the cursor in that cell', async () => {
  await k.locator('.cm-table td', { hasText: CELL }).click()
  await expect(k.locator('.cm-line', { hasText: '|:---------|' })).toBeVisible()
  await expect(k.locator('.cm-table')).toHaveCount(1)
  await k.keyboard.type(`${TYPED} `)
  await expect.poll(disk).toContain(`| ${TYPED} ${CELL} | ${QTY2} | [[Proxy]] |`)
  // Leaving the table draws it again, from the text as written (not reformatted).
  await k.locator('.cm-h1').click()
  await expect(k.locator('.cm-table')).toHaveCount(2)
  await expect(k.locator('.cm-table td', { hasText: `${TYPED} ${CELL}` })).toBeVisible()
  expect(disk()).toContain(`|:---------|---------:|:----:|\n| **${BOLD}** | ${QTY1} | \`${CODE}\` |`)
  // The other person sees it drawn too.
  await expect(a.locator('.cm-table td', { hasText: `${TYPED} ${CELL}` })).toBeVisible()
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
  await page.getByLabel('Nombre de usuario').fill(ADMIN.username)
  await page.getByLabel('Contraseña').fill(ADMIN.password)
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
  expect(diff(before, disk())).toEqual([before.indexOf(`] ${BUY}`) - 1])
  await wrap.evaluate((e) => { e.scrollLeft = 200 })
  await page.screenshot({ path: `${SHOTS}/tasks-tables-390.png`, animations: 'disabled' })
  await ctx.close()
})
