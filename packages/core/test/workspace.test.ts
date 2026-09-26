import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_WORKSPACE, parseWorkspaceConfig, type ConfigError, type StrictSection } from '@thoth/core'

const errors = (text: string) => {
  const r = parseWorkspaceConfig(text)
  assert.ok(!r.ok, 'should be invalid')
  return r.errors.map((e: ConfigError) => [e.code, e.at, e.line] as const)
}
const brief = (list: ConfigError[]) => list.map((e) => [e.code, e.at, e.line] as const)
/** Parses a valid file and returns what it left out. */
const warnings = (text: string, strict?: readonly StrictSection[]) => {
  const r = parseWorkspaceConfig(text, strict)
  assert.ok(r.ok, `should be usable: ${JSON.stringify(!r.ok && r.errors)}`)
  return brief(r.warnings)
}

test('thoth.yaml: empty or just comments is valid and turns nothing on', () => {
  for (const text of ['', '# nothing yet\n', '---\n']) assert.deepEqual(parseWorkspaceConfig(text), { ok: true, config: EMPTY_WORKSPACE, warnings: [], sections: { permissions: null } })
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

test('thoth.yaml: links.aliases turns alias resolution off; on by default', () => {
  assert.equal(EMPTY_WORKSPACE.links.aliases, true)
  const off = parseWorkspaceConfig('links:\n  aliases: false\n')
  assert.ok(off.ok)
  assert.deepEqual(off.config.links, { aliases: false })
  const on = parseWorkspaceConfig('links:\n  aliases: true\n')
  assert.ok(on.ok && on.config.links.aliases)
  assert.deepEqual(errors('links:\n  aliases: "no"\n'), [['not_boolean', 'links.aliases', 2]])
  assert.deepEqual(errors('links: false\n'), [['not_a_map', 'links', 1]])
  assert.deepEqual(warnings('links:\n  alias: false\n'), [['unknown_key', 'links.alias', 2]])
})

test('thoth.yaml: history is managed with a 20 MB limit unless it says otherwise', () => {
  assert.deepEqual(EMPTY_WORKSPACE.history, { mode: 'managed', maxFileSize: 20, exclude: [] })
  const r = parseWorkspaceConfig('history:\n  mode: off\n  maxFileSize: 2.5\n')
  assert.ok(r.ok)
  assert.deepEqual(r.config.history, { mode: 'off', maxFileSize: 2.5, exclude: [] })
  const only = parseWorkspaceConfig('history:\n  mode: unmanaged\n')
  assert.ok(only.ok)
  assert.deepEqual(only.config.history, { mode: 'unmanaged', maxFileSize: 20, exclude: [] })
  assert.deepEqual(errors('history:\n  mode: git\n'), [['invalid_value', 'history.mode', 2]])
  assert.deepEqual(errors('history:\n  maxFileSize: 0\n'), [['invalid_value', 'history.maxFileSize', 2]])
  assert.deepEqual(errors('history:\n  maxFileSize: "20 MB"\n'), [['invalid_value', 'history.maxFileSize', 2]])
  assert.deepEqual(errors('history: off\n'), [['not_a_map', 'history', 1]])
  assert.deepEqual(warnings('history:\n  retention: forever\n'), [['unknown_key', 'history.retention', 2]])
})

test('thoth.yaml: mcp.instructions names a note of the workspace, none by default', () => {
  assert.deepEqual(EMPTY_WORKSPACE.mcp, { instructions: null })
  const r = parseWorkspaceConfig('mcp:\n  instructions: Agentes/Instrucciones\n')
  assert.ok(r.ok)
  assert.deepEqual(r.config.mcp, { instructions: 'Agentes/Instrucciones.md' })
  const md = parseWorkspaceConfig('mcp:\n  instructions: Guía.md\n')
  assert.ok(md.ok && md.config.mcp.instructions === 'Guía.md')
  assert.deepEqual(errors('mcp:\n  instructions: ../fuera\n'), [['invalid_path', 'mcp.instructions', 2]])
  assert.deepEqual(errors('mcp:\n  instructions: .ocultas/guia\n'), [['invalid_path', 'mcp.instructions', 2]])
  assert.deepEqual(errors('mcp:\n  instructions: [a]\n'), [['invalid_type', 'mcp.instructions', 2]])
  assert.deepEqual(errors('mcp: yes\n'), [['not_a_map', 'mcp', 1]])
  assert.deepEqual(warnings('mcp:\n  instruction: x\n'), [['unknown_key', 'mcp.instruction', 2]])
})

test('thoth.yaml: history.exclude is a list of path patterns; a bad one is an error on its own line', () => {
  const r = parseWorkspaceConfig('history:\n  exclude:\n    - biblioteca/**\n    - "**/*.pdf"\n    - borradores/secreto.md\n')
  assert.ok(r.ok)
  assert.deepEqual(r.config.history.exclude, ['biblioteca/**', '**/*.pdf', 'borradores/secreto.md'])
  const one = parseWorkspaceConfig('history:\n  exclude: Archivo/\n')
  assert.ok(one.ok)
  assert.deepEqual(one.config.history.exclude, ['Archivo/'], 'one pattern alone is a list of one')
  assert.deepEqual(errors('history:\n  exclude:\n    - ok/**\n    - /etc/**\n    - "a/../b"\n'), [
    ['invalid_pattern', 'history.exclude.1', 4],
    ['invalid_pattern', 'history.exclude.2', 5],
  ])
  const bad = parseWorkspaceConfig('history:\n  exclude:\n    - "*.{pdf,epub}"\n')
  assert.ok(!bad.ok)
  assert.deepEqual(bad.errors[0], { code: 'invalid_pattern', at: 'history.exclude.0', line: 3, detail: '*.{pdf,epub}' })
  assert.deepEqual(errors('history:\n  exclude: /secret\n'), [['invalid_pattern', 'history.exclude', 2]])
  assert.deepEqual(errors('history:\n  exclude:\n    - 3\n'), [['invalid_type', 'history.exclude.0', 3]])
  assert.deepEqual(errors('history:\n  exclude:\n    a: b\n'), [['invalid_type', 'history.exclude', 2]])
})

test('thoth.yaml: YAML errors carry their line', () => {
  assert.deepEqual(errors('daily:\n  diario:\n    folder: [unclosed\n'), [['yaml', null, 4]])
  assert.deepEqual(errors('templates: a\ntemplates: b\n'), [['yaml', null, 2]], 'duplicate keys')
  assert.deepEqual(errors('- a\n- b\n'), [['not_a_map', null, 1]])
})

test('thoth.yaml: unknown keys are reported and ignored; the rest applies', () => {
  const r = parseWorkspaceConfig('templtes: Plantillas\ntemplates: P\nattachments:\n  fodler: x\n  folder: A\ndaily:\n  d:\n    folder: D\n    fromat: x\n')
  assert.ok(r.ok)
  assert.deepEqual(brief(r.warnings), [['unknown_key', 'templtes', 1], ['unknown_key', 'attachments.fodler', 4], ['unknown_key', 'daily.d.fromat', 9]])
  assert.equal(r.config.templates, 'P')
  assert.deepEqual(r.config.attachments, { folder: 'A' })
  assert.deepEqual(r.config.daily.map((s) => s.folder), ['D'])
})

test('thoth.yaml: version is optional; a newer one warns and applies what is understood', () => {
  assert.deepEqual(warnings('version: 1\ntemplates: P\n'), [])
  const r = parseWorkspaceConfig('version: 2\ntemplates: P\nnewer_feature: true\n')
  assert.ok(r.ok)
  assert.deepEqual(brief(r.warnings), [['newer_version', 'version', 1], ['unknown_key', 'newer_feature', 3]])
  assert.equal(r.warnings[0]!.detail, '2')
  assert.equal(r.config.templates, 'P')
  for (const bad of ['0', '-1', '1.5', 'dos', '"1"']) assert.deepEqual(errors(`version: ${bad}\n`), [['invalid_version', 'version', 1]], bad)
})

test('thoth.yaml: a wrong value in a known key still makes the file unusable', () => {
  const r = parseWorkspaceConfig('unknown: 1\ntemplates: ../fuera\n')
  assert.ok(!r.ok)
  assert.deepEqual(brief(r.errors), [['invalid_path', 'templates', 2]])
  assert.deepEqual(brief(r.warnings), [['unknown_key', 'unknown', 1]])
})

test('thoth.yaml: permissions is not applied until it exists, and never blocks the rest', () => {
  const r = parseWorkspaceConfig('templates: P\npermissions:\n  Privado: {noa: edit}\n')
  assert.ok(r.ok)
  assert.deepEqual(brief(r.warnings), [['not_supported', 'permissions', 2]])
  assert.equal(r.sections.permissions, null)
  assert.equal(r.config.templates, 'P')
})

// A stand-in for a security section (M4's permissions): strict, failing closed.
const FAKE: StrictSection<{ shared: string[] }> = {
  key: 'sharing',
  closed: { shared: [] },
  parse(raw, at, report) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { report('not_a_map', at); return { shared: [] } }
    const out: string[] = []
    for (const [k, v] of Object.entries(raw)) {
      if (k !== 'shared') report('unknown_key', [...at, k])
      else if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) report('invalid_type', [...at, k], 'list')
      else out.push(...v)
    }
    return { shared: out }
  },
}

test('thoth.yaml: a strict section with any doubt is rejected alone and fails closed', () => {
  const good = parseWorkspaceConfig('templates: P\nsharing:\n  shared: [Público]\n', [FAKE])
  assert.ok(good.ok)
  assert.deepEqual(good.sections, { sharing: { shared: ['Público'] } })
  assert.deepEqual(good.warnings, [])

  // A typo inside the strict section is not ignored like elsewhere: the whole section goes.
  const typo = parseWorkspaceConfig('templates: P\nsharing:\n  shared: [Público]\n  sahred: [Privado]\n', [FAKE])
  assert.ok(typo.ok, 'the rest of the file still applies')
  assert.equal(typo.config.templates, 'P')
  assert.deepEqual(typo.sections, { sharing: { shared: [] } }, 'the most restrictive setting, not the half that parsed')
  assert.deepEqual(brief(typo.warnings), [['section_rejected', 'sharing', 2], ['unknown_key', 'sharing.sahred', 4]])

  const wrong = parseWorkspaceConfig('sharing: todo\n', [FAKE])
  assert.ok(wrong.ok)
  assert.deepEqual(wrong.sections, { sharing: { shared: [] } })
  assert.deepEqual(brief(wrong.warnings), [['not_a_map', 'sharing', 1], ['section_rejected', 'sharing', 1]])

  const missing = parseWorkspaceConfig('templates: P\n', [FAKE])
  assert.ok(missing.ok)
  assert.deepEqual(missing.sections, { sharing: { shared: [] } }, 'missing: closed too')
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

  assert.deepEqual(warnings('attachments:\n  mode: per-note\n  sufix: _files\n'), [['unknown_key', 'attachments.sufix', 3]], 'a typo is ignored like elsewhere')
  assert.deepEqual(errors('attachments:\n  mode: per_note\n'), [['invalid_value', 'attachments.mode', 2]], 'a wrong value in a known key is not')
  assert.deepEqual(errors('attachments:\n  mode: folder\n'), [['invalid_value', 'attachments.mode', 2]], 'folder mode needs a folder')
  assert.deepEqual(errors('attachments:\n  mode: per-note\n  folder: Media\n'), [['invalid_value', 'attachments.folder', 3]], 'a key of another mode')
  assert.deepEqual(errors('attachments:\n  suffix: .assets\n'), [['invalid_value', 'attachments.suffix', 2]])
  for (const bad of ['a/b', '.md', '', ' x']) {
    assert.deepEqual(errors(`attachments:\n  mode: per-note\n  suffix: "${bad}"\n`), [['invalid_path', 'attachments.suffix', 3]], bad)
  }
})
