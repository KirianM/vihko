<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/mark-dark.svg">
  <img src=".github/assets/mark-light.svg" alt="" width="72" height="72">
</picture>

# vihko

> *Vihko* is Finnish for "notebook". Say it VIH-koh. The mark is one seen
> end-on, open on its spine, with the diamond that marks an AI agent's work
> in the app.

A self-hosted, open source notes system over plain Markdown files, with its own
web UI, multiple users, live collaboration, and a server-side index you can
query from the UI and, optionally, from an API and an MCP server.

Your notes stay a folder of `.md` files. If vihko disappears, you lose nothing.

## The problem it solves

Existing projects all fail at the same point, for the same reason:

- **Files as the source of truth** → the server knows nothing and the index
  ends up in the client (SilverBullet needs a headless Chromium on the server
  to expose its queries through an API).
- **A database as the source of truth** → you gain queries, relations,
  permissions and history, and lose portability and interchangeable editors
  (Trilium, Outline, Docmost).

vihko takes a third path: **files as the source of truth + an index on the
server**, giving up full offline mode.

## What it is and isn't

- **Files are the source of truth.** Plain Markdown in a folder you own. Edit
  it with any other editor or sync tool at the same time: vihko picks the
  changes up. It keeps your frontmatter as it is.
- **The index is disposable.** Search, links and tags live in a SQLite index
  that vihko rebuilds from the files whenever it needs to. Delete it and
  nothing is lost.
- **A complete notes system on its own**: web UI (desktop and phone), several
  people with per-folder permissions, real-time co-editing between people and
  the agents they allow in, comments, and a history of every note.
- **Closed by default.** The API and the MCP server for AI agents are built in
  but **off** until an admin turns them on. Without them, nothing gets in or
  out except through the people who sign in. No telemetry, no update checks,
  no CDNs: the UI only talks to its own server.
- **Easy to host.** One container and two folders. No reverse proxy,
  Postgres, Redis or external identity provider required.
- Not an offline-first app: the UI needs the server. No features behind a paid
  tier.

## Quick start

You need Docker with Compose on Linux (amd64 or arm64).

> [!NOTE]
> vihko is at its first release candidate: `compose.yaml` pulls
> `ghcr.io/kirianm/vihko:1.0.0-rc.1`. From 1.0.0 on it pulls `:1`.

```sh
mkdir vihko && cd vihko
curl -fsSLO https://raw.githubusercontent.com/KirianM/vihko/main/compose.yaml
mkdir notes state        # create them yourself: Docker would create them owned by root
# Only if you are root: vihko doesn't need it, give both to an ordinary user.
#   chown 1000:1000 notes state
printf 'VIHKO_UID=%s\nVIHKO_GID=%s\n' "$(stat -c %u notes)" "$(stat -c %g notes)" > .env
docker compose up -d
docker compose logs vihko
```

vihko runs as the owner of the notes folder, which `.env` names, and `state/`
belongs to that same user.

The log of the first start prints a one-time token:

```text
[vihko] first boot: no users yet. Create the admin with this one-time token
[vihko]   (in the UI, or with POST /api/setup): <token>
```

Open `http://<your-server>:8080`, paste the token, and choose the admin's name
and password (10 characters or more). That's it: create notes in the UI, or
drop `.md` files into `notes/`.

Port 8080 taken? `VIHKO_HOST_PORT=8098 docker compose up -d`. Already have
notes, on this disk or on NFS? Point the `./notes` volume at that folder, and
write its owner into `.env` instead:
[The user and file ownership](guide/install.md#the-user-and-file-ownership).
The [installation guide](guide/install.md) explains every line of the compose
file.

## Guides

- [Installation](guide/install.md): requirements, the compose file, first
  start, environment variables.
- [Notes and Markdown](guide/notes.md): what vihko reads and writes in your
  files, and editing them with other tools.
- [Configuration](guide/configuration.md): `vihko.yaml`, the workspace
  settings that live with your notes.
- [Users and permissions](guide/users-and-permissions.md): inviting people,
  groups, per-folder permissions, two-step verification.
- [History](guide/history.md): versions of every note, and how to purge one.
- [Agents](guide/agents.md): API keys, MCP on your network and remote MCP
  with OAuth.
- [API](guide/api.md): the HTTP API reference.
- [Upgrading](guide/upgrading.md): versions, image tags, updating and rolling
  back.
- [Backups](guide/backups.md): what to back up, and how to restore.
- [Reverse proxy](guide/reverse-proxy.md): HTTPS and a public address.
- [Operations](guide/operations.md): the command line, logs, NFS, and common
  problems.

The full index is in [guide/README.md](guide/README.md).

## Status

First release candidate of 1.0 (`1.0.0-rc.1`). See [ROADMAP.md](ROADMAP.md)
for what's done and what's next. Report bugs and ideas in the issues;
security vulnerabilities privately, as [SECURITY.md](SECURITY.md) explains.

## Stack

TypeScript on Node for server and UI: Yjs + Hocuspocus for collaboration,
CodeMirror 6 as the editor, React + React Aria for the UI, SQLite
(`better-sqlite3`, FTS5) for the index, and git for the history.

## Support

vihko is free software with no paid tier. If it's useful to you, you can
[buy me a coffee](https://buymeacoffee.com/kirian).

## License

[AGPL-3.0](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md).
