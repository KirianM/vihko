// An agent in an open note (M3 §6): a key's edit over the API reaches the
// editors live; the agent shows as presence («<key name> · en nombre de
// <the admin>», diamond, never colour alone) and what it just wrote is marked for
// a few seconds, in two sessions at once. Nothing a person types is marked.
//
// The hub publishes `{ agent: { name, onBehalfOf, via } }` in the awareness
// for a key that writes, and writes with that presence's clientID. A
// person's connection that announces itself as an agent is not shown as one:
// the hub signs presence (D-040 3.3).
import { expect, test, type Page } from '@playwright/test'
import { HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { mkdirSync } from 'node:fs'
import WebSocket from 'ws'
import { openLineage, type Lineage } from '../src/editor/lineage.ts'
import { ADMIN, BASE_URL, E2E_DIR, MEMBER, specMother } from './env.ts'
import { signIn } from './helpers.ts'

const SHOTS = `${E2E_DIR}/shots`
const m = specMother(import.meta.url)
/** The spec's folder (the keys' only one), and its note. */
const FOLDER = m.aFolder()
const NOTE = m.aNotePath(FOLDER)
const TITLE = NOTE.slice(FOLDER.length + 1, -'.md'.length)
/** The keys' name: what the presence shows. */
const KEY_NAME = m.aKeyName()
const AGENT = { name: KEY_NAME, onBehalfOf: ADMIN.username, via: 'mcp' }
/** Lines of the note: its first one, what the agent writes each time, what a person types. */
const FIRST = m.aSentence()
const BY_API = m.aSentence()
const BY_AGENT = m.aSentence()
const TYPED = m.aSentence()
const BY_FAKE = m.aSentence()
/** The pill's text: who, for whom, and how. */
const PILL = `${KEY_NAME} · en nombre de ${ADMIN.username}, por la API`

test.describe.configure({ mode: 'serial' })

const sockets: HocuspocusProviderWebsocket[] = []
const lineages: Lineage[] = []
test.afterAll(() => {
  for (const l of lineages.splice(0)) l.destroy()
  for (const s of sockets.splice(0)) s.destroy()
})

/** A Yjs client on the hub with the session of whoever is signed in on `page`, as the agent's connection. */
async function agentClient(page: Page, agent: typeof AGENT | null): Promise<Lineage> {
  const cookie = (await page.context().cookies()).find((c) => c.name === 'vihko_session')!
  class AuthedWS extends WebSocket {
    constructor(url: string, protocols?: string | string[]) { super(url, protocols, { headers: { cookie: `${cookie.name}=${cookie.value}` } }) }
  }
  const socket = new HocuspocusProviderWebsocket({ url: `${BASE_URL.replace(/^http/, 'ws')}/collab`, WebSocketPolyfill: AuthedWS as unknown as typeof globalThis.WebSocket })
  sockets.push(socket)
  const l = openLineage(socket, NOTE)
  lineages.push(l)
  await expect.poll(() => l.provider.isSynced, { timeout: 15_000 }).toBe(true)
  if (agent) l.provider.awareness!.setLocalStateField('agent', agent)
  return l
}

const fresh = (page: Page) => page.locator('.cm-agent-fresh')
const pill = (page: Page) => page.locator('.agent-pill')
const lineOf = (page: Page, text: string) => page.locator('.cm-line', { hasText: text })

let admin: Page
let member: Page

test.beforeAll(async ({ browser }) => {
  admin = await signIn(browser, ADMIN)
  const created = await admin.request.post('/api/note', { data: { path: NOTE, text: `# ${TITLE}\n\n${FIRST}\n` } })
  expect([201, 409]).toContain(created.status())
  await admin.goto(`/?note=${encodeURIComponent(NOTE)}`)
  await expect(admin.locator('.cm-content')).toContainText(FIRST)
  // The member, in her own session, on a phone in dark mode.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'es-ES' })
  member = await ctx.newPage()
  await member.goto(`/?note=${encodeURIComponent(NOTE)}`)
  await member.getByLabel('Nombre de usuario').fill(MEMBER.username)
  await member.getByLabel('Contraseña').fill(MEMBER.password)
  await member.getByRole('button', { name: 'Entrar' }).last().tap()
  await expect(member.locator('.cm-content')).toContainText(FIRST)
})
test.afterAll(async () => {
  await admin.request.put('/api/admin/integrations', { data: { api: false, mcp: false } })
  await admin.context().close()
  await member.context().close()
})

test('an edit with a key over the API reaches the open editors live', async () => {
  await admin.request.put('/api/admin/integrations', { data: { api: true } })
  const { key, token } = await (await admin.request.post('/api/keys', { data: { confirm: ADMIN.password, name: KEY_NAME, canWrite: true, folders: [FOLDER] } })).json() as { key: { id: string }; token: string }
  const r = await admin.request.post('/api/note/edit', {
    headers: { Authorization: `Bearer ${token}` },
    data: { path: NOTE, ops: [{ op: 'append', text: `${BY_API}\n` }] },
  })
  expect(r.status()).toBe(200)
  await expect(lineOf(admin, BY_API)).toBeVisible()
  await expect(lineOf(member, BY_API)).toBeVisible()
  // The hub's real presence for the key (not a simulated client): who and how, and its text marked.
  await expect(pill(admin)).toHaveText(PILL)
  await expect(fresh(admin)).toHaveText(BY_API)
  await expect(fresh(member)).toHaveText(BY_API)
  await admin.request.delete(`/api/keys/${key.id}`)
  // Both go after a few seconds, before the next test brings its own agent.
  await expect(fresh(admin)).toHaveCount(0, { timeout: 10_000 })
  await expect(pill(admin)).toHaveCount(0, { timeout: 20_000 })
  await expect(pill(member)).toHaveCount(0, { timeout: 20_000 })
})

test('the agent shows as presence and what it writes is marked for a few seconds, in both sessions', async () => {
  await admin.request.put('/api/admin/integrations', { data: { api: true } })
  const { key, token } = await (await admin.request.post('/api/keys', { data: { confirm: ADMIN.password, name: KEY_NAME, canWrite: true, folders: [FOLDER] } })).json() as { key: { id: string }; token: string }
  const write = async (text: string) => {
    const r = await admin.request.post('/api/note/edit', { headers: { Authorization: `Bearer ${token}` }, data: { path: NOTE, ops: [{ op: 'append', text }] } })
    expect(r.status()).toBe(200)
  }
  await write(`${BY_AGENT}\n`)
  await expect(lineOf(admin, BY_AGENT)).toBeVisible()
  await expect(fresh(admin)).toHaveText(BY_AGENT)
  await expect(fresh(admin)).toHaveAttribute('title', `Lo acaba de escribir ${KEY_NAME} · en nombre de ${ADMIN.username}`)
  await expect(fresh(member)).toHaveText(BY_AGENT)
  // Presence: the diamond and who it acts for, in text; how it came, for screen readers and on hover.
  await expect(pill(admin)).toHaveText(PILL)
  await expect(pill(admin).locator('.diamond')).toBeVisible()
  await expect(pill(admin)).toHaveAttribute('title', PILL)
  await expect(pill(member)).toBeVisible()
  // On the phone the header has room for it: it overlaps none of its buttons.
  const overlaps = await member.locator('.main-head').evaluate((head) => {
    const p = head.querySelector('.agent-pill')!.getBoundingClientRect()
    return [...head.querySelectorAll('button')].filter((b) => {
      const r = b.getBoundingClientRect()
      return r.left < p.right && p.left < r.right && r.top < p.bottom && p.top < r.bottom
    }).map((b) => b.getAttribute('aria-label'))
  })
  expect(overlaps).toEqual([])
  // And the note's name keeps its room: shown whole, or with 40 px at least when it has to be cut.
  const name = await member.locator('.crumbs b').evaluate((b) => ({ width: b.getBoundingClientRect().width, whole: b.scrollWidth <= b.clientWidth }))
  expect(name.whole || name.width > 40, JSON.stringify(name)).toBe(true)
  // People are circles (the admin and the member); the agent never is one.
  await expect(admin.locator('.avatar-stack')).toHaveCount(2)
  // The mark is accent-soft with an accent underline, from the design tokens.
  const style = await fresh(admin).evaluate((el) => {
    const css = getComputedStyle(el)
    const token = (name: string) => { const probe = document.createElement('span'); probe.style.color = `var(${name})`; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c }
    return { bg: css.backgroundColor, soft: token('--accent-soft'), shadow: css.boxShadow, accent: token('--accent') }
  })
  expect(style.bg).toBe(style.soft)
  expect(style.shadow).toContain(style.accent)
  await admin.screenshot({ path: `${SHOTS}/agent-presence-light.png`, animations: 'disabled' })
  await member.screenshot({ path: `${SHOTS}/agent-presence-mobile-dark.png`, animations: 'disabled' })
  // A few seconds later, the mark goes; the text stays.
  await expect(fresh(admin)).toHaveCount(0, { timeout: 10_000 })
  await expect(fresh(member)).toHaveCount(0, { timeout: 10_000 })
  await expect(lineOf(admin, BY_AGENT)).toBeVisible()

  // What a person types is never marked.
  await lineOf(member, BY_AGENT).tap()
  await member.keyboard.press('End')
  await member.keyboard.type(` ${TYPED}`)
  await expect(admin.locator('.cm-content')).toContainText(TYPED)
  await admin.waitForTimeout(500)
  await expect(fresh(admin)).toHaveCount(0)

  // The agent stops writing: it's shown a moment longer, then goes.
  await admin.request.delete(`/api/keys/${key.id}`)
  await expect(pill(admin)).toHaveCount(0, { timeout: 30_000 })
  await expect(pill(member)).toHaveCount(0, { timeout: 30_000 })
})

test('a person\'s connection that announces itself as an agent is not shown as one, nor is its text marked (D-040 3.3)', async () => {
  const fake = await agentClient(admin, AGENT)
  fake.text.insert(fake.text.length, `${BY_FAKE}\n`)
  await expect(lineOf(member, BY_FAKE)).toBeVisible()
  await expect(lineOf(admin, BY_FAKE)).toBeVisible()
  await admin.waitForTimeout(1000)
  for (const p of [admin, member]) {
    await expect(pill(p)).toHaveCount(0)
    await expect(fresh(p)).toHaveCount(0)
  }
  fake.destroy()
})
