// The app shell never scrolls as a whole: only the main area's content does,
// as in a note. In every view of the main area, at a desktop's width and a
// phone's, scrolling its content to the end and wheeling on leaves the page
// where it was (`document.scrollingElement` at the top, nothing to scroll),
// and the sidebar (on a phone, the header) where it was. «Recent changes»
// first, filled with enough changes to scroll.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { addressOf } from '@vihko/core/spaces'
import { ADMIN, freshFolder, inVault, specMother } from './env.ts'
import { dismissNotices, signIn } from './helpers.ts'

const m = specMother(import.meta.url)
const FOLDER = freshFolder(() => m.aFolder())
const DIR = inVault(FOLDER)
/** Changes enough to scroll «Recent changes» on any screen: each note created is one. */
const COUNT = 30
const NOTES = Array.from({ length: COUNT }, () => m.aNotePath(DIR))
/** The changes «Recent changes» must list of them, at least (the history may join notes written at once). */
const MIN_CHANGES = 12
/** A note longer than any screen, for the note and its version. */
const LONG = NOTES[0]!
const LONG_TEXT = `# ${m.aHeading()}\n\n${Array.from({ length: 60 }, () => m.aParagraph()).join('\n\n')}\n`
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'es-ES' }

test.describe.configure({ mode: 'serial' })
let desk: Page
let phone: Page
/** A version of the long note (`?version=`). */
let version: string

test.beforeAll(async ({ browser }) => {
  desk = await signIn(browser, ADMIN)
  await dismissNotices(desk.request)
  for (const path of NOTES) {
    const r = await desk.request.post('/api/note', { data: { path, text: path === LONG ? LONG_TEXT : `# ${m.aHeading()}\n\n${m.aParagraph()}\n` } })
    expect(r.status(), await r.text()).toBe(201)
  }
  // Every note is in «Recent changes» (the history writes them in the background).
  await expect.poll(async () => {
    const r = await desk.request.get(`/api/history/changes?limit=200`)
    const { changes } = await r.json() as { changes: { files: { path: string }[] }[] }
    return changes.filter((c) => c.files.some((f) => f.path.startsWith(`${DIR}/`))).length
  }, { timeout: 20_000 }).toBeGreaterThanOrEqual(MIN_CHANGES)
  const v = await (await desk.request.get(`/api/history/versions?path=${encodeURIComponent(LONG)}`)).json() as { versions: { id: string }[] }
  version = v.versions[0]!.id
  phone = await phoneSession(browser)
})

test.afterAll(async () => {
  await desk.request.delete(`/api/folder?path=${encodeURIComponent(DIR)}`)
  await desk.context().close()
  await phone?.context().close()
})

async function phoneSession(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext(PHONE)
  const page = await ctx.newPage()
  await page.goto('/')
  await page.getByLabel('Nombre de usuario').fill(ADMIN.username)
  await page.getByLabel('Contraseña').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Entrar' }).last().tap()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  return page
}

const address = (path: string) => encodeURIComponent(addressOf(path) ?? path)

/** The views of the main area: where each is, what says it's there, and whether its content is sure to be longer than the screen. */
const VIEWS: { name: string; url: () => string; ready: (page: Page) => Promise<void>; long?: boolean }[] = [
  { name: 'Recent changes', url: () => '/?view=changes', ready: (p) => expect(p.locator('.c-change').nth(MIN_CHANGES - 1)).toBeVisible({ timeout: 15_000 }), long: true },
  { name: 'Home', url: () => '/', ready: (p) => expect(p.getByRole('heading', { name: 'Inicio', level: 1 })).toBeVisible() },
  { name: 'Alerts', url: () => '/?view=alerts', ready: (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible() },
  { name: 'Users', url: () => '/?view=users', ready: (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible() },
  { name: 'Spaces', url: () => '/?view=spaces', ready: (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible() },
  { name: 'Account', url: () => '/?view=account', ready: (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible() },
  { name: 'Agents', url: () => '/?view=agents', ready: (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible() },
  { name: 'Trash', url: () => '/?view=trash', ready: (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible() },
  { name: 'Privacy', url: () => '/?view=privacy', ready: (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible() },
  { name: 'a note', url: () => `/?note=${address(LONG)}`, ready: (p) => expect(p.locator('.cm-content')).toBeVisible(), long: true },
  { name: 'a version', url: () => `/?note=${address(LONG)}&version=${encodeURIComponent(version)}`, ready: (p) => expect(p.locator('.version')).toBeVisible(), long: true },
]

/** Two frames: whatever a wheel scrolls has been painted. */
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))

const documentScroll = (page: Page) => page.evaluate(() => {
  const d = document.scrollingElement!
  return { top: d.scrollTop, overflow: d.scrollHeight - d.clientHeight }
})

/**
 * The main area's content scrolled to its end, then wheeled and scrolled on:
 * the page stays at the top with nothing to scroll, and `anchor` (the
 * sidebar, or a phone's header) doesn't move.
 */
async function scrollsInsideOnly(page: Page, anchorSelector: string, long: boolean) {
  const anchor = page.locator(anchorSelector).first()
  const before = await anchor.boundingBox()
  expect(before).not.toBeNull()
  const main = page.locator('main.main')
  // Every scroller in the main area to its end (the view's content, the editor's): how many scrolled.
  const toTheEnd = () => main.evaluate((el) => {
    let n = 0
    for (const s of [el, ...el.querySelectorAll<HTMLElement>('*')]) {
      const o = getComputedStyle(s).overflowY
      if ((o === 'auto' || o === 'scroll') && s.scrollHeight > s.clientHeight) { s.scrollTop = s.scrollHeight; n++ }
    }
    return n
  })
  // A long view's content may still be arriving (a version's text): until it scrolls.
  if (long) await expect.poll(toTheEnd, { message: 'the content is longer than the screen and scrolls in the main area', timeout: 15_000 }).toBeGreaterThan(0)
  else await toTheEnd()
  await frames(page)
  const box = (await main.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 1200)
  await frames(page)
  // As a script or the keyboard would: the page has nowhere to go.
  await page.evaluate(() => { window.scrollTo(0, 1e6); document.scrollingElement!.scrollTop = 1e6 })
  await frames(page)
  expect(await documentScroll(page)).toEqual({ top: 0, overflow: 0 })
  expect(await anchor.boundingBox()).toEqual(before)
}

/**
 * A control below the fold that takes the focus (the keyboard's Tab) is
 * brought into view by scrolling the main area, never the page: the last
 * switch of «Users and groups», whose input is the hidden one React Aria
 * keeps for screen readers.
 */
async function focusScrollsTheView(page: Page) {
  await page.goto('/?view=users')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const last = page.getByRole('switch').last()
  const scroller = page.locator('main.main .settings-page')
  await expect.poll(() => scroller.evaluate((el) => el.scrollHeight > el.clientHeight), { message: 'the view is longer than the screen' }).toBe(true)
  await scroller.evaluate((el) => { el.scrollTop = 0 })
  await last.focus()
  await frames(page)
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  const box = (await last.boundingBox())!
  const main = (await page.locator('main.main').boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(main.y)
  expect(box.y + box.height).toBeLessThanOrEqual(main.y + main.height)
  expect(await documentScroll(page)).toEqual({ top: 0, overflow: 0 })
}

test('on a desktop, a control the focus reaches below the fold scrolls the view to it', () => focusScrollsTheView(desk))
test('on a phone, a control the focus reaches below the fold scrolls the view to it', () => focusScrollsTheView(phone))

for (const view of VIEWS) {
  test(`${view.name}: on a desktop, only the main area scrolls`, async () => {
    await desk.goto(view.url())
    await view.ready(desk)
    await scrollsInsideOnly(desk, 'nav.sidebar', view.long === true)
  })

  test(`${view.name}: on a phone, only the main area scrolls`, async () => {
    await phone.goto(view.url())
    await view.ready(phone)
    await scrollsInsideOnly(phone, '.main-head', view.long === true)
  })
}
