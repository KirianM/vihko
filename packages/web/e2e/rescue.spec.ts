// What someone types must never be lost in silence, with two sessions: a
// member who edits and the admin who moves, deletes, lowers access or ends
// sessions meanwhile. Being offline is a WebSocket the test really cuts
// (Chromium's offline mode holds the socket's messages instead), and a
// keystroke in flight is one the test holds back on its way to the hub.
// - Moved somewhere the member can't open while they type: the note closes,
//   they're told, and what never arrived is offered as a copy.
// - Moved where they can write: what was in flight is written there.
// - Offline meanwhile, then back: the note moved, deleted, their access
//   lowered or their session ended: «Save my version as a copy», never a
//   silent loss.
// - Leaving the page with something unsent asks first; another note opened
//   meanwhile still gets what was typed in this one.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, MEMBER, NOTES, inVault, personal, specMother } from './env.ts'
import { editorText, noteInUrl, signIn, usePermissions } from './helpers.ts'

const m = specMother(import.meta.url)
const DIR = inVault(m.aFolder())
const SHOTS = `${E2E_DIR}/shots`
const SLOW = { timeout: 30_000 }
const q = encodeURIComponent
const disk = (p: string) => readFileSync(`${NOTES}/${p}`, 'utf8')

/** A new note in DIR, with a line only it has. */
function newNote() {
  const title = m.aTitle()
  const path = `${DIR}/${title}.md`
  writeFileSync(`${NOTES}/${path}`, `# ${title}\n\n${m.aSentence()} ${m.aUniqueWord()}\n`)
  return { title, path }
}

/**
 * The member signed in, in a tab whose WebSocket the test controls:
 * `offline()` closes it and refuses it until `online()`; `hold()` keeps
 * what the tab sends from reaching the hub (a keystroke in flight) until
 * `release()`, which drops it.
 */
async function memberTab(browser: Browser, note: string) {
  const page = await (await browser.newContext()).newPage()
  let offline = false
  let holding = false
  const held: unknown[] = []
  const live: { close(): void }[] = []
  await page.routeWebSocket(/\/collab$/, (ws) => {
    if (offline) return void ws.close()
    const server = ws.connectToServer()
    ws.onMessage((msg) => { if (holding) held.push(msg); else server.send(msg) })
    live.push(ws, server)
  })
  await page.goto(`/?note=${q(note)}`)
  await page.getByLabel('Nombre de usuario').fill(MEMBER.username)
  await page.getByLabel('Contraseña').fill(MEMBER.password)
  await page.getByRole('button', { name: 'Entrar' }).last().click()
  // A new tab loads the editor first (its code comes on demand): slower on a loaded machine.
  await expect(page.locator('.cm-content')).toBeVisible(SLOW)
  await expect(page.locator('.status')).toHaveText('Guardado en disco')
  return {
    page,
    async offline() {
      offline = true
      for (const c of live.splice(0)) c.close()
      await expect(page.locator('.status')).toContainText('Sin conexión')
    },
    online() { offline = false },
    hold() { holding = true },
    /** Waits until something is held, so it's in flight for sure. */
    async holding() { await expect.poll(() => held.length).toBeGreaterThan(0) },
    release() { holding = false; held.length = 0 },
  }
}

/** Types `text` on a new line at the end of the open note. */
async function typeLine(page: Page, text: string) {
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(`\n${text}`)
}

const banner = (page: Page) => page.getByRole('alert').filter({ hasText: 'no llegaron a guardarse' })
const copiesOf = (dir: string, title: string) => existsSync(`${NOTES}/${dir}`) ? readdirSync(`${NOTES}/${dir}`).filter((f) => f.startsWith(`${title} (sin enviar `)) : []

let admin: Page
// Back online, the browser tries again after a pause that grows with each failed try (up to 30 s).
test.describe.configure({ timeout: 90_000 })

test.beforeAll(async ({ browser }) => {
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  admin = await signIn(browser, ADMIN)
})

/** The admin moves a note through the API. */
async function move(from: string, to: string) {
  const r = await admin.request.post('/api/note/move', { data: { from, to } })
  expect(r.status(), await r.text()).toBe(200)
}

test('moved where the member can\'t open it while they type: the note closes, they\'re told, and what never arrived is kept as a copy', async ({ browser }) => {
  const { title, path } = newNote()
  const tab = await memberTab(browser, path)
  const { page } = tab
  const typed = m.aUniqueWord()
  tab.hold()
  await typeLine(page, typed)
  await tab.holding()
  // Into the admin's own space: the member can't read it there.
  await move(path, `${personal(ADMIN)}/${m.aTitle()}.md`)
  await expect(page.getByRole('alert').filter({ hasText: 'a un sitio que no puedes abrir' }).first()).toBeVisible()
  await expect(page.locator('.cm-content')).toHaveCount(0)
  await expect(banner(page)).toBeVisible()
  await expect(banner(page)).toContainText(`Alguien movió «${title}» a un sitio que no puedes abrir.`)
  tab.release()
  await page.screenshot({ path: `${SHOTS}/rescue-moved-away.png` })
  // Kept next to where it was: the member still writes there.
  await banner(page).getByRole('button', { name: 'Guardar mi versión como copia' }).click()
  await expect(page.locator('.crumbs b')).toContainText(`${title} (sin enviar`)
  await expect.poll(() => editorText(page)).toContain(typed)
  expect(copiesOf(DIR, title)).toHaveLength(1)
  expect(readFileSync(`${NOTES}/${DIR}/${copiesOf(DIR, title)[0]}`, 'utf8')).toContain(typed)
  await expect(banner(page)).toHaveCount(0)
})

test('renamed by someone else while a keystroke is on its way: it\'s written where the note went, with no copy', async ({ browser }) => {
  const { path } = newNote()
  const tab = await memberTab(browser, path)
  const { page } = tab
  const typed = m.aUniqueWord()
  tab.hold()
  await typeLine(page, typed)
  await tab.holding()
  const to = `${DIR}/${m.aTitle()}.md`
  await move(path, to)
  await expect(page).toHaveURL(new RegExp(noteInUrl(to)))
  tab.release()
  await expect.poll(() => disk(to), SLOW).toContain(typed)
  await expect(page.locator('.status')).toHaveText('Guardado en disco')
  await expect(banner(page)).toHaveCount(0)
  expect(disk(to).split(typed).length - 1).toBe(1)
})

// Back from being offline: the hub turns the tab's copy away, or tells it the person can't write any more.
test('offline while the note is moved: they follow it, and what they typed is offered as a copy', async ({ browser }) => {
  {
    const { title, path } = newNote()
    const tab = await memberTab(browser, path)
    const { page } = tab
    await tab.offline()
    await expect(page.locator('.status')).toHaveText('Sin conexión · no cierres esta pestaña')
    await page.screenshot({ path: `${SHOTS}/rescue-offline-status.png` })
    const typed = m.aUniqueWord()
    await typeLine(page, typed)
    const to = `${DIR}/${m.aTitle()}.md`
    await move(path, to)
    tab.online()
    await expect(page).toHaveURL(new RegExp(noteInUrl(to)), SLOW)
    await expect(banner(page)).toContainText(`Movieron «${title}» mientras escribías`, SLOW)
    expect(disk(to)).not.toContain(typed)
    await banner(page).getByRole('button', { name: 'Guardar mi versión como copia' }).click()
    await expect.poll(() => editorText(page)).toContain(typed)
    expect(copiesOf(DIR, title)).toHaveLength(1)
  }
})

test('offline while the note is deleted: closed, told, and the copy offered', async ({ browser }) => {
  {
    const { title, path } = newNote()
    const tab = await memberTab(browser, path)
    const { page } = tab
    await tab.offline()
    const typed = m.aUniqueWord()
    await typeLine(page, typed)
    const del = await admin.request.delete(`/api/note?path=${q(path)}`)
    expect(del.status()).toBe(200)
    tab.online()
    await expect(page.getByRole('alert').filter({ hasText: 'ya no está donde la tenías' }).first()).toBeVisible(SLOW)
    await expect(banner(page)).toContainText(`«${title}» ya no está donde la tenías`)
    await banner(page).getByRole('button', { name: 'Guardar mi versión como copia' }).click()
    await expect.poll(() => editorText(page)).toContain(typed)
  }
})

test('offline while the member\'s access is lowered to reading: it reopens read-only, and the copy goes to their own space', async ({ browser }) => {
  {
    const { title, path } = newNote()
    const tab = await memberTab(browser, path)
    const { page } = tab
    await tab.offline()
    const typed = m.aUniqueWord()
    await typeLine(page, typed)
    // In the whole space: sharing only adds, so a folder's grant can't lower what the space gives.
    await usePermissions({ grants: { [MEMBER.username]: 'read' } })
    try {
      tab.online()
      await expect(banner(page)).toContainText(`Ya no puedes editar «${title}»`, SLOW)
      await expect(page.locator('.status-readonly')).toBeVisible()
      await page.screenshot({ path: `${SHOTS}/rescue-read-only.png` })
      expect(disk(path)).not.toContain(typed)
      await banner(page).getByRole('button', { name: 'Guardar mi versión como copia' }).click()
      await expect.poll(() => editorText(page)).toContain(typed)
      expect(copiesOf(personal(MEMBER), title)).toHaveLength(1)
    } finally {
      await usePermissions()
    }
  }
})

test('the session ends while offline: back online it signs in again, and what was typed is offered as a copy', async ({ browser }) => {
  const { title, path } = newNote()
  const tab = await memberTab(browser, path)
  const { page } = tab
  await tab.offline()
  const typed = m.aUniqueWord()
  await typeLine(page, typed)
  const users = (await (await admin.request.get('/api/admin/users')).json()) as { users: { id: string; username: string }[] }
  const id = users.users.find((u) => u.username === MEMBER.username)!.id
  expect((await admin.request.delete(`/api/admin/users/${id}/sessions`)).status()).toBe(200)
  tab.online()
  await expect(page.getByLabel('Contraseña')).toBeVisible(SLOW)
  await page.getByLabel('Nombre de usuario').fill(MEMBER.username)
  await page.getByLabel('Contraseña').fill(MEMBER.password)
  await page.getByRole('button', { name: 'Entrar' }).last().click()
  await expect(banner(page)).toContainText(`Tu sesión terminó antes de que llegara a «${title}»`)
  await banner(page).getByRole('button', { name: 'Guardar mi versión como copia' }).click()
  await expect.poll(() => editorText(page)).toContain(typed)
  expect(copiesOf(DIR, title)).toHaveLength(1)
})


test('with something unsent, leaving the page asks first; once it is sent, it doesn\'t', async ({ browser }) => {
  const { path } = newNote()
  const tab = await memberTab(browser, path)
  const { page } = tab
  await tab.offline()
  const typed = m.aUniqueWord()
  await typeLine(page, typed)
  const asked = page.waitForEvent('dialog')
  await page.close({ runBeforeUnload: true })
  const dialog = await asked
  expect(dialog.type()).toBe('beforeunload')
  await dialog.dismiss()
  expect(page.isClosed()).toBe(false)
  tab.online()
  await expect.poll(() => disk(path), SLOW).toContain(typed)
  await expect(page.locator('.status')).toHaveText('Guardado en disco', SLOW)
  let again = false
  page.on('dialog', () => { again = true })
  await page.close({ runBeforeUnload: true })
  await expect.poll(() => page.isClosed()).toBe(true)
  expect(again).toBe(false)
})

test('another note opened while this one has something unsent: it goes on sending, and arrives', async ({ browser }) => {
  const { path } = newNote()
  const other = newNote()
  const tab = await memberTab(browser, path)
  const { page } = tab
  await tab.offline()
  const typed = m.aUniqueWord()
  await typeLine(page, typed)
  await page.getByRole('row', { name: other.title, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(noteInUrl(other.path)))
  tab.online()
  await expect.poll(() => disk(path), SLOW).toContain(typed)
  await expect(page.locator('.status')).toHaveText('Guardado en disco', SLOW)
  await expect(banner(page)).toHaveCount(0)
})
