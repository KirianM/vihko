# Context for agents

## What this is

`thoth` (working name): a self-hosted, open source notes system over Markdown
files, with its own web UI, multiple users with roles, note history, and a
server-side index queryable from the UI and, optionally, from an API, MCP and
webhooks. Anyone should be able to self-host it with Docker.

The plan is in `ROADMAP.md`.

## Non-negotiable rules

1. **Files are the source of truth.** Plain Markdown. If a feature needs to
   move content into a database, the feature is wrong.

2. **The index is derived and disposable.** Anything that can't be rebuilt by
   rescanning the folder can't live in `index.db`. Deleting and rebuilding the
   index must have no consequences. Application state (users, roles, keys,
   webhooks) lives separately in `state.db`, which never holds note content or
   relations between notes.

3. **Blank canvas.** The system imposes no folder structure or taxonomy.
   Integration conventions go in configuration, never hardcoded. No hardcoded
   paths or folder names.

4. **Closed by default.** API, MCP and webhooks are optional and off by
   default. Without them nothing gets in or out except through the user (no
   CDNs either: the UI only talks to its own server). The minimal deployment
   needs no reverse proxy, Postgres, Redis or external identity provider. No
   telemetry or auto-update.

5. **One core for every write.** UI, API and MCP go through the same service,
   which applies permissions, concurrency and atomic writes. An agent never
   sees or writes more than the user it acts for. If the note is open in an
   editor (a hot note), the write goes to the in-memory CRDT document, which is
   only a cache: the file is still the truth.

## Writing code that touches note files

- Always atomic writes: temp file + `rename`. An external editor may have the
  file open.
- **Keep frontmatter intact**: key order, comments, unknown fields. Normalising
  YAML destroys notes from other tools.
- The frontmatter `uid` is the identity, never the path or the name. The
  indexer doesn't write to notes: the `uid` is only assigned when needed.
- Optimistic concurrency with a content hash.
- The watcher is not enough: the periodic rescan is mandatory (network
  filesystems, changes while the service was down, lost events).
- The SQLite index lives on **local disk**, never on NFS: SQLite locking over
  NFS is not reliable.

## Code conventions

- Everything in code is in English: identifiers, comments, test names, logs and
  developer-facing error messages. User-facing text goes through
  `packages/web/src/i18n.tsx` (English and Spanish); the server returns codes.
- TypeScript runs on Node without a build step: erasable syntax only (no enums,
  namespaces or parameter properties).
- Colours, spacing and type come from the design tokens
  (`packages/web/src/theme/tokens.json`), never hardcoded.
- Every UI change is checked in a real browser (Playwright, `packages/web/e2e`),
  with two sessions when collaboration is involved.
- Minimal solutions before full stacks. Every dependency must justify itself,
  more so when a third party has to deploy it: SQLite before Postgres, a timer
  before a daemon, a file before a broker. Always the latest stable version.
