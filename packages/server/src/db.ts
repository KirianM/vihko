// index.db: derived and disposable. Everything here is rebuilt from the
// files. This file holds the framework's tables; extensions (extension.ts)
// declare and version their own. If the framework's schema changes, the whole
// index is deleted and reindexed.
import Database from 'better-sqlite3'
import { rmSync } from 'node:fs'

export type Db = Database.Database

/**
 * Version of the framework's tables and of how extensions are recorded.
 * Bumping it forces a full rebuild; an extension's own changes bump only its
 * version.
 */
export const SCHEMA_VERSION = 7 // 7: tables split into versioned extensions

const SCHEMA = `
create table meta (
  key   text primary key,
  value text not null
);

-- One row per note. No timestamps of its own: only what comes from disk.
create table notes (
  path      text primary key,
  uid       text,
  title     text not null,
  hash      text not null,
  mtime_ms  real not null,
  size      integer not null,
  fm_json   text not null,
  fm_error  text,
  aliases   text not null   -- JSON: list of aliases
);
create index notes_uid on notes(uid) where uid is not null;

-- Link resolution keys: path suffixes and normalised aliases.
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
  key        text,            -- search key; null = the note itself
  status     text not null check (status in ('resolved', 'ambiguous', 'missing')),
  dst_path   text,
  via        text,
  anchor_ok  integer,         -- null no anchor; 1 exists; 0 broken
  candidates text,            -- JSON if ambiguous
  primary key (src_path, ord)
);
create index links_key on links(key);
create index links_dst on links(dst_path);

-- References to image files in the notes folder, to know which notes use
-- each image (an image moves with a note only if no other note uses it).
-- \`path\` is where the reference points, from the notes root, whether the file
-- exists or not; external URLs are not recorded.
create table images (
  src_path  text not null,
  ord       integer not null,
  kind      text not null check (kind in ('image', 'embed', 'markdown', 'wiki')),
  raw       text not null,
  path      text not null,
  primary key (src_path, ord)
);
create index images_path on images(path);

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

-- Every folder under the notes root (hidden ones aside), empty or not: the
-- tree shows a folder that has no notes yet. Derived from disk like the rest.
create table folders (
  path text primary key
);

-- Alerts derived from disk: sync-tool conflict copies, etc.
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

/** Deterministic dump of the whole index (rebuild tests). */
export function dumpIndex(db: Db): string {
  const tables = ['notes', 'link_keys', 'links', 'images', 'tags', 'headings', 'folders', 'alerts']
  const out: string[] = []
  for (const t of tables) {
    const columns = Math.min(3, (db.prepare(`pragma table_info(${t})`).all()).length)
    const order = Array.from({ length: columns }, (_, i) => i + 1).join(', ')
    const rows = db.prepare(`select * from ${t} order by ${order}`).all()
    out.push(`## ${t}`, ...rows.map((r) => JSON.stringify(r)))
  }
  const fts = db.prepare('select path, title, aliases, body from notes_fts order by path').all()
  out.push('## notes_fts', ...fts.map((r) => JSON.stringify(r)))
  return out.join('\n')
}
