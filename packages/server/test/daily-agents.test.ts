// Today's note for an agent (D-030, D-037): asking for it names it, so when
// it exists but is hidden from the agent (`ai: false`, or outside the key's
// folders) the answer is `agent_denied` with the reason, as for any note the
// agent names, over HTTP and over MCP, read-only or not; never its path or
// anything of it, and nothing is created. One that doesn't exist outside the
// key's folders stays `not_found`, without its path (leaks.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setup } from './_agents.ts'

const TODAY = '2026-09-26'
const CONFIG = `daily:
  agenda:
    folder: proyectos/diario
  ajena:
    folder: fuera/diario
  vacia:
    folder: fuera/vacia
`
const FILES = {
  'proyectos/plan.md': '# Plan\n',
  [`proyectos/diario/${TODAY}.md`]: '---\nai: false\n---\n# Hoy\n\nZafiro del día.\n',
  [`fuera/diario/${TODAY}.md`]: '# Hoy fuera\n\nRubí del día.\n',
}
/** What the key must never get about those notes. */
const SECRETS = [TODAY, 'diario', 'Zafiro', 'Rubí', 'fuera/']

test('today\'s note hidden from the agent: agent_denied with the reason, over HTTP and MCP, read-only or not; nothing of it, nothing created', async () => {
  const h = await setup({ files: FILES, config: CONFIG })
  try {
    await h.enableApi()
    await h.enableMcp()
    const clean = (what: string, body: string) => { for (const s of SECRETS) assert.ok(!body.includes(s), `${what} gives away «${s}»: ${body}`) }
    for (const canWrite of [false, true]) {
      const { token } = await h.newKey({ name: `Diario ${canWrite}`, canWrite, folders: ['proyectos'] })
      const key = h.withKey(token)
      const denied = async (what: string, r: Promise<{ status: number; body: any; text: string }>, reason: string) => {
        const res = await r
        assert.deepEqual([res.status, res.body?.error, res.body?.reason], [403, 'agent_denied', reason], `${what}: ${res.text}`)
        clean(what, res.text)
      }
      // Over HTTP: where it is (GET) and, with a key that writes, open it (POST).
      await denied('GET /api/daily', key('GET', '/api/daily'), 'ai_false')
      await denied('GET /api/daily ajena', key('GET', h.url('/api/daily', { series: 'ajena' })), 'outside_key_folders')
      if (canWrite) {
        await denied('POST /api/daily', key('POST', '/api/daily', {}), 'ai_false')
        await denied('POST /api/daily ajena', key('POST', '/api/daily', { series: 'ajena' }), 'outside_key_folders')
      }
      // Over MCP: daily_note, read-only or writing.
      const c = await h.mcp(token)
      for (const [args, reason] of [[{}, 'ai_false'], [{ series: 'ajena' }, 'outside_key_folders']] as const) {
        const r = await c.call('daily_note', args)
        assert.equal(r.error, true, r.raw)
        assert.deepEqual([r.data.error, r.data.reason], ['agent_denied', reason], r.raw)
        clean(`daily_note ${JSON.stringify(args)}`, r.raw)
      }
      // One that doesn't exist outside its folders: not_found, without its path.
      const none = await c.call('daily_note', { series: 'vacia' })
      assert.equal(none.data.error, 'not_found', none.raw)
      assert.ok(!none.raw.includes('vacia/'), none.raw)
      await c.close()
    }
    // Nothing was written: the notes as they were, and no note where there was none.
    assert.equal(readFileSync(join(h.notesDir, `proyectos/diario/${TODAY}.md`), 'utf8'), FILES[`proyectos/diario/${TODAY}.md`])
    assert.equal(readFileSync(join(h.notesDir, `fuera/diario/${TODAY}.md`), 'utf8'), FILES[`fuera/diario/${TODAY}.md`])
    assert.ok(!existsSync(join(h.notesDir, 'fuera/vacia')))
    // The person still gets it.
    const own = await h.admin('GET', '/api/daily')
    assert.deepEqual([own.status, own.body.path, own.body.exists], [200, `proyectos/diario/${TODAY}.md`, true])
  } finally { await h.close() }
})
