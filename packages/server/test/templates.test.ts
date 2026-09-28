// Templates (D-030): a new note from a template note, never overwriting.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG, DAILY, setup } from './_app.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** An instant as `YYYY-MM-DD HH:mm` in a timezone. */
function localTime(timeZone: string, at: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(at).map((p) => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

test('templates: a new note from any template note, in the person\'s timezone', async () => {
  const now = new Date('2026-09-24T23:30:00Z') // the setup's clock
  const { notesDir, admin, runtime, users } = await setup({ config: CONFIG })
  const template = `${DAILY.templates}/${m.aTitle()}.md`
  writeFileSync(join(notesDir, template), '# {{title}}\n\n{{date:YYYY-MM-DD HH:mm}} {{user}}\n')
  runtime.rescan({})
  const zone = m.aTimeZone()
  await admin('PUT', '/api/profile', { timezone: zone })
  const title = m.aTitle()
  const path = `${m.aFolder()}/${title}.md`
  const r = await admin('POST', '/api/note', { path, template })
  assert.equal(r.status, 201)
  assert.equal(readFileSync(join(notesDir, path), 'utf8'), `---\nuid: ${r.body.uid}\n---\n# ${title}\n\n${localTime(zone, now)} ${users.admin.username}\n`, zone)
  assert.equal((await admin('POST', '/api/note', { path, template })).body.error, 'exists')
  const other = m.aNotePath()
  assert.equal((await admin('POST', '/api/note', { path: other, template: `${DAILY.templates}/${m.aTitle()}.md` })).body.error, 'not_found')
  assert.equal((await admin('POST', '/api/note', { path: other, template: 3 })).body.error, 'invalid')
  assert.ok(!existsSync(join(notesDir, other)))
})
