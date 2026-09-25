// Rename, move and trash from the UI, with the note open by two people. It
// creates its own notes at the start so it never touches other specs' notes.
import { expect, test, type Page } from '@playwright/test'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { E2E_DIR, NOTES, PASSWORD } from './env.ts'
import { editorText, png, sendFiles, signIn } from './helpers.ts'

const DIR = 'rename-tests'
const NOTE = `${DIR}/Server.md`
const RENAMED = `${DIR}/Main server.md`
const MOVED = `${DIR}/archive/Main server.md`
const LINKS = `${DIR}/links.md`
const read = (p: string) => (existsSync(`${NOTES}/${p}`) ? readFileSync(`${NOTES}/${p}`, 'utf8') : null)
const shot = (page: Page, name: string) => page.screenshot({ path: `${E2E_DIR}/shots/${name}.png` })

test.describe.configure({ mode: 'serial' })
let k: Page
let a: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  writeFileSync(`${NOTES}/${NOTE}`, '---\naliases: [srv]\n---\n# Server\n\n## Network\n')
  writeFileSync(`${NOTES}/${LINKS}`, [
    '# Links to Server', '',
    '- [[Server]] by name.',
    '- [[Server#Network]] with an anchor.',
    '- [[srv]] by alias.',
    '- [Server in Markdown](Server.md) relative.', '',
  ].join('\n'))
  k = await signIn(browser, 'noa', NOTE)
  // Until the index sees the links (watcher or rescan), the preview does not know them.
  await expect.poll(async () => (await (await k.request.get(`/api/note/links?path=${encodeURIComponent(NOTE)}`)).json()).backlinks.length, { timeout: 15_000 }).toBe(4)
  a = await signIn(browser, 'ana', NOTE)
})

async function openRename(page: Page) {
  await page.getByRole('button', { name: 'Más acciones' }).click()
  await page.getByRole('menuitem', { name: 'Renombrar o mover…' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

test('rename with preview: links are rewritten on disk and both editors follow the note', async () => {
  await expect(k.locator('.presence .avatar')).toHaveCount(2)
  await k.getByRole('row', { name: DIR }).click()
  await k.keyboard.press('ArrowRight')
  await expect(k.getByRole('row', { name: 'Server', exact: true })).toBeVisible()
  const dialog = await openRename(k)
  await expect(dialog.getByRole('heading')).toHaveText('Renombrar o mover «Server»')
  await expect(dialog.getByText('Escribe otro nombre u otra carpeta')).toBeVisible()
  await dialog.getByLabel('Nuevo nombre').fill('Main server')

  const rows = dialog.locator('.preview-row')
  await expect(rows).toHaveCount(4)
  await expect(rows.nth(0)).toHaveText('rename-tests / links[[Server]] → [[Main server]]')
  await expect(dialog.locator('.preview-change', { hasText: '[[Server#Network]] → [[Main server#Network]]' })).toBeVisible()
  await expect(dialog.locator('.preview-change', { hasText: '(Server.md) → [Server in Markdown](Main%20server.md)' })).toBeVisible()
  await expect(dialog.locator('.preview-kept')).toHaveText('rename-tests / links[[srv]] sigue funcionando por alias: no se toca')
  const submit = dialog.getByRole('button', { name: 'Renombrar y actualizar 3 enlaces' })
  await expect(submit).toBeEnabled()
  await shot(k, 'rename-light')

  // Ana types while noa renames: nothing is lost.
  await a.locator('.cm-content').click()
  await a.keyboard.press('Control+End')
  await a.keyboard.type('Written by ana before the rename.')
  await submit.click()

  for (const p of [k, a]) {
    await expect(p.locator('.crumbs b')).toHaveText('Main server')
    await expect(p).toHaveURL(/note=rename-tests%2FMain(\+|%20)server\.md/)
    await expect.poll(() => editorText(p)).toContain('Written by ana before the rename.')
  }
  await expect(k.locator('.presence .avatar')).toHaveCount(2)
  // The tree refreshes: the expanded folder shows the new name.
  await expect(k.getByRole('row', { name: 'Main server' })).toBeVisible()
  await expect(k.getByRole('row', { name: 'Server', exact: true })).toHaveCount(0)
  await expect(k.getByRole('dialog')).toHaveCount(0)
  await expect.poll(() => read(RENAMED)).toContain('Written by ana before the rename.')
  expect(read(NOTE)).toBeNull()
  await expect.poll(() => read(LINKS)).toContain('[Server in Markdown](Main%20server.md)')
  const links = read(LINKS)!
  expect(links).toContain('- [[Main server]] by name.')
  expect(links).toContain('- [[Main server#Network]] with an anchor.')
  expect(links).toContain('- [[srv]] by alias.')
  expect(links).toContain('[Server in Markdown](Main%20server.md)')

  // Ana keeps editing at the new path; the old one does not come back.
  await a.locator('.cm-content').click()
  await a.keyboard.press('Control+End')
  await a.keyboard.type(' And afterwards.')
  await expect.poll(() => read(RENAMED)).toContain('And afterwards.')
  await expect(k.locator('.status')).toHaveText('Guardado en disco')
  expect(read(NOTE)).toBeNull()
})

test('a name that already exists is explained and cannot be confirmed', async () => {
  const dialog = await openRename(k)
  await dialog.getByLabel('Nuevo nombre').fill('links')
  await expect(dialog.getByRole('alert')).toHaveText('Ya existe una nota con ese nombre.')
  await expect(dialog.getByRole('button', { name: 'Renombrar' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await expect(k.getByRole('dialog')).toHaveCount(0)
})

test('move to another folder: the button says "Mover" and only what would stop resolving changes', async () => {
  const dialog = await openRename(k)
  await dialog.getByLabel('Carpeta').fill(`${DIR}/archive`)
  await expect(dialog.locator('.preview-change')).toHaveText('[Server in Markdown](Main%20server.md) → [Server in Markdown](archive/Main%20server.md)')
  await expect(dialog.locator('.preview-kept', { hasText: '[[Main server]] sigue funcionando: no se toca' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Mover y actualizar 1 enlace' }).click()
  for (const p of [k, a]) {
    await expect(p.locator('.crumbs')).toHaveText('rename-tests / archive / Main server')
    await expect(p).toHaveURL(/archive/)
  }
  await expect.poll(() => read(MOVED)).toContain('And afterwards.')
  expect(read(RENAMED)).toBeNull()
  // The note moves first; the links follow (in the background if it takes long).
  await expect.poll(() => read(LINKS)).toContain('[Server in Markdown](archive/Main%20server.md)')
  expect(read(LINKS)).toContain('- [[Main server]] by name.')
})

test('trash: confirmation names the note, whoever had it open is told, and it restores', async () => {
  await k.getByRole('button', { name: 'Más acciones' }).click()
  await k.getByRole('menuitem', { name: 'Mover a la papelera' }).click()
  const confirm = k.getByRole('alertdialog')
  await expect(confirm.getByRole('heading')).toHaveText('¿Mover «Main server» a la papelera?')
  await shot(k, 'trash-confirm')
  await confirm.getByRole('button', { name: 'Mover a la papelera' }).click()

  await expect(k.getByRole('status').filter({ hasText: '«Main server» está en la papelera.' })).toBeVisible()
  await expect(k.locator('.cm-content')).toHaveCount(0)
  await expect(k.getByText('Elige una nota en el árbol.')).toBeVisible()
  await expect(k).not.toHaveURL(/note=/)
  await expect(k.getByRole('row', { name: 'Main server' })).toHaveCount(0)
  await expect(a.getByRole('alert')).toHaveText('noa ha movido «Main server» a la papelera mientras la tenías abierta.')
  await expect(a.locator('.cm-content')).toHaveCount(0)
  await shot(a, 'trash-other')
  // Nobody resurrects it: neither the editor that had it open nor a pending flush.
  await a.waitForTimeout(2000)
  expect(read(MOVED)).toBeNull()

  await k.getByRole('button', { name: 'Restaurar' }).click()
  await expect(k.locator('.crumbs b')).toHaveText('Main server')
  await expect.poll(() => editorText(k)).toContain('And afterwards.')
  expect(read(MOVED)).toContain('Written by ana before the rename.')
  await expect(k.getByRole('status').filter({ hasText: 'papelera' })).toHaveCount(0)
  // Ana, with nothing left to restore, reopens it with the same button.
  await a.getByRole('button', { name: 'Restaurar' }).click()
  await expect(a.locator('.crumbs b')).toHaveText('Main server')
  await expect.poll(() => editorText(a)).toContain('And afterwards.')
  // Both are on the same document again (same path, same socket as before the trash).
  await expect(k.locator('.presence .avatar')).toHaveCount(2)
  await k.locator('.cm-content').click()
  await k.keyboard.press('Control+End')
  await k.keyboard.type(' After the restore.')
  await expect.poll(() => editorText(a)).toContain('After the restore.')
})

test('screenshots: menu, dialog in dark and on mobile', async ({ browser }) => {
  await k.getByRole('button', { name: 'Más acciones' }).click()
  await expect(k.getByRole('menuitem')).toHaveCount(3)
  await shot(k, 'menu')
  await k.keyboard.press('Escape')
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  const dialog = await openRename(k)
  await dialog.getByLabel('Nuevo nombre').fill('Home server')
  await expect(dialog.locator('.preview-row').first()).toBeVisible()
  await shot(k, 'rename-dark')
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const m = await ctx.newPage()
  await m.goto(`/?note=${encodeURIComponent(MOVED)}`)
  await m.getByLabel('Nombre de usuario').fill('noa')
  await m.getByLabel('Contraseña').fill(PASSWORD)
  await m.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(m.locator('.cm-content')).toBeVisible()
  await shot(m, 'header-mobile')
  const md = await openRename(m)
  await md.getByLabel('Nuevo nombre').fill('Home server')
  await expect(md.locator('.preview-row').first()).toBeVisible()
  await shot(m, 'rename-mobile')
  await md.getByRole('button', { name: 'Cancelar' }).click()
  await ctx.close()
})

test('a link that cannot be rewritten: the notice names the note and the alias that keeps it working', async () => {
  const target = `${DIR}/Target.md`
  const locked = `${DIR}/locked`
  mkdirSync(`${NOTES}/${locked}`, { recursive: true })
  writeFileSync(`${NOTES}/${target}`, '# Target\n')
  writeFileSync(`${NOTES}/${locked}/Linker.md`, 'See [[Target]].\n')
  await k.goto(`/?note=${encodeURIComponent(target)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  await expect.poll(async () => (await (await k.request.get(`/api/note/links?path=${encodeURIComponent(target)}`)).json()).backlinks.length, { timeout: 15_000 }).toBe(1)
  // A folder thoth cannot write to: the rewrite of Linker fails.
  chmodSync(`${NOTES}/${locked}`, 0o555)
  try {
    // Some network filesystems (NFS with ACLs) ignore the mode bits: then there's no failure to show.
    let enforced = false
    try { writeFileSync(`${NOTES}/${locked}/probe`, '') } catch { enforced = true }
    test.skip(!enforced, 'the notes folder ignores permissions (network filesystem): run with E2E_DIR on a local disk')
    const dialog = await openRename(k)
    await dialog.getByLabel('Nuevo nombre').fill('Target renamed')
    await dialog.getByRole('button', { name: 'Renombrar y actualizar 1 enlace' }).click()
    await expect(k.locator('.crumbs b')).toHaveText('Target renamed')
    await expect(k.getByRole('alert').filter({ hasText: 'no se han podido actualizar' })).toHaveText(
      '«Target renamed» ya está en su sitio, pero no se han podido actualizar los enlaces de estas notas: Linker. ' +
      'Su nombre anterior, «Target», se queda como alias para que sigan funcionando.')
    await shot(k, 'move-partial')
    expect(read(`${locked}/Linker.md`)).toBe('See [[Target]].\n')
    expect(read(`${DIR}/Target renamed.md`)).toContain('aliases')
    await k.getByRole('button', { name: 'Cerrar aviso' }).click()
    await expect(k.getByRole('alert').filter({ hasText: 'no se han podido actualizar' })).toHaveCount(0)
  } finally {
    chmodSync(`${NOTES}/${locked}`, 0o755)
  }
})

test('moving a note with images: its pasted image goes with it, a shared one stays, and both keep rendering', async () => {
  const from = `${DIR}/photos`
  const to = `${DIR}/album`
  const trip = `${from}/Trip.md`
  const other = `${from}/Other.md`
  const blue = png(320, 120, [30, 74, 134])
  const green = png(240, 90, [60, 140, 90])
  mkdirSync(`${NOTES}/${from}`, { recursive: true })
  writeFileSync(`${NOTES}/${from}/shared.png`, green)
  writeFileSync(`${NOTES}/${trip}`, '# Trip\n\n![](shared.png)\n')
  writeFileSync(`${NOTES}/${other}`, '# Other\n\n![](shared.png)\n')
  await k.goto(`/?note=${encodeURIComponent(trip)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  await k.locator('.cm-h1').click()
  await k.keyboard.press('Control+End')
  await k.keyboard.press('Enter')
  await sendFiles(k, 'paste', [{ name: 'image.png', bytes: blue }])
  await expect.poll(() => read(trip)).toMatch(/!\[\]\(Trip-[\d-]+\.png\)/)
  const pasted = /!\[\]\((Trip-[\d-]+\.png)\)/.exec(read(trip)!)![1]!
  // Until the index sees Other.md, the move would not know shared.png is shared.
  const stayed = async () => (await (await k.request.post('/api/note/move', { data: { from: trip, to: `${to}/Trip.md`, dryRun: true } })).json()).images.stayed.length
  await expect.poll(stayed, { timeout: 15_000 }).toBe(1)

  const dialog = await openRename(k)
  await dialog.getByLabel('Carpeta').fill(to)
  await expect(dialog.locator('.preview-image').first()).toHaveText(`rename-tests / photos / ${pasted}va con la nota a rename-tests / album / ${pasted}`)
  await expect(dialog.locator('.preview-image.preview-kept')).toHaveText('rename-tests / photos / shared.pngse queda: la usan otras notas')
  await expect(dialog.locator('.preview-change')).toHaveText('![](shared.png) → ![](../photos/shared.png)')
  await shot(k, 'move-images')
  await dialog.getByRole('button', { name: 'Mover con 1 imagen y actualizar 1 enlace' }).click()
  await expect(k.locator('.crumbs')).toHaveText('rename-tests / album / Trip')

  // On disk: the pasted image moved next to the note; the shared one stayed.
  expect(existsSync(`${NOTES}/${to}/${pasted}`)).toBe(true)
  expect(readFileSync(`${NOTES}/${to}/${pasted}`)).toEqual(blue)
  expect(existsSync(`${NOTES}/${from}/${pasted}`)).toBe(false)
  expect(readFileSync(`${NOTES}/${from}/shared.png`)).toEqual(green)
  await expect.poll(() => read(`${to}/Trip.md`)).toContain('![](../photos/shared.png)')
  expect(read(`${to}/Trip.md`)).toContain(`![](${pasted})`)
  expect(read(other)).toBe('# Other\n\n![](shared.png)\n')

  // Both render: in the moved note and in the one that shares the image.
  await k.locator('.cm-h1').click()
  const widths = () => k.locator('.cm-image img').evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).naturalWidth).sort())
  await expect.poll(widths).toEqual([240, 320])
  await k.goto(`/?note=${encodeURIComponent(other)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  await k.locator('.cm-h1').click()
  await expect.poll(widths).toEqual([240])
})

// D-019: ambiguous links a move would resolve are listed in the preview, by source note.
test('the preview lists ambiguous links the move would resolve, by note, and the notice says it after', async ({ browser }) => {
  const dir = `${DIR}/tie`
  const note = `${dir}/a/Diseño.md`
  mkdirSync(`${NOTES}/${dir}/a`, { recursive: true })
  mkdirSync(`${NOTES}/${dir}/b`, { recursive: true })
  writeFileSync(`${NOTES}/${note}`, '# Diseño A\n')
  writeFileSync(`${NOTES}/${dir}/b/Diseño.md`, '# Diseño B\n')
  const uses = '# Uses\n\n- [[Diseño]] first.\n- [[Diseño]] second.\n'
  const also = '# Also\n\n- [[Diseño]] here too.\n'
  writeFileSync(`${NOTES}/${dir}/Uses.md`, uses)
  writeFileSync(`${NOTES}/${dir}/Also.md`, also)
  const shifted = async () => (await (await k.request.post('/api/note/move', { data: { from: note, to: `${dir}/Diseño.md`, dryRun: true } })).json()).shifted.length
  await expect.poll(shifted, { timeout: 15_000 }).toBe(2)
  await k.goto(`/?note=${encodeURIComponent(note)}`)
  await expect(k.locator('.cm-content')).toBeVisible()

  const fill = async (page: Page) => {
    const dialog = await openRename(page)
    await dialog.getByLabel('Carpeta').fill(dir)
    await expect(dialog.locator('.shifts')).toBeVisible()
    return dialog
  }
  let dialog = await fill(k)
  await expect(dialog.locator('.preview-head')).toHaveText('Vista previa')
  const shifts = dialog.locator('.shifts')
  await expect(shifts.locator('strong')).toHaveText('3 enlaces no se reescriben pero cambiarán adónde llevan')
  await expect(shifts.locator('.shifts-src')).toHaveText(['rename-tests / tie / Also1 enlace', 'rename-tests / tie / Uses2 enlaces'])
  await expect(shifts.locator('.shifts-row').first()).toHaveText('[[Diseño]] era ambiguo; llevará a rename-tests / tie / Diseño')
  await shot(k, 'rename-shifts-light')
  // Dark and phone, before deciding.
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  dialog = await fill(k)
  await shot(k, 'rename-shifts-dark')
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await k.context().storageState() })
  const m = await ctx.newPage()
  await m.goto(`/?note=${encodeURIComponent(note)}`)
  await expect(m.locator('.cm-content')).toBeVisible()
  const md = await fill(m)
  await md.locator('.shifts').scrollIntoViewIfNeeded()
  await shot(m, 'rename-shifts-mobile')
  await md.getByRole('button', { name: 'Cancelar' }).click()
  await ctx.close()

  // Going ahead: the links stay as they are and the notice says where they lead now.
  dialog = await fill(k)
  await dialog.getByRole('button', { name: 'Mover', exact: true }).click()
  await expect(k.locator('.crumbs')).toHaveText('rename-tests / tie / Diseño')
  await expect(k.getByRole('alert').filter({ hasText: 'llevan ahora a otra parte' })).toHaveText(
    '«Diseño» ya está en su sitio. 3 enlaces que no se han reescrito llevan ahora a otra parte, en: Also, Uses.')
  await shot(k, 'rename-shifts-notice')
  expect(read(`${dir}/Uses.md`)).toBe(uses)
  expect(read(`${dir}/Also.md`)).toBe(also)
  await k.getByRole('button', { name: 'Cerrar aviso' }).click()
})

// A rename that rewrites many notes: the note moves at once and the links follow in the background.
test('a rename with many backlinks shows its progress, can go to the background, and the UI stays usable', async () => {
  // Enough notes that the rewrites outlast the second the server waits before
  // answering with a job, even on a fast disk: each takes at least two stable
  // reads (120 ms), 16 at a time, so 400 notes take 3 s or more.
  test.setTimeout(300_000)
  const dir = `${DIR}/many`
  const hub = `${dir}/Hub.md`
  const N = 400
  mkdirSync(`${NOTES}/${dir}/refs`, { recursive: true })
  writeFileSync(`${NOTES}/${hub}`, '# Hub\n')
  for (let i = 0; i < N; i++) writeFileSync(`${NOTES}/${dir}/refs/Ref ${i}.md`, `# Ref ${i}\n\nSee [[Hub]].\n`)
  await expect.poll(async () => (await (await k.request.get(`/api/note/links?path=${encodeURIComponent(hub)}`)).json()).backlinks.length, { timeout: 60_000 }).toBe(N)
  await k.goto(`/?note=${encodeURIComponent(hub)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  // The job as the server has it, asked apart from the page.
  let jobId = ''
  const jobState = async () => (await (await k.request.get(`/api/move-jobs/${jobId}`)).json()).state as string
  // One of the page's status requests gets no answer until well after the job
  // ends (a stalled connection): the notice must not wait for it.
  let polls = 0
  await k.route('**/api/move-jobs/**', async (route) => {
    if (++polls !== 3) return route.continue()
    await expect.poll(jobState, { timeout: 150_000, intervals: [1000] }).toBe('done')
    await new Promise((r) => setTimeout(r, 20_000))
    await route.continue().catch(() => {}) // the page may have given up on it
  })
  const dialog = await openRename(k)
  await dialog.getByLabel('Nuevo nombre').fill('Central hub')
  const started = k.waitForResponse((r) => r.url().endsWith('/api/note/move') && r.request().postDataJSON()?.background === true)
  await dialog.getByRole('button', { name: `Renombrar y actualizar ${N} enlaces` }).click()
  jobId = ((await (await started).json()) as { job: { id: string } }).job.id

  const progress = k.getByRole('dialog').filter({ hasText: 'Actualizando enlaces' })
  await expect(progress).toBeVisible()
  await expect(progress).toContainText('«Central hub» ya está en su sitio.')
  await expect(progress.getByRole('progressbar')).toHaveAttribute('aria-valuemax', String(N))
  await expect(k.locator('.crumbs b')).toHaveText('Central hub')
  await shot(k, 'move-progress')
  await progress.getByRole('button', { name: 'Seguir en segundo plano' }).click()
  await expect(progress).toHaveCount(0)
  const toast = k.getByRole('status').filter({ hasText: 'Actualizando los enlaces a «Central hub»' })
  await expect(toast).toBeVisible()
  await shot(k, 'move-progress-toast')
  // The UI answers meanwhile: another note opens.
  await k.keyboard.press('Control+k')
  await k.keyboard.type('Ref 7')
  await k.getByRole('option', { name: /Ref 7(?!\d)/ }).first().click()
  await expect(k.locator('.crumbs b')).toHaveText('Ref 7')
  // At the end the notice goes and every link was rewritten. The server's end
  // and the notice's are told apart: a slow disk makes the first late, while
  // the second must follow it (at worst, once the stalled request is dropped).
  await expect.poll(jobState, { timeout: 150_000, intervals: [1000] }).toBe('done')
  await expect(toast, 'the notice follows the end of the job').toHaveCount(0, { timeout: 15_000 })
  expect(polls, 'the stalled request was among them').toBeGreaterThanOrEqual(3)
  await k.unrouteAll({ behavior: 'ignoreErrors' })
  for (let i = 0; i < N; i++) expect(read(`${dir}/refs/Ref ${i}.md`)).toContain('[[Central hub]]')
})
