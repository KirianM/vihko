// The formatting bar: above the editor on a computer, at the bottom on a
// phone (one row that scrolls sideways). What each button and shortcut writes
// in the file, taking it off again, the pressed state following the cursor,
// one undo step per press, nothing that writes below `edit`, and a change
// made in one session reaching another.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, MEMBER, NOTES, inVault, personal, specMother } from './env.ts'
import { signIn, usePermissions } from './helpers.ts'

const m = specMother(import.meta.url)
const DIR = inVault(m.aFolder())
/** A folder of the admin's own space, shared with the member below edit (sharing only adds: never inside the vault's space, where she edits). */
const RO_DIR = `${personal(ADMIN)}/${m.aFolder()}`
const SHOTS = `${E2E_DIR}/shots`
/** A line of three words no other line has (the last one is unique): short enough never to wrap. */
const line = () => [m.aWord(), m.aWord(), m.aUniqueWord()] as const
const text = (l: readonly string[]) => l.join(' ')

const bar = (p: Page) => p.getByRole('toolbar', { name: 'Formato' })
const tool = (p: Page, name: string) => bar(p).getByRole('button', { name, exact: true })
const q = (s: string) => encodeURIComponent(s)

/** A new note with `body` after a frontmatter with a uid (so opening it adds none): its path and its body on disk. */
function note(dir: string, body: string) {
  const path = `${dir}/${m.aTitle()}.md`
  writeFileSync(`${NOTES}/${path}`, `---\nuid: ${m.faker.string.ulid({ refDate: '2026-01-01T00:00:00Z' })}\n---\n${body}`)
  return { path, body: () => readFileSync(`${NOTES}/${path}`, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '') }
}

async function open(p: Page, path: string) {
  await p.goto(`/?note=${q(path)}`)
  await expect(p.locator('.cm-content')).toBeVisible()
}

/** The cursor at the end of the line with `words`, and the last word selected. */
async function selectLastWord(p: Page, words: readonly string[]) {
  await p.locator('.cm-line', { hasText: words[2] }).click()
  await p.keyboard.press('End')
  await p.keyboard.press('Shift+Control+ArrowLeft')
}

test.describe.configure({ mode: 'serial' })
let k: Page

test.beforeAll(async ({ browser }) => {
  for (const d of [DIR, RO_DIR]) mkdirSync(`${NOTES}/${d}`, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  k = await signIn(browser, ADMIN)
})
test.afterAll(async () => { await k.context().close() })

test('on a computer the bar sits above the editor, every button named, with its shortcut in its tooltip', async () => {
  const words = line()
  const n = note(DIR, `# ${m.aHeading()}\n\n${text(words)}\n`)
  await open(k, n.path)
  const box = (await bar(k).boundingBox())!
  const head = (await k.locator('.main-head').boundingBox())!
  const editor = (await k.locator('.cm-content').boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(head.y + head.height - 1)
  expect(box.y + box.height).toBeLessThanOrEqual(editor.y)
  for (const name of ['Estilo del texto', 'Negrita', 'Cursiva', 'Tachado', 'Código en línea', 'Insertar enlace', 'Enlazar nota', 'Añadir tag',
    'Lista con viñetas', 'Lista numerada', 'Lista de tareas', 'Cita', 'Bloque de código', 'Tabla', 'Insertar imagen', 'Comentar']) {
    await expect(tool(k, name)).toBeVisible()
  }
  // In one row, with the side panel open.
  await expect(k.getByRole('complementary', { name: 'Comentarios y contexto' })).toBeVisible()
  const tops = await bar(k).getByRole('button').evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().top)))])
  expect(tops).toHaveLength(1)
  // Tooltips show on hover once the pointer is in use (React Aria's modality): a click in the text first.
  await k.locator('.cm-line', { hasText: words[2] }).click()
  await tool(k, 'Negrita').hover()
  await expect(k.getByRole('tooltip')).toHaveText('Negrita (Ctrl+B)')
  await tool(k, 'Tachado').hover()
  await expect(k.getByRole('tooltip')).toHaveText('Tachado (Ctrl+Shift+S)')
  await tool(k, 'Código en línea').hover()
  await expect(k.getByRole('tooltip')).toHaveText('Código en línea (Ctrl+E)')
  await tool(k, 'Insertar enlace').hover()
  await expect(k.getByRole('tooltip')).toHaveText('Insertar enlace (Ctrl+K con texto seleccionado, o Ctrl+Alt+K)')
  // It stays while the note scrolls.
  await k.mouse.move(editor.x + 10, editor.y + 10)
  await k.mouse.wheel(0, 400)
  await expect(bar(k)).toBeInViewport()
})

test('bold, italic, strikethrough and inline code wrap the selection, show as such, and come off again', async () => {
  const words = line()
  const n = note(DIR, `${text(words)}\n`)
  await open(k, n.path)
  const [a, b, c] = words
  await selectLastWord(k, words)
  await tool(k, 'Negrita').click()
  await expect.poll(n.body).toBe(`${a} ${b} **${c}**\n`)
  await expect(tool(k, 'Negrita')).toHaveAttribute('aria-pressed', 'true')
  await expect(k.locator('.cm-content')).toBeFocused()
  await expect(k.locator('.cm-content .tok-strong', { hasText: c })).toBeVisible()
  // Pressed again, on the same selection: off.
  await tool(k, 'Negrita').click()
  await expect.poll(n.body).toBe(`${a} ${b} ${c}\n`)
  await expect(tool(k, 'Negrita')).toHaveAttribute('aria-pressed', 'false')
  await tool(k, 'Cursiva').click()
  await expect.poll(n.body).toBe(`${a} ${b} *${c}*\n`)
  await tool(k, 'Cursiva').click()
  await tool(k, 'Tachado').click()
  await expect.poll(n.body).toBe(`${a} ${b} ~~${c}~~\n`)
  await expect(k.locator('.cm-content .tok-strikethrough', { hasText: c })).toHaveCSS('text-decoration-line', 'line-through')
  await tool(k, 'Tachado').click()
  await tool(k, 'Código en línea').click()
  await expect.poll(n.body).toBe(`${a} ${b} \`${c}\`\n`)
  await expect(k.locator('.cm-content .tok-monospace', { hasText: c })).toBeVisible()
  await tool(k, 'Código en línea').click()
  await expect.poll(n.body).toBe(`${a} ${b} ${c}\n`)
})

test('shortcuts: Ctrl+B, Ctrl+I, Ctrl+Shift+S, Ctrl+E and Ctrl+Alt+K; Ctrl+K with no selection is still the palette', async () => {
  const words = line()
  const n = note(DIR, `${text(words)}\n`)
  await open(k, n.path)
  const [a, b, c] = words
  await selectLastWord(k, words)
  await k.keyboard.press('Control+b')
  await expect.poll(n.body).toBe(`${a} ${b} **${c}**\n`)
  await k.keyboard.press('Control+i')
  await expect.poll(n.body).toBe(`${a} ${b} ***${c}***\n`)
  await expect(tool(k, 'Cursiva')).toHaveAttribute('aria-pressed', 'true')
  await k.keyboard.press('Control+b')
  await k.keyboard.press('Control+i')
  await expect.poll(n.body).toBe(`${a} ${b} ${c}\n`)
  await k.keyboard.press('Control+Shift+s')
  await expect.poll(n.body).toBe(`${a} ${b} ~~${c}~~\n`)
  await expect(tool(k, 'Tachado')).toHaveAttribute('aria-pressed', 'true')
  await k.keyboard.press('Control+Shift+s')
  await expect.poll(n.body).toBe(`${a} ${b} ${c}\n`)
  await k.keyboard.press('Control+e')
  await expect.poll(n.body).toBe(`${a} ${b} \`${c}\`\n`)
  await expect(tool(k, 'Código en línea')).toHaveAttribute('aria-pressed', 'true')
  await k.keyboard.press('Control+e')
  await expect.poll(n.body).toBe(`${a} ${b} ${c}\n`)
  await expect(k.locator('.cm-content')).toBeFocused()
  await k.keyboard.press('Control+Alt+k')
  await k.keyboard.type('https://example.org/')
  await expect.poll(n.body).toBe(`${a} ${b} [${c}](https://example.org/)\n`)
  // Away from the cursor it shows as a link.
  await k.locator('.cm-line', { hasText: a }).click({ position: { x: 2, y: 5 } })
  await expect(k.locator('.cm-content .cm-link', { hasText: c })).toBeVisible()
  await k.keyboard.press('Control+k')
  await expect(k.getByRole('textbox', { name: 'Buscar' })).toBeVisible()
  await k.keyboard.press('Escape')
})

test('Ctrl+K over a selection makes it a link, as the button does, and the palette stays closed', async () => {
  const words = line()
  const n = note(DIR, `${text(words)}\n`)
  await open(k, n.path)
  const [a, b, c] = words
  await selectLastWord(k, words)
  await k.keyboard.press('Control+k')
  const url = `https://${m.aHost()}/${m.aWord()}`
  await k.keyboard.type(url)
  await expect.poll(n.body).toBe(`${a} ${b} [${c}](${url})\n`)
  await expect(k.getByRole('textbox', { name: 'Buscar' })).toHaveCount(0)
  await expect(k.locator('.cm-content')).toBeFocused()
  // With the cursor alone, in the same editor: the palette.
  await k.locator('.cm-line', { hasText: a }).click({ position: { x: 2, y: 5 } })
  await k.keyboard.press('Control+k')
  await expect(k.getByRole('textbox', { name: 'Buscar' })).toBeVisible()
  await k.keyboard.press('Escape')
  await expect.poll(n.body).toBe(`${a} ${b} [${c}](${url})\n`)
})

test('on Windows, a character typed with AltGr (Ctrl+Alt there) is not taken for Ctrl+Alt+K or Ctrl+Alt+D', async ({ browser }: { browser: Browser }) => {
  const words = line()
  const n = note(DIR, `${text(words)}\n`)
  const [a, b, c] = words
  // Today's note on, so that Ctrl+Alt+D has something to take.
  await usePermissions({ config: `daily:\n  ${m.anId()}:\n    label: ${JSON.stringify(m.aHeading())}\n    folder: ${JSON.stringify(inVault(m.aFolder()))}\n` })
  const ctx = await browser.newContext({ storageState: await k.context().storageState() })
  // Windows, as CodeMirror and vihko read it when they load.
  await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32' }))
  const p = await ctx.newPage()
  try {
    await open(p, n.path)
    await expect(p.locator('nav.sidebar').getByRole('button', { name: 'Nota de hoy' })).toBeVisible()
    await selectLastWord(p, words)
    /** A key pressed with AltGr as Windows reports it (Ctrl and Alt down, `key` what it types): whether something took it. */
    const altGr = (key: string, code: string) => p.locator('.cm-content').evaluate((el, [key, code]) => {
      const e = new KeyboardEvent('keydown', { key, code, ctrlKey: true, altKey: true, bubbles: true, cancelable: true })
      el.dispatchEvent(e)
      return e.defaultPrevented
    }, [key, code] as const)
    // AltGr+K and AltGr+D type «ł» and «đ» on some layouts (Czech, Hungarian…): nothing takes them, so they're typed.
    expect(await altGr('ł', 'KeyK')).toBe(false)
    expect(await altGr('đ', 'KeyD')).toBe(false)
    await expect(p.locator('.crumbs b')).toHaveText(n.path.slice(DIR.length + 1, -3))
    expect(n.body()).toBe(`${text(words)}\n`)
    // Where that key types no other character, it's the shortcut.
    expect(await altGr('k', 'KeyK')).toBe(true)
    await expect.poll(n.body).toBe(`${a} ${b} [${c}]()\n`)
  } finally {
    await ctx.close()
    await usePermissions()
  }
})

test('headings from the text style menu: the level shows on its button, the heading in the editor', async () => {
  const words = line()
  const n = note(DIR, `${m.aSentence()}\n\n${text(words)}\n`)
  await open(k, n.path)
  await k.locator('.cm-line', { hasText: words[2] }).click()
  await tool(k, 'Estilo del texto').click()
  const menu = k.getByRole('menu', { name: 'Estilo del texto' })
  await expect(menu.getByRole('menuitemradio', { name: 'Texto normal' })).toHaveAttribute('aria-checked', 'true')
  await k.screenshot({ path: `${SHOTS}/format-menu-light.png`, animations: 'disabled' })
  await menu.getByRole('menuitemradio', { name: 'Título 2' }).click()
  await expect.poll(n.body).toContain(`\n## ${text(words)}\n`)
  await expect(k.locator('.cm-content')).toBeFocused()
  await expect(k.locator('.cm-h2', { hasText: words[2] })).toBeVisible()
  await expect(tool(k, 'Estilo del texto')).toHaveAttribute('aria-pressed', 'true')
  await expect(tool(k, 'Estilo del texto')).toContainText('H2')
  await tool(k, 'Estilo del texto').click()
  await menu.getByRole('menuitemradio', { name: 'Título 1' }).click()
  await expect.poll(n.body).toContain(`\n# ${text(words)}\n`)
  await tool(k, 'Estilo del texto').click()
  await menu.getByRole('menuitemradio', { name: 'Texto normal' }).click()
  await expect.poll(n.body).toContain(`\n${text(words)}\n`)
  await expect(k.locator('.cm-h', { hasText: words[2] })).toHaveCount(0)
  await expect(tool(k, 'Estilo del texto')).toHaveAttribute('aria-pressed', 'false')
})

test('lists, tasks and quotes on every selected line; another kind replaces the marker; numbered from 1', async () => {
  const one = line()
  const two = line()
  const n = note(DIR, `${text(one)}\n${text(two)}\n`)
  await open(k, n.path)
  await k.locator('.cm-line', { hasText: one[2] }).click()
  await k.keyboard.press('Home')
  await k.keyboard.press('Shift+ArrowDown')
  await k.keyboard.press('Shift+End')
  await tool(k, 'Lista con viñetas').click()
  await expect.poll(n.body).toBe(`- ${text(one)}\n- ${text(two)}\n`)
  await expect(tool(k, 'Lista con viñetas')).toHaveAttribute('aria-pressed', 'true')
  await tool(k, 'Lista numerada').click()
  await expect.poll(n.body).toBe(`1. ${text(one)}\n2. ${text(two)}\n`)
  await expect(tool(k, 'Lista numerada')).toHaveAttribute('aria-pressed', 'true')
  await expect(tool(k, 'Lista con viñetas')).toHaveAttribute('aria-pressed', 'false')
  await tool(k, 'Lista de tareas').click()
  await expect.poll(n.body).toBe(`- [ ] ${text(one)}\n- [ ] ${text(two)}\n`)
  await tool(k, 'Lista de tareas').click()
  await expect.poll(n.body).toBe(`${text(one)}\n${text(two)}\n`)
  await tool(k, 'Cita').click()
  await expect.poll(n.body).toBe(`> ${text(one)}\n> ${text(two)}\n`)
  await expect(k.locator('.cm-quote')).toHaveCount(2)
  await tool(k, 'Cita').click()
  await expect.poll(n.body).toBe(`${text(one)}\n${text(two)}\n`)
  await tool(k, 'Bloque de código').click()
  await expect.poll(n.body).toBe(`\`\`\`\n${text(one)}\n${text(two)}\n\`\`\`\n`)
  await expect(k.locator('.cm-codeblock', { hasText: one[2] })).toBeVisible()
  await tool(k, 'Bloque de código').click()
  await expect.poll(n.body).toBe(`${text(one)}\n${text(two)}\n`)
})

test('a table: a GFM skeleton on its own lines, with its first header selected to type over', async () => {
  const words = line()
  const n = note(DIR, `${text(words)}\n`)
  await open(k, n.path)
  await k.locator('.cm-line', { hasText: words[2] }).click()
  await k.keyboard.press('End')
  await tool(k, 'Tabla').click()
  await expect.poll(n.body).toBe(`${text(words)}\n\n| Columna 1 | Columna 2 |\n| --- | --- |\n|  |  |\n`)
  const header = m.aWord()
  await k.keyboard.type(header)
  await expect.poll(n.body).toContain(`| ${header} | Columna 2 |`)
  // Away from the cursor, it's drawn as a table.
  await k.locator('.cm-line', { hasText: words[2] }).click()
  await expect(k.locator('.cm-table th', { hasText: header })).toBeVisible()
})

test('the pressed state follows the cursor, from the syntax tree', async () => {
  const [a, b, c, d] = [m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord()]
  const n = note(DIR, `### ${a}\n\n- **${b}** ~~${c}~~\n\n> *${d}*\n`)
  await open(k, n.path)
  await k.locator('.cm-line', { hasText: a }).click()
  await expect(tool(k, 'Estilo del texto')).toContainText('H3')
  await expect(tool(k, 'Lista con viñetas')).toHaveAttribute('aria-pressed', 'false')
  await k.getByText(b).click()
  await expect(tool(k, 'Negrita')).toHaveAttribute('aria-pressed', 'true')
  await expect(tool(k, 'Lista con viñetas')).toHaveAttribute('aria-pressed', 'true')
  await expect(tool(k, 'Tachado')).toHaveAttribute('aria-pressed', 'false')
  await expect(tool(k, 'Estilo del texto')).toHaveAttribute('aria-pressed', 'false')
  await k.getByText(c).click()
  await expect(tool(k, 'Tachado')).toHaveAttribute('aria-pressed', 'true')
  await expect(tool(k, 'Negrita')).toHaveAttribute('aria-pressed', 'false')
  await k.getByText(d).click()
  await expect(tool(k, 'Cursiva')).toHaveAttribute('aria-pressed', 'true')
  await expect(tool(k, 'Cita')).toHaveAttribute('aria-pressed', 'true')
  await expect(tool(k, 'Lista con viñetas')).toHaveAttribute('aria-pressed', 'false')
  await k.screenshot({ path: `${SHOTS}/format-light.png`, animations: 'disabled' })
  await k.emulateMedia({ colorScheme: 'dark' })
  await k.screenshot({ path: `${SHOTS}/format-dark.png`, animations: 'disabled' })
  await tool(k, 'Estilo del texto').click()
  await k.screenshot({ path: `${SHOTS}/format-menu-dark.png`, animations: 'disabled' })
  await k.keyboard.press('Escape')
  await k.emulateMedia({ colorScheme: 'light' })
})

test('one undo step per press: Ctrl+Z takes off the format, not what was typed just before', async () => {
  const words = line()
  const n = note(DIR, `${text(words)}\n`)
  await open(k, n.path)
  await k.locator('.cm-line', { hasText: words[2] }).click()
  await k.keyboard.press('End')
  const typed = m.aUniqueWord()
  await k.keyboard.type(` ${typed}`)
  await tool(k, 'Lista con viñetas').click()
  await expect.poll(n.body).toBe(`- ${text(words)} ${typed}\n`)
  await k.keyboard.press('Control+z')
  await expect.poll(n.body).toBe(`${text(words)} ${typed}\n`)
  await k.keyboard.press('Control+y')
  await expect.poll(n.body).toBe(`- ${text(words)} ${typed}\n`)
})

test('below edit, nothing that writes: no bar when reading, only «Comentar» with comment; Ctrl+K over a selection is the palette', async ({ browser }: { browser: Browser }) => {
  const words = line()
  const n = note(RO_DIR, `${text(words)}\n`)
  /** A word selected and Ctrl+K: the palette opens, and the note stays as it was. */
  const modK = async (p: Page) => {
    await selectLastWord(p, words)
    await p.keyboard.press('Control+k')
    await expect(p.getByRole('textbox', { name: 'Buscar' })).toBeVisible()
    await p.keyboard.press('Escape')
    await expect(p.getByRole('textbox', { name: 'Buscar' })).toHaveCount(0)
    expect(n.body()).toBe(`${text(words)}\n`)
  }
  const level = async (p: Page) => ((await (await p.request.get(`/api/note?path=${q(n.path)}`)).json()) as { level?: string }).level
  await usePermissions({ rules: { [RO_DIR]: { [MEMBER.username]: 'read' } } })
  const a = await signIn(browser, MEMBER)
  try {
    await expect.poll(() => level(a)).toBe('read')
    await open(a, n.path)
    await expect(a.locator('.status-readonly')).toHaveText('Solo lectura')
    await expect(bar(a)).toHaveCount(0)
    await modK(a)
    await usePermissions({ rules: { [RO_DIR]: { [MEMBER.username]: 'comment' } } })
    await expect.poll(() => level(a)).toBe('comment')
    await expect(a.locator('.status-readonly')).toHaveText('Solo comentarios', { timeout: 15_000 })
    await expect(bar(a).getByRole('button')).toHaveCount(1)
    await expect(tool(a, 'Comentar')).toBeVisible()
    await modK(a)
  } finally {
    await a.context().close()
    await usePermissions()
  }
})

test('two sessions: a format applied in one shows in the other at once', async ({ browser }: { browser: Browser }) => {
  const one = line()
  const two = line()
  const n = note(DIR, `${text(one)}\n\n${text(two)}\n`)
  await open(k, n.path)
  const a = await signIn(browser, MEMBER, n.path)
  try {
    await selectLastWord(k, one)
    await tool(k, 'Negrita').click()
    await expect(a.locator('.cm-content .tok-strong', { hasText: one[2] })).toBeVisible()
    await a.locator('.cm-line', { hasText: two[2] }).click()
    await tool(a, 'Estilo del texto').click()
    await a.getByRole('menuitemradio', { name: 'Título 2' }).click()
    // By its first word: the other person's cursor, at the end of the line, sits inside the text there.
    await expect(k.locator('.cm-h2', { hasText: two[0] })).toBeVisible()
    await expect.poll(n.body).toBe(`${one[0]} ${one[1]} **${one[2]}**\n\n## ${text(two)}\n`)
  } finally {
    await a.context().close()
  }
})

test('on a phone: at the bottom, in one row that scrolls sideways, and the keyboard stays open', async ({ browser }: { browser: Browser }) => {
  const words = line()
  const n = note(DIR, `# ${m.aHeading()}\n\n${text(words)}\n`)
  for (const scheme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'es-ES', colorScheme: scheme, storageState: await k.context().storageState() })
    const p = await ctx.newPage()
    try {
      await open(p, n.path)
      const box = (await bar(p).boundingBox())!
      expect(box.y + box.height).toBeLessThanOrEqual(844)
      expect(box.y + box.height).toBeGreaterThan(800)
      expect(box.width).toBe(390)
      const row = p.locator('.fmt-scroll')
      expect(await row.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
      // Saved: the icon alone (the text for screen readers and as its tooltip), so the buttons get the room.
      const status = bar(p).locator('.status', { hasText: 'Guardado en disco' })
      await expect(status).toHaveAttribute('title', 'Guardado en disco')
      expect((await status.locator('.status-label').boundingBox())!.width).toBeLessThanOrEqual(1)
      expect((await status.boundingBox())!.width).toBeLessThanOrEqual(44)
      await expect(p.getByRole('toolbar')).toHaveCount(1)
      // Only the edge with more buttons beyond it fades.
      await expect(row).toHaveAttribute('data-more-end', '')
      await expect(row).not.toHaveAttribute('data-more-start')
      await p.screenshot({ path: `${SHOTS}/format-mobile-start-${scheme}.png`, animations: 'disabled' })
      if (scheme === 'light') {
        await p.locator('.cm-line', { hasText: words[2] }).tap()
        // Inside the last word: from the end of the note (the line may wrap on a phone, and End stops where it does).
        await p.keyboard.press('Control+End')
        await p.keyboard.press('ArrowLeft')
        await p.keyboard.press('ArrowLeft')
        await tool(p, 'Negrita').tap()
        await expect.poll(n.body).toContain(`${words[0]} ${words[1]} **${words[2]}**\n`)
        // A button further along: the row scrolls to it, and the keyboard (the editor's focus) stays.
        await tool(p, 'Cita').tap()
        await expect.poll(n.body).toContain(`> ${words[0]} ${words[1]} **${words[2]}**\n`)
        expect(await row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
        await expect(p.locator('.cm-content')).toBeFocused()
      }
      // Scrolled part of the way both edges fade; at the end, only the start.
      await row.evaluate((el) => { el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2 })
      await expect(row).toHaveAttribute('data-more-start', '')
      await expect(row).toHaveAttribute('data-more-end', '')
      await p.screenshot({ path: `${SHOTS}/format-mobile-middle-${scheme}.png`, animations: 'disabled' })
      await row.evaluate((el) => { el.scrollLeft = el.scrollWidth })
      await expect(row).not.toHaveAttribute('data-more-end')
      await expect(row).toHaveAttribute('data-more-start', '')
      expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
      await p.screenshot({ path: `${SHOTS}/format-mobile-${scheme}.png`, animations: 'disabled' })
    } finally {
      await ctx.close()
    }
  }
})

test('on a phone, a save state that needs attention keeps its text in the bar', async ({ browser }: { browser: Browser }) => {
  const n = note(DIR, `${text(line())}\n`)
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'es-ES', storageState: await k.context().storageState() })
  const p = await ctx.newPage()
  // The connection to the note drops: as generation.spec does, by closing /collab.
  let offline = false
  const live: { close(): void }[] = []
  await p.routeWebSocket(/\/collab$/, (ws) => {
    if (offline) return void ws.close()
    live.push(ws, ws.connectToServer())
  })
  try {
    await open(p, n.path)
    await expect(bar(p).locator('.status-calm')).toHaveCount(1)
    offline = true
    for (const c of live.splice(0)) c.close()
    const status = bar(p).locator('.status', { hasText: 'Sin conexión' })
    await expect(status).toBeVisible()
    await expect(status).not.toHaveClass(/status-calm/)
    expect((await status.locator('.status-label').boundingBox())!.width).toBeGreaterThan(100)
    expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    await p.screenshot({ path: `${SHOTS}/format-mobile-offline-light.png`, animations: 'disabled' })
  } finally {
    await ctx.close()
  }
})
