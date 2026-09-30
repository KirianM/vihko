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
      file stays the source of truth. A note deleted outside vihko while open
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
      renames made outside vihko with an «update links» alert (an open note
      follows its file); per-note attachment subfolders; «text changed» marks
      on comments and confirmation before resolving; argon2id passwords; a
      tolerant, versioned `vihko.yaml` (strict only for permissions); full
      Unicode case folding in links.
- [x] Server errors and alerts as translatable codes.
- [x] Local auth: an admin created from the CLI or a one-time token, sessions.
      A principal on every query from day one.
- [x] Docker image and example compose file with the two volumes.
- [x] `vihko.yaml`: the workspace configuration file, read at start and
      reloaded on change (first users: daily-note series and templates).
- [x] User profile with a timezone (defaults to the browser's).
- [x] Templates: plain `.md` notes with fixed variables (`{{date}}`,
      `{{date:format}}`, `{{user}}`, `{{title}}`), copied only on creation; no
      code.
- [x] Daily note, optional: series declared in `vihko.yaml` (folder and name
      pattern, `{user}` for personal ones, optional template); each person picks
      theirs. «Today» opens it or creates it (never overwriting), in the
      person's timezone; previous/next in the header.

**Done when:** with `docker compose up` over an existing folder of 1,000 notes
you can search, edit and rename without breaking links; a change made with
another editor shows up live; deleting the index and rebuilding it yields an
identical dump; a `kill -9` loses no edits.

## M2 · History

- [x] Git in the state volume (managed mode, the default): commits after a
      quiet period with authorship (user, agent on behalf of a user, system
      with its reason, external). What people type in the editor shares a
      version; any other write is its own, so "just before the agent" always
      exists. Notes and attachments up to 20 MB (configurable); nothing is
      ever dropped. History never blocks a write, and a `kill -9` loses no
      authorship.
- [x] Unmanaged mode (reads the user's own git in the folder, never writes to
      it) and off, chosen in `vihko.yaml`.
- [x] UI: per-note history in the side panel, a read-only version view with an
      inline word diff, and restore (a new version, bringing back the images
      that version linked).
- [x] Recent changes: a read-only, workspace-wide feed of changes, filterable
      by author.
- [x] Resolved comments listed from history and reopenable; resolving no
      longer asks for confirmation in managed mode.
- [x] Edits an offline tab couldn't send merge after an external change vihko
      saw while running (instead of going to a copy).

**Done when:** any change, wherever it came from, can be seen and undone from
the UI with its author.

## M2.1 · History follow-ups (before agents)

From the review after comparing M2 with other systems.

- [x] External changes in a row to a file are one version (30 s quiet, 5 min
      at most), closed by any vihko write, as typing is.
- [x] A long git outage never drops a version silently: past the queue's cap,
      versions merge into the next one, with an alert.
- [x] `history.exclude` in `vihko.yaml`: patterns kept out of the history
      without hiding them from vihko.
- [x] `vihko history purge <path or version>` from the command line (vihko
      stopped): rewrites the managed history without it, for a secret an agent
      or a person pasted by mistake.

## M3 · Agents

- [x] HTTP API with API keys (`vihko_<id>_<secret>`, only the secret's
      hash kept, optional expiry). What a key may do: read, or read and
      write, in every folder its user sees or only in some. Rotation with 10
      minutes of grace for the old secret. ETag + `If-Match` → 412,
      `If-None-Match: *`. Off by default: the vihko admin turns it on,
      `VIHKO_INTEGRATIONS=off` locks it off; only the routes classified for
      keys, through the single filtering point. Keys are managed in «Agents
      and API».
- [x] Remote MCP: bearer token on the LAN, OAuth 2.1 when there is a public
      URL (`VIHKO_PUBLIC_URL`: Client ID Metadata Documents, fetched with SSRF
      protections, and dynamic registration, 5 an hour per address; PKCE;
      consent in the UI, showing the client's domain; the authorization as a
      revocable key); the tools that write only for a key that may write.
- [x] Tools: `search`, `get_note`, `list_folder`, `related`/backlinks,
      `resolve_link`, `create_note`, `edit_note` (flat operations with
      `if_match` and `dry_run`), `changes_since`, `move`, `delete` to trash,
      `daily_note` (today's note of the represented person, created if
      needed), `history` and `revert_change`, and appending at the end or
      under a heading. Everything that comes from notes (text, titles,
      frontmatter, paths, snippets) is framed as data, not instructions.
- [x] The history says who wrote a version and how: «Claude Code · on behalf
      of Noa · via MCP» (the API, MCP, or MCP with OAuth).
- [x] Login limits (exponential waits per client, account and address),
      before exposing vihko with a public URL.
- [x] Revert this change: undo only what one version changed (an agent's),
      applied to the current text, keeping what was written after; what can't
      be reverted is reported. A content-only view of a version, to copy from.
- [x] An alert when the API or MCP is on while the history is unmanaged
      (writes from vihko have no version of their own there), or off.
- [x] `ai: false` restriction enforced at the single filtering point.
- [x] Handshake tests with real MCP clients in CI (the SDK, MCP Inspector and
      `mcp-remote`, with a key and with OAuth).
- [x] Privacy page: what leaves, where to and when.

**Done when:** an agent writes a plan, the user edits it in the UI and the
agent sees those changes, with safeguards and everything in the history.

## M4 · Multi-user

- [x] Users and groups; accounts created with a one-time, expiring link (no
      SMTP), which also resets passwords; deactivate (cuts sessions, keys and
      OAuth at once) and delete (history keeps the name).
- [x] Per-folder permissions in `vihko.yaml`, managed from the UI: `read`,
      `comment`, `edit` and `manage`; inherited, with a folder's own grants
      replacing the inherited ones; deny by default. `manage` shares the folder.
      Optional `{user}` rules (e.g. a folder per person). A folder can be
      closed to agents (`ai: false`, inherited, only closes).
- [x] The vihko admin manages users, groups and permissions but only reads what
      is granted to them, like anyone else.
- [x] Single filtering point with leak tests over every endpoint, tool and
      editor message (titles, backlinks, counts, candidates, errors).
- [x] Link rewriting as the system across permissions; moving something that
      changes who can see it asks first.
- [x] Presence and cursors across users in the editor; read-only and
      comment-only editing.
- [x] Purge from history in the UI: whoever manages the folder, or the admin by
      path; on top of the M2.1 command.
- [x] A note's history (versions, diffs, resolved comments, its part of recent
      changes) needs edit permission, and so does restoring: sharing a note to
      read doesn't share its past.
- [x] An open version closes when someone who wasn't in it starts typing.
- [x] Saving a copy of an image by URL: members only from public addresses
      unless the admin allows the local network.
- [x] Second factor for users: TOTP with recovery codes; the admin makes it
      required, optional or disabled, and can reset a user's; asked again
      before OAuth consent and before creating a key.

**Done when:** two users with different permissions work at the same time and
the tests prove neither sees anything they shouldn't.

## M4.1 · Multi-user follow-ups (before release)

From the review after comparing M4 with other systems.

- [x] Resetting someone's access or second factor, or changing their role,
      asks the admin to confirm who they are, and the person and the other
      admins are told.
- [x] Whoever manages a folder keeps managing everything under it, except
      inside a personal (`{user}`) folder.
- [x] An agent that moves a note where more people can see it has to confirm
      that audience explicitly.
- [x] The editor's presence is signed by the server.
- [x] Turning the second factor off for the workspace keeps it for whoever has
      it; TOTP secrets are encrypted when the server administrator sets a key.
- [x] Whoever wrote in what gets purged from the history is told, without the
      content.
- [x] User and group names are unique in any case, in any script.

## M5 · Release (v1.0)

- [x] Release policy: semver, changelog, Docker tags, migrations of `state.db`
      and `vihko.yaml`.
- [x] Final name.
- [x] Installation and operations documentation (volumes, backups including
      the history in the state volume, NFS).
- [x] Security review.
- [x] From the release candidates: a formatting toolbar for people who don't
      write Markdown (above the note on a computer, over the keyboard on a
      phone); integration switches closed by default; the admin's purge in
      «Recent changes».
- [x] Public repository.

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
- OIDC, passkeys.
- Suggestion mode for agents.
- Quotes with a text selector in the UI.
- Request access to a note (with the event log of M6).
- Syntax highlighting in code blocks, per language, each loaded only when a
  note needs it.
- Purge from the history everything no longer in the folder, listing what is
  lost before confirming.
- Themes: light and dark as the first two of a theme system (palette and type
  per theme), so others can be added.

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
