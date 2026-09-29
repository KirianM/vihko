// The upgrade smoke test: an installation of the previous stable release,
// with some of everything in it, upgraded to a new image, the way a person
// upgrades (the same folders, `docker compose up` with the new tag).
//
//   npm run upgrade-smoke -- --new vihko:local                  # from the previous stable release
//   npm run upgrade-smoke -- --new vihko:local --old ghcr.io/kirianm/vihko:1.0.0-rc.4
//
// 1. Starts the old image with the repository's compose.yaml as it is (its
//    hardening: its own user, a read-only filesystem, no capabilities) and
//    two fresh folders for the volumes.
// 2. Creates an admin and a member (the CLI, as the guide does), turns the
//    API on and creates a key, and writes, through the API, a note with
//    frontmatter (a comment and a key vihko doesn't know included), a link
//    to another note, an image and a comment thread, until the history has
//    a version of it.
// 3. Stops it, and starts the new image on the same folders.
// 4. Checks that it starts; that if state.db migrated, its copy is in the
//    state volume and the admin has the alert, and if it didn't, no copy was
//    made; that both people sign in; that the note, its link and backlink,
//    the image and the comment are as they were; that the key still works;
//    and that the history still has the note's versions.
//
// The old image is ghcr.io/kirianm/vihko:<the newest stable tag v* older than
// the version being released> (`--version`, the root package.json's by
// default; scripts/release.ts, previousStable). With no such tag it's
// skipped, saying so. The release workflow runs it on the image it built,
// before anything is pushed (.github/workflows/release.yml, job `smoke`).
//
// Only Node's own modules: the workflow runs it without `npm ci`. Needs
// Docker with Compose. The folders go in a temporary folder (`--dir` to
// choose it, on local disk), removed at the end with the container unless
// `--keep`; compose.yaml publishes vihko on a free port of the host (`--port`).
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { previousStable } from './release.ts'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const REGISTRY = 'ghcr.io/kirianm/vihko'
const USAGE = 'usage: npm run upgrade-smoke -- --new <image> [--old <image>] [--version <x.y.z>] [--port <n>] [--dir <folder>] [--keep]'

/** A 1×1 PNG. A literal: any valid image will do, and the bytes are compared after the upgrade. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const PLAN = 'upgrade-smoke/Plan.md'
const TARGET = 'upgrade-smoke/Target.md'
/** A note written by hand: frontmatter with a comment, a key vihko doesn't know, a link. */
const PLAN_TEXT = `---
title: Upgrade plan
tags: [smoke, upgrade]
owner: nobody in particular   # a key vihko doesn't know, with a comment
---
# Upgrade plan

The plan links to [[Target]] and keeps an image.
`
const TARGET_TEXT = '# Target\n\nWhat the plan links to.\n'

class SmokeError extends Error {}
const check = (ok: unknown, what: string): void => {
  if (!ok) throw new SmokeError(what)
}
const step = (msg: string) => console.log(`[upgrade-smoke] ${msg}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function docker(args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', input: opts.input, env: opts.env ?? process.env, maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new SmokeError(`docker ${args[0]}: ${r.error.message}`)
  return r
}

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer().once('error', fail).listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })
}

/** The images: `--old`, or the previous stable release (null: there is none). */
function images(opts: { new?: string; old?: string; version?: string }): { from: string | null; to: string; why: string } {
  if (!opts.new) throw new SmokeError(USAGE)
  if (opts.old) return { from: opts.old, to: opts.new, why: '--old' }
  const version = opts.version ?? (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }).version
  const git = spawnSync('git', ['tag', '--list', 'v*'], { cwd: REPO, encoding: 'utf8' })
  if (git.status !== 0) throw new SmokeError(`git tag --list failed: ${git.stderr || git.error?.message}`)
  const prev = previousStable(version, git.stdout.split('\n').filter(Boolean))
  return { from: prev && `${REGISTRY}:${prev}`, to: opts.new, why: prev ? `the stable release before ${version}` : `no stable release before ${version} among the tags` }
}

interface Reply { status: number; body: any; bytes: Buffer }

class Vihko {
  base: string
  constructor(port: number) {
    this.base = `http://127.0.0.1:${port}`
  }

  async call(method: string, path: string, opts: { cookie?: string; token?: string; json?: unknown; data?: Buffer; type?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = {}
    if (opts.cookie) headers.cookie = opts.cookie
    if (opts.token) headers.authorization = `Bearer ${opts.token}`
    let body: string | Uint8Array<ArrayBuffer> | undefined
    if (opts.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.json) }
    if (opts.data) { headers['content-type'] = opts.type ?? 'application/octet-stream'; body = new Uint8Array(opts.data) }
    const res = await fetch(this.base + path, { method, headers, body })
    const bytes = Buffer.from(await res.arrayBuffer())
    let parsed: unknown = null
    if ((res.headers.get('content-type') ?? '').includes('json')) {
      try { parsed = JSON.parse(bytes.toString('utf8')) } catch {}
    }
    return { status: res.status, body: parsed, bytes }
  }

  async expect(status: number, method: string, path: string, opts: Parameters<Vihko['call']>[2] = {}): Promise<any> {
    const r = await this.call(method, path, opts)
    check(r.status === status, `${method} ${path}: ${r.status} (expected ${status}) ${r.bytes.toString('utf8').slice(0, 300)}`)
    return r.body
  }

  async login(username: string, password: string): Promise<string> {
    const res = await fetch(this.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })
    check(res.status === 200, `${username} signs in: ${res.status} ${await res.text()}`)
    return res.headers.get('set-cookie')!.split(';')[0]!
  }

  async healthy(ms: number, logs: () => string) {
    const until = Date.now() + ms
    while (Date.now() < until) {
      try {
        if ((await fetch(this.base + '/api/health')).ok) return
      } catch {}
      await sleep(500)
    }
    throw new SmokeError(`vihko didn't answer within ${ms / 1000} s. Its log:\n${logs()}`)
  }
}

/** What the old version left, to compare the new one's view with. */
interface Snapshot {
  plan: string
  image: { path: string; bytes: Buffer }
  threads: string
  versions: number
}

async function snapshot(v: Vihko, cookie: string, image: string): Promise<Snapshot> {
  const plan = (await v.expect(200, 'GET', `/api/note?path=${encodeURIComponent(PLAN)}`, { cookie })).text as string
  const file = await v.call('GET', `/api/file?path=${encodeURIComponent(image)}`, { cookie })
  check(file.status === 200, `GET /api/file ${image}: ${file.status}`)
  const threads = JSON.stringify((await v.expect(200, 'GET', `/api/note/comments?path=${encodeURIComponent(PLAN)}`, { cookie })).threads)
  const versions = ((await v.expect(200, 'GET', `/api/history/versions?path=${encodeURIComponent(PLAN)}`, { cookie })).versions as unknown[]).length
  return { plan, image: { path: image, bytes: file.bytes }, threads, versions }
}

/** The link from the plan to its target, both ways. */
async function checkLinks(v: Vihko, cookie: string) {
  const plan = await v.expect(200, 'GET', `/api/note/links?path=${encodeURIComponent(PLAN)}`, { cookie })
  // `dstPath` from 1.1 on; `dst_path` (deprecated) in 1.0.
  const out = (plan.outgoing as { status: string; dstPath?: string | null; dst_path?: string | null }[]).find((l) => (l.dstPath ?? l.dst_path) === TARGET)
  check(out?.status === 'resolved', `the plan's link to ${TARGET} resolves: ${JSON.stringify(plan.outgoing)}`)
  const target = await v.expect(200, 'GET', `/api/note/links?path=${encodeURIComponent(TARGET)}`, { cookie })
  check((target.backlinks as { path: string }[]).some((b) => b.path === PLAN), `${TARGET} has the plan as a backlink: ${JSON.stringify(target.backlinks)}`)
}

async function main() {
  const { values: opts } = parseArgs({
    options: {
      new: { type: 'string' }, old: { type: 'string' }, version: { type: 'string' },
      port: { type: 'string' }, dir: { type: 'string' }, keep: { type: 'boolean' }, help: { type: 'boolean' },
    },
  })
  if (opts.help) { console.log(USAGE); return }
  const { from, to, why } = images(opts)
  if (!from) {
    step(`skipped: ${why}, so there is nothing to upgrade from`)
    return
  }
  step(`${from} (${why}) → ${to}`)
  check(docker(['compose', 'version']).status === 0, 'Docker Compose is not available')
  check(docker(['image', 'inspect', to]).status === 0, `the new image ${to} isn't here: build it first (docker build -t ${to} .)`)
  const pulled = docker(['pull', '--quiet', from])
  check(pulled.status === 0, `docker pull ${from}: ${pulled.stderr}`)

  const port = opts.port ? Number(opts.port) : await freePort()
  const dir = opts.dir ? resolve(opts.dir) : mkdtempSync(join(tmpdir(), 'vihko-smoke-'))
  if (opts.dir) mkdirSync(dir, { recursive: true })
  const notesDir = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  // Both exist before `up`: a missing one would be created by Docker, owned by root.
  mkdirSync(notesDir)
  mkdirSync(stateDir)
  // The user that owns the folders, the way the installation guide sets it: its .env.
  writeFileSync(join(dir, '.env'), `VIHKO_UID=${process.getuid!()}\nVIHKO_GID=${process.getgid!()}\n`)
  const project = `vihko-smoke-${port}`
  const override = join(dir, 'compose.smoke.yaml')
  // compose.yaml as it is, and the image; versions close after 1 s of calm, so the history has one soon.
  const use = (image: string) => writeFileSync(override, `services:\n  vihko:\n    image: ${JSON.stringify(image)}\n    environment:\n      VIHKO_HISTORY_QUIET_SECONDS: "1"\n`)
  const compose = (args: string[], input?: string) => {
    const r = docker(['compose', '-p', project, '--project-directory', dir, '-f', join(REPO, 'compose.yaml'), '-f', override, ...args],
      { input, env: { ...process.env, VIHKO_HOST_PORT: String(port) } })
    check(r.status === 0, `docker compose ${args.join(' ')}: ${r.stderr}`)
    return r.stdout
  }
  const logs = () => { try { return compose(['logs', '--no-color', '--no-log-prefix', 'vihko']) } catch (err) { return String(err) } }
  const v = new Vihko(port)
  const admin = { username: 'admin', password: randomBytes(18).toString('base64url') }
  const member = { username: 'member', password: randomBytes(18).toString('base64url') }
  let ok = false
  try {
    // 1. The old version, as installed.
    use(from)
    compose(['up', '-d', '--no-build'])
    await v.healthy(120_000, logs)
    const oldVersion = compose(['exec', '-T', 'vihko', 'vihko', 'version']).trim()
    step(`old version ${oldVersion} answers on ${v.base}`)

    // 2. Some of everything.
    compose(['exec', '-T', 'vihko', 'vihko', 'user', 'create', admin.username, '--admin'], admin.password)
    compose(['exec', '-T', 'vihko', 'vihko', 'user', 'create', member.username], member.password)
    let cookie = await v.login(admin.username, admin.password)
    await v.login(member.username, member.password)
    await v.expect(200, 'PUT', '/api/admin/integrations', { cookie, json: { api: true } })
    const { token } = await v.expect(201, 'POST', '/api/keys', { cookie, json: { name: 'upgrade smoke', canWrite: true, folders: [], confirm: admin.password } }) as { token: string }
    await v.expect(201, 'POST', '/api/note', { cookie, json: { path: TARGET, text: TARGET_TEXT } })
    await v.expect(201, 'POST', '/api/note', { cookie, json: { path: PLAN, text: PLAN_TEXT } })
    const up = await v.expect(201, 'POST', `/api/attachments?note=${encodeURIComponent(PLAN)}`, { cookie, data: PNG, type: 'image/png' }) as { path: string; src: string; markdown?: string }
    await v.expect(200, 'POST', '/api/note/edit', { cookie, json: { path: PLAN, ops: [{ op: 'append', text: `\n${up.markdown ?? `![](${up.src})`}\n` }] } })
    const context = 'The plan links'
    await v.expect(200, 'POST', '/api/note/comment', { cookie, json: { path: PLAN, op: 'add', context, at: PLAN_TEXT.indexOf(context) + context.length, text: 'Checked before the upgrade.' } })
    const byKey = await v.expect(200, 'GET', `/api/note?path=${encodeURIComponent(PLAN)}`, { token })
    await checkLinks(v, cookie)
    let before = await snapshot(v, cookie, up.path)
    for (const until = Date.now() + 60_000; before.versions === 0 && Date.now() < until; before = await snapshot(v, cookie, up.path)) await sleep(500)
    check(before.versions > 0, 'the history has a version of the note before the upgrade')
    check(byKey.text === before.plan, 'the key reads the note')
    // vihko adds a `uid` to the frontmatter (the comment needs one); the rest of it stays line by line.
    const frontmatter = PLAN_TEXT.split('\n---\n')[0]!.split('\n').slice(1)
    check(frontmatter.every((l) => before.plan.includes(`\n${l}\n`)) && before.plan.includes('<!--'), `the note has its frontmatter and its comment: ${before.plan}`)
    check(JSON.parse(before.threads).length === 1, `one comment thread: ${before.threads}`)
    const planOnDisk = readFileSync(join(notesDir, PLAN))
    const backupsBefore = readdirSync(stateDir).filter((n) => n.startsWith('state.db.bak-'))
    step(`written: 2 users, a key, 2 notes, an image, a comment; ${before.versions} version(s) in the history`)

    // 3. The upgrade, as a person does it: stop, new image, same folders.
    compose(['stop', '--timeout', '30'])
    use(to)
    // A new image: Compose replaces the container, so the log is the new one's alone.
    compose(['up', '-d', '--no-build'])
    await v.healthy(180_000, logs)
    const newVersion = compose(['exec', '-T', 'vihko', 'vihko', 'version']).trim()
    step(`new version ${newVersion} answers`)
    const newLog = logs()

    // 4. What must have survived.
    cookie = await v.login(admin.username, admin.password)
    check((await v.expect(200, 'GET', '/api/auth/me', { cookie })).user?.role === 'admin', 'the admin is still an admin')
    await v.login(member.username, member.password)
    const migrated = /state\.db migrated from version (\d+) to (\d+); the previous one is in \S*?(state\.db\.bak-v\d+)/.exec(newLog)
    const backups = readdirSync(stateDir).filter((n) => n.startsWith('state.db.bak-'))
    if (migrated) {
      const [, fromV, toV, backup] = migrated
      check(existsSync(join(stateDir, backup!)), `the copy ${backup} is in the state volume`)
      const alerts = (await v.expect(200, 'GET', '/api/alerts', { cookie })).alerts as { code: string; from?: number; to?: number; backup?: string }[]
      check(alerts.some((a) => a.code === 'state_migrated' && a.from === Number(fromV) && a.to === Number(toV) && a.backup === backup), `the admin has the state_migrated alert: ${JSON.stringify(alerts)}`)
      step(`state.db migrated from version ${fromV} to ${toV}; ${backup} in the state volume and the admin's alert`)
    } else {
      check(backups.length === backupsBefore.length, `state.db didn't migrate, and no copy was made: ${backups.join(', ')}`)
      step('state.db needed no migration')
    }
    const after = await snapshot(v, cookie, before.image.path)
    check(after.plan === before.plan, `the note is as it was:\n${before.plan}\n---\n${after.plan}`)
    check(readFileSync(join(notesDir, PLAN)).equals(planOnDisk), 'the note\'s file is byte for byte the same')
    check(after.image.bytes.equals(before.image.bytes), 'the image is the same')
    check(after.threads === before.threads, `the comment thread is the same: ${before.threads} → ${after.threads}`)
    check(after.versions >= before.versions, `the history keeps the note's versions: ${before.versions} → ${after.versions}`)
    await checkLinks(v, cookie)
    check((await v.expect(200, 'GET', '/api/integrations', { cookie })).api === true, 'the API is still on')
    const again = await v.expect(200, 'GET', `/api/note?path=${encodeURIComponent(PLAN)}`, { token })
    check(again.text === before.plan, 'the key still reads the note')
    ok = true
    step(`passed: ${oldVersion} → ${newVersion}`)
  } catch (err) {
    console.error(`[upgrade-smoke] FAILED: ${err instanceof SmokeError ? err.message : (err as Error).stack}\n\nThe container's log:\n${logs()}`)
    throw err
  } finally {
    if (!opts.keep) {
      try { compose(['down', '--timeout', '10']) } catch (err) { console.error(String(err)) }
      // The container wrote as this user: everything in the folder is removable.
      if (!opts.dir) rmSync(dir, { recursive: true, force: true })
      else for (const f of ['notes', 'state', '.env', 'compose.smoke.yaml']) rmSync(join(dir, f), { recursive: true, force: true })
    } else {
      step(`kept: project ${project} (docker compose -p ${project} down), folder ${dir}`)
    }
    if (!ok) process.exitCode = 1
  }
}

main().catch((err) => {
  // On GitHub Actions, as an error annotation on the run's summary.
  console.error(`${process.env.GITHUB_ACTIONS ? '::error::' : ''}${err instanceof SmokeError ? err.message : (err as Error).stack}`)
  process.exit(1)
})
