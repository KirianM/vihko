// Templates marked in their frontmatter, and searching by frontmatter fields:
// a folder's notes marked as templates from its menu (how many first, then
// each one marked and nothing else of it changed), a new note from one with
// its frontmatter but not the mark, a template unmarked from its note's menu;
// and the ⌘K box finding notes by `key:value` and `prop:key`, templates only
// when asked for. It works in a folder of its own, in the admin's space.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, NOTES, freshFolder, personal, specMother } from './env.ts'
import { literally, signIn, spaceTree } from './helpers.ts'

const m = specMother(import.meta.url)
const SHOTS = `${E2E_DIR}/shots`
const MINE = personal(ADMIN)
/** The folder of templates, with one note in it and one in a subfolder. */
const FOLDER = freshFolder(() => m.aUniqueWord(), { in: MINE })
const SUB = m.aUniqueWord()
/** Names, each a word no other name contains: a row or an option found by one is that one. */
const ONE = m.aUniqueWord()
const TWO = m.aUniqueWord()
const PLAIN = m.aUniqueWord()
const OTHER = m.aUniqueWord()
const NEW = m.aUniqueWord()
/** A frontmatter value the template and a plain note share, and a key only the plain note has. */
const TYPE = m.aUniqueWord()
const KEY = m.aUniqueWord()
const VALUE = m.aUniqueWord()
const COMMENT = m.aSentence()
const path = {
  one: `${MINE}/${FOLDER}/${ONE}.md`,
  two: `${MINE}/${FOLDER}/${SUB}/${TWO}.md`,
  plain: `${MINE}/${PLAIN}.md`,
  other: `${MINE}/${OTHER}.md`,
  fresh: `${MINE}/${NEW}.md`,
}
const TEXT = {
  // Key order, a comment of its own line and one after a value: all kept, byte for byte.
  one: `---\n# ${COMMENT}\ntype: ${TYPE}   # ${COMMENT}\n---\n# {{title}}\n\n${m.aSentence()}\n`,
  two: `# {{title}}\n`,
  plain: `---\ntype: ${TYPE.toUpperCase()}\n${KEY}: [${m.aUniqueWord()}, ${VALUE}]\n---\n# ${PLAIN}\n`,
  other: `---\ntype: ${m.aUniqueWord()}\n---\n# ${OTHER}\n`,
}
const read = (p: string) => (existsSync(`${NOTES}/${p}`) ? readFileSync(`${NOTES}/${p}`, 'utf8') : null)
/** A note's text without the `uid` vihko gives it on its first write. */
const withoutUid = (text: string | null) => text?.replace(/^uid: \S+\n/m, '').replace(/^---\n---\n/, '') ?? null

let k: Page
const mine = () => spaceTree(k, 'Mis notas')
const row = (name: string) => mine().getByRole('row', { name: new RegExp(`^${literally(name)}`) })
const palette = () => k.getByRole('dialog', { name: 'Buscar o crear' })
/** The titles of what the ⌘K box finds for `q`. */
async function found(q: string): Promise<string[]> {
  await k.keyboard.press('Control+k')
  await palette().getByRole('textbox').fill(q)
  // The results for it, once they are in (until then, the recent notes or «loading»).
  const results = palette().getByRole('group', { name: 'Notas' })
  await expect(results.or(palette().getByText('Ninguna nota coincide.'))).toBeVisible()
  const titles = (await results.locator('.palette-title').allInnerTexts()).map((t) => t.split(/\s/)[0]!)
  await k.keyboard.press('Escape')
  await expect(palette()).toHaveCount(0)
  return titles.sort()
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${MINE}/${FOLDER}/${SUB}`, { recursive: true })
  for (const [k, p] of Object.entries(path)) if (k in TEXT) writeFileSync(`${NOTES}/${p}`, TEXT[k as keyof typeof TEXT])
  k = await signIn(browser, ADMIN)
  await expect.poll(async () => ((await (await k.request.get('/api/tree')).json()) as { notes: { path: string }[] }).notes.filter((n) => Object.values(path).includes(n.path)).length).toBe(4)
})

// The other specs share the notes folder: everything goes as it was.
test.afterAll(async () => {
  for (const p of Object.values(path)) if (existsSync(`${NOTES}/${p}`)) await k.request.delete(`/api/note?path=${encodeURIComponent(p)}`)
  rmSync(`${NOTES}/${MINE}/${FOLDER}`, { recursive: true, force: true, maxRetries: 10 })
  await k.context().close()
})

test('a folder\'s notes marked as templates: first how many, then each one marked, nothing else of it changed', async () => {
  await k.goto('/')
  await row(FOLDER).click()
  await row(SUB).click()
  await expect(row(TWO)).toBeVisible()
  await row(FOLDER).click({ button: 'right' })
  await k.getByRole('menuitem', { name: 'Marcar notas como plantillas…' }).click()
  const dialog = k.getByRole('alertdialog')
  await expect(dialog.getByRole('heading')).toHaveText(`Marcar las notas de «${FOLDER}» como plantillas`)
  await expect(dialog.getByRole('list', { name: 'Qué pasará' })).toHaveText('2 notas pasan a ser plantillas')
  for (const theme of ['light', 'dark'] as const) {
    await k.emulateMedia({ colorScheme: theme })
    await k.screenshot({ path: `${SHOTS}/templates-mark-${theme}.png`, animations: 'disabled' })
  }
  await k.emulateMedia({ colorScheme: null })
  // Nothing written until confirmed.
  expect(read(path.one)).toBe(TEXT.one)
  await dialog.getByRole('button', { name: 'Marcar como plantillas' }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => withoutUid(read(path.one))).toBe(`---\n# ${COMMENT}\ntype: ${TYPE}   # ${COMMENT}\ntemplate: true\n---\n# {{title}}\n\n${TEXT.one.split('\n\n')[1]}`)
  await expect.poll(() => withoutUid(read(path.two))).toBe(`---\ntemplate: true\n---\n${TEXT.two}`)
  // The tree marks them; the others, not.
  await expect(row(ONE)).toContainText('Plantilla')
  await expect(row(TWO)).toContainText('Plantilla')
  await expect(row(PLAIN)).not.toContainText('Plantilla')
  await k.screenshot({ path: `${SHOTS}/templates-tree.png`, animations: 'disabled' })
})

test('a new note from a template: its text and frontmatter, without the mark', async () => {
  await k.goto('/')
  await k.locator('nav.sidebar').getByRole('button', { name: 'Nueva nota' }).click()
  const create = k.getByRole('dialog', { name: 'Nueva nota' })
  await create.getByRole('textbox').fill(NEW)
  const option = create.getByRole('option', { name: `Crear «${NEW}» con la plantilla ${ONE}` })
  await expect(option).toBeVisible()
  await expect(create.getByRole('option', { name: `Crear «${NEW}» con la plantilla ${TWO}` })).toBeVisible()
  for (const theme of ['light', 'dark'] as const) {
    await k.emulateMedia({ colorScheme: theme })
    await k.screenshot({ path: `${SHOTS}/templates-offered-${theme}.png`, animations: 'disabled' })
  }
  await k.emulateMedia({ colorScheme: null })
  await option.click()
  await expect(k.locator('.crumbs b')).toHaveText(NEW)
  await expect.poll(() => read(path.fresh)).toMatch(new RegExp(`^---\\n# ${literally(COMMENT)}\\ntype: ${TYPE}   # ${literally(COMMENT)}\\nuid: \\w+\\n---\\n# ${NEW}\\n\\n`))
  expect(read(path.fresh)).not.toContain('template')
  await expect(row(NEW)).not.toContainText('Plantilla')
})

test('⌘K by frontmatter: key:value in any case, any item of a list, prop:, and -; templates only when asked for', async () => {
  await k.goto('/')
  await expect(row(PLAIN)).toBeVisible()
  await k.keyboard.press('Control+k')
  // The hints list the syntax.
  for (const example of ['tipo:decisión', 'prop:fecha', 'prop:tag=urgente']) await expect(palette().getByText(example, { exact: true })).toBeVisible()
  // And the names kept for vihko's own filters.
  await expect(palette().locator('.palette-reserved')).toHaveText('Nombres reservados, solo con prop: tag:path:is:has:in:prop:before:after:')
  await palette().getByRole('textbox').fill(`type:${TYPE}`)
  await expect(palette().getByRole('option').filter({ hasText: PLAIN })).toBeVisible()
  for (const theme of ['light', 'dark'] as const) {
    await k.emulateMedia({ colorScheme: theme })
    await k.screenshot({ path: `${SHOTS}/search-fields-${theme}.png`, animations: 'disabled' })
  }
  await k.emulateMedia({ colorScheme: null })
  // A query with a filter is a search, never a new note's name.
  await expect(palette().getByRole('option', { name: /^Crear/ })).toHaveCount(0)
  await k.keyboard.press('Escape')
  // The template (with the same type) only when asked for by its mark.
  expect(await found(`type:${TYPE}`)).toEqual([NEW, PLAIN].sort())
  expect(await found(`TYPE:${TYPE.toUpperCase()} template:true`)).toEqual(['{{title}}'])
  expect(await found(`${KEY}:${VALUE}`)).toEqual([PLAIN])
  expect(await found(`prop:${KEY}`)).toEqual([PLAIN])
  expect(await found(`type:${TYPE} -prop:${KEY}`)).toEqual([NEW])
  const others = await found(`-type:${TYPE} prop:type`)
  expect(others).toContain(OTHER)
  expect(others).not.toContain(PLAIN)
})

test('a template no more, from its note\'s menu: the mark goes, nothing else', async () => {
  await k.goto('/')
  await expect(row(FOLDER)).toBeVisible()
  if (await row(FOLDER).getAttribute('aria-expanded') !== 'true') await row(FOLDER).click()
  await row(ONE).click({ button: 'right' })
  await expect(k.getByRole('menuitem', { name: 'Convertir en plantilla' })).toHaveCount(0)
  await k.getByRole('menuitem', { name: 'Dejar de ser plantilla' }).click()
  await expect.poll(() => withoutUid(read(path.one))).toBe(TEXT.one)
  await expect(row(ONE)).not.toContainText('Plantilla')
  // And back, from the same menu.
  await row(ONE).click({ button: 'right' })
  await k.getByRole('menuitem', { name: 'Convertir en plantilla' }).click()
  await expect(row(ONE)).toContainText('Plantilla')
  expect(withoutUid(read(path.one))).toContain('template: true')
})
