// End-to-end co-editing: two people on the same note, the file on disk as
// the source of truth, changes and deletions made outside thoth.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { ADMIN, MEMBER, NOTES } from './env.ts'
import { editorText, signIn } from './helpers.ts'

const NOTE = 'hogar/Proxy.md'
const FILE = `${NOTES}/${NOTE}`
const disk = () => (existsSync(FILE) ? readFileSync(FILE, 'utf8') : '')

test.describe.configure({ mode: 'serial' })
let k: Page
let a: Page

test.beforeAll(async ({ browser }) => {
  k = await signIn(browser, ADMIN, NOTE)
  a = await signIn(browser, MEMBER, NOTE)
})

test('on open: presence with distinct colors, saved, folded frontmatter and no marks', async () => {
  const avatars = k.locator('.presence .avatar')
  await expect(avatars).toHaveCount(2)
  const bgs = await avatars.evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor))
  expect(bgs[0]).not.toBe(bgs[1])
  await expect(k.locator('.status')).toHaveText('Guardado en disco')
  await expect(k.locator('.cm-frontmatter-chip')).toHaveText('frontmatter · 1 clave')
  await expect(k.locator('.cm-h1')).toHaveText('Proxy')
})

test('two people write at the same time and the file converges with an intact uid and frontmatter', async () => {
  await k.locator('.cm-content').click()
  await k.keyboard.press('Control+End')
  await k.keyboard.type(`\nEscrito por ${ADMIN.username} con **negrita** y [[Red]].`)
  await a.locator('.cm-line', { hasText: 'Red' }).first().click()
  await a.keyboard.press('End')
  await a.keyboard.type(`\nvmbr0 escrito por ${MEMBER.username}`)

  await expect.poll(disk).toContain(`Escrito por ${ADMIN.username} con **negrita** y [[Red]].`)
  await expect.poll(disk).toContain(`vmbr0 escrito por ${MEMBER.username}`)
  expect(disk()).toMatch(/^---\naliases: \[gw, Hipervisor\]\n/)
  expect(disk()).toMatch(/\nuid: [0-9A-Z]{26}\n/)
  await expect(k.locator('.status')).toHaveText('Guardado en disco')
  await expect.poll(() => editorText(a)).toContain(`Escrito por ${ADMIN.username}`)
  await expect.poll(() => editorText(k)).toContain(`vmbr0 escrito por ${MEMBER.username}`)
  await expect(k.locator('.cm-ySelectionCaret').first()).toBeAttached()
})

test('a change made outside thoth shows up live', async () => {
  writeFileSync(FILE, disk().replace('## Almacenamiento', '## Almacenamiento (editado fuera)'))
  await expect.poll(() => editorText(a)).toContain('(editado fuera)')
})

test('live preview: marks hidden outside the cursor and a resolved wikilink', async () => {
  await k.locator('.cm-h1').click()
  await expect(k.locator('.cm-line', { hasText: `Escrito por ${ADMIN.username}` })).toHaveText(`Escrito por ${ADMIN.username} con negrita y Red.`)
  await expect(k.locator('.cm-wikilink-resolved a', { hasText: 'Red' })).toBeVisible()
})

test('link statuses and navigation by alias', async () => {
  await k.goto('/?note=hogar/enlaces.md')
  await expect(k.locator('.cm-wikilink-missing').first()).toBeVisible()
  await k.locator('.cm-wikilink-resolved a', { hasText: 'gw' }).click()
  await expect(k.locator('.crumbs b')).toHaveText('Proxy')
})

test('deleted externally with the note open: alert, not recreated, and the copy is kept', async () => {
  // In the title: the middle of the text may land on a link, which navigates on click.
  await a.locator('.cm-h1').click()
  await a.keyboard.press('Control+End')
  await a.keyboard.type('\nlínea antes del borrado')
  await expect.poll(disk).toContain('antes del borrado')
  rmSync(FILE)
  await expect(a.getByRole('alert')).toContainText('se ha borrado fuera', { timeout: 15_000 }) // after the grace for a move (6 s)
  await a.keyboard.type('\nlínea después del borrado')
  await a.waitForTimeout(2000)
  expect(existsSync(FILE)).toBe(false)
  await a.getByRole('button', { name: 'Conservar mi copia' }).click()
  await expect.poll(disk).toContain('después del borrado')
  expect(disk()).toContain('antes del borrado')
  await expect(a.locator('.banner')).toHaveCount(0)
})

test('discarding the copy of a note deleted externally: once recreated, it reopens live on the same socket', async () => {
  const note = 'orphan-tests/Scratch note.md'
  const file = `${NOTES}/${note}`
  mkdirSync(`${NOTES}/orphan-tests`, { recursive: true })
  writeFileSync(file, '# Scratch note\n\nFirst version.\n')
  await a.goto(`/?note=${encodeURIComponent(note)}`)
  await expect(a.locator('.cm-content')).toBeVisible()
  rmSync(file)
  await expect(a.getByRole('alert')).toContainText('se ha borrado fuera', { timeout: 15_000 }) // after the grace for a move (6 s)
  await a.getByRole('button', { name: 'Descartar' }).click()
  await expect(a.locator('.banner')).toHaveCount(0)
  // Leave the note without reloading the page: the WebSocket stays the same.
  const open = async (query: string, crumb: string) => {
    await a.keyboard.press('Control+k')
    const palette = a.getByRole('dialog', { name: 'Buscar o crear' })
    await palette.getByRole('textbox').fill(query)
    await expect(palette.getByRole('option').first()).toContainText(crumb)
    await a.keyboard.press('Enter')
    await expect(a.locator('.crumbs b')).toHaveText(crumb)
  }
  await open('Proxy', 'Proxy')
  // The note comes back with the same path (restored from a backup, a sync tool…) and is opened again.
  writeFileSync(file, '# Scratch note\n\nSecond version.\n')
  await expect.poll(async () => (await (await a.request.get('/api/search?q=Scratch')).json()).results.length, { timeout: 15_000 }).toBe(1)
  await open('Scratch', 'Scratch note')
  await expect.poll(() => editorText(a)).toContain('Second version.')
  await a.waitForTimeout(1000)
  await a.locator('.cm-h1').click()
  await a.keyboard.press('Control+End')
  await a.keyboard.type('\nStill live.')
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('Still live.')
  await expect(a.locator('.status')).toHaveText('Guardado en disco')
})
