// Indexer extensions: how index.db is split into independent pieces.
//
// The framework (indexer.ts) walks the notes folder, detects what changed,
// parses each changed note once and keeps the note registry (`notes`), the
// folders and the alerts. Everything else derived from a note's content is
// produced by an extension: a named, versioned unit that owns some tables.
//
// An extension declares:
// - `name` and `version`: bumping the version drops and rebuilds its tables
//   (and those of the extensions that depend on it) from the files, without
//   touching the rest of the index.
// - `tables`: the tables it owns, with their DDL (indexes included). Nobody
//   else writes to them.
// - `requires`: the extensions it depends on. They form a DAG: the indexer
//   runs extensions in topological order, hands each one the facts its
//   requirements extracted for the same note, and lets it read their tables.
//
// Work is split in two phases, so a heavy extension (embeddings, M7) can move
// the pure part to a worker thread later without changing the contract:
// - `extract(note, inputs)`: pure. It sees the note's text and what the
//   framework parsed from it, nothing else: no database, no filesystem.
// - `open(db)` returns the writer that stores those facts. It gets a guarded
//   handle on index.db, never the notes folder: an extension can't write to
//   notes, can't write outside its own tables and can only read tables that
//   are rebuilt from the files (its own, its requirements', the registry).
//   The guard keeps honest code honest; it is not a sandbox.
//
// The index stays derived and disposable (D-011): every extension's rows must
// come from the files alone, so deleting index.db and rescanning rebuilds
// exactly the same thing.
//
// Everything runs inside the indexer's write transaction today. A heavy
// extension (embeddings) would keep `extract` cheap (chunking) and have its
// writer queue `(path, hash)` in its own table, for a worker thread to fill
// later and drop when the hash no longer matches. That mode isn't built yet.
import type { Extracted } from '@thoth/core'
import type { Db } from './db.ts'

/** What an extension sees of a note: its text and what the framework derived from it. */
export interface NoteSnapshot {
  readonly path: string
  readonly text: string
  /** Content hash of `text`. */
  readonly hash: string
  /** The shared parse (the same parser as the editor, D-021). */
  readonly parsed: Readonly<Extracted>
  readonly uid: string | null
  readonly title: string
  readonly aliases: readonly string[]
}

/** Facts extracted by the extensions a given one requires, for the same note. */
export interface Inputs {
  /** Throws if `name` is not among the extension's `requires`. */
  get<T>(name: string): T
}

/** A batch the indexer has just applied: what a `finalize` works from. */
export interface ChangeSet {
  /** Notes (re)indexed in the batch: added or changed. */
  readonly indexed: ReadonlySet<string>
  /** Notes removed from the index in the batch. */
  readonly removed: ReadonlySet<string>
}

export interface Extension<Facts = unknown> {
  /** Lowercase identifier, unique. */
  readonly name: string
  /** Bump it whenever the tables or what goes in them change. */
  readonly version: number
  readonly requires?: readonly string[]
  /** Tables it owns: name → DDL creating that table and its indexes. */
  readonly tables: Readonly<Record<string, string>>
  /** Pure: the facts this extension keeps for the note. */
  extract(note: NoteSnapshot, inputs: Inputs): Facts
  /** Prepares the writer. Called again whenever its tables are recreated. */
  open(db: ExtensionDb): ExtensionWriter<Facts>
}

export interface ExtensionWriter<Facts = unknown> {
  /** Replaces every row this extension holds for `path` with `facts`. */
  store(path: string, facts: Facts): void
  /** Removes every row this extension holds for `path`. */
  remove(path: string): void
  /** Optional work across notes after a batch (e.g. resolving links). Same transaction. */
  finalize?(changes: ChangeSet): void
}

/** A statement on index.db, without access to the connection behind it. */
export interface Statement {
  run(...params: unknown[]): { changes: number }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

/** The only door an extension has to index.db. */
export interface ExtensionDb {
  /**
   * Prepares a statement after checking it: `select`/`with` over readable
   * tables, or `insert`/`replace`/`update`/`delete` on the extension's own
   * tables. Anything else (DDL, pragmas, attach, transactions) is refused.
   */
  prepare(sql: string): Statement
}

export class ExtensionError extends Error {}

/** Tables the framework owns (db.ts). Extensions may read the first two. */
export const FRAMEWORK_TABLES = ['notes', 'folders', 'alerts', 'meta'] as const
const FRAMEWORK_READABLE = ['notes', 'folders']

const NAME = /^[a-z][a-z0-9_]*$/

/**
 * Validates the set and returns it in topological order (ties keep the
 * registration order, so the order is deterministic). Fails on duplicate or
 * invalid names, missing requirements, cycles and clashing table names.
 */
export function plan(extensions: readonly Extension[]): Extension[] {
  const byName = new Map<string, Extension>()
  const tableOwner = new Map<string, string>(FRAMEWORK_TABLES.map((t) => [t, 'the framework']))
  for (const e of extensions) {
    if (!NAME.test(e.name)) throw new ExtensionError(`invalid extension name "${e.name}"`)
    if (byName.has(e.name)) throw new ExtensionError(`duplicate extension "${e.name}"`)
    if (!Number.isInteger(e.version) || e.version < 1) throw new ExtensionError(`extension "${e.name}": version must be a positive integer`)
    byName.set(e.name, e)
    for (const t of Object.keys(e.tables)) {
      if (!NAME.test(t)) throw new ExtensionError(`extension "${e.name}": invalid table name "${t}"`)
      const owner = tableOwner.get(t)
      if (owner) throw new ExtensionError(`extension "${e.name}": table "${t}" already belongs to ${owner}`)
      tableOwner.set(t, `extension "${e.name}"`)
    }
  }
  for (const e of extensions) {
    for (const r of e.requires ?? []) if (!byName.has(r)) throw new ExtensionError(`extension "${e.name}" requires "${r}", which is not registered`)
  }
  const order: Extension[] = []
  const placed = new Set<string>()
  while (order.length < extensions.length) {
    const next = extensions.find((e) => !placed.has(e.name) && (e.requires ?? []).every((r) => placed.has(r)))
    if (!next) {
      const left = extensions.filter((e) => !placed.has(e.name)).map((e) => e.name)
      throw new ExtensionError(`dependency cycle among extensions: ${left.join(', ')}`)
    }
    order.push(next)
    placed.add(next.name)
  }
  return order
}

/** `name` and every extension it requires, directly or not. */
function ancestors(name: string, byName: Map<string, Extension>, out = new Set<string>()): Set<string> {
  for (const r of byName.get(name)?.requires ?? []) {
    if (!out.has(r)) { out.add(r); ancestors(r, byName, out) }
  }
  return out
}

interface Installed { version: number; tables: string[] }

/**
 * Runs a set of extensions over index.db: installs their tables, keeps track
 * of their versions (in `meta`, one `ext:<name>` key each) and dispatches the
 * indexer's work to them in topological order.
 */
export class ExtensionHost {
  readonly order: readonly Extension[]
  private byName: Map<string, Extension>
  private writers = new Map<string, ExtensionWriter>()
  private requires = new Map<string, Set<string>>()
  private db: Db

  constructor(db: Db, extensions: readonly Extension[]) {
    this.db = db
    this.order = plan(extensions)
    this.byName = new Map(this.order.map((e) => [e.name, e]))
    for (const e of this.order) this.requires.set(e.name, new Set(e.requires ?? []))
  }

  /**
   * Brings the tables in line with the code. An extension whose recorded
   * version or tables differ from its declaration (or that was never
   * installed) is stale, and so is everything that depends on it: their
   * tables are dropped and created empty. Tables of extensions no longer
   * registered are dropped. Returns the stale extensions, which need every
   * note again; `markCurrent` records them once that's done.
   */
  install(): Set<string> {
    const recorded = this.recorded()
    const stale = new Set<string>()
    for (const e of this.order) {
      const r = recorded.get(e.name)
      const tables = Object.keys(e.tables)
      const same = r && r.version === e.version && r.tables.length === tables.length && r.tables.every((t, i) => t === tables[i])
      if (!same || (e.requires ?? []).some((d) => stale.has(d))) stale.add(e.name)
    }
    this.db.transaction(() => {
      for (const [name, r] of recorded) {
        if (this.byName.has(name)) continue
        for (const t of r.tables) this.db.exec(`drop table if exists "${t}"`)
        this.db.prepare('delete from meta where key = ?').run('ext:' + name)
      }
      for (const e of this.order) {
        if (!stale.has(e.name)) continue
        // What it had (maybe other tables in an older version) and what it declares (maybe left half-built).
        for (const t of new Set([...recorded.get(e.name)?.tables ?? [], ...Object.keys(e.tables)])) this.db.exec(`drop table if exists "${t}"`)
        this.db.prepare('delete from meta where key = ?').run('ext:' + e.name)
        this.createTables(e)
      }
    })()
    for (const e of this.order) this.writers.set(e.name, e.open(guardedDb(this.db, e, this.byName)))
    return stale
  }

  /** Records that these extensions hold every note: their tables are up to date with their version. */
  markCurrent(names: Iterable<string>) {
    const put = this.db.prepare('insert or replace into meta (key, value) values (?, ?)')
    for (const name of names) {
      const e = this.byName.get(name)
      if (e) put.run('ext:' + name, JSON.stringify({ version: e.version, tables: Object.keys(e.tables) } satisfies Installed))
    }
  }

  /**
   * Runs every extension over a note, in topological order. With `only`,
   * stores just those (their requirements are still extracted, for the inputs).
   */
  index(note: NoteSnapshot, only?: ReadonlySet<string>) {
    const facts = new Map<string, unknown>()
    for (const e of this.order) {
      if (only && !only.has(e.name) && !this.isNeededBy(e.name, only)) continue
      const f = e.extract(note, this.inputs(e.name, facts))
      facts.set(e.name, f)
      if (!only || only.has(e.name)) this.writers.get(e.name)!.store(note.path, f)
    }
  }

  remove(path: string) {
    for (const e of this.order) this.writers.get(e.name)!.remove(path)
  }

  finalize(changes: ChangeSet, only?: ReadonlySet<string>) {
    for (const e of this.order) if (!only || only.has(e.name)) this.writers.get(e.name)!.finalize?.(changes)
  }

  private needed = new Map<string, Set<string>>()
  /** Whether `name` is an ancestor of any extension in `only`. */
  private isNeededBy(name: string, only: ReadonlySet<string>): boolean {
    for (const o of only) {
      let a = this.needed.get(o)
      if (!a) this.needed.set(o, (a = ancestors(o, this.byName)))
      if (a.has(name)) return true
    }
    return false
  }

  private inputs(name: string, facts: Map<string, unknown>): Inputs {
    const allowed = this.requires.get(name)!
    return {
      get<T>(dep: string): T {
        if (!allowed.has(dep)) throw new ExtensionError(`extension "${name}" reads "${dep}" without requiring it`)
        return facts.get(dep) as T
      },
    }
  }

  private recorded(): Map<string, Installed> {
    const rows = this.db.prepare("select key, value from meta where key like 'ext:%'").all() as { key: string; value: string }[]
    const out = new Map<string, Installed>()
    for (const r of rows) {
      try { out.set(r.key.slice(4), JSON.parse(r.value) as Installed) } catch { /* unreadable: treated as never installed */ }
    }
    return out
  }

  /** Runs the extension's DDL and checks it only created what it declared. */
  private createTables(e: Extension) {
    const before = new Set((this.db.prepare('select name from sqlite_master').all() as { name: string }[]).map((o) => o.name))
    const declared = Object.keys(e.tables)
    for (const t of declared) this.db.exec(e.tables[t]!)
    const all = this.db.prepare('select type, name, tbl_name, sql from sqlite_master').all() as { type: string; name: string; tbl_name: string; sql: string | null }[]
    // Virtual tables (FTS5) create shadow tables named after them.
    const virtual = declared.filter((t) => all.some((o) => o.name === t && /^\s*create\s+virtual\s/i.test(o.sql ?? '')))
    for (const o of all) {
      if (before.has(o.name)) continue
      const owned = declared.includes(o.tbl_name) || virtual.some((t) => o.tbl_name.startsWith(t + '_'))
      if (!owned) throw new ExtensionError(`extension "${e.name}" created "${o.name}", which is not among its tables`)
    }
    for (const t of declared) {
      if (!all.some((o) => o.name === t && o.type === 'table')) throw new ExtensionError(`extension "${e.name}" declares table "${t}" but its DDL doesn't create it`)
    }
  }
}

// --- The guarded handle ------------------------------------------------------
//
// Which tables a statement touches is read from SQLite's own plan (`explain`:
// every table or index it opens, subqueries and joins included), not guessed
// from the text. Virtual tables (FTS5) don't appear by name in the plan, so
// those are checked by name in the statement.

function guardedDb(db: Db, ext: Extension, byName: Map<string, Extension>): ExtensionDb {
  const own = new Set(Object.keys(ext.tables))
  const readable = new Set([...own, ...FRAMEWORK_READABLE])
  for (const a of ancestors(ext.name, byName)) for (const t of Object.keys(byName.get(a)!.tables)) readable.add(t)
  const schema = db.prepare('select type, name, tbl_name, rootpage, sql from sqlite_master').all() as { type: string; name: string; tbl_name: string; rootpage: number; sql: string | null }[]
  const tableAt = new Map(schema.filter((o) => o.rootpage > 0).map((o) => [o.rootpage, o.tbl_name.toLowerCase()]))
  const virtual = new Set(schema.filter((o) => o.type === 'table' && /^\s*create\s+virtual\s/i.test(o.sql ?? '')).map((o) => o.name.toLowerCase()))
  const refuse = (sql: string, why: string): never => {
    throw new ExtensionError(`extension "${ext.name}": ${why}: ${sql.trim().replace(/\s+/g, ' ').slice(0, 120)}`)
  }
  return {
    prepare(sql: string): Statement {
      const tokens = tokenize(sql)
      const first = tokens[0]?.toLowerCase()
      const query = first === 'select' || first === 'with'
      if (!query && first !== 'insert' && first !== 'replace' && first !== 'update' && first !== 'delete') {
        refuse(sql, 'only select, insert, replace, update and delete are allowed')
      }
      const stmt = db.prepare(sql)
      if (query && !stmt.readonly) refuse(sql, 'a query that writes')
      if (!query) {
        const target = writeTarget(tokens)
        if (!target || !own.has(target)) refuse(sql, `writes only to its own tables (${[...own].join(', ')})`)
      }
      for (const op of db.prepare('explain ' + sql).all(...placeholders(tokens)) as { opcode: string; p2: number; p3: number }[]) {
        if (op.opcode !== 'OpenRead' && op.opcode !== 'OpenWrite' && op.opcode !== 'ReopenIdx') continue
        const table = op.p3 === 0 ? tableAt.get(op.p2) : undefined
        if (!table) return refuse(sql, 'touches something outside the index tables')
        if (op.opcode === 'OpenWrite' && !own.has(table)) refuse(sql, `can't write to "${table}"`)
        if (!readable.has(table)) refuse(sql, `can't read "${table}"; it must be its own or a required extension's`)
      }
      for (const t of tokens) {
        const name = t.toLowerCase()
        if (virtual.has(name) && !readable.has(name)) refuse(sql, `can't read "${name}"; it must be its own or a required extension's`)
      }
      return {
        run: (...p) => ({ changes: stmt.run(...p).changes }),
        get: (...p) => stmt.get(...p),
        all: (...p) => stmt.all(...p),
      }
    },
  }
}

/** Words, quoted identifiers (unquoted) and punctuation; strings and comments dropped. */
function tokenize(sql: string): string[] {
  const out: string[] = []
  const re = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"((?:[^"]|"")*)"|`([^`]*)`|\[([^\]]*)\]|([A-Za-z_][\w$]*)|(\S)/g
  for (const m of sql.matchAll(re)) {
    const word = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]
    if (word !== undefined) out.push(word)
  }
  return out
}

/** Null values for a statement's parameters, so it can be explained without running it. */
function placeholders(tokens: string[]): unknown[] {
  const named: Record<string, null> = {}
  let positional = 0
  tokens.forEach((t, i) => {
    if (t === '?') positional++
    else if ((t === ':' || t === '@' || t === '$') && /^[A-Za-z_]/.test(tokens[i + 1] ?? '')) named[tokens[i + 1]!] = null
  })
  const out: unknown[] = Array.from({ length: positional }, () => null)
  if (Object.keys(named).length) out.push(named)
  return out
}

/** The table an insert, replace, update or delete writes to. */
function writeTarget(tokens: string[]): string | null {
  const lower = tokens.map((t) => t.toLowerCase())
  if (lower[0] === 'delete') return lower[1] === 'from' ? lower[2] ?? null : null
  let i = 1
  if (lower[i] === 'or') i += 2
  if (lower[0] !== 'update') { if (lower[i] !== 'into') return null; i++ }
  return lower[i] ?? null
}
