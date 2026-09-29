// The product screenshots of the README and the releases
// (.github/assets/screenshots/), made from the demo workspace in
// scripts/screenshots/vault: a fresh vihko on a copy of it, two people (an
// admin, who is shown, and a member, who has the note open too), a comment
// thread written into the copy of the note as vihko stores one (dated a
// little before the run), and the browser in the Playwright image of the installed
// @playwright/test, driven from here (`playwright run-server`). The split and
// side-by-side images are composed in that same browser: no image tools.
//
//   npm run screenshots     (builds the UI first; needs Docker)
//
// SCREENSHOTS_PORT (4630) is vihko's port; the browser server takes the next
// one. Everything runs from a temporary folder, removed at the end.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { baseHue } from '@vihko/core'
import { Auth } from '../packages/server/src/auth.ts'
import { openState } from '../packages/server/src/state.ts'
import { prepareStateDir } from '../packages/server/src/volumes.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const VAULT = join(ROOT, 'scripts/screenshots/vault')
const OUT = join(ROOT, '.github/assets/screenshots')
const CLI = join(ROOT, 'packages/server/src/cli.ts')
const PORT = Number(process.env.SCREENSHOTS_PORT ?? 4630)
const BROWSER_PORT = PORT + 1
const BASE = `http://127.0.0.1:${PORT}`
const PLAYWRIGHT = (JSON.parse(readFileSync(join(ROOT, 'node_modules/@playwright/test/package.json'), 'utf8')) as { version: string }).version
const IMAGE = `mcr.microsoft.com/playwright:v${PLAYWRIGHT}-noble`
const CONTAINER = `vihko-screenshots-${process.pid}`

/** The note shown, and the passage the member commented on (the thread is added to the copy, dated a little before now). */
const NOTE = 'handbook/Welcome.md'
const COMMENTED = 'If vihko ever went away, we would still have every word.'
/** Where the member's cursor rests, at the end of this line: the admin sees it, with the member's name. */
const CARET = 'Turn on the API and MCP'
/** The people: fixed demo content, not test data. Their passwords are only for this run. */
const ADMIN = { username: 'hanna', password: randomBytes(12).toString('hex') }
const MEMBER = { username: 'ravi', password: randomBytes(12).toString('hex') }
const THREAD = [
  { who: MEMBER.username, minutesAgo: 132, text: 'Worth saying that comments live in the note too, like this thread.' },
  { who: ADMIN.username, minutesAgo: 87, text: '↳ Good call. I added it to How we write notes.' },
]

const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }

/** The edge of a composed picture: a hairline over its border, inside its rounded corners. */
const FRAME = 'position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 2px rgba(128,128,128,0.35)'

const children: ChildProcess[] = []
let work = ''

/** Stops the server (its whole process group) and the browser's container, then removes the temporary folder. */
async function cleanUp() {
  const running = children.filter((c) => c.exitCode === null && c.signalCode === null)
  const exited = Promise.all(running.map((c) => new Promise((r) => c.once('exit', r))))
  for (const c of running) if (c.pid !== undefined) try { process.kill(-c.pid, 'SIGTERM') } catch { /* not a group leader: the container, below */ }
  try { execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }) } catch { /* not running */ }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))])
  for (const c of running) if (c.exitCode === null && c.signalCode === null && c.pid !== undefined) try { process.kill(-c.pid, 'SIGKILL') } catch { /* gone */ }
  if (work) rmSync(work, { recursive: true, force: true })
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void cleanUp().finally(() => process.exit(130)) })

const stamp = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString().slice(0, 16) + 'Z'

/** The demo vault in a temporary folder, with the comment thread on the passage, and the two people. */
async function prepare(): Promise<Record<string, string>> {
  work = mkdtempSync(join(tmpdir(), 'vihko-screenshots-'))
  const env = { ...process.env, VIHKO_NOTES_DIR: join(work, 'notes'), VIHKO_STATE_DIR: join(work, 'state') }
  cpSync(VAULT, env.VIHKO_NOTES_DIR, { recursive: true })
  const file = join(env.VIHKO_NOTES_DIR, NOTE)
  const text = readFileSync(file, 'utf8')
  if (!text.includes(COMMENTED)) throw new Error(`the commented passage is no longer in ${NOTE}`)
  const thread = THREAD.map((c) => `<!-- @${c.who} ${stamp(c.minutesAgo)} · ${c.text} -->`).join('\n')
  writeFileSync(file, text.replace(COMMENTED, `${COMMENTED}${thread}`))
  await createPeople(env.VIHKO_STATE_DIR)
  return env as Record<string, string>
}

/**
 * The two people, as `vihko user create` makes them. A person's colour comes
 * from their (random) id: they are made again until the admin's is a teal and
 * the member's a warm red, so every run looks the same.
 */
async function createPeople(stateDir: string) {
  const within = (h: number, from: number, to: number) => (from <= to ? h >= from && h < to : h >= from || h < to)
  for (let attempt = 0; attempt < 500; attempt++) {
    rmSync(stateDir, { recursive: true, force: true })
    prepareStateDir(stateDir)
    const state = openState(join(stateDir, 'state.db'))
    try {
      const auth = new Auth(state)
      const admin = await auth.createUser(ADMIN.username, ADMIN.password, 'admin')
      const member = await auth.createUser(MEMBER.username, MEMBER.password, 'member')
      if (within(baseHue(admin.id), 160, 200) && within(baseHue(member.id), 345, 20)) return
    } finally {
      state.close()
    }
  }
  throw new Error('no ids gave the people their colours')
}

async function waitFor(what: string, ms: number, check: () => Promise<boolean>) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check().catch(() => false)) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function startServer(env: Record<string, string>) {
  const server = spawn(process.execPath, ['--no-experimental-webstorage', CLI, 'serve'], {
    env: { ...env, VIHKO_HOST: '127.0.0.1', VIHKO_PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
  })
  children.push(server)
  await waitFor('vihko to answer', 60_000, async () => (await fetch(`${BASE}/api/health`)).ok)
}

/** Chromium in the Playwright image (the host may lack its libraries), on the host's network. */
async function startBrowser(): Promise<Browser> {
  const docker = spawn('docker', [
    'run', '--rm', '--init', '--name', CONTAINER, '--network', 'host',
    '--user', `${process.getuid!()}:${process.getgid!()}`, '-e', 'HOME=/tmp',
    '-v', `${ROOT}:${ROOT}:ro`, '-w', ROOT, IMAGE,
    'node', join(ROOT, 'node_modules/@playwright/test/cli.js'), 'run-server', '--host', '127.0.0.1', '--port', String(BROWSER_PORT),
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  children.push(docker)
  let browser: Browser | undefined
  await waitFor('the browser server', 120_000, async () => {
    browser = await chromium.connect(`ws://127.0.0.1:${BROWSER_PORT}/`, { timeout: 5_000 })
    return true
  })
  return browser!
}

/** A person's own browser session (English UI, light theme), signed in, with the note open. */
async function open(browser: Browser, who: { username: string; password: string }, device: typeof DESKTOP | typeof MOBILE): Promise<Page> {
  const ctx: BrowserContext = await browser.newContext({ ...device, baseURL: BASE, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light' })
  const login = await ctx.request.post('/api/auth/login', { data: who })
  if (!login.ok()) throw new Error(`sign-in of ${who.username}: ${login.status()} ${await login.text()}`)
  const page = await ctx.newPage()
  await page.goto(`/?note=${encodeURIComponent(NOTE)}`)
  await page.locator('.cm-content').waitFor()
  await page.locator('.cm-image img').evaluate((img: HTMLImageElement) => img.decode())
  return page
}

/** The caret at the end of the editor's line holding `text` (by the DOM selection, which the editor takes as its own). */
async function caretAtEnd(page: Page, text: string) {
  const line = page.locator('.cm-line', { hasText: text })
  await page.locator('.cm-content').focus()
  await line.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
  })
}

/** Nothing transient: no focus, no pointer over anything, the note saved, fonts and images loaded. */
async function settle(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(-1, -1)
  await page.evaluate(() => document.fonts.ready)
  await page.getByText('Saving…').first().waitFor({ state: 'detached' })
  await page.waitForTimeout(600)
}

async function shoot(page: Page, name: string, theme: 'light' | 'dark'): Promise<Buffer> {
  await page.emulateMedia({ colorScheme: theme })
  await settle(page)
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide' })
  writeFileSync(join(OUT, name), png)
  console.log(`  ${name}`)
  return png
}

/** Composes an image in the browser: `html` with the pictures as data URLs, at `width`×`height` CSS pixels, screenshot at scale 1. */
async function compose(browser: Browser, name: string, width: number, height: number, html: (src: string[]) => string, pictures: Buffer[], transparent = false) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  const src = pictures.map((p) => `data:image/png;base64,${p.toString('base64')}`)
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}</style>${html(src)}`)
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())))
  writeFileSync(join(OUT, name), await page.screenshot({ omitBackground: transparent }))
  await page.close()
  console.log(`  ${name}`)
}

async function main() {
  if (!existsSync(join(ROOT, 'packages/web/dist/index.html'))) throw new Error('no compiled UI: npm run build first')
  mkdirSync(OUT, { recursive: true })
  const env = await prepare()
  await startServer(env)
  const browser = await startBrowser()
  console.log(`vihko on ${BASE}, browser ${IMAGE}`)

  // Desktop: the member has the note open too (a second face in the header);
  // the admin's side panel is on the comments.
  const member = await open(browser, MEMBER, DESKTOP)
  await caretAtEnd(member, CARET)
  const admin = await open(browser, ADMIN, DESKTOP)
  await admin.locator('.cm-ySelectionCaret').waitFor()
  await admin.getByRole('tab', { name: /^Comments/ }).click()
  const light = await shoot(admin, 'desktop-light.png', 'light')
  const dark = await shoot(admin, 'desktop-dark.png', 'dark')
  const [w, h] = [DESKTOP.viewport.width * DESKTOP.deviceScaleFactor, DESKTOP.viewport.height * DESKTOP.deviceScaleFactor]
  // The dark part from a slanted line through the note, clear of its table
  // (the tree and the start of the note light, the rest and the panel dark);
  // rounded, with a hairline that shows on a light page and on a dark one.
  await compose(browser, 'desktop.png', w, h, ([l, d]) => `
    <div style="position:relative;width:${w}px;height:${h}px;border-radius:24px;overflow:hidden">
      <img src="${l}" style="position:absolute;inset:0">
      <img src="${d}" style="position:absolute;inset:0;clip-path:polygon(60% 0,100% 0,100% 100%,48% 100%)">
      <div style="${FRAME}"></div>
    </div>`, [light, dark], true)
  await member.context().close()
  await admin.context().close()

  // Phone.
  const phone = await open(browser, ADMIN, MOBILE)
  // The table runs under the editor's bar: scrolled a little, so that the
  // bar's edge meets one of its row lines instead of cutting through text.
  await phone.evaluate(() => {
    const bar = document.querySelector('.editor-bar')!.getBoundingClientRect().top
    const next = [...document.querySelectorAll('.cm-table tr')].map((r) => r.getBoundingClientRect().bottom).find((b) => b >= bar)
    if (next !== undefined) document.querySelector('.cm-scroller')!.scrollTop += Math.round(next - bar)
  })
  const mLight = await shoot(phone, 'mobile-light.png', 'light')
  const mDark = await shoot(phone, 'mobile-dark.png', 'dark')
  await phone.context().close()
  // Side by side, each at twice its CSS size, rounded like a screen, on a transparent ground.
  const [pw, ph, gap] = [MOBILE.viewport.width * 2, MOBILE.viewport.height * 2, 64]
  await compose(browser, 'mobile.png', pw * 2 + gap, ph, ([l, d]) => `
    <div style="display:flex;gap:${gap}px">
      ${[l, d].map((s) => `<div style="position:relative;width:${pw}px;height:${ph}px;border-radius:48px;overflow:hidden">
        <img src="${s}" style="width:100%;height:100%;display:block"><div style="${FRAME}"></div></div>`).join('')}
    </div>`, [mLight, mDark], true)

  await browser.close()
}

try {
  await main()
} finally {
  await cleanUp()
}
