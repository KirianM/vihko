import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMap, isScalar, type Document, type Pair, type Scalar, type YAMLMap } from 'yaml'
import { WORKSPACE_MIGRATIONS, WORKSPACE_VERSION, deleteTopKey, formatVersion, migrateWorkspaceText, parseWorkspaceConfig, rewriteYaml, type WorkspaceMigration } from '@vihko/core'
import { parseYamlDocument } from '../src/yaml.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** A top-level key of `doc` (its pair), if it has it. */
const topPair = (doc: Document, key: string) => (isMap(doc.contents) ? (doc.contents as YAMLMap).items.find((p) => isScalar(p.key) && p.key.value === key) as Pair<Scalar> | undefined : undefined)

/**
 * A made-up format change: the series were once under `dailyNotes`, and are
 * `daily` now. The key is renamed in place, so its comments stay with it.
 */
const renameSeries: WorkspaceMigration = {
  id: 'daily-notes-renamed',
  description: 'dailyNotes is now daily',
  version: 2,
  apply(doc) {
    const old = topPair(doc, 'dailyNotes')
    if (!old || topPair(doc, 'daily')) return false
    old.key.value = 'daily'
    return true
  },
}

/** Another: `links.aliases: yes` (a string) became a boolean. Changes a value deep in the file. */
const aliasesBoolean: WorkspaceMigration = {
  id: 'links-aliases-boolean',
  description: 'links.aliases "yes"/"no" is now true/false',
  version: 2,
  apply(doc) {
    const node = doc.getIn(['links', 'aliases'], true)
    if (!isScalar(node) || (node.value !== 'yes' && node.value !== 'no')) return false
    doc.setIn(['links', 'aliases'], node.value === 'yes')
    return true
  },
}

const series = m.anId()
const folder = m.aFolder()
const templates = m.aFolder()
const excluded = m.aFolder()

/**
 * A file written by hand, the way the README shows it: comments aligned at
 * the end of lines and on their own, blank lines, a list not indented under
 * its key, a key vihko doesn't know, and no line break at the end. Every byte
 * of it outside what a migration changes must survive.
 */
const FILE = `# Workspace settings
version: 1                  # optional
templates: ${JSON.stringify(templates)}   # folder offered for templates

dailyNotes:                 # daily-note series
  ${series}:
    folder: ${JSON.stringify(`${folder}/{user}`)}  # one per person
    name: "{YYYY}-{MM}-{DD}"
links:
  aliases:   yes            # frontmatter aliases resolve links
history:
  exclude:
  - ${JSON.stringify(`${excluded}/**`)}
  - "**/*.pdf"
someday: { a: 1,   b: 2 }   # a key vihko doesn't know
# the end`

test('a migration rewrites only what it changes: every other byte of the file stays, comments and unknown keys included', () => {
  const r = migrateWorkspaceText(FILE, [renameSeries])
  assert.equal(r.kind, 'migrated')
  if (r.kind !== 'migrated') return
  assert.deepEqual(r.applied, [{ id: renameSeries.id, description: renameSeries.description }])
  // Only the key's name changes, and the format's number: each line keeps its spacing and comment.
  assert.equal(r.text, FILE.replace('dailyNotes:', 'daily:').replace('version: 1 ', 'version: 2 '))
  // Once the rest of the old file is migrated too, vihko reads the series.
  const cfg = parseWorkspaceConfig(r.text.replace('aliases:   yes', 'aliases: true'))
  assert.ok(cfg.ok, JSON.stringify(cfg))
  assert.deepEqual(cfg.config.daily.map((s) => s.id), [series])
})

test('migrations run in order, each where its old form is; a value deep in the file changes on its own line', () => {
  const r = migrateWorkspaceText(FILE, [renameSeries, aliasesBoolean])
  assert.equal(r.kind, 'migrated')
  if (r.kind !== 'migrated') return
  assert.deepEqual(r.applied.map((a) => a.id), [renameSeries.id, aliasesBoolean.id])
  assert.equal(r.text, FILE.replace('dailyNotes:', 'daily:').replace('aliases:   yes', 'aliases:   true').replace('version: 1 ', 'version: 2 '))
})

test('a migration applies once: on its own output, and on a file already in the new form, nothing happens', () => {
  const r = migrateWorkspaceText(FILE, [renameSeries, aliasesBoolean])
  assert.equal(r.kind, 'migrated')
  if (r.kind !== 'migrated') return
  assert.deepEqual(migrateWorkspaceText(r.text, [renameSeries, aliasesBoolean]), { kind: 'none' })
  // Old and new forms side by side: the new one wins, nothing is touched.
  assert.deepEqual(migrateWorkspaceText(`daily: {}\n${FILE.replace('aliases:   yes', 'aliases: true')}`, [renameSeries, aliasesBoolean]), { kind: 'none' })
  // No migrations at all (today's list): nothing is even parsed.
  assert.deepEqual(migrateWorkspaceText('{ not yaml', []), { kind: 'none' })
})

test('a file that isn\'t valid YAML, a migration that throws, and one that would apply at every start: nothing is written', () => {
  const invalid = migrateWorkspaceText('dailyNotes: [unclosed\n', [renameSeries])
  assert.equal(invalid.kind, 'invalid')

  const detail = m.aSentence()
  const throws: WorkspaceMigration = { id: 'throws', description: m.aSentence(), version: 2, apply: () => { throw new Error(detail) } }
  assert.deepEqual(migrateWorkspaceText(FILE, [renameSeries, throws]), { kind: 'failed', migration: { id: throws.id, description: throws.description }, detail })

  // Always "changes" something: it would rewrite the file at every start.
  let n = 0
  const restless: WorkspaceMigration = { id: 'restless', description: m.aSentence(), version: 2, apply: (doc) => { doc.set('counter', ++n); return true } }
  const r = migrateWorkspaceText(FILE, [restless])
  assert.equal(r.kind, 'failed')
  if (r.kind === 'failed') assert.equal(r.migration.id, restless.id)
})

test('a migration that adds and removes keys: the rest of the file stays; an empty file gets just the new key and the format\'s version', () => {
  const move: WorkspaceMigration = {
    id: 'someday-moved',
    description: 'someday is now links.someday',
    version: 2,
    apply(doc) {
      if (!doc.has('someday') || doc.hasIn(['links', 'someday'])) return false
      doc.setIn(['links', 'someday'], doc.get('someday', true))
      doc.delete('someday')
      return true
    },
  }
  const r = migrateWorkspaceText(FILE, [move])
  assert.equal(r.kind, 'migrated')
  if (r.kind !== 'migrated') return
  const data = parseYamlDocument(r.text).toJS() as { links: unknown; someday?: unknown }
  assert.deepEqual(data.links, { aliases: 'yes', someday: { a: 1, b: 2 } })
  assert.equal('someday' in data, false)
  // Every other line is the file's own.
  for (const line of FILE.split('\n').filter((l) => !l.startsWith('someday') && !l.startsWith('version'))) assert.ok(r.text.split('\n').includes(line), `kept: ${line}`)
  assert.deepEqual(migrateWorkspaceText(r.text, [move]), { kind: 'none' })

  const seed: WorkspaceMigration = { id: 'seed', description: 'adds links', version: 2, apply: (doc) => (doc.has('links') ? false : (doc.set('links', { aliases: true }), true)) }
  const empty = migrateWorkspaceText('# nothing yet\n', [seed])
  assert.equal(empty.kind, 'migrated')
  if (empty.kind !== 'migrated') return
  assert.ok(empty.text.startsWith('# nothing yet\n'), empty.text)
  assert.deepEqual(parseYamlDocument(empty.text).toJS(), { version: 2, links: { aliases: true } })
})

test('version: a rewrite raises it to the migrations\' format (added first if missing), never lowers it, and leaves an invalid one alone', () => {
  const later: WorkspaceMigration = { ...aliasesBoolean, id: 'later', version: 3 }
  const old = `# settings\ndailyNotes: {}\n`
  // Missing: added, as the first key.
  const added = migrateWorkspaceText(old, [renameSeries])
  assert.ok(added.kind === 'migrated')
  assert.deepEqual(parseYamlDocument(added.text).toJS(), { version: 2, daily: {} })
  assert.match(added.text, /^(# settings\n)?version: 2\n/)
  // Lower: raised to the highest of the list, even if only an earlier migration applied.
  const raised = migrateWorkspaceText(`version: 1\n${old}`, [renameSeries, later])
  assert.ok(raised.kind === 'migrated')
  assert.deepEqual(raised.applied.map((a) => a.id), [renameSeries.id])
  assert.equal((parseYamlDocument(raised.text).toJS() as { version: number }).version, 3)
  // Higher (a newer vihko's file with an old form in it): kept.
  const newer = migrateWorkspaceText(`version: 7\n${old}`, [renameSeries])
  assert.ok(newer.kind === 'migrated')
  assert.equal((parseYamlDocument(newer.text).toJS() as { version: number }).version, 7)
  // Not a whole number: the workspace's own alert says so; the migration still applies.
  const odd = migrateWorkspaceText(`version: two\n${old}`, [renameSeries])
  assert.ok(odd.kind === 'migrated')
  assert.equal((parseYamlDocument(odd.text).toJS() as { version: string }).version, 'two')
  // Nothing to migrate: the file isn't rewritten for its number alone.
  assert.deepEqual(migrateWorkspaceText('version: 1\ndaily: {}\n', [renameSeries]), { kind: 'none' })
})

test('version: vihko\'s own migrations go from 2 up, in order, and WORKSPACE_VERSION is their format', () => {
  let last = 2
  for (const mg of WORKSPACE_MIGRATIONS) {
    assert.ok(Number.isInteger(mg.version) && mg.version >= last, `${mg.id}: version ${mg.version}`)
    last = mg.version
  }
  assert.equal(WORKSPACE_VERSION, formatVersion(WORKSPACE_MIGRATIONS))
  assert.equal(formatVersion([]), 1)
})

test('a top-level key removed from a YAML file: its lines go, every other byte stays; a comment above it stays too; nothing left is an empty file', () => {
  const [a, b, c] = [m.aSentence(), m.aSentence(), m.aSentence()]
  // Literal layout: the comments and spacing around the key are the case under test.
  const text = `# ${a}\ngone: [x, y]   # ${b}\nkept:    1      # ${c}\n\n# ${b}\nalso: 2\n`
  assert.equal(rewriteYaml(text, (d) => deleteTopKey(d, 'gone')), `# ${a}\nkept:    1      # ${c}\n\n# ${b}\nalso: 2\n`)
  assert.equal(rewriteYaml(text, (d) => deleteTopKey(d, 'also')), `# ${a}\ngone: [x, y]   # ${b}\nkept:    1      # ${c}\n\n# ${b}\n`)
  assert.equal(rewriteYaml(text, (d) => deleteTopKey(d, 'missing')), null)
  assert.equal(rewriteYaml('only: 1\n', (d) => deleteTopKey(d, 'only')), '')
  assert.equal(rewriteYaml('a: [', (d) => deleteTopKey(d, 'a')), null, 'not YAML: nothing')
})
