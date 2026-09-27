// An agent's move that opens a note to more people (D-040 3.2): the dry run
// says who gains and loses access, to agents too, and a move that widens it
// goes through only with the audience confirmed; one that narrows it needs
// nothing. Over the API with a key and over MCP, on the M4 scenario.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ADMIN, FILES, GROUP, MEMBER, OTHER, setup } from './_m4.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** Who gains access when the admin's plan goes to the shared folder: both members, in the order thoth lists them (by name). */
const GAINERS = [MEMBER.username, OTHER.username].sort((a, b) => a.localeCompare(b))
/** The admin's note that the agent moves to the shared folder. */
const PLAN = { from: `personas/${ADMIN.username}/plan.md`, to: 'familia/plan.md' }

test('API: an agent\'s move that widens access needs confirmAudience; the dry run says who gains it; narrowing needs nothing', async () => {
  const h = await setup({ files: FILES })
  try {
    await h.enable()
    const membersKey = m.aKeyName()
    await h.newKey('member', { name: membersKey })
    const agent = h.withKey((await h.newKey('admin', { name: 'K', canWrite: true })).token)
    const plan = PLAN

    const dry = await agent('POST', '/api/note/move', { ...plan, dryRun: true })
    assert.equal(dry.status, 200, dry.text)
    const gain = { users: { gain: GAINERS, lose: [] }, groups: { gain: [GROUP], lose: [] }, keys: { gain: 1, lose: 0 } }
    const brief = (a: { users: { gain: { username: string }[]; lose: { username: string }[] }; groups: unknown; keys: unknown }) =>
      ({ users: { gain: a.users.gain.map((u) => u.username), lose: a.users.lose.map((u) => u.username) }, groups: a.groups, keys: a.keys })
    assert.deepEqual(brief(dry.body.audience), gain)
    assert.ok(!dry.text.includes(membersKey), 'keys are counted, never named')

    // Without the confirmation: refused with the change, and nothing moved.
    const refused = await agent('POST', '/api/note/move', plan)
    assert.deepEqual([refused.status, refused.body.error], [409, 'audience_widens'], refused.text)
    assert.deepEqual(brief(refused.body.audience), gain)
    assert.ok(existsSync(join(h.notesDir, plan.from)) && !existsSync(join(h.notesDir, plan.to)))
    assert.equal((await agent('POST', '/api/note/move', { ...plan, confirmAudience: 'yes' })).status, 409, 'only true confirms')

    // Confirmed (the person agreed): it moves.
    const moved = await agent('POST', '/api/note/move', { ...plan, confirmAudience: true })
    assert.equal(moved.status, 200, moved.text)
    assert.equal(moved.body.audience, undefined, 'the change is the dry run\'s')
    assert.equal((await h.member('GET', h.url('/api/note', { path: plan.to }))).status, 200)

    // Narrowing (back to his folder): nothing to confirm.
    const back = await agent('POST', '/api/note/move', { from: plan.to, to: plan.from })
    assert.equal(back.status, 200, back.text)
    // Nor a move within the same audience.
    assert.equal((await agent('POST', '/api/note/move', { from: 'admin/ajustes.md', to: 'admin/config.md' })).status, 200)

    // A person moves as before: the UI asks them (D-038), the API doesn't.
    assert.equal((await h.admin('POST', '/api/note/move', plan)).status, 200)
  } finally { await h.close() }
})

test('MCP: move with dry_run gives the audience; widening needs confirm_audience, and the instructions say to ask first', async () => {
  const h = await setup({ files: FILES })
  try {
    await h.enable()
    const c = await h.mcp((await h.newKey('admin', { name: 'K', canWrite: true })).token)
    try {
      const instructions = c.client.getInstructions() ?? ''
      assert.match(instructions, /audience_widens/)
      assert.match(instructions, /ask the person/)
      const tool = (await c.client.listTools()).tools.find((t) => t.name === 'move')!
      assert.ok('confirm_audience' in (tool.inputSchema.properties ?? {}))
      assert.match(tool.description ?? '', /audience_widens/)

      const plan = PLAN
      const dry = await c.call('move', { ...plan, dry_run: true })
      assert.equal(dry.error, false, dry.raw)
      assert.deepEqual(dry.data.audience, { users: { gain: GAINERS, lose: [] }, groups: { gain: [GROUP], lose: [] }, keys: { gain: 0, lose: 0 } })

      const refused = await c.call('move', plan)
      assert.equal(refused.error, true)
      assert.equal(refused.data.error, 'audience_widens')
      assert.deepEqual(refused.data.audience.users.gain, GAINERS)
      assert.ok(existsSync(join(h.notesDir, plan.from)))

      const moved = await c.call('move', { ...plan, confirm_audience: true })
      assert.equal(moved.error, false, moved.raw)
      assert.ok(existsSync(join(h.notesDir, plan.to)))
      // camelCase works too, and narrowing needs nothing.
      const back = await c.call('move', { from: plan.to, to: plan.from })
      assert.equal(back.error, false, back.raw)
      const again = await c.call('move', { ...plan, confirmAudience: true })
      assert.equal(again.error, false, again.raw)
    } finally { await c.close() }
  } finally { await h.close() }
})
