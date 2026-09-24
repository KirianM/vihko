// index.db: derivado y desechable. Todo lo que hay aquí se reconstruye desde
// los archivos. Si cambia el esquema, se borra y se vuelve a indexar.
import Database from 'better-sqlite3'
import { rmSync } from 'node:fs'

export type Db = Database.Database

/** Subir este número fuerza una reconstrucción completa del índice. */
export const SCHEMA_VERSION = 1

const SCHEMA = `
create table meta (
  key   text primary key,
  value text not null
);

-- Una fila por nota. Sin marcas de tiempo propias: solo lo que sale del disco.
create table notes (
  path      text primary key,
  uid       text,
  title     text not null,
  hash      text not null,
  mtime_ms  real not null,
  size      integer not null,
  fm_json   text not null,
  fm_error  text,
  aliases   text not null   -- JSON: lista de alias
);
create index notes_uid on notes(uid) where uid is not null;

create virtual table notes_fts using fts5(
  path unindexed, title, body,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Claves de resolución de enlaces (D-019): sufijos de ruta y alias normalizados.
create table link_keys (
  key  text not null,
  path text not null,
  kind text not null check (kind in ('path', 'alias')),
  primary key (key, path, kind)
);

create table links (
  src_path   text not null,
  ord        integer not null,
  kind       text not null check (kind in ('wiki', 'embed', 'markdown')),
  raw        text not null,
  target     text not null,
  anchor     text,
  display    text,
  pos_from   integer not null,
  pos_to     integer not null,
  key        text,            -- clave de búsqueda; null = la propia nota
  status     text not null check (status in ('resolved', 'ambiguous', 'missing')),
  dst_path   text,
  via        text,
  anchor_ok  integer,         -- null sin ancla; 1 existe; 0 rota
  candidates text,            -- JSON si es ambiguo
  primary key (src_path, ord)
);
create index links_key on links(key);
create index links_dst on links(dst_path);

create table tags (
  path   text not null,
  tag    text not null,
  source text not null check (source in ('inline', 'frontmatter')),
  primary key (path, tag, source)
);
create index tags_tag on tags(tag);

create table headings (
  path  text not null,
  ord   integer not null,
  level integer not null,
  text  text not null,
  pos   integer not null,
  primary key (path, ord)
);

-- Avisos derivados del disco: copias de conflicto de sincronizadores, etc.
create table alerts (
  path   text primary key,
  kind   text not null,
  detail text
);
`

export function openIndex(file: string): Db {
  let db = new Database(file)
  const version = readVersion(db)
  if (version !== SCHEMA_VERSION) {
    db.close()
    for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true })
    db = new Database(file)
    configure(db)
    db.exec(SCHEMA)
    db.prepare('insert into meta (key, value) values (?, ?)').run('schema_version', String(SCHEMA_VERSION))
    return db
  }
  configure(db)
  return db
}

function configure(db: Db) {
  db.pragma('journal_mode = wal')
  db.pragma('synchronous = normal')
}

function readVersion(db: Db): number | null {
  try {
    const row = db.prepare("select value from meta where key = 'schema_version'").get() as { value: string } | undefined
    return row ? Number(row.value) : null
  } catch {
    return null
  }
}

/** Volcado determinista de todo el índice (tests de reconstrucción). */
export function dumpIndex(db: Db): string {
  const tables = ['notes', 'link_keys', 'links', 'tags', 'headings', 'alerts']
  const out: string[] = []
  for (const t of tables) {
    const rows = db.prepare(`select * from ${t} order by 1, 2, 3`).all()
    out.push(`## ${t}`, ...rows.map((r) => JSON.stringify(r)))
  }
  const fts = db.prepare('select path, title, body from notes_fts order by path').all()
  out.push('## notes_fts', ...fts.map((r) => JSON.stringify(r)))
  return out.join('\n')
}
