// The frontmatter is protected in the editor, so losing it by accident never
// drops `ai: false` unnoticed: select all and
// delete, type over it or paste never reach it (its uid and `ai: false`
// stay), undo brings the body back, and in two sessions the other one sees
// the body go and the frontmatter stay; it is still edited by opening its
// folded block.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ADMIN, MEMBER, NOTES, inVault, specMother } from './env.ts'
import { signIn } from './helpers.ts'

const m = specMother(import.meta.url)
const DIR = inVault(m.aFolder())
const q = encodeURIComponent
const SLOW = { timeout: 15_000 }

/** A new note with a uid, `ai: false` and a tag in its frontmatter, and a body of a few lines. */
function aNote() {
  const path = `${DIR}/${m.aTitle()}.md`
  const fm = `---\nuid: ${m.faker.string.ulid({ refDate: '2026-01-01T00:00:00Z' })}\nai: false\ntags: [${m.aTag()}]\n---\n`
  const lines = [`# ${m.aHeading()}`, '', `${m.aSentence().slice(0, -1)} ${m.aUniqueWord()}.`, '', `${m.aSentence().slice(0, -1)} ${m.aUniqueWord()}.`]
  writeFileSync(`${NOTES}/${path}`, fm + lines.join('\n') + '\n')
  return { path, fm, lines, disk: () => (existsSync(`${NOTES}/${path}`) ? readFileSync(`${NOTES}/${path}`, 'utf8') : '') }
}

async function open(p: Page, path: string) {
  await p.goto(`/?note=${q(path)}`)
  await expect(p.locator('.cm-content')).toBeVisible()
  await expect(p.locator('.status')).toHaveText('Guardado en disco', SLOW)
}

test.describe.configure({ mode: 'serial' })
let k: Page
let a: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  k = await signIn(browser, ADMIN)
  a = await signIn(browser, MEMBER)
})

test('select all and delete empties the body, never the frontmatter (its uid and ai: false); undo brings the body back', async () => {
  const n = aNote()
  await open(k, n.path)
  await k.locator('.cm-line', { hasText: n.lines[2]!.slice(0, 10) }).click()
  await k.keyboard.press('ControlOrMeta+a')
  await k.keyboard.press('Delete')
  await expect.poll(n.disk, SLOW).toBe(n.fm)
  // Still folded, with its three keys: it was never touched.
  await expect(k.locator('.cm-frontmatter-chip')).toHaveText('frontmatter · 3 claves')
  await k.keyboard.press('ControlOrMeta+z')
  await expect.poll(n.disk, SLOW).toBe(n.fm + n.lines.join('\n') + '\n')
  // Typing over everything, and pasting over everything: the same.
  await k.keyboard.press('ControlOrMeta+a')
  const typed = m.aUniqueWord()
  await k.keyboard.type(typed)
  await expect.poll(n.disk, SLOW).toBe(n.fm + typed)
  await k.keyboard.press('ControlOrMeta+a')
  const pasted = `${m.aSentence()}\n`
  await k.evaluate((text) => {
    const data = new DataTransfer()
    data.setData('text/plain', text)
    document.querySelector('.cm-content')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, pasted)
  await expect.poll(n.disk, SLOW).toBe(n.fm + pasted)
  // Backspace at the start of the body never joins it to the frontmatter.
  await k.locator('.cm-line', { hasText: pasted.slice(0, 10) }).click()
  await k.keyboard.press('Home')
  await k.keyboard.press('Backspace')
  await k.keyboard.press('Backspace')
  await expect.poll(n.disk, SLOW).toBe(n.fm + pasted)
  await k.screenshot({ path: `${process.env.SHOTS ?? '/tmp'}/frontmatter-protected.png` })
})

test('two sessions: one empties the body, the other sees the frontmatter stay; it is edited by opening its block, and that reaches the first', async () => {
  const n = aNote()
  await open(k, n.path)
  await open(a, n.path)
  await expect(a.locator('.presence .avatar')).toHaveCount(2, SLOW)
  await a.locator('.cm-line', { hasText: n.lines[4]!.slice(0, 10) }).click()
  await a.keyboard.press('ControlOrMeta+a')
  await a.keyboard.press('Backspace')
  await expect.poll(n.disk, SLOW).toBe(n.fm)
  await expect(k.locator('.cm-line', { hasText: n.lines[2]!.slice(0, 10) })).toHaveCount(0, SLOW)
  await expect(k.locator('.cm-frontmatter-chip')).toHaveText('frontmatter · 3 claves')
  // The other opens the block from its chip and changes a key: that is how it is edited.
  await k.locator('.cm-frontmatter-chip button').click()
  await expect(k.locator('.cm-line', { hasText: 'ai: false' })).toBeVisible()
  await k.locator('.cm-line', { hasText: 'ai: false' }).click()
  await k.keyboard.press('End')
  await k.keyboard.press('Shift+Home')
  await k.keyboard.type('ai: true')
  await expect.poll(n.disk, SLOW).toBe(n.fm.replace('ai: false', 'ai: true'))
  await expect(a.locator('.cm-frontmatter-chip')).toHaveText('frontmatter · 3 claves')
  // Inside the open block, select all takes its YAML only; leaving it, the body.
  await k.keyboard.press('ControlOrMeta+a')
  const yaml = await k.evaluate(() => getSelection()?.toString() ?? '')
  expect(yaml).toContain('ai: true')
  expect(yaml).not.toContain('---')
})
