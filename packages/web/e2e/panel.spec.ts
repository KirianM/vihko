// Note side panel: links, outline and comments inside the file,
// with two people at once.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, MEMBER, NOTES } from './env.ts'
import { editorText, literally, signIn } from './helpers.ts'

const NOTE = 'panel/comentarios.md'
const FILE = `${NOTES}/${NOTE}`
const BODY = `# Índice del índice

La propuesta inicial era usar Postgres con una tabla por tipo de nota.

## Almacenamiento

Texto del almacenamiento.

## Pruebas

Texto de las pruebas.
`
const ORIGINAL = `---\ntitle: Comentarios\n# comentario de YAML que no se toca\n---\n${BODY}`
const disk = () => readFileSync(FILE, 'utf8')
const SHOTS = `${E2E_DIR}/shots`
// An author is any username: letters of any script, digits, `.`, `_`, `-`.
const COMMENT = /<!-- @([\p{L}\p{N}._-]+) \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z · (↳ )?([^>]*) -->/u

test.describe.configure({ mode: 'serial' })
let k: Page
let a: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/panel`, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(FILE, ORIGINAL)
  k = await signIn(browser, ADMIN, NOTE)
  a = await signIn(browser, MEMBER, NOTE)
})

test('links: outgoing with their status, ambiguous with candidates, and navigation', async () => {
  await k.goto('/?note=diario/2026-09-24.md')
  await k.getByRole('tab', { name: /Enlaces/ }).click()
  const panel = k.getByRole('complementary', { name: 'Comentarios y contexto' })
  await expect(panel.getByText('ambiguo · 2')).toBeVisible()
  await expect(panel.getByRole('button', { name: /Plan\s*Plan\.md/ })).toBeVisible()
  await panel.getByRole('button', { name: 'proyectos/blog/Tareas.md' }).click()
  await expect(k.locator('.crumbs')).toHaveText('proyectos / blog / Tareas')
})

test('links: backlinks with context', async () => {
  await k.goto('/?note=proyectos/thoth/Plan.md')
  await k.getByRole('tab', { name: /Enlaces/ }).click()
  const backlink = k.locator('.backlink', { hasText: 'Notas de thoth' }).first()
  await expect(backlink).toContainText('resuelve a proyectos/thoth/Plan.md')
  await expect(backlink.locator('mark')).toHaveText('[[Plan]]')
  await backlink.click()
  await expect(k.locator('.crumbs b')).toHaveText('notas')
})

test('links: a note\'s links to itself are neither outgoing nor backlinks, and still show as working links in the editor', async () => {
  writeFileSync(`${NOTES}/panel/propia.md`, '# Propia\n\n## Índice\n\nVer [[#Índice]] y [[propia]]. También [[comentarios]].\n')
  await k.goto('/?note=panel/propia.md')
  await k.getByRole('tab', { name: /Enlaces/ }).click()
  const panel = k.getByRole('complementary', { name: 'Comentarios y contexto' })
  await expect(panel.getByRole('heading', { name: 'Salientes · 1' })).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Entrantes · 0' })).toBeVisible()
  await expect(panel.locator('.link-list').first().locator(':scope > li')).toHaveCount(1)
  await expect(panel.getByRole('button', { name: /comentarios/ })).toBeVisible()
  await expect(k.getByRole('tab', { name: /Enlaces/ })).toHaveText('Enlaces · 1')
  // In the text, [[propia]] still leads somewhere: not shown as missing.
  await expect(k.locator('.cm-wikilink-resolved', { hasText: 'propia' })).toHaveCount(1)
  await expect(k.locator('.cm-wikilink-missing')).toHaveCount(0)
})

test('outline: live headings; clicking one moves the cursor there', async () => {
  await k.goto(`/?note=${NOTE}`)
  await k.getByRole('tab', { name: 'Índice' }).click()
  const toc = k.locator('.toc-item')
  await expect(toc).toHaveText(['Índice del índice', 'Almacenamiento', 'Pruebas'])
  await toc.filter({ hasText: 'Pruebas' }).click()
  await expect(k.locator('.toc-current')).toHaveText('Pruebas')
  // What's typed shows up in the outline without saving or reloading (the member types it).
  await a.locator('.cm-line', { hasText: 'Texto de las pruebas' }).click()
  await a.keyboard.press('End')
  await a.keyboard.type('\n\n### Carga')
  await expect(toc).toHaveText(['Índice del índice', 'Almacenamiento', 'Pruebas', 'Carga'])
  await a.keyboard.press('Control+z')
  await expect(toc).toHaveCount(3)
})

test('commenting, seeing it live, replying: all inside the file, in the format described above', async () => {
  await k.getByRole('tab', { name: /Comentarios/ }).click()
  await a.getByRole('tab', { name: /Comentarios/ }).click()
  await expect(k.getByText('Esta nota no tiene comentarios', { exact: false })).toBeVisible()

  // The admin selects the sentence and comments.
  await k.locator('.cm-line', { hasText: 'usar Postgres' }).click()
  await k.keyboard.press('Home')
  await k.keyboard.press('Shift+End')
  await k.getByRole('button', { name: 'Comentar la selección' }).click()
  await expect(k.locator('.thread-draft .thread-quote')).toHaveText(/^«La propuesta inicial era usar Postgres con una .*…»$/)
  await k.getByRole('textbox', { name: 'Escribe un comentario…' }).fill('esto no, usa SQLite')
  await k.keyboard.press('Enter')

  await expect.poll(disk).toMatch(new RegExp(`tipo de nota\\.<!-- @${literally(ADMIN.username)} \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}Z · esto no, usa SQLite -->\\n\\n## Almacenamiento`))
  expect(disk().startsWith('---\ntitle: Comentarios\n# comentario de YAML que no se toca\n')).toBe(true)

  // The member sees it live: thread in the panel and the text highlighted; the syntax stays hidden.
  const thread = a.locator('.thread', { hasText: 'esto no, usa SQLite' })
  await expect(thread).toBeVisible()
  await expect(thread.locator('.comment b')).toHaveText(ADMIN.username)
  await expect(a.locator('.cm-commented')).toHaveText('La propuesta inicial era usar Postgres con una tabla por tipo de nota.')
  await expect.poll(() => editorText(a)).not.toContain('<!--')
  await expect(a.getByRole('tab', { name: 'Comentarios · 1' })).toBeVisible()

  // The member replies; the reply goes on its own line, with ↳.
  await thread.getByRole('button', { name: 'Responder' }).click()
  await a.getByRole('textbox', { name: 'Escribe una respuesta…' }).fill('de acuerdo, lo cambio')
  await a.keyboard.press('Enter')
  await expect.poll(disk).toMatch(new RegExp(`usa SQLite -->\\n<!-- @${literally(MEMBER.username)} \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}Z · ↳ de acuerdo, lo cambio -->\\n\\n## Almacenamiento`))
  const replies = k.locator('.thread').first().locator('.comment')
  await expect(replies).toHaveCount(2)
  await expect(replies.nth(1)).toHaveClass(/comment-reply/)
  const lines = disk().split('\n').filter((l) => l.includes('<!--'))
  expect(lines.map((l) => COMMENT.exec(l)?.slice(1))).toEqual([[ADMIN.username, undefined, 'esto no, usa SQLite'], [MEMBER.username, '↳ ', 'de acuerdo, lo cambio']])
})

test('screenshots: light, dark and narrow', async () => {
  await k.locator('.cm-h1').click()
  await k.screenshot({ path: `${SHOTS}/panel-light.png` })
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await k.screenshot({ path: `${SHOTS}/panel-dark.png` })
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
})

test('narrow screen: panel hidden, notice under the paragraph, and overlaid panel', async () => {
  await a.setViewportSize({ width: 900, height: 800 })
  await expect(a.getByRole('complementary', { name: 'Comentarios y contexto' })).toHaveCount(0)
  const notice = a.locator('.cm-comment-notice')
  await expect(notice).toHaveText('2 comentarios en este párrafoVer')
  await a.screenshot({ path: `${SHOTS}/panel-narrow.png` })
  await notice.click()
  const panel = a.getByRole('complementary', { name: 'Comentarios y contexto' })
  await expect(panel).toBeVisible()
  await expect(panel.locator('.thread-active')).toContainText('esto no, usa SQLite')
  await a.screenshot({ path: `${SHOTS}/panel-overlay.png` })
  await panel.getByRole('button', { name: 'Ocultar el panel lateral' }).click()
  await expect(panel).toHaveCount(0)
  await a.setViewportSize({ width: 1280, height: 800 })
})

// D-031.6: the index remembers the commented text as it first saw it.
const originals = async (p: Page) => {
  const r = await p.request.get(`/api/note/comments?path=${encodeURIComponent(NOTE)}`)
  return ((await r.json()) as { threads: { original: string; changed: boolean }[] }).threads.map((t) => [t.original, t.changed])
}
const SENTENCE = 'La propuesta inicial era usar Postgres con una tabla por tipo de nota.'

test('the text has changed: rewriting the commented sentence marks the thread for everyone; restoring it clears the mark', async () => {
  await expect.poll(() => originals(k)).toEqual([[SENTENCE, false]])
  const thread = (p: Page) => p.locator('.thread', { hasText: 'esto no, usa SQLite' })
  await expect(thread(k).locator('.thread-changed')).toHaveCount(0)

  await k.locator('.cm-line', { hasText: 'usar Postgres' }).click()
  await k.keyboard.press('Home')
  await k.keyboard.type('Al final no: ')
  for (const p of [k, a]) {
    await expect(thread(p).locator('.thread-changed-badge')).toHaveText('El texto ha cambiado')
    await expect(thread(p).locator('.thread-original')).toHaveText(/^Texto original: «La propuesta inicial era usar Postgres con una .*…»$/)
  }
  // The server says the same (it reads an open note as its editors have it);
  // once saved, the note file holds nothing of it.
  await expect.poll(() => originals(k)).toEqual([[SENTENCE, true]])
  await expect.poll(disk).toContain(`Al final no: ${SENTENCE}<!-- @${ADMIN.username} `)
  expect(disk()).not.toContain('Texto original')

  await k.screenshot({ path: `${SHOTS}/comment-changed-light.png` })
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await k.screenshot({ path: `${SHOTS}/comment-changed-dark.png` })
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
  await a.setViewportSize({ width: 390, height: 800 })
  await a.locator('.cm-comment-notice').click()
  await expect(thread(a).locator('.thread-changed-badge')).toBeVisible()
  await a.screenshot({ path: `${SHOTS}/comment-changed-390.png` })
  await a.getByRole('complementary', { name: 'Comentarios y contexto' }).getByRole('button', { name: 'Ocultar el panel lateral' }).click()
  await a.setViewportSize({ width: 1280, height: 800 })

  // Only spaces differ: not a change. Back to the words it had: no mark.
  // The line wraps now: clicked on its first row. Home twice: with leading
  // spaces the first one stops after them.
  const select = async (n: number) => {
    await k.locator('.cm-line', { hasText: 'propuesta inicial' }).click({ position: { x: 4, y: 6 } })
    await k.keyboard.press('Home')
    await k.keyboard.press('Home')
    for (let i = 0; i < n; i++) await k.keyboard.press('Shift+ArrowRight')
  }
  await select('Al final no: '.length)
  await k.keyboard.type('  ')
  await expect.poll(() => originals(k)).toEqual([[SENTENCE, false]])
  await expect(thread(k).locator('.thread-changed')).toHaveCount(0)
  await expect(thread(a).locator('.thread-changed')).toHaveCount(0)
  await select(2)
  await k.keyboard.press('Backspace')
  await expect.poll(disk).toContain(`

${SENTENCE}<!-- @${ADMIN.username} `)
})

// With the history on (the default), without asking: it can be reopened (resolved.spec.ts).
test('resolving deletes the thread from the file and leaves the text as it was', async () => {
  await expect(k.locator('.panel-note')).toContainText('quedan en el historial')
  await k.locator('.thread').first().getByRole('button', { name: 'Resolver' }).click()
  await expect(k.locator('.thread-confirm')).toHaveCount(0)
  await expect.poll(disk).not.toContain('<!--')
  expect(disk()).toContain(BODY)
  expect(disk().startsWith('---\ntitle: Comentarios\n# comentario de YAML que no se toca\n')).toBe(true)
  await expect(a.locator('.thread')).toHaveCount(0)
  await expect(a.locator('.cm-commented')).toHaveCount(0)
})

test('the panel remembers whether it was closed', async () => {
  await k.getByRole('button', { name: 'Ocultar el panel lateral' }).click()
  await k.reload()
  await expect(k.locator('.cm-content')).toBeVisible()
  await expect(k.getByRole('complementary', { name: 'Comentarios y contexto' })).toHaveCount(0)
  await k.getByRole('button', { name: 'Mostrar el panel lateral' }).click()
  await expect(k.getByRole('complementary', { name: 'Comentarios y contexto' })).toBeVisible()
})
