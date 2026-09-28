import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PermissionsFileError, RuleSet, grantsAt, levelIn, levelInReach, moveRules, parseWorkspaceConfig, reachingGrants, removeRules, rewriteSubject, setRule,
  type ConfigError, type Level, type PermissionRule,
} from '@thoth/core'
import { mother } from '../../../test/mother.ts'

// The people and groups of the rules: the admin who manages the root, a
// member, another member, a group of both, and a name nobody has.
const m = mother(import.meta.url)
const ADMIN = m.aUsername()
const MEMBER = m.aUsername()
const OTHER = m.aUsername()
const NOBODY = m.aUsername()
const GROUP = m.aGroupName()
// The folders of the rules: a shared one, the one of personal folders, and some below them.
const SHARED = m.aFolder()
const PEOPLE = m.aFolder()
const RECIPES = m.aFolder()
const TRIPS = m.aFolder()
const SURPRISE = m.aFolder()
const DIARY = m.aFolder()
const ELSEWHERE = m.aFolder()
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
  "":                         # the root
    grants: { ${ADMIN}: manage }
  ${SHARED}:
    grants: { "@${GROUP}": edit, ${ADMIN}: edit }
  "${PEOPLE}/{user}":
    grants: { "{user}": manage }
  ${PEOPLE}/${MEMBER}/${DIARY}:
    ai: false
`

test('permissions: the rules as written, levels and subjects checked', () => {
  assert.deepEqual(rulesOf(SPEC), [
    { folder: '', grants: { [ADMIN]: 'manage' }, ai: null },
    { folder: SHARED, grants: { [`@${GROUP}`]: 'edit', [ADMIN]: 'edit' }, ai: null },
    { folder: `${PEOPLE}/{user}`, grants: { '{user}': 'manage' }, ai: null },
    { folder: `${PEOPLE}/${MEMBER}/${DIARY}`, grants: null, ai: false },
  ])
  // Own grants that are empty close the folder; no grants inherit.
  assert.deepEqual(rulesOf('permissions:\n  a: {grants: {}}\n  b: {}\n'), [{ folder: 'a', grants: {}, ai: null }, { folder: 'b', grants: null, ai: null }])
})

test('permissions: any doubt rejects the whole section (nobody reads), with where', () => {
  assert.deepEqual(rejected(`permissions:\n  a: {grants: {${ADMIN}: admin}}\n`), [['section_rejected', 'permissions', 1], ['invalid_value', `permissions.a.grants.${ADMIN}`, 2]])
  assert.deepEqual(rejected('permissions:\n  a: {grants: {"{user}": read}}\n'), [['section_rejected', 'permissions', 1], ['invalid_value', 'permissions.a.grants.{user}', 2]])
  assert.deepEqual(rejected(`permissions:\n  a: {grant: {${ADMIN}: read}}\n`), [['section_rejected', 'permissions', 1], ['unknown_key', 'permissions.a.grant', 2]])
  assert.deepEqual(rejected('permissions:\n  ../fuera: {grants: {}}\n'), [['section_rejected', 'permissions', 1], ['invalid_path', 'permissions.../fuera', 2]])
  assert.deepEqual(rejected('permissions:\n  "{user}/{user}": {grants: {}}\n'), [['section_rejected', 'permissions', 1], ['invalid_path', 'permissions.{user}/{user}', 2]])
  assert.deepEqual(rejected('permissions:\n  "a/{users}": {grants: {}}\n'), [['section_rejected', 'permissions', 1], ['invalid_path', 'permissions.a/{users}', 2]])
  assert.deepEqual(rejected('permissions:\n  a: {ai: "no"}\n'), [['section_rejected', 'permissions', 1], ['not_boolean', 'permissions.a.ai', 2]])
  assert.deepEqual(rejected('permissions:\n  a: {grants: {"bad name!": read}}\n'), [['section_rejected', 'permissions', 1], ['invalid_value', 'permissions.a.grants.bad name!', 2]])
  // The same name twice, in another case.
  assert.deepEqual(rejected(`permissions:\n  a: {grants: {${ADMIN.toUpperCase()}: read, ${ADMIN.toLowerCase()}: edit}}\n`), [['section_rejected', 'permissions', 1], ['invalid_value', `permissions.a.grants.${ADMIN.toLowerCase()}`, 2]])
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
  const users = new Set([ADMIN, MEMBER, OTHER])
  const exists = (u: string) => users.has(u)
  const level = (folder: string, username: string, groups: string[] = []): Level | null => {
    const g = set.governing(folder)
    return g ? levelIn(grantsAt(g, exists), { username, groups }) : null
  }
  assert.equal(level('', ADMIN), 'manage')
  assert.equal(level(`${ELSEWHERE}/cosa`, ADMIN), 'manage', 'inherited from the root')
  assert.equal(level(ELSEWHERE, MEMBER), null)
  assert.equal(level(`${SHARED}/${RECIPES}`, MEMBER, [GROUP]), 'edit', 'through a group')
  assert.equal(level(SHARED, ADMIN), 'edit', 'own grants replace the root\'s (in the grants: his manage still reaches it from above, reachingGrants)')
  assert.equal(level(PEOPLE, ADMIN), 'manage', 'the folder above a {user} rule inherits')
  assert.equal(level(`${PEOPLE}/${MEMBER}`, MEMBER), 'manage')
  assert.equal(level(`${PEOPLE}/${MEMBER}/${DIARY}`, MEMBER), 'manage', 'ai alone doesn\'t change the grants')
  assert.equal(level(`${PEOPLE}/${MEMBER}`, ADMIN), null, 'the admin doesn\'t read what isn\'t granted')
  assert.equal(level(`${PEOPLE}/${NOBODY}`, ADMIN), null, 'named like nobody: nobody')
  assert.equal(level(`${PEOPLE}/${NOBODY}/sub`, NOBODY), null)
  assert.deepEqual(set.governing(`${PEOPLE}/${MEMBER}/${DIARY}/x`), { rule: rulesOf(SPEC)[2], user: MEMBER, at: `${PEOPLE}/${MEMBER}` })
  assert.equal(set.aiClosedAt(`${PEOPLE}/${MEMBER}/${DIARY}/2026`), `${PEOPLE}/${MEMBER}/${DIARY}`)
  assert.equal(set.aiClosedAt(`${PEOPLE}/${MEMBER}`), null)
  // A literal rule at the same depth wins over the {user} one.
  const lit = new RuleSet(rulesOf(SPEC + `  ${PEOPLE}/${MEMBER}/${RECIPES}:\n    grants: { ${MEMBER}: manage, ${ADMIN}: comment }\n  ${PEOPLE}/${OTHER}:\n    grants: { ${OTHER}: read }\n`))
  assert.equal(levelIn(grantsAt(lit.governing(`${PEOPLE}/${MEMBER}/${RECIPES}`)!, exists), { username: ADMIN, groups: [] }), 'comment')
  assert.equal(levelIn(grantsAt(lit.governing(`${PEOPLE}/${OTHER}`)!, exists), { username: OTHER, groups: [] }), 'read')
  // A literal rule without grants (only `ai: false`) over a {user} one keeps that one's grants: never the root's.
  const closed = new RuleSet(rulesOf(SPEC + `  ${PEOPLE}/${MEMBER}:\n    ai: false\n`))
  const at = (folder: string, username: string) => levelIn(grantsAt(closed.governing(folder)!, exists), { username, groups: [] })
  assert.equal(at(`${PEOPLE}/${MEMBER}`, MEMBER), 'manage')
  assert.equal(at(`${PEOPLE}/${MEMBER}`, ADMIN), null, 'the root\'s manager gains nothing')
  assert.equal(at(`${PEOPLE}/${MEMBER}/${RECIPES}`, ADMIN), null)
  assert.equal(closed.aiClosedAt(`${PEOPLE}/${MEMBER}/${RECIPES}`), `${PEOPLE}/${MEMBER}`)
  assert.equal(closed.own(`${PEOPLE}/${MEMBER}`)?.user, null, 'its own rule is the literal one')
  assert.equal(closed.userRule(`${PEOPLE}/${MEMBER}`)?.user, MEMBER)
  // And ai: false on the {user} rule closes every personal folder.
  assert.equal(new RuleSet(rulesOf(SPEC.replace('{ "{user}": manage }', '{ "{user}": manage }\n    ai: false'))).aiClosedAt(`${PEOPLE}/${OTHER}/x`), `${PEOPLE}/${OTHER}`)
  // Names compare without case, as state.db does.
  assert.equal(levelIn({ [ADMIN.toUpperCase()]: 'read', [`@${GROUP.toUpperCase()}`]: 'edit' }, { username: ADMIN.toLowerCase(), groups: [GROUP.toLowerCase()] }), 'edit')
})

test('permissions: whoever manages a folder keeps manage under it, whatever a subfolder\'s grants say, but never into a personal folder (D-040 3.5)', () => {
  const set = new RuleSet(rulesOf(SPEC
    + `  ${SHARED}/${TRIPS}:\n    grants: { ${MEMBER}: manage, ${OTHER}: manage }\n`
    + `  ${SHARED}/${TRIPS}/${SURPRISE}:\n    grants: { ${MEMBER}: manage }\n`
    + `  ${PEOPLE}/${MEMBER}/${RECIPES}:\n    grants: { ${OTHER}: read }\n`))
  const users = new Set([ADMIN, MEMBER, OTHER])
  const exists = (u: string) => users.has(u)
  const level = (folder: string, username: string, groups: string[] = []) => levelInReach(reachingGrants(set, folder, exists), { username, groups })
  // Where managers come from: up to the nearest personal folder, included; none for a personal folder itself.
  assert.deepEqual(set.managedFrom(`${SHARED}/${TRIPS}/${SURPRISE}`), [`${SHARED}/${TRIPS}`, SHARED, ''])
  assert.deepEqual(set.managedFrom(`${PEOPLE}/${MEMBER}/${RECIPES}/x`), [`${PEOPLE}/${MEMBER}/${RECIPES}`, `${PEOPLE}/${MEMBER}`])
  assert.deepEqual(set.managedFrom(`${PEOPLE}/${MEMBER}`), [])
  assert.deepEqual([set.personal(`${PEOPLE}/${MEMBER}`), set.personal(PEOPLE), set.personal(`${PEOPLE}/${MEMBER}/${RECIPES}`)], [true, false, false])
  // A co-manager left out of a subfolder's own grants keeps managing it.
  assert.equal(level(`${SHARED}/${TRIPS}/${SURPRISE}`, OTHER), 'manage')
  assert.deepEqual(reachingGrants(set, `${SHARED}/${TRIPS}/${SURPRISE}`, exists).above, [
    { subject: MEMBER, from: `${SHARED}/${TRIPS}` }, { subject: OTHER, from: `${SHARED}/${TRIPS}` }, { subject: ADMIN, from: '' },
  ])
  // The root's manager: everything but personal folders.
  assert.equal(level(SHARED, ADMIN), 'manage', 'his own edit, and the root\'s manage from above')
  assert.equal(level(`${SHARED}/${TRIPS}/${SURPRISE}`, ADMIN), 'manage')
  assert.equal(level(`${SHARED}/${RECIPES}`, MEMBER, [GROUP]), 'edit', 'a grant below manage doesn\'t flow')
  for (const f of [`${PEOPLE}/${MEMBER}`, `${PEOPLE}/${MEMBER}/${RECIPES}`, `${PEOPLE}/${MEMBER}/${RECIPES}/x`, `${PEOPLE}/${NOBODY}`, `${PEOPLE}/${NOBODY}/sub`]) {
    assert.equal(level(f, ADMIN), null, f)
  }
  // The owner of a personal folder manages a subfolder whose own grants leave her out; a reader there only reads.
  assert.equal(level(`${PEOPLE}/${MEMBER}/${RECIPES}`, MEMBER), 'manage')
  assert.equal(level(`${PEOPLE}/${MEMBER}/${RECIPES}`, OTHER), 'read')
  assert.deepEqual(reachingGrants(set, `${PEOPLE}/${MEMBER}/${RECIPES}`, exists).above, [{ subject: MEMBER, from: `${PEOPLE}/${MEMBER}`, rule: `${PEOPLE}/{user}` }])
  // Through a group, as any grant.
  const team = m.aGroupName()
  const [inTeam, reader] = [m.aUsername(), m.aUsername()]
  const group = new RuleSet(rulesOf(`permissions:\n  a:\n    grants: { "@${team}": manage }\n  a/b:\n    grants: { ${reader}: read }\n`))
  assert.equal(levelInReach(reachingGrants(group, 'a/b/c', exists), { username: inTeam, groups: [team] }), 'manage')
  assert.equal(levelInReach(reachingGrants(group, 'a/b/c', exists), { username: reader, groups: [] }), 'read')
})

test('permissions file: one entry changes, comments, order and the rest of the file stay', () => {
  const text = `# Workspace
templates: Plantillas   # templates here

permissions:
  # the root
  "":
    grants: { ${ADMIN}: manage }
  ${SHARED}:   # shared
    grants: { "@${GROUP}": edit }
daily:
  ${SERIES}:
    folder: ${DIARY}/{user}
`
  const g = `@${GROUP}`
  const out = setRule(text, SHARED, { grants: { [g]: 'edit', [MEMBER]: 'read' }, ai: null })
  // Usernames are written plain (letters, digits, `.`, `_`, `-`), a group quoted (`@`).
  assert.equal(out, text.replace(`grants: { "${g}": edit }`, `grants: { "${g}": edit, ${MEMBER}: read }`))
  // A comment on a line written again stays, with its line; one on its own line too.
  const commented = text.replace(`grants: { "${g}": edit }`, `# who\n    grants: { "${g}": edit }  # the family edits`)
  assert.equal(setRule(commented, SHARED, { grants: { [g]: 'read' }, ai: null }), commented.replace(`"${g}": edit }`, `"${g}": read }`))
  const added = setRule(text, `${PEOPLE}/${MEMBER}/${RECIPES}`, { grants: { [MEMBER]: 'manage', [ADMIN]: 'comment' }, ai: null })
  assert.ok(added.includes(`${SHARED}:   # shared\n    grants: { "${g}": edit }\n  ${PEOPLE}/${MEMBER}/${RECIPES}:\n    grants: { ${MEMBER}: manage, ${ADMIN}: comment }\ndaily:`), added)
  assert.ok(added.startsWith('# Workspace\ntemplates: Plantillas   # templates here\n'))
  const closed = setRule(text, SHARED, { grants: { [g]: 'edit' }, ai: false })
  assert.deepEqual(rulesOf(closed)[1], { folder: SHARED, grants: { [g]: 'edit' }, ai: false })
  const gone = setRule(text, SHARED, { grants: null, ai: null })
  assert.deepEqual(rulesOf(gone).map((r) => r.folder), [''])
  assert.match(gone, /# Workspace/)
  // No file, or none of it about permissions: the implicit section is written first.
  const fresh = setRule('templates: P\n', SHARED, { grants: { [MEMBER]: 'edit' }, ai: null }, { implicitAdmins: [ADMIN] })
  assert.deepEqual(rulesOf(fresh), [{ folder: '', grants: { [ADMIN]: 'manage' }, ai: null }, { folder: SHARED, grants: { [MEMBER]: 'edit' }, ai: null }])
  assert.deepEqual(rulesOf(setRule('', '', { grants: { [MEMBER]: 'read' }, ai: null }, { implicitAdmins: [ADMIN] })), [{ folder: '', grants: { [MEMBER]: 'read' }, ai: null }])
  assert.throws(() => setRule('a: [\n', 'x', { grants: {}, ai: null }), PermissionsFileError)
})

test('permissions file: moving a folder moves its rules and those under it; deleting removes them', () => {
  const text = `permissions:\n  "": {grants: {${ADMIN}: manage}}\n  a/b: {grants: {${MEMBER}: edit}}\n  a/b/c: {ai: false}\n  a/bc: {grants: {}}\n`
  const moved = moveRules(text, 'a/b', 'x/y')
  assert.deepEqual(rulesOf(moved).map((r) => r.folder), ['', 'a/bc', 'x/y', 'x/y/c'])
  assert.deepEqual(rulesOf(moved)[2], { folder: 'x/y', grants: { [MEMBER]: 'edit' }, ai: null })
  const both = moveRules(text, 'a/b', 'x/y', { keepFrom: true, extra: [{ folder: 'x/y/z', grants: { [MEMBER]: 'manage' }, ai: null }] })
  assert.deepEqual(rulesOf(both).map((r) => r.folder), ['', 'a/b', 'a/b/c', 'a/bc', 'x/y', 'x/y/c', 'x/y/z'])
  assert.deepEqual(rulesOf(removeRules(text, 'a/b')).map((r) => r.folder), ['', 'a/bc'])
})

test('permissions file: a subject is removed or renamed everywhere; an emptied rule stays closed', () => {
  // The grant written in upper case, the subject asked for in lower case: the same one.
  const text = `permissions:\n  "": {grants: {${ADMIN}: manage, "@${GROUP}": read}}\n  ${PEOPLE}/${OTHER}: {grants: {${OTHER.toUpperCase()}: manage}}\n`
  assert.deepEqual(rulesOf(rewriteSubject(text, OTHER.toLowerCase(), null))[1], { folder: `${PEOPLE}/${OTHER}`, grants: {}, ai: null })
  const renamed = m.aGroupName()
  assert.deepEqual(rulesOf(rewriteSubject(text, `@${GROUP}`, `@${renamed}`))[0], { folder: '', grants: { [ADMIN]: 'manage', [`@${renamed}`]: 'read' }, ai: null })
  assert.equal(rewriteSubject(text, m.aUsername(), null), text)
})
