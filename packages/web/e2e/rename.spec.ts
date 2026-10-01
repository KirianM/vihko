// Rename, move and trash from the UI, with the note open by two people. It
// creates its own notes at the start so it never touches other specs' notes.
import { expect, test, type Page } from '@playwright/test'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, MEMBER, NOTES, SPACE, SPACE_NAME, inVault, specMother } from './env.ts'
import { editorText, literally, noteInUrl, png, sendFiles, signIn } from './helpers.ts'

const m = specMother(import.meta.url)
/** A sentence no other text of the spec contains (it carries a unique word). */
const line = () => `${m.aSentence(m.anInt(2, 5)).slice(0, -1)} ${m.aUniqueWord()}.`
/** A path of the vault's space as the breadcrumbs and the previews show it: `spaces/x-id/a/b.md` → `<its name> / a / b` (D-056). */
const label = (path: string) => [SPACE_NAME, ...inner(path).replace(/\.md$/i, '').split('/')].join(' / ')
/** A path inside the vault's space, as the move dialogs' «Carpeta» takes it. */
const inner = (path: string) => path.slice(SPACE.length + 1)
/** A generated name as a Markdown link destination (they have only letters and spaces: vihko writes a space as %20). */
const dest = (path: string) => path.replace(/ /g, '%20')
/** The path in the page's URL (?note=…): a space as `+` or `%20`. */
const inUrl = (path: string) => new RegExp(noteInUrl(path))

const DIR_NAME = m.aFolder()
const DIR = inVault(DIR_NAME)
const NAME = m.aTitle()
const NEW_NAME = m.aTitle()
const ARCHIVE = m.aFolder()
const ALIAS = m.aUniqueWord()
const SECTION = m.aHeading()
const LINKS_NAME = m.aTitle()
const LINK_TEXT = m.aHeading()
const NOTE = `${DIR}/${NAME}.md`
const RENAMED = `${DIR}/${NEW_NAME}.md`
const MOVED = `${DIR}/${ARCHIVE}/${NEW_NAME}.md`
const LINKS = `${DIR}/${LINKS_NAME}.md`
/** What the member types during the rename, then after it, and the admin after the restore. */
const TYPED = { during: line(), after: m.aUniqueWord(), restored: m.aUniqueWord() }
const read = (p: string) => (existsSync(`${NOTES}/${p}`) ? readFileSync(`${NOTES}/${p}`, 'utf8') : null)
const shot = (page: Page, name: string) => page.screenshot({ path: `${E2E_DIR}/shots/${name}.png` })

test.describe.configure({ mode: 'serial' })
let k: Page
let a: Page

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  writeFileSync(`${NOTES}/${NOTE}`, `---\naliases: [${ALIAS}]\n---\n# ${NAME}\n\n## ${SECTION}\n`)
  // Four ways to link to it: by name, with an anchor, by alias, and a relative Markdown link.
  writeFileSync(`${NOTES}/${LINKS}`, [
    `# ${m.aHeading()}`, '',
    `- [[${NAME}]] ${m.aWord()}.`,
    `- [[${NAME}#${SECTION}]] ${m.aWord()}.`,
    `- [[${ALIAS}]] ${m.aWord()}.`,
    `- [${LINK_TEXT}](${dest(NAME)}.md) ${m.aWord()}.`, '',
  ].join('\n'))
  k = await signIn(browser, ADMIN, NOTE)
  // Until the index sees the links (watcher or rescan), the preview does not know them.
  await expect.poll(async () => (await (await k.request.get(`/api/note/links?path=${encodeURIComponent(NOTE)}`)).json()).backlinks.length, { timeout: 15_000 }).toBe(4)
  a = await signIn(browser, MEMBER, NOTE)
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
  await k.getByRole('row', { name: DIR_NAME, exact: true }).click()
  await k.keyboard.press('ArrowRight')
  await expect(k.getByRole('row', { name: NAME, exact: true })).toBeVisible()
  const dialog = await openRename(k)
  await expect(dialog.getByRole('heading')).toHaveText(`Renombrar o mover «${NAME}»`)
  await expect(dialog.getByText('Escribe otro nombre u otra carpeta')).toBeVisible()
  await dialog.getByLabel('Nuevo nombre').fill(NEW_NAME)

  // In words (D-056.29): where, and to which note; never the Markdown of the links.
  const rows = dialog.locator('.preview-line')
  await expect(rows).toHaveText([
    `En ${label(LINKS)}, 3 enlaces a ${NEW_NAME} se actualizan para que sigan funcionando.`,
    `En ${label(LINKS)}, el enlace a ${NEW_NAME} sigue funcionando por un alias: no se toca.`,
  ])
  await expect(dialog.locator('.preview')).not.toContainText('[[')
  const submit = dialog.getByRole('button', { name: 'Renombrar y actualizar 3 enlaces' })
  await expect(submit).toBeEnabled()
  await shot(k, 'rename-light')

  // The member types while the admin renames: nothing is lost.
  await a.locator('.cm-content').click()
  await a.keyboard.press('Control+End')
  await a.keyboard.type(TYPED.during)
  await submit.click()

  for (const p of [k, a]) {
    await expect(p.locator('.crumbs b')).toHaveText(NEW_NAME)
    await expect(p).toHaveURL(inUrl(RENAMED))
    await expect.poll(() => editorText(p)).toContain(TYPED.during)
  }
  await expect(k.locator('.presence .avatar')).toHaveCount(2)
  // The tree refreshes: the expanded folder shows the new name.
  await expect(k.getByRole('row', { name: NEW_NAME, exact: true })).toBeVisible()
  await expect(k.getByRole('row', { name: NAME, exact: true })).toHaveCount(0)
  await expect(k.getByRole('dialog')).toHaveCount(0)
  await expect.poll(() => read(RENAMED)).toContain(TYPED.during)
  expect(read(NOTE)).toBeNull()
  await expect.poll(() => read(LINKS)).toContain(`[${LINK_TEXT}](${dest(NEW_NAME)}.md)`)
  const links = read(LINKS)!
  expect(links).toContain(`- [[${NEW_NAME}]] `)
  expect(links).toContain(`- [[${NEW_NAME}#${SECTION}]] `)
  expect(links).toContain(`- [[${ALIAS}]] `)
  expect(links).not.toContain(`[[${NAME}`)

  // The member keeps editing at the new path; the old one does not come back.
  await a.locator('.cm-content').click()
  await a.keyboard.press('Control+End')
  await a.keyboard.type(` ${TYPED.after}`)
  await expect.poll(() => read(RENAMED)).toContain(TYPED.after)
  await expect(k.locator('.status')).toHaveText('Guardado en disco')
  expect(read(NOTE)).toBeNull()
})

test('a name that already exists is explained and cannot be confirmed', async () => {
  const dialog = await openRename(k)
  await dialog.getByLabel('Nuevo nombre').fill(LINKS_NAME)
  await expect(dialog.getByRole('alert')).toHaveText('Ese nombre no está disponible aquí.')
  await expect(dialog.getByRole('button', { name: 'Renombrar' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await expect(k.getByRole('dialog')).toHaveCount(0)
})

test('move to another folder: the button says "Mover" and only what would stop resolving changes', async () => {
  const dialog = await openRename(k)
  await dialog.getByLabel('Carpeta').fill(`${DIR_NAME}/${ARCHIVE}`)
  await expect(dialog.locator('.preview-line:not(.preview-kept)')).toHaveText(`En ${label(LINKS)}, el enlace a ${NEW_NAME} se actualiza para que siga funcionando.`)
  await expect(dialog.locator('.preview-kept', { hasText: `el enlace a ${NEW_NAME} sigue funcionando: no se toca` }).first()).toBeVisible()
  await dialog.getByRole('button', { name: 'Mover y actualizar 1 enlace' }).click()
  for (const p of [k, a]) {
    await expect(p.locator('.crumbs')).toHaveText(label(MOVED))
    await expect(p).toHaveURL(inUrl(MOVED))
  }
  await expect.poll(() => read(MOVED)).toContain(TYPED.after)
  expect(read(RENAMED)).toBeNull()
  // The note moves first; the links follow (in the background if it takes long).
  await expect.poll(() => read(LINKS)).toContain(`[${LINK_TEXT}](${dest(`${ARCHIVE}/${NEW_NAME}`)}.md)`)
  expect(read(LINKS)).toContain(`- [[${NEW_NAME}]] `)
})

test('trash: confirmation names the note, whoever had it open is told, and it restores', async () => {
  await k.getByRole('button', { name: 'Más acciones' }).click()
  await k.getByRole('menuitem', { name: 'Mover a la papelera' }).click()
  const confirm = k.getByRole('alertdialog')
  await expect(confirm.getByRole('heading')).toHaveText(`¿Mover «${NEW_NAME}» a la papelera?`)
  await shot(k, 'trash-confirm')
  await confirm.getByRole('button', { name: 'Mover a la papelera' }).click()

  await expect(k.getByRole('status').filter({ hasText: `«${NEW_NAME}» está en la papelera.` })).toBeVisible()
  await expect(k.locator('.cm-content')).toHaveCount(0)
  await expect(k.getByText('Elige una nota en el árbol.')).toBeVisible()
  await expect(k).not.toHaveURL(/note=/)
  await expect(k.getByRole('row', { name: NEW_NAME, exact: true })).toHaveCount(0)
  await expect(a.getByRole('alert')).toHaveText(`${ADMIN.username} ha movido «${NEW_NAME}» a la papelera mientras la tenías abierta.`)
  await expect(a.locator('.cm-content')).toHaveCount(0)
  await shot(a, 'trash-other')
  // Nobody resurrects it: neither the editor that had it open nor a pending flush.
  await a.waitForTimeout(2000)
  expect(read(MOVED)).toBeNull()

  await k.getByRole('button', { name: 'Restaurar' }).click()
  await expect(k.locator('.crumbs b')).toHaveText(NEW_NAME)
  await expect.poll(() => editorText(k)).toContain(TYPED.after)
  expect(read(MOVED)).toContain(TYPED.during)
  await expect(k.getByRole('status').filter({ hasText: 'papelera' })).toHaveCount(0)
  // The member, with nothing left to restore, reopens it with the same button.
  await a.getByRole('button', { name: 'Restaurar' }).click()
  await expect(a.locator('.crumbs b')).toHaveText(NEW_NAME)
  await expect.poll(() => editorText(a)).toContain(TYPED.after)
  // Both are on the same document again (same path, same socket as before the trash).
  await expect(k.locator('.presence .avatar')).toHaveCount(2)
  await k.locator('.cm-content').click()
  await k.keyboard.press('Control+End')
  await k.keyboard.type(` ${TYPED.restored}`)
  await expect.poll(() => editorText(a)).toContain(TYPED.restored)
})

test('screenshots: menu, dialog in dark and on mobile', async ({ browser }) => {
  await k.getByRole('button', { name: 'Más acciones' }).click()
  await expect(k.getByRole('menuitem')).toHaveCount(3)
  await shot(k, 'menu')
  await k.keyboard.press('Escape')
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  const dialog = await openRename(k)
  await dialog.getByLabel('Nuevo nombre').fill(m.aTitle())
  await expect(dialog.locator('.preview-line').first()).toBeVisible()
  await shot(k, 'rename-dark')
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const phone = await ctx.newPage()
  await phone.goto(`/?note=${encodeURIComponent(MOVED)}`)
  await phone.getByLabel('Nombre de usuario').fill(ADMIN.username)
  await phone.getByLabel('Contraseña').fill(ADMIN.password)
  await phone.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(phone.locator('.cm-content')).toBeVisible()
  await shot(phone, 'header-mobile')
  const md = await openRename(phone)
  await md.getByLabel('Nuevo nombre').fill(m.aTitle())
  await expect(md.locator('.preview-line').first()).toBeVisible()
  await shot(phone, 'rename-mobile')
  await md.getByRole('button', { name: 'Cancelar' }).click()
  await ctx.close()
})

test('a link that cannot be rewritten: the notice names the note and the alias that keeps it working', async () => {
  const name = m.aTitle()
  const renamed = m.aTitle()
  const linker = m.aTitle()
  const target = `${DIR}/${name}.md`
  const locked = `${DIR}/${m.aFolder()}`
  const linkerText = `${m.aWord()} [[${name}]].\n`
  mkdirSync(`${NOTES}/${locked}`, { recursive: true })
  writeFileSync(`${NOTES}/${target}`, `# ${name}\n`)
  writeFileSync(`${NOTES}/${locked}/${linker}.md`, linkerText)
  await k.goto(`/?note=${encodeURIComponent(target)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  await expect.poll(async () => (await (await k.request.get(`/api/note/links?path=${encodeURIComponent(target)}`)).json()).backlinks.length, { timeout: 15_000 }).toBe(1)
  // A folder vihko cannot write to: the rewrite of the linking note fails.
  chmodSync(`${NOTES}/${locked}`, 0o555)
  try {
    // Some network filesystems (NFS with ACLs) ignore the mode bits: then there's no failure to show.
    let enforced = false
    try { writeFileSync(`${NOTES}/${locked}/probe`, '') } catch { enforced = true }
    test.skip(!enforced, 'the notes folder ignores permissions (network filesystem): run with E2E_DIR on a local disk')
    const dialog = await openRename(k)
    await dialog.getByLabel('Nuevo nombre').fill(renamed)
    await dialog.getByRole('button', { name: 'Renombrar y actualizar 1 enlace' }).click()
    await expect(k.locator('.crumbs b')).toHaveText(renamed)
    await expect(k.getByRole('alert').filter({ hasText: 'no se han podido actualizar' })).toHaveText(
      `«${renamed}» ya está en su sitio, pero no se han podido actualizar los enlaces de estas notas: ${linker}. ` +
      `Su nombre anterior, «${name}», se queda como alias para que sigan funcionando.`)
    await shot(k, 'move-partial')
    expect(read(`${locked}/${linker}.md`)).toBe(linkerText)
    expect(read(`${DIR}/${renamed}.md`)).toContain('aliases')
    await k.getByRole('button', { name: 'Cerrar aviso' }).click()
    await expect(k.getByRole('alert').filter({ hasText: 'no se han podido actualizar' })).toHaveCount(0)
  } finally {
    chmodSync(`${NOTES}/${locked}`, 0o755)
  }
})

test('moving a note with images: its pasted image goes with it, a shared one stays, and both keep rendering', async () => {
  const [fromName, toName, tripName, otherName, sharedName] = [m.aFolder(), m.aFolder(), m.aTitle(), m.aTitle(), m.aTitle()]
  const from = `${DIR}/${fromName}`
  const to = `${DIR}/${toName}`
  const trip = `${from}/${tripName}.md`
  const other = `${from}/${otherName}.md`
  /** An image two notes show. */
  const shared = `${sharedName}.png`
  const otherText = `# ${otherName}\n\n![](${dest(shared)})\n`
  const blue = png(320, 120, [30, 74, 134])
  const green = png(240, 90, [60, 140, 90])
  mkdirSync(`${NOTES}/${from}`, { recursive: true })
  writeFileSync(`${NOTES}/${from}/${shared}`, green)
  writeFileSync(`${NOTES}/${trip}`, `# ${tripName}\n\n![](${dest(shared)})\n`)
  writeFileSync(`${NOTES}/${other}`, otherText)
  await k.goto(`/?note=${encodeURIComponent(trip)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  await k.locator('.cm-h1').click()
  await k.keyboard.press('Control+End')
  await k.keyboard.press('Enter')
  await sendFiles(k, 'paste', [{ name: 'image.png', bytes: blue }])
  // Named after the note and the time (a space as %20 in the link).
  const pastedRe = new RegExp(`!\\[\\]\\((${literally(dest(tripName))}-[\\d-]+\\.png)\\)`)
  await expect.poll(() => read(trip)).toMatch(pastedRe)
  const pastedDest = pastedRe.exec(read(trip)!)![1]!
  const pasted = decodeURIComponent(pastedDest)
  // Until the index sees the other note, the move would not know the image is shared.
  const stayed = async () => (await (await k.request.post('/api/note/move', { data: { from: trip, to: `${to}/${tripName}.md`, dryRun: true } })).json()).images.stayed.length
  await expect.poll(stayed, { timeout: 15_000 }).toBe(1)

  const dialog = await openRename(k)
  await dialog.getByLabel('Carpeta').fill(inner(to))
  await expect(dialog.locator('.preview-line', { hasText: 'va con la nota' })).toHaveText(`La imagen ${pasted} va con la nota a ${label(to)}.`)
  await expect(dialog.locator('.preview-kept', { hasText: shared })).toHaveText(`La imagen ${shared} se queda en ${label(from)}: la usan otras notas.`)
  await expect(dialog.locator('.preview-line', { hasText: 'se enlaza' })).toHaveText(`En ${label(`${to}/${tripName}`)}, la imagen ${shared} se enlaza en su nuevo sitio.`)
  await shot(k, 'move-images')
  await dialog.getByRole('button', { name: 'Mover con 1 imagen y actualizar 1 enlace' }).click()
  await expect(k.locator('.crumbs')).toHaveText(label(`${to}/${tripName}`))

  // On disk: the pasted image moved next to the note; the shared one stayed.
  expect(existsSync(`${NOTES}/${to}/${pasted}`)).toBe(true)
  expect(readFileSync(`${NOTES}/${to}/${pasted}`)).toEqual(blue)
  expect(existsSync(`${NOTES}/${from}/${pasted}`)).toBe(false)
  expect(readFileSync(`${NOTES}/${from}/${shared}`)).toEqual(green)
  await expect.poll(() => read(`${to}/${tripName}.md`)).toContain(`![](${dest(`../${fromName}/${shared}`)})`)
  expect(read(`${to}/${tripName}.md`)).toContain(`![](${pastedDest})`)
  expect(read(other)).toBe(otherText)

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
  // Two notes with one name, in two folders: [[name]] is ambiguous until one of them moves up.
  const [dirName, one, two, name, usesName, alsoName] = [m.aFolder(), m.aFolder(), m.aFolder(), m.aTitle(), m.aTitle(), m.aTitle()]
  const dir = `${DIR}/${dirName}`
  const note = `${dir}/${one}/${name}.md`
  mkdirSync(`${NOTES}/${dir}/${one}`, { recursive: true })
  mkdirSync(`${NOTES}/${dir}/${two}`, { recursive: true })
  writeFileSync(`${NOTES}/${note}`, `# ${m.aHeading()}\n`)
  writeFileSync(`${NOTES}/${dir}/${two}/${name}.md`, `# ${m.aHeading()}\n`)
  // Two such links in one note, one in another.
  const uses = `# ${usesName}\n\n- [[${name}]] ${m.aWord()}.\n- [[${name}]] ${m.aWord()}.\n`
  const also = `# ${alsoName}\n\n- [[${name}]] ${m.aWord()}.\n`
  writeFileSync(`${NOTES}/${dir}/${usesName}.md`, uses)
  writeFileSync(`${NOTES}/${dir}/${alsoName}.md`, also)
  /** The notes with such links, as vihko lists them: by path (code units). */
  const sources = [{ path: `${dir}/${alsoName}.md`, count: '1 enlace' }, { path: `${dir}/${usesName}.md`, count: '2 enlaces' }]
    .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
  const shifted = async () => (await (await k.request.post('/api/note/move', { data: { from: note, to: `${dir}/${name}.md`, dryRun: true } })).json()).shifted.length
  await expect.poll(shifted, { timeout: 15_000 }).toBe(2)
  await k.goto(`/?note=${encodeURIComponent(note)}`)
  await expect(k.locator('.cm-content')).toBeVisible()

  const fill = async (page: Page) => {
    const dialog = await openRename(page)
    await dialog.getByLabel('Carpeta').fill(inner(dir))
    await expect(dialog.locator('.shifts')).toBeVisible()
    return dialog
  }
  let dialog = await fill(k)
  await expect(dialog.locator('.preview-head')).toHaveText('Vista previa')
  const shifts = dialog.locator('.shifts')
  await expect(shifts.locator('strong')).toHaveText('3 enlaces no se reescriben pero cambiarán adónde llevan')
  await expect(shifts.locator('.shifts-src')).toHaveText(sources.map((x) => `${label(x.path)}${x.count}`))
  await expect(shifts.locator('.shifts-row').first()).toHaveText(`El enlace «${name}» era ambiguo; llevará a ${label(`${dir}/${name}`)}`)
  await shot(k, 'rename-shifts-light')
  // Dark and phone, before deciding.
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await k.getByRole('button', { name: 'Cambiar a tema oscuro' }).click()
  dialog = await fill(k)
  await shot(k, 'rename-shifts-dark')
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await k.getByRole('button', { name: 'Cambiar a tema claro' }).click()
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await k.context().storageState() })
  const phone = await ctx.newPage()
  await phone.goto(`/?note=${encodeURIComponent(note)}`)
  await expect(phone.locator('.cm-content')).toBeVisible()
  const md = await fill(phone)
  await md.locator('.shifts').scrollIntoViewIfNeeded()
  await shot(phone, 'rename-shifts-mobile')
  await md.getByRole('button', { name: 'Cancelar' }).click()
  await ctx.close()

  // Going ahead: the links stay as they are and the notice says where they lead now.
  dialog = await fill(k)
  await dialog.getByRole('button', { name: 'Mover', exact: true }).click()
  await expect(k.locator('.crumbs')).toHaveText(label(`${dir}/${name}`))
  await expect(k.getByRole('alert').filter({ hasText: 'llevan ahora a otra parte' })).toHaveText(
    `«${name}» ya está en su sitio. 3 enlaces que no se han reescrito llevan ahora a otra parte, en: ${sources.map((x) => label(x.path).split(' / ').pop()).join(', ')}.`)
  await shot(k, 'rename-shifts-notice')
  expect(read(`${dir}/${usesName}.md`)).toBe(uses)
  expect(read(`${dir}/${alsoName}.md`)).toBe(also)
  await k.getByRole('button', { name: 'Cerrar aviso' }).click()
})

// A rename that rewrites many notes: the note moves at once and the links follow in the background.
test('a rename with many backlinks shows its progress, can go to the background, and the UI stays usable', async () => {
  // Enough notes that the rewrites outlast the second the server waits before
  // answering with a job, even on a fast disk: each takes at least two stable
  // reads (120 ms), 16 at a time, so 400 notes take 3 s or more.
  test.setTimeout(300_000)
  const [hubName, newName, ref] = [m.aTitle(), m.aTitle(), m.aTitle()]
  const dir = `${DIR}/${m.aFolder()}`
  const refs = `${dir}/${m.aFolder()}`
  const hub = `${dir}/${hubName}.md`
  const N = 400
  mkdirSync(`${NOTES}/${refs}`, { recursive: true })
  writeFileSync(`${NOTES}/${hub}`, `# ${hubName}\n`)
  for (let i = 0; i < N; i++) writeFileSync(`${NOTES}/${refs}/${ref} ${i}.md`, `# ${ref} ${i}\n\n${m.aWord()} [[${hubName}]].\n`)
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
  await dialog.getByLabel('Nuevo nombre').fill(newName)
  const started = k.waitForResponse((r) => r.url().endsWith('/api/note/move') && r.request().postDataJSON()?.background === true)
  await dialog.getByRole('button', { name: `Renombrar y actualizar ${N} enlaces` }).click()
  jobId = ((await (await started).json()) as { job: { id: string } }).job.id

  const progress = k.getByRole('dialog').filter({ hasText: 'Actualizando enlaces' })
  await expect(progress).toBeVisible()
  await expect(progress).toContainText(`«${newName}» ya está en su sitio.`)
  await expect(progress.getByRole('progressbar')).toHaveAttribute('aria-valuemax', String(N))
  await expect(k.locator('.crumbs b')).toHaveText(newName)
  await shot(k, 'move-progress')
  await progress.getByRole('button', { name: 'Seguir en segundo plano' }).click()
  await expect(progress).toHaveCount(0)
  const toast = k.getByRole('status').filter({ hasText: `Actualizando los enlaces a «${newName}»` })
  await expect(toast).toBeVisible()
  await shot(k, 'move-progress-toast')
  // The UI answers meanwhile: another note opens.
  await k.keyboard.press('Control+k')
  await k.keyboard.type(`${ref} 7`)
  await k.getByRole('option', { name: new RegExp(`${literally(ref)} 7(?!\\d)`) }).first().click()
  await expect(k.locator('.crumbs b')).toHaveText(`${ref} 7`)
  // At the end the notice goes and every link was rewritten. The server's end
  // and the notice's are told apart: a slow disk makes the first late, while
  // the second must follow it (at worst, once the stalled request is dropped).
  await expect.poll(jobState, { timeout: 150_000, intervals: [1000] }).toBe('done')
  await expect(toast, 'the notice follows the end of the job').toHaveCount(0, { timeout: 15_000 })
  expect(polls, 'the stalled request was among them').toBeGreaterThanOrEqual(3)
  await k.unrouteAll({ behavior: 'ignoreErrors' })
  for (let i = 0; i < N; i++) expect(read(`${refs}/${ref} ${i}.md`)).toContain(`[[${newName}]]`)
})
