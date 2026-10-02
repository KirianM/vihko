// Frontmatter fields, for searching by them (`type:decision`, `has:due`;
// query.ts in core): every top-level key whose value is simple (text, a
// number, true/false, a date, or a list of those), as written. Nested maps,
// and maps inside lists, are left out. A key with no value (`due:`) or an
// empty list is kept too, with no value: `has:` finds it, nothing else does.
//
// The same table says which notes are templates (`template: true`):
// `templateSql`.
import { TEMPLATE_KEY, foldField } from '@vihko/core'
import type { Extension } from '../extension.ts'

export type FieldKind = 'string' | 'number' | 'boolean' | 'date' | 'null'

export interface Field {
  /** The key as written. */
  key: string
  /** The value as text (a number as JavaScript writes it, a boolean as `true`/`false`); null for none. */
  value: string | null
  /** For a number, the number, to compare `5` with `5.0`. */
  num: number | null
  kind: FieldKind
}

/** The most items of one list, and the longest value, kept: a frontmatter is no place for more. */
const MAX_ITEMS = 200
const MAX_VALUE = 1000

/** A date as YAML 1.1 and most tools write it (the core schema reads it as text). */
const DATE = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/

function scalar(v: unknown): Omit<Field, 'key'> | null {
  if (typeof v === 'string') return v.length > MAX_VALUE ? null : { value: v.normalize('NFC'), num: null, kind: DATE.test(v.trim()) ? 'date' : 'string' }
  if (typeof v === 'number') return Number.isFinite(v) ? { value: String(v), num: v, kind: 'number' } : null
  if (typeof v === 'boolean') return { value: String(v), num: null, kind: 'boolean' }
  return null
}

/** The simple fields of a frontmatter's data (Field), in order; nothing for a key whose value is a map. */
export function frontmatterFields(data: Record<string, unknown>): Field[] {
  const out: Field[] = []
  for (const [rawKey, v] of Object.entries(data)) {
    const key = rawKey.normalize('NFC')
    if (!key.trim()) continue
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) {
      out.push({ key, value: null, num: null, kind: 'null' })
      continue
    }
    const items = Array.isArray(v) ? v.slice(0, MAX_ITEMS) : [v]
    // A list of nothing simple (maps, say) is no field to search by.
    for (const item of items) {
      const s = scalar(item)
      if (s) out.push({ key, ...s })
    }
  }
  return out
}

export const fields: Extension<readonly Field[]> = {
  name: 'fields',
  version: 1,
  tables: {
    fields: `create table fields (
      path       text not null,
      key        text not null,
      key_fold   text not null,
      value      text,
      value_fold text,
      num        real,
      kind       text not null check (kind in ('string', 'number', 'boolean', 'date', 'null'))
    );
    create index fields_path on fields(path);
    create index fields_key on fields(key_fold, value_fold);`,
  },
  extract: (note) => (note.parsed.frontmatter.error ? [] : frontmatterFields(note.parsed.frontmatter.data)),
  open(db) {
    const del = db.prepare('delete from fields where path = ?')
    const ins = db.prepare('insert into fields (path, key, key_fold, value, value_fold, num, kind) values (?, ?, ?, ?, ?, ?, ?)')
    return {
      store(path, list) {
        del.run(path)
        for (const f of list) ins.run(path, f.key, foldField(f.key), f.value, f.value === null ? null : foldField(f.value), f.num, f.kind)
      },
      remove: (path) => { del.run(path) },
    }
  },
}

/**
 * SQL condition: the note at `alias.path` is a template (`template: true` in
 * its frontmatter, the key as written, a YAML true).
 */
export const templateSql = (alias: string) =>
  `exists (select 1 from fields tf where tf.path = ${alias}.path and tf.key = '${TEMPLATE_KEY}' and tf.kind = 'boolean' and tf.value = 'true')`

/** Every template in the index (to be filtered by what the principal reads). */
export const TEMPLATES_SQL = `select distinct path from fields where key = '${TEMPLATE_KEY}' and kind = 'boolean' and value = 'true'`
