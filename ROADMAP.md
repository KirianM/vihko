# Roadmap

Each milestone is a usable release with a checkable definition of done. The
reasons behind the order are at the end.

## M1 · Notes, one user

Goal: a complete notes system from the UI, without integrations.

- [x] TypeScript monorepo: shared package (`lezer-markdown` parser, link
      resolution, byte-preserving frontmatter patching), server and web. CI with
      typecheck, tests, browser tests and the Docker image.
- [x] Edge-case vault for tests (ambiguous links, Unicode, exotic frontmatter,
      sync-conflict files, temporary files).
- [x] Indexer: watcher + periodic rescan, exclusion list, guard against mass
      deletions.
- [x] Split the indexer into extensions (a DAG): each set of derived tables
      is an extension with its own version, run in dependency order; bumping
      one rebuilds only it and its dependents. Ground for the first real
      extension (embeddings, M7).
- [x] `index.db`: FTS5 (`unicode61 remove_diacritics 2`), links with states,
      tags, headings. Deterministic rebuild test.
- [x] Write core: hot/cold notes, `if_match`, trash, lazy `uid`, move/rename
      rewriting links.
- [x] Collaboration hub: notes open in an editor are live Yjs documents; the
      file stays the source of truth. A note deleted outside thoth while open
      keeps a copy until someone decides.
- [x] Editor: CodeMirror 6 on Yjs with live preview, presence and link states.
- [x] UI: folder tree, ⌘K search-or-create, side panel with comments,
      links/backlinks and outline, rename/move with preview, trash, workspace
      alerts. Translatable (English and Spanish).
- [x] Responsive layout for phones and an installable PWA (no offline mode;
      installing needs HTTPS).
- [x] Images: upload, paste and by URL (local copy or link); they travel with
      their note when it moves to another folder; external images can be
      blocked by the administrator.
- [x] Autocomplete in the editor: `[[` suggests notes and aliases, `#`
      suggests existing tags.
- [x] A broken `[[link]]` offers to create the note (in the current note's
      folder).
- [x] Tasks and tables in the editor: `- [ ]` toggles with a click; Markdown
      tables render as tables outside the cursor.
- [x] Folders and tags in the tree: create, rename and move folders (also by
      dragging notes), a tags view, and `tag:`/`path:` filters in search.
- [x] Review after comparing with other systems: configurable alias
      resolution; a picker and «pin this target» for ambiguous links; a
      generation number so a stale tab can't duplicate a note; detection of
      renames made outside thoth with an «update links» alert (an open note
      follows its file); per-note attachment subfolders; «text changed» marks
      on comments and confirmation before resolving; argon2id passwords; a
      tolerant, versioned `thoth.yaml` (strict only for permissions); full
      Unicode case folding in links.
- [x] Server errors and alerts as translatable codes.
- [x] Local auth: an admin created from the CLI or a one-time token, sessions.
      A principal on every query from day one.
- [x] Docker image and example compose file with the two volumes.
- [x] `thoth.yaml`: the workspace configuration file, read at start and
      reloaded on change (first users: daily-note series and templates).
- [x] User profile with a timezone (defaults to the browser's).
- [x] Templates: plain `.md` notes with fixed variables (`{{date}}`,
      `{{date:format}}`, `{{user}}`, `{{title}}`), copied only on creation; no
      code.
- [x] Daily note, optional: series declared in `thoth.yaml` (folder and name
      pattern, `{user}` for personal ones, optional template); each person picks
      theirs. «Today» opens it or creates it (never overwriting), in the
      person's timezone; previous/next in the header.

**Done when:** with `docker compose up` over an existing folder of 1,000 notes
you can search, edit and rename without breaking links; a change made with
another editor shows up live; deleting the index and rebuilding it yields an
identical dump; a `kill -9` loses no edits.

## M2 · History

- [ ] Git in the state volume: managed, unmanaged and off modes; commits after
      a quiet period with authorship (user, agent, external).
- [ ] UI: per-note history, diff and restore.

**Done when:** any change, wherever it came from, can be seen and undone from
the UI with its author.

## M3 · Agents

- [ ] HTTP API with API keys (prefix, hash, expiry, scopes, per-folder scope).
      ETag + `If-Match` → 412, `If-None-Match: *`.
- [ ] Remote MCP: bearer token on the LAN, OAuth 2.1 when there is a public
      URL; tools registered according to scopes.
- [ ] Tools: `search`, `get_note`, `related`/backlinks, `resolve_link`,
      `create_note`, `edit_note` (flat operations with `if_match` and
      `dry_run`), `changes_since`, `move`, `delete` to trash, `daily_note`
      (today's note of the represented person, created if needed) and
      appending at the end or under a heading.
- [ ] `ai: false` restriction enforced at the single filtering point.
- [ ] Handshake tests with real MCP clients in CI.
- [ ] Privacy page: what leaves, where to and when.

**Done when:** an agent writes a plan, the user edits it in the UI and the
agent sees those changes, with safeguards and everything in the history.

## M4 · Multi-user

- [ ] Users, groups and roles; per-folder permissions in `thoth.yaml`, managed
      from the UI.
- [ ] Single filtering point with leak tests over every endpoint and tool
      (titles, backlinks, counts, candidates, errors).
- [ ] Link rewriting as the system across permissions.
- [ ] Presence and cursors across users in the editor.

**Done when:** two users with different permissions work at the same time and
the tests prove neither sees anything they shouldn't.

## M5 · Release (v1.0)

- [ ] Release policy: semver, changelog, Docker tags, migrations of `state.db`
      and `thoth.yaml`.
- [ ] Final name.
- [ ] Installation and operations documentation (volumes, backups, NFS).
- [ ] Security review.
- [ ] Public repository.

**Done when:** a third party installs and uses it following only the
documentation.

## M6 · Events

- [ ] Event log with a cursor.
- [ ] Webhooks: HMAC with timestamp, real retries, SQLite outbox, stable event
      id, delivery log, auto-disable.
- [ ] Loop breaker ("expected writes" + body hash).

**Done when:** a real integration with another application works using only
these generic pieces.

## M7 · Retrieval

- [ ] Configurable conventions for note types (decisions, projects…).
- [ ] Embeddings in a worker thread, `sqlite-vec`, hybrid search; never
      embeddings of what the agent cannot see.
- [ ] Intent tools: `project_context`, `decisions`, `timeline`.

**Done when:** an agent working on one project retrieves decisions taken in
related projects.

## Later

- E-reader: EPUB per collection and OPDS, with highlights flowing back.
- Graph view.
- OIDC, TOTP, passkeys.
- Suggestion mode for agents.
- Quotes with a text selector in the UI.

## Why this order

1. **Yjs from M1.** The editor is collaborative from birth even with one user:
   no rewriting the write path later, and several tabs or devices and live
   external changes work from the start.
2. **History before agents.** The safety net exists before AI is allowed to
   write.
3. **Agents before multi-user.** It is the reason for the project and works
   with one user. The permission engine is born in M1 (a principal on every
   query), so M4 adds users and rules without rewriting anything.
4. **Public after multi-user.** v1.0 = notes + history + agents + multi-user.
   Events and retrieval arrive as 1.x.
