# thoth

> Working name. Thoth: scribe, knowledge and writing.

A self-hosted, open source notes system over plain Markdown files, with its own
web UI, multiple users, live collaboration, and a server-side index you can
query from the UI and, optionally, from an API, MCP and webhooks.

Your notes stay a folder of `.md` files. If thoth disappears, you lose nothing.

## The problem it solves

Existing projects all fail at the same point, for the same reason:

- **Files as the source of truth** → the server knows nothing and the index
  ends up in the client (SilverBullet needs a headless Chromium on the server
  to expose its queries through an API).
- **A database as the source of truth** → you gain queries, relations,
  permissions and history, and lose portability and interchangeable editors
  (Trilium, Outline, Docmost).

thoth takes a third path: **files as the source of truth + an index on the
server**, giving up full offline mode.

## What it is and isn't

- A complete notes system on its own, with its own web UI and real-time
  co-editing between people (and, later, agents).
- API, MCP and webhooks built in but **optional and off by default**. Without
  them, nothing gets in or out except through the user.
- Designed for anyone to self-host with Docker: no reverse proxy, Postgres or
  external identity provider required.
- No telemetry, no auto-update, no features behind a paid tier.

## Install

```sh
docker compose up -d        # with the example compose.yaml (adjust the volumes)
docker compose logs thoth   # the first start prints a one-time token to create the admin
# or create the admin from the command line:
docker compose exec -T thoth thoth user create <name> --admin <<< 'password'
```

The UI is at `http://<server>:8080`. If that port is taken,
`THOTH_HOST_PORT=8098 docker compose up -d`.

### Volumes

| Volume | Contents | Local disk | Network filesystem (NFS, SMB) |
|---|---|---|---|
| `/data/notes` | Your `.md` files, the source of truth. Back it up | Supported | **Supported** (a periodic rescan catches missed events) |
| `/data/state` | `state.db` (users, sessions; back it up), `index.db` (disposable), trash, collaboration logs | Supported | **Not supported**: SQLite locking over NFS is not reliable |

A Docker bind mount of a host directory that lives on NFS is NFS for all
purposes.

The container runs as the `node` user (uid 1000); `user:` in the compose file
changes it. On NFS with user mapping, files get whatever owner the export
imposes.

### Environment variables

All optional:

| Variable | Default | Purpose |
|---|---|---|
| `THOTH_NOTES_DIR` | `/data/notes` | Notes folder |
| `THOTH_STATE_DIR` | `/data/state` | Local state |
| `THOTH_HOST` / `THOTH_PORT` | `0.0.0.0` / `8080` | Where it listens |
| `THOTH_RESCAN_SECONDS` | `60` | Full rescan interval |
| `THOTH_WEB_DIR` | `packages/web/dist` | Built UI; without it the server only exposes the API |

No reverse proxy is required: it works over plain HTTP on a LAN. HTTPS and
public exposure only matter if you enable remote MCP for external clients, or
to install thoth as an app: browsers only offer to install a web app served
over HTTPS (or from `localhost`). Over plain HTTP the UI works the same in the
browser, including on a phone, and a home-screen shortcut opens it in a
browser tab. There is no offline mode either way.

## Status

Under active development towards the first milestone; see
[ROADMAP.md](ROADMAP.md). Not ready for real notes yet.

## Stack

TypeScript on Node for server and UI: Yjs + Hocuspocus for collaboration,
CodeMirror 6 as the editor, React + React Aria for the UI, SQLite
(`better-sqlite3`, FTS5) for the index.

## License

[AGPL-3.0](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md).
