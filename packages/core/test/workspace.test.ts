import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_WORKSPACE, parseWorkspaceConfig, type ConfigError, type StrictSection } from '@vihko/core'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const USER = m.aUsername()

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

test('vihko.yaml: empty or just comments is valid and turns nothing on', () => {
  for (const text of ['', '# nothing yet\n', '---\n']) assert.deepEqual(parseWorkspaceConfig(text), { ok: true, config: EMPTY_WORKSPACE, warnings: [], sections: { permissions: { kind: 'none' } } })
})

test('vihko.yaml: series and attachments', () => {
  const r = parseWorkspaceConfig(`# Workspace settings
version: 1
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
  assert.deepEqual(r.config.attachments, { folder: 'Adjuntos' })
  assert.deepEqual(r.config.daily, [
    { id: 'diario', label: 'Mi diario', folder: 'Diario/{user}', name: '{YYYY}-{MM}-{DD}', template: 'Plantillas/Diario.md', period: 'day' },
    { id: 'equipo', label: null, folder: 'Equipo', name: '{YYYY}-{MM}-{DD} reunión', template: null, period: 'day' },
    { id: 'semanas', label: null, folder: 'Semanas', name: '{GGGG}-W{WW}', template: null, period: 'week' },
  ])
})

test('vihko.yaml: templates are no longer folders: an old templates key is an unknown one, the rest applies', () => {
  const own = `people/{user}/${m.aFolder()}`
  const r = parseWorkspaceConfig(`templates:\n  - ${JSON.stringify(own)}\nattachments:\n  folder: A\n`)
  assert.ok(r.ok)
  assert.deepEqual(brief(r.warnings), [['unknown_key', 'templates', 1]])
  assert.ok(!('templates' in r.config))
  assert.deepEqual(r.config.attachments, { folder: 'A' })
})

test('vihko.yaml: links.aliases turns alias resolution off; on by default', () => {
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

test('vihko.yaml: history is managed with a 20 MB limit unless it says otherwise', () => {
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

test('vihko.yaml: mcp.instructions names a note of the workspace, none by default', () => {
  assert.deepEqual(EMPTY_WORKSPACE.mcp, { instructions: null, clientDomains: [] })
  const r = parseWorkspaceConfig('mcp:\n  instructions: Agentes/Instrucciones\n')
  assert.ok(r.ok)
  assert.deepEqual(r.config.mcp, { instructions: 'Agentes/Instrucciones.md', clientDomains: [] })
  const md = parseWorkspaceConfig('mcp:\n  instructions: Guía.md\n')
  assert.ok(md.ok && md.config.mcp.instructions === 'Guía.md')
  assert.deepEqual(errors('mcp:\n  instructions: ../fuera\n'), [['invalid_path', 'mcp.instructions', 2]])
  assert.deepEqual(errors('mcp:\n  instructions: .ocultas/guia\n'), [['invalid_path', 'mcp.instructions', 2]])
  assert.deepEqual(errors('mcp:\n  instructions: [a]\n'), [['invalid_type', 'mcp.instructions', 2]])
  assert.deepEqual(errors('mcp: yes\n'), [['not_a_map', 'mcp', 1]])
  assert.deepEqual(warnings('mcp:\n  instruction: x\n'), [['unknown_key', 'mcp.instruction', 2]])
})

test('vihko.yaml: history.exclude is a list of path patterns; a bad one is an error on its own line', () => {
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

test('vihko.yaml: YAML errors carry their line', () => {
  assert.deepEqual(errors('daily:\n  diario:\n    folder: [unclosed\n'), [['yaml', null, 4]])
  assert.deepEqual(errors('daily: a\ndaily: b\n'), [['yaml', null, 2]], 'duplicate keys')
  assert.deepEqual(errors('- a\n- b\n'), [['not_a_map', null, 1]])
})

test('vihko.yaml: an alias bomb is a YAML error, never an exception', () => {
  // A few lines whose aliases expand to millions of values: the case under test.
  const bomb = ['a: &a [x, x, x, x, x, x, x, x, x]', ...'bcdef'.split('').map((k, i) =>
    `${k}: &${k} [${Array(9).fill(`*${'abcdef'[i]}`).join(', ')}]`)].join('\n')
  for (const text of [`${bomb}\n`, `permissions:\n  ${bomb.replaceAll('\n', '\n  ')}\n`]) {
    const r = parseWorkspaceConfig(text)
    assert.ok(!r.ok, 'should be invalid')
    assert.deepEqual(r.errors.map((e) => e.code), ['yaml'])
    assert.equal(r.sections, undefined, 'no section applies: the permissions fail closed')
  }
})

test('vihko.yaml: unknown keys are reported and ignored; the rest applies', () => {
  const r = parseWorkspaceConfig('atachments: Plantillas\nlinks:\n  aliases: false\nattachments:\n  fodler: x\n  folder: A\ndaily:\n  d:\n    folder: D\n    fromat: x\n')
  assert.ok(r.ok)
  assert.deepEqual(brief(r.warnings), [['unknown_key', 'atachments', 1], ['unknown_key', 'attachments.fodler', 5], ['unknown_key', 'daily.d.fromat', 10]])
  assert.deepEqual(r.config.links, { aliases: false })
  assert.deepEqual(r.config.attachments, { folder: 'A' })
  assert.deepEqual(r.config.daily.map((s) => s.folder), ['D'])
})

test('vihko.yaml: version is optional; a newer one warns and applies what is understood', () => {
  assert.deepEqual(warnings('version: 1\nattachments:\n  folder: P\n'), [])
  const r = parseWorkspaceConfig('version: 2\nattachments:\n  folder: P\nnewer_feature: true\n')
  assert.ok(r.ok)
  assert.deepEqual(brief(r.warnings), [['newer_version', 'version', 1], ['unknown_key', 'newer_feature', 4]])
  assert.equal(r.warnings[0]!.detail, '2')
  assert.deepEqual(r.config.attachments, { folder: 'P' })
  for (const bad of ['0', '-1', '1.5', 'dos', '"1"']) assert.deepEqual(errors(`version: ${bad}\n`), [['invalid_version', 'version', 1]], bad)
})

test('vihko.yaml: a wrong value in a known key still makes the file unusable', () => {
  const r = parseWorkspaceConfig('unknown: 1\nattachments:\n  folder: ../fuera\n')
  assert.ok(!r.ok)
  assert.deepEqual(brief(r.errors), [['invalid_path', 'attachments.folder', 3]])
  assert.deepEqual(brief(r.warnings), [['unknown_key', 'unknown', 1]])
})

test('vihko.yaml: permissions is a strict section: rejected, nothing is shared; missing, none', () => {
  // A folder of someone's personal space: keys are real paths inside a space.
  const folder = `people/${m.aUsername()}/${m.aFolder()}`
  const r = parseWorkspaceConfig(`attachments: { folder: P }\npermissions:\n  ${JSON.stringify(folder)}: {grants: {${USER}: edit}}\n`)
  assert.ok(r.ok)
  assert.deepEqual(r.warnings, [])
  assert.deepEqual(r.sections.permissions, { kind: 'rules', rules: [{ folder, grants: { [USER]: 'edit' }, ai: null }] })
  const bad = parseWorkspaceConfig(`attachments: { folder: P }\npermissions:\n  ${JSON.stringify(folder)}: {${USER}: edit}\n`)
  assert.ok(bad.ok, 'never blocks the rest')
  assert.deepEqual(bad.config.attachments, { folder: 'P' })
  assert.deepEqual(bad.sections.permissions, { kind: 'closed' })
  assert.deepEqual(brief(bad.warnings), [['section_rejected', 'permissions', 2], ['unknown_key', `permissions.${folder}.${USER}`, 3]])
  // A folder in no space rejects it too.
  const outside = parseWorkspaceConfig(`attachments: { folder: P }\npermissions:\n  ${JSON.stringify(m.aFolder())}: {grants: {${USER}: edit}}\n`)
  assert.ok(outside.ok)
  assert.deepEqual(outside.sections.permissions, { kind: 'closed' })
  const none = parseWorkspaceConfig('attachments: { folder: P }\n')
  assert.ok(none.ok)
  assert.deepEqual(none.sections.permissions, { kind: 'none' })
})

// A stand-in for a security section (M4's permissions): strict, failing closed.
const FAKE: StrictSection<{ shared: string[] }> = {
  key: 'sharing',
  closed: { shared: [] },
  parse(raw, at, report, _notice) {
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

test('vihko.yaml: a strict section with any doubt is rejected alone and fails closed', () => {
  const good = parseWorkspaceConfig('attachments: { folder: P }\nsharing:\n  shared: [Público]\n', [FAKE])
  assert.ok(good.ok)
  assert.deepEqual(good.sections, { sharing: { shared: ['Público'] } })
  assert.deepEqual(good.warnings, [])

  // A typo inside the strict section is not ignored like elsewhere: the whole section goes.
  const typo = parseWorkspaceConfig('attachments: { folder: P }\nsharing:\n  shared: [Público]\n  sahred: [Privado]\n', [FAKE])
  assert.ok(typo.ok, 'the rest of the file still applies')
  assert.deepEqual(typo.config.attachments, { folder: 'P' })
  assert.deepEqual(typo.sections, { sharing: { shared: [] } }, 'the most restrictive setting, not the half that parsed')
  assert.deepEqual(brief(typo.warnings), [['section_rejected', 'sharing', 2], ['unknown_key', 'sharing.sahred', 4]])

  const wrong = parseWorkspaceConfig('sharing: todo\n', [FAKE])
  assert.ok(wrong.ok)
  assert.deepEqual(wrong.sections, { sharing: { shared: [] } })
  assert.deepEqual(brief(wrong.warnings), [['not_a_map', 'sharing', 1], ['section_rejected', 'sharing', 1]])

  const missing = parseWorkspaceConfig('attachments: { folder: P }\n', [FAKE])
  assert.ok(missing.ok)
  assert.deepEqual(missing.sections, { sharing: { shared: [] } }, 'missing: closed too')
})

test('vihko.yaml: paths stay inside the notes folder and out of hidden folders', () => {
  for (const bad of ['../fuera', '/abs', '.oculta', 'a/../b', 'a//b', 'a/./b']) {
    assert.deepEqual(errors(`attachments:\n  folder: "${bad}"\n`), [['invalid_path', 'attachments.folder', 2]], bad)
  }
  assert.deepEqual(errors('attachments:\n  folder: 3\n'), [['invalid_type', 'attachments.folder', 2]])
  assert.deepEqual(errors('daily:\n  d:\n    folder: ../D\n'), [['invalid_path', 'daily.d.folder', 3]])
  assert.deepEqual(errors('daily:\n  d:\n    folder: D\n    name: "{YYYY}/{MM}-{DD}"\n'), [['invalid_path', 'daily.d.name', 4]])
  assert.deepEqual(errors('daily:\n  d:\n    folder: D\n    template: .t/x\n'), [['invalid_path', 'daily.d.template', 4]])
})

test('vihko.yaml: series patterns must name exactly one note per period', () => {
  assert.deepEqual(errors('daily:\n  d:\n    folder: D\n    name: "{MM}-{DD}"\n'), [['pattern_period', 'daily.d.name', 4]])
  assert.deepEqual(errors('daily:\n  d:\n    folder: D\n    name: "{YYYY}-W{WW}"\n'), [['pattern_period', 'daily.d.name', 4]])
  assert.deepEqual(errors('daily:\n  d:\n    folder: D\n    name: "{YYYY}-{mm}-{DD}"\n'), [['pattern_token', 'daily.d.name', 4]], 'no period error on top of it')
  assert.deepEqual(errors('daily:\n  "mi diario":\n    folder: D\n'), [['invalid_id', 'daily.mi diario', 2]])
  assert.deepEqual(errors('daily:\n  d: Diario\n'), [['not_a_map', 'daily.d', 2]])
})

test('vihko.yaml: every error is reported at once', () => {
  assert.deepEqual(errors('atachments: x\nattachments:\n  folder: ../x\ndaily:\n  d:\n    folder: D\n    name: "{MM}"\n'), [
    ['invalid_path', 'attachments.folder', 3],
    ['pattern_period', 'daily.d.name', 7],
  ])
})

test('vihko.yaml: attachments modes', () => {
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

test('vihko.yaml: mcp.client_domains lists the domains OAuth apps may come from; none (any) by default', () => {
  const [a, b] = [m.aHost(), m.aHost()]
  const r = parseWorkspaceConfig(`mcp:\n  client_domains: [${a.toUpperCase()}, "*.${b}", ${a}]\n`)
  assert.ok(r.ok)
  assert.deepEqual(r.config.mcp.clientDomains, [a, b], 'lower case, a leading *. dropped, each once')
  const one = parseWorkspaceConfig(`mcp:\n  client_domains: ${a}\n`)
  assert.ok(one.ok && one.config.mcp.clientDomains.join() === a)
  // Literals: the wrong values are the case under test.
  assert.deepEqual(errors('mcp:\n  client_domains: ["https://claude.ai/x"]\n'), [['invalid_value', 'mcp.client_domains', 2]])
  assert.deepEqual(errors('mcp:\n  client_domains: { a: 1 }\n'), [['invalid_type', 'mcp.client_domains', 2]])
})
