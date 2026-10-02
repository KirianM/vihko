// What the release workflow (.github/workflows/release.yml) checks and works
// out for a tag, before anything is pushed:
//
//   node scripts/release.ts v1.2.3                     # check, and hand the results to the workflow
//   node scripts/release.ts v1.2.3 --notes notes.md    # …and write the version's CHANGELOG.md section
//
// It fails, saying why, when the tag is not a version (`v` and semver, no
// build metadata), when it doesn't match the root package.json's version, or
// when CHANGELOG.md has no section for it. Otherwise it prints what it found
// and, on GitHub Actions, writes the step's outputs: `version`, `prerelease`,
// `latest` and `tags` (the image tags, as docker/metadata-action lines).
//
// The image tags: a stable 1.2.3 gets 1.2.3, 1.2, 1 and latest; a 0.x
// version only 0.2.3 and 0.2 (before 1.0 a minor version may change things
// incompatibly, so nothing moves anyone across minors); a pre-release (any
// `-…` suffix) only its exact tag. A moving tag goes only
// forward: a fix for an older line (1.1.5 once 1.2.0 is out) doesn't take 1
// or latest back to it. The functions are pure, so test/release.test.ts
// checks them without git, GitHub or files.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Version { major: number; minor: number; patch: number; prerelease: string }

const NUMBER = '(0|[1-9]\\d*)'
const IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)'
/** Semantic Versioning 2.0.0 without build metadata (`+…`, which a Docker tag can't hold). */
const SEMVER = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?$`)

/** A version (`1.2.3`, `1.0.0-rc.1`), or null. */
export function parseVersion(text: string): Version | null {
  const m = SEMVER.exec(text)
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? '' } : null
}

/** The version a release tag names (`v1.2.3` → `1.2.3`); throws, saying what a tag looks like, on anything else. */
export function tagVersion(tag: string): string {
  if (!tag.startsWith('v') || !parseVersion(tag.slice(1))) {
    throw new Error(`${JSON.stringify(tag)} is not a release tag: v and a version, such as v1.2.3 or v1.0.0-rc.1 (no build metadata)`)
  }
  return tag.slice(1)
}

/** Why `tag` can't be released from a commit whose package.json says `packageVersion`, or null when they agree. */
export function versionMismatch(tag: string, packageVersion: unknown): string | null {
  const version = tagVersion(tag)
  if (packageVersion === version) return null
  return `The tag ${tag} doesn't match the version in package.json (${JSON.stringify(packageVersion)}). `
    + `Tag the commit whose package.json says "${version}", or bump the version first (DEVELOPMENT.md, Releasing).`
}

/**
 * The section of a Keep a Changelog file for `version`: what follows its
 * `## [1.2.3] - 2026-10-01` heading (brackets and date optional) up to the next
 * `## ` heading, without the link definitions that close the file. Null when
 * there is no such section or it says nothing.
 */
export function changelogSection(changelog: string, version: string): string | null {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const heading = new RegExp(`^##\\s+\\[?${escaped}\\]?(?=\\s|$)`)
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((l) => heading.test(l))
  if (start < 0) return null
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
  if (end < 0) end = lines.length
  const body = lines.slice(start + 1, end)
  while (body.length && (body.at(-1)!.trim() === '' || /^\[[^\]]+\]:\s*\S/.test(body.at(-1)!))) body.pop()
  while (body.length && body[0]!.trim() === '') body.shift()
  return body.length ? `${body.join('\n')}\n` : null
}

const compare = (a: Version, b: Version) => a.major - b.major || a.minor - b.minor || a.patch - b.patch

/**
 * The image tags for `version`, given the tags already in the repository
 * (`released`: any names; those that aren't stable release tags are
 * ignored), and whether it is the latest release. A moving tag (1.2, 1,
 * latest) is set only when no stable release it covers is newer.
 */
export function imageTags(version: string, released: string[]): { tags: string[]; latest: boolean } {
  const v = parseVersion(version)
  if (!v) throw new Error(`${JSON.stringify(version)} is not a version`)
  if (v.prerelease) return { tags: [version], latest: false }
  const stable = released
    .map((t) => (t.startsWith('v') ? parseVersion(t.slice(1)) : null))
    .filter((r): r is Version => r !== null && r.prerelease === '')
  const newest = (covers: (r: Version) => boolean) => stable.every((r) => !covers(r) || compare(r, v) <= 0)
  const tags = [version]
  if (newest((r) => r.major === v.major && r.minor === v.minor)) tags.push(`${v.major}.${v.minor}`)
  const latest = newest(() => true)
  if (v.major === 0) return { tags, latest }
  if (newest((r) => r.major === v.major)) tags.push(`${v.major}`)
  if (latest) tags.push('latest')
  return { tags, latest }
}

/**
 * The stable release an installation of `version` would come from, for the
 * upgrade smoke test (scripts/upgrade-smoke.ts): the newest stable tag of
 * `released` (any names; the rest are ignored) older than `version`, without
 * the `v`. A pre-release counts as its version (1.1.0-rc.1 comes from 1.0.x,
 * as 1.1.0 does); a fix for an older line (1.1.5 once 1.2.0 is out) from that
 * line, never from a newer one. Null when there is none.
 */
export function previousStable(version: string, released: string[]): string | null {
  const v = parseVersion(version)
  if (!v) throw new Error(`${JSON.stringify(version)} is not a version`)
  const older = released
    .map((t) => (t.startsWith('v') ? parseVersion(t.slice(1)) : null))
    .filter((r): r is Version => r !== null && r.prerelease === '' && compare(r, v) < 0)
    .sort(compare)
  const last = older.at(-1)
  return last ? `${last.major}.${last.minor}.${last.patch}` : null
}

/** One GitHub Actions output, safe for any text (a delimiter the value can't contain). */
function output(file: string, name: string, value: string) {
  const delimiter = `EOF_${randomBytes(16).toString('hex')}`
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
}

function main(args: string[]) {
  const [tag, flag, notesFile] = args
  if (!tag || (flag !== undefined && (flag !== '--notes' || !notesFile)) || args.length > 3) {
    throw new Error('usage: node scripts/release.ts <tag> [--notes <file>]')
  }
  const root = fileURLToPath(new URL('..', import.meta.url))
  const version = tagVersion(tag)
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }
  const mismatch = versionMismatch(tag, pkg.version)
  if (mismatch) throw new Error(mismatch)

  let changelog: string
  try { changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8') } catch { changelog = '' }
  const notes = changelogSection(changelog, version)
  if (notes === null) {
    throw new Error(`CHANGELOG.md has no section for ${version}: add "## [${version}] - <date>" with its changes before tagging (DEVELOPMENT.md, Releasing).`)
  }

  const git = spawnSync('git', ['tag', '--list', 'v*'], { cwd: root, encoding: 'utf8' })
  if (git.status !== 0) throw new Error(`git tag --list failed: ${git.stderr || git.error?.message}`)
  const { tags, latest } = imageTags(version, git.stdout.split('\n').filter((t) => t && t !== tag))
  const prerelease = parseVersion(version)!.prerelease !== ''

  console.log(`${tag}: version ${version}${prerelease ? ' (pre-release)' : ''}, matches package.json`)
  console.log(`image tags: ${tags.join(', ')}`)
  console.log(`CHANGELOG.md section: ${notes.split('\n').length - 1} lines`)
  if (notesFile) writeFileSync(notesFile, notes)
  const out = process.env.GITHUB_OUTPUT
  if (out) {
    output(out, 'version', version)
    output(out, 'prerelease', String(prerelease))
    output(out, 'latest', String(latest))
    output(out, 'tags', tags.map((t) => `type=raw,value=${t}`).join('\n'))
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    // On GitHub Actions, as an error annotation on the run's summary.
    console.error(`${process.env.GITHUB_ACTIONS ? '::error::' : ''}${(err as Error).message}`)
    process.exit(1)
  }
}
