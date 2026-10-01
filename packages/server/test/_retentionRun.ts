// One retention run over the folders of a history setup (_history.ts), in a
// process of its own: the crash tests kill it on the way
// (VIHKO_TEST_CRASH_AT), as a kill -9 of the server would. Prints the run.
// `node _retentionRun.ts <dir> <now ms>`.
import { join } from 'node:path'
import { AdminSettings, History, Indexer, NoteService, Notices, Retention, Workspace, openIndex, openState } from '@vihko/server'

const [dir, at] = process.argv.slice(2) as [string, string]
const notesDir = join(dir, 'notes')
const stateDir = join(dir, 'state')
const state = openState(join(dir, 'state.db'))
const index = openIndex(join(dir, 'index.db'))
const workspace = new Workspace({ notesDir })
const indexer = new Indexer({ notesDir, db: index })
indexer.scan({})
const history = new History({ notesDir, stateDir, config: () => workspace.config.history })
await history.open()
await history.start()
await history.recorder.settle()
const notes = new NoteService({ notesDir, stateDir, indexer, db: index, history: history.recorder })
const retention = new Retention({ stateDir, settings: new AdminSettings(state), trash: () => notes.trash(), history, notices: new Notices(state), now: () => Number(at) })
const run = await retention.run()
await history.close()
index.close()
state.close()
console.log(JSON.stringify(run))
