// The history's retention on a long history (RETENTION_COMMITS commits over
// two years, 20,000 by default): how long a first run and the next night's
// take, and how long the server's event loop is held at most meanwhile (it
// must keep answering requests). Every file keeps its content at the head.
// The numbers are printed; the bounds are loose, for a loaded machine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { Git, retainRunning, retentionPreview } from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const DAY = 86_400_000
const COMMITS = Number(process.env.RETENTION_COMMITS ?? 20_000)
const FILES = Math.max(10, Math.round(COMMITS / 30))

/** A recorder that is never writing: the run's pause is the server's business (history-purge-ui tests it). */
const idle = { async purging<T>(fn: () => Promise<{ result: T }>) { return { result: (await fn()).result, stillOnDisk: [], counts: { pending: 0, queued: 0 } } } }

async function generate(stateDir: string) {
  const gitDir = join(stateDir, 'history.git')
  mkdirSync(stateDir, { recursive: true })
  const git = new Git({ gitDir })
  await git.run(['init', '--bare', '-q', '--initial-branch=main', gitDir], { bare: true })
  const space = m.aSpaceFolder()
  const folders = Array.from({ length: 20 }, () => m.aFolder())
  const paths = Array.from({ length: FILES }, (_, i) => `spaces/${space}/${folders[i % folders.length]}/${m.aUniqueWord()}-${i}.md`)
  const texts = paths.map(() => `# ${m.aHeading()}\n`)
  const sentences = Array.from({ length: 200 }, () => m.aSentence())
  const people = Array.from({ length: 5 }, () => m.faker.string.ulid())
  const live = new Set<number>()
  const start = Math.floor(Date.now() / 1000) - 730 * 86400
  await git.run(['fast-import', '--quiet', '--done'], {
    timeoutMs: 600_000,
    input: async (stdin) => {
      const write = (s: string | Buffer) => new Promise<void>((r) => { if (stdin.write(s)) r(); else stdin.once('drain', () => r()) })
      for (let i = 0; i < COMMITS; i++) {
        const t = start + Math.floor((i / COMMITS) * 730 * 86400)
        const f = m.faker.number.int({ min: 0, max: FILES - 1 })
        let ops: string
        if (live.has(f) && m.faker.number.float() < 0.01) {
          live.delete(f)
          ops = `D "${paths[f]}"\n`
        } else {
          live.add(f)
          texts[f] = texts[f]!.length > 6000 ? `# ${m.aHeading()}\n` : texts[f] + sentences[i % sentences.length] + '\n'
          ops = `M 100644 inline "${paths[f]}"\ndata ${Buffer.byteLength(texts[f]!)}\n${texts[f]}\n`
        }
        const msg = Buffer.from(`Edit\n\nVihko-Actor: user ${people[i % people.length]}\n`)
        await write(`commit refs/heads/main\nauthor someone <x@users.vihko.invalid> ${t} +0000\ncommitter vihko <vihko@vihko.invalid> ${t} +0000\ndata ${msg.byteLength}\n`)
        await write(msg)
        await write(`\n${ops}\n`)
      }
      await write('done\n')
    },
  })
  await git.run(['gc', '--quiet'], { timeoutMs: 600_000 })
  return git
}

const headTree = async (git: Git) => (await git.run(['ls-tree', '-r', 'refs/heads/main'])).stdout.toString('utf8')
const size = async (git: Git) => /size-pack: (\d+)/.exec((await git.run(['count-objects', '-v'])).stdout.toString())![1]

test(`retention on a history of ${COMMITS} commits: a first run and the next night's, without holding the server up`, async (t) => {
  const stateDir = join(tempDir('vihko-retention-timing-'), 'state')
  const git = await generate(stateDir)
  const tree = await headTree(git)
  const before = await size(git)
  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()
  const cutoff = Date.now() - 365 * DAY
  const req = { cutoff, keep: [], drop: [] }

  let at = performance.now()
  const preview = await retentionPreview({ stateDir }, req)
  const previewMs = performance.now() - at
  at = performance.now()
  const first = await retainRunning({ stateDir }, req, idle)
  const firstMs = performance.now() - at
  const firstStall = loop.max / 1e6
  assert.equal(first.versions, preview.versions, 'the preview counts what the run removes')
  assert.ok(first.versions > 0)
  assert.equal(await headTree(git), tree, 'every file keeps its content at the head')

  loop.reset()
  at = performance.now()
  const next = await retainRunning({ stateDir }, { ...req, cutoff: cutoff + DAY }, idle)
  const nextMs = performance.now() - at
  const nextStall = loop.max / 1e6
  loop.disable()
  assert.equal(await headTree(git), tree)

  t.diagnostic(`${COMMITS} commits, ${FILES} files; pack ${before} KiB → ${await size(git)} KiB`)
  t.diagnostic(`preview ${Math.round(previewMs)} ms; first run ${Math.round(firstMs)} ms (${first.versions} versions, ${first.rewritten} commits rewritten), longest stall ${Math.round(firstStall)} ms`)
  t.diagnostic(`next night ${Math.round(nextMs)} ms (${next.versions} versions, ${next.rewritten} commits rewritten), longest stall ${Math.round(nextStall)} ms`)
  // About ten times what a quiet machine takes, for a loaded one.
  assert.ok(firstMs < COMMITS * 2, `first run: ${firstMs} ms`)
  assert.ok(Math.max(firstStall, nextStall) < 2000, `the event loop was held ${Math.max(firstStall, nextStall)} ms`)
})
