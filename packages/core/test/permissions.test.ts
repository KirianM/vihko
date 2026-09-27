import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PermissionsFileError, RuleSet, grantsAt, levelIn, moveRules, parseWorkspaceConfig, removeRules, rewriteSubject, setRule,
  type ConfigError, type Level, type PermissionRule,
} from '@thoth/core'

const brief = (list: ConfigError[]) => list.map((e) => [e.code, e.at, e.line] as const)
const rulesOf = (text: string): PermissionRule[] => {
  const r = parseWorkspaceConfig(text)
  assert.ok(r.ok)
  const p = r.sections.permissions as { kind: string; rules?: PermissionRule[] }
  assert.equal(p.kind, 'rules', JSON.stringify(r.warnings))
  return p.rules!
}
const rejected = (text: string) => {
  const r = parseWorkspaceConfig(text)
  assert.ok(r.ok)
  assert.deepEqual(r.sections.permissions, { kind: 'closed' })
  return brief(r.warnings)
}

const SPEC = `permissions:
  "":                         # the root
    grants: { noa: manage }
  familia:
    grants: { "@familia": edit, noa: edit }
  "personas/{user}":
    grants: { "{user}": manage }
  personas/laura/diario:
    ai: false
`

test('permissions: the rules as written, levels and subjects checked', () => {
  assert.deepEqual(rulesOf(SPEC), [
    { folder: '', grants: { noa: 'manage' }, ai: null },
    { folder: 'familia', grants: { '@familia': 'edit', noa: 'edit' }, ai: null },
    { folder: 'personas/{user}', grants: { '{user}': 'manage' }, ai: null },
    { folder: 'personas/laura/diario', grants: null, ai: false },
  ])
  // Own grants that are empty close the folder; no grants inherit.
  assert.deepEqual(rulesOf('permissions:\n  a: {grants: {}}\n  b: {}\n'), [{ folder: 'a', grants: {}, ai: null }, { folder: 'b', grants: null, ai: null }])
})

test('permissions: any doubt rejects the whole section (nobody reads), with where', () => {
  assert.deepEqual(rejected('permissions:\n  a: {grants: {noa: admin}}\n'), [['section_rejected', 'permissions', 1], ['invalid_value', 'permissions.a.grants.noa', 2]])
  assert.deepEqual(rejected('permissions:\n  a: {grants: {"{user}": read}}\n'), [['section_rejected', 'permissions', 1], ['invalid_value', 'permissions.a.grants.{user}', 2]])
  assert.deepEqual(rejected('permissions:\n  a: {grant: {noa: read}}\n'), [['section_rejected', 'permissions', 1], ['unknown_key', 'permissions.a.grant', 2]])
  assert.deepEqual(rejected('permissions:\n  ../fuera: {grants: {}}\n'), [['section_rejected', 'permissions', 1], ['invalid_path', 'permissions.../fuera', 2]])
  assert.deepEqual(rejected('permissions:\n  "{user}/{user}": {grants: {}}\n'), [['section_rejected', 'permissions', 1], ['invalid_path', 'permissions.{user}/{user}', 2]])
  assert.deepEqual(rejected('permissions:\n  "a/{users}": {grants: {}}\n'), [['section_rejected', 'permissions', 1], ['invalid_path', 'permissions.a/{users}', 2]])
  assert.deepEqual(rejected('permissions:\n  a: {ai: "no"}\n'), [['section_rejected', 'permissions', 1], ['not_boolean', 'permissions.a.ai', 2]])
  assert.deepEqual(rejected('permissions:\n  a: {grants: {"bad name!": read}}\n'), [['section_rejected', 'permissions', 1], ['invalid_value', 'permissions.a.grants.bad name!', 2]])
  assert.deepEqual(rejected('permissions:\n  a: {grants: {Noa: read, noa: edit}}\n'), [['section_rejected', 'permissions', 1], ['invalid_value', 'permissions.a.grants.noa', 2]])
  assert.deepEqual(rejected('permissions: [a]\n'), [['not_a_map', 'permissions', 1], ['section_rejected', 'permissions', 1]])
  assert.deepEqual(rejected('permissions:\n  a: todo\n'), [['section_rejected', 'permissions', 1], ['not_a_map', 'permissions.a', 2]])
  // Written twice once normalized (NFC and NFD of the same name).
  assert.deepEqual(rejected('permissions:\n  "Café": {grants: {}}\n  "Café": {grants: {}}\n')[0], ['section_rejected', 'permissions', 1])
})

test('permissions: ai: true only closes nothing; ignored with a notice, the section still applies', () => {
  const r = parseWorkspaceConfig('permissions:\n  a: {ai: false}\n  a/b: {ai: true}\n')
  assert.ok(r.ok)
  assert.deepEqual(r.sections.permissions, { kind: 'rules', rules: [{ folder: 'a', grants: null, ai: false }, { folder: 'a/b', grants: null, ai: null }] })
  assert.deepEqual(brief(r.warnings), [['ignored_value', 'permissions.a/b.ai', 3]])
})

test('permissions: which rule governs a folder, most specific first', () => {
  const set = new RuleSet(rulesOf(SPEC))
  const users = new Set(['noa', 'laura', 'marta'])
  const exists = (u: string) => users.has(u)
  const level = (folder: string, username: string, groups: string[] = []): Level | null => {
    const g = set.governing(folder)
    return g ? levelIn(grantsAt(g, exists), { username, groups }) : null
  }
  assert.equal(level('', 'noa'), 'manage')
  assert.equal(level('otra/cosa', 'noa'), 'manage', 'inherited from the root')
  assert.equal(level('otra', 'laura'), null)
  assert.equal(level('familia/recetas', 'laura', ['familia']), 'edit', 'through a group')
  assert.equal(level('familia', 'noa'), 'edit', 'own grants replace the root\'s manage')
  assert.equal(level('personas', 'noa'), 'manage', 'the folder above a {user} rule inherits')
  assert.equal(level('personas/laura', 'laura'), 'manage')
  assert.equal(level('personas/laura/diario', 'laura'), 'manage', 'ai alone doesn\'t change the grants')
  assert.equal(level('personas/laura', 'noa'), null, 'the admin doesn\'t read what isn\'t granted')
  assert.equal(level('personas/antigua', 'noa'), null, 'named like nobody: nobody')
  assert.equal(level('personas/antigua/sub', 'antigua'), null)
  assert.deepEqual(set.governing('personas/laura/diario/x'), { rule: rulesOf(SPEC)[2], user: 'laura', at: 'personas/laura' })
  assert.equal(set.aiClosedAt('personas/laura/diario/2026'), 'personas/laura/diario')
  assert.equal(set.aiClosedAt('personas/laura'), null)
  // A literal rule at the same depth wins over the {user} one.
  const lit = new RuleSet(rulesOf(SPEC + '  personas/laura/recetas:\n    grants: { laura: manage, noa: comment }\n  personas/marta:\n    grants: { marta: read }\n'))
  assert.equal(levelIn(grantsAt(lit.governing('personas/laura/recetas')!, exists), { username: 'noa', groups: [] }), 'comment')
  assert.equal(levelIn(grantsAt(lit.governing('personas/marta')!, exists), { username: 'marta', groups: [] }), 'read')
  // A literal rule without grants (only `ai: false`) over a {user} one keeps that one's grants: never the root's.
  const closed = new RuleSet(rulesOf(SPEC + '  personas/laura:\n    ai: false\n'))
  const at = (folder: string, username: string) => levelIn(grantsAt(closed.governing(folder)!, exists), { username, groups: [] })
  assert.equal(at('personas/laura', 'laura'), 'manage')
  assert.equal(at('personas/laura', 'noa'), null, 'the root\'s manager gains nothing')
  assert.equal(at('personas/laura/recetas', 'noa'), null)
  assert.equal(closed.aiClosedAt('personas/laura/recetas'), 'personas/laura')
  assert.equal(closed.own('personas/laura')?.user, null, 'its own rule is the literal one')
  assert.equal(closed.userRule('personas/laura')?.user, 'laura')
  // And ai: false on the {user} rule closes every personal folder.
  assert.equal(new RuleSet(rulesOf(SPEC.replace('{ "{user}": manage }', '{ "{user}": manage }\n    ai: false'))).aiClosedAt('personas/marta/x'), 'personas/marta')
  // Names compare without case, as state.db does.
  assert.equal(levelIn({ Noa: 'read', '@Familia': 'edit' }, { username: 'noa', groups: ['familia'] }), 'edit')
})

test('permissions file: one entry changes, comments, order and the rest of the file stay', () => {
  const text = `# Workspace
templates: Plantillas   # templates here

permissions:
  # the root
  "":
    grants: { noa: manage }
  familia:   # shared
    grants: { "@familia": edit }
daily:
  diario:
    folder: Diario/{user}
`
  const out = setRule(text, 'familia', { grants: { '@familia': 'edit', laura: 'read' }, ai: null })
  assert.equal(out, text.replace('grants: { "@familia": edit }', 'grants: { "@familia": edit, laura: read }'))
  // A comment on a line written again stays, with its line; one on its own line too.
  const commented = text.replace('grants: { "@familia": edit }', '# who\n    grants: { "@familia": edit }  # the family edits')
  assert.equal(setRule(commented, 'familia', { grants: { '@familia': 'read' }, ai: null }), commented.replace('"@familia": edit }', '"@familia": read }'))
  const added = setRule(text, 'personas/laura/recetas', { grants: { laura: 'manage', noa: 'comment' }, ai: null })
  assert.match(added, /familia:   # shared\n {4}grants: \{ "@familia": edit \}\n {2}personas\/laura\/recetas:\n {4}grants: \{ laura: manage, noa: comment \}\ndaily:/)
  assert.ok(added.startsWith('# Workspace\ntemplates: Plantillas   # templates here\n'))
  const closed = setRule(text, 'familia', { grants: { '@familia': 'edit' }, ai: false })
  assert.deepEqual(rulesOf(closed)[1], { folder: 'familia', grants: { '@familia': 'edit' }, ai: false })
  const gone = setRule(text, 'familia', { grants: null, ai: null })
  assert.deepEqual(rulesOf(gone).map((r) => r.folder), [''])
  assert.match(gone, /# Workspace/)
  // No file, or none of it about permissions: the implicit section is written first.
  const fresh = setRule('templates: P\n', 'familia', { grants: { laura: 'edit' }, ai: null }, { implicitAdmins: ['noa'] })
  assert.deepEqual(rulesOf(fresh), [{ folder: '', grants: { noa: 'manage' }, ai: null }, { folder: 'familia', grants: { laura: 'edit' }, ai: null }])
  assert.deepEqual(rulesOf(setRule('', '', { grants: { laura: 'read' }, ai: null }, { implicitAdmins: ['noa'] })), [{ folder: '', grants: { laura: 'read' }, ai: null }])
  assert.throws(() => setRule('a: [\n', 'x', { grants: {}, ai: null }), PermissionsFileError)
})

test('permissions file: moving a folder moves its rules and those under it; deleting removes them', () => {
  const text = 'permissions:\n  "": {grants: {noa: manage}}\n  a/b: {grants: {laura: edit}}\n  a/b/c: {ai: false}\n  a/bc: {grants: {}}\n'
  const moved = moveRules(text, 'a/b', 'x/y')
  assert.deepEqual(rulesOf(moved).map((r) => r.folder), ['', 'a/bc', 'x/y', 'x/y/c'])
  assert.deepEqual(rulesOf(moved)[2], { folder: 'x/y', grants: { laura: 'edit' }, ai: null })
  const both = moveRules(text, 'a/b', 'x/y', { keepFrom: true, extra: [{ folder: 'x/y/z', grants: { laura: 'manage' }, ai: null }] })
  assert.deepEqual(rulesOf(both).map((r) => r.folder), ['', 'a/b', 'a/b/c', 'a/bc', 'x/y', 'x/y/c', 'x/y/z'])
  assert.deepEqual(rulesOf(removeRules(text, 'a/b')).map((r) => r.folder), ['', 'a/bc'])
})

test('permissions file: a subject is removed or renamed everywhere; an emptied rule stays closed', () => {
  const text = 'permissions:\n  "": {grants: {noa: manage, "@familia": read}}\n  personas/marta: {grants: {Marta: manage}}\n'
  assert.deepEqual(rulesOf(rewriteSubject(text, 'marta', null))[1], { folder: 'personas/marta', grants: {}, ai: null })
  assert.deepEqual(rulesOf(rewriteSubject(text, '@familia', '@casa'))[0], { folder: '', grants: { noa: 'manage', '@casa': 'read' }, ai: null })
  assert.equal(rewriteSubject(text, 'nadie', null), text)
})
