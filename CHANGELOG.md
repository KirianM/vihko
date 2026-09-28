# Changelog

Every release of vihko, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/) with the promise explained in
[guide/upgrading.md](guide/upgrading.md): a new major version is the only kind
that asks you to do something by hand or breaks an integration. Read a
version's **Upgrade notes** before installing it.

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

[1.0.0-rc.1]: https://github.com/KirianM/vihko/releases/tag/v1.0.0-rc.1
