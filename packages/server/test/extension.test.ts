import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { ExtensionError, ExtensionHost, Indexer, SCHEMA_VERSION, dumpIndex, openIndex, plan, type Extension, type Db, type ExtensionDb } from '@vihko/server'
import { tempDir } from './_tmp.ts'

const openDb = () => openIndex(join(tempDir('vihko-ext-'), 'index.db'))
const count = (db: Db, table: string) => (db.prepare(`select count(*) n from ${table}`).get() as { n: number }).n

/** A do-nothing extension with one table named after it. */
function ext(name: string, opts: { requires?: string[]; version?: number; open?: (db: ExtensionDb) => void; ddl?: string } = {}): Extension {
  return {
    name,
    version: opts.version ?? 1,
    requires: opts.requires,
    tables: { [`t_${name}`]: opts.ddl ?? `create table t_${name} (path text primary key, v text)` },
    extract: () => null,
    open(db) {
      opts.open?.(db)
      return { store() {}, remove() {} }
    },
  }
}

test('extensions run in topological order, ties in registration order', () => {
  const order = plan([ext('c', { requires: ['b'] }), ext('a'), ext('b', { requires: ['a'] }), ext('d')]).map((e) => e.name)
  assert.deepEqual(order, ['a', 'b', 'c', 'd'])
})

test('an invalid set of extensions is refused', () => {
  assert.throws(() => plan([ext('a', { requires: ['b'] }), ext('b', { requires: ['a'] })]), /cycle/)
  assert.throws(() => plan([ext('a', { requires: ['zzz'] })]), /not registered/)
  assert.throws(() => plan([ext('a'), ext('a')]), /duplicate/)
  assert.throws(() => plan([ext('Bad-Name')]), /invalid extension name/)
  assert.throws(() => plan([{ ...ext('a'), tables: { notes: 'create table notes (x)' } }]), /belongs to the framework/)
  assert.throws(() => plan([ext('a'), { ...ext('b'), tables: { t_a: 'create table t_a (x)' } }]), /already belongs to extension "a"/)
  assert.throws(() => plan([{ ...ext('a'), version: 0 }]), /version/)
})

test('an extension only writes its own tables and only reads what it may', () => {
  const db = openDb()
  const outcomes: Record<string, string> = {}
  const attempt = (label: string, fn: () => unknown) => {
    try { fn(); outcomes[label] = 'ok' } catch (err) { outcomes[label] = err instanceof ExtensionError ? 'refused' : `error: ${String(err)}` }
  }
  const host = new ExtensionHost(db, [
    ext('base'),
    ext('other'),
    ext('probe', {
      requires: ['base'],
      open(x) {
        attempt('write own', () => x.prepare('insert or replace into t_probe (path, v) values (?, ?)').run('a', 'b'))
        attempt('update own', () => x.prepare('update t_probe set v = ? where path = ?'))
        attempt('delete own', () => x.prepare('delete from "t_probe" where path = ?'))
        attempt('read own and required', () => x.prepare('select p.path from t_probe p join t_base b on b.path = p.path, notes n where n.path = p.path'))
        attempt('read with a cte and a function', () => x.prepare("with q as (select path from t_base) select q.path, j.value from q, json_each('[1]') j"))
        attempt('write required', () => x.prepare('insert into t_base (path) values (?)'))
        attempt('write notes', () => x.prepare("update notes set title = 'x'"))
        attempt('delete other', () => x.prepare('delete from t_other'))
        attempt('read unrelated', () => x.prepare('select * from t_other'))
        attempt('read unrelated in a subquery', () => x.prepare('select path from t_probe where path in (select path from t_other)'))
        attempt('read meta', () => x.prepare('select * from meta'))
        attempt('copy into own from unrelated', () => x.prepare('insert into t_probe select path, v from t_other'))
        attempt('ddl', () => x.prepare('drop table t_other'))
        attempt('pragma', () => x.prepare('pragma user_version = 3'))
        attempt('attach', () => x.prepare("attach database 'x.db' as x"))
        attempt('a string does not count as a table', () => x.prepare("select 'from t_other' as s from t_probe"))
      },
    }),
  ])
  host.install()
  assert.deepEqual(outcomes, {
    'write own': 'ok',
    'update own': 'ok',
    'delete own': 'ok',
    'read own and required': 'ok',
    'read with a cte and a function': 'ok',
    'write required': 'refused',
    'write notes': 'refused',
    'delete other': 'refused',
    'read unrelated': 'refused',
    'read unrelated in a subquery': 'refused',
    'read meta': 'refused',
    'copy into own from unrelated': 'refused',
    ddl: 'refused',
    pragma: 'refused',
    attach: 'refused',
    'a string does not count as a table': 'ok',
  })
})

test('an extension whose DDL creates something it did not declare is refused', () => {
  const db = openDb()
  const sneaky = ext('sneaky', { ddl: 'create table t_sneaky (x); create table elsewhere (y)' })
  assert.throws(() => new ExtensionHost(db, [sneaky]).install(), /created "elsewhere"/)
  assert.equal(db.prepare("select 1 from sqlite_master where name = 'elsewhere'").get(), undefined, 'rolled back')
  // Only a virtual table gets shadow tables named after it.
  assert.throws(() => new ExtensionHost(db, [ext('plain', { ddl: 'create table t_plain (x); create table t_plain_more (y)' })]).install(), /created "t_plain_more"/)
  new ExtensionHost(db, [ext('search', { ddl: 'create virtual table t_search using fts5(body)' })]).install()
  assert.ok(db.prepare("select 1 from sqlite_master where name = 't_search_data'").get())
})

test('versions: only what changed (and what depends on it) is stale; unregistered extensions are dropped', () => {
  const db = openDb()
  const exts = (words: number) => [ext('words', { version: words }), ext('summary', { requires: ['words'] }), ext('unrelated')]
  let host = new ExtensionHost(db, exts(1))
  assert.deepEqual([...host.install()].sort(), ['summary', 'unrelated', 'words'], 'a new index: everything')
  host.markCurrent(['summary', 'unrelated', 'words'])
  for (const t of ['t_words', 't_summary', 't_unrelated']) db.prepare(`insert into ${t} (path) values ('kept')`).run()

  host = new ExtensionHost(db, exts(1))
  assert.deepEqual([...host.install()], [], 'nothing changed')
  assert.ok(db.prepare("select 1 from t_words where path = 'kept'").get())

  host = new ExtensionHost(db, exts(2))
  assert.deepEqual([...host.install()].sort(), ['summary', 'words'], 'a bump: that extension and its dependents')
  assert.equal(count(db, 't_words'), 0, 'recreated empty')
  assert.equal(count(db, 't_summary'), 0)
  assert.equal(count(db, 't_unrelated'), 1, 'the rest untouched')
  // Until marked current, a restart still sees them stale (e.g. the rebuild was interrupted).
  host = new ExtensionHost(db, exts(2))
  assert.deepEqual([...host.install()].sort(), ['summary', 'words'])
  host.markCurrent(['summary', 'words'])

  host = new ExtensionHost(db, [ext('words', { version: 2 })])
  assert.deepEqual([...host.install()], [])
  assert.equal(db.prepare("select 1 from sqlite_master where name in ('t_summary', 't_unrelated')").get(), undefined, 'unregistered: dropped')
  assert.equal(db.prepare("select 1 from meta where key in ('ext:summary', 'ext:unrelated')").get(), undefined)
})

// --- Extensions inside the indexer -------------------------------------------

const VAULT = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))

/**
 * The example extension: words per note (body only). Its `version` changes
 * how words are counted, to see a bump rebuild it.
 */
function words(version: number, calls: Map<string, number>): Extension<number> {
  return {
    name: 'words',
    version,
    tables: {
      ext_words: `create table ext_words (path text primary key, words integer not null)`,
    },
    extract(note) {
      const list = note.text.slice(note.parsed.frontmatter.bodyStart).split(/\s+/).filter(Boolean)
      return version === 1 ? list.length : list.filter((w) => w.length > 3).length
    },
    open(db) {
      const put = db.prepare('insert or replace into ext_words (path, words) values (?, ?)')
      const del = db.prepare('delete from ext_words where path = ?')
      return {
        store(path, n) { calls.set('words', (calls.get('words') ?? 0) + 1); put.run(path, n) },
        remove(path) { del.run(path) },
      }
    },
  }
}

/** Depends on `words`: words per heading. */
function density(calls: Map<string, number>): Extension<number> {
  return {
    name: 'density',
    version: 1,
    requires: ['words'],
    tables: { ext_density: `create table ext_density (path text primary key, per_heading real not null)` },
    extract: (note, inputs) => inputs.get<number>('words') / Math.max(1, note.parsed.headings.length),
    open(db) {
      const put = db.prepare('insert or replace into ext_density (path, per_heading) values (?, ?)')
      const del = db.prepare('delete from ext_density where path = ?')
      return {
        store(path, v) { calls.set('density', (calls.get('density') ?? 0) + 1); put.run(path, v) },
        remove(path) { del.run(path) },
      }
    },
  }
}

function vault() {
  const dir = tempDir('vihko-ext-vault-')
  const notes = join(dir, 'notes')
  cpSync(VAULT, notes, { recursive: true })
  return { dir, notes, file: join(dir, 'index.db') }
}

const rows = (db: Db, table: string) => JSON.stringify(db.prepare(`select * from ${table} order by 1`).all())
const one = <T>(db: Db, sql: string) => db.prepare(sql).get() as T

/** Built-in tables and the example's, indexed from scratch. */
function freshState(notes: string, version: number) {
  const db = openDb()
  new Indexer({ notesDir: notes, db, extensions: [words(version, new Map()), density(new Map())] }).scan()
  const out = { dump: dumpIndex(db), words: rows(db, 'ext_words'), density: rows(db, 'ext_density') }
  db.close()
  return out
}

test('an extension indexes every note, and bumping its version rebuilds only it and what depends on it', () => {
  const { notes, file } = vault()
  let calls = new Map<string, number>()
  let db = openIndex(file)
  new Indexer({ notesDir: notes, db, extensions: [words(1, calls), density(calls)] }).scan()
  const total = count(db, 'notes')
  assert.equal(calls.get('words'), total)
  assert.equal(calls.get('density'), total)
  assert.equal(one<{ words: number }>(db, "select words from ext_words where path = 'Plan.md'").words, 3)
  const builtIn = dumpIndex(db)
  const plain = openDb()
  new Indexer({ notesDir: notes, db: plain }).scan()
  assert.equal(builtIn, dumpIndex(plain), 'the built-in tables are the same with or without extensions')
  db.close()

  // Rows a scan changes (folders and alerts are rewritten on every full scan).
  const scanChanges = (indexer: Indexer) => {
    const changes = () => one<{ n: number }>(db, 'select total_changes() n').n
    const before = changes()
    const r = indexer.scan()
    assert.deepEqual([r.added.length, r.changed.length, r.removed.length], [0, 0, 0])
    return changes() - before
  }

  // A restart with nothing new does no work.
  calls = new Map()
  db = openIndex(file)
  const idle = scanChanges(new Indexer({ notesDir: notes, db, extensions: [words(1, calls), density(calls)] }))
  assert.equal(calls.size, 0)
  db.close()

  // words v2: words and density are rebuilt from the files; nothing else is touched.
  calls = new Map()
  db = openIndex(file)
  const changed = scanChanges(new Indexer({ notesDir: notes, db, extensions: [words(2, calls), density(calls)] }))
  assert.equal(calls.get('words'), total)
  assert.equal(calls.get('density'), total)
  // On top of an idle scan: the two extensions' inserts and their version records. No built-in row.
  assert.equal(changed - idle, 2 * total + 2)
  assert.equal(dumpIndex(db), builtIn)
  assert.equal(one<{ words: number }>(db, "select words from ext_words where path = 'Plan.md'").words, 2, 'counted the v2 way')
  const fresh = freshState(notes, 2)
  assert.equal(rows(db, 'ext_words'), fresh.words)
  assert.equal(rows(db, 'ext_density'), fresh.density)
  db.close()

  // Unregistered: its tables go, the rest stays.
  db = openIndex(file)
  new Indexer({ notesDir: notes, db }).scan()
  assert.equal(db.prepare("select 1 from sqlite_master where name in ('ext_words', 'ext_density')").get(), undefined)
  assert.equal(dumpIndex(db), builtIn)
  db.close()
})

test('a version bump waits for the notes folder, and a note changed meanwhile is reindexed whole', () => {
  const { dir, notes, file } = vault()
  const plan = join(notes, 'Plan.md')
  utimesSync(plan, 1_700_000_000, 1_700_000_000) // whole seconds: restorable exactly
  let db = openIndex(file)
  new Indexer({ notesDir: notes, db, extensions: [words(1, new Map()), density(new Map())] }).scan()
  db.close()

  // The folder is gone (an unmounted share): nothing is recorded as rebuilt.
  const away = join(dir, 'away')
  renameSync(notes, away)
  db = openIndex(file)
  const r = new Indexer({ notesDir: notes, db, extensions: [words(2, new Map()), density(new Map())] }).scan()
  assert.equal(r.aborted, 'root_unavailable')
  assert.equal(db.prepare("select 1 from meta where key in ('ext:words', 'ext:density')").get(), undefined, 'not recorded as current')
  db.close()
  renameSync(away, notes)

  // Back, with a note edited while the service was down (same size and mtime: only the hash tells).
  const { size } = statSync(plan)
  writeFileSync(plan, '# Plan de hoy'.padEnd(size, '.'))
  utimesSync(plan, 1_700_000_000, 1_700_000_000)
  assert.equal(statSync(plan).mtimeMs, 1_700_000_000_000)
  db = openIndex(file)
  new Indexer({ notesDir: notes, db, extensions: [words(2, new Map()), density(new Map())] }).scan()
  const fresh = freshState(notes, 2)
  assert.equal(dumpIndex(db), fresh.dump)
  assert.equal(rows(db, 'ext_words'), fresh.words)
  assert.equal(rows(db, 'ext_density'), fresh.density)
  assert.equal(one<{ title: string }>(db, "select title from notes where path = 'Plan.md'").title, 'Plan de hoy..')
  db.close()
})

test('an index from before extensions is rebuilt once', () => {
  const { notes, file } = vault()
  // The single-version layout: schema 6, every table fixed.
  const raw = new Database(file)
  raw.exec(`create table meta (key text primary key, value text not null); insert into meta values ('schema_version', '6');
    create table notes (path text primary key); insert into notes values ('stale.md');
    create table tags (path text, tag text, source text); insert into tags values ('stale.md', 'old', 'inline')`)
  raw.close()
  const db = openIndex(file)
  new Indexer({ notesDir: notes, db }).scan()
  assert.equal(dumpIndex(db), freshState(notes, 1).dump)
  assert.equal(one<{ value: string }>(db, "select value from meta where key = 'schema_version'").value, String(SCHEMA_VERSION))
  const recorded = (db.prepare("select key from meta where key like 'ext:%' order by key").all() as { key: string }[]).map((r) => r.key)
  assert.deepEqual(recorded, ['ext:comment_anchors', 'ext:fields', 'ext:fts', 'ext:headings', 'ext:images', 'ext:links', 'ext:tags'])
  db.close()
})
