// An open note whose folder is moved through the API and moved back: its
// editor follows it both times, and a reload opens it where it is. The
// editor used to reopen it at the first new path while the second move took
// it away, and showed it as missing (the server now says where it went).
import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { ADMIN, NOTES, inVault, specMother } from './env.ts'
import { noteInUrl, signIn } from './helpers.ts'

const m = specMother(import.meta.url)

test('a folder moved through the API and back while its note is open: the editor ends where the note is', async ({ browser }) => {
  const k = await signIn(browser, ADMIN)
  // Waiting for the editor between the two moves, and not.
  for (const wait of [true, false, true, false]) {
    const [a, b] = [inVault(m.aFolder()), inVault(m.aFolder())]
    const title = m.aTitle()
    mkdirSync(`${NOTES}/${a}`, { recursive: true })
    writeFileSync(`${NOTES}/${a}/${title}.md`, `# ${title}\n`)
    await k.goto(`/?note=${encodeURIComponent(`${a}/${title}.md`)}`)
    await expect(k.locator('.cm-content')).toBeVisible()
    expect((await k.request.post('/api/folder/move', { data: { from: a, to: b } })).status()).toBe(200)
    if (wait) await expect(k).toHaveURL(new RegExp(noteInUrl(`${b}/${title}.md`)))
    expect((await k.request.post('/api/folder/move', { data: { from: b, to: a } })).status()).toBe(200)
    await expect(k).toHaveURL(new RegExp(noteInUrl(`${a}/${title}.md`)), { timeout: 10_000 })
    await expect(k.getByText('Esta nota no existe o no tienes acceso.')).toHaveCount(0)
    await k.reload()
    await expect(k.locator('.crumbs b')).toHaveText(title)
    await expect(k.locator('.cm-content')).toBeVisible()
  }
  await k.context().close()
})
