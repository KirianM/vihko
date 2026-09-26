// The user's own git repository, for the tests of the unmanaged history: git
// as they would run it from a terminal (never thoth's), and a snapshot of a
// `.git` to prove thoth never writes to it.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

export const ANA = { name: 'Ana Pérez', email: 'ana@example.com' }
export const BEA = { name: 'Bea', email: 'bea@example.com' }

/** The environment the user's git runs with in tests: nothing from the machine's configuration. */
export function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && v !== undefined) env[k] = v
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...extra }
}

/**
 * A new repository at `top`, and commits a minute apart by whoever. On NFS
 * its files belong to another user (`nobody`): the user trusts it by its path.
 */
export function userGit(top: string) {
  let clock = Date.parse('2026-03-01T09:00:00Z') / 1000
  const run = (args: string[], env: Record<string, string> = {}, input?: string | Buffer) =>
    execFileSync('git', ['-c', `safe.directory=${top}`, ...args], { cwd: top, env: gitEnv(env), encoding: 'utf8', input, maxBuffer: 1 << 28 })
  const repo = {
    run,
    head: () => run(['rev-parse', 'HEAD']).trim(),
    /** Commits what changed (`add: false`: only what is staged already), as `who`. */
    commit(message: string, who = ANA, opts: { add?: boolean } = {}): { id: string; at: string } {
      clock += 60
      const date = new Date(clock * 1000).toISOString().slice(0, 19) + '+0000'
      if (opts.add !== false) run(['add', '-A'])
      run(['commit', '-q', '-m', message], { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email, GIT_COMMITTER_DATE: date })
      return { id: repo.head(), at: new Date(clock * 1000).toISOString() }
    },
  }
  run(['init', '-q', '-b', 'main'])
  return repo
}

/** Every file and folder of a `.git`: contents, sizes and modification times (a lock taken and dropped changes its folder's). */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (rel: string) => {
    const abs = join(dir, rel)
    const st = lstatSync(abs, { bigint: true })
    if (st.isDirectory()) {
      out[`${rel}/`] = `dir ${st.mtimeNs}`
      for (const name of readdirSync(abs).sort()) walk(rel ? `${rel}/${name}` : name)
    } else if (st.isSymbolicLink()) out[rel] = `link ${readlinkSync(abs)}`
    else out[rel] = `file ${st.size} ${st.mtimeNs} ${createHash('sha256').update(readFileSync(abs)).digest('hex')}`
  }
  walk('')
  return out
}
