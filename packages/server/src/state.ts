// state.db: application state that is NOT derived from the files: users,
// groups, sessions, one-time links, profiles, settings, agent keys, OAuth
// clients and tokens and, later, webhooks. It's not disposable: it's
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
  // Installation settings set from the UI by the thoth admin (the integration
  // switches, D-035.1): no row = the default. And agent keys (D-035.2): only
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
  // The second factor (D-036, twoFactor.ts): a user's TOTP secret (base32;
  // it has to be kept as it is to compute the codes) and the last step
  // whose code was accepted, so that none works twice. Recovery codes, only
  // as their sha256, each one used once.
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
