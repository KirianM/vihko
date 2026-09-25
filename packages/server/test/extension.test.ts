import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExtensionError, ExtensionHost, openIndex, plan, type Extension, type Db, type ExtensionDb } from '@thoth/server'

const openDb = () => openIndex(join(mkdtempSync(join(tmpdir(), 'thoth-ext-')), 'index.db'))
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
