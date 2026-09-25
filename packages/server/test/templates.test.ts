// Templates (D-030): a new note from a template note, never overwriting.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG, setup } from './_app.ts'

test('templates: a new note from any template note, in the person\'s timezone', async () => {
  const { notesDir, noa, runtime } = await setup({ config: CONFIG })
  writeFileSync(join(notesDir, 'Plantillas', 'Reunión.md'), '# {{title}}\n\n{{date:YYYY-MM-DD HH:mm}} {{user}}\n')
  runtime.rescan({})
  await noa('PUT', '/api/profile', { timezone: 'Asia/Tokyo' })
  const r = await noa('POST', '/api/note', { path: 'proyectos/Kickoff.md', template: 'Plantillas/Reunión.md' })
  assert.equal(r.status, 201)
  assert.equal(readFileSync(join(notesDir, 'proyectos/Kickoff.md'), 'utf8'), `---\nuid: ${r.body.uid}\n---\n# Kickoff\n\n2026-09-25 08:30 noa\n`)
  assert.equal((await noa('POST', '/api/note', { path: 'proyectos/Kickoff.md', template: 'Plantillas/Reunión.md' })).body.error, 'exists')
  assert.equal((await noa('POST', '/api/note', { path: 'x.md', template: 'Plantillas/Nope.md' })).body.error, 'not_found')
  assert.equal((await noa('POST', '/api/note', { path: 'x.md', template: 3 })).body.error, 'invalid')
  assert.ok(!existsSync(join(notesDir, 'x.md')))
})
