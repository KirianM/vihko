// Code blocks in the editor: away from the cursor their fences are hidden and
// the language shows as a small label; with the cursor in the block the
// fences are back, to edit them. Also in a quote, and unclosed at the end.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, NOTES, freshFolder, inVault, specMother } from './env.ts'
import { signIn } from './helpers.ts'

const m = specMother(import.meta.url)
const DIR = inVault(freshFolder(() => m.aFolder()))
const NOTE = `${DIR}/${m.aTitle()}.md`
const SHOTS = `${E2E_DIR}/shots`
/** Each block's one line of code: words nothing else in the note has. */
const [CODE, PLAIN, QUOTED, LAST] = [m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord()]
// The languages and the fences are the case under test.
const TEXT = `# ${m.aHeading()}

${m.aSentence()}

\`\`\`ts
const ${CODE} = 1
\`\`\`

${m.aSentence()}

\`\`\`
${PLAIN}
\`\`\`

> \`\`\`js
> ${QUOTED}()
> \`\`\`

${m.aSentence()}

\`\`\`sh
echo ${LAST}
`

test.describe.configure({ mode: 'serial' })
let k: Page
test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(`${NOTES}/${NOTE}`, TEXT)
  k = await signIn(browser, ADMIN, NOTE)
})
test.afterAll(async () => {
  await k.context().close()
  rmSync(`${NOTES}/${DIR}`, { recursive: true, force: true, maxRetries: 10 })
})

/** The editor's lines that show a fence (no line of code has a backtick). */
const fences = () => k.locator('.cm-line', { hasText: '```' })

test('away from the cursor, the fences are hidden and each language is a label; the code shows', async () => {
  await expect(k.locator('.cm-line', { hasText: CODE })).toBeVisible()
  await expect(fences()).toHaveCount(0)
  await expect(k.locator('.cm-code-lang')).toHaveText(['ts', 'js', 'sh'])
  for (const line of [CODE, PLAIN, QUOTED, LAST]) await expect(k.locator('.cm-codeblock', { hasText: line })).toBeVisible()
  await k.screenshot({ path: `${SHOTS}/code-blocks-light.png` })
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await k.screenshot({ path: `${SHOTS}/code-blocks-dark.png` })
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
})

test('with the cursor in a block its fences are back, to edit them; the other blocks keep theirs hidden', async () => {
  await k.locator('.cm-line', { hasText: CODE }).click()
  await expect(fences()).toHaveText(['```ts', '```'])
  await expect(k.locator('.cm-code-lang')).toHaveText(['js', 'sh'])
  // Up from the code, onto its opening fence.
  await k.keyboard.press('ArrowUp')
  await k.keyboard.press('End')
  await k.keyboard.type('x')
  await expect(fences().first()).toHaveText('```tsx')
  await k.keyboard.press('Backspace')
  // Out of it again: hidden.
  await k.locator('.cm-h1').click()
  await expect(fences()).toHaveCount(0)
})
