// An alias typed in the editor goes through the same name guard as one added
// through the API: the member lends the admin a folder of their own space to
// edit, where a note links by an alias to a note of theirs the admin can't
// read. The admin types that alias into a note of the folder: it is taken out
// of the note before it's saved (for every editor), the admin is told, and the
// link still leads where it did. Another alias goes in.
import { expect, test } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ADMIN, E2E_DIR, MEMBER, NOTES, personal, specMother } from './env.ts'
import { signIn, usePermissions } from './helpers.ts'

const m = specMother(import.meta.url)
const SHOTS = `${E2E_DIR}/shots`
const SLOW = { timeout: 20_000 }
const OWN = personal(MEMBER)
const TRIP = `${OWN}/${m.aUniqueWord()}`
const HIDDEN = `${OWN}/${m.aUniqueWord()}`
const [TAKEN, FREE] = [m.aUniqueWord(), m.aUniqueWord()]
const SECRET = `${HIDDEN}/${m.aTitle()}.md`
const PLAN = `${TRIP}/${m.aTitle()}.md`
const MINE = `${TRIP}/${m.aTitle()}.md`
const LINKING = `[[${TAKEN}]]\n`

test.afterAll(async () => {
  await usePermissions()
})

test('an alias typed in the editor that would take a link to a note the typist can\'t read is taken out, and they are told; another goes in', async ({ browser }) => {
  for (const [path, text] of [[SECRET, `---\naliases: [${TAKEN}]\n---\n# ${m.aHeading()}\n`], [PLAN, LINKING], [MINE, `# ${m.aHeading()}\n\n${m.aSentence()}\n`]] as const) {
    mkdirSync(dirname(join(NOTES, path)), { recursive: true })
    writeFileSync(join(NOTES, path), text)
  }
  await usePermissions({ rules: { [TRIP]: { [ADMIN.username]: 'edit' } } })
  const k = await signIn(browser, ADMIN)
  try {
    expect((await k.request.post('/api/admin/rescan', { data: {} })).status()).toBe(200)
    await k.goto(`/?note=${encodeURIComponent(MINE)}`)
    await expect(k.locator('.cm-content')).toBeVisible()
    // Pasted at the start of the note, as a frontmatter block with both aliases.
    await k.locator('.cm-content').click()
    await k.keyboard.press('Control+Home')
    await k.evaluate((text) => {
      const data = new DataTransfer()
      data.setData('text/plain', text)
      document.querySelector('.cm-content')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, `---\naliases: [${TAKEN}, ${FREE}]\n---\n`)
    const banner = k.getByRole('alert').filter({ hasText: 'Ese alias no está disponible aquí' })
    await expect(banner).toBeVisible(SLOW)
    await expect(banner).toContainText(`«${TAKEN}»`)
    await expect(banner).not.toContainText(FREE)
    await k.screenshot({ path: `${SHOTS}/editor-alias-refused.png`, animations: 'disabled' })
    // Saved without it, and taken out of the editor too; the other one stays.
    await expect.poll(() => readFileSync(join(NOTES, MINE), 'utf8'), SLOW).toContain(FREE)
    expect(readFileSync(join(NOTES, MINE), 'utf8')).not.toContain(TAKEN)
    await expect(k.locator('.cm-content')).not.toContainText(TAKEN, SLOW)
    // The link the admin reads still leads where it did: not to their note.
    expect(readFileSync(join(NOTES, PLAN), 'utf8')).toBe(LINKING)
    const links = await (await k.request.get(`/api/note/links?path=${encodeURIComponent(PLAN)}`)).json()
    expect(JSON.stringify(links)).not.toContain(MINE)
    // On a phone too.
    await k.setViewportSize({ width: 390, height: 844 })
    await expect(banner).toBeVisible()
    await k.screenshot({ path: `${SHOTS}/editor-alias-refused-phone.png`, animations: 'disabled' })
    await k.setViewportSize({ width: 1280, height: 800 })
    // Dismissed, it goes.
    await banner.getByRole('button', { name: 'Cerrar aviso' }).click()
    await expect(banner).toHaveCount(0)
  } finally {
    await k.context().close()
  }
})
