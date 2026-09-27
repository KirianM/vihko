// The mother itself: its values follow thoth's rules, names never repeat
// under thoth's comparison, and the same seed gives the same values.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { classifyPath } from '@thoth/core'
import { caseFold } from '@thoth/core/casefold'
import { subjectKey as coreSubjectKey } from '../packages/core/src/permissions.ts'
import { MIN_PASSWORD as SERVER_MIN_PASSWORD, NAME_PATTERN as SERVER_NAME_PATTERN, NoteService } from '@thoth/server'
import { MIN_PASSWORD, NAME_PATTERN, RESERVED, SEED, mother, subjectKey } from './mother.ts'

const m = mother(import.meta.url)

test("the mother's rules are thoth's own", () => {
  assert.equal(NAME_PATTERN.source, SERVER_NAME_PATTERN.source)
  assert.equal(NAME_PATTERN.flags, SERVER_NAME_PATTERN.flags)
  assert.equal(MIN_PASSWORD, SERVER_MIN_PASSWORD)
  for (const s of ['Ángela', 'MARÍA', 'I', 'ﬁ', 'Straße']) assert.equal(subjectKey(s), coreSubjectKey(s), s)
})

test('usernames and group names are valid and never repeat under subjectKey, nor name a reserved literal', () => {
  const seen = new Set<string>(RESERVED.map(subjectKey))
  const names = [...Array.from({ length: 400 }, () => m.aUsername()), ...Array.from({ length: 200 }, () => m.aGroupName())]
  for (const n of names) {
    assert.match(n, NAME_PATTERN)
    assert.equal(n, n.normalize('NFC'), `${n} is NFC`)
    assert.ok(!seen.has(subjectKey(n)), `${n} repeats`)
    seen.add(subjectKey(n))
  }
  assert.ok(names.some((n) => /[^\x00-\x7f]/.test(n)), 'some names are not ASCII')
})

test('passwords are long enough and never repeat; weak ones are too short; secrets never repeat', () => {
  const passwords = Array.from({ length: 300 }, () => m.aPassword())
  for (const p of passwords) assert.ok(p.length >= MIN_PASSWORD, p)
  assert.equal(new Set(passwords).size, passwords.length)
  for (let i = 0; i < 100; i++) {
    const w = m.aWeakPassword()
    assert.ok(w.length >= 1 && w.length < MIN_PASSWORD, w)
  }
  const secrets = Array.from({ length: 200 }, () => m.aSecret())
  assert.equal(new Set(secrets).size, secrets.length)
  for (const s of secrets) assert.match(s, /^[A-Za-z0-9]{40}$/)
  assert.match(m.aSecret(12), /^[A-Za-z0-9]{12}$/)
})

test('note paths are valid, and titles, folders and tags never repeat under case folding', () => {
  const folded = new Set<string>()
  for (let i = 0; i < 200; i++) {
    const path = m.aNotePath(m.chance(0.5) ? m.aFolderPath(m.anInt(1, 3)) : '')
    assert.equal(NoteService.checkPath(path), path)
    assert.equal(classifyPath(path), 'note')
    for (const seg of path.replace(/\.md$/, '').split('/')) {
      assert.ok(!folded.has(caseFold(seg)), `${seg} repeats`)
      folded.add(caseFold(seg))
    }
  }
  const folder = m.aFolderPath(2)
  assert.equal(NoteService.checkFolder(folder), folder)
  const tags = Array.from({ length: 100 }, () => m.aTag())
  for (const t of tags) assert.match(t, /^[\p{L}\p{N}_-]+$/u)
  assert.equal(new Set(tags.map(caseFold)).size, tags.length)
  const words = Array.from({ length: 50 }, () => m.aUniqueWord())
  const text = Array.from({ length: 200 }, () => m.aParagraph()).join(' ')
  for (const w of words) assert.ok(!text.split(/[\s.]+/).includes(w), `${w} is in no sentence`)
})

test('a lane other than 0 gives other names, which never clash with lane 0', () => {
  const zero = mother('lanes')
  const one = mother('lanes', { lane: 1 })
  const a = zero.aUsername()
  const b = one.aUsername()
  assert.match(b, /-w1$/)
  assert.doesNotMatch(a, /-w\d+$/)
  assert.equal(mother('lanes', { lane: 0 }).aSentence(), mother('lanes').aSentence(), 'lane 0 is the plain stream')
})

test('the same seed gives the same values; another seed, others', () => {
  const script = `import { mother } from './test/mother.ts'
const m = mother('same-seed')
console.log(JSON.stringify([m.aUsername(), m.aPassword(), m.aGroupName(), m.aNotePath(m.aFolder()), m.aTag(), m.aSentence(), m.aTimeZone()]))`
  const run = (seed: string) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), env: { ...process.env, THOTH_TEST_SEED: seed }, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  }
  const seed = String(SEED)
  assert.equal(run(seed), run(seed))
  assert.notEqual(run(seed), run(String(SEED + 1)))
})
