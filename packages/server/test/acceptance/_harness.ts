// Shared pieces of the M1 acceptance suite (`npm run acceptance`): a generated
// vault on local disk, the real server as a separate process (started with the
// CLI, as in production), timings, memory and a report of the numbers.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { cpus, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { CLI, sleep, waitFor, type Srv } from '../_collab.ts'
import { generateVault, type Vault } from './_vault.ts'
import { mother } from '../../../../test/mother.ts'

export { sleep, waitFor }

export const NOTES = Number(process.env.ACCEPTANCE_NOTES ?? 1000)
export const SEED = Number(process.env.ACCEPTANCE_SEED ?? 1)
/** Repetitions of the concurrency scenarios: one green pass proves nothing. */
export const ROUNDS = Number(process.env.ACCEPTANCE_ROUNDS ?? 5)
/** The admin every workspace is made with (the mother's): their username and password. */
const ADMIN = mother(import.meta.url).aUser({ role: 'admin' })
export const USER = ADMIN.username
export const PASSWORD = ADMIN.password

let nextPort = 26000 + Math.floor(Math.random() * 3000)
export const freePort = () => nextPort++

export interface Workspace { root: string; notesDir: string; stateDir: string; vault: Vault; env: Record<string, string> }

/**
 * A generated vault and an empty state with one admin. On local disk: the
 * system temp folder, or ACCEPTANCE_DIR (e.g. an NFS mount, to measure it).
 * ACCEPTANCE_STATE_DIR puts the state elsewhere (it must be local disk).
 */
export function workspace(name: string, opts: { user?: boolean } = {}): Workspace {
  const base = process.env.ACCEPTANCE_DIR ?? tmpdir()
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, `thoth-acc-${name}-`))
  const notesDir = join(root, 'notes')
  const stateDir = process.env.ACCEPTANCE_STATE_DIR ? mkdtempSync(join(process.env.ACCEPTANCE_STATE_DIR, `thoth-acc-${name}-`)) : join(root, 'state')
  const vault = generateVault(notesDir, { notes: NOTES, seed: SEED })
  const env = { THOTH_NOTES_DIR: notesDir, THOTH_STATE_DIR: stateDir, THOTH_HOST: '127.0.0.1', THOTH_PORT: String(freePort()) }
  if (opts.user !== false) {
    const r = spawnSync(process.execPath, ['--no-experimental-webstorage', CLI, 'user', 'create', USER, '--admin'], { env: { ...process.env, ...env }, input: PASSWORD })
    if (r.status !== 0) throw new Error(`user create: ${r.stderr}`)
  }
  return { root, notesDir, stateDir, vault, env }
}

export function cleanup(ws: Workspace) {
  if (process.env.ACCEPTANCE_KEEP) return
  rmSync(ws.root, { recursive: true, force: true })
  if (!ws.stateDir.startsWith(ws.root)) rmSync(ws.stateDir, { recursive: true, force: true })
}

export interface Server extends Srv {
  pid: number
  /** Milliseconds from spawn to "index ready" and to "listening". */
  indexedMs: number
  listeningMs: number
}

/** Starts `thoth serve` as production does; resolves when it's listening. */
export async function startServer(env: Record<string, string>, timeout = 120_000): Promise<Server> {
  const t0 = performance.now()
  const proc = spawn(process.execPath, ['--no-experimental-webstorage', CLI, 'serve'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const out: string[] = []
  let indexedMs = -1
  let listeningMs = -1
  const onData = (d: Buffer) => {
    const s = d.toString()
    out.push(s)
    if (indexedMs < 0 && s.includes('index ready')) indexedMs = performance.now() - t0
    if (listeningMs < 0 && s.includes('listening on')) listeningMs = performance.now() - t0
  }
  proc.stdout!.on('data', onData)
  proc.stderr!.on('data', onData)
  await waitFor(() => listeningMs >= 0 || proc.exitCode !== null, 'server startup', timeout)
  if (proc.exitCode !== null) throw new Error(`the server exited (${proc.exitCode}):\n${out.join('')}`)
  return {
    proc, out, env, pid: proc.pid!, indexedMs, listeningMs,
    base: `http://127.0.0.1:${env.THOTH_PORT}`,
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      if (proc.exitCode !== null || proc.signalCode !== null) return
      const done = new Promise((r) => proc.once('exit', r))
      proc.kill(signal)
      await done
    },
  }
}

/** Resident memory of a process, in MiB: now (VmRSS) and peak (VmHWM). Linux only. */
export function memory(pid: number): { rss: number; peak: number } {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(status)?.[1] ?? NaN)
  return { rss: kb('VmRSS') / 1024, peak: kb('VmHWM') / 1024 }
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return NaN
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!
}

export async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now()
  const r = await fn()
  return [r, performance.now() - t]
}

/**
 * Records a number: printed, and appended as a JSON line to ACCEPTANCE_REPORT
 * if set, so a run leaves its figures behind (with the machine they were taken on).
 */
export function metric(name: string, value: number, unit: string, extra: Record<string, unknown> = {}) {
  const v = Math.round(value * 10) / 10
  console.log(`[acceptance] ${name}: ${v} ${unit}${Object.keys(extra).length ? ' ' + JSON.stringify(extra) : ''}`)
  const file = process.env.ACCEPTANCE_REPORT
  if (file) appendFileSync(file, JSON.stringify({ name, value: v, unit, ...extra, notes: NOTES, cpu: cpus()[0]?.model, cpus: cpus().length, memGiB: Math.round(totalmem() / 2 ** 30), dir: process.env.ACCEPTANCE_DIR ?? tmpdir() }) + '\n')
}
