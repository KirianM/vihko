// Panel lateral de la nota: enlaces, índice y comentarios dentro del archivo (D-023)
// con dos personas a la vez.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { E2E_DIR, NOTES } from './env.ts'
import { editorText, signIn } from './helpers.ts'

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
const COMMENT = /<!-- @(\w+) \d{4}-\d{2}-\d{2} \d{2}:\d{2} · (↳ )?([^>]*) -->/

test.describe.configure({ mode: 'serial' })
let k: Page
let a: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/panel`, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(FILE, ORIGINAL)
  k = await signIn(browser, 'noa', NOTE)
  a = await signIn(browser, 'ana', NOTE)
})

test('enlaces: salientes con su estado, ambiguos con candidatos, y navegación', async () => {
  await k.goto('/?note=diario/2026-09-24.md')
  await k.getByRole('tab', { name: /Enlaces/ }).click()
  const panel = k.getByRole('complementary', { name: 'Comentarios y contexto' })
  await expect(panel.getByText('ambiguo · 2')).toBeVisible()
  await expect(panel.getByRole('button', { name: /Plan\s*Plan\.md/ })).toBeVisible()
  await panel.getByRole('button', { name: 'proyectos/blog/Tareas.md' }).click()
  await expect(k.locator('.crumbs')).toHaveText('proyectos / blog / Tareas')
})

test('enlaces: entrantes con contexto', async () => {
  await k.goto('/?note=proyectos/thoth/Plan.md')
  await k.getByRole('tab', { name: /Enlaces/ }).click()
  const backlink = k.locator('.backlink', { hasText: 'Notas de thoth' }).first()
  await expect(backlink).toContainText('resuelve a proyectos/thoth/Plan.md')
  await expect(backlink.locator('mark')).toHaveText('[[Plan]]')
  await backlink.click()
  await expect(k.locator('.crumbs b')).toHaveText('notas')
})

test('índice: encabezados en vivo; pulsar uno lleva el cursor allí', async () => {
  await k.goto(`/?note=${NOTE}`)
  await k.getByRole('tab', { name: 'Índice' }).click()
  const toc = k.locator('.toc-item')
  await expect(toc).toHaveText(['Índice del índice', 'Almacenamiento', 'Pruebas'])
  await toc.filter({ hasText: 'Pruebas' }).click()
  await expect(k.locator('.toc-current')).toHaveText('Pruebas')
  // Lo que se escribe aparece en el índice sin guardar ni recargar (lo escribe ana).
  await a.locator('.cm-line', { hasText: 'Texto de las pruebas' }).click()
  await a.keyboard.press('End')
  await a.keyboard.type('\n\n### Carga')
  await expect(toc).toHaveText(['Índice del índice', 'Almacenamiento', 'Pruebas', 'Carga'])
  await a.keyboard.press('Control+z')
  await expect(toc).toHaveCount(3)
})

test('comentar, verlo en vivo, responder: todo dentro del archivo con el formato de D-023', async () => {
  await k.getByRole('tab', { name: /Comentarios/ }).click()
  await a.getByRole('tab', { name: /Comentarios/ }).click()
  await expect(k.getByText('Esta nota no tiene comentarios', { exact: false })).toBeVisible()

  // noa selecciona la frase y comenta.
  await k.locator('.cm-line', { hasText: 'usar Postgres' }).click()
  await k.keyboard.press('Home')
  await k.keyboard.press('Shift+End')
  await k.getByRole('button', { name: 'Comentar la selección' }).click()
  await expect(k.locator('.thread-draft .thread-quote')).toHaveText(/^«La propuesta inicial era usar Postgres con una .*…»$/)
  await k.getByRole('textbox', { name: 'Escribe un comentario…' }).fill('esto no, usa SQLite')
  await k.keyboard.press('Enter')

  await expect.poll(disk).toMatch(/tipo de nota\.<!-- @noa \d{4}-\d{2}-\d{2} \d{2}:\d{2} · esto no, usa SQLite -->\n\n## Almacenamiento/)
  expect(disk().startsWith('---\ntitle: Comentarios\n# comentario de YAML que no se toca\n')).toBe(true)

  // ana lo ve en vivo: hilo en el panel y el texto resaltado; la sintaxis, oculta.
  const thread = a.locator('.thread', { hasText: 'esto no, usa SQLite' })
  await expect(thread).toBeVisible()
  await expect(thread.locator('.comment b')).toHaveText('noa')
  await expect(a.locator('.cm-commented')).toHaveText('La propuesta inicial era usar Postgres con una tabla por tipo de nota.')
  await expect.poll(() => editorText(a)).not.toContain('<!--')
  await expect(a.getByRole('tab', { name: 'Comentarios · 1' })).toBeVisible()

  // ana responde; la respuesta va en su línea, con ↳.
  await thread.getByRole('button', { name: 'Responder' }).click()
  await a.getByRole('textbox', { name: 'Escribe una respuesta…' }).fill('de acuerdo, lo cambio')
  await a.keyboard.press('Enter')
  await expect.poll(disk).toMatch(/usa SQLite -->\n<!-- @ana \d{4}-\d{2}-\d{2} \d{2}:\d{2} · ↳ de acuerdo, lo cambio -->\n\n## Almacenamiento/)
  const replies = k.locator('.thread').first().locator('.comment')
  await expect(replies).toHaveCount(2)
  await expect(replies.nth(1)).toHaveClass(/comment-reply/)
  const lines = disk().split('\n').filter((l) => l.includes('<!--'))
  expect(lines.map((l) => COMMENT.exec(l)?.slice(1))).toEqual([['noa', undefined, 'esto no, usa SQLite'], ['ana', '↳ ', 'de acuerdo, lo cambio']])
})

test('capturas: claro, oscuro y estrecho', async () => {
  await k.locator('.cm-h1').click()
  await k.screenshot({ path: `${SHOTS}/panel-light.png` })
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  await k.screenshot({ path: `${SHOTS}/panel-dark.png` })
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
})

test('pantalla estrecha: panel oculto, aviso bajo el párrafo y panel superpuesto', async () => {
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

test('resolver borra el hilo del archivo y deja el texto como estaba', async () => {
  await k.locator('.thread').first().getByRole('button', { name: 'Resolver' }).click()
  await expect.poll(disk).not.toContain('<!--')
  expect(disk()).toContain(BODY)
  expect(disk().startsWith('---\ntitle: Comentarios\n# comentario de YAML que no se toca\n')).toBe(true)
  await expect(a.locator('.thread')).toHaveCount(0)
  await expect(a.locator('.cm-commented')).toHaveCount(0)
})

test('el panel recuerda si estaba cerrado', async () => {
  await k.getByRole('button', { name: 'Ocultar el panel lateral' }).click()
  await k.reload()
  await expect(k.locator('.cm-content')).toBeVisible()
  await expect(k.getByRole('complementary', { name: 'Comentarios y contexto' })).toHaveCount(0)
  await k.getByRole('button', { name: 'Mostrar el panel lateral' }).click()
  await expect(k.getByRole('complementary', { name: 'Comentarios y contexto' })).toBeVisible()
})
