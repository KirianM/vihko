// The `permissions` section of vihko.yaml: how it's read
// (strict: any doubt rejects it whole) and how vihko edits it, leaving the
// rest of the file as it was. Levels are space-rules.test.ts's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PermissionsFileError, moveRules, parseWorkspaceConfig, removeRules, rewriteSubject, setRule,
  type ConfigError, type PermissionRule,
} from '@vihko/core'
import { mother } from '../../../test/mother.ts'

// The people and groups of the rules: an admin, a member, another member and a group.
const m = mother(import.meta.url)
const ADMIN = m.aUsername()
const MEMBER = m.aUsername()
const OTHER = m.aUsername()
const GROUP = m.aGroupName()
// A shared space and folders in it; a folder in a personal space.
const HOME = `spaces/${m.aSpaceFolder()}`
const RECIPES = `${HOME}/${m.aFolder()}`
const TRIPS = `people/${MEMBER}/${m.aFolder()}`
const DIARY = `people/${MEMBER}/${m.aFolder()}`
const SERIES = m.anId()

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
  ${HOME}:                  # a shared space
    grants: { "@${GROUP}": edit, ${ADMIN}: manage }
  ${TRIPS}:
    grants: { ${OTHER}: comment }
  ${DIARY}:
    ai: false
`

test('permissions: the rules as written, levels and subjects checked', () => {
  assert.deepEqual(rulesOf(SPEC), [
    { folder: HOME, grants: { [`@${GROUP}`]: 'edit', [ADMIN]: 'manage' }, ai: null },
    { folder: TRIPS, grants: { [OTHER]: 'comment' }, ai: null },
    { folder: DIARY, grants: null, ai: false },
  ])
  // Grants that are empty give nobody anything; none written, nothing either.
  assert.deepEqual(rulesOf(`permissions:\n  ${RECIPES}: {grants: {}}\n  ${TRIPS}: {}\n`), [{ folder: RECIPES, grants: {}, ai: null }, { folder: TRIPS, grants: null, ai: null }])
  // No section: nothing is shared (`none`); an empty one: no rules.
  assert.deepEqual((parseWorkspaceConfig('templates: x\n') as { sections: Record<string, unknown> }).sections.permissions, { kind: 'none' })
  assert.deepEqual(rulesOf('permissions:\n'), [])
})

test('permissions: any doubt rejects the whole section (nothing is shared), with where', () => {
  const at = (key: string) => [['section_rejected', 'permissions', 1], ['invalid_path', `permissions.${key}`, 2]]
  assert.deepEqual(rejected(`permissions:\n  ${HOME}: {grants: {${ADMIN}: admin}}\n`), [['section_rejected', 'permissions', 1], ['invalid_value', `permissions.${HOME}.grants.${ADMIN}`, 2]])
  assert.deepEqual(rejected(`permissions:\n  ${HOME}: {grant: {${ADMIN}: read}}\n`), [['section_rejected', 'permissions', 1], ['unknown_key', `permissions.${HOME}.grant`, 2]])
  assert.deepEqual(rejected(`permissions:\n  ${HOME}: {ai: "no"}\n`), [['section_rejected', 'permissions', 1], ['not_boolean', `permissions.${HOME}.ai`, 2]])
  assert.deepEqual(rejected(`permissions:\n  ${HOME}: {grants: {"bad name!": read}}\n`), [['section_rejected', 'permissions', 1], ['invalid_value', `permissions.${HOME}.grants.bad name!`, 2]])
  // 1.0's per-user subject is no subject now.
  assert.deepEqual(rejected(`permissions:\n  ${HOME}: {grants: {"{user}": read}}\n`), [['section_rejected', 'permissions', 1], ['invalid_value', `permissions.${HOME}.grants.{user}`, 2]])
  // Keys in no space: the root, the fixed folders, anything else; a `{user}` segment; grants at a personal root.
  for (const key of ['', 'people', 'spaces', m.aFolder(), `${m.aFolder()}/${m.aFolder()}`, 'people/{user}', `${HOME}/{user}`, `spaces/.${m.aWord()}`, `spaces/~${m.aWord()}`, '../fuera']) {
    assert.deepEqual(rejected(`permissions:\n  ${JSON.stringify(key)}: {grants: {${MEMBER}: read}}\n`)[0], ['section_rejected', 'permissions', 1], key)
  }
  assert.deepEqual(rejected(`permissions:\n  people/${MEMBER}: {grants: {${OTHER}: read}}\n`), at(`people/${MEMBER}`))
  // ai: false alone at a personal root is fine.
  assert.deepEqual(rulesOf(`permissions:\n  people/${MEMBER}: {ai: false}\n`), [{ folder: `people/${MEMBER}`, grants: null, ai: false }])
  // The same name twice, in another case.
  assert.deepEqual(rejected(`permissions:\n  ${HOME}: {grants: {${ADMIN.toUpperCase()}: read, ${ADMIN.toLowerCase()}: edit}}\n`), [['section_rejected', 'permissions', 1], ['invalid_value', `permissions.${HOME}.grants.${ADMIN.toLowerCase()}`, 2]])
  assert.deepEqual(rejected('permissions: [a]\n'), [['not_a_map', 'permissions', 1], ['section_rejected', 'permissions', 1]])
  assert.deepEqual(rejected(`permissions:\n  ${HOME}: todo\n`), [['section_rejected', 'permissions', 1], ['not_a_map', `permissions.${HOME}`, 2]])
  // Written twice once normalized (NFC and NFD of the same name: literals, the case under test).
  const cafe = 'Café'
  assert.deepEqual(rejected(`permissions:\n  "${HOME}/${cafe.normalize('NFC')}": {grants: {}}\n  "${HOME}/${cafe.normalize('NFD')}": {grants: {}}\n`)[0], ['section_rejected', 'permissions', 1])
})

test('permissions: ai: true closes nothing; ignored with a notice, the section still applies', () => {
  const r = parseWorkspaceConfig(`permissions:\n  ${HOME}: {ai: false}\n  ${RECIPES}: {ai: true}\n`)
  assert.ok(r.ok)
  assert.deepEqual(r.sections.permissions, { kind: 'rules', rules: [{ folder: HOME, grants: null, ai: false }, { folder: RECIPES, grants: null, ai: null }] })
  assert.deepEqual(brief(r.warnings), [['ignored_value', `permissions.${RECIPES}.ai`, 3]])
})

test('permissions file: one entry changes, comments, order and the rest of the file stay', () => {
  const text = `# Workspace
templates: Plantillas   # templates here

permissions:
  # the space
  ${HOME}:   # shared
    grants: { "@${GROUP}": edit }
  ${TRIPS}:
    grants: { ${OTHER}: comment }
daily:
  ${SERIES}:
    folder: people/{user}/${m.aFolder()}
`
  const g = `@${GROUP}`
  const out = setRule(text, HOME, { grants: { [g]: 'edit', [MEMBER]: 'read' }, ai: null })
  // Usernames are written plain (letters, digits, `.`, `_`, `-`), a group quoted (`@`).
  assert.equal(out, text.replace(`grants: { "${g}": edit }`, `grants: { "${g}": edit, ${MEMBER}: read }`))
  // A comment on a line written again stays, with its line; one on its own line too.
  const commented = text.replace(`grants: { "${g}": edit }`, `# who\n    grants: { "${g}": edit }  # the family edits`)
  assert.equal(setRule(commented, HOME, { grants: { [g]: 'read' }, ai: null }), commented.replace(`"${g}": edit }`, `"${g}": read }`))
  const added = setRule(text, RECIPES, { grants: { [MEMBER]: 'manage', [ADMIN]: 'comment' }, ai: null })
  assert.ok(added.includes(`  ${TRIPS}:\n    grants: { ${OTHER}: comment }\n  ${RECIPES}:\n    grants: { ${MEMBER}: manage, ${ADMIN}: comment }\ndaily:`), added)
  assert.ok(added.startsWith('# Workspace\ntemplates: Plantillas   # templates here\n'))
  const closed = setRule(text, HOME, { grants: { [g]: 'edit' }, ai: false })
  assert.deepEqual(rulesOf(closed)[0], { folder: HOME, grants: { [g]: 'edit' }, ai: false })
  const gone = setRule(text, HOME, { grants: null, ai: null })
  assert.deepEqual(rulesOf(gone).map((r) => r.folder), [TRIPS])
  assert.match(gone, /# Workspace/)
  // No section yet: it's written, with the one rule (nothing implicit comes with it).
  const fresh = setRule('templates: P\n', HOME, { grants: { [MEMBER]: 'edit' }, ai: null })
  assert.deepEqual(rulesOf(fresh), [{ folder: HOME, grants: { [MEMBER]: 'edit' }, ai: null }])
  assert.throws(() => setRule('a: [\n', HOME, { grants: {}, ai: null }), PermissionsFileError)
})

test('permissions file: moving a folder moves its rules and those under it, and drops those forgotten where it goes; deleting removes them', () => {
  const [b, c, bc, x, y, z] = [m.aFolder(), m.aFolder(), m.aFolder(), m.aFolder(), m.aFolder(), m.aFolder()]
  const A = (p: string) => `${HOME}/${p}`
  const text = `permissions:\n  ${HOME}: {grants: {${ADMIN}: manage}}\n  ${A(b)}: {grants: {${MEMBER}: edit}}\n  ${A(`${b}/${c}`)}: {ai: false}\n  ${A(b + bc)}: {grants: {}}\n  ${A(`${x}/${y}/${z}`)}: {grants: {${OTHER}: read}}\n`
  const moved = moveRules(text, A(b), A(`${x}/${y}`))
  // The rule forgotten under the destination goes: the folder brings its own.
  assert.deepEqual(rulesOf(moved).map((r) => r.folder).sort(), [HOME, A(b + bc), A(`${x}/${y}`), A(`${x}/${y}/${c}`)].sort())
  assert.deepEqual(rulesOf(moved).find((r) => r.folder === A(`${x}/${y}`)), { folder: A(`${x}/${y}`), grants: { [MEMBER]: 'edit' }, ai: null })
  const both = moveRules(text, A(b), A(`${x}/${y}`), { keepFrom: true })
  assert.deepEqual(rulesOf(both).map((r) => r.folder).sort(), [HOME, A(b), A(`${b}/${c}`), A(b + bc), A(`${x}/${y}`), A(`${x}/${y}/${c}`)].sort())
  assert.deepEqual(rulesOf(removeRules(text, A(b))).map((r) => r.folder).sort(), [HOME, A(b + bc), A(`${x}/${y}/${z}`)].sort())
})

test('permissions file: a subject is removed or renamed everywhere; an emptied rule gives nobody anything', () => {
  // The grant written in upper case, the subject asked for in lower case: the same one.
  const text = `permissions:\n  ${HOME}: {grants: {${ADMIN}: manage, "@${GROUP}": read}}\n  ${TRIPS}: {grants: {${OTHER.toUpperCase()}: manage}}\n`
  assert.deepEqual(rulesOf(rewriteSubject(text, OTHER.toLowerCase(), null))[1], { folder: TRIPS, grants: {}, ai: null })
  const renamed = m.aGroupName()
  assert.deepEqual(rulesOf(rewriteSubject(text, `@${GROUP}`, `@${renamed}`))[0], { folder: HOME, grants: { [ADMIN]: 'manage', [`@${renamed}`]: 'read' }, ai: null })
  assert.equal(rewriteSubject(text, m.aUsername(), null), text)
})
