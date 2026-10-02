// The log and personal spaces (logging.ts): at `info`, a path inside one is
// never written, only that it's in a personal space and a note's uid; at
// `debug`, whole. Shared spaces' paths are written either way.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newUid } from '@vihko/core'
import { configFromEnv, configureLogging, scrub, shownPath } from '@vihko/server'
import { tempDir } from './_tmp.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

test('at info, a personal space\'s paths become what they are (with a note\'s uid); a shared space\'s stay; at debug, all whole', (t) => {
  const user = m.aUsername()
  const [uid, title, folder] = [newUid(), m.aTitle(), m.aFolder()]
  const note = `people/${user}/${folder}/${title}.md`
  const image = `people/${user}/${folder}/${m.aUniqueWord()}.png`
  const shared = `spaces/${m.aSpaceFolder(m.aSpaceName())}/${m.aTitle()}.md`
  configureLogging({ level: 'info', uidOf: (p) => (p === note ? uid : null) })
  t.after(() => configureLogging({ level: 'info', uidOf: () => null }))

  assert.equal(shownPath(note), `a note in a personal space (uid ${uid})`)
  assert.equal(shownPath(`people/${user}/${m.aTitle()}.md`), 'a note in a personal space')
  assert.equal(shownPath(image), 'a file or folder in a personal space')
  assert.equal(shownPath(`people/${user}`), 'a personal space')
  assert.equal(shownPath(shared), shared)

  // Whatever else carries them (an error's message, a path on the disk), nothing of the person's names is left.
  for (const line of [
    `flush of x: ENOENT: no such file or directory, open '/data/notes/${note}'`,
    `${note} was deleted outside vihko`,
    `moved ${note} → ${image}, and ${shared}`,
  ]) {
    const out = scrub(line)
    for (const secret of [user, title, folder]) assert.ok(!out.includes(secret), `${out} (${secret})`)
    if (line.includes(shared)) assert.ok(out.includes(shared), out)
  }

  configureLogging({ level: 'debug' })
  assert.equal(shownPath(note), note)
  assert.equal(scrub(`${note} was deleted`), `${note} was deleted`)
})

test('VIHKO_LOG_LEVEL: info (the default) or debug', () => {
  const base = { VIHKO_NOTES_DIR: tempDir('vihko-log-notes-'), VIHKO_STATE_DIR: tempDir('vihko-log-state-') }
  assert.equal(configFromEnv(base).logLevel, 'info')
  assert.equal(configFromEnv({ ...base, VIHKO_LOG_LEVEL: 'debug' }).logLevel, 'debug')
  assert.throws(() => configFromEnv({ ...base, VIHKO_LOG_LEVEL: m.aWord() }), /VIHKO_LOG_LEVEL/)
})
