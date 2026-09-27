// How an agent came in shows in the history (D-037): a key's version says
// «Claude Code · en nombre de <the admin> · por la API» or «… · por MCP», in the
// note's History tab and in «Cambios recientes». The edits are real: one
// over the HTTP API with the key, one through the MCP server with the SDK's
// client, each on a note of its own.
import { expect, test, type Page } from '@playwright/test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { mkdirSync } from 'node:fs'
import { ADMIN, BASE_URL, E2E_DIR } from './env.ts'
import { signIn } from './helpers.ts'

const SHOTS = `${E2E_DIR}/shots`
const FOLDER = 'e2e-via'
const BY_API = `${FOLDER}/Por la API.md`
const BY_MCP = `${FOLDER}/Por MCP.md`
const NAME = 'Agente vía'
const WHO = `${NAME} · en nombre de ${ADMIN.username}`
/** Versions appear after a flush and some calm (3 s on the e2e server). */
const SLOW = { timeout: 20_000 }

test.describe.configure({ mode: 'serial' })
let k: Page
let keyId = ''

test.beforeAll(async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true })
  k = await signIn(browser, ADMIN)
  expect((await k.request.put('/api/admin/integrations', { data: { api: true, mcp: true } })).status()).toBe(200)
  for (const [path, text] of [[BY_API, '# Por la API\n\nAntes.\n'], [BY_MCP, '# Por MCP\n\nAntes.\n']]) {
    expect([201, 409]).toContain((await k.request.post('/api/note', { data: { path, text } })).status())
  }
  const { key, token } = await (await k.request.post('/api/keys', { data: { confirm: ADMIN.password, name: NAME, canWrite: true, folders: [FOLDER] } })).json() as { key: { id: string }; token: string }
  keyId = key.id
  // Over the HTTP API, with the key.
  const r = await k.request.post('/api/note/edit', { headers: { Authorization: `Bearer ${token}` }, data: { path: BY_API, ops: [{ op: 'append', text: 'Escrito por la API.\n' }] } })
  expect(r.status(), await r.text()).toBe(200)
  // Through the MCP server, as a client would.
  const client = new Client({ name: 'e2e', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  const done = await client.callTool({ name: 'edit_note', arguments: { path: BY_MCP, ops: [{ op: 'append', text: 'Escrito por MCP.\n' }] } }) as { isError?: boolean; content: unknown }
  expect(done.isError, JSON.stringify(done.content)).not.toBe(true)
  await client.close()
})

test.afterAll(async () => {
  if (keyId) await k.request.delete(`/api/keys/${keyId}`)
  await k.request.put('/api/admin/integrations', { data: { api: false, mcp: false } })
  await k.context().close()
})

const agentRow = (page: Page) => page.getByRole('complementary', { name: 'Comentarios y contexto' }).locator('.h-row').filter({ hasText: NAME })

test('the note\'s History tab says how the agent came in', async () => {
  for (const [path, via] of [[BY_API, 'por la API'], [BY_MCP, 'por MCP']] as const) {
    // Opened again until the agent's version is closed and listed.
    await expect(async () => {
      await k.goto(`/?note=${encodeURIComponent(path)}`)
      await expect(k.locator('.cm-content')).toBeVisible()
      await k.getByRole('complementary', { name: 'Comentarios y contexto' }).getByRole('tab', { name: 'Historial' }).click()
      await expect(agentRow(k).first()).toBeVisible({ timeout: 3_000 })
    }).toPass(SLOW)
    await expect(agentRow(k).first().locator('.h-agent')).toHaveText(`${WHO} · ${via}`)
    await expect(agentRow(k).first().locator('.h-diamond')).toBeVisible()
  }
  await agentRow(k).first().screenshot({ path: `${SHOTS}/history-via-row.png`, animations: 'disabled' })
})

test('«Cambios recientes» says it too', async () => {
  await k.goto('/?view=changes')
  await expect(k.getByRole('heading', { name: 'Cambios recientes', level: 1 })).toBeVisible()
  const cards = k.locator('.c-change')
  await expect(cards.locator('.h-agent').filter({ hasText: `${WHO} · por la API` }).first()).toBeVisible(SLOW)
  await expect(cards.locator('.h-agent').filter({ hasText: `${WHO} · por MCP` }).first()).toBeVisible()
  // The filter names the agent once, whichever way it came.
  const filter = k.getByLabel('Autor')
  await expect(filter.locator('option', { hasText: NAME })).toHaveCount(1)
  await k.screenshot({ path: `${SHOTS}/history-via-changes.png`, animations: 'disabled' })
})
