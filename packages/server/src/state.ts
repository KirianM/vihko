// state.db: application state that is NOT derived from the files: users,
// groups, sessions, one-time links, profiles, settings, agent keys, OAuth
// clients and tokens and, later, webhooks. It's not disposable: it's
// backed up, and its schema evolves through migrations, never by deleting it.
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Alert } from '@vihko/core'
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
  // and their daily-note preferences. No row = nothing chosen yet.
  `create table profiles (
     user_id      text primary key references users(id) on delete cascade,
     timezone     text,
     daily_series text,
     open_daily   integer not null default 0
   );`,
  // Installation settings set from the UI by the vihko admin (the integration
  // switches): no row = the default. And agent keys: only
  // the sha256 of the secret and its last 4 characters; `folders` is a JSON
  // list (empty = every folder the user sees).
  `create table settings (
     key   text primary key,
     value text not null
   );
   create table api_keys (
     id           text primary key,
     user_id      text not null references users(id) on delete cascade,
     name         text not null,
     secret_hash  text not null,
     last4        text not null,
     can_write    integer not null default 0,
     folders      text not null default '[]',
     expires_at   text,
     created_at   text not null,
     last_used_at text,
     last_via     text check (last_via in ('api', 'mcp', 'oauth')),
     revoked_at   text
   );
   create index api_keys_user on api_keys(user_id);`,
  // OAuth 2.1 for the MCP server with a public URL (oauth.ts). An
  // authorization is a key like any other (`oauth_client` says which client
  // it was given to; its secret is random and never shown). Clients come from
  // dynamic registration; codes and tokens are kept only as their sha256.
  // `used_family`/`used_at`: a code or refresh token already exchanged, kept
  // until it expires so that a second use revokes what came from it.
  `alter table api_keys add column oauth_client text;
   create table oauth_clients (
     id            text primary key,
     name          text not null,
     redirect_uris text not null,
     auth_method   text not null check (auth_method in ('none', 'client_secret_post', 'client_secret_basic')),
     secret_hash   text,
     created_at    text not null
   );
   create table oauth_codes (
     code_hash      text primary key,
     client_id      text not null references oauth_clients(id) on delete cascade,
     user_id        text not null references users(id) on delete cascade,
     redirect_uri   text not null,
     code_challenge text not null,
     resource       text not null,
     can_write      integer not null,
     folders        text not null,
     expires_at     text not null,
     used_family    text
   );
   create table oauth_tokens (
     token_hash text primary key,
     kind       text not null check (kind in ('access', 'refresh')),
     key_id     text not null references api_keys(id) on delete cascade,
     family     text not null,
     resource   text not null,
     expires_at text not null,
     used_at    text
   );
   create index oauth_tokens_key on oauth_tokens(key_id);
   create index oauth_tokens_family on oauth_tokens(family);`,
  // Rotating a key (keys.ts): the secret it replaced (only its sha256) keeps
  // working until `previous_until`, so that whatever used it can be changed.
  `alter table api_keys add column previous_secret_hash text;
   alter table api_keys add column previous_until text;`,
  // Several people (M4, users.ts). A deleted user stays as a tombstone: its
  // row keeps the id and the name (the history still says who wrote, and
  // the name is never given to someone else), with no password, and
  // `disabled` set so nothing signs in as it. Groups (subjects of the
  // permissions as `@name`) and their members. One-time links to choose a
  // password (an invitation, or a reset): only their sha256, with an expiry
  // and when they were used. A session remembers its browser, to tell it
  // apart in «Account».
  `alter table users add column deleted_at text;
   alter table sessions add column user_agent text;
   create table user_groups (
     id         text primary key,
     name       text not null unique collate nocase,
     created_at text not null
   );
   create table group_members (
     group_id text not null references user_groups(id) on delete cascade,
     user_id  text not null references users(id) on delete cascade,
     primary key (group_id, user_id)
   );
   create index group_members_user on group_members(user_id);
   create table user_links (
     token_hash text primary key,
     user_id    text not null references users(id) on delete cascade,
     kind       text not null check (kind in ('invite', 'reset')),
     created_at text not null,
     expires_at text not null,
     used_at    text
   );
   create index user_links_user on user_links(user_id);`,
  // The second factor (twoFactor.ts): a user's TOTP secret (base32;
  // it has to be kept as it is to compute the codes) and the last step
  // whose code was accepted, so that none works twice. Recovery codes, only
  // as a hash (a sha256 then; now a slow hash with a salt per batch, in
  // the same column), each one used once.
  `create table two_factor (
     user_id    text primary key references users(id) on delete cascade,
     secret     text not null,
     enabled_at text not null,
     last_step  integer not null default 0
   );
   create table recovery_codes (
     user_id   text not null references users(id) on delete cascade,
     code_hash text not null,
     used_at   text,
     primary key (user_id, code_hash)
   );`,
  // Notices addressed to one person (M4.1, notices.ts): a code and its data
  // as JSON (ids of people, never names; a path only for a purge), until
  // they dismiss it. Never anything of a note's content.
  `create table notices (
     id         text primary key,
     user_id    text not null references users(id) on delete cascade,
     code       text not null,
     data       text not null,
     created_at text not null
   );
   create index notices_user on notices(user_id, created_at);`,
  // The language of each person's UI (profiles.ts): null = their browser's.
  `alter table profiles add column language text;`,
  // Spaces (0.1.0): what each person pins in the sidebar from «Shared
  // with me» (spaceService.ts). Folders by their path from the notes root, as
  // a key's folders are: rewritten when vihko moves a folder (folderRefs.ts).
  // Never anything of a note's content, nor links between notes.
  `create table pins (
     user_id    text not null references users(id) on delete cascade,
     path       text not null,
     created_at text not null,
     primary key (user_id, path)
   );`,
  // «On opening» (profiles.ts): what vihko opens when the person
  // comes in: `home`, `last` (that device's last note), `note` (`on_open_note`,
  // a path) or `daily` (today's note, only if it exists). Null: home. The
  // switch it replaces («open today's note», `open_daily`) carries over.
  `alter table profiles add column on_open text;
   alter table profiles add column on_open_note text;
   update profiles set on_open = 'daily' where open_daily = 1;`,
  // What each person may see of the past (grantStarts.ts): when each grant
  // of vihko.yaml began, by folder and subject (null: from the start), and
  // since when someone is in a group (null: from before this was kept). And
  // the shared spaces deleted to the trash (spaceService.ts), so that they
  // can be restored whole: their root, their rules and empty folders, the
  // trash entries that hold their notes and files, who managed them, who
  // deleted them and when. Never anything of a note's content.
  `create table grant_starts (
     folder  text not null,
     subject text not null,
     since   text,
     primary key (folder, subject)
   );
   alter table group_members add column added_at text;
   create table deleted_spaces (
     id         text primary key,
     root       text not null,
     rules      text not null,
     folders    text not null,
     entries    text not null,
     managers   text not null,
     by_user    text not null,
     deleted_at text not null
   );`,
  // «On opening: Last note (on this device)» (profiles.ts): the last note
  // each person opened on each device (the random id of its device cookie),
  // kept in their account so it outlives signing out, and nothing of it in
  // the browser. A path, rewritten when vihko moves it (folderRefs.ts).
  `create table last_notes (
     user_id    text not null references users(id) on delete cascade,
     device     text not null,
     path       text not null,
     opened_at  text not null,
     primary key (user_id, device)
   );`,
]

export const STATE_VERSION = MIGRATIONS.length

/**
 * A migration of an existing state.db, as the admins are told of it until
 * one of them dismisses it: from and to which version, when (ISO), and the
 * copy made before (`backup`, its path in the state volume).
 */
export interface StateMigration {
  id: string
  from: number
  to: number
  at: string
  backup: string
}

/**
 * Where the migrations the admins haven't dismissed are kept: in state.db
 * itself, written in the migration's own transaction, so that whatever
 * opened it (the server, or a CLI command before it) leaves the record, and
 * a database put back from its copy takes it away.
 */
const MIGRATED_KEY = 'state.migrations'
/** The migrations kept until dismissed: older ones go first. */
const MAX_MIGRATED = 20

export interface OpenStateOptions {
  log?: (msg: string) => void
  now?: () => Date
}

export function openState(file: string, opts: OpenStateOptions = {}): Db {
  const existed = existsSync(file)
  const db = new Database(file)
  db.pragma('journal_mode = wal')
  db.pragma('synchronous = full')
  db.pragma('foreign_keys = on')
  const current = db.pragma('user_version', { simple: true }) as number
  if (current > MIGRATIONS.length) {
    db.close()
    throw new Error(`state.db is at version ${current}, newer than this install (${MIGRATIONS.length}). Did you roll back to an older version of vihko?`)
  }
  if (current < MIGRATIONS.length) {
    // A new database is no news; an upgraded one is, with where its copy went.
    const upgrade = existed && current > 0
    const backup = `${basename(file)}.bak-v${current}`
    if (upgrade) {
      db.pragma('wal_checkpoint(truncate)')
      copyFileSync(file, join(dirname(file), backup))
    }
    db.transaction(() => {
      for (let v = current; v < MIGRATIONS.length; v++) db.exec(MIGRATIONS[v]!)
      db.pragma(`user_version = ${MIGRATIONS.length}`)
      if (upgrade) {
        const at = (opts.now?.() ?? new Date()).toISOString()
        saveMigrations(db, [...stateMigrations(db), { id: randomUUID(), from: current, to: MIGRATIONS.length, at, backup }].slice(-MAX_MIGRATED))
      }
    })()
    if (upgrade) opts.log?.(`state.db migrated from version ${current} to ${MIGRATIONS.length}; the previous one is in ${join(dirname(file), backup)}`)
  }
  // External images when VIHKO_EXTERNAL_IMAGES isn't set, decided once: a new
  // installation asks before showing them (`ask`); one from before that
  // default keeps showing them (`allow`), as it did.
  if (!db.prepare('select 1 from settings where key = ?').get(EXTERNAL_IMAGES_KEY)) {
    db.prepare('insert into settings (key, value) values (?, ?)').run(EXTERNAL_IMAGES_KEY, existed && current > 0 ? 'allow' : 'ask')
  }
  return db
}

/** Where state.db keeps the installation's default for external images (see openState). */
const EXTERNAL_IMAGES_KEY = 'install.externalImages'

/** The installation's default for external images, when VIHKO_EXTERNAL_IMAGES doesn't say: `ask` for a new one, `allow` for one from before. */
export function externalImagesDefault(db: Db): 'allow' | 'ask' | 'block' {
  const v = (db.prepare('select value from settings where key = ?').get(EXTERNAL_IMAGES_KEY) as { value: string } | undefined)?.value
  return v === 'allow' || v === 'block' ? v : 'ask'
}

/** The migrations of this state.db the admins haven't dismissed, oldest first. */
export function stateMigrations(db: Db): StateMigration[] {
  const row = db.prepare('select value from settings where key = ?').get(MIGRATED_KEY) as { value: string } | undefined
  if (!row) return []
  try {
    const data = JSON.parse(row.value) as unknown
    return Array.isArray(data)
      ? data.filter((r): r is StateMigration => typeof r?.id === 'string' && Number.isInteger(r.from) && Number.isInteger(r.to) && typeof r.at === 'string' && typeof r.backup === 'string')
      : []
  } catch {
    return []
  }
}

/** Each migration as the admins' alert. */
export function stateMigrationAlerts(db: Db): Alert[] {
  return stateMigrations(db).map((r) => ({ code: 'state_migrated', id: r.id, file: 'state.db', from: r.from, to: r.to, backup: r.backup, at: r.at, actions: ['dismiss'] }))
}

/** Dismisses a migration's alert (for every admin). Whether there was one. */
export function dismissStateMigration(db: Db, id: string): boolean {
  return db.transaction(() => {
    const before = stateMigrations(db)
    const after = before.filter((r) => r.id !== id)
    if (after.length === before.length) return false
    saveMigrations(db, after)
    return true
  })()
}

function saveMigrations(db: Db, list: StateMigration[]) {
  if (list.length === 0) db.prepare('delete from settings where key = ?').run(MIGRATED_KEY)
  else db.prepare('insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(MIGRATED_KEY, JSON.stringify(list))
}
