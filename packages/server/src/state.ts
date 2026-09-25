// state.db: application state that is NOT derived from the files: users,
// sessions, profiles and, later, API keys and webhooks. It's not disposable: it's
// backed up, and its schema evolves through migrations, never by deleting it.
import Database from 'better-sqlite3'
import { copyFileSync, existsSync } from 'node:fs'
import type { Db } from './db.ts'

/** Migrations in order. A published one is never edited: another one is added. */
const MIGRATIONS: string[] = [
  `create table users (
     id            text primary key,
     username      text not null unique collate nocase,
     password_hash text not null,
     role          text not null check (role in ('admin', 'member')),
     created_at    text not null,
     disabled      integer not null default 0
   );
   create table sessions (
     token_hash   text primary key,
     user_id      text not null references users(id) on delete cascade,
     created_at   text not null,
     expires_at   text not null,
     last_seen_at text not null
   );
   create index sessions_user on sessions(user_id);`,
  // Each person's profile: the timezone that decides what "today" is for them
  // and their daily-note preferences (D-030). No row = nothing chosen yet.
  `create table profiles (
     user_id      text primary key references users(id) on delete cascade,
     timezone     text,
     daily_series text,
     open_daily   integer not null default 0
   );`,
]

export const STATE_VERSION = MIGRATIONS.length

export function openState(file: string): Db {
  const existed = existsSync(file)
  const db = new Database(file)
  db.pragma('journal_mode = wal')
  db.pragma('synchronous = full')
  db.pragma('foreign_keys = on')
  const current = db.pragma('user_version', { simple: true }) as number
  if (current > MIGRATIONS.length) {
    db.close()
    throw new Error(`state.db is at version ${current}, newer than this install (${MIGRATIONS.length}). Did you roll back to an older version of thoth?`)
  }
  if (current < MIGRATIONS.length) {
    if (existed && current > 0) {
      db.pragma('wal_checkpoint(truncate)')
      copyFileSync(file, `${file}.bak-v${current}`)
    }
    db.transaction(() => {
      for (let v = current; v < MIGRATIONS.length; v++) db.exec(MIGRATIONS[v]!)
      db.pragma(`user_version = ${MIGRATIONS.length}`)
    })()
  }
  return db
}
