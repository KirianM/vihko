// The tree and the sidebar, live (D-056.36), with two people in their own
// sessions: what one creates, renames, moves or deletes where the other
// reads shows in the other's tree without reloading; what one shares with
// the other appears in «Shared with me», and goes when it's taken back.
import { expect, test, type Page } from '@playwright/test'
import { ADMIN, MEMBER, SPACE, SPACE_NAME, personal, specMother } from './env.ts'
import { signIn, spaceTree } from './helpers.ts'

const m = specMother(import.meta.url)
const LIVE = { timeout: 10_000 }
const DIR = `${SPACE}/${m.aFolder()}`
const MINE = `${personal(ADMIN)}/${m.aFolder()}`

let k: Page
let a: Page

/** A request as `page`'s person; expects `status`. */
async function call(page: Page, method: 'get' | 'post' | 'put' | 'delete', url: string, data?: unknown, status = 200) {
  const r = await page.request[method](url, data === undefined ? {} : { data })
  expect(r.status(), `${method} ${url}: ${await r.text()}`).toBe(status)
  return r.json() as Promise<Record<string, any>>
}
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/, '')
/** Shares (or with null takes back) a folder of the admin's own space with the member. */
async function share(level: 'read' | null) {
  const now = await call(k, 'get', `/api/permissions?folder=${encodeURIComponent(MINE)}`)
  await call(k, 'put', '/api/permissions', { folder: MINE, grants: level ? { [MEMBER.username]: level } : null, ifMatch: now.etag })
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  k = await signIn(browser, ADMIN)
  a = await signIn(browser, MEMBER)
  await call(k, 'post', '/api/folder', { path: DIR }, 201)
  await call(k, 'post', '/api/folder', { path: MINE }, 201)
  await a.reload()
  await spaceTree(a, SPACE_NAME).getByRole('row', { name: base(DIR), exact: true }).click()
})

test.afterAll(async () => {
  await call(k, 'delete', `/api/folder?path=${encodeURIComponent(MINE)}&trash=true`).catch(() => {})
  await a.context().close()
})

test('a note made, renamed, moved and deleted by the admin shows in the member\'s tree at once', async () => {
  const tree = spaceTree(a, SPACE_NAME)
  const note = `${DIR}/${m.aTitle()}.md`
  await call(k, 'post', '/api/note', { path: note, text: `# ${m.aHeading()}\n` }, 201)
  await expect(tree.getByRole('row', { name: base(note), exact: true })).toBeVisible(LIVE)
  const renamed = `${DIR}/${m.aTitle()}.md`
  await call(k, 'post', '/api/note/move', { from: note, to: renamed })
  await expect(tree.getByRole('row', { name: base(renamed), exact: true })).toBeVisible(LIVE)
  await expect(tree.getByRole('row', { name: base(note), exact: true })).toHaveCount(0)
  // A folder moved: its new name shows, the old one goes.
  const sub = `${DIR}/${m.aFolder()}`
  await call(k, 'post', '/api/folder', { path: sub }, 201)
  await expect(tree.getByRole('row', { name: base(sub), exact: true })).toBeVisible(LIVE)
  const subMoved = `${DIR}/${m.aFolder()}`
  await call(k, 'post', '/api/folder/move', { from: sub, to: subMoved })
  await expect(tree.getByRole('row', { name: base(subMoved), exact: true })).toBeVisible(LIVE)
  await expect(tree.getByRole('row', { name: base(sub), exact: true })).toHaveCount(0)
  await call(k, 'delete', `/api/note?path=${encodeURIComponent(renamed)}`)
  await expect(tree.getByRole('row', { name: base(renamed), exact: true })).toHaveCount(0, LIVE)
})

test('a folder shared with the member appears in «Shared with me» at once, and goes when it\'s taken back; nothing of the admin\'s own shows before', async () => {
  // A note of the admin's own space: the member's sidebar knows nothing of it.
  const secret = `${MINE}/${m.aTitle()}.md`
  await call(k, 'post', '/api/note', { path: secret, text: `# ${m.aHeading()}\n` }, 201)
  // Its entry in «Shared with me» (which other specs may have filled), opened when it's there.
  const entry = a.getByRole('button', { name: `Acciones de «${base(MINE)} · de ${ADMIN.username}»`, exact: true })
  const openShared = async () => {
    const toggle = a.getByRole('button', { name: /^Compartido conmigo/ })
    if (await toggle.count() && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
  }
  await openShared()
  await expect(entry).toHaveCount(0)
  await share('read')
  await expect(async () => { await openShared(); await expect(entry).toBeVisible({ timeout: 500 }) }).toPass(LIVE)
  await share(null)
  await expect(entry).toHaveCount(0, LIVE)
  await expect(a.getByText(base(secret))).toHaveCount(0)
})
