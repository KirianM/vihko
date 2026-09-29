# What 1.x keeps stable

[Upgrading](upgrading.md) says what a version number promises: within 1.x,
updates only add or fix things in the HTTP API, the MCP tools, `vihko.yaml`,
what vihko writes into your notes and the Docker interface. This page lists
that surface item by item, as vihko 1.0 has it, so you know exactly what a
script, an agent or another tool can rely on.

## How to read this page

- **Everything listed here keeps working** in every 1.x release: the same
  names, the same types, the same meaning.
- **Things are added** in minor releases: routes, response fields, tools,
  optional parameters, `vihko.yaml` keys, error codes, environment variables.
  Write clients that ignore fields and codes they don't know. An error code
  you don't know is still an error: go by its HTTP status.
- **Limits can change** within 1.x, down as well as up: body sizes, page
  sizes, images at once. A lower limit is announced in the changelog's
  *Upgrade notes*. What a request over a limit gets (its status and error
  code) stays.
- **A default doesn't change** in a way that opens anything up. Features that
  are off by default stay off by default.
- **Wording isn't covered.** The `message` of an error, log lines and text
  meant for people can change in any release. Check codes, never messages.

When something here has to change, the old form keeps working until 2.0. It's
announced in the changelog's *Upgrade notes*, and the API and the MCP server
say so themselves when a client uses it. It goes away only in a major version.

## The HTTP API

The [API guide](api.md) explains how to use it. This is the list of what
stays.

### Conventions

| What | Stays as |
|---|---|
| Base path | `/api`, no version prefix |
| Authentication | `Authorization: Bearer <key>`; a request with a key is judged by the key alone |
| Key format | `vihko_`, a 26-character id, `_`, a 43-character secret |
| The API switch off | Every request with a key answers `404 not_found` |
| A route not open to keys | `404 not_found` |
| A read-only key on a route that writes | `403 forbidden` |
| Bodies | JSON, except image uploads (raw bytes) and file downloads |
| Note paths | From the notes root, with `.md`: `projects/plan.md` |
| Dates | ISO 8601, UTC |
| A note's ETag | `sha256:<hex>` of its text, in the body and in the `ETag` header (quoted) |
| Conditional writes | `If-Match` (quoted or bare), `ifMatch` in the body where a route takes it, `If-None-Match: *` on `PUT /api/note` |
| Errors | `{ "error": <code>, "message": <hint> }`, with `etag` on `precondition_failed`, `reason` on `agent_denied`, `audience` on `audience_widens`, `retryAfter` on `too_many_attempts`; `Retry-After` on `429` |
| Hidden notes | `404 not_found` for a note the key can't see; `403 agent_denied` with `reason` (`ai_false`, `outside_key_folders`, `user_no_access`) when it names one that exists but is hidden from agents |
| A write that hides the note from the key | Succeeds, and adds `nowHidden: true`, `reason` and `message` |

### Routes open to keys

"Key" says which keys may call the route: any key (read) or a key that may
write (write).

| Method and path | Key | Request | Response |
|---|---|---|---|
| `GET /api/tree` | read | — | `notes` (`path`, `title`, `uid`, `aliases`), `folders`, `pathOnly` |
| `GET /api/note` | read | `path` | `path`, `text`, `etag`, `meta` (`title`, `uid`, `fm_error`, or null), `hiddenFromAgents` |
| `GET /api/note/links` | read | `path` | `outgoing` (`raw`, `kind`, `target`, `anchor`, `status`, `dst_path`, `anchor_ok`, `candidates`, `pos_from`, and `others_no_access`, `reason`, `self` when they apply), `backlinks` (`path`, `title`, `raw`, `context`), `titles` |
| `GET /api/note/headings` | read | `path` | `headings` (`level`, `text`) |
| `GET /api/note/comments` | read | `path` | `threads` (`id`, `original`, `changed`) |
| `GET /api/search` | read | `q` | `results` (`path`, `title`, `snippet`), `highlight` (`start`, `end`) |
| `GET /api/tags` | read | — | `tags` (`tag`, `count`, `total`) |
| `GET /api/daily` | read | `series`? | `series`, `path`, `exists` |
| `GET /api/file` | read | `path` | The file's bytes, with its `Content-Type` and an opaque `ETag` |
| `POST /api/note` | write | `path`, and `text` or `template` | `201`: `path`, `uid`, `etag` |
| `PUT /api/note` | write | `path` (query), `text`, `If-Match` or `If-None-Match: *` | `200` or `201`: `etag` |
| `POST /api/note/edit` | write | `path`, `ops`, `ifMatch`?, `dryRun`? | `etag`; with `dryRun`: `dryRun`, `etag`, `changes` (`at`, `removed`, `inserted`) |
| `POST /api/note/move` | write | `from`, `to`, `dryRun`?, `confirmAudience`?, `If-Match`? | `from`, `to`, `dryRun`, `etag`, `relinked`, `shifted`, `kept`, `failed`, `aliasAdded`, `images`, `hidden`, and `audience` in a dry run |
| `DELETE /api/note` | write | `path` (query), `If-Match`? | The trash entry: `id`, `path`, `deletedAt`, `actor`, `etag`, and `files` when images went with it |
| `POST /api/daily` | write | `series`? | `200` or `201`: `series`, `path`, `created` |
| `POST /api/attachments` | write | `note` (query), the image's bytes as the body | `201`: `path`, `src`, `markdown` |
| `GET /api/history/status` | read | — | `mode`, `available`, `error` (`code`, `message`, or null) |
| `GET /api/history/versions` | read | `path`, `limit`?, `cursor`? | `versions` (`id`, `at`, `authors`, `reason`, `foundAtStartup`, `path`, `change`, `from`, `added`, `removed`), `next`, `pending` (`authors`, `since`, or null), `excluded` |
| `GET /api/history/version` | read | `path`, `id` | `path`, `id`, `at`, `text` |
| `GET /api/history/diff` | read | `path`, `id`, `against`? (`previous`, `current` or a version id) | `ops` (pairs of `-1`, `0` or `1` and a piece of text), `added`, `removed` |
| `GET /api/history/changes` | read | `limit`?, `cursor`?, `author`? | `changes` (`id`, `at`, `authors`, `reason`, `foundAtStartup`, `files`), `next`, `authors` |
| `GET /api/history/resolved` | read | `path` | `threads` (`id`, `comments`, `anchor`, `place`, `resolvedAt`, `resolvedBy`, `version`, `reopenable`), `complete` |
| `POST /api/history/restore` | write | `path`, `id`, `ifMatch`? | `etag`, `images` (`restored`, `missing`) |
| `POST /api/history/revert` | write | `path`, `id`, `ifMatch`?, `dryRun`? | `dryRun`, `changed`, `etag`, `counts`, `reverted`, `skipped` |

In the history, an author has `kind` (`user`, `agent`, `system`, `git` or
`external`), `name` and `key` (the value for the `author` filter), and, as
they apply, `id`, `onBehalfOf` (`id`, `name`) and `via` (`api`, `mcp` or
`oauth`). A reason is a `code` with its data.

The operations of `POST /api/note/edit` stay as they are: `append` (`text`),
`append_under_heading` (`heading`, `text`), `find_replace` (`find`,
`replace`, `expectedCount`), `replace_section` (`heading`, `text`) and
`set_frontmatter` (`key`, `value`). The last three need the ETag.

### Routes without a key

| Method and path | Request | Response |
|---|---|---|
| `GET /api/health` | — | `{ "ok": true }` |
| `GET /api/setup` | — | `needed` |
| `POST /api/setup` | `token`, `username`, `password` | `user` (`id`, `username`, `role`, `disabled`) |

Send them without `Authorization`.

### Error codes

The codes in the [API guide](api.md#errors) stay, with their status:
`unauthorized` (401), `forbidden` (403), `agent_denied` (403), `not_found`
(404), `invalid` (400, or 413 for a body over the limit), `invalid_path`
(400), `control_characters` (400), `exists` (409), `edit_mismatch` (409),
`not_configured` (409), `audience_widens` (409), `not_revertible` (409),
`history_off` (409), `too_large` (413), `unsupported_type` (415), `busy`
(429), `precondition_required` (428), `precondition_failed` (412),
`history_unavailable` (503) and `internal` (500). Creating the first admin adds
`invalid_token`, `invalid_username` and `weak_password` (400),
`already_setup` (409) and `too_many_attempts` (429).

### Limits

| What | 1.0 |
|---|---|
| Request body | 20 MiB |
| Image upload | `VIHKO_MAX_IMAGE_MB`, 20 MB by default |
| Images received at once | 2 per person, 8 in all |
| Search results | 50 with words, 500 with filters alone |
| History pages for a key | 50 |

## The MCP server

The [Agents guide](agents.md) explains how to connect. This is the list of
what stays.

### The endpoint

| What | Stays as |
|---|---|
| Address | `/mcp`, on the same address and port as the UI |
| Transport | Streamable HTTP, without sessions: `POST` only; `GET` and `DELETE` answer `405` |
| Credential | `Authorization: Bearer` with a key, or an OAuth access token (see [OAuth](#oauth)) |
| The MCP switch off | `404`, whatever the request |
| No credential, or a wrong one | `401`, with a `WWW-Authenticate: Bearer` challenge (naming the resource metadata while OAuth exists) |
| A request from a page on another site | `403` |
| Request size | Up to 4 MB |

### Conventions

- Parameters are `snake_case`. `camelCase` is accepted too, and so are these
  other names: `note`, `file` and `note_path` for `path`; `etag` for
  `if_match`; `q` for `query`; `source` and `destination` for `from` and `to`;
  `id` for `version`.
- A result's first block is its data as JSON, between `<data-…>` markers. A
  note's text comes in a block of its own, between `<note-…>` markers. Both
  markers carry a random tag.
- An error is a result with `isError`, whose text is JSON: `error` (a code),
  `message`, and as they apply `etag`, `hint`, `reason` and `audience`. The
  codes are those of the HTTP API.
- Lists are paged: pass `next_offset` back as `offset`, or `next` as
  `cursor`.
- A write that hides the note from the agent succeeds and adds `now_hidden:
  true`, `reason` and `message`.
- A read-only key gets only the reading tools; a writing tool is unknown to
  it.

### Reading tools

Every key has these.

| Tool | Parameters | Result |
|---|---|---|
| `search` | `query` (text, required), `limit` (1 to 50, 20), `offset` (0) | `results` (`path`, `title`, `snippet` with hits between `**`), `next_offset` |
| `get_note` | `path` or `uid` (one of them), `offset` (0), `max_chars` (1,000 to 200,000; 100,000) | `path`, `etag`, `title`, `uid`, `frontmatter`, `links` (`outgoing`: `link`, `target`, `anchor`, `status`, `path`, `candidates`, and `others_no_access`, `reason` when they apply; `incoming`: `path`, `title`, `count`; `more`), `text` (`offset`, `length`, `total`, `next_offset`); the text as a block |
| `list_folder` | `folder` (`""` for the root, the default), `recursive` (false), `limit` (1 to 500, 100), `offset` (0) | `folder`, `entries` (`kind` `folder` with `path`, or `note` with `path` and `title`), `next_offset` |
| `related` | `path` (required), `limit` (1 to 200, 50), `offset` (0) | `path`, `links_to` (`link`, `target`, `anchor`, `status`, `path`, `title`, `candidates` with `path` and `title`, and `others_no_access`, `reason` when they apply), `linked_from` (`path`, `title`, `count`, `link`, `context`), `next_offset` |
| `resolve_link` | `from` (required), `link` (required) | `from`, `link`, `target`, `anchor`, `status`, `path`, `title`, `anchor_found`, `candidates`, and `others_no_access`, `reason` when they apply |
| `changes_since` | `path` (required), `since` (an ETag or a version id, required), `wait_seconds` (0 to 30, 0), `include_text` (false) | `path`, `etag`, `changed`; when changed, `words` (`added`, `removed`), `changes` (`line`, `removed`, `added`, `before`, `after`) and `truncated`, or `base_known: false` with the whole text as a block |
| `history` | `path` (required), `version`, `include_text` (false), `cursor`, `limit` (1 to 20, 10) | `path`, `versions` (`version`, `at`, `authors`, `change`, `from`, `path`, `reason`, `words`), `next`; with `version`: `path`, `version`, `at`, `change`, `words`, `changes`, `truncated` |
| `daily_note` | `series` | `series`, `path`, `exists`, and `etag` with the text as a block when it exists |

`status` is `resolved`, `ambiguous`, `missing` or `no_access`. An author in
`history` has `kind` and, as they apply, `name`, `on_behalf_of` and `via`.

### Writing tools

Only keys that may write have these.

| Tool | Parameters | Result |
|---|---|---|
| `daily_note` | `series`, `create` (true) | `series`, `path`, `created`, `etag`, and the text as a block; with `create: false`, as for a read-only key |
| `create_note` | `path` (required), `text` or `template` | `path`, `etag`, `uid`, `created` |
| `edit_note` | `path` (required), `operations` (1 to 50, required), `if_match`, `dry_run` (false) | `path`, `etag`; with `dry_run`: `dry_run`, `etag`, `changes` (`at`, `removed`, `inserted`) |
| `move` | `from`, `to` (required), `if_match`, `dry_run` (false), `confirm_audience` (false) | `from`, `to`, `dry_run`, `etag`, `relinked`, `shifted`, `kept`, `failed`, `alias_added`, `hidden`, `images`, and `audience` when it applies |
| `delete` | `path` (required), `if_match` | `path`, `trashed`, `at`, and `images` when some went with it |
| `attach_image` | `note` (required), `data` (base64, required), `mime_type`, `alt` | `path`, `src`, `markdown` |
| `revert_change` | `path`, `version` (required), `if_match`, `dry_run` (false) | `dry_run`, `changed`, `etag`, `counts`, `reverted`, `skipped` |

The operations of `edit_note` are those of the HTTP API, with
`expected_count` for `expectedCount`: `op`, and `find`, `replace`,
`expected_count`, `text`, `heading`, `key` and `value` as each one needs.

## `vihko.yaml`

Every key vihko reads. [Configuration](configuration.md) explains each one.

| Key | Type | What it does |
|---|---|---|
| `version` | whole number from 1 | The file's format (1 when left out) |
| `templates` | folder | Where the templates are |
| `daily` | map of series by id | Daily, weekly, monthly or yearly notes |
| `daily.<id>.label` | text | The series' name in the UI |
| `daily.<id>.folder` | folder pattern | Where its notes go |
| `daily.<id>.name` | name pattern | Each note's file name, without `.md` |
| `daily.<id>.template` | note | The note its notes start from |
| `attachments.mode` | `next-to-note`, `folder` or `per-note` | Where new images go |
| `attachments.folder` | folder | The folder for `mode: folder` |
| `attachments.suffix` | text | The folder suffix for `mode: per-note` |
| `links.aliases` | `true` or `false` | Whether frontmatter aliases resolve `[[links]]` |
| `history.mode` | `managed`, `unmanaged` or `off` | How the history is kept |
| `history.maxFileSize` | number of MB | The largest file that enters the history |
| `history.exclude` | pattern, or list of patterns | Paths kept out of the history |
| `mcp.instructions` | note | A note served to agents as instructions |
| `permissions.<folder>.grants` | map of subject to level | Who gets what in that folder |
| `permissions.<folder>.ai` | `false` | Closes the folder to agents |

What stays with them:

- **Patterns** in `daily`: `{YYYY}`, `{MM}`, `{DD}`, `{GGGG}`, `{WW}` and
  `{user}`.
- **Template variables**: `{{title}}`, `{{user}}`, `{{date}}` and
  `{{date:FORMAT}}`, with the tokens `YYYY`, `YY`, `MM`, `M`, `DD`, `D`,
  `GGGG`, `WW`, `W`, `HH`, `mm` and text in `[brackets]`.
- **Permissions**: folder keys (`""` for the root, one `{user}` segment at
  most), subjects (a username, `@group`, `{user}`) and the levels `read`,
  `comment`, `edit` and `manage`.
- **How the file is read**: a key vihko doesn't know is ignored with a
  warning; a wrong value in a known key keeps the last valid file; the
  `permissions` section is strict and fails closed.
- **How vihko writes it**: only the `permissions` entries that change, and a
  format rewrite at start after an upgrade. Comments, key order and keys it
  doesn't know stay.

## Environment variables

| Variable | Values |
|---|---|
| `VIHKO_PUBLIC_URL` | An `https://` origin |
| `VIHKO_TRUSTED_PROXIES` | Addresses or CIDR ranges, separated by commas or spaces |
| `VIHKO_INTEGRATIONS` | `off`, or unset |
| `VIHKO_EXTERNAL_IMAGES` | `allow` (default) or `block` |
| `VIHKO_MAX_IMAGE_MB` | A number of megabytes, 20 by default |
| `VIHKO_SECRET_KEY` | A key of 32 characters or more |
| `VIHKO_SECRET_KEY_FILE` | A file holding that key |
| `VIHKO_RESCAN_SECONDS` | Seconds, 60 by default |
| `VIHKO_NOTES_DIR` | A folder, `/data/notes` by default |
| `VIHKO_STATE_DIR` | A folder, `/data/state` by default |
| `VIHKO_HOST` | An address, `0.0.0.0` by default |
| `VIHKO_PORT` | A port, 8080 by default |
| `VIHKO_WEB_DIR` | A folder, for running from source |
| `VIHKO_HISTORY_QUIET_SECONDS` | Seconds, 30 by default |
| `VIHKO_HISTORY_MAX_SECONDS` | Seconds, 300 by default |
| `VIHKO_HISTORY_SWEEP_SECONDS` | Seconds, 3600 by default |
| `VIHKO_GIT` | The git program, `git` by default |

The example `compose.yaml` keeps reading `VIHKO_UID`, `VIHKO_GID` and
`VIHKO_HOST_PORT`. [Installation](install.md#environment-variables) says what
each variable does. Other `VIHKO_*` variables in the source code are for tests
and aren't covered.

## The Docker image

| What | Stays as |
|---|---|
| Image | `ghcr.io/kirianm/vihko` |
| Tags | `1.2.3` (never changes), `1.2`, `1` and `latest` (move forward only), and release candidates under their exact tag only |
| Platforms | `linux/amd64` and `linux/arm64` |
| Volumes | `/data/notes` (the notes) and `/data/state` (vihko's state) |
| Port | 8080, plain HTTP |
| User | Any `uid:gid` in `user:` that can write both volumes; it needn't be root |
| Hardening | Runs with a read-only root filesystem, no capabilities (`cap_drop: [ALL]`) and `no-new-privileges` |
| Health check | `GET /api/health` answers `200` while the process serves |
| Required settings | None: no variable is required to start |

## What vihko writes into your notes

[Notes and Markdown](notes.md) explains each of these. vihko writes nothing
else into a note unless someone asks it to (an edit, a comment, a
`set_frontmatter`).

| What | Form |
|---|---|
| The note's identity | `uid: <ULID>` in the frontmatter (26 characters), added only when vihko writes the note anyway: created, edited or moved from vihko |
| An alias after a rename | The old name added to `aliases`, only when a link to the note couldn't be rewritten and `links.aliases` is on |
| Frontmatter changes | Only that key's value, in place; a new key is added at the end of the block; a note without frontmatter gets a block at the top. The rest of the block stays byte for byte |
| Comments | `<!-- @author YYYY-MM-DDTHH:MMZ · text -->`; a reply starts its text with `↳ `; comments one after another are a thread; resolving a thread deletes it |
| Links rewritten after a move | A wikilink gets the shortest target that reaches the note (its name, then longer path endings, then `/` and the whole path, without `.md`), keeping its `#heading` and `\|text`. A Markdown link gets the path relative to the note (spaces as `%20`), with its `#anchor` |
| Image links | `![alt](path)`, relative to the note, with spaces, brackets, parentheses, `%`, `#`, `?`, `<`, `>` and `\` percent-encoded |
| Where new images go | As `attachments` says: next to the note (`plan-2026-09-28-1012.png`), in one folder (same name), or in the note's own folder (`plan.assets/2026-09-28-1012.png`); the time in UTC, a taken name gets `-2`, `-3`… |
| Moved images | Images only one note uses go with it when it changes folder, and every link to them is rewritten |

What vihko reads in your notes stays too: the frontmatter keys `uid`,
`title`, `tags`, `aliases` and `ai` (`ai: false` hides a note from agents),
`#tags`, both kinds of links, and the files it ignores (names starting with
`.` or ending in `~`, and symbolic links).

## OAuth

OAuth exists while `VIHKO_PUBLIC_URL` is set and the MCP server is on;
otherwise every address below answers `404`.

| Address | What it is |
|---|---|
| `GET /.well-known/oauth-protected-resource/mcp` (and without `/mcp`) | Resource metadata (RFC 9728): `resource` (`<public URL>/mcp`), `authorization_servers`, `bearer_methods_supported`, `resource_name` |
| `GET /.well-known/oauth-authorization-server` | Server metadata (RFC 8414) |
| `POST /oauth/register` | Dynamic client registration (RFC 7591), only while the admin allows it |
| `GET /oauth/authorize` | Where the person approves the app |
| `POST /oauth/token` | Codes and refresh tokens |
| `POST /oauth/revoke` | Token revocation (RFC 7009) |

What the server metadata promises, and stays: the authorization code flow
with PKCE (`S256` only) and refresh tokens, the `query` response mode, the
`iss` parameter in the response, client authentication `none`,
`client_secret_post` or `client_secret_basic`, and clients that identify
themselves with a metadata document URL. `registration_endpoint` is listed
only while registration is on. Tokens are opaque: read `expires_in` rather
than counting on a lifetime.

## What isn't covered

These can change in any release, and are never a reason for a major version:

- **The web UI**: its screens, its keyboard shortcuts, and its URLs, other
  than those the guides tell you to use (`/mcp`, the invitation links).
  `?view=` parameters are the UI's own.
- **Routes a key can't call.** They're the UI's: folders, the trash,
  comments, alerts, users, groups, keys, settings, sessions. Only
  `/api/health` and `/api/setup` are covered among them.
- **The databases**: the tables of `state.db` and `index.db`. vihko migrates
  `state.db` on its own; `index.db` is rebuilt from the notes.
- **The files in the state volume**, their names and their layout: the
  history repository, the trash, the editor's recovery files, the lock. The
  guides of each version say what to back up and how to roll back.
- **Log lines** and every text meant for people: error `message`s, the MCP
  server's instructions, tool descriptions.
- **Timings**: how long a version waits to be saved, how often vihko rescans,
  how long a token or a session lasts.
- **Short-lived files** vihko writes next to a note to make a write atomic
  (hidden names such as `.plan.md.vihko-…`).
