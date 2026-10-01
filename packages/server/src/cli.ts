#!/usr/bin/env -S node --no-experimental-webstorage
// vihko serve | vihko                 starts the server
// vihko user create <name> [--admin]  creates a user; the password is read from stdin
//                                     (--admin before or after the name)
// vihko user reset-link <name>        a one-time link for them to choose a password
//                                     (7 days; the way back for an admin who lost theirs)
// vihko user reset-2fa <name>         takes their second factor away (with reset-link,
//                                     the way back for an admin who lost password and phone)
// vihko history purge <path> [--version <id>] [--dry-run]
//                                     rewrites the managed history without a path
//                                     (or one version's content of it); vihko stopped
// vihko version | vihko --version     prints vihko's version
//
// Exit status (guide/compatibility.md): 0 done, 1 an error (`error: …` or
// `error (<code>): …`), 2 a command or arguments it doesn't take (the usage).
//
// No Web Storage: the server doesn't use it, and lib0 (Yjs) probes for it on import,
// which on Node 26 prints an ExperimentalWarning on every startup.
import { join } from 'node:path'
import { pathMatcher } from '@vihko/core'
import { Auth, AuthError, userIdByName } from './auth.ts'
import { configFromEnv, start } from './main.ts'
import { Users, UsersError } from './users.ts'
import { TwoFactor } from './twoFactor.ts'
import { openState } from './state.ts'
import { PurgeError, purgeHistory, type PurgeReport } from './history/purge.ts'
import { describeLeftover } from './history/leftovers.ts'
import { StateInUseError } from './lock.ts'
import { StartupError, checkVolumes, prepareStateDir } from './volumes.ts'
import { Workspace } from './workspace.ts'
import { VERSION } from './version.ts'

const USAGE = 'usage: vihko serve | vihko user create <name> [--admin] | vihko user reset-link <name> | vihko user reset-2fa <name> | vihko history purge <path> [--version <id>] [--dry-run] | vihko version'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

async function main(argv: string[]) {
  const [cmd, sub, ...rest] = argv
  // Before the configuration: it answers whatever the environment says.
  if ((cmd === 'version' || cmd === '--version') && sub === undefined) {
    console.log(VERSION)
    return
  }
  serving = cmd === undefined || (cmd === 'serve' && sub === undefined)
  const config = envConfig()
  if (serving) {
    const s = await start(config)
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, async () => { await s.stop(); process.exit(0) })
    return
  }
  if (cmd === 'user' && sub === 'create') {
    const args = parseCreate(rest)
    if (!args) return usage()
    // May be the first thing that runs on a new install.
    checkVolumes({ stateDir: config.stateDir })
    prepareStateDir(config.stateDir)
    const state = openState(join(config.stateDir, 'state.db'))
    try {
      if (process.stdin.isTTY) process.stderr.write('password (read from stdin; end with Ctrl-D): ')
      // With their personal folder (people/<name>, D-056), and the product's two folders if this is the first thing that runs.
      const auth = new Auth(state, { notesDir: config.notesDir })
      auth.personalFolders?.ensureLayout()
      const user = await auth.createUser(args.name, await readStdin(), args.admin ? 'admin' : 'member')
      console.log(`user created: ${user.username} (${user.role})`)
    } finally {
      state.close()
    }
    return
  }
  if (cmd === 'user' && sub === 'reset-link' && rest[0] && rest.length === 1) {
    const state = openState(join(config.stateDir, 'state.db'))
    try {
      const auth = new Auth(state)
      const name = rest[0].normalize('NFC').trim()
      const id = userIdByName(state, name)
      const row = id === null ? undefined : { id }
      if (!row) throw new UsersError('not_found', `no user ${name}`)
      // Written straight into state.db: a running vihko reads it on the next request.
      const link = new Users(auth).newLink(row.id)
      const path = `/invite/${link.token}`
      const base = config.publicUrl
      console.log(`${link.kind === 'invite' ? 'invitation' : 'password reset'} link for ${name}, valid until ${link.expiresAt} (any earlier link of theirs no longer works):`)
      console.log(base ? `${base}${path}` : `  <vihko's address>${path}`)
    } finally {
      state.close()
    }
    return
  }
  // A reset link keeps a second factor on purpose (whoever intercepts the
  // link still needs the code): someone with the server's shell takes it
  // away here, for whoever lost it with no admin left to reset it.
  if (cmd === 'user' && sub === 'reset-2fa' && rest[0] && rest.length === 1) {
    const state = openState(join(config.stateDir, 'state.db'))
    try {
      const name = rest[0].normalize('NFC').trim()
      const id = userIdByName(state, name)
      const row = id === null ? undefined : { id }
      if (!row) throw new UsersError('not_found', `no user ${name}`)
      // Written straight into state.db: a running vihko reads it on the next request.
      const had = new TwoFactor(state).disable(row.id)
      console.log(had ? `second factor removed for ${name}: they sign in with their password alone (or set up a new one, if it's required)` : `${name} had no second factor`)
    } finally {
      state.close()
    }
    return
  }
  if (cmd === 'history' && sub === 'purge') {
    const args = parsePurge(rest)
    if (!args) return usage()
    // vihko.yaml says the mode (never the user's own repository) and what is excluded.
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

/**
 * `<name> [--admin]`, `--admin` before or after the name. Anything else (no
 * name, two, another option) is not understood: never a user named after an
 * option.
 */
function parseCreate(args: string[]): { name: string; admin: boolean } | null {
  const names = args.filter((a) => a !== '--admin')
  if (names.length !== 1 || names[0]!.startsWith('-') || names[0] === '') return null
  return { name: names[0]!, admin: args.includes('--admin') }
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
    console.log(`warning: ${p} is still in the notes folder: its content ${r.dryRun ? 'would enter' : 'enters'} the history again with its next version. Delete it, or add it to history.exclude in vihko.yaml.`)
  }
  if (r.sharedWith.length) console.log(`warning: the same content is also in the history under ${r.sharedWith.join(', ')}; it stays stored there. Purge those paths too.`)
  if (r.movedFrom.length) console.log(`note: before a move, it was ${r.movedFrom.join(', ')}; the versions from before are under that path.`)
}

/** A variable vihko can't use is the person's to fix, not a bug: its message says which and why. */
function envConfig() {
  try {
    return configFromEnv()
  } catch (err) {
    throw new StartupError([(err as Error).message])
  }
}

/** Whether the command is the server, whose log lines start with [vihko]. */
let serving = false

main(process.argv.slice(2)).catch((err) => {
  const prefix = serving ? '[vihko] ' : 'error: '
  // What the person can fix, said in a line each: a stack trace would only hide it.
  if (err instanceof StartupError) for (const line of err.lines) console.error(`${prefix}${line}`)
  else if (err instanceof AuthError) console.error(`error (${err.code}): ${err.message}`)
  else if (err instanceof UsersError) console.error(`error (${err.code}): ${err.message}`)
  else if (err instanceof PurgeError || err instanceof StateInUseError) console.error(`${serving ? '[vihko] ' : ''}error (${err.code}): ${err.message}`)
  else {
    // Unexpected: a line to read, and the stack, which is what finds the bug.
    if (serving) console.error(`[vihko] vihko couldn't start: ${err instanceof Error ? err.message : String(err)}`)
    console.error(err)
  }
  process.exit(1)
})
