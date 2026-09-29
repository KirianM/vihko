# Changelog

Every release of vihko, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/) with the promise explained in
[guide/upgrading.md](guide/upgrading.md): a new major version is the only kind
that asks you to do something by hand or breaks an integration. Read a
version's **Upgrade notes** before installing it.

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

[1.0.0-rc.2]: https://github.com/KirianM/vihko/releases/tag/v1.0.0-rc.2
[1.0.0-rc.1]: https://github.com/KirianM/vihko/releases/tag/v1.0.0-rc.1
