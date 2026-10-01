import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_NOTE_SETTINGS, NOTE_SETTINGS_VERSION, NoteSettingsFileError, noteSettingsPath, parseNoteSettings, resolveNoteSettings, writeNoteSettings, type NoteSettings } from '@vihko/core'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** Settings of a space, the mother's names. */
function aSettings(): NoteSettings {
  const folder = m.aFolder()
  return {
    version: NOTE_SETTINGS_VERSION,
    daily: [{ id: m.anId(), label: m.aHeading(), folder: `${folder}/{YYYY}`, name: '{YYYY}-{MM}-{DD}', template: `${m.aFolder()}/${m.aTitle()}.md` }],
    templates: [m.aFolder()],
    attachments: { mode: 'folder', folder: m.aFolder() },
    agents: `${m.aTitle()}.md`,
  }
}

test('note settings: the file of a space, where it is', () => {
  const user = m.aUsername()
  assert.equal(noteSettingsPath(`people/${user}`), `people/${user}/.vihko/settings.yaml`)
  assert.equal(noteSettingsPath('spaces/Casa'), 'spaces/Casa/.vihko/settings.yaml')
})

test('note settings: written and read back the same; nothing there is the empty settings', () => {
  const s = aSettings()
  const text = writeNoteSettings(null, s)
  assert.match(text, /^version: 1\n/)
  assert.deepEqual(parseNoteSettings(text), { settings: s, errors: [] })
  assert.deepEqual(parseNoteSettings(null), { settings: EMPTY_NOTE_SETTINGS, errors: [] })
  assert.deepEqual(parseNoteSettings(''), { settings: EMPTY_NOTE_SETTINGS, errors: [] })
})

test('note settings: a change touches only what changed; comments and unknown keys stay', () => {
  const s = aSettings()
  const comment = `# ${m.aSentence()}`
  const text = `${comment}\n${writeNoteSettings(null, s)}# ${m.aWord()}\nlater: ${m.aWord()}\n`
  const next: NoteSettings = { ...s, templates: [...s.templates, m.aFolder()], agents: null }
  const out = writeNoteSettings(text, next)
  assert.ok(out.includes(comment))
  assert.match(out, /\nlater: /)
  assert.deepEqual(parseNoteSettings(out).settings, next)
  assert.deepEqual(parseNoteSettings(out).errors.map((e) => [e.code, e.at]), [['unknown_key', 'later']])
  // Not YAML: vihko doesn't write over it.
  assert.throws(() => writeNoteSettings('daily: [', next), NoteSettingsFileError)
})

test('note settings: what is wrong is left out and said, with where; the rest applies', () => {
  const [good, id] = [m.anId(), m.anId()]
  // Literals: each value is the case under test.
  const r = parseNoteSettings(`version: 1\ndaily:\n  ${good}:\n    folder: ${JSON.stringify(`${m.aFolder()}/{YYYY}`)}\n  ${id}:\n    folder: ../out\n  weekly:\n    folder: w\n    name: "{GGGG}-W{WW}-{user}"\n  monthly:\n    folder: m\n    name: "{MM}"\n`)
  assert.deepEqual(r.settings.daily.map((d) => d.id), [good])
  assert.deepEqual(r.errors.map((e) => [e.code, e.at]).sort(), [['invalid_path', `daily.${id}.folder`], ['pattern_period', 'daily.monthly.name'], ['pattern_token', 'daily.weekly.name']].sort())
  for (const [bad, code] of [['templates: /abs', 'invalid_path'], ['templates: a/../b', 'invalid_path'], ['templates: .hidden', 'invalid_path'], ['agents: 7', 'invalid_type'], ['attachments: { mode: other }', 'invalid_value'], ['version: two', 'invalid_version'], ['version: 9', 'newer_version'], ['what: 1', 'unknown_key'], ['- a list', 'not_a_map'], ['a: [', 'yaml']] as const) {
    assert.equal(parseNoteSettings(bad).errors[0]?.code, code, bad)
  }
  // Each with its line.
  assert.equal(parseNoteSettings(`version: 1\ntemplates: /abs\n`).errors[0]!.line, 2)
})

test('note settings: saving what was read from a hand-broken file writes over its wrong values; a key vihko doesn\'t know stays', () => {
  const [good, bad, later] = [m.anId(), m.anId(), m.aWord()]
  const folder = `${m.aFolder()}/{YYYY}`
  // Literals: each wrong value is the case under test.
  for (const text of [
    `version: two\ndaily:\n  ${good}:\n    folder: ${JSON.stringify(folder)}\n  ${bad}:\n    folder: ../out\ntemplates: /abs\nattachments: { mode: other }\nagents: 7\n${later}: 1\n`,
    `daily: 3\ntemplates: [a/../b]\n${later}: 1\n`,
  ]) {
    const read = parseNoteSettings(text).settings
    const out = parseNoteSettings(writeNoteSettings(text, read))
    assert.deepEqual(out.settings, read, text)
    assert.deepEqual(out.errors.map((e) => [e.code, e.at]), [['unknown_key', later]], text)
  }
})

test('note settings: resolved inside the space, each series with its own id', () => {
  const s = aSettings()
  const root = `spaces/${m.aSpaceName()}`
  const r = resolveNoteSettings(s, root, 'sp-')
  assert.deepEqual(r.daily.map((d) => [d.id, d.folder, d.template, d.period]), [[`sp-${s.daily[0]!.id}`, `${root}/${s.daily[0]!.folder}`, `${root}/${s.daily[0]!.template}`, 'day']])
  assert.deepEqual(r.templates, [`${root}/${s.templates[0]}`])
  assert.deepEqual(r.attachments, { folder: (s.attachments as { folder: string }).folder })
  assert.equal(r.agents, `${root}/${s.agents}`)
  assert.deepEqual(resolveNoteSettings({ ...s, attachments: { mode: 'per-note', suffix: '.files' } }, root, '').attachments, { folder: null, perNote: '.files' })
})
