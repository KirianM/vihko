// What the release workflow checks and works out for a tag (scripts/release.ts):
// the tag against package.json, the CHANGELOG.md section that becomes the
// GitHub Release's text, and the image tags (D-042: a stable version moves
// X.Y, X and latest forward, a pre-release gets only its exact tag).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { changelogSection, imageTags, parseVersion, previousStable, tagVersion, versionMismatch } from '../scripts/release.ts'
import { mother } from './mother.ts'

const m = mother(import.meta.url)
const n = () => m.anInt(0, 30)
/** A stable version, `major.minor.patch`. */
const aStable = () => `${m.anInt(1, 30)}.${n()}.${n()}`
/** A pre-release of `base` (a stable version): `-rc.2`, `-beta.1`, `-alpha`… */
const aPrerelease = (base = aStable()) => `${base}-${m.pick(['rc', 'beta', 'alpha'])}${m.chance(0.8) ? `.${m.anInt(1, 9)}` : ''}`
/** A Keep a Changelog section's heading for `version`, in any of the accepted forms. */
const heading = (version: string) => m.pick([`## [${version}] - 2026-${String(m.anInt(1, 12)).padStart(2, '0')}-${String(m.anInt(1, 28)).padStart(2, '0')}`, `## [${version}]`, `## ${version}`])
/** A section's body: a subsection or two with a few entries. */
const aBody = () => Array.from({ length: m.anInt(1, 2) }, () => `### ${m.pick(['Added', 'Changed', 'Fixed', 'Security'])}\n\n${Array.from({ length: m.anInt(1, 4) }, () => `- ${m.aSentence()}`).join('\n')}`).join('\n\n') + '\n'

test('a release tag is v and a version; anything else is refused, saying what a tag looks like', () => {
  const stable = aStable()
  const pre = aPrerelease()
  assert.equal(tagVersion(`v${stable}`), stable)
  assert.equal(tagVersion(`v${pre}`), pre)
  // The cases under test: no v, missing parts, leading zeros, build metadata, a moving tag's name.
  for (const bad of [stable, `v${stable.split('.').slice(0, 2).join('.')}`, 'v01.2.3', `v${stable}+build.5`, 'v1', 'latest', `V${stable}`]) {
    assert.throws(() => tagVersion(bad), /is not a release tag: v and a version, such as v1\.2\.3/, bad)
  }
})

test('the tag must match package.json, and the message says how to fix it', () => {
  const version = m.chance(0.5) ? aStable() : aPrerelease()
  assert.equal(versionMismatch(`v${version}`, version), null)
  const other = `${m.anInt(31, 60)}.${n()}.${n()}` // a major aStable never draws: another version
  const message = versionMismatch(`v${version}`, other)
  assert.ok(message?.includes(`v${version}`) && message.includes(JSON.stringify(other)), message ?? '')
  assert.match(message!, /bump the version first/)
  assert.match(versionMismatch(`v${version}`, undefined)!, /\(undefined\)/, 'a package.json without a version')
})

test("the CHANGELOG.md section is the version's own, up to the next version, without the link definitions", () => {
  const [newer, version, older] = [aBody(), aBody(), aBody()]
  const v = aStable()
  const changelog = [
    '# Changelog', '', m.aSentence(), '',
    '## [Unreleased]', '', newer,
    heading(v), '', version,
    heading(`0.${n()}.${n()}`), '', older,
    `[Unreleased]: https://example.org/compare/v${v}...HEAD`,
    `[${v}]: https://example.org/releases/tag/v${v}`, '',
  ].join('\n')
  assert.equal(changelogSection(changelog, v), version)
  assert.equal(changelogSection(changelog.replaceAll('\n', '\r\n'), v), version, 'CRLF line ends')
})

test('the last section ends before the link definitions that close the file', () => {
  const v = aStable()
  const body = aBody()
  const changelog = `# Changelog\n\n${heading(v)}\n\n${body}\n[${v}]: https://example.org/releases/tag/v${v}\n`
  assert.equal(changelogSection(changelog, v), body)
})

test("a version's section is never its pre-release's, nor the other way round", () => {
  const v = aStable()
  const pre = aPrerelease(v)
  const [stableBody, preBody] = [aBody(), aBody()]
  const both = `# Changelog\n\n${heading(v)}\n\n${stableBody}\n${heading(pre)}\n\n${preBody}`
  assert.equal(changelogSection(both, v), stableBody)
  assert.equal(changelogSection(both, pre), preBody)
  const onlyPre = `# Changelog\n\n${heading(pre)}\n\n${preBody}`
  assert.equal(changelogSection(onlyPre, v), null, 'the stable version has no section yet')
})

test('no section, or an empty one, is none: the workflow fails before pushing anything', () => {
  const v = aStable()
  assert.equal(changelogSection('', v), null)
  assert.equal(changelogSection(`# Changelog\n\n## [Unreleased]\n\n${aBody()}`, v), null)
  assert.equal(changelogSection(`# Changelog\n\n${heading(v)}\n\n\n${heading(`0.${n()}.${n()}`)}\n\n${aBody()}`, v), null)
})

test('a pre-release gets only its exact tag, never X, X.Y or latest', () => {
  const pre = aPrerelease()
  const released = Array.from({ length: m.anInt(0, 5) }, () => `v${aStable()}`)
  assert.deepEqual(imageTags(pre, released), { tags: [pre], latest: false })
})

test('a stable version newer than every release gets X.Y.Z, X.Y, X and latest', () => {
  const v = parseVersion(aStable())!
  const version = `${v.major}.${v.minor}.${v.patch}`
  // Older releases, and pre-releases of a later version (they move nothing).
  const released = [
    `v${v.major}.${v.minor}.${v.patch}-rc.1`,
    ...(v.patch > 0 ? [`v${v.major}.${v.minor}.${v.patch - 1}`] : []),
    ...(v.major > 1 ? [`v${v.major - 1}.${n()}.${n()}`] : []),
    `v${v.major + 1}.0.0-rc.1`,
    'not-a-release',
  ]
  assert.deepEqual(imageTags(version, m.shuffle(released)), { tags: [version, `${v.major}.${v.minor}`, `${v.major}`, 'latest'], latest: true })
  assert.deepEqual(imageTags(version, []), { tags: [version, `${v.major}.${v.minor}`, `${v.major}`, 'latest'], latest: true }, 'the first release')
})

test('a fix for an older line never takes a moving tag back', () => {
  const major = m.anInt(1, 20)
  const minor = m.anInt(0, 20)
  const fix = `${major}.${minor}.${m.anInt(1, 20)}`
  // A newer minor of the same major: the fix gets X.Y only.
  assert.deepEqual(imageTags(fix, [`v${major}.${minor + 1}.0`]), { tags: [fix, `${major}.${minor}`], latest: false })
  // A newer major: the fix gets X.Y and X, not latest.
  assert.deepEqual(imageTags(fix, [`v${major + 1}.0.0`]), { tags: [fix, `${major}.${minor}`, `${major}`], latest: false })
  // A newer patch of the same minor (tagged out of order): only the exact tag.
  const [a, b] = [m.anInt(0, 10), m.anInt(11, 20)]
  assert.deepEqual(imageTags(`${major}.${minor}.${a}`, [`v${major}.${minor}.${b}`]), { tags: [`${major}.${minor}.${a}`], latest: false })
})

test('the upgrade smoke test starts from the newest stable release older than the one being made', () => {
  // Literal versions: the order of a repository's releases is the case under test.
  const tags = ['v1.0.0-rc.1', 'v1.0.0', 'v1.0.1', 'v1.1.0-rc.1', 'v1.1.0', 'v1.2.0', 'latest', 'v2.0.0-rc.1']
  assert.equal(previousStable('1.1.0', tags), '1.0.1', 'itself excluded')
  assert.equal(previousStable('1.1.0-rc.2', tags), '1.0.1', 'a candidate comes from the stable line before it, never a candidate')
  assert.equal(previousStable('1.2.1', tags), '1.2.0')
  assert.equal(previousStable('1.0.2', tags), '1.0.1', 'a fix for an older line comes from that line, not from a newer one')
  assert.equal(previousStable('2.0.0', tags), '1.2.0')
  assert.equal(previousStable('1.0.0', tags), null, 'the first stable release has nothing to come from')
  assert.equal(previousStable('1.0.0-rc.2', tags), null)
  assert.throws(() => previousStable('v1.2.3', tags), /is not a version/)
})
