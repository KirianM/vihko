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
| `/data/state` | `state.db` (users, sessions; back it up), the managed history (`history.git`; back it up), `index.db` (disposable), trash, collaboration logs | Supported | **Not supported**: SQLite locking over NFS is not reliable |

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
| `THOTH_INTEGRATIONS` | unset | `off` keeps the API with keys and the MCP server off whatever the admin turns on in the UI |

### Command line

The image's `thoth` command, run inside the container (`docker compose exec
thoth thoth …` while it runs, `docker compose run --rm thoth thoth …` while
it's stopped):

| Command | What it does |
|---|---|
| `thoth serve` | Starts the server (what the container runs) |
| `thoth user create <name> [--admin]` | Creates a user; the password is read from standard input |
| `thoth history purge <path> [--version <id>] [--dry-run]` | Rewrites the managed history without a file or folder, or without one version of a file |

**`thoth history purge`** is for something that should never have been kept,
such as a secret pasted into a note by mistake:

- `<path>` is a file or a folder, relative to the notes folder: it goes from
  every version. With `--version <id>` (the version's id, as in the address of
  a version: `?version=<id>`; 7 characters are enough), only the content that
  file has in that version goes: wherever the file held it, it holds what it
  had right before. `--dry-run` lists the commits and files it would change,
  and changes nothing.
- thoth must be stopped: the server and the command take the same lock in the
  state volume (`thoth.lock`), which is released however a process ends, so
  it refuses while thoth runs (and a second server refuses to start on the
  same state volume). `--dry-run` only reads, and works with thoth running.
- Only the managed history: in unmanaged mode the repository is yours and it
  refuses. Everything else keeps its authors, dates and moves; a commit left
  with no change is dropped, and the versions after the first rewritten one
  get new ids.
- The repository is left compacted: the purged content is in no commit,
  reflog or pack, unless the same content is also stored under another path,
  which it reports. If it is stopped half way, the history stays as it was;
  running it again finishes the work.
- It never touches the notes folder. If the file is still there, its content
  enters the history again with its next version: delete it, or add it to
  `history.exclude` first (the command warns). Nor does it touch the trash or
  the editors' recovery files in the state volume.

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
attachments:                # where new images go (uploads, pastes, copies from a URL)
  mode: next-to-note        # next-to-note (default), folder or per-note
  # folder: Attachments     # with mode: folder, every new image goes here
  # suffix: .assets         # with mode: per-note, plan.md keeps its images in plan.assets/
links:
  aliases: true             # optional; false: frontmatter aliases don't resolve [[links]]
history:
  mode: managed             # managed (default), unmanaged (read the folder's own git) or off
  maxFileSize: 20           # MB; larger files don't enter the history
  exclude:                  # kept out of the history (still indexed, shown and edited)
    - Library/**
    - "**/*.pdf"
    - Drafts/private.md
```

- **Images** go next to their note by default (`plan-2026-09-25-1012.png`).
  `mode: folder` puts them all in one folder (`folder` alone implies it).
  `mode: per-note` gives each note its own folder next to it, named after it
  plus `suffix` (`.assets` by default, as in Typora): `plan.assets/2026-09-25-1012.png`.
  Renaming or moving the note moves that folder whole, renamed to match, and
  rewrites every link into it, from the note or from any other. It stays where
  it is (and the links are rewritten to reach it there) if the new name is
  already taken or it holds notes; the move's preview says so. In every mode,
  images next to the note that no other note uses go with it when it changes
  folder.

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
- **Aliases** in a note's frontmatter resolve `[[links]]` as a last resort,
  after names and paths. Set `links.aliases: false` if the folder is shared
  with a tool where they don't (Obsidian): `[[alias]]` is then a broken link,
  autocomplete still offers aliases but inserts `[[Note|alias]]`, and a
  rename that couldn't rewrite some link no longer adds the old name as an
  alias. Changing it re-resolves every link without reindexing the notes.
- **History exclusions** are path patterns from the notes root: `*` and `?`
  within one name, `**` for any number of folders. A pattern covers what is
  under it, so `Library`, `Library/` and `Library/**` all exclude that folder;
  `*.pdf` only matches at the root, `**/*.pdf` everywhere. Excluded files
  aren't hidden from thoth, only their changes aren't saved as versions, and
  the note's history tab says so. Changing the list applies at once; what
  the history already holds stays (`thoth history purge` removes it). A note
  moved into an excluded folder leaves the history; moved out, it enters.
- **Versions and unknown keys:** `version` (1 if missing) says which format
  the file follows. A key thoth doesn't know (a typo, or a setting from a
  newer thoth) is ignored and listed in a workspace alert with its line; the
  rest of the file applies. A `version` newer than thoth's gets the same
  treatment: what it understands applies, and the alert says so.
- **Errors** don't stop thoth: a file that isn't valid YAML, or a known key
  with a wrong value (a path outside the notes folder, a bad series pattern),
  shows up as a workspace alert with the reason and line, and thoth keeps
  using the last valid version it read.
- **Security sections are strict.** `permissions` (per-folder permissions,
  not built yet) is reported and never applied. Once it exists, anything
  doubtful in it (an unknown key included) rejects that section alone, and
  the most restrictive setting applies instead.

## Status

Under active development towards the first milestone; see
[ROADMAP.md](ROADMAP.md). Not ready for real notes yet.

## Stack

TypeScript on Node for server and UI: Yjs + Hocuspocus for collaboration,
CodeMirror 6 as the editor, React + React Aria for the UI, SQLite
(`better-sqlite3`, FTS5) for the index.

## License

[AGPL-3.0](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md).
