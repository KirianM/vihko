// M3 «done when» (m3 §9, points 1 to 4 and 6) against the real server over
// the generated vault: an agent writes a plan over MCP, a person edits it in
// the editor, the agent sees the change and folds it in while the note is
// open (the editor gets it live, with the agent's presence), the history
// shows both, and nothing hidden from the key reaches it (_m3.ts). The same
// runs against the Docker image in docker.acceptance.ts.
import { test } from 'node:test'
import { login } from '../_collab.ts'
import { NOTES, cleanup, startServer, workspace, type Server } from './_harness.ts'
import { m3DoneWhen } from './_m3.ts'

test(`M3 done when, over ${NOTES} notes: an agent writes a plan, a person edits it, the agent sees it and folds it in, all in the history, nothing hidden leaks`, { timeout: 300_000 }, async () => {
  const ws = workspace('agents')
  let srv: Server | null = null
  try {
    srv = await startServer({ ...ws.env, THOTH_HISTORY_QUIET_SECONDS: '1', THOTH_RESCAN_SECONDS: '5' })
    await m3DoneWhen({ srv, cookie: await login(srv), notesDir: ws.notesDir })
  } finally {
    await srv?.stop()
    cleanup(ws)
  }
})
