// vihko can't save an open note (its folder refuses writes, as with a full
// disk or wrong permissions), with two sessions on it: both are told and
// can't type, the admin sees an alert, and once the folder takes writes
// again the note saves what it held and both can type again.
import { expect, test } from '@playwright/test'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ADMIN, E2E_DIR, MEMBER, NOTES, inVault, specMother } from './env.ts'
import { literally, signIn } from './helpers.ts'

const m = specMother(import.meta.url)
const DIR = inVault(m.aFolder())
const TITLE = m.aTitle()
const NOTE = `${DIR}/${TITLE}.md`
const SHOTS = `${E2E_DIR}/shots`
const SLOW = { timeout: 20_000 }
const disk = () => readFileSync(`${NOTES}/${NOTE}`, 'utf8')

test('the note\'s folder refuses writes: read-only for both sessions, the admin is told; then it saves and is writable again', async ({ browser }) => {
  test.skip(process.getuid?.() === 0, 'permissions don\'t stop root')
  mkdirSync(`${NOTES}/${DIR}`, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(`${NOTES}/${NOTE}`, `# ${TITLE}\n\n${m.aSentence()}\n`)
  const member = await signIn(browser, MEMBER, NOTE)
  const admin = await signIn(browser, ADMIN, NOTE)
  const [held, ignored, after] = [m.aUniqueWord(), m.aUniqueWord(), m.aUniqueWord()]
  chmodSync(`${NOTES}/${DIR}`, 0o555)
  try {
    await member.locator('.cm-content').click()
    await member.keyboard.press('Control+End')
    await member.keyboard.type(`\n${held}`)
    for (const p of [member, admin]) {
      await expect(p.getByRole('alert').filter({ hasText: 'vihko no puede guardar esta nota ahora' })).toContainText('no tiene permiso para escribir', SLOW)
      await expect(p.locator('.status')).toHaveText('Sin guardar · solo lectura')
      await expect(p.locator('.cm-content')).toHaveAttribute('aria-readonly', 'true')
    }
    await member.screenshot({ path: `${SHOTS}/unsaved-note.png` })
    expect(disk()).not.toContain(held)
    // Typing goes nowhere.
    await admin.locator('.cm-content').click()
    await admin.keyboard.type(ignored)
    // The admin's alert, where alerts show.
    await admin.goto('/?view=alerts')
    await expect(admin.getByRole('region', { name: new RegExp(`^vihko no puede guardar «.* / ${literally(TITLE)}»$`) })).toBeVisible(SLOW)
    await admin.screenshot({ path: `${SHOTS}/unsaved-alert.png` })
    await admin.goto(`/?note=${encodeURIComponent(NOTE)}`)
    await expect(admin.getByRole('alert').filter({ hasText: 'vihko no puede guardar esta nota ahora' })).toBeVisible()
  } finally {
    chmodSync(`${NOTES}/${DIR}`, 0o755)
  }
  for (const p of [member, admin]) {
    await expect(p.getByRole('alert').filter({ hasText: 'vihko no puede guardar' })).toHaveCount(0, SLOW)
    await expect(p.locator('.status')).toHaveText('Guardado en disco', SLOW)
  }
  expect(disk()).toContain(held)
  expect(disk()).not.toContain(ignored)
  await member.locator('.cm-content').click()
  await member.keyboard.press('Control+End')
  await member.keyboard.type(`\n${after}`)
  await expect.poll(disk, SLOW).toContain(after)
  await expect.poll(async () => (await admin.locator('.cm-content').innerText())).toContain(after)
})
