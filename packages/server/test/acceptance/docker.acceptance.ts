// The M1 definition of done says `docker compose up`: the same checks against
// the image, with the example compose file and its two volumes. Startup over
// the generated vault, the admin created with the CLI inside the container,
// search, and kill -9 rounds of the server process with the container's
// restart policy bringing it back.
//
// Needs Docker with Compose. ACCEPTANCE_IMAGE: an image already built (CI
// builds it in its own job); otherwise it's built here from the repository.
// ACCEPTANCE_DOCKER=0 skips it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { api, closeAll, login, type Srv } from '../_collab.ts'
import { NOTES, PASSWORD, USER, cleanup, freePort, metric, percentile, sleep, timed, waitFor, workspace } from './_harness.ts'
import { AGENT_MARK, killRound } from './_crash.ts'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const ROUNDS = Number(process.env.ACCEPTANCE_DOCKER_ROUNDS ?? 2)
const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' })
const skip = process.env.ACCEPTANCE_DOCKER === '0' ? 'ACCEPTANCE_DOCKER=0'
  : docker.status !== 0 ? 'Docker Compose is not available' : false

test(`docker compose up over ${NOTES} notes: startup, search and kill -9`, { skip, timeout: 1_200_000 }, async () => {
  const image = process.env.ACCEPTANCE_IMAGE ?? 'thoth:acceptance'
  if (!process.env.ACCEPTANCE_IMAGE) {
    const [, ms] = await timed(async () => execFileSync('docker', ['build', '-q', '-t', image, REPO], { stdio: ['ignore', 'ignore', 'inherit'] }))
    metric('docker build', ms, 'ms')
  }
  const ws = workspace('docker', { user: false })
  // Both folders exist before `up`: a missing one would be created by Docker, owned by root.
  mkdirSync(ws.stateDir, { recursive: true })
  const port = freePort()
  const project = `thoth-acc-${port}`
  // The example compose file as it is, plus the image to use and the user that owns the folders.
  writeFileSync(join(ws.root, 'compose.override.yaml'), `services:\n  thoth:\n    image: ${image}\n    user: "${process.getuid!()}:${process.getgid!()}"\n`)
  const compose = (args: string[], input?: string) => {
    const r = spawnSync('docker', ['compose', '-p', project, '--project-directory', ws.root, '-f', join(REPO, 'compose.yaml'), '-f', join(ws.root, 'compose.override.yaml'), ...args],
      { encoding: 'utf8', input, env: { ...process.env, THOTH_HOST_PORT: String(port) } })
    if (r.status !== 0) throw new Error(`docker compose ${args.join(' ')}: ${r.stderr}`)
    return r.stdout
  }
  const base = `http://127.0.0.1:${port}`
  const srv = { base } as Srv
  const healthy = async () => { try { return (await fetch(base + '/api/health')).ok } catch { return false } }
  try {
    const t0 = performance.now()
    compose(['up', '-d', '--no-build'])
    await waitFor(healthy, 'the container answers', 120_000)
    metric('docker compose up → answering', performance.now() - t0, 'ms', { image })
    compose(['exec', '-T', 'thoth', 'thoth', 'user', 'create', USER, '--admin'], PASSWORD)
    const cookie = await login(srv)

    const tree = (await api(srv, cookie, 'GET', '/api/tree')).body.notes as unknown[]
    assert.ok(tree.length >= NOTES, `${tree.length} notes indexed`)
    const lat: number[] = []
    for (const m of ws.vault.markers) {
      const [r, ms] = await timed(() => api(srv, cookie, 'GET', `/api/search?q=${encodeURIComponent(m.word)}`))
      assert.equal(r.body.results[0]?.path, m.path, m.word)
      lat.push(ms)
    }
    metric('docker search latency p50', percentile(lat, 50), 'ms', { p95: Math.round(percentile(lat, 95) * 10) / 10 })

    const [hot, cold] = ws.vault.editable as [string, string]
    assert.equal((await api(srv, cookie, 'POST', '/api/note/edit', { path: hot, ops: [{ op: 'append', text: `${AGENT_MARK}\n` }] })).status, 200)
    const container = compose(['ps', '-q', 'thoth']).trim()
    const failures: string[] = []
    for (let round = 0; round < ROUNDS; round++) {
      let restarts = 0
      const r = await killRound({
        round, srv, cookie, notesDir: ws.notesDir, hot, cold,
        async kill() {
          // The server process, not `docker kill`: a crash, which the restart policy handles.
          const inspect = () => JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0].State as { Pid: number }
          restarts = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0].RestartCount
          process.kill(inspect().Pid, 'SIGKILL')
          await waitFor(async () => !(await healthy()), 'the server is down', 10_000)
        },
        async restart() {
          await waitFor(async () => JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0].RestartCount > restarts && (await healthy()), 'restarted by its policy', 60_000)
          return srv
        },
      })
      failures.push(...r.failures)
      metric(`docker kill -9 round ${round}`, r.recoveryMs, 'ms', { typed: r.typed, acked: r.acked, agentHot: r.agentHot, agentCold: r.agentCold })
    }
    assert.deepEqual(failures, [])
  } finally {
    closeAll()
    try { compose(['logs', '--no-color', '--tail', '40']).split('\n').forEach((l) => l && console.log(`[container] ${l}`)) } catch {}
    try { compose(['down', '--timeout', '5']) } catch (err) { console.error(err) }
    await sleep(200)
    cleanup(ws)
  }
})
