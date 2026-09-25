import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_WORKSPACE, parseWorkspaceConfig, type ConfigError } from '@thoth/core'

const errors = (text: string) => {
  const r = parseWorkspaceConfig(text)
  assert.ok(!r.ok, 'should be invalid')
  return r.errors.map((e: ConfigError) => [e.code, e.at, e.line] as const)
}

test('thoth.yaml: empty or just comments is valid and turns nothing on', () => {
  for (const text of ['', '# nothing yet\n', '---\n']) assert.deepEqual(parseWorkspaceConfig(text), { ok: true, config: EMPTY_WORKSPACE })
})

test('thoth.yaml: series, templates and attachments', () => {
  const r = parseWorkspaceConfig(`# Workspace settings
version: 1
templates: Plantillas/
daily:
  diario:
    label: Mi diario
    folder: Diario/{user}
    template: Plantillas/Diario
  equipo:
    folder: Equipo
    name: "{YYYY}-{MM}-{DD} reunión"
  semanas:
    folder: Semanas
    name: "{GGGG}-W{WW}"
attachments:
  folder: Adjuntos
`)
  assert.ok(r.ok)
  assert.equal(r.config.templates, 'Plantillas')
  assert.deepEqual(r.config.attachments, { folder: 'Adjuntos' })
  assert.deepEqual(r.config.daily, [
    { id: 'diario', label: 'Mi diario', folder: 'Diario/{user}', name: '{YYYY}-{MM}-{DD}', template: 'Plantillas/Diario.md', period: 'day' },
    { id: 'equipo', label: null, folder: 'Equipo', name: '{YYYY}-{MM}-{DD} reunión', template: null, period: 'day' },
    { id: 'semanas', label: null, folder: 'Semanas', name: '{GGGG}-W{WW}', template: null, period: 'week' },
  ])
})

test('thoth.yaml: YAML errors carry their line', () => {
  assert.deepEqual(errors('daily:\n  diario:\n    folder: [unclosed\n'), [['yaml', null, 4]])
  assert.deepEqual(errors('templates: a\ntemplates: b\n'), [['yaml', null, 2]], 'duplicate keys')
  assert.deepEqual(errors('- a\n- b\n'), [['not_a_map', null, 1]])
})

test('thoth.yaml: unknown and reserved keys are errors, never ignored', () => {
  assert.deepEqual(errors('templtes: Plantillas\n'), [['unknown_key', 'templtes', 1]])
  assert.deepEqual(errors('templates: P\npermissions:\n  Privado: {noa: edit}\n'), [['not_supported', 'permissions', 2]])
  assert.deepEqual(errors('daily:\n  d:\n    folder: D\n    fromat: x\n'), [['unknown_key', 'daily.d.fromat', 4]])
  assert.deepEqual(errors('attachments:\n  mdoe: per-note\n'), [['unknown_key', 'attachments.mdoe', 2]])
  assert.deepEqual(errors('version: 2\n'), [['unsupported_version', 'version', 1]])
})

test('thoth.yaml: paths stay inside the notes folder and out of hidden folders', () => {
  for (const bad of ['../fuera', '/abs', '.oculta', 'a/../b', 'a//b', 'a/./b']) {
    assert.deepEqual(errors(`templates: "${bad}"\n`), [['invalid_path', 'templates', 1]], bad)
  }
  assert.deepEqual(errors('templates: 3\n'), [['invalid_type', 'templates', 1]])
  assert.deepEqual(errors('daily:\n  d:\n    folder: ../D\n'), [['invalid_path', 'daily.d.folder', 3]])
  assert.deepEqual(errors('daily:\n  d:\n    folder: D\n    name: "{YYYY}/{MM}-{DD}"\n'), [['invalid_path', 'daily.d.name', 4]])
  assert.deepEqual(errors('daily:\n  d:\n    folder: D\n    template: .t/x\n'), [['invalid_path', 'daily.d.template', 4]])
})

test('thoth.yaml: series patterns must name exactly one note per period', () => {
  assert.deepEqual(errors('daily:\n  d:\n    folder: D\n    name: "{MM}-{DD}"\n'), [['pattern_period', 'daily.d.name', 4]])
  assert.deepEqual(errors('daily:\n  d:\n    folder: D\n    name: "{YYYY}-W{WW}"\n'), [['pattern_period', 'daily.d.name', 4]])
  assert.deepEqual(errors('daily:\n  d:\n    folder: D\n    name: "{YYYY}-{mm}-{DD}"\n'), [['pattern_token', 'daily.d.name', 4]], 'no period error on top of it')
  assert.deepEqual(errors('daily:\n  "mi diario":\n    folder: D\n'), [['invalid_id', 'daily.mi diario', 2]])
  assert.deepEqual(errors('daily:\n  d: Diario\n'), [['not_a_map', 'daily.d', 2]])
})

test('thoth.yaml: every error is reported at once', () => {
  assert.deepEqual(errors('templtes: x\ntemplates: ../x\ndaily:\n  d:\n    folder: D\n    name: "{MM}"\n'), [
    ['unknown_key', 'templtes', 1],
    ['invalid_path', 'templates', 2],
    ['pattern_period', 'daily.d.name', 6],
  ])
})

test('thoth.yaml: attachments modes', () => {
  const att = (text: string) => {
    const r = parseWorkspaceConfig(text)
    assert.ok(r.ok, JSON.stringify(r))
    return r.config.attachments
  }
  assert.deepEqual(att('attachments:\n  mode: next-to-note\n'), { folder: null })
  assert.deepEqual(att('attachments:\n  mode: folder\n  folder: Media/\n'), { folder: 'Media' })
  assert.deepEqual(att('attachments:\n  folder: Media\n'), { folder: 'Media' }, 'a folder alone implies the mode')
  assert.deepEqual(att('attachments:\n  mode: per-note\n'), { folder: null, perNote: '.assets' })
  assert.deepEqual(att('attachments:\n  mode: per-note\n  suffix: _files\n'), { folder: null, perNote: '_files' })

  assert.deepEqual(errors('attachments:\n  mode: per_note\n'), [['invalid_value', 'attachments.mode', 2]])
  assert.deepEqual(errors('attachments:\n  mode: folder\n'), [['invalid_value', 'attachments.mode', 2]], 'folder mode needs a folder')
  assert.deepEqual(errors('attachments:\n  mode: per-note\n  folder: Media\n'), [['invalid_value', 'attachments.folder', 3]], 'a key of another mode')
  assert.deepEqual(errors('attachments:\n  suffix: .assets\n'), [['invalid_value', 'attachments.suffix', 2]])
  for (const bad of ['a/b', '.md', '', ' x']) {
    assert.deepEqual(errors(`attachments:\n  mode: per-note\n  suffix: "${bad}"\n`), [['invalid_path', 'attachments.suffix', 3]], bad)
  }
})
