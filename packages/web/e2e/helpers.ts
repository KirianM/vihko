import { expect, request, type APIRequestContext, type Browser, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'
import { addressOf, pathOfAddress } from '@vihko/core/spaces'
import { ADMIN, BASE_URL, NOTES, PERMISSIONS, permissionsSection, SPACE, SPACE_GRANTS, type Grants, type Rule } from './env.ts'

/** Writes vihko.yaml with `text` and `permissions` (by default the ones every spec runs under, env.ts); with nothing, only those. */
export function writeWorkspace(text = '', permissions = PERMISSIONS) {
  writeFileSync(`${NOTES}/vihko.yaml`, (text === '' || text.endsWith('\n') ? text : text + '\n') + permissions)
}

/**
 * The permissions of a spec, in vihko.yaml: SPACE_GRANTS plus `grants` at
 * the vault's space, and `rules` for other folders (real paths from the
 * notes root; `config`, other keys of the file, before them). Returns once
 * vihko has read it, as the space's grants say to the admin: the whole file
 * is read at once, so the rules are in force too (when the space's grants
 * don't change, the spec waits for its rules itself). With nothing, the
 * baseline back: every spec that calls it in `beforeAll` calls it again in
 * `afterAll`, after whatever it undoes with its grants.
 */
export async function usePermissions(opts: { grants?: Grants; rules?: Record<string, Rule>; config?: string } = {}) {
  writeWorkspace(opts.config, permissionsSection(opts.grants, opts.rules))
  const expected = { ...SPACE_GRANTS, ...opts.grants }
  const api = await request.newContext({ baseURL: BASE_URL })
  try {
    const login = await api.post('/api/auth/login', { data: { username: ADMIN.username, password: ADMIN.password } })
    expect(login.status(), await login.text()).toBe(200)
    await expect.poll(async () => {
      const r = await api.get(`/api/permissions?folder=${encodeURIComponent(SPACE)}`)
      return r.ok() ? ((await r.json()) as { own: { grants: Grants | null } }).own.grants : r.status()
    }, { message: 'vihko reads the new vihko.yaml', timeout: 15_000 }).toEqual(expected)
  } finally {
    await api.dispose()
  }
}

/** Own session (isolated context) with the person already signed in and the note open. */
export async function signIn(browser: Browser, user: { username: string; password: string }, note?: string): Promise<Page> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(note ? `/?note=${encodeURIComponent(note)}` : '/')
  await page.getByLabel('Nombre de usuario').fill(user.username)
  await page.getByLabel('Contraseña').fill(user.password)
  await page.getByRole('button', { name: 'Entrar' }).last().click()
  if (note) await expect(page.locator('.cm-content')).toBeVisible()
  // «My notes» is always there: the first of the sidebar's trees (one per space, D-056).
  else await expect(page.getByRole('treegrid').first()).toBeVisible()
  return page
}

/**
 * Dismisses the notices addressed to whoever `page` is signed in as (what
 * others shared with them, D-056.22; what the admin did to their account):
 * other specs on the same server leave some, and a notice that comes in with
 * the session closes a phone's drawer and shows a toast.
 */
export async function dismissNotices(api: APIRequestContext) {
  const { alerts } = await (await api.get('/api/alerts')).json() as { alerts: { id?: string; code: string; actions: string[] }[] }
  const personal = ['account_changed', 'user_account_changed', 'history_purged_authored', 'links_not_updated', 'space_changed', 'shared_with_you']
  for (const a of alerts) if (a.id && personal.includes(a.code)) await api.delete(`/api/account/notices/${encodeURIComponent(a.id)}`)
}

/** The sidebar's tree of a space or a shared folder, by the name the sidebar gives it («Mis notas», the space's name). */
export const spaceTree = (page: Page, name: string | RegExp) => page.getByRole('treegrid', { name, exact: typeof name === 'string' })

/**
 * Someone new, created by the admin (`admin`: a page with their session) and
 * signed up through their link with their password, as a person would: the
 * API never takes a new user's password (D-046.1). A new admin is confirmed
 * with the admin's password (the servers' admin has no second factor).
 */
export async function newUser(admin: Page, user: { username: string; password: string; role?: 'admin' | 'member' }) {
  const role = user.role ?? 'member'
  const r = await admin.request.post('/api/admin/users', { data: { username: user.username, role, ...(role === 'admin' ? { confirm: ADMIN.password } : {}) } })
  expect(r.status(), await r.text()).toBe(201)
  const { link } = await r.json() as { link: { token: string } }
  const api = await request.newContext({ baseURL: BASE_URL })
  try {
    const accepted = await api.post(`/api/invite/${link.token}`, { data: { password: user.password } })
    expect(accepted.status(), await accepted.text()).toBe(200)
  } finally {
    await api.dispose()
  }
}

/** `text` for a regular expression that matches it literally (generated names have dots; valid with the `u` flag too). */
export const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/**
 * A pattern for `note=<the note's address>` in the browser's URL (D-056.29:
 * `home-7k2q9x/…` or `~ana/…`, never `people/` nor `spaces/`), however the
 * query encodes it (`+` or `%20`, `~` or `%7E`).
 */
/** The path of the note open in `page`, read from its address (`?note=`). */
export const openPath = (page: Page) => { const v = new URL(page.url()).searchParams.get('note'); return v === null ? null : pathOfAddress(v)?.path ?? null }

export const noteInUrl = (path: string) => `note=${literally(encodeURIComponent(addressOf(path) ?? path)).replace(/%20/g, '(?:\\+|%20)').replace(/~/g, '(?:~|%7E)')}`

/**
 * A pattern for `text` as a whole word, from `^` when `start`: `\b` only
 * knows ASCII, and a name ending in «í» has no `\b` after it.
 */
export const wordRe = (text: string, opts: { start?: boolean; flags?: string } = {}) =>
  new RegExp(`${opts.start ? '^' : '(?<![\\p{L}\\p{N}])'}${literally(text)}(?![\\p{L}\\p{N}])`, `u${opts.flags ?? ''}`)

export const editorText =(page: Page) => page.locator('.cm-content').innerText()

/** A solid-colour PNG, so the browser really decodes and shows something. */
export function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8) // 8 bits, RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** Dispatches a paste (or a drop) with these files, as the browser does with a screenshot on the clipboard. */
export async function sendFiles(page: Page, kind: 'paste' | 'drop', files: { name: string; bytes: Buffer }[]) {
  await page.locator('.cm-content').evaluate((el, { kind, files }) => {
    const dt = new DataTransfer()
    for (const f of files) dt.items.add(new File([Uint8Array.from(f.bytes)], f.name, { type: 'image/png' }))
    if (kind === 'paste') {
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    } else {
      const line = el.querySelector('.cm-line:last-child')!.getBoundingClientRect()
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: line.left + 5, clientY: line.top + 5 }))
    }
  }, { kind, files: files.map((f) => ({ name: f.name, bytes: [...f.bytes] })) })
}
