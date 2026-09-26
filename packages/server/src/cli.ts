#!/usr/bin/env -S node --no-experimental-webstorage
// thoth serve                         starts the server
// thoth user create <name> [--admin]  creates a user; the password is read from stdin
// thoth history purge <path> [--version <id>] [--dry-run]
//                                     rewrites the managed history without a path
//                                     (or one version's content of it); thoth stopped
//
// No Web Storage: the server doesn't use it, and lib0 (Yjs) probes for it on import,
// which on Node 26 prints an ExperimentalWarning on every startup.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathMatcher } from '@thoth/core'
import { Auth, AuthError } from './auth.ts'
import { configFromEnv, start } from './main.ts'
import { openState } from './state.ts'
import { PurgeError, purgeHistory, type PurgeReport } from './history/purge.ts'
import { describeLeftover } from './history/leftovers.ts'
import { StateInUseError } from './lock.ts'
import { Workspace } from './workspace.ts'

const USAGE = 'usage: thoth serve | thoth user create <name> [--admin] | thoth history purge <path> [--version <id>] [--dry-run]'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

async function main(argv: string[]) {
  const [cmd, sub, ...rest] = argv
  const config = configFromEnv()
  if (cmd === 'serve' || cmd === undefined) {
    const s = await start(config)
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, async () => { await s.stop(); process.exit(0) })
    return
  }
  if (cmd === 'user' && sub === 'create' && rest[0]) {
    mkdirSync(config.stateDir, { recursive: true }) // may be the first thing that runs on a new install
    const state = openState(join(config.stateDir, 'state.db'))
    try {
      if (process.stdin.isTTY) process.stderr.write('password (read from stdin; end with Ctrl-D): ')
      const user = await new Auth(state).createUser(rest[0], await readStdin(), rest.includes('--admin') ? 'admin' : 'member')
      console.log(`user created: ${user.username} (${user.role})`)
    } finally {
      state.close()
    }
    return
  }
  if (cmd === 'history' && sub === 'purge') {
    const args = parsePurge(rest)
    if (!args) return usage()
    // thoth.yaml says the mode (never the user's own repository) and what is excluded.
    const { history } = new Workspace({ notesDir: config.notesDir }).config
    const report = await purgeHistory({
      stateDir: config.stateDir, notesDir: config.notesDir, path: args.path, version: args.version, dryRun: args.dryRun,
      mode: history.mode, excluded: pathMatcher(history.exclude), git: config.history.git,
    })
    printReport(report)
    return
  }
  usage()
}

function usage() {
  console.error(USAGE)
  process.exit(2)
}

function parsePurge(args: string[]): { path: string; version?: string; dryRun: boolean } | null {
  let path: string | undefined
  let version: string | undefined
  let dryRun = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--dry-run') dryRun = true
    else if (a === '--version') {
      if (version !== undefined || args[i + 1] === undefined) return null
      version = args[++i]
    } else if (a.startsWith('--version=')) version = a.slice('--version='.length)
    else if (a.startsWith('-') || path !== undefined) return null
    else path = a
  }
  return path === undefined ? null : { path, ...(version !== undefined ? { version } : {}), dryRun }
}

function printReport(r: PurgeReport) {
  const what = r.version ? `the content of ${r.path} in ${r.version.slice(0, 10)}` : r.path
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  for (const l of r.leftovers) console.log(`note: ${describeLeftover(l)}`)
  if (r.dryRun) console.log('Dry run: nothing is changed.')
  if (r.commits.length === 0) console.log(`Nothing of ${what} is in the history.`)
  for (const c of r.commits) {
    console.log(`${c.id.slice(0, 10)}  ${c.at}  ${c.subject}${c.dropped ? '  (left empty: dropped)' : ''}`)
    for (const f of c.files) console.log(`    ${f.change.padEnd(8)}  ${f.path}`)
  }
  if (r.commits.length) {
    const [remove, rewrite] = r.dryRun ? ['Would remove', 'rewrite'] : ['Removed', 'rewrote']
    console.log(`${remove} ${plural(r.filesRemoved, 'file version')} of ${what} in ${plural(r.commits.length, 'commit')}, and ${rewrite} ${plural(r.rewritten, 'commit')}${r.dropped ? ` (${r.dropped} left empty: dropped)` : ''}.`)
  }
  if (!r.dryRun && (r.journal.pending || r.journal.queued)) {
    console.log(`Dropped from the recorder's journal: ${plural(r.journal.pending, 'open version')}, ${plural(r.journal.queued, 'queued change')}.`)
  }
  if (!r.dryRun) console.log('The history is compacted: nothing unreachable is left in it.')
  for (const p of r.stillOnDisk) {
    console.log(`warning: ${p} is still in the notes folder: its content ${r.dryRun ? 'would enter' : 'enters'} the history again with its next version. Delete it, or add it to history.exclude in thoth.yaml.`)
  }
  if (r.sharedWith.length) console.log(`warning: the same content is also in the history under ${r.sharedWith.join(', ')}; it stays stored there. Purge those paths too.`)
  if (r.movedFrom.length) console.log(`note: before a move, it was ${r.movedFrom.join(', ')}; the versions from before are under that path.`)
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof AuthError) console.error(`error: ${err.message}`)
  else if (err instanceof PurgeError || err instanceof StateInUseError) console.error(`error (${err.code}): ${err.message}`)
  else console.error(err)
  process.exit(1)
})
