# Changelog

Every release of vihko, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/) with the promise explained in
[guide/upgrading.md](guide/upgrading.md): a new major version is the only kind
that asks you to do something by hand or breaks an integration. Read a
version's **Upgrade notes** before installing it.

## [1.0.1-rc.1] - 2026-09-29

A correction of 1.0.0, published the same day. Taking the inventory of what
1.x promises (`guide/compatibility.md`, new) showed a few things 1.0.0 got
wrong; 1.0.1 changes them outright, **once**, instead of keeping both forms
until 2.0. It's the only exception to the promise, and it's written down in
that page.

### Added

- `guide/compatibility.md`: everything 1.x keeps stable, taken from the code
  (the HTTP API route by route, the MCP tools, `vihko.yaml`, environment
  variables, the Docker image, the command line, what vihko writes into notes,
  OAuth), and what isn't covered.
- The command line is part of the promise: commands, options and exit status
  (0 done, 1 an error, 2 the usage).
- Before publishing, a release now starts the previous stable version, fills
  it with users, a key, notes, an image and a comment, and starts the new
  version on the same data (`npm run upgrade-smoke`).

### Changed

- **HTTP API: the fields that came in `snake_case` are `camelCase`**, like all
  the others: `meta.fm_error` is `meta.fmError`; a link's `dst_path`,
  `anchor_ok`, `pos_from` and `others_no_access` are `dstPath`, `anchorOk`,
  `posFrom` and `othersNoAccess`. The MCP tools keep `snake_case`, their
  convention throughout.
- `POST /api/note/edit` answers a malformed operation (unknown `op`, missing or
  wrong field, none or more than 50 operations, `set_frontmatter` on `uid`)
  with `400 invalid`, as MCP does; it was `409 edit_mismatch`.
- MCP: arguments that don't fit a tool answer `invalid`, and a writing tool
  called with a read-only key answers `forbidden`, both in vihko's
  `{ error, message }` JSON.
- Limits (image size, operations per call…) may go down within 1.x, announced
  here in the Upgrade notes.

### Fixed

- **Moving or renaming a note to a name with parentheses, `#`, `?` or
  brackets (`a (1).md`) left the Markdown links to it broken.** Rewritten
  links are now encoded like image links, and keep their `<…>` form, anchor
  and title.
- `/api/health` and `/api/setup` answered 404 when the request carried a key.
- `vihko user create --admin <name>` created an admin named `--admin`, and
  `vihko serve` took any argument.
- On Windows, AltGr+D (a character on some keyboards) opened today's note
  instead of typing it.
- The image's description no longer mentions webhooks, which 1.0 doesn't
  have.
- The guides: only MCP `get_note` takes a `uid`; history author kinds `git`
  and `external` and several response fields documented; which environment
  variables are checked.

### Upgrade notes

- Test it with `ghcr.io/kirianm/vihko:1.0.1-rc.1`; `:1` moves to 1.0.1 when
  it's released.
- Scripts that read `fm_error`, `dst_path`, `anchor_ok`, `pos_from` or
  `others_no_access` from the HTTP API read the `camelCase` names.
- Scripts that rely on `409 edit_mismatch` for a malformed edit get
  `400 invalid`, and at most 50 operations per call.
- `vihko user create` with arguments other than a name and `--admin`, or
  `vihko serve` with any argument, prints the usage and exits with 2.

## [1.0.0] - 2026-09-29

The first stable release: a self-hosted notes system over plain Markdown
files, with its own web UI, several users and live collaboration. Your notes
stay a folder of `.md` files; the index, the history and the application state
live apart and never replace them.

![vihko on a computer, half in the light theme and half in the dark one](https://raw.githubusercontent.com/KirianM/vihko/v1.0.0/.github/assets/screenshots/desktop.png)

What 1.0 brings, from the release candidates below:

- **Notes**: a live-preview editor for computer and phone with a formatting
  toolbar, wikilinks and Markdown links that follow renames and moves,
  backlinks, tags, tasks, tables, images, comments inside the note, search,
  templates and daily notes. Changes made by other editors or sync tools on
  the same folder are picked up while vihko runs.
- **Collaboration and people**: several people in the same note at once, with
  presence; users and groups, per-folder permissions (read, comment, edit,
  manage), personal folders, sign-up links and a second factor.
- **History**: every note's versions, diffs and restore, recent changes for
  the workspace, and purging what shouldn't have stayed.
- **Agents, optional and off by default**: an HTTP API with keys and an MCP
  server (with OAuth for remote clients), which only see and write what the
  person they act for can.
- **Operations**: one Docker image for amd64 and arm64, a hardened
  `compose.yaml`, automatic migrations with a backup, and guides for
  installing, backing up, upgrading and running it behind a reverse proxy.

### Changed

- `compose.yaml` pulls `ghcr.io/kirianm/vihko:1`: every 1.x release, never an
  incompatible version.
- The README shows the product, on a computer and on a phone.

### Upgrade notes

- From a release candidate: change the image line of your `compose.yaml` to
  `ghcr.io/kirianm/vihko:1` (or take the new file); nothing else changes since
  1.0.0-rc.4.

## [1.0.0-rc.4] - 2026-09-29

The fourth release candidate: what the third one's installation turned up.

### Added

- **A formatting toolbar**, for anyone who doesn't write Markdown: above the
  note on a computer, over the keyboard on a phone (one row that scrolls).
  Text style (normal, headings 1–3), bold, italic, strikethrough, inline
  code, link, bulleted, numbered and task lists, quote, code block, table and
  image, besides `[[`, `#` and comments. Each button turns its format off
  when it's already on and shows when the cursor is inside it; line formats
  apply to every selected line. It only writes standard Markdown.
- Shortcuts: Ctrl+B bold, Ctrl+I italic (it was «select the enclosing
  syntax»), Ctrl+Alt+K link (⌘B, ⌘I and ⌥⌘K on a Mac).
- «New folder» in the command palette (`>`), inside the open note's folder.

### Changed

- **Members can no longer create keys by default**, and **OAuth apps can no
  longer register themselves by default**: the vihko admin turns each on in
  Agents and API. The registration switch sits right under the MCP one;
  clients that identify themselves with a URL (CIMD) don't need it.
- The vihko admin's «Purge from the history» moved from Users and groups to
  Recent changes.
- On a phone, the save status in the bottom bar is an icon while all is well,
  and keeps its text when something needs your attention.

### Fixed

- Recent changes stopped loading after any purge from the history, until
  vihko restarted.
- Strikethrough and inline code show as such in the editor.

### Upgrade notes

- Take the image line of the new `compose.yaml`
  (`ghcr.io/kirianm/vihko:1.0.0-rc.4`).
- If you never touched «Members can create keys» or «OAuth apps can register
  themselves», they are now off. Members' existing keys and apps already
  registered keep working; turn the switches on in Agents and API if members
  should create keys or claude.ai or mcp-remote should connect anew.

## [1.0.0-rc.3] - 2026-09-29

### Added

- **Agents can store images through MCP**: the `attach_image` tool (keys
  that can write) takes an image in base64 and the note it's for, stores it
  like an upload (next to the note by default, within the key's folders and
  never where agents are kept out) and answers with the link to write into
  the note. Images up to about 3 MB fit in one call.

### Fixed

- The API's answer to an image upload carries `markdown`, the link ready to
  write into the note. Writing `src` as it was broke the link when the name
  had a space: the note didn't use the image, a key couldn't read it, and
  deleting the note left it behind.

### Upgrade notes

- Take the image line of the new `compose.yaml`
  (`ghcr.io/kirianm/vihko:1.0.0-rc.3`); nothing else changes.
- Scripts that upload images through the API should write the answer's
  `markdown` into the note instead of building the link from `src`.

## [1.0.0-rc.2] - 2026-09-29

The second release candidate: what the first one's installations turned up.

### Fixed

- **An undo made in another editor is no longer overwritten.** With a note
  open in vihko, undoing a change in another editor (saving back the text it
  had before) could be undone again by vihko, which wrote its own copy over
  the file. The other editor's save now wins, and live edits are still kept
  when another program saves from an old copy of the file.
- Markdown links (`[text](note.md)`, `[text](https://…)`), also in tables, can
  be clicked: a note opens, an external address opens in a new tab.
- Inserting an image right after pasting or clicking another no longer puts
  it inside the first one's reference; nothing inserted lands inside a link,
  an image or a comment.
- Renaming, moving or deleting a note takes its saved editor state along, so
  none is left behind in the state volume.
- Name fields no longer start with a capital letter on phones.
- «1 workspace alert», singular.

### Added

- **A language preference**, in Preferences → Account and in ⌘K: English,
  Spanish or the browser's, saved in your account.
- Deleting a note sends the images only it uses to the trash with it, and
  restoring it brings them back.
- **Delete folder** lists what the folder holds and can send it all to the
  trash in one step.
- On a computer, commented text shows that it has comments and opens them on
  a click, with the side panel closed too.
- A warning at start when `VIHKO_TRUSTED_PROXIES` covers a wide range.
- The guide [First steps in the app](guide/first-steps.md), and fuller guides
  for a reverse proxy on another machine and for file ownership.

### Changed

- **The example `compose.yaml` runs vihko as the owner of your notes**:
  `user: "${VIHKO_UID:-1000}:${VIHKO_GID:-1000}"`, with the ids in `.env`
  (the quick start writes it). When vihko can't write its folders it says so
  in one line with the fix, instead of a stack trace.
- vihko doesn't start when the notes folder is missing (an unmounted share
  would look like an empty one).
- Typing `folder/name` in New note creates the note in that folder (from the
  current one; `/folder/name` from the root), and its heading is only the
  name.
- A code block's fences hide while the cursor is outside it; its language
  shows as a small label.
- The workspace alerts' address is `?view=alerts` (`?view=avisos` still
  opens it).

### Upgrade notes

- **Take the new `compose.yaml`** (`image: ghcr.io/kirianm/vihko:1.0.0-rc.2`
  and the `user:` line). Without a `.env`, vihko runs as 1000:1000 as before.
  If your notes belong to another user, write `VIHKO_UID` and `VIHKO_GID` to
  `.env` next to `compose.yaml` and give the `state` folder to that user; see
  [The user and file ownership](guide/install.md#the-user-and-file-ownership).
- `state.db` is migrated at the first start (a copy stays as
  `state.db.bak-v8`); to go back to 1.0.0-rc.1, follow
  [Rolling back](guide/upgrading.md#rolling-back).
- If your notes folder is a network share, make sure it's mounted before vihko
  starts: it no longer starts on an empty mount point.
- `VIHKO_TRUSTED_PROXIES` must be your proxy's own address, not a range around
  it (for example `10.0.0.50`, not `10.0.0.50/8`).

## [1.0.0-rc.1] - 2026-09-28

The first release candidate of vihko 1.0: a self-hosted notes system over a
folder of plain Markdown files, for one person or a small group. Install it
with the [installation guide](guide/install.md); a release candidate is only
published under its exact image tag, `ghcr.io/kirianm/vihko:1.0.0-rc.1`.

### Added

- **Your notes stay files.** A folder of `.md` files you can open and change
  with any other editor or sync tool at the same time; vihko picks the changes
  up and keeps your frontmatter as it is. Its search index is disposable and
  rebuilt from the files.
- **A web app for desktop and phone**, installable as an app: the editor with
  live preview, links between notes with renames that rewrite them, tags,
  search, backlinks, images, templates and daily notes, in English and Spanish,
  light and dark.
- **Several people**, each with their own account: per-folder permissions
  (read, comment, edit, manage) passed down to subfolders, personal folders
  that not even the admin reads, groups, sign-up and password reset by one-time
  links (no email server needed), two-step verification, and sign-in limits.
- **Live co-editing** between people and the AI agents they allow in, with
  comments anchored to the text.
- **History of every note**, kept in the state volume: browse versions, see who
  wrote what, restore, and purge.
- **Optional API and MCP server**, off until an admin turns them on: keys for
  scripts and agents that never see more than their person, folders closed to
  agents, and remote MCP with OAuth for clients such as claude.ai.
- **One container, two folders**: amd64 and arm64 images, no database server,
  no reverse proxy required, and no telemetry: the server only reaches outside
  when someone asks it to (saving an image from its address, a remote MCP
  client's metadata).

### Upgrade notes

- First release: there is nothing to upgrade from. Installations made from
  development builds before this candidate (under the project's earlier
  working name) aren't migrated: start them again from empty state.

[1.0.1-rc.1]: https://github.com/KirianM/vihko/releases/tag/v1.0.1-rc.1
[1.0.0]: https://github.com/KirianM/vihko/releases/tag/v1.0.0
[1.0.0-rc.4]: https://github.com/KirianM/vihko/releases/tag/v1.0.0-rc.4
[1.0.0-rc.3]: https://github.com/KirianM/vihko/releases/tag/v1.0.0-rc.3
[1.0.0-rc.2]: https://github.com/KirianM/vihko/releases/tag/v1.0.0-rc.2
[1.0.0-rc.1]: https://github.com/KirianM/vihko/releases/tag/v1.0.0-rc.1
