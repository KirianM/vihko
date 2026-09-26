// An agent in an open note (M3 §6): a key's edit over the API reaches the
// editors live; the agent shows as presence («Claude Code · en nombre de
// noa», diamond, never colour alone) and what it just wrote is marked for
// a few seconds, in two sessions at once. Nothing a person types is marked.
//
// The hub's connection for an agent publishes `{ agent: { name, onBehalfOf,
// via } }` in the awareness and writes with its own clientID (M3 §5, the MCP
// work). Until that lands, the agent's connection is simulated here by a Yjs
// client with that awareness, as the hub's would be.
import { expect, test, type Page } from '@playwright/test'
import { HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { mkdirSync } from 'node:fs'
import WebSocket from 'ws'
import { openLineage, type Lineage } from '../src/editor/lineage.ts'
import { BASE_URL, E2E_DIR, PASSWORD } from './env.ts'
import { signIn } from './helpers.ts'

const SHOTS = `${E2E_DIR}/shots`
const NOTE = 'e2e-agentes/Plan del agente.md'
const AGENT = { name: 'Claude Code', onBehalfOf: 'noa', via: 'mcp' }

test.describe.configure({ mode: 'serial' })

const sockets: HocuspocusProviderWebsocket[] = []
const lineages: Lineage[] = []
test.afterAll(() => {
  for (const l of lineages.splice(0)) l.destroy()
  for (const s of sockets.splice(0)) s.destroy()
})

/** A Yjs client on the hub with the session of whoever is signed in on `page`, as the agent's connection. */
async function agentClient(page: Page, agent: typeof AGENT | null): Promise<Lineage> {
  const cookie = (await page.context().cookies()).find((c) => c.name === 'thoth_session')!
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

let noa: Page
let ana: Page

test.beforeAll(async ({ browser }) => {
  noa = await signIn(browser, 'noa')
  const created = await noa.request.post('/api/note', { data: { path: NOTE, text: '# Plan del agente\n\nPrimera línea del plan.\n' } })
  expect([201, 409]).toContain(created.status())
  await noa.goto(`/?note=${encodeURIComponent(NOTE)}`)
  await expect(noa.locator('.cm-content')).toContainText('Primera línea del plan.')
  // Ana, in her own session, on a phone in dark mode.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'es-ES' })
  ana = await ctx.newPage()
  await ana.goto(`/?note=${encodeURIComponent(NOTE)}`)
  await ana.getByLabel('Nombre de usuario').fill('ana')
  await ana.getByLabel('Contraseña').fill(PASSWORD)
  await ana.getByRole('button', { name: 'Entrar' }).last().tap()
  await expect(ana.locator('.cm-content')).toContainText('Primera línea del plan.')
})
test.afterAll(async () => {
  await noa.request.put('/api/admin/integrations', { data: { api: false, mcp: false } })
  await noa.context().close()
  await ana.context().close()
})

test('an edit with a key over the API reaches the open editors live', async () => {
  await noa.request.put('/api/admin/integrations', { data: { api: true } })
  const { key, token } = await (await noa.request.post('/api/keys', { data: { name: 'Claude Code', canWrite: true, folders: ['e2e-agentes'] } })).json() as { key: { id: string }; token: string }
  const r = await noa.request.post('/api/note/edit', {
    headers: { Authorization: `Bearer ${token}` },
    data: { path: NOTE, ops: [{ op: 'append', text: 'Escrito por la API con la clave.\n' }] },
  })
  expect(r.status()).toBe(200)
  await expect(lineOf(noa, 'Escrito por la API con la clave.')).toBeVisible()
  await expect(lineOf(ana, 'Escrito por la API con la clave.')).toBeVisible()
  await noa.request.delete(`/api/keys/${key.id}`)
})

test('the agent shows as presence and what it writes is marked for a few seconds, in both sessions', async () => {
  const agent = await agentClient(noa, AGENT)
  // Presence: the diamond and who it acts for, in text; how it came, for screen readers and on hover.
  await expect(pill(noa)).toHaveText('Claude Code · en nombre de noa, por MCP')
  await expect(pill(noa).locator('.diamond')).toBeVisible()
  await expect(pill(noa)).toHaveAttribute('title', 'Claude Code · en nombre de noa, por MCP')
  await expect(pill(ana)).toBeVisible()
  // On the phone the header has room for it: it overlaps none of its buttons.
  const overlaps = await ana.locator('.main-head').evaluate((head) => {
    const p = head.querySelector('.agent-pill')!.getBoundingClientRect()
    return [...head.querySelectorAll('button')].filter((b) => {
      const r = b.getBoundingClientRect()
      return r.left < p.right && p.left < r.right && r.top < p.bottom && p.top < r.bottom
    }).map((b) => b.getAttribute('aria-label'))
  })
  expect(overlaps).toEqual([])
  // And the note's name keeps its room.
  expect((await ana.locator('.crumbs b').boundingBox())!.width).toBeGreaterThan(40)
  // People are circles (noa and ana); the agent never is one.
  await expect(noa.locator('.avatar-stack')).toHaveCount(2)

  const t = agent.text
  t.insert(t.length, 'Texto que escribe el agente.\n')
  await expect(lineOf(noa, 'Texto que escribe el agente.')).toBeVisible()
  await expect(fresh(noa)).toHaveText('Texto que escribe el agente.')
  await expect(fresh(noa)).toHaveAttribute('title', 'Lo acaba de escribir Claude Code · en nombre de noa')
  await expect(fresh(ana)).toHaveText('Texto que escribe el agente.')
  // The mark is accent-soft with an accent underline, from the design tokens.
  const style = await fresh(noa).evaluate((el) => {
    const css = getComputedStyle(el)
    const token = (name: string) => { const probe = document.createElement('span'); probe.style.color = `var(${name})`; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c }
    return { bg: css.backgroundColor, soft: token('--accent-soft'), shadow: css.boxShadow, accent: token('--accent') }
  })
  expect(style.bg).toBe(style.soft)
  expect(style.shadow).toContain(style.accent)
  await noa.screenshot({ path: `${SHOTS}/agent-presence-light.png`, animations: 'disabled' })
  await ana.screenshot({ path: `${SHOTS}/agent-presence-mobile-dark.png`, animations: 'disabled' })
  // A few seconds later, the mark goes; the text stays.
  await expect(fresh(noa)).toHaveCount(0, { timeout: 10_000 })
  await expect(fresh(ana)).toHaveCount(0, { timeout: 10_000 })
  await expect(lineOf(noa, 'Texto que escribe el agente.')).toBeVisible()

  // What a person types is never marked.
  await lineOf(ana, 'Texto que escribe el agente.').tap()
  await ana.keyboard.press('End')
  await ana.keyboard.type(' Y esto lo escribe ana.')
  await expect(noa.locator('.cm-content')).toContainText('Y esto lo escribe ana.')
  await noa.waitForTimeout(500)
  await expect(fresh(noa)).toHaveCount(0)

  // The agent leaves: it's shown a moment longer, then goes.
  agent.destroy()
  await expect(pill(noa)).toBeVisible()
  await expect(pill(noa)).toHaveCount(0, { timeout: 20_000 })
  await expect(pill(ana)).toHaveCount(0, { timeout: 20_000 })
})

test('text that arrives before its awareness says it was an agent’s is still marked', async () => {
  const agent = await agentClient(noa, null)
  agent.text.insert(agent.text.length, 'Antes de presentarse.\n')
  await expect(lineOf(noa, 'Antes de presentarse.')).toBeVisible()
  await expect(fresh(noa)).toHaveCount(0)
  agent.provider.awareness!.setLocalStateField('agent', AGENT)
  await expect(fresh(noa)).toHaveText('Antes de presentarse.')
  await expect(pill(noa)).toBeVisible()
  agent.destroy()
})
