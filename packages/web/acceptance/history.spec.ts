// M2 «done when», in a real browser over the generated vault: something typed
// in the UI, a change made with another editor and a rename from the UI show
// up in the history with their author, and restoring undoes them. The
// history's own screens come with the M2 UI: here the browser makes the
// changes, and its session asks the history API what it recorded and
// restores through it.
import { expect, test, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { ACC_DIR, ADMIN, NOTES } from './env.ts'
import { editorText, signIn } from '../e2e/helpers.ts'

interface Vault { hub: string; editable: string[] }
interface Version { id: string; change: string; from?: string; reason: { code: string; by?: { name: string } } | null; authors: { kind: string; name: string }[] }

test.describe.configure({ mode: 'serial' })
let vault: Vault
let k: Page
const q = encodeURIComponent
const read = (p: string) => readFileSync(`${NOTES}/${p}`, 'utf8')
const who = (v: Version) => v.authors.map((a) => (a.kind === 'user' ? a.name : a.kind)).join(',')
const versions = async (path: string): Promise<Version[]> => (await (await k.request.get(`/api/history/versions?path=${q(path)}`)).json()).versions ?? []

test.beforeAll(async ({ browser }) => {
  vault = JSON.parse(readFileSync(`${ACC_DIR}/vault.json`, 'utf8'))
  k = await signIn(browser, ADMIN)
})

test('typed in the browser, then changed with another editor: each version with its author, and restoring undoes the change', async () => {
  const note = vault.editable.filter((p) => p !== vault.hub && p === p.normalize('NFC'))[30]!
  await k.goto(`/?note=${q(note)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  await k.locator('.cm-h1').first().click()
  await k.keyboard.press('Control+End')
  await k.keyboard.type('\nEscrito para el historial.')
  await expect.poll(() => read(note), { timeout: 10_000 }).toContain('Escrito para el historial.')
  writeFileSync(`${NOTES}/${note}`, read(note) + '\nCambio de otro editor para el historial.\n')
  await expect.poll(() => editorText(k)).toContain('Cambio de otro editor para el historial.')
  // The external change closes what was typed, a version by its author; the
  // external one stays open for a while (that editor may save again).
  const state = async () => {
    const r = await (await k.request.get(`/api/history/versions?path=${q(note)}`)).json() as { versions: Version[]; pending: { authors: { kind: string }[] } | null }
    return `${r.versions[0] ? who(r.versions[0]) : ''} | ${r.pending?.authors.map((a) => a.kind).join(',') ?? ''}`
  }
  await expect.poll(state, { timeout: 15_000 }).toBe(`${ADMIN.username} | external`)
  const [typed] = await versions(note)
  const r = await k.request.post('/api/history/restore', { data: { path: note, id: typed!.id } })
  expect(r.status()).toBe(200)
  await expect.poll(() => editorText(k)).not.toContain('Cambio de otro editor para el historial.')
  expect(await editorText(k)).toContain('Escrito para el historial.')
  await expect.poll(() => read(note), { timeout: 10_000 }).not.toContain('Cambio de otro editor para el historial.')
  // Restoring closed the external version first: each change is still there with its author.
  await expect.poll(async () => (await versions(note)).slice(0, 3).map((v) => `${v.change} ${who(v)}`).join(' | ')).toBe(`restored ${ADMIN.username} | modified external | modified ${ADMIN.username}`)
})

test('a rename from the UI: the move by whoever did it, the links rewritten by the system for them, and restoring a backlink brings its link back', async () => {
  // A note with backlinks, other than the hub (the vault spec renames that one).
  let target = ''
  let backlink: { path: string; raw: string } | null = null
  for (const p of vault.editable.filter((x) => x !== vault.hub && x === x.normalize('NFC')).slice(40)) {
    const links = await (await k.request.get(`/api/note/links?path=${q(p)}`)).json() as { backlinks: { path: string; raw: string }[] }
    const b = links.backlinks.find((x) => x.path !== vault.hub && x.path === x.path.normalize('NFC') && x.raw.startsWith('[['))
    if (b) { target = p; backlink = b; break }
  }
  expect(backlink).not.toBeNull()
  const name = 'Renombrada para el historial'
  const to = target.replace(/[^/]*$/, `${name}.md`)
  await k.goto(`/?note=${q(target)}`)
  await expect(k.locator('.cm-content')).toBeVisible()
  await k.getByRole('button', { name: 'Más acciones' }).click()
  await k.getByRole('menuitem', { name: 'Renombrar o mover…' }).click()
  const dialog = k.getByRole('dialog')
  await dialog.getByLabel('Nuevo nombre').fill(name)
  const submit = dialog.getByRole('button', { name: /^Renombrar/ })
  await expect(submit).toBeEnabled({ timeout: 15_000 })
  await submit.click()
  await expect(k.locator('.crumbs b')).toHaveText(name, { timeout: 30_000 })
  await expect.poll(async () => { const [v] = await versions(to); return v ? `${v.change} ${v.from} ${who(v)}` : '' }, { timeout: 15_000 }).toBe(`moved ${target} ${ADMIN.username}`)
  const src = backlink!.path
  await expect.poll(async () => (await versions(src))[0]?.reason?.code, { timeout: 15_000 }).toBe('note_moved')
  const [rewrite, before] = await versions(src)
  expect(who(rewrite!)).toBe('system')
  expect(rewrite!.reason!.by!.name).toBe(ADMIN.username)
  expect(read(src)).not.toContain(backlink!.raw)
  const r = await k.request.post('/api/history/restore', { data: { path: src, id: before!.id } })
  expect(r.status()).toBe(200)
  expect(read(src)).toContain(backlink!.raw)
})
