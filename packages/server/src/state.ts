// state.db: estado de aplicación que NO se deriva de los archivos (D-011):
// usuarios, sesiones y, más adelante, API keys y webhooks. No es desechable:
// se respalda, y su esquema evoluciona con migraciones, nunca borrándolo.
import Database from 'better-sqlite3'
import { copyFileSync, existsSync } from 'node:fs'
import type { Db } from './db.ts'

/** Migraciones en orden. Nunca se edita una ya publicada: se añade otra. */
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
    throw new Error(`state.db tiene la versión ${current}, más nueva que esta instalación (${MIGRATIONS.length}). ¿Se ha vuelto a una versión anterior de thoth?`)
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
