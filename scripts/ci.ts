// `npm run ci`: the four jobs of .github/workflows/ci.yml (check, acceptance,
// docker, e2e) on this machine, over a clean copy of the code on local disk.
// GitHub runs them only for Dependabot's pull requests; everything else is
// tested here, and `--post` reports the result as the `ci/local` commit status.
//
//   npm run ci                       the last commit of this checkout
//   npm run ci -- --pr 72            pull request 72 merged onto its base, as GitHub tests it
//   npm run ci -- --ref origin/main  a commit (fetch first to test the latest main)
//   npm run ci -- --jobs check,e2e   some jobs only
//   npm run ci -- --jobs e2e --grep 'two-factor\.spec'
//                                    only the tests matching a pattern (below)
//   npm run ci -- --keep             keep the run's folder (worktree, data) to debug
//   npm run ci -- --pr 72 --post     pending, then success or failure, on the PR's head commit
//   npm run ci -- --parallel         the jobs at the same time (faster, but see CONTRIBUTING.md)
//   npm run ci -- --clean            remove the folders and logs of earlier runs
//
// To run again only what failed: `--jobs` with the failed jobs and, for
// browser tests, `--grep` with their files (a failed run prints the command).
// `--grep` is a regular expression: Playwright matches it against the file
// name and the titles (`two-factor\.spec`, `purge`), `node --test` against
// test names only (--test-name-pattern). A run of some jobs or tests is not the
// CI: with `--post` it reports as `ci/local-partial`, never `ci/local`, which
// only a run of every job and test sets.
//
// Browser tests that fail run once more (Playwright's retries, with a trace).
// One that passes then is flaky: the job passes, and the summary, the job's
// line and the posted status say which, so it's never silent.
//
// Each run has its own folder (THOTH_CI_DIR, /var/tmp/thoth-ci by default:
// local disk, never NFS nor a tmpfs /tmp) with a git worktree, TMPDIR, test
// data and logs; free ports of its own; and containers and an image named after
// it. Whatever happens (a failure, a timeout, Ctrl-C), it stops its processes,
// found by their working directory (killing `npm run` leaves its grandchildren
// alive), removes its containers, image and worktree, and keeps only the logs.
// A run killed outright (kill -9) is cleaned up by the next one.
//
// The tests draw their data (people, passwords, notes…) from one seed per
// run (test/seed.ts): THOTH_TEST_SEED, or a new one. Every job gets the same,
// the Playwright container included; the run prints it, and the summary and
// a failure give it with the command that runs again with the same data.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { createServer } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { SEED_VARIABLE, testSeed } from '../test/seed.ts'

const JOBS = ['check', 'acceptance', 'docker', 'e2e'] as const
type Job = (typeof JOBS)[number]
type Stage = 'setup' | Job
/** Minutes: the workflow's timeout-minutes. Setup is the `npm ci` and build every job there starts with. */
const LIMIT: Record<Stage, number> = { setup: 15, check: 20, acceptance: 30, docker: 30, e2e: 45 }
const USAGE = `Usage: npm run ci -- [--pr N | --ref COMMIT] [--jobs ${JOBS.join(',')}] [--grep PATTERN] [--keep] [--post] [--parallel] | --clean`
const HELP = `  --pr N          pull request N merged onto its base, as GitHub tests it
  --ref COMMIT    a commit (fetch first to test the latest main); by default, this checkout's HEAD
  --jobs LIST     some jobs only, e.g. e2e or check,e2e
  --grep PATTERN  only the tests matching this regular expression: Playwright matches the
                  file name and titles (e.g. 'two-factor\\.spec'), node --test the test names
  --post          report as a commit status: ci/local for a run of every job and test,
                  ci/local-partial for one with --jobs or --grep (never ci/local)
  --keep          keep the run's folder (worktree, data) to debug
  --parallel      the jobs at the same time (faster, but see CONTRIBUTING.md)
  --clean         remove the folders and logs of earlier runs

A failed run prints the command that runs again only what failed. Browser tests
that fail run once more; one that passes then is reported as flaky.`

const REPO = dirname(fileURLToPath(new URL('.', import.meta.url)))
const BASE = process.env.THOTH_CI_DIR ?? '/var/tmp/thoth-ci'
/** Logs of finished runs are kept this long. */
const LOG_DAYS = 7

let opt: { pr?: string; ref?: string; jobs?: string; grep?: string; keep?: boolean; post?: boolean; parallel?: boolean; clean?: boolean; help?: boolean }
try {
  opt = parseArgs({
    options: {
      pr: { type: 'string' }, ref: { type: 'string' }, jobs: { type: 'string' }, grep: { type: 'string' }, keep: { type: 'boolean' }, post: { type: 'boolean' },
      parallel: { type: 'boolean' }, clean: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  }).values
} catch (err) {
  console.error(`${(err as Error).message}\n${USAGE}`)
  process.exit(2)
}
if (opt.help) {
  console.log(`${USAGE}\n\n${HELP}`)
  process.exit(0)
}
const selected = (opt.jobs ?? JOBS.join(',')).split(',').map((j) => j.trim()).filter(Boolean)
const unknown = selected.filter((j) => !(JOBS as readonly string[]).includes(j))
if (unknown.length || selected.length === 0) usage(`unknown jobs: ${unknown.join(', ') || '(none)'}`)
if (opt.pr !== undefined && !/^\d+$/.test(opt.pr)) usage('--pr takes a pull request number')
if (opt.pr !== undefined && opt.ref !== undefined) usage('--pr or --ref, not both')
if (opt.grep !== undefined) {
  try { new RegExp(opt.grep) } catch (err) { usage(`--grep: ${(err as Error).message}`) }
  if (opt.grep === '') usage('--grep takes a pattern')
}
const jobs = JOBS.filter((j) => selected.includes(j))
/** Some jobs, or some tests: never the whole CI, so never `ci/local` (see the top). */
const partial = jobs.length !== JOBS.length || opt.grep !== undefined
const CONTEXT = partial ? 'ci/local-partial' : 'ci/local'
/**
 * One after another unless --parallel. Measured on the 6-CPU machine the CI
 * runs on: 12m30s one after another, 8m at once; but at once, one run in three
 * failed a timing-dependent unit test (two writes more than 150 ms apart), which
 * never failed one after another. A CI that fails from its own load is worse
 * than a slower one.
 */
const parallel = opt.parallel === true && jobs.length > 1
/** The test data's seed, for every job (the environment of each is built without THOTH_ variables, so it's put back there). */
const SEED = testSeed()

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// The run

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const ID = `${stamp}-${opt.pr ? `pr${opt.pr}` : opt.ref ? 'ref' : 'head'}-${randomBytes(2).toString('hex')}`
const RUN = join(BASE, ID)
const TREE = join(RUN, 'repo')
const LOGS = join(RUN, 'logs')
const IMAGE = `thoth-ci:${ID}`
const LABEL = `thoth-ci=${ID}`
/** Git refuses a work tree whose repository belongs to another user (NFS maps it to nobody): this one is ours. */
const SAFE = ['-c', `safe.directory=${TREE}`]

type Status = 'OK' | 'FAILED' | 'CANCELLED' | 'SKIPPED'
/** `flaky`: browser tests that failed and then passed on their retry; `info`: what else the job's line says. */
interface Result { stage: Stage; status: Status; ms: number; why?: string; log: string; flaky?: string[]; info?: string }
interface Ctx { stage: Stage; log: string; fd: number; env: NodeJS.ProcessEnv; deadline: number; procs: Set<ChildProcess>; info: string[] }

/** What this run tests, in words: its jobs, and its pattern if it has one. */
const what = () => `${jobs.join(', ')}${opt.grep !== undefined ? ` (--grep ${opt.grep})` : ''}`
/** A test as Playwright names it, shorter: its file and title. */
const short = (test: string) => test.replace(/^(?:\[[^\]]*\] › )?(?:e2e\/|acceptance\/)?([^:]+):\d+:\d+ › /, '$1 › ').slice(0, 60)
/** Quoted for a POSIX shell, when it has to be. */
const shell = (s: string) => (/^[\w.,/:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/**
 * The command that runs again only what failed: the same target, the failed
 * jobs, and for browser tests their files (or this run's --grep). Null when
 * nothing failed, or the setup did (then everything runs again anyway).
 */
function rerun(failed: Result[]): string | null {
  if (!failed.length || failed.some((r) => r.stage === 'setup')) return null
  const args = [...(opt.pr ? ['--pr', opt.pr] : opt.ref ? ['--ref', opt.ref] : []), '--jobs', failed.map((r) => r.stage).join(',')]
  const e2e = failed.find((r) => r.stage === 'e2e')
  const files = e2e ? [...new Set(playwrightSummary(e2e.log).failed.map((t) => /([^/\s]+\.spec\.ts):\d+/.exec(t)?.[1]).filter((f): f is string => !!f))] : []
  // A pattern only when the browser tests are all that failed: it would filter the others' tests too.
  if (failed.length === 1 && files.length) args.push('--grep', files.map((f) => f.replace(/[.]/g, '\\.')).join('|'))
  else if (opt.grep !== undefined) args.push('--grep', opt.grep)
  return `${SEED_VARIABLE}=${SEED} npm run ci -- ${args.map(shell).join(' ')}`
}

/**
 * Playwright's closing summaries in a log (the list reporter's `N failed`
 * and `N flaky` sections, one per `playwright test` in it): the tests named.
 */
function playwrightSummary(log: string): { failed: string[]; flaky: string[] } {
  const found = { failed: [] as string[], flaky: [] as string[] }
  let lines: string[]
  try { lines = readFileSync(log, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n') } catch { return found }
  for (let i = 0; i < lines.length; i++) {
    const head = /^\s+\d+ (failed|flaky)$/.exec(lines[i]!)
    if (!head) continue
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^\s{4,}(\S.* › .+?)[\s─]*$/.exec(lines[j]!)
      if (!item) break
      found[head[1] as 'failed' | 'flaky'].push(item[1]!)
    }
  }
  return found
}

/** A step that failed; the message says which and why. */
class Failure extends Error {}

const abort = new AbortController()
let signalled: string | null = null
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    if (signalled) return
    signalled = sig
    say(`\n${sig}: stopping the run and cleaning up…`)
    abort.abort()
  })
}
// The terminal may be gone (SIGHUP): writing to it must not stop the cleanup.
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})

const tty = process.stdout.isTTY === true
const say = (s: string) => process.stdout.write(s + '\n')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const clock = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}
const time = () => new Date().toTimeString().slice(0, 8)

async function main(): Promise<number> {
  await tidy(false)
  mkdirSync(RUN, { recursive: true })
  writeFileSync(join(RUN, 'run.json'), JSON.stringify({ id: ID, pid: process.pid, keep: opt.keep === true }) + '\n')
  mkdirSync(LOGS, { recursive: true })
  const [e2e, locked, external, acc, docker] = await freePorts(5)
  const ports: Record<Job, Record<string, number>> = {
    check: {},
    acceptance: {},
    docker: { DOCKER_PORT: docker! },
    e2e: { E2E_PORT: e2e!, E2E_LOCKED_PORT: locked!, E2E_EXTERNAL_PORT: external!, ACC_PORT: acc! },
  }
  say(`thoth CI · ${ID}`)
  say(`  folder  ${RUN}`)
  say(`  jobs    ${jobs.join(', ')} (${parallel ? 'in parallel' : 'one after another'})`)
  if (opt.grep !== undefined) say(`  grep    ${opt.grep} (only the tests it matches)`)
  say(`  ports   e2e ${e2e}, locked ${locked}, images ${external}, acceptance ${acc}, docker ${docker}`)
  say(`  seed    ${SEED} (the test data's: ${SEED_VARIABLE}=${SEED} npm run ci … runs with the same)`)
  say('')

  const t0 = Date.now()
  const results: Result[] = []
  const notes: string[] = []
  const s: { target: Target | null; posted: boolean } = { target: null, posted: false }
  try {
    const setup = await stage('setup', {}, async (c) => {
      const target = await resolve(c, notes)
      s.target = target
      note(c, `testing ${target.what}`)
      if (opt.post) {
        post(target.sha, 'pending', `Running ${what()} on ${hostname()}`)
        s.posted = true
      }
      await checkout(c, target)
      await run(c, 'npm', ['ci'])
      if (jobs.includes('check') || jobs.includes('e2e')) await run(c, 'npm', ['run', 'build'])
    })
    results.push(setup)
    if (setup.status !== 'OK') {
      for (const j of jobs) results.push(skipped(j))
    } else if (parallel) {
      results.push(...(await Promise.all(jobs.map((j) => stage(j, ports[j], JOB[j])))))
    } else {
      for (const j of jobs) {
        if (abort.signal.aborted) results.push(skipped(j))
        else results.push(await stage(j, ports[j], JOB[j]))
        // Whatever a job left running (a server of a test that hung) goes before the next one starts.
        await sweep(RUN)
      }
    }
  } finally {
    const total = Date.now() - t0
    const failed = results.filter((r) => r.status === 'FAILED')
    const flaky = results.flatMap((r) => r.flaky ?? [])
    const outcome = signalled ? 'CANCELLED' : failed.length ? 'FAILED' : flaky.length ? `OK, with ${flaky.length} flaky` : 'OK'
    const again = signalled ? null : rerun(failed)
    const tail = [
      `total ${clock(total)} · ${outcome}`,
      ...failed.map((r) => `\n${r.stage} FAILED: ${r.why}\n  log: ${r.log}`),
      ...(flaky.length ? [`\nflaky (failed, then passed on their retry; see the log and the retry's trace):`, ...flaky.map((t) => `  ${t}`)] : []),
      ...(again ? [`\nonly what failed, again (with the same test data): ${again}`] : []),
      `seed: ${SEED} (the test data's; ${SEED_VARIABLE}=${SEED} repeats it)`,
      ...notes,
      ...(s.target ? [`target: ${s.target.what}`] : []),
    ]
    say(['', ...tail].join('\n'))
    try { writeFileSync(join(LOGS, 'summary.txt'), [...results.map(line), ...tail].join('\n') + '\n') } catch {}
    if (s.posted && s.target) {
      const [state, description] = signalled ? ['error', `Cancelled after ${clock(total)}`] as const
        : failed.length ? ['failure', `${failed.map((r) => r.stage).join(', ')} failed with seed ${SEED}: ${failed[0]!.why} (${clock(total)})`] as const
        : ['success', `${what()} passed in ${clock(total)}${flaky.length ? `; ${flaky.length} flaky: ${flaky.map(short).join(', ')}` : ''}`] as const
      post(s.target.sha, state, description)
      say(`${CONTEXT} → ${state} on ${s.target.sha.slice(0, 7)}`)
    }
    const done = await cleanup(ID, RUN, opt.keep === true)
    say(`cleanup: ${done.join('; ') || 'nothing was left'}`)
    say(opt.keep ? `kept: ${RUN} (its processes stopped; npm run ci -- --clean removes it)` : `logs: ${LOGS}`)
  }
  if (signalled) return 130
  return results.every((r) => r.status === 'OK') ? 0 : 1
}

// ---------------------------------------------------------------------------
// What to test

interface Target { what: string; sha: string; merge?: { number: number; base: string; baseName: string } }

/** The commit the status goes on, and what the run tests, told in words. */
async function resolve(c: Ctx, notes: string[]): Promise<Target> {
  if (!opt.pr) {
    const rev = opt.ref ?? 'HEAD'
    const sha = must(git(['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]), `git rev-parse ${rev}`)
    if (!opt.ref && git(['status', '--porcelain', '--untracked-files=no']).out) notes.push('note: this checkout has uncommitted changes; the run tested its last commit, without them')
    return { what: `${rev} ${sha.slice(0, 7)}${opt.ref ? '' : ` of ${REPO}`}`, sha }
  }
  const pr = JSON.parse(must(capture('gh', ['pr', 'view', opt.pr, '--json', 'number,title,headRefOid,baseRefName,state']), `gh pr view ${opt.pr}`)) as
    { number: number; title: string; headRefOid: string; baseRefName: string; state: string }
  if (pr.state !== 'OPEN') notes.push(`note: #${pr.number} is ${pr.state.toLowerCase()}`)
  await run(c, 'git', [...SAFE, 'fetch', '--no-tags', 'origin', `+refs/pull/${pr.number}/head:refs/thoth-ci/${ID}`, `+refs/heads/${pr.baseRefName}:refs/remotes/origin/${pr.baseRefName}`],
    { cwd: REPO, limitMs: 5 * 60_000, label: 'git fetch' })
  const head = must(git(['rev-parse', `refs/thoth-ci/${ID}`]), 'git rev-parse')
  if (head !== pr.headRefOid) notes.push(`note: #${pr.number} moved while the run started; it tested ${head.slice(0, 7)}`)
  const base = must(git(['rev-parse', `refs/remotes/origin/${pr.baseRefName}`]), 'git rev-parse')
  return {
    what: `#${pr.number} "${pr.title}": its head ${head.slice(0, 7)} merged onto ${pr.baseRefName} ${base.slice(0, 7)}`,
    sha: head,
    merge: { number: pr.number, base, baseName: pr.baseRefName },
  }
}

/** The worktree on local disk: the commit, or the pull request merged onto its base as GitHub does. */
async function checkout(c: Ctx, t: Target) {
  const m = t.merge
  await run(c, 'git', [...SAFE, 'worktree', 'add', '--detach', TREE, m ? m.base : t.sha], { cwd: REPO, label: 'git worktree add' })
  if (!m) return
  try {
    await run(c, 'git', [...SAFE, '-c', 'user.name=thoth CI', '-c', 'user.email=ci@localhost', 'merge', '--no-ff', '--no-edit', '-m', `Merge #${m.number} into ${m.baseName}`, t.sha],
      { cwd: TREE, label: 'git merge' })
  } catch (err) {
    if (abort.signal.aborted) throw err
    const conflicts = git(['diff', '--name-only', '--diff-filter=U'], TREE).out.split('\n').filter(Boolean)
    throw new Failure(`#${m.number} does not merge onto ${m.baseName}${conflicts.length ? `: conflicts in ${conflicts.join(', ')}` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// The jobs, as in the workflow

const JOB: Record<Job, (c: Ctx) => Promise<void>> = {
  async check(c) {
    await run(c, 'npm', ['run', 'typecheck'])
    await run(c, 'npm', ['test'], { env: nodeTestFilter(c) })
  },

  async acceptance(c) {
    // The docker job runs that part against the image it builds.
    await run(c, 'npm', ['run', 'acceptance'], { env: { ACCEPTANCE_DOCKER: '0', ...nodeTestFilter(c) } })
  },

  async docker(c) {
    await run(c, 'docker', ['build', '--pull', '--progress=plain', '--label', LABEL, '-t', IMAGE, '.'])
    const name = `thoth-ci-${ID}`
    const base = `http://127.0.0.1:${c.env.DOCKER_PORT}`
    // Its own HEALTHCHECK, every 2 s instead of 30 so it answers soon.
    await run(c, 'docker', ['run', '-d', '--name', name, '--label', LABEL, '-p', `127.0.0.1:${c.env.DOCKER_PORT}:8080`, '--health-interval', '2s', IMAGE], { limitMs: 60_000 })
    try {
      await waitFor(c, 'the container answers /api/health', 30_000, () => answers(`${base}/api/health`))
      await waitFor(c, 'its HEALTHCHECK says healthy', 60_000, () => capture('docker', ['inspect', '-f', '{{.State.Health.Status}}', name]).out === 'healthy')
      await waitFor(c, 'it serves the UI', 10_000, () => answers(`${base}/`, (body) => body.includes('id="root"')))
    } finally {
      await run(c, 'docker', ['logs', name], { limitMs: 30_000 }).catch(() => {})
      await run(c, 'docker', ['rm', '-f', name], { limitMs: 60_000 }).catch(() => {})
    }
    await run(c, process.execPath, ['--test', '--test-force-exit', 'packages/server/test/acceptance/docker.acceptance.ts'], { env: { ACCEPTANCE_IMAGE: IMAGE, ...nodeTestFilter(c) } })
  },

  // The servers run here and the browser in the Playwright image, on the host's network.
  // With --grep, a suite none of whose tests match is skipped, server included.
  async e2e(c) {
    const web = join(TREE, 'packages/web')
    try {
      const base = `http://127.0.0.1:${c.env.E2E_PORT}`
      const e2e = { E2E_BASE_URL: base, E2E_PORT: c.env.E2E_PORT!, E2E_LOCKED_PORT: c.env.E2E_LOCKED_PORT!, E2E_EXTERNAL_PORT: c.env.E2E_EXTERNAL_PORT!, E2E_DIR: join(RUN, 'data/e2e') }
      const acc = { ACC_BASE_URL: `http://127.0.0.1:${c.env.ACC_PORT}`, ACC_PORT: c.env.ACC_PORT!, ACC_DIR: join(RUN, 'data/acceptance') }
      const suites = [
        { script: 'e2e', env: e2e, config: [], serve: ['e2e/serve.ts'], urls: [`${base}/api/health`, `http://127.0.0.1:${c.env.E2E_LOCKED_PORT}/api/health`], ms: 60_000 },
        { script: 'acceptance:ui', env: acc, config: ['-c', 'playwright.acceptance.config.ts'], serve: ['acceptance/serve.ts'], urls: [`${acc.ACC_BASE_URL}/api/health`], ms: 180_000 },
      ]
      for (const s of suites) {
        const n = opt.grep === undefined ? null : await matching(c, s.env, s.config)
        if (n !== null) c.info.push(`${s.script}: ${n} ${n === 1 ? 'test matches' : 'tests match'}`)
        if (n === 0) continue
        await withServer(c, s.serve, s.env, s.urls, s.ms, () => playwright(c, s.env, s.script))
      }
    } catch (err) {
      // What the workflow uploads when it fails.
      for (const dir of ['playwright-report', 'test-results']) {
        if (existsSync(join(web, dir))) cpSync(join(web, dir), join(LOGS, `e2e-${dir}`), { recursive: true })
      }
      throw err
    }
  },
}

async function withServer(c: Ctx, args: string[], env: Record<string, string>, urls: string[], ms: number, body: () => Promise<void>) {
  const server = launch(c, process.execPath, args, { cwd: join(TREE, 'packages/web'), env }, '&')
  try {
    for (const url of urls) await waitFor(c, `${url} answers`, ms, () => answers(url, undefined, server))
    await body()
  } finally {
    await stop(server)
    c.procs.delete(server)
  }
}

/** `npm run <script> -w @thoth/web` in the Playwright image of the installed @playwright/test (with --grep, only its tests). */
function playwright(c: Ctx, env: Record<string, string>, script: string) {
  const version = (JSON.parse(readFileSync(join(TREE, 'node_modules/@playwright/test/package.json'), 'utf8')) as { version: string }).version
  const image = `mcr.microsoft.com/playwright:v${version}-noble`
  const vars = Object.entries({ HOME: '/tmp', CI: 'true', NPM_CONFIG_UPDATE_NOTIFIER: 'false', [SEED_VARIABLE]: String(SEED), ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  const grep = opt.grep === undefined ? [] : ['--', '--grep', opt.grep]
  return run(c, 'docker', [
    'run', '--rm', '--init', '--name', `thoth-ci-${ID}-${script.replace(/\W/g, '-')}`, '--label', LABEL,
    '--network', 'host', '--user', `${process.getuid!()}:${process.getgid!()}`, ...vars,
    '-v', `${RUN}:${RUN}`, '-w', join(TREE, 'packages/web'), image, 'npm', 'run', script, ...grep,
  ], { label: `npm run ${script} (${basename(image)})` })
}

/**
 * How many tests of a Playwright configuration match --grep. Listed here,
 * not in the image: listing starts no browser (nor, with the base URL in the
 * environment, a server).
 */
async function matching(c: Ctx, env: Record<string, string>, config: string[]): Promise<number> {
  const args = [join(TREE, 'node_modules/@playwright/test/cli.js'), 'test', '--list', '--grep', opt.grep!, ...config]
  note(c, `\n[${time()}] $ node ${args.join(' ')}`)
  const child = spawn(process.execPath, args, { cwd: join(TREE, 'packages/web'), env: { ...c.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  c.procs.add(child)
  let out = ''
  child.stdout!.on('data', (d: Buffer) => { out += d })
  child.stderr!.on('data', (d: Buffer) => { out += d })
  const end = await ending(child, Math.min(c.deadline, Date.now() + 120_000))
  c.procs.delete(child)
  const total = /^Total: (\d+) tests? in/m.exec(out)
  note(c, total ? total[0] : out.trim().split('\n').slice(-10).join('\n'))
  if (end === 'aborted') throw new Failure('cancelled while listing the browser tests')
  if (!total) throw new Failure(`could not list the browser tests (${end})`)
  return Number(total[1])
}

/**
 * With --grep, the environment that makes `node --test` run only the tests
 * whose names match: NODE_OPTIONS, since options after the files would go to
 * the tests instead (npm run appends them there).
 */
function nodeTestFilter(c: Ctx): Record<string, string> {
  if (opt.grep === undefined) return {}
  const pattern = `--test-name-pattern="${opt.grep.replace(/[\\"]/g, '\\$&')}"`
  return { NODE_OPTIONS: [c.env.NODE_OPTIONS, pattern].filter(Boolean).join(' ') }
}

// ---------------------------------------------------------------------------
// Stages and processes

async function stage(name: Stage, ports: Record<string, number>, body: (c: Ctx) => Promise<void>): Promise<Result> {
  const log = join(LOGS, `${name}.log`)
  const fd = openSync(log, 'a')
  const c: Ctx = { stage: name, log, fd, env: environment(name, ports), deadline: Date.now() + LIMIT[name] * 60_000, procs: new Set(), info: [] }
  const t0 = Date.now()
  if (tty && !parallel) process.stdout.write(`  ${name.padEnd(11)}`)
  note(c, `[${time()}] ${name} (at most ${LIMIT[name]} min) in ${TREE}`)
  let status: Status = 'OK'
  let why: string | undefined
  try {
    await body(c)
  } catch (err) {
    status = abort.signal.aborted ? 'CANCELLED' : 'FAILED'
    why = err instanceof Failure ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err)
    note(c, `\n[${time()}] ${status}: ${why}`)
  } finally {
    for (const p of c.procs) await stop(p)
    note(c, `[${time()}] ${name}: ${status} in ${clock(Date.now() - t0)}`)
    closeSync(fd)
  }
  const flaky = name === 'e2e' ? playwrightSummary(log).flaky : []
  if (flaky.length) c.info.push(`${flaky.length} flaky: ${flaky.map(short).join(', ')}`)
  const r: Result = { stage: name, status, ms: Date.now() - t0, why, log, flaky, info: c.info.join('; ') || undefined }
  // On a terminal, one job after another: the line started above ends here (unless Ctrl-C broke it).
  say(tty && !parallel && !signalled ? line(r).slice(13) : line(r))
  return r
}

const skipped = (stage: Job): Result => {
  const r: Result = { stage, status: 'SKIPPED', ms: 0, log: '' }
  say(line(r))
  return r
}
const line = (r: Result) => `  ${r.stage.padEnd(11)}${r.status.padEnd(10)}${r.status === 'SKIPPED' ? '' : clock(r.ms).padStart(7)}${r.why && r.status === 'FAILED' ? `  ${r.why.split('\n')[0]}` : ''}${r.info ? `  (${r.info})` : ''}`

/**
 * The environment of a stage: this one without what could steer the tests
 * (their ports and folders, npm's own variables), Node first in PATH, CI set
 * as on GitHub, its own TMPDIR and the run's ports.
 */
function environment(stage: Stage, ports: Record<string, number>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^(npm_|E2E_|ACC_|ACCEPTANCE_|THOTH_|INIT_CWD$)/.test(k)) env[k] = v
  const tmp = join(RUN, 'tmp', stage)
  mkdirSync(tmp, { recursive: true })
  const own: Record<string, string> = { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`, TMPDIR: tmp, TMP: tmp, TEMP: tmp, CI: 'true', [SEED_VARIABLE]: String(SEED) }
  for (const [k, v] of Object.entries(ports)) own[k] = String(v)
  return { ...env, ...own }
}

function note(c: Ctx, text: string) {
  writeSync(c.fd, text.endsWith('\n') ? text : text + '\n')
}

interface RunOpts { cwd?: string; env?: Record<string, string>; limitMs?: number; label?: string }

/** Runs a command to its end, with its output in the stage's log and within the stage's time. */
async function run(c: Ctx, cmd: string, args: string[], o: RunOpts = {}): Promise<void> {
  const label = o.label ?? [cmd === process.execPath ? 'node' : cmd, ...args.filter((a) => !SAFE.includes(a))].join(' ').slice(0, 80)
  const child = launch(c, cmd, args, o)
  const deadline = Math.min(c.deadline, o.limitMs ? Date.now() + o.limitMs : Infinity)
  const end = await ending(child, deadline)
  c.procs.delete(child)
  if (end === 'aborted') throw new Failure(`cancelled during \`${label}\``)
  if (end === 'timeout') throw new Failure(`timed out (${o.limitMs && Date.now() < c.deadline ? `${Math.round(o.limitMs / 1000)} s` : `${LIMIT[c.stage]} min`}) in \`${label}\``)
  if (end !== 0) {
    const first = firstFailingTest(c.log)
    throw new Failure(`\`${label}\` failed (${end})${first ? `: ${first}` : ''}`)
  }
}

/** The first failing test in the log's last summary: node --test (✖ failing tests) or Playwright (N failed). */
function firstFailingTest(log: string): string | null {
  let lines: string[]
  try { lines = readFileSync(log, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n') } catch { return null }
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!
    if (l.startsWith('✖ failing tests:') || /^\s+\d+ failed$/.test(l)) {
      for (const next of lines.slice(i + 1, i + 6)) {
        const name = /^✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(next)?.[1] ?? /^\s+(\S.* › .+)$/.exec(next)?.[1]
        if (name) return name.trim()
      }
      return null
    }
  }
  return null
}

/** Starts a command in a process group of its own (so it can be stopped whole), its output into the stage's log. */
function launch(c: Ctx, cmd: string, args: string[], o: RunOpts, suffix = ''): ChildProcess {
  note(c, `\n[${time()}] $ ${[cmd === process.execPath ? 'node' : cmd, ...args].join(' ')} ${suffix}`.trimEnd())
  const child = spawn(cmd, args, { cwd: o.cwd ?? TREE, env: { ...c.env, ...o.env }, stdio: ['ignore', c.fd, c.fd], detached: true })
  child.on('error', (err) => note(c, `${cmd}: ${err.message}`))
  c.procs.add(child)
  return child
}

const over = (p: ChildProcess) => p.exitCode !== null || p.signalCode !== null

/** How the process ends: its exit code or signal; or 'timeout' or 'aborted', and then it's stopped. */
async function ending(child: ChildProcess, deadline: number): Promise<number | string> {
  let timer: NodeJS.Timeout | undefined
  const end = await Promise.race([
    new Promise<number | string>((resolve) => {
      if (over(child)) resolve(child.exitCode ?? child.signalCode!)
      child.once('exit', (code, signal) => resolve(code ?? signal ?? 'killed'))
      child.once('error', (err) => resolve(err.message))
    }),
    new Promise<string>((resolve) => { timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now())) }),
    new Promise<string>((resolve) => {
      if (abort.signal.aborted) resolve('aborted')
      abort.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
    }),
  ])
  clearTimeout(timer)
  if (end === 'timeout' || end === 'aborted') await stop(child)
  return end
}

/** Stops a process and its group: SIGTERM, and SIGKILL if it's still there after 5 s. */
async function stop(child: ChildProcess) {
  const group = (sig: NodeJS.Signals) => { try { process.kill(-child.pid!, sig) } catch {} }
  if (child.pid === undefined) return
  group('SIGTERM')
  for (let i = 0; i < 20 && !over(child); i++) await sleep(250)
  group('SIGKILL')
  for (let i = 0; i < 20 && !over(child); i++) await sleep(250)
}

async function waitFor(c: Ctx, what: string, ms: number, test: () => boolean | Promise<boolean>) {
  const end = Math.min(Date.now() + ms, c.deadline)
  for (;;) {
    if (abort.signal.aborted) throw new Failure(`cancelled waiting until ${what}`)
    if (await test()) {
      note(c, `[${time()}] ${what}: yes`)
      return
    }
    if (Date.now() >= end) throw new Failure(`not within ${Math.round(ms / 1000)} s: ${what}`)
    await sleep(500)
  }
}

async function answers(url: string, check?: (body: string) => boolean, server?: ChildProcess): Promise<boolean> {
  if (server && over(server)) throw new Failure(`the server for ${url} exited (${server.exitCode ?? server.signalCode})`)
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    const body = await res.text()
    return res.ok && (check ? check(body) : true)
  } catch {
    return false
  }
}

function capture(cmd: string, args: string[], cwd = REPO): { ok: boolean; out: string; err: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 120_000 })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr || r.error?.message || '').trim() }
}
const git = (args: string[], cwd = REPO) => capture('git', [...SAFE, ...args], cwd)
function must(r: { ok: boolean; out: string; err: string }, what: string): string {
  if (!r.ok) throw new Failure(`${what}: ${r.err || 'failed'}`)
  return r.out
}
const hostname = () => { try { return readFileSync('/etc/hostname', 'utf8').trim() } catch { return 'this machine' } }

// ---------------------------------------------------------------------------
// Ports, the GitHub status

/**
 * Free ports for this run, checked by listening on them. Below the kernel's
 * ephemeral range (32768+), and above the ones the tests pick at random for
 * their own servers (21000–29000).
 */
async function freePorts(n: number): Promise<number[]> {
  const got = new Set<number>()
  for (let tries = 0; got.size < n; tries++) {
    if (tries > 1000) throw new Error('no free ports between 30000 and 32700')
    const port = 30000 + Math.floor(Math.random() * 2700)
    if (!got.has(port) && (await listenable(port))) got.add(port)
  }
  return [...got]
}

function listenable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer()
    s.once('error', () => resolve(false))
    s.listen({ port, host: '0.0.0.0', exclusive: true }, () => s.close(() => resolve(true)))
  })
}

/**
 * The `ci/local` commit status (`ci/local-partial` for a run of some jobs or
 * tests): GitHub shows it on the pull request, and it costs no Actions minutes.
 */
function post(sha: string, state: 'pending' | 'success' | 'failure' | 'error', description: string) {
  const r = capture('gh', ['api', '--method', 'POST', `repos/{owner}/{repo}/statuses/${sha}`,
    '-f', `state=${state}`, '-f', `context=${CONTEXT}`, '-f', `description=${description.replace(/\s+/g, ' ').slice(0, 140)}`])
  if (!r.ok) {
    if (state === 'pending') throw new Failure(`could not post the ${CONTEXT} status: ${r.err}`)
    say(`could not post the ${CONTEXT} status (${state}): ${r.err}`)
    process.exitCode = 1
  }
}

// ---------------------------------------------------------------------------
// Cleanup

/** PIDs of the processes working inside a folder (their cwd), but this one. */
function processesIn(dir: string): number[] {
  const pids: number[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue
    let cwd: string
    try { cwd = readlinkSync(`/proc/${name}/cwd`) } catch { continue }
    if (cwd === dir || cwd.startsWith(dir + '/')) pids.push(Number(name))
  }
  return pids
}

/** Stops every process working inside the folder: SIGTERM, and SIGKILL after 5 s. How many there were. */
async function sweep(dir: string): Promise<number> {
  let pids = processesIn(dir)
  const found = pids.length
  for (const pid of pids) try { process.kill(pid, 'SIGTERM') } catch {}
  for (let i = 0; i < 20 && pids.length; i++) {
    await sleep(250)
    pids = processesIn(dir)
  }
  for (const pid of pids) try { process.kill(pid, 'SIGKILL') } catch {}
  return found
}

/**
 * Everything a run leaves, but its logs: its processes, containers (its own,
 * and the compose projects the docker acceptance started from its folders),
 * their networks, its image, its git ref and worktree. With `keep`, the folder stays.
 */
async function cleanup(id: string, dir: string, keep: boolean): Promise<string[]> {
  const done: string[] = []
  const stopped = await sweep(dir)
  if (stopped) done.push(`${stopped} processes stopped`)

  const containers = new Set(capture('docker', ['ps', '-aq', '--filter', `label=thoth-ci=${id}`]).out.split('\n').filter(Boolean))
  const projects = new Set<string>()
  const compose = capture('docker', ['ps', '-a', '--filter', 'label=com.docker.compose.project', '--format', '{{.ID}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}'])
  for (const row of compose.out.split('\n')) {
    const [cid, project, workingDir] = row.split('\t')
    if (cid && project && workingDir && (workingDir === dir || workingDir.startsWith(dir + '/'))) {
      containers.add(cid)
      projects.add(project)
    }
  }
  if (containers.size) {
    capture('docker', ['rm', '-f', ...containers])
    done.push(`${containers.size} containers removed`)
  }
  for (const project of projects) {
    const networks = capture('docker', ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]).out.split('\n').filter(Boolean)
    if (networks.length) capture('docker', ['network', 'rm', ...networks])
  }
  if (capture('docker', ['image', 'inspect', `thoth-ci:${id}`]).ok) {
    capture('docker', ['image', 'rm', '-f', `thoth-ci:${id}`])
    done.push('image removed')
  }

  const ref = `refs/thoth-ci/${id}`
  if (capture('git', ['show-ref', '--verify', '--quiet', ref]).ok) capture('git', ['update-ref', '-d', ref])
  if (keep) return done

  const tree = join(dir, 'repo')
  if (existsSync(tree)) {
    const removed = capture('git', ['-c', `safe.directory=${tree}`, 'worktree', 'remove', '--force', tree])
    if (!removed.ok) rmSync(tree, { recursive: true, force: true, maxRetries: 3 })
    done.push('worktree removed')
  }
  capture('git', ['worktree', 'prune'])
  for (const sub of ['tmp', 'data', 'run.json']) rmSync(join(dir, sub), { recursive: true, force: true, maxRetries: 3 })
  return done
}

/**
 * Earlier runs: one whose process is gone but whose folder is still there (it
 * was killed outright) is cleaned up; logs older than LOG_DAYS are removed.
 * `all` (--clean) also removes the folders kept with --keep.
 */
async function tidy(all: boolean) {
  if (!existsSync(BASE)) return
  for (const name of readdirSync(BASE)) {
    const dir = join(BASE, name)
    let info: { pid: number; keep: boolean } | null = null
    try { info = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) } catch {}
    let age: number
    try { age = Date.now() - statSync(dir).mtimeMs } catch { continue }
    if (info && running(info.pid)) continue
    if (!info && existsSync(join(dir, 'repo')) && age < 3_600_000) continue // just starting, or written by hand
    if (existsSync(join(dir, 'repo')) || existsSync(join(dir, 'tmp')) || existsSync(join(dir, 'data'))) {
      if (info?.keep && !all) continue
      const done = await cleanup(name, dir, false)
      say(`${info?.keep ? 'kept' : 'left behind'}: ${dir} (${done.join('; ') || 'removed'})`)
    }
    if (all || age > LOG_DAYS * 86_400_000) rmSync(dir, { recursive: true, force: true })
  }
}

function running(pid: number): boolean {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('ci.ts') } catch { return false }
}

// Last, once every declaration above is initialised.
if (opt.clean) await tidy(true)
else process.exitCode = await main()
