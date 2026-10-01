// The spaces model of the permissions: the
// section's keys, a shared space's name, and levels (sharing only adds).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LEVELS, SpaceRules, atLeast, moveRules, parentFolder, parseWorkspaceConfig, rewriteSubject, rulesInFile, setRule, spaceKeyProblem,
  type Level, type PermissionRule,
} from '@vihko/core'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
const OWNER = m.aUsername()
const MEMBER = m.aUsername()
const OTHER = m.aUsername()
const GONE = m.aUsername()
const GROUP = m.aGroupName()
const HOME_NAME = m.aSpaceName()
// A space as 0.1.0-rc.1 and rc.2 made it: its name in vihko.yaml (read only for the start that renames it).
const HOME = `spaces/${m.aLegacySpaceFolder(HOME_NAME)}`
const RECIPES = `${HOME}/${m.aFolder()}`
const FINANCES = `${HOME}/${m.aFolder()}`
const TRIPS = `people/${OWNER}/${m.aFolder()}`
const DIARY = `people/${OWNER}/${m.aFolder()}`

const exists = (name: string) => name !== GONE
const who = (username: string, groups: string[] = []) => ({ username, groups })

const rulesOf = (text: string): PermissionRule[] => {
  const r = parseWorkspaceConfig(text)
  assert.ok(r.ok)
  const p = r.sections.permissions as { kind: string; rules?: PermissionRule[] }
  assert.equal(p.kind, 'rules', JSON.stringify(r.warnings))
  return p.rules!
}

const SPEC = `permissions:
  ${HOME}:                  # members of the space
    name: ${JSON.stringify(HOME_NAME)}
    grants: { "@${GROUP}": edit, ${OWNER}: manage }
  ${RECIPES}:
    grants: { ${OTHER}: read }
  ${FINANCES}:
    ai: false
  ${TRIPS}:
    grants: { ${MEMBER}: comment }
  people/${OWNER}:
    ai: false
`

test('spaces model: the section as written, with a legacy space name', () => {
  assert.deepEqual(rulesOf(SPEC), [
    { folder: HOME, grants: { [`@${GROUP}`]: 'edit', [OWNER]: 'manage' }, ai: null, name: HOME_NAME },
    { folder: RECIPES, grants: { [OTHER]: 'read' }, ai: null },
    { folder: FINANCES, grants: null, ai: false },
    { folder: TRIPS, grants: { [MEMBER]: 'comment' }, ai: null },
    { folder: `people/${OWNER}`, grants: null, ai: false },
  ])
})

test('spaces model: a legacy name only at a shared space root, any text there', () => {
  for (const [key, name] of [[RECIPES, HOME_NAME], [`people/${OWNER}`, HOME_NAME]] as const) {
    const r = parseWorkspaceConfig(`permissions:\n  ${key}:\n    name: ${JSON.stringify(name)}\n`)
    assert.ok(r.ok)
    assert.deepEqual(r.sections.permissions, { kind: 'closed' }, `${key}: ${name}`)
    assert.ok(r.warnings.some((w) => w.code === 'invalid_value' && w.at === `permissions.${key}.name`), JSON.stringify(r.warnings))
  }
  const r = parseWorkspaceConfig(`permissions:\n  ${HOME}:\n    name: 12\n`)
  assert.ok(r.ok && r.warnings.some((w) => w.code === 'invalid_type'))
  // At a shared space's root any text is kept as it was: it rejects nothing (the start falls back to the readable part).
  for (const name of ['', ` ${HOME_NAME}`, `${HOME_NAME}/${m.aWord()}`]) {
    const ok = parseWorkspaceConfig(`permissions:\n  ${HOME}:\n    name: ${JSON.stringify(name)}\n`)
    assert.ok(ok.ok)
    assert.deepEqual(ok.sections.permissions, { kind: 'rules', rules: [{ folder: HOME, grants: null, ai: null, name }] }, name)
  }
})

test('spaces model: which keys it takes', () => {
  const g = { grants: { [MEMBER]: 'read' as Level } }
  const none = { grants: null }
  assert.equal(spaceKeyProblem(HOME, g), null)
  assert.equal(spaceKeyProblem(RECIPES, g), null)
  assert.equal(spaceKeyProblem(TRIPS, g), null)
  assert.equal(spaceKeyProblem(`people/${OWNER}`, none), null)
  assert.equal(spaceKeyProblem(`people/${OWNER}`, g), 'personal_root_grants')
  for (const key of ['', 'people', 'spaces', m.aFolder(), `${m.aFolder()}/${m.aFolder()}`, `spaces/.${m.aWord()}`, `spaces/~${m.aWord()}`, 'spaces/people', 'people/.x']) {
    assert.equal(spaceKeyProblem(key, g), 'outside_spaces', key)
  }
  assert.equal(spaceKeyProblem('people/{user}', g), 'user_segment')
  assert.equal(spaceKeyProblem(`${HOME}/{user}`, g), 'user_segment')
})

test('spaces model: levels', () => {
  const rules = new SpaceRules(rulesOf(SPEC))
  const level = (folder: string, u: { username: string; groups: string[] }) => rules.level(folder, u, exists)
  // The owner manages their space, whatever is written.
  assert.equal(level(`people/${OWNER}`, who(OWNER)), 'manage')
  assert.equal(level(DIARY, who(OWNER)), 'manage')
  // Nobody else sees a personal space, but what is shared from it.
  assert.equal(level(`people/${OWNER}`, who(MEMBER)), null)
  assert.equal(level(DIARY, who(MEMBER)), null)
  assert.equal(level(TRIPS, who(MEMBER)), 'comment')
  assert.equal(level(`${TRIPS}/${m.aFolder()}`, who(MEMBER)), 'comment')
  // Members, by group; a subfolder adds someone from outside.
  assert.equal(level(HOME, who(MEMBER, [GROUP])), 'edit')
  assert.equal(level(RECIPES, who(MEMBER, [GROUP])), 'edit')
  assert.equal(level(HOME, who(OTHER)), null)
  assert.equal(level(RECIPES, who(OTHER)), 'read')
  assert.equal(level(`${RECIPES}/${m.aFolder()}`, who(OTHER)), 'read')
  assert.equal(level(HOME, who(OWNER)), 'manage')
  // Groups and names are compared without case.
  assert.equal(level(HOME, who(MEMBER, [GROUP.toUpperCase()])), 'edit')
  assert.equal(level(TRIPS, who(MEMBER.toUpperCase())), 'comment')
  // Outside every space, nothing: not even the root.
  for (const f of ['', 'people', 'spaces', m.aFolder()]) assert.equal(level(f, who(OWNER)), null)
})

test('spaces model: a deleted person’s space is nobody’s', () => {
  const trips = `people/${GONE}/${m.aFolder()}`
  const rules = new SpaceRules([{ folder: trips, grants: { [MEMBER]: 'edit' }, ai: null }])
  assert.equal(rules.level(`people/${GONE}`, who(GONE), exists), null)
  assert.equal(rules.level(trips, who(MEMBER), exists), null)
  assert.equal(rules.level(trips, who(MEMBER), () => true), 'edit')
})

test('spaces model: rules it does not take are left out', () => {
  const folder = m.aFolder()
  const rules = new SpaceRules([
    { folder: '', grants: { [MEMBER]: 'manage' }, ai: null },
    { folder, grants: { [MEMBER]: 'manage' }, ai: null },
    { folder: 'people/{user}', grants: { '{user}': 'manage' }, ai: null },
    { folder: `people/${OWNER}`, grants: { [MEMBER]: 'manage' }, ai: null },
  ])
  assert.equal(rules.rules.length, 0)
  assert.equal(rules.level(`people/${OWNER}`, who(MEMBER), exists), null)
  assert.equal(rules.level(folder, who(MEMBER), exists), null)
})

test('spaces model: ai: false closes down to everything under it, within the space', () => {
  const rules = new SpaceRules(rulesOf(SPEC))
  assert.equal(rules.aiClosedAt(FINANCES), FINANCES)
  assert.equal(rules.aiClosedAt(`${FINANCES}/${m.aFolder()}`), FINANCES)
  assert.equal(rules.aiClosedAt(RECIPES), null)
  assert.equal(rules.aiClosedAt(TRIPS), `people/${OWNER}`)
  assert.equal(rules.aiClosedAt(m.aFolder()), null)
})

test('spaces model: what reaches a folder, a legacy name, what has grants', () => {
  const rules = new SpaceRules(rulesOf(SPEC))
  assert.deepEqual(rules.reaching(RECIPES), [
    { subject: `@${GROUP}`, level: 'edit', from: HOME },
    { subject: OWNER, level: 'manage', from: HOME },
    { subject: OTHER, level: 'read', from: RECIPES },
  ])
  assert.deepEqual(rules.reaching(DIARY), [])
  assert.equal(rules.legacyName(HOME), HOME_NAME)
  assert.equal(rules.legacyName(RECIPES), null)
  assert.deepEqual(rules.granted().sort(), [HOME, RECIPES, TRIPS].sort())
})

test('spaces model (property): sharing only adds, the owner manages, a deleted owner closes', () => {
  for (let round = 0; round < 40; round++) {
    const users = Array.from({ length: 4 }, () => m.aUsername())
    const groups = [m.aGroupName(), m.aGroupName()]
    const membership = new Map(users.map((u) => [u, groups.filter(() => m.chance(0.5))]))
    const owner = m.pick(users)
    const roots = [`people/${owner}`, `spaces/${m.aSpaceFolder()}`]
    // A tree of folders under each root, grants at random (any level, to anyone).
    const folders: string[] = []
    for (const root of roots) {
      let parents = [root]
      for (let depth = 0; depth < 3; depth++) {
        const next = parents.flatMap((p) => Array.from({ length: m.anInt(1, 2) }, () => `${p}/${m.aFolder()}`))
        folders.push(...next)
        parents = next
      }
    }
    const subjects = [...users, ...groups.map((g) => `@${g}`)]
    const rules: PermissionRule[] = []
    for (const f of [roots[1]!, ...folders]) {
      if (!m.chance(0.4)) continue
      const grants: Record<string, Level> = {}
      for (const s of subjects) if (m.chance(0.3)) grants[s] = m.pick(LEVELS)
      rules.push({ folder: f, grants, ai: m.chance(0.2) ? false : null })
    }
    const set = new SpaceRules(rules)
    for (const u of users) {
      const w = who(u, membership.get(u)!)
      for (const f of folders) {
        const here = set.level(f, w, () => true)
        const above = set.level(parentFolder(f)!, w, () => true)
        // Never less than in the parent.
        if (above !== null) assert.ok(atLeast(here, above), `${f}: ${here} < ${above}`)
        // The owner manages everything in their space.
        if (u === owner && f.startsWith(`people/${owner}/`)) assert.equal(here, 'manage')
        // Nobody else sees the owner's space unless something is written for them in it.
        if (u !== owner && f.startsWith(`people/${owner}/`) && here !== null) assert.ok(set.reaching(f).length > 0)
        // With the owner deleted, nobody sees anything in their space.
        if (f.startsWith(`people/${owner}/`)) assert.equal(set.level(f, w, (n) => n !== owner), null)
      }
      // ai: false is inherited (the nearest closing folder is the one named).
      for (const f of folders) {
        if (set.aiClosedAt(parentFolder(f)!) !== null) assert.notEqual(set.aiClosedAt(f), null, f)
      }
    }
  }
})

test('spaces model: vihko writes a space’s name with its members, and keeps it', () => {
  const name = m.aSpaceName()
  const root = `spaces/${m.aSpaceFolder(name)}`
  let text = `# settings\ntemplates: ${JSON.stringify(m.aFolder())}\n`
  text = setRule(text, root, { name, grants: { [OWNER]: 'manage' }, ai: null })
  assert.deepEqual(rulesInFile(text).get(root), { grants: { [OWNER]: 'manage' }, ai: null, name })
  assert.deepEqual(rulesOf(text), [{ folder: root, grants: { [OWNER]: 'manage' }, ai: null, name }])
  // A name that needs quoting reads back the same (literals: the characters are the case).
  for (const odd of ['true', '12 monos', 'a: b', 'Casa # 2', '"quoted"', "Ana's"]) {
    const t = setRule(text, root, { name: odd, grants: { [OWNER]: 'manage' }, ai: null })
    assert.equal(rulesInFile(t).get(root)?.name, odd, odd)
  }
  // Renaming a subject keeps the name.
  const renamed = rewriteSubject(text, OWNER, MEMBER)
  assert.deepEqual(rulesInFile(renamed).get(root), { grants: { [MEMBER]: 'manage' }, ai: null, name })
  // Moving the rules of a folder that holds the space keeps the name (the rules travel whole).
  const sub = `${root}/${m.aFolder()}`
  const moved = moveRules(setRule(text, sub, { grants: { [OTHER]: 'read' }, ai: null }), sub, `${root}/${m.aFolder()}`)
  assert.equal(rulesInFile(moved).get(root)?.name, name)
  // Setting grants and ai without a name removes the name; all null removes the rule.
  assert.equal(rulesInFile(setRule(text, root, { grants: { [OWNER]: 'manage' }, ai: null })).get(root)?.name, undefined)
  assert.equal(rulesInFile(setRule(text, root, { grants: null, ai: null, name: null })).has(root), false)
  // A section written in flow style too.
  const flow = setRule(`permissions: { ${TRIPS}: { grants: { ${MEMBER}: read } } }\n`, root, { name, grants: { [OWNER]: 'manage' }, ai: null })
  assert.equal(rulesInFile(flow).get(root)?.name, name)
})
