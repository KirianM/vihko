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
mkdir -p notes state        # the two volumes, owned by you (Docker would create them as root)
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
changes it. Both folders must exist and be writable by that user before the
first start: a bind-mount folder that doesn't exist is created by Docker as
root, and the server then can't open `state.db` (`SQLITE_CANTOPEN`, restarting
in a loop). On NFS with user mapping, files get whatever owner the export
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
| `THOTH_MAX_IMAGE_MB` | `20` | Largest image stored from an upload, a paste or a URL |
| `THOTH_EXTERNAL_IMAGES` | `allow` | `block` stops the browser loading images that notes link from other sites; a box with the domain is shown instead |

No reverse proxy is required: it works over plain HTTP on a LAN. HTTPS and
public exposure only matter if you enable remote MCP for external clients, or
to install thoth as an app: browsers only offer to install a web app served
over HTTPS (or from `localhost`). Over plain HTTP the UI works the same in the
browser, including on a phone, and a home-screen shortcut opens it in a
browser tab. There is no offline mode either way.

## Workspace configuration: `thoth.yaml`

Settings that belong to the notes rather than to the installation live in
`thoth.yaml`, at the root of the notes folder, so they travel and are
versioned with the notes. It is optional: without it nothing is turned on.
thoth only reads it (at start, when it changes, and on every rescan) and never
writes to it; it doesn't show up as a note.

```yaml
version: 1                  # optional
templates: Templates        # folder offered when creating a note from a template
daily:                      # daily-note series; the first one is the default
  journal:                  # id: letters, digits, "-" or "_"
    label: Journal          # optional, shown in the UI
    folder: Journal/{user}  # {user}: one journal per person; leave it out to share one
    name: "{YYYY}-{MM}-{DD}"  # optional; this is the default
    template: Templates/Daily # optional note, from the notes root
  weekly:
    folder: Weeks
    name: "{GGGG}-W{WW}"    # ISO week and its year
attachments:
  folder: Attachments       # optional: new images go here instead of next to their note
```

- **Series patterns** take `{YYYY}`, `{MM}`, `{DD}`, `{GGGG}` (ISO week year),
  `{WW}` (ISO week) and `{user}`, and must name one note per day
  (`YYYY`+`MM`+`DD`), week (`GGGG`+`WW`), month (`YYYY`+`MM`) or year. Each
  person picks their series in their preferences; «Today» opens that note in
  their own timezone, or creates it from the template if it doesn't exist
  (never overwriting one). It is in the sidebar, the palette and on
  Ctrl+Alt+D (⌘⌥D); previous and next are in the note header.
- **Templates** are plain notes. When a note is created from one, these are
  filled in, and nothing else runs: `{{title}}` (the new note's name),
  `{{user}}`, `{{date}}` (`YYYY-MM-DD`) and `{{date:FORMAT}}`, with the tokens
  `YYYY`, `YY`, `MM`, `M`, `DD`, `D`, `GGGG`, `WW`, `W`, `HH` and `mm`; text in
  `[brackets]` is literal (`{{date:[Week] W}}`). Anything else in `{{…}}` is
  left as is. The date is the person's, in their timezone.
- **Errors** don't stop thoth: an invalid file shows up as a workspace alert
  with the reason and line, and thoth keeps using the last valid version it
  read. Unknown keys are errors, not ignored, so a typo never looks like a
  working setting. `permissions` is reserved for per-folder permissions and
  refused until they exist.

## Status

Under active development towards the first milestone; see
[ROADMAP.md](ROADMAP.md). Not ready for real notes yet.

## Stack

TypeScript on Node for server and UI: Yjs + Hocuspocus for collaboration,
CodeMirror 6 as the editor, React + React Aria for the UI, SQLite
(`better-sqlite3`, FTS5) for the index.

## License

[AGPL-3.0](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md).
