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
query from the UI and, optionally, from an API, MCP and webhooks.

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

- A complete notes system on its own, with its own web UI and real-time
  co-editing between people and the agents they allow in.
- API, MCP and webhooks built in but **optional and off by default**. Without
  them, nothing gets in or out except through the user.
- Designed for anyone to self-host with Docker: no reverse proxy, Postgres or
  external identity provider required.
- No telemetry, no auto-update, no features behind a paid tier.

## Install

```sh
mkdir -p notes state        # the two volumes, owned by you (Docker would create them as root)
docker compose up -d        # with the example compose.yaml (adjust the volumes)
docker compose logs vihko   # the first start prints a one-time token to create the admin
# or create the admin from the command line:
docker compose exec -T vihko vihko user create <name> --admin <<< 'password'
```

The UI is at `http://<server>:8080`. If that port is taken,
`VIHKO_HOST_PORT=8098 docker compose up -d`.

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
| `VIHKO_NOTES_DIR` | `/data/notes` | Notes folder |
| `VIHKO_STATE_DIR` | `/data/state` | Local state |
| `VIHKO_HOST` / `VIHKO_PORT` | `0.0.0.0` / `8080` | Where it listens |
| `VIHKO_RESCAN_SECONDS` | `60` | Full rescan interval |
| `VIHKO_WEB_DIR` | `packages/web/dist` | Built UI; without it the server only exposes the API |
| `VIHKO_MAX_IMAGE_MB` | `20` | Largest image stored from an upload, a paste or a URL |
| `VIHKO_EXTERNAL_IMAGES` | `allow` | `block` stops the browser loading images that notes link from other sites; a box with the domain is shown instead |
| `VIHKO_INTEGRATIONS` | unset | `off` keeps the API with keys and the MCP server off whatever the admin turns on in the UI |
| `VIHKO_PUBLIC_URL` | unset | The `https://` address vihko is reached at from outside, behind a reverse proxy (origin only). Turns on OAuth for the MCP server while it's on, for remote assistants such as claude.ai; see [Remote MCP](#remote-mcp-with-a-public-url-oauth) |
| `VIHKO_TRUSTED_PROXIES` | unset | Addresses or CIDR ranges of your reverse proxies (`172.16.0.0/12, 10.0.0.5`). Only from them is `X-Forwarded-For` believed, to tell clients apart for the [login limits](#login-limits); unset, the connection's address counts and the header is ignored |
| `VIHKO_SECRET_KEY` / `VIHKO_SECRET_KEY_FILE` | unset | A key (32 characters or more) that encrypts the second factor's secrets in `state.db`, or the file that holds it (a Docker secret). See [The second factor's key](#the-second-factors-key) |

### Command line

The image's `vihko` command, run inside the container (`docker compose exec
vihko vihko …` while it runs, `docker compose run --rm vihko vihko …` while
it's stopped):

| Command | What it does |
|---|---|
| `vihko serve` | Starts the server (what the container runs) |
| `vihko user create <name> [--admin]` | Creates a user; the password is read from standard input |
| `vihko user reset-link <name>` | Prints a one-time link (7 days) for that user to choose a new password: the way back for an admin who lost theirs. Any earlier link of theirs stops working. A second factor they have is still asked for after it |
| `vihko user reset-2fa <name>` | Takes away that user's second factor (TOTP and recovery codes). With `reset-link`, the way back for an admin who lost both password and phone; also for whoever's second factor can't be read after `VIHKO_SECRET_KEY` was lost or changed |
| `vihko history purge <path> [--version <id>] [--dry-run]` | Rewrites the managed history without a file or folder, or without one version of a file |
| `vihko version` (or `vihko --version`) | Prints vihko's version |

**`vihko history purge`** is for something that should never have been kept,
such as a secret pasted into a note by mistake:

- `<path>` is a file or a folder, relative to the notes folder: it goes from
  every version. With `--version <id>` (the version's id, as in the address of
  a version: `?version=<id>`; 7 characters are enough), only the content that
  file has in that version goes: wherever the file held it, it holds what it
  had right before. `--dry-run` lists the commits and files it would change,
  and changes nothing.
- vihko must be stopped: the server and the command take the same lock in the
  state volume (`vihko.lock`), which is released however a process ends, so
  it refuses while vihko runs (and a second server refuses to start on the
  same state volume). `--dry-run` only reads, and works with vihko running.
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
to install vihko as an app: browsers only offer to install a web app served
over HTTPS (or from `localhost`). Over plain HTTP the UI works the same in the
browser, including on a phone, and a home-screen shortcut opens it in a
browser tab. There is no offline mode either way.

## Remote MCP with a public URL (OAuth)

On your network, an agent connects to `http://<server>:8080/mcp` with a key
made in Settings → Agents and API (it shows ready-made configurations for
Claude Code, Claude Desktop and others). A remote assistant such as
claude.ai (web, desktop or mobile) is different: it connects from its own
servers, not from your computer, and signs in with OAuth instead of a key.
For that, vihko needs a public HTTPS address:

1. **Put vihko behind a reverse proxy with HTTPS**, on a name the internet can
   reach. The whole application goes through it: the authorization page is
   the UI, with its login. With [Caddy](https://caddyserver.com), which gets
   the certificate and passes WebSockets and `X-Forwarded-Proto` on its own:

   ```
   notes.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```

   With another proxy: keep the `Host` header, set `X-Forwarded-Proto: https`
   (vihko marks its session cookie `Secure` from it), allow WebSocket upgrades
   (`/collab`, the live editor) and keep request timeouts above 60 seconds
   (`/mcp` may wait up to 30 seconds for a change). Declare the proxy's
   address in `VIHKO_TRUSTED_PROXIES` (as vihko sees it: `127.0.0.1` on the
   same host, the Docker network's range such as `172.16.0.0/12` in a
   container), so the [login limits](#login-limits) count each client apart
   and not everyone as the proxy.
2. **Give vihko that address**: `VIHKO_PUBLIC_URL=https://notes.example.com`
   (the origin only, `https`), and restart it. In `compose.yaml`, under
   `environment:`.
3. **Turn on the MCP server**, as the vihko admin, in Settings → Agents and
   API. OAuth only exists while both hold: without `VIHKO_PUBLIC_URL`, or with
   the MCP server off (or `VIHKO_INTEGRATIONS=off`), every OAuth address
   answers 404 and `/mcp` takes keys only.
4. **Add it to claude.ai** as a custom connector (Settings → Connectors → Add
   custom connector) with the URL `https://notes.example.com/mcp`. Claude
   introduces itself (it registers, or names itself by the address of its
   description) and sends you to vihko: sign in, check who asks (the app's
   domain, when it has one) and what it may do (read-only and every folder
   unless you choose otherwise), and authorize it. Other clients that speak
   MCP with OAuth, such as `mcp-remote`, work the same way.

The authorization is one more key in Agents and API, named after the app,
used "via MCP (OAuth)" in the history and the editor: change what it may do
there, or revoke it, which stops its tokens at once. Access tokens last an
hour; refresh tokens change on every use and expire after 30 days unused.

What a public address exposes, besides the UI and its login (use strong
passwords): the OAuth metadata (`/.well-known/oauth-*`), client registration
(`/oauth/register`), and the token and revocation endpoints. None of them
gives access to any note without a person approving it. Registration is open
by default, as claude.ai needs it, and limited to 5 clients an hour from each
address (then `429` with `Retry-After`; with a proxy, see
`VIHKO_TRUSTED_PROXIES` above); once your clients are connected, the vihko
admin can turn it off in Agents and API, and those clients keep working.

Since anyone can register a client with any return address, vihko never
sends the browser to one on its own: an authorization request that isn't
valid is shown as an error on vihko's page (a `400` to a client asking for
JSON), not sent back to the app. The browser only goes back to the app when
the person authorizes or denies it on the consent page, which shows where it
goes.

An app can also name itself by an `https` address that describes it (a
*Client ID Metadata Document*, which the MCP authorization specification of
2026-07-28 prefers to registration). Then vihko fetches that address, and
it's the only request vihko ever makes on its own: only when someone signed
in starts authorizing that app, only over `https` on port 443, never to an
address that isn't public (private, loopback, link-local and the like,
checked after resolving the name, and the connection goes to the address
that was checked), without following redirects, 5 KB and 5 seconds at most,
and kept in memory for a few minutes. The consent page shows that domain.

### Login limits

Signing in and the first-boot token are limited, so that a password can't be
guessed by trying (OWASP's exponential lockout and device cookies). After a
few failures, whoever keeps failing has to wait before trying again, and the
wait doubles with each failure, from one second up to a cap:

| Counter | Free failures | Longest wait |
|---|---|---|
| One client (address or browser) and one username | 5 | 15 minutes |
| One username, from anywhere | 10 | 1 minute |
| One address, any username | 20 | 15 minutes |

While a wait is in force the answer is `429 too_many_attempts` with
`Retry-After`, and the password isn't even checked. A successful sign-in
clears that username's counters and leaves a cookie in the browser: from a
browser that has signed in before, only its own failures count, so nobody can
lock you out by failing with your name. From a new browser, while someone keeps
guessing your name, you wait the username's part: a minute at most. A counter
is forgotten an hour after its last failure. With many failures in the past
day, the vihko admin gets an alert.

The counters live in memory: restarting vihko forgets them (and browsers sign
in as new ones once). Their number is capped, so made-up usernames can't fill
the memory. Behind a reverse proxy, set `VIHKO_TRUSTED_PROXIES`, or every
client counts as the proxy's address.

One-time links (invitations and password resets) and the first-boot token are
limited too, but only by client address (the first and last counters, with
every link, or the token, counted as one username): they are long random tokens,
so a guess spread over many addresses gets nowhere, and nobody guessing
elsewhere can hold back the person who has the real link.

Codes of the second factor (a TOTP code or a recovery code, at sign-in or when
confirming a new key or an OAuth client) are limited the same way, with
counters of their own for each username: knowing the password doesn't give
fresh guesses at the code.

### The second factor's key

To check someone's second-factor codes, vihko has to keep the secret their
authenticator app was given, in `state.db`. Without a key it's kept as it is:
anyone with a copy of `state.db` (a backup) could compute that person's codes.
With `VIHKO_SECRET_KEY`, the secrets are stored encrypted (AES-256-GCM, with a
key derived from yours), and a copy of `state.db` alone is not enough.

```sh
openssl rand -base64 32   # a key; keep it apart from the backups of the state volume
```

- Give it as `VIHKO_SECRET_KEY`, or in a file named by `VIHKO_SECRET_KEY_FILE`
  (a Docker secret: `/run/secrets/…`), not both. A key shorter than 32
  characters, or a file that can't be read, stops vihko from starting.
- vihko never writes the key to disk or to its log, and takes it out of its
  environment once read.
- Setting it on an installation that already has second factors: they are
  encrypted when vihko starts (the log says how many). Without it, they're
  stored as before; both kinds can coexist.
- **If the key is lost or changed**, the secrets encrypted with the old one
  can't be read. vihko still starts, and tells the admin in «Alerts» whose
  second factor can't be checked. Those people can still sign in with a
  recovery code; otherwise `vihko user reset-2fa <name>` (or the admin, in
  «Users and groups») takes theirs away so they set it up again. Putting the
  old key back makes them readable again.

## Workspace configuration: `vihko.yaml`

Settings that belong to the notes rather than to the installation live in
`vihko.yaml`, at the root of the notes folder, so they travel and are
versioned with the notes. It is optional: without it nothing is turned on.
vihko reads it at start, when it changes, and on every rescan; it writes
`permissions`, from the permissions dialog, and rewrites the file to the
current format at start after an upgrade (see below). It doesn't show up
as a note, and it's served to nobody (it holds the permissions).

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
permissions:                # who reads what, per folder; without it, every admin manages the root
  "":                       # the root
    grants: { noa: manage }
  Family:
    grants: { "@family": edit, noa: edit }
  "People/{user}":          # one folder per person, theirs
    grants: { "{user}": manage }
  People/laura/Diary:
    ai: false               # closed to agents, with everything under it
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
  aren't hidden from vihko, only their changes aren't saved as versions, and
  the note's history tab says so. Changing the list applies at once; what
  the history already holds stays (`vihko history purge` removes it). A note
  moved into an excluded folder leaves the history; moved out, it enters.
- **Versions and unknown keys:** `version` (1 if missing) says which format
  the file follows. A key vihko doesn't know (a typo, or a setting from a
  newer vihko) is ignored and listed in a workspace alert with its line; the
  rest of the file applies. A `version` newer than vihko's gets the same
  treatment: what it understands applies, and the alert says so.
- **Format changes on upgrade:** when a new version of vihko changes how
  something is written in `vihko.yaml`, vihko rewrites the file itself when
  it starts, before reading it: only what changed, keeping comments, key
  order and keys it doesn't know. The file as it was is copied first to the
  state volume (`config-backups/`, the latest 10 copies), never to the notes
  folder. Each rewrite is logged and shown to the admins in «Alerts» until
  one dismisses it. A file that isn't valid YAML, or that can't be written,
  is left as it is and the alert says so; the next start tries again. vihko
  never rewrites the file while it runs.
- **Errors** don't stop vihko: a file that isn't valid YAML, or a known key
  with a wrong value (a path outside the notes folder, a bad series pattern),
  shows up as a workspace alert with the reason and line, and vihko keeps
  using the last valid version it read.
- **Permissions** (`permissions`) are per folder: each key is a folder
  (`""` the root, and a `{user}` segment makes a rule hold for each user),
  with `grants` from a user's name, `@group` or `{user}` to `read`,
  `comment`, `edit` or `manage`, and `ai: false` to close it (and what's
  under it) to agents. A folder with grants of its own replaces what it
  would inherit; one without them inherits from the nearest folder above
  that has some. Whoever manages a folder keeps `manage` in everything
  under it, even in a subfolder whose own grants don't name them, except in
  personal folders (those a `{user}` rule matches) and under them: nobody
  from above gets into one. Nobody reads what isn't granted or managed from
  above, the admin included: an admin who manages the root reads everything
  but other people's personal folders, unless they're shared with them.
  Without the section, every admin manages the root. vihko writes this
  section itself from the permissions dialog (only the entries that change;
  the rest of the file stays as it was) and moves a folder's rules when the
  folder moves from vihko.
- **Security sections are strict.** Anything doubtful in `permissions` (an
  unknown key included) rejects that section alone: if vihko starts that
  way, nobody reads any note until it's fixed; if it happens while running,
  the last valid permissions stay. Grants to users or groups that don't
  exist are ignored with a warning, so deleting someone never invalidates
  the section.

## Status

Under active development towards the first milestone; see
[ROADMAP.md](ROADMAP.md). Not ready for real notes yet.

## Stack

TypeScript on Node for server and UI: Yjs + Hocuspocus for collaboration,
CodeMirror 6 as the editor, React + React Aria for the UI, SQLite
(`better-sqlite3`, FTS5) for the index.

## License

[AGPL-3.0](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md).
