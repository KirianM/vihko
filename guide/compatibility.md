# What 0.x tries to keep

vihko is at 0.x: the relaunch of the project around spaces, before a stable
1.0. **Nothing on this page is frozen yet.** This page lists, item by item,
the surface that scripts, agents and other tools can build on, as vihko 0.1.0
has it, taken from the code: the HTTP API, the MCP tools, `vihko.yaml`, the
environment variables, the Docker image, the command line, and what vihko
writes into your notes folder.

## How 0.x versions work

- **A minor version (0.1 → 0.2) may change anything listed here**, including
  in ways that break a script or an agent. Each such change is in the
  changelog's *Upgrade notes* for that version, with what to do instead. Read
  them before you move to a new minor version.
- **A patch version (0.1.0 → 0.1.1) only fixes things.** It doesn't change
  this surface, except for a security fix (below).
- **What we try to keep**, even across minor versions: your notes stay plain
  Markdown files that any editor opens; note paths keep their form
  (`people/<user>/…` and `spaces/<folder>/…`); the names of routes, tools,
  fields and error codes; and the meaning of a field once it exists. When one
  has to change, we say so, and we prefer adding a new name to renaming an
  old one. In particular:
  - `people/` and `spaces/` are fixed. A shared space's folder is its name:
    renaming the space renames its folder.
  - A username is permanent once its person has signed in: it is the name of
    the person's folder and part of every link into it. Only someone who
    hasn't used their invitation yet can be renamed (see [Routes for the web
    UI](#routes-for-the-web-ui)).
  - Folders whose name starts with a dot are vihko's or other tools': vihko
    never indexes or serves them, nor keeps their history. `.vihko/` at the
    root of any space is reserved for vihko's settings.
  - The subjects of a grant may grow. `@everyone`, `@all`, `@public` and
    `@anyone` are reserved: no group can take those names.
  - The keys inside a `permissions` rule may grow. An older vihko that
    doesn't know a key rejects the whole section, and nothing is shared
    until you upgrade again.
- **Security comes first.** If keeping something as it is would leave
  installations open to an attack, any release can change it or turn it off.
  The changelog says so under *Security*.
- **A default never changes in a way that opens anything up.** Features that
  are off by default stay off by default. A default can change to close
  something, announced in the *Upgrade notes*.

When the model has settled through real use, a 1.0 release will freeze this
page, and from then on only a new major version will break it.

### Reading the surface

- **Things are added** in any minor version: routes, response fields, tools,
  optional parameters, `vihko.yaml` keys, error codes, alert codes,
  environment variables. Write clients that ignore fields and codes they
  don't know. An error code you don't know is still an error: go by its HTTP
  status.
- **Values are added too.** A field that answers with one of a set of values
  (an author's `kind`, a version's `change`, a link's `status`, a `reason`, a
  space's `kind`) can answer with a new one. Treat a value you don't know like
  an unknown field.
- **Limits can change**, down as well as up, and new ones can appear, rate
  limits among them. A lower or a new limit is announced in the *Upgrade
  notes*. A request over a limit keeps its status and error code (`429` with
  `Retry-After` for a rate limit).
- **Wording isn't covered.** The `message` of an error, log lines and text
  meant for people can change in any release. Check codes, never messages.

## Paths and spaces

Every note, image and folder vihko shows has one path, the same for everyone:
from the root of the notes folder, with `/` between folders and `.md` on a
note. Every path vihko serves is inside a space:

| Path | What it is |
|---|---|
| `people/<username>/…` | A person's own space («My notes» in the UI). `<username>` is the person's username; it changes only while they haven't used their invitation |
| `spaces/<name>/…` | A shared space, such as `spaces/Home/`. The folder is the space's name as it was written (in NFC), and renaming the space renames it |
| `people/<username>/.vihko/`, `spaces/<name>/.vihko/` | The settings of that person or space (`settings.yaml`: see [Settings of a person or a space](#settings-of-a-person-or-a-space)), never notes. Hidden, like every name that starts with a dot, and refused as a note or folder in any case (`invalid_path`). A person's doesn't come along when their space becomes a shared one: it goes to the trash |
| `vihko.yaml` | The workspace configuration, at the root. Nobody sees it in vihko. It may be a symbolic link: vihko reads it through the link, and writes through it, atomically, to the file it points to |
| Anything else | In no space: nobody sees it in vihko, and the admins get the `outside_spaces` alert (but for names that start with a dot, which are other tools') |

- `people` and `spaces` are fixed names. No note can be created at the root
  of the notes folder, or directly in `people/` or `spaces/`, and no folder
  at the root of the notes folder or anywhere outside a space: a request that
  tries gets `400 outside_space`. A folder directly in `people/` or
  `spaces/` would be a space's root, which is never created, renamed, moved
  or deleted as a folder: `400 space_root` (a shared space is created and
  deleted as a space; see below).
- Any folder in `spaces/` is a shared space, but one whose name starts with
  `.` or `~`, ends with `.`, `~` or `.md`, holds `\` or a control character,
  or is `people` or `spaces` in any case: those are in no space. One made on
  the disk has no members until the admin assigns a manager.
- A folder in `people/` named after no user (active, disabled or deleted) is
  seen by nobody, and the admins get `person_folder_without_user`.
- **A shared space's name is unique in the installation**, without regard to
  case, and it is not secret: everyone who can sign in can learn that a name
  is taken (creating a space with it answers `space_name_taken`), and the
  admin's directory lists every shared space by name. What a space holds and
  who is in it stay private. A name given in vihko (creating or renaming a
  space) has at most 64 characters, no spaces around it and no control
  characters, and can't hold `/`, `\` or any of `<>:"|?*`, start with `.` or
  `~`, end with `.`, `~` or `.md`, or be `people`, `spaces` or a device name
  of Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, `LPT1` to `LPT9`,
  in any case, alone or with an extension). A folder made on the disk is a
  space by the rule above, whatever its length or those characters.
- **vihko is served at the root of its domain** (`https://notes.example.com/`),
  never under a path, and its addresses count on it: a note's address, and
  the links to one by its address, start at the domain's root (`/?note=…`).
- The UI never shows `people/` nor `spaces/`. A note's address in the
  browser is `?note=<address>`, the same for everyone who can open it: a
  shared space by its name (`?note=Home/plan.md`), a person's space by `~`
  and the username (`?note=~ana/trips/Rome.md`). An address with the path
  from the notes root (`?note=spaces/Home/plan.md`) still opens the note and
  is replaced by that form. Other query parameters (`view`, `version`) may be added; addresses of
  another form may be added too.
- A link never leads to another space (see [What vihko writes into your
  notes folder](#what-vihko-writes-into-your-notes-folder)).

## The HTTP API

The [API guide](api.md) explains how to use it.

### Conventions

| What | In 0.1.0 |
|---|---|
| Base path | `/api`, no version prefix |
| Authentication | `Authorization: Bearer <key>`; a request with a key is judged by the key alone |
| `Origin` | Not checked on a request with a key: a key is no credential a browser sends on its own. Without a key (the UI's session), a write from another origin is `403 forbidden` |
| CORS | None: vihko sends no CORS headers and approves no preflight request, so a page on another site can't call the API from a browser |
| Key format | Starts with `vihko_`; the rest is opaque (in 0.1.0, a 26-character id, `_` and a 43-character secret) |
| The API switch off | Every request with a key answers `404 not_found` |
| A route not open to keys | `404 not_found` |
| A read-only key on a route that writes | `403 forbidden` |
| Bodies | JSON, except image uploads (raw bytes) and file downloads |
| Field names | `camelCase`, in requests and answers |
| Note paths | From the notes root, with `.md`, inside a space: `spaces/Home/plan.md` |
| Dates | ISO 8601, UTC |
| A note's ETag | `sha256:<hex>` of its text, in the body and in the `ETag` header (quoted); a dry run gives it in the body only |
| Cursors | `next`, passed back as `cursor`: opaque (encrypted), valid until vihko restarts |
| Version ids | Opaque text (in 0.1.0, 40 hex digits). They change when the history is rewritten: a purge, or a retention run that removed something, gives new ids to every later version of the installation, with no table from old to new. A version id kept from before (a `version` or `against`, the `since` of `changes_since`) then answers `404 not_found`, or `base_known: false` for `since`: read the versions again |
| Conditional writes | `If-Match` (quoted or bare), `ifMatch` in the body where a route takes it, `If-None-Match: *` on `PUT /api/note` |
| An ETag a note open in the editor had a moment ago | A write planned on it (`PUT /api/note`, `POST /api/note/edit`, `POST /api/history/restore`) goes in, applied to the text as it is now, when nothing changed since in what it replaces or right next to it (a whole text counts from the first character it changes to the last); otherwise `412 precondition_failed`. "A moment ago": the texts vihko handed out with their ETag in the last 10 minutes, the last 32 of each open note and about 4 MiB of text at most, and the texts it wrote to the note's file lately |
| Errors | `{ "error": <code>, "message": <hint> }`, with `etag` on `precondition_failed` (and `etag: null` on other errors about a note), `reason` on `agent_denied`, `audience` on `audience_widens`, `path` on an `exists` that names the disk's spelling, `movedTo` on a `not_found` for a note vihko moved from there in the last two minutes (only to whoever reads it where it went), `contents` on `not_empty`, `group` on `leave_via_group`, `retryAfter` on `too_many_attempts`; `Retry-After` on `429` |
| What the key's person can't read | `404 not_found`, the same whether it exists or not |
| What the person reads but is hidden from agents | `403 agent_denied` with `reason`: `ai_false` (the note or a folder above it is closed to agents) or `outside_key_folders` |
| A write that hides the note from the key | Succeeds, and adds `nowHidden: true`, `reason` and `message` (a restore from the history too) |
| A note's history | Its versions, diffs, resolved threads, restoring and reverting need `edit` where the note is now, for the key's person: where they only read or comment, `403 forbidden`. «Recent changes» (`GET /api/history/changes`) lists only notes where they edit |

### Routes open to keys

"Key" says which keys may call the route: any key (read) or a key that may
write (write).

| Method and path | Key | Request | Response |
|---|---|---|---|
| `GET /api/tree` | read | — | `notes` (`path`, `title`, `uid`, `aliases`, and `template: true` for a template), `folders`, `pathOnly` |
| `GET /api/spaces` | read | — | `personal` (`path`, or null when the key doesn't reach it), `spaces` (`path`, `name`, `level`, `managers`, `aiClosed`), `shared` (`path`, `level`, `pinned`, and `owner` in a personal space or `space` with `path`, `name`), `canCreate` (always false for a key). A shared space's `name` is its folder's. `level` is the person's, whatever the key may do. `managers` leaves out people the admin disabled. A space the key reaches only part of (a folder in it) is listed |
| `GET /api/spaces/members` | read | `path` (a folder) | `path`, `space` (`path`, `name`, or null in a personal space), `owner` (or null in a shared space), `members` (`username`, `level`, `via`: `subject`, `level`, `from` (null where the asker doesn't read that folder), and `owner: true` for a person's own space) |
| `GET /api/note` | read | `path` | `path`, `text`, `etag`, `meta` (`title`, `uid`, `fmError`, or null), `hiddenFromAgents`; `tooLarge: true` for a note over `notes.maxSize` (its `meta` has nothing of its text) |
| `GET /api/note/links` | read | `path` | `outgoing` (`raw`, `kind`, `target`, `anchor`, `status`, `dstPath`, `anchorOk`, `candidates`, `posFrom`, and `othersNoAccess`, `reason`, `self` when they apply; `file` when a wikilink with no note of its name leads to a file of the space, `[[invoice.pdf]]`: `dstPath` is the file), `backlinks` (`path`, `title`, `raw`, `context`), `titles` |
| `GET /api/note/headings` | read | `path` | `headings` (`level`, `text`) |
| `GET /api/note/comments` | read | `path` | `threads` (`id`, `original`, `changed`) |
| `GET /api/search` | read | `q` | `results` (`path`, `title`, `snippet`), `highlight` (`start`, `end`). The query's filters are under [Search filters](#search-filters) |
| `GET /api/tags` | read | — | `tags` (`tag`, `count`, `total`) |
| `GET /api/daily` | read | `series`? | `series`, `path`, `exists` |
| `GET /api/file` | read | `path`, or `note` and `name` | The file's bytes, with its `Content-Type` and an opaque `ETag`. With `note` and `name`, the file as that note names it (`![[photo.png]]`): relative to the note, or by name among the files of its space, the nearest winning, a tie or another space `404`. `Content-Disposition: inline` for images (not SVG) and PDFs, `attachment` for anything else |
| `POST /api/note` | write | `path`, and `text` or `template` (any note the key reads; its frontmatter is copied without `template: true` and `aliases`, and with a new `uid`) | `201`: `path`, `uid`, `etag` |
| `PUT /api/note` | write | `path` (query), `text`, `If-Match` or `If-None-Match: *` | `200` or `201`: `etag` |
| `POST /api/note/edit` | write | `path`, `ops`, `ifMatch`?, `dryRun`? | `etag`; with `dryRun`: `dryRun`, `etag`, `changes` (`at`, `removed`, `inserted`) |
| `POST /api/note/move` | write | `from`, `to`, `dryRun`?, `confirmAudience`?, `If-Match`? | `from`, `to`, `dryRun`, `etag`, `relinked`, `shifted`, `kept`, `failed`, `aliasAdded`, `images` (`moved`, `copied`, `stayed`, `folder`, `failed`), `hidden`, `brokenLinks` (`path`, `to`) when it changes space, and `audience` in a dry run; each `relinked` change has `before`, `after`, `kind` (`link` or `image`) and `to` |
| `DELETE /api/note` | write | `path` (query), `If-Match`? | The trash entry: `id`, `path`, `deletedAt`, `actor`, `etag`, and `files` when images went with it |
| `POST /api/daily` | write | `series`? | `200` or `201`: `series`, `path`, `created` |
| `POST /api/attachments` | write | `note` (query), the image's bytes as the body | `201`: `path`, `src`, `markdown` |
| `GET /api/history/status` | read | — | `mode`, `available`, `error` (`code`, `message`, or null) |
| `GET /api/history/versions` | read | `path`, `limit`?, `cursor`? | `versions` (`id`, `at`, `authors`, `reason`, `foundAtStartup`, `path`, `change`, `from`, `added`, `removed`), `next`, `pending` (`authors`, `since`, or null), `excluded` |
| `GET /api/history/version` | read | `path`, `id` | `path`, `id`, `at`, `text` |
| `GET /api/history/diff` | read | `path`, `id`, `against`? (`previous`, `current` or a version id) | `ops` (pairs of `-1`, `0` or `1` and a piece of text), `added`, `removed` |
| `GET /api/history/changes` | read | `limit`?, `cursor`?, `author`? | `changes` (`id`, `at`, `authors`, `reason`, `foundAtStartup`, `files`), `next`, `authors` |
| `GET /api/history/resolved` | read | `path` | `threads` (`id`, `comments`, `anchor`, `place`, `resolvedAt`, `resolvedBy`, `version`, `reopenable`), `complete` |
| `POST /api/history/restore` | write | `path`, `id`, `ifMatch`?, `to`? | `etag`, `images` (`restored`, `missing`); with `to`, also `path`; and `nowHidden`, `reason`, `message` when the restored note is hidden from the key. When the version has a `uid` and the note at the path has another one, or none: `409 uid_mismatch`; `to` restores it as a new note there instead (`409 exists` over a note) |
| `POST /api/history/revert` | write | `path`, `id`, `ifMatch`?, `dryRun`? | `dryRun`, `changed`, `etag`, `counts`, `reverted`, `skipped` |

Details that go with them:

- **Links.** A link's `status` is `resolved`, `ambiguous`, `missing` or
  `no_access`. A link to a note the key's person can't read is `missing`,
  exactly as a link to a note that doesn't exist, with nothing of where it
  leads. `no_access` is only for a note the person reads but that is hidden
  from agents, with a `reason` when every note it may lead to is hidden for
  the same one; an ambiguous link keeps the candidates the key sees, with
  `othersNoAccess: true` when there are more.
- **Moving to another space.** The `audience` of a dry run (and of
  `audience_widens`) has `users` (`gain`, `lose`: `id`, `username`), `groups`
  (`gain`, `lose`: names), `keys` (`gain`, `lose`: counts) and `owner`
  (`before`, `after`: `{ kind: "personal", owner }`, `{ kind: "shared", path,
  name }`, or null), which is null when the note stays in its space.
  Nothing is rewritten across spaces (a link never leads to another space):
  `brokenLinks` lists the links the move leaves broken, in the moved note to
  notes of the space it leaves and in notes the key sees there to the moved
  note, each once: `path`, the note holding the link, and `to`, the note it
  led to, both where they are after the move. `images.copied` lists the images the note
  uses that would stay behind in the space it leaves, copied to the new one
  (`from`, `to`).
- **The history**: an author has `kind` (`user`, `agent`, `system`, `git` or
  `external`), `name` and `key` (the value for the `author` filter), and, as
  they apply, `id`, `onBehalfOf` (`id`, `name`) and `via` (`api`, `mcp` or
  `oauth`). A reason is a `code` with its data. A link the system rewrote
  so that it keeps leading to its note when another note took its name
  (created, restored or given an alias by someone who can't read the note
  holding the link) has the reason `links_kept`, with `to` (the note that
  took the name, or null where the reader can't read it) and `by`. A key's
  person (as everyone) sees the versions, and the
  trash entries, only from when they could read where the note is: the
  grant that reaches them, or their joining the group it names. A note's
  versions are those of the note at that path now: a note that had the path
  before with another `uid` keeps its own, which `GET /api/history/version`
  still opens by id.
- **Edits by operation**: `append` (`text`), `append_under_heading`
  (`heading`, `text`), `find_replace` (`find`, `replace`, `expectedCount`),
  `replace_section` (`heading`, `text`) and `set_frontmatter` (`key`,
  `value`). The last three need the ETag. An edit has 1 to 50 of them; one
  that isn't well formed (an unknown `op`, a field missing or of the wrong
  type, `set_frontmatter` on `uid`) is `400 invalid`, and one that doesn't fit
  the text is `409 edit_mismatch`.
- **A note's folder of images** (`attachments.mode: per-note`) moves with
  it. Its grants go along within its space, or into another space where the
  key's person manages; elsewhere only its `ai: false` does.
- **Fields the UI uses on these routes**, not in the [API guide](api.md):
  `freshUid` and `fromLink` on `POST /api/note`, and `background` on
  `POST /api/note/move` (a key's move always answers with its report).
  `fromLink` names the note whose broken link the new note comes from; it is
  refused (`403 forbidden`) when that note is in someone else's personal
  space, whatever the link leads to.

### Routes without a key

| Method and path | Request | Response |
|---|---|---|
| `GET /api/health` | — | `{ "ok": true }` |
| `GET /api/setup` | — | `needed` |
| `POST /api/setup` | `token`, `username`, `password` | `user` (`id`, `username`, `role`, `disabled`) |

They need no key and ignore one: with an `Authorization` header, whatever its
key, they answer as without it, even with the API off. Creating the first
admin also creates their folder, `people/<username>/`.

### Error codes

These are the codes a key can meet, with their status:

| Code | Status | When |
|---|---|---|
| `unauthorized` | 401 | Not a valid key |
| `key_suspended` | 403 | A member's key (or authorised app) while the admin doesn't let members have keys; it works again once they do |
| `forbidden` | 403 | A read-only key on a route that writes, or something the key's person may not do there (a note's history where they don't edit, among others) |
| `agent_denied` | 403 | Hidden from agents; `reason` says why |
| `not_found` | 404 | No such note, folder, version or route, or one the key's person can't read |
| `invalid` | 400 (413 for a body over the limit) | A body or parameter that isn't valid |
| `invalid_path` | 400 | Not a valid note or folder path |
| `control_characters` | 400 | A path with a control character |
| `outside_space` | 400 | Creating or moving a note where no space is: the notes root, `people/`, `spaces/`, or anything in no space |
| `query_too_complex` | 400 | A search over the [limits](#limits) of a query |
| `exists` | 409 | The name is taken, or isn't available there (see [Known limits](#known-limits)) |
| `permissions_invalid` | 409 | Moving a note whose folder of images has rules of its own in `vihko.yaml`, while a mistake in the file keeps vihko from changing it |
| `config_invalid` | 409 | A note created, moved or restored into a folder that doesn't exist yet but kept grants in `vihko.yaml` from before, which vihko clears first, while the file can't be changed as it is |
| `edit_mismatch` | 409 | An edit operation doesn't fit the text |
| `not_configured` | 409 | The daily note, with no series for the person |
| `series_gone` | 409 | The daily note without `series`, when the series the person chose (`dailySeries`) no longer exists for them, or when they never chose one and no series offered to them is in their own space: they choose one |
| `audience_widens` | 409 | A move would show the note to someone who can't see it now |
| `not_revertible` | 409 | Reverting a version that creates or deletes the note |
| `uid_mismatch` | 409 | Restoring, over the note at a path, a version of another note that had that path before (the version has a `uid`, and the note another one or none): restore it with `to` instead |
| `history_off` | 409 | The history is off |
| `too_large` | 413 | An image over the size limit |
| `note_too_large` | 413 | A write that would make a note larger than `notes.maxSize` (5 MB by default). A write that leaves a note over it no larger than it was goes through |
| `unsupported_type` | 415 | Not an image type vihko stores |
| `busy` | 429 | Too many images received at once |
| `precondition_required` | 428 | A write without the `If-Match` it needs |
| `precondition_failed` | 412 | The note changed since that ETag, or `If-None-Match: *` over a name that is taken or not available |
| `history_unavailable` | 503 | The history can't be read right now |
| `internal` | 500 | Something went wrong in vihko; also a write to an open note vihko can't save right now (the admins get the `note_not_saved` alert meanwhile) |

Creating the first admin adds `invalid_token`, `invalid_username` and
`weak_password` (400), `already_setup` and `personal_folder_exists` (409), and
`too_many_attempts` (429).

### Limits

| What | 0.1.0 |
|---|---|
| Request body | 20 MiB; 16 KiB on the routes that carry a password or a one-time code (setting up, signing in, invitations and reset links, a new password, the second factor). Over it, `413 invalid` |
| Image upload | `VIHKO_MAX_IMAGE_MB` mebibytes, 20 MiB by default |
| Images received at once | 2 per person, 8 in all |
| Search results | 50 with words, 500 with filters alone |
| A search query | 1,000 characters, 20 filters and 32 words (`400 query_too_complex` over any of them, by HTTP and MCP alike) |
| Searching frontmatter | A value longer than 1,000 characters isn't searched, and of a list only its first 200 items are |
| History pages for a key | 50 |

### Routes for the web UI

The routes below need a signed-in session and answer `404` to a key. They're
listed because 0.1.0 added or changed them for spaces; like every route a key
can't call (signing in, invitations and the rest of the UI's), they can
change in any release.

«Confirmed at the moment» means the request carries `confirm`: the person's
current second-factor code, or their password when they have no second
factor. Without it: `400 confirmation_required`, with `with` (`code` or
`password`); a wrong one: `403 wrong_password`, `invalid_code` or
`code_used`, and `429 too_many_attempts` after too many. A confirmation
lasts 15 minutes for that browser session, during which `confirm` isn't
asked for (`GET /api/account/2fa`).

| Method and path | Who | Request | Response, and codes of its own |
|---|---|---|---|
| `POST /api/spaces` | Anyone, or only admins with the setting `spacesCreation: admins` (`403 forbidden` otherwise) | `name`, `members`? (`{ "<user>" or "@<group>": level }`) | `201`: `space` (as in `GET /api/spaces`), at `spaces/<name>`. The creator manages it. `409 space_name_taken` with `name` (as the other space writes it) when a space has that name in any case, or a space that had it (deleted or renamed) left trash entries or history under it; `400 invalid` with `problem` for a name that can't be a space's folder (`empty`, `too_long`, `control_characters`, `spaces_around`, `invalid_characters`, `invalid_name`) |
| `POST /api/spaces/from-folder` | `manage` in the folder and `edit` in its parent, and who may create spaces | `path` (a folder inside a space), `name`? (the folder's own by default), `dryRun`? | A dry run: `report` (the folder move's, with `audience`). Otherwise `201`: `space` (as in `GET /api/spaces`), `report`. The folder becomes a shared space of its own, `spaces/<name>`: what it holds goes to the new space's root, with the folder's own grants and its mover managing it. `400 space_root` for a space's root; `409 space_name_taken` (in a dry run too) and `400 invalid` as for `POST /api/spaces` |
| `POST /api/spaces/rename` | `manage` at the space's root | `path`, `name` | `space`, at its new path. Its folder becomes `spaces/<name>` with everything in it, its rules, and the keys, pins, notices and trash entries that named it, and the `dailySeries` of whoever chose one of its series (whose ids change with the name); links don't change. Another case of its own name renames it too. `409 space_name_taken` and `400 invalid` as for `POST /api/spaces` |
| `DELETE /api/spaces` | `manage` at the space's root | `path`, `trash`? (query) | `path`, and `deleted` (what restores it whole). With `trash=true`, what it holds goes to the trash, which its managers keep seeing; otherwise only an empty space goes (`409 not_empty`) |
| `GET /api/spaces/deleted` | Anyone signed in | — | `spaces` (`id`, `path`, `name`, `by`, `deletedAt`, `entries`: how many of its trash entries are left): the deleted spaces the person managed when they were deleted; for the vihko admin, every one |
| `POST /api/spaces/restore` | Who managed it when it was deleted; the vihko admin | `id` | `space` (`path`, `name`), `restored`, `missing` (trash entries no longer there). Its folder and folders, its rules and its trash entries, where they were. `409 space_name_taken` while another space has its name; `404 not_found` for anyone else, as for one that doesn't exist |
| `POST /api/spaces/leave` | A grant of one's own there | `path` | `path`. One's own grants there and below go; nothing is deleted. `409 leave_via_group` with `group` when it comes through a group; `400 invalid` for one's own space, or a grant from a folder above |
| `POST /api/spaces/pin` | What is shared with one | `path`, `pinned` | `path`, `pinned`. `400 invalid` when `pinned` isn't `true` or `false`, or to pin a folder that isn't shared with one |
| `GET /api/admin/spaces` | The vihko admin | — | `spaces` (`path`, `name`, `managers`, `members` (a count), `aiClosed`), `closed` (`userId`, `username`, `path`: the spaces of deleted people) |
| `POST /api/admin/spaces/managers` | The vihko admin, confirmed at the moment | `path`, `userId`, `confirm` | `space`. Only for a space without managers (a disabled one doesn't count): `409 space_has_managers` otherwise |
| `POST /api/admin/spaces/join` | The vihko admin, confirmed at the moment | `path`, `level`? (`read` by default), `confirm` | `space`. Only for a space without managers (a disabled one doesn't count): `409 space_has_managers` otherwise. Its members are told (`space_changed`, `admin_joined`) |
| `POST /api/admin/users` | The vihko admin; confirmed at the moment for a new admin | `username`, `role`? (`member` by default), `adopt`?, `confirm`? | `201`: `user`, `link` (their invitation), and their folder `people/<username>/`. When that folder already exists with something in it: `409 personal_folder_exists`, unless `adopt: true`, which makes it theirs as it is (never by default). `409 user_exists`, `400 invalid_username` |
| `PUT /api/admin/users/:id/username` | The vihko admin | `username` | `user`. Only someone who hasn't used their invitation yet (`409 not_invited` otherwise): their folder, the grants to them in `vihko.yaml` and their link follow the new name. `409 user_exists` and `400 invalid_username` as for a new user |
| `GET /api/admin/users/:id/space` | The vihko admin | — | `path`, `exists`, `sharedFolders`, `people` (counts), and `shared` (each folder they share: `path`, only where the admin reads it, else null; `people`: `username`, `level`). What a deleted person shared stays shared until the admin decides what becomes of their space |
| `POST /api/admin/users/:id/space` | The vihko admin, confirmed at the moment | `action` (`transfer`, `convert` or `delete`), `to` (a user id, for `transfer`), `name` and `members` (for `convert`), `dryRun`?, `confirm`, `deleteUser`? | `plan` (`action`, `from`, `to`, `notes`, `files`, `sharedFolders`, `people`). `400 space_needs_manager` when a conversion names nobody who manages it. A transfer goes to `people/<recipient>/<deleted username>`, or, if that name is taken there, the first free `-<n>` after it, found only when it moves (a dry run never looks into the recipient's space); the transfer's own answer has `to: null` for an admin who doesn't read there. A conversion doesn't bring the person's `.vihko/` along: it goes to the trash. With `deleteUser: true`, the person is disabled but not deleted yet: what is asked (a transfer or a conversion) is checked and confirmed, then they're deleted and their space settled |
| `GET /api/permissions` | `manage` in the folder | `folder` | `folder`, `etag` (of `vihko.yaml`), `section` (`none`, `rules` or `closed`), `own` (`grants`), `inherited` (`from`, `grants`: every folder above it in its space with grants), `owner`, `space` (`path`, `name`), `ai` (`closed`, `from`), `canEdit`, `access` (who has access, and why) |
| `PUT /api/permissions` | `manage` in the folder | `folder`, `grants`? (or null), `ai`? (`false` or null), `ifMatch` | As `GET`, or `folder`, `etag` and `canEdit: false` when the change took the person's own `manage` there away. `428 precondition_required` without `ifMatch`; `412` when `vihko.yaml` changed; `409 config_invalid` when it can't be changed as it is; `400 invalid_path` for a folder path that isn't one; `400 invalid` for grants at a personal space's root. Inside a shared space a new or changed grant to one of its members (a person, or a group with a grant at its root) at or below their level in the whole space is `400 grant_not_higher` with `subject` and `level`; at a space's root, the grants below it of whoever is taken out go, and so do grants below that no longer raise their subject above their level in the space |
| `GET /api/permissions/folders` | Anyone | — | `folders` (`path`, `level`, `ownGrants`, `aiClosed`, `canEdit`): only what the asker sees; `section` (`none`, `rules` or `closed`) |
| `POST /api/permissions/holds/:id` | Who could have made that move from vihko | `action: "release"` | `ok` |
| `POST /api/folder` | `edit` in the parent | `path` | `201`: `path`. `outside_space`, `space_root` |
| `POST /api/folder/templates` | `edit` in it | `path` (a folder), `dryRun`? | `marked`, `already`, `skipped` (counts, of the notes in the folder and below: those it marks, or would mark, with `template: true`; those already marked; those whose frontmatter can't be read). Each is written as any edit of that note. `404 not_found` for a folder the person doesn't see |
| `POST /api/note/template` | `edit` where the note is | `path`, `template` (`true` or `false`) | `etag`. `true` sets `template: true`, `false` removes the key; nothing else of the note changes |
| `POST /api/folder/move` | `manage` in it and `edit` in both parents | `from`, `to`, `dryRun`?, `background`? | The folder move's report, with `images.copied` when it changes space; with `background`, a move that takes more than a moment answers `202` with `job` instead, followed with `GET /api/move-jobs/:id`. The root of a folder someone shares with you is only theirs to move. Into another space, its grants (and those of the folders under it) go along only for whoever manages where it goes; otherwise only `ai: false` does, and it takes the audience of where it lands. `409 permissions_invalid` when it has rules of its own and `vihko.yaml` can't be changed as it is |
| `DELETE /api/folder` | `manage` in it and `edit` in its parent; never the root of a folder someone shares with you | `path`, `trash`?, `dryRun`? | `path`, `trashed`. `409 held_inside` while notes held after a move made outside vihko are in it. `409 not_empty`'s `contents`: `notes`, `files`, `hidden` (its hidden folders, which go to the trash with it: `total`, `paths`, and `files`, how many files they hold) and `kept` (symbolic links, which stop it). With `dryRun=true` nothing is deleted: `path` and `contents`, with the same checks |
| `GET /api/home` | Anyone | — | «Home»: `recent` (`path`, `title`, `at`: notes the person changed lately; without a history, those of their own space changed last), `changed` (the same and `by`: what others changed lately in notes the person reads; `by` (`kind` `user`, `agent` or `external`, `name`, and for an agent `onBehalfOf`, the person's name) only where they may see the history, null elsewhere), `shared` (`kind` `space` or `folder`, `path`, `name`, `owner`, `by`, `at`: what was shared with them in the last 30 days, while they see it). At most 8 each; nothing the person can't read |
| `GET /api/live` | Anyone | — | A server-sent event stream: `ready` when it opens, then `tree` (data `{}`) whenever a change concerns what the person sees: a note made, renamed, moved or deleted where they read, a folder made or gone there, or what they reach (their spaces, what is shared with them, their levels) changed. It never says what changed. Also `notices` (data `{}`) when a notice arrives for them. A comment keeps it open every 25 s |
| `POST /api/auth/password` | Anyone, their own | `current`, `password`, `endSessions`? and `revokeKeys`? (each `false` when absent; any other field is `400 invalid`) | `ok`, `sessionsEnded`, `keysRevoked`. `sessionsEnded`: with `endSessions`, how many other sessions of theirs were signed out (never the one that asks); `0` without it. `keysRevoked`: with `revokeKeys`, how many keys and authorised apps of theirs were revoked (those that worked, and members' suspended ones, which never come back), their OAuth access and refresh tokens and the codes not yet exchanged going with them; `0` without it. Whatever is chosen, a confirmation at the moment of any session of theirs ends. `403 wrong_password`, `400 weak_password` |
| `GET /api/account/2fa` | Anyone, their own | — | `policy`, `enabled`, `enabledAt`, `recoveryCodesLeft`, `confirmWith` (`code` or `password`), `confirmNeeded` and `confirmedUntil`: what is «confirmed at the moment» doesn't ask while a confirmation of this browser session lasts (15 minutes from it), and `confirm` is then ignored. Never for a key or an OAuth token |
| `GET/PUT /api/profile` | Anyone, their own | `timezone`?, `dailySeries`?, `onOpen`? (`home`, `last`, `note` or `daily`), `onOpenNote`? (a note's path, with `note`), `language`?; `openDailyOnStart`? (deprecated: `true` is `onOpen: daily`) | `timezone`, `dailySeries`, `onOpen`, `onOpenNote`, `openDailyOnStart` (deprecated: `onOpen` is `daily`), `language`, `lastNote` (this device's last note: null when there is none, it is gone, or the person can't read it). `onOpen: note` names only a note the person reads: `404 not_found` otherwise, and one they no longer read comes back as `home`. `onOpenNote` follows its note when vihko moves or renames it, or its folder. `onOpen: last` opens the note this device had open last, which vihko keeps in the person's account for each device: it follows moves and renames, outlives signing out, and gives Home when the person can't read it any more. A device is a browser, by its device cookie (`vihko_device`), which it keeps from one sign-in to the next |
| `PUT /api/profile/last-note` | Anyone, their own | `path` (a note the person reads) | `lastNote`: kept as this device's last note (the UI says it each time it opens a note). `400 invalid` for what isn't a note's path; `404 not_found` for a note the person can't read, whether it exists or not. A browser without a device cookie gets one |
| `GET /api/trash` | Anyone | — | `entries`, each with `space` (its space's root, or null), and `bytes` (its note and the files of it the person sees, never the rest), `deletedBy` (`kind` `user`, `agent` or `system`, `name`, and `id` and `onBehalfOf` (`id`, `name`) as they apply), `canRestore`, `canDelete` (whoever manages where it was in a shared space, the owner of a personal space, who managed a deleted space, and only when the person sees all of it), `expiresAt` (when the trash's retention takes it, null while it's off) and `deletedSpace` (the id of the deleted space it belongs to, for whoever sees that space whole); and the answer has `spaces` (the deleted spaces the person may restore whole, as `GET /api/spaces/deleted`, with `bytes` (null but for who managed it), `canRestore`, `canDelete` and `expiresAt`), `bytes` (the sum of the entries') and `retentionDays` (null: off) |
| `POST /api/trash/:id/restore` | Where the entry was | `to`? | `path`, `etag`, `files`, `left`: what stayed in the trash, only where the person reads. `409 exists` when a note has its name: `to` restores it under another name or in another place where the person may write. A `to` that isn't a string is `400 invalid` |
| `DELETE /api/trash/:id` | As `canDelete` says, confirmed at the moment | `confirm` | `entries`, `bytes`. The entry goes from the trash for good (with the history's retention on, its notes' history goes at the next run, as for an entry the retention empties). `403 forbidden` for one the person sees but may only restore, `404 not_found` for one they don't see, both before anything is asked |
| `POST /api/trash/empty` | Anyone, confirmed at the moment when it deletes anything | `space`? (a space's root), `dryRun`?, `confirm` | `entries`, `spaces`, `bytes` (what it deletes, or with `dryRun` would delete, asking nothing), `kept` (what the person sees there but may only restore). Everything in the trash the person may delete for good, of one space with `space`; a deleted space's entries go with it |
| `DELETE /api/spaces/deleted/:id` | Who managed it when it was deleted, confirmed at the moment | `confirm` | `entries`, `bytes`. Its trash entries go for good, and it can't be restored any more; its name stays taken while its history holds anything. `403 forbidden` for the vihko admin who didn't manage it (they may restore it, never destroy it), `404 not_found` for anyone else |
| `GET /api/keys` | Anyone | `all=1` (the vihko admin: everyone's; `403 forbidden` for anyone else) | `keys`; with `all=1`, each with `user`, and `foldersHidden` when someone else's key reaches folders the admin doesn't read (those aren't listed in `folders`) |
| `POST /api/history/purge` | Whoever manages the note's folder; the vihko admin, any path | `path`, `version`?, `dryRun`?, `confirm` | `path`, `version`, `dryRun`, `versions`, `filesRemoved`, `onDisk`, `sharedWith`, `movedFrom`, `confirmRequired`. The admin's dry run of a path they can't read answers `hidden: true` with nothing of it (no versions, nothing on the disk), whether it exists or not. `409 history_unmanaged` (the history isn't the managed one), `409 history_no_repository`, `409 history_moved`, `400 invalid_version`, `404 not_a_version` |
| `GET /api/history/purgeable` | Anyone signed in (never a key) | — | `paths`: `{ path, deleted }` for each file the managed history holds versions of that the person may purge and reads now (whoever manages a folder, its notes; the vihko admin, any file they read); `deleted` when its last version deletes it. Empty in any other history mode. A path the person can't read is never listed |
| `POST /api/admin/rescan` | The vihko admin | `force`?, `confirmRemoval`? | Counts only: `added`, `changed`, `removed`, `moved`, `unchanged`, `aborted`, `massDelete` |
| `GET /api/move-jobs/:id` | Whoever started the move | — | `done` and `total` count only the notes the person reads |
| `GET/PUT /api/admin/settings` | The vihko admin | `spacesCreation`? (`everyone` or `admins`), `trashRetentionDays`?, `historyRetentionDays`? (a whole number of days, 1 to 36500, or null: off), `confirm`? | The settings, with `spacesCreation`, `trashRetentionDays` and `historyRetentionDays` (null by default). Turning a retention period on or shortening it needs `confirm` (`400 confirmation_required` without it); a longer one, or null, doesn't |
| `GET /api/workspace` | Anyone | — | `daily`: the series the person can write today's note in, from `vihko.yaml`, their shared spaces' settings and their own; `links` (`aliases`). Templates are marked in the notes (`GET /api/tree`) |
| `GET /api/settings` | One's own; a shared space's members | `space`? (a shared space's root; one's own space when left out) | `space` (the root), `etag`, `settings` (`version`, `daily` (`id`, `label`, `folder`, `name`, `template`), `attachments` (`mode`, and `folder` or `suffix`; null: as `vihko.yaml` says), `agents` (a person's), `guide` (a shared space's text); paths relative to the space), `errors` (what is wrong in the file: `code`, `at`, `line`, `detail`), `guideMissing` (`agents` names a note that doesn't exist), `canEdit` (oneself, or a manager). `404 not_found` for a space the person isn't in, or anything that isn't a space's root |
| `PUT /api/settings` | One's own; a shared space's managers | `space`?, `settings` (as `GET` gives them), `ifMatch`, `remove`? (keys of the file vihko doesn't know to remove from it, as `errors` names them in `at`; any other is ignored) | As `GET`. `400 invalid` with `errors` (nothing written), `428 precondition_required` without `ifMatch`, `412 precondition_failed` when the file changed, `403 forbidden` for a member who doesn't manage the space, `400 invalid_path` when the settings' path goes through a symbolic link (`GET` reads none there), `409 config_invalid` when the file isn't YAML or a map and can't be rewritten (it's fixed by hand) |
| `POST /api/admin/permissions/restore` | The vihko admin, confirmed at the moment | `confirm` | While `permissions_missing` is raised: the last `permissions` section that shared something, written back into `vihko.yaml` folder by folder (the rest of the file as it is): `ok`, `folders` (how many). `404 not_found` when there's nothing to restore |
| `DELETE /api/admin/permissions/restore` | The vihko admin | — | `permissions_missing` dismissed, and the kept section forgotten. `404 not_found` without the alert |
| `GET /api/admin/retention` | The vihko admin | — | `lastRun` (`at`, `trash: { entries, bytes }`, `history: { versions, bytes }` or null, `failed`) or null; `nextRun` (null while both periods are off); `history`: whether the history is the managed one, the only one retention thins |
| `POST /api/admin/retention/run` | The vihko admin | `confirm` | A run now with the settings in force (`400 confirmation_required` without `confirm`): `at`, `trash`, `history`, `failed`, as `lastRun` |
| `POST /api/admin/retention/preview` | The vihko admin | `trashRetentionDays`?, `historyRetentionDays`? (missing: as they are) | What the next run would remove with them: `trash: { entries, bytes }`, `history: { versions, bytes }` (null when off or not managed). Counts and sizes of the whole installation, never a path |

### Search filters

The query of `GET /api/search` and of the MCP `search` tool: words (each a
term, the last one also a prefix), and filters, each a word of its own:

| Filter | Keeps |
|---|---|
| `tag:<tag>` | Notes with that tag or one nested under it |
| `path:<folder or note>` | Notes in that folder and below, or that note |
| `<key>:<value>` | Notes whose frontmatter has that top-level key with that value, for any key that starts with a letter or `_` (then letters, digits, `_`, `.`, `-`) and isn't a reserved name (below). A value that starts with `//` isn't one (an address stays a word) |
| `prop:<key>=<value>` | The same, for any key at all, a reserved name included |
| `prop:<key>` | With no value: notes whose frontmatter has that key with a simple value (below), or with none |

- **Reserved names**: `tag`, `path`, `is`, `has`, `in`, `prop`, `before` and `after` are vihko's own
  filters, now or later, never a frontmatter field: a field with one of those
  names is searched only as `prop:<key>=<value>` (or `prop:<key>`). `is:`,
  `has:`, `in:`, `before:` and `after:` mean nothing yet: a filter with one
  matches no note (and, with `-`, every note) until a version gives it a
  meaning. Any other name is free for your frontmatter (`type:`, `status:`,
  `created:`, `modified:`…).
- `-` in front of any filter excludes instead; `"…"` quotes a value (or a
  `prop:` key) with spaces. Several filters all apply. A filter starts a
  word: a word quoted whole (`"re:budget"`) is searched as text.
- Keys and values of fields, and tags, compare case-insensitively (full case
  folding, NFC), whole. `path:` ignores case only in the letters A to Z.
  A list matches when any of its items does. A number matches the same number
  however it's written (`5`, `5.0`). Only simple values are searched: text,
  numbers, `true`/`false`, dates (as written) and lists of them; a key whose
  value is a map, or a list of maps, isn't, not even by `prop:<key>`. The
  [limits](#limits) say how long a value can be.
- Templates (`template: true`) are left out unless a filter on `template`
  that doesn't exclude asks for them (`template:true`, `prop:template`).
- Only notes the principal reads are ever searched or counted.

### Alerts and notices

`GET /api/alerts` (the UI's, so not covered, like the other routes for the
web UI) answers codes with their data; the only text in them is for
developers (a `detail`, a migration's `description`). Each notice to one
person also has `id`, `at` and `actions` (`dismiss`). The codes about
spaces, sharing and what an admin is told of them:

| Code | Who sees it | What it says |
|---|---|---|
| `outside_spaces` | Admins | `paths`: top-level names, and folders in `spaces/` that aren't a space, that nobody sees; `into`: the admin's own space (`people/<admin>`), where they can move them on the disk. Also a `config_warnings` entry for a `vihko.yaml` path outside the spaces |
| `unreadable_notes` | Admins | `paths`: notes on the disk vihko can't read (no permission, an I/O error), among those the admin reads; `elsewhere`: the roots of the spaces that hold the others. Each stays as the index had it, and the server's log names it, until it can be read. A scan or a start never stops for one |
| `permissions_missing` | Admins | `file`, `folders` (how many folders the kept section has rules for), `actions` (`restore_permissions`, `dismiss`): `vihko.yaml` has no `permissions` (or there's no file), so nothing is shared, while vihko kept the last section that shared something |
| `notes_too_large` | Admins | `paths` (those the admin reads), `elsewhere` (the roots of the spaces that hold the others), `limitMb`: notes over `notes.maxSize`, indexed by their name alone and never opened live |
| `closed_spaces` | Admins | `people`: usernames of deleted people whose space nobody has decided about yet (transferred, made a shared space or deleted) |
| `person_folder_without_user` | Admins | `names`: folders in `people/` named after no user |
| `space_without_members` | Admins | `path`, `name`: a shared space nobody has access to |
| `space_without_managers` | Admins | `path`, `name`: a shared space with members but nobody who manages it (a disabled manager doesn't count) |
| `missing_folder` | Whoever manages the space | `folders`: grants in `vihko.yaml` for folders that don't exist. Never the admin as such |
| `permissions_held` | Who could have made that move from vihko | `id`, `folder`, `notes` (a count): notes held after a move made outside vihko |
| `shared_with_you` | The person added | `kind` (`space` or `folder`), `by`, `path`, `name`, `owner`, `space`: someone added them to a space or shared a folder with them. Names and path only while they can still see it |
| `space_changed` | The people concerned, and the other admins | `change` (`manager_assigned`, `admin_joined`, `personal_transferred`, `personal_converted`, `personal_deleted`), `by`, `user`, `to`, `space` (`path`, and `name`, null for a personal space; the whole of it null once the person can't see it) |
| `links_not_updated` | Whoever made the move | Links in other notes a move of theirs couldn't update, even retried. No path, name or count |
| `account_key_added` | The person whose account it is | `kind` (`key` or `app`), `name`: a key was made, or an app authorised, on their account, even by themselves |
| `removed_from` | The person taken out | `kind` (`space` or `folder`), `by`, `name` (the space's, or the folder's), `owner` (a personal space's) or `space` (the shared space's name, for a folder): as they last saw them, never where it is now |
| `space_deleted` | The members of a shared space; whoever deleted it, if they managed it | `by`, `name`, `deleted` (what `restore_space` restores it by, only for whoever may; null otherwise), `actions` (`restore_space` then too, and `dismiss`) |
| `space_restored` | The members of a restored space | `by`, `path` and `name` (while they're in it) |
| `space_renamed` | The members of a renamed space | `by`, `from` (its name before), `name`, `path` (while they're in it) |
| `moved_out` | A personal space's owner | `kind` (`note` or `folder`), `by`, `from` (where it was in their space), `to` (where it is, only while they read it), `space` (`path`, `name`: the shared space it went to) or `owner` (the person whose space it went to): someone they shared it with moved it out of their space |
| `settings_invalid` | The person, for their own settings; a shared space's managers, for the space's. Never the admin as such | `space` (null for one's own; otherwise `path` and `name`), `file` (the file's path from the notes root), `errors` (`code`, `at`, `line`, `detail`): what is wrong in a settings file |
| `settings_guide_missing` | The person, for their own settings | `space` (always null: a shared space's guide is text), `note`: a person's settings name a guide for agents (`agents`) that isn't a note, so agents get nothing from it |
| `note_not_saved` | Every admin | `path` (null for an admin who can't read the note), `space` (its space's root), `reason` (`disk_full`, `write_denied` or `write_failed`), `volume` (`notes`: its file; `state`: its recovery log): an open note vihko can't save. It's read-only for whoever has it open until vihko can, which it keeps trying; then the alert goes |
| `retention_ran` | Every admin | `trashEntries`, `versions`, `failed`: what a retention run (weekly, or «Run now») removed (or that it failed part way). Counts only |
| `settings_migrated` | Whom the file belongs to: the person for their settings, a shared space's managers for its, the admins for `vihko.yaml` | `key` (a retired key), `file` (null once they can't see it), `marked` (notes marked as templates), `missing` (folders it named that no longer exist): what vihko did at start with a key it retired, before removing it from the file. Until dismissed |

`history_purged` names the path only to an admin who can read where it was,
or who purged it; to the others, `path` is null.

Its other codes, about the scan, the configuration, the history and
accounts: `scan_aborted_mass_delete`, `scan_aborted_root_unavailable`,
`orphaned_note`, `uid_conflict`, `external_move`, `sync_conflict`,
`config_invalid`, `config_warnings`, `config_migrated`,
`config_migration_failed`, `config_template_missing`, `state_migrated`,
`history_unavailable`, `history_files_too_large`, `history_versions_merged`,
`history_purged`, `history_purged_authored`, `history_no_repository`,
`integrations_unversioned`, `login_attempts_blocked`,
`permissions_rejected`, `two_factor_unreadable`, `account_changed` and
`user_account_changed` (whose `change` is `reset_link`,
`two_factor_reset`, `role_changed`, `invite_link`, `disabled` or
`deleted`).

## The MCP server

The [Agents guide](agents.md) explains how to connect.

### The endpoint

| What | In 0.1.0 |
|---|---|
| Address | `/mcp`, on the same address and port as the UI |
| Transport | Streamable HTTP, without sessions: a client needs only `POST`. Any other method (`GET`, `DELETE`…) answers `405` with `Allow: POST` and `error: invalid` |
| Protocol versions | Those of the MCP specification the server offers: in 0.1.0, 2026-07-28 and the 2024 and 2025 revisions |
| Credential | `Authorization: Bearer` with a key, or an OAuth access token (see [OAuth](#oauth)) |
| The MCP switch off | `404`, whatever the request |
| No credential, or a wrong one | `401`, with a `WWW-Authenticate: Bearer` challenge (naming the resource metadata while OAuth exists) |
| A member's key or app while the admin doesn't let members have keys | `403 key_suspended`; it works again once they do |
| An `Origin` that isn't vihko's own | `403 forbidden` with a key; with an OAuth access token, accepted from the origin of one of its app's redirect URIs and `403 forbidden` from any other; without a valid credential (a token whose authorization no longer holds included), the `401` above |
| Request size | Up to 4 MiB: an image of about 3 MB for `attach_image`. Beyond it, `413` with a JSON-RPC error (code `-32000`), not vihko's `error` and `message` |

### Conventions

- Paths are from the notes root, with `.md`, inside a space, as over HTTP.
- Parameters are `snake_case`. `camelCase` is accepted too (and
  `nextOffset` for `offset`), and so are these other names: `note`, `file`
  and `note_path` for `path`; `etag` for `if_match`; `q` for `query`;
  `source` and `destination` for `from` and `to`; `id` for `version`. And
  for one tool each: `content` for `text` (`create_note`), `ops` for
  `operations` (`edit_note`), `path` for `folder` (`list_folder`), `path`
  for `from` and `target` for `link` (`resolve_link`), `etag` and `version`
  for `since` (`changes_since`, where `etag` isn't `if_match` and `id`
  isn't taken), and `path`, `file` or `note_path` for `note` and `image`
  for `data` (`attach_image`).
- A result's first block is its data as JSON, between `<data-…>` markers. A
  note's text comes in a block of its own, between `<note-…>` markers. Both
  markers carry a random tag. Results have no `structuredContent`: the data
  is that first block.
- An error is a result with `isError`, whose text is JSON: `error` (a code),
  `message`, and as they apply `etag`, `hint`, `reason` and `audience`. The
  codes are those of the HTTP API, for the same cases. Arguments that don't
  fit a tool's schema are `invalid`.
- Results are `snake_case`. Lists are paged: pass `next_offset` back as
  `offset`, or `next` as `cursor`.
- A write that hides the note from the agent succeeds and adds `now_hidden:
  true`, `reason` and `message`. Its `etag` is left out when the agent
  didn't have the note's whole text: `move`, and `edit_note`,
  `revert_change` without `if_match`, and `create_note` from a template.
- A read-only key is offered only the reading tools (and a `daily_note` that
  only looks, with no `create`); calling a writing tool answers `forbidden`.
- A note's history (`history`, `revert_change`, and `changes_since` from a
  version id) needs `edit` where the note is now, as over HTTP: `forbidden`
  otherwise.
- Agents don't create, rename, delete or leave spaces, share folders, or move
  folders: those are for people, in the UI.

### Reading tools

| Tool | Parameters | Result |
|---|---|---|
| `search` | `query` (required; the filters of [Search filters](#search-filters)), `limit` (1 to 50, 20), `offset` (0) | `results` (`path`, `title`, `snippet`), `next_offset` |
| `get_note` | `path` or `uid`, `offset` (0), `max_chars` (1,000 to 200,000; 100,000) | `path`, `etag`, `title`, `uid`, `frontmatter`, `links` (`outgoing`: `link`, `target`, `anchor`, `status`, `path`, `candidates`, and `others_no_access`, `reason` when they apply, `file` for a link that leads to a file that isn't a note; `incoming`: `path`, `title`, `count`; `more`), `text` (`offset`, `length`, `total`, `next_offset`); the text as a block |
| `list_folder` | `folder` (`""`, the default, or a folder), `recursive` (false), `limit` (1 to 500, 100), `offset` (0) | `folder`, `entries` (`kind` `folder` with `path`, or `note` with `path` and `title`), `next_offset`. With `""`, the roots the person reaches (below) |
| `related` | `path` (required), `limit` (1 to 200, 50), `offset` (0) | `path`, `links_to` (`link`, `target`, `anchor`, `status`, `path`, `title`, `candidates` with `path` and `title`, and `others_no_access`, `reason`, `file` when they apply), `linked_from` (one per note: `path`, `title`, `count`, and its first `link` with its `context`), `next_offset` |
| `resolve_link` | `from`, `link` (required) | `from`, `link`, `target`, `anchor`, `status`, `path`, `title`, `anchor_found`, `candidates`, and `others_no_access`, `reason` when they apply. Notes only: a link to a file that isn't a note is `missing` here, where `get_note` and `related` give it as `resolved` with `file` |
| `changes_since` | `path`, `since` (an ETag or a version id; required), `wait_seconds` (0 to 30, 0), `include_text` (false) | `path`, `etag`, `changed`; when changed, `words` (`added`, `removed`), `changes` and `truncated`, and a `note` that their text is the note's; or `base_known: false` and a `hint`, with the whole text |
| `history` | `path` (required), `version`, `include_text` (false), `cursor`, `limit` (1 to 20, 10) | `path`, `versions` (`version`, `at`, `authors`, `change`, `from` when it was elsewhere, `path`, `reason`, `words`), `next`; with `version`: `path`, `version`, `at`, `change`, `words`, `changes`, `truncated` |
| `daily_note` | `series` (an id of `vihko.yaml`, or one of a space's series as `GET /api/workspace` gives it: `me-…`, `sp-…`) | `series`, `path`, `exists`, and `etag` with the text as a block when it exists |

**`list_folder` with `""`** lists, first, one entry per root the person
reaches within the key, each `kind: "folder"` with its `path` and a `space`:

| `space.kind` | The root | Other fields |
|---|---|---|
| `personal` | Their own space, `people/<username>` | — |
| `shared` | A shared space they belong to | `name`, `level` |
| `received` | A folder someone shares with them | `level`, and `owner` (in a personal space) or `name` (of its shared space) |

A space the key reaches only part of (a folder in it) is listed by its root
all the same; listing that root shows only what the key reaches. With
`recursive`, the folders and notes under those roots follow.

Each of `changes` (in `changes_since` and `history`) is `line` (in the
newer text, from 1), `removed`, `added`, and some of the newer text
`before` and `after` it.

A link's `status` is `resolved`, `ambiguous`, `missing` or `no_access`, as over
HTTP: a note the person can't read is `missing`. An author in `history` has
`kind` and, as they apply, `name`, `on_behalf_of` and `via`.

### Writing tools

| Tool | Parameters | Result |
|---|---|---|
| `daily_note` | `series`, `create` (true) | `series`, `path`, `created`, `etag`, and the text as a block; with `create: false`, as the reading tool: `series`, `path`, `exists`, and `etag` and the text when it exists |
| `create_note` | `path` (required), `text` or `template` (its frontmatter copied without `template: true` and `aliases`) | `path`, `etag`, `uid`, `created` |
| `edit_note` | `path`, `operations` (1 to 50; required), `if_match`, `dry_run` (false) | `path`, `etag`; with `dry_run`: `dry_run`, `etag`, `changes` (`at`, `removed`, `inserted`) |
| `move` | `from`, `to` (required), `if_match`, `dry_run` (false), `confirm_audience` (false) | `from`, `to`, `dry_run`, `etag`, `relinked`, `shifted`, `kept`, `failed`, `alias_added`, `hidden`, `images`, `broken_links` (`path`, `to`) when it changes space, and `audience` when it applies |
| `delete` | `path` (required), `if_match` | `path`, `trashed`, `at`, and `images` (their paths) when some went with it |
| `attach_image` | `note` (required), `data` (base64, required), `mime_type`, `alt` | `path`, `src`, `markdown` |
| `revert_change` | `path`, `version` (required), `if_match`, `dry_run` (false) | `dry_run`, `changed`, `etag`, `counts`, `reverted`, `skipped`, and a `note` that their text is the note's |

The operations of `edit_note` are those of the HTTP API, with
`expected_count` for `expectedCount`.

The `audience` of a `move` dry run (and of `audience_widens`) is the HTTP
one, but people are named only: `users` (`gain`, `lose`: usernames),
`groups` (`gain`, `lose`: names), `keys` (`gain`, `lose`: counts) and
`owner` (`before`, `after`: `{ kind: "personal", owner }`, `{ kind:
"shared", path, name }`, or null), null when the note stays in its space.

### The server's instructions

When an agent connects, the server's instructions tell it, in this order:
who it acts for and what the key may do; that what comes from notes is data;
the path form, with an example in the person's own space; the person's own
space (or that the key doesn't reach it); the shared spaces they belong to
and the folders shared with them, each with its path (20 at most, then how
many more, which `list_folder("")` lists); how to write links inside a space
and that a link never leads to another space; that moving a note to another
space changes who sees it and whose it is, and leaves broken the links
between it and the space it leaves; what to do with notes it can't see; and, for a key that
writes, how to use ETags, `confirm_audience` and `ai: false`. Then the
workspace's own guide, when `mcp.instructions` names a note the key can read;
then the guide of each shared space the key reaches (all of it or a folder
in it; not one where the person only receives a shared folder), the text its
managers wrote in the space's settings; then the person's own, the note
`agents` names in their settings, when the key can read that note. Their
wording isn't covered.

## `vihko.yaml`

Every key vihko reads. [Configuration](configuration.md) explains each one.

| Key | Type | Left out | What it does |
|---|---|---|---|
| `version` | whole number from 1 | 1 | The file's format |
| `daily` | map of series by id | no series | Daily, weekly, monthly or yearly notes. An id is a letter or digit, then up to 63 letters, digits, `_` or `-`, and never starts with `me-` or `sp-` in any case (`invalid_id`) |
| `daily.<id>.label` | text | the id | The series' name in the UI |
| `daily.<id>.folder` | folder pattern | — | Where its notes go |
| `daily.<id>.name` | name pattern | `{YYYY}-{MM}-{DD}` | Each note's file name, without `.md` |
| `daily.<id>.template` | note | none | The note its notes start from |
| `attachments.mode` | `next-to-note`, `folder` or `per-note` | `next-to-note`, or `folder` when `folder` is given | Where new images go |
| `attachments.folder` | folder | — | The folder for `mode: folder` (and only for it), **relative to the root of each note's space** |
| `attachments.suffix` | text | `.assets` | The folder suffix for `mode: per-note` (and only for it): up to 32 characters, without `/`, `\`, spaces around it or a final `.md` |
| `links.aliases` | `true` or `false` | `true` | Whether frontmatter aliases resolve `[[links]]` |
| `history.mode` | `managed`, `unmanaged` or `off` | `managed` | How the history is kept |
| `history.maxFileSize` | number of MiB | 20 | The largest file that enters the history |
| `history.exclude` | pattern, or list of patterns | none | Paths kept out of the history |
| `mcp.instructions` | note | none | A note served to agents as instructions; may hold `{user}` |
| `mcp.client_domains` | list of domains (or one) | empty | The domains OAuth apps may come from, with their subdomains (a metadata document's host, or every redirect URI of an app that registers itself). Empty: any. An app from elsewhere can't register (`invalid_redirect_uri`) or be authorized (`client_not_allowed`, with `host`, on `GET/POST /api/oauth/authorize`) |
| `notes.maxSize` | number of MiB | 5 | The largest note vihko indexes and opens in the live editor: a larger one is indexed by its name alone, shows as plain text with a download, and the API and MCP refuse writes that make a note larger (`413 note_too_large`) |
| `permissions.<folder>.grants` | map of subject to level | nobody | Who gets what in that folder and below |
| `permissions.<folder>.ai` | `false` | open | Closes the folder and everything below it to agents |

`attachments.folder` without `mode: folder` (or `mode: folder` without a
folder), and `attachments.suffix` without `mode: per-note`, are wrong values
(`invalid_value`), like any other: see «How the file is read» below.

What goes with them:

- **Paths** are from the notes root. A series' folder or `mcp.instructions`
  outside `people/` and `spaces/` is ignored, with an `outside_spaces`
  warning. `{user}` in a series' pattern or `mcp.instructions` is the
  person's username (with
  `people/{user}/agents.md`, each person's agents get their own guide).
- **Patterns** in `daily`: `{YYYY}`, `{MM}`, `{DD}`, `{GGGG}`, `{WW}` and
  `{user}`. «Today's note» only offers the series where the person can write
  today's note.
- **Template variables**: `{{title}}`, `{{user}}`, `{{date}}` and
  `{{date:FORMAT}}`, with the tokens `YYYY`, `YY`, `MM`, `M`, `DD`, `D`,
  `GGGG`, `WW`, `W`, `HH`, `mm` and text in `[brackets]`.
- **Templates** aren't configured here: a template is a note marked
  `template: true`.
- **Permission keys** are real folders: a shared space's root
  (`spaces/<name>`) or a folder below it, or a folder inside a personal
  space (`people/<user>/<folder>`, and below). A personal space's root
  (`people/<user>`) takes only `ai: false`. Anything else rejects the
  section: `""`, `people`, `spaces`, a path in no space, a `{user}` segment,
  grants at a personal space's root, a key written twice. A shared space's
  name is its folder's: no key holds it.
- **Subjects**: a username, or `@group`. **Levels**: `read`, `comment`,
  `edit` and `manage`. No group can be named `everyone`, `all`, `public` or
  `anyone` (`400 invalid_group_name`): those subjects are kept for grants to
  everyone, should they come.
- **Sharing only adds.** A person's level in a folder is `manage` in their own
  space; nothing in the space of a deleted person; otherwise the highest level
  that the grants of the folder and of every folder above it, up to its
  space's root, give them by name or through a group. Being an admin adds
  nothing.
- **How the file is read**: a key vihko doesn't know is ignored with a
  warning; a wrong value in a known key keeps the last valid file (also when
  vihko starts with it, from a copy it keeps in the state volume; the alert
  says `fallback: last_good`). The `permissions` section is strict: a
  section with anything wrong in it is rejected whole (`permissions_rejected`).
  While vihko runs, the last valid section stays in force; when vihko starts
  with a rejected one, it fails closed: no grant applies, and each person
  keeps only their own space. Without the section (or without the file),
  nobody shares anything, and the admins get `permissions_missing`.
- **How vihko writes it**: the `permissions` entries that change when someone
  shares a folder, creates, renames, deletes or leaves a space, moves or
  deletes a folder, or when a user or group is deleted or renamed; when the
  admin assigns a manager, joins a space to rescue it, restores the last
  permissions or settles a deleted person's space; when a key vihko retired
  is migrated at start; and a format rewrite at start after an upgrade,
  which may raise `version`. Comments, key order and keys it doesn't know
  stay. When `vihko.yaml` is a symbolic link, vihko writes the file it
  points to, atomically, and the link stays.

## Settings of a person or a space

Each space can have a settings file at
`<space root>/.vihko/settings.yaml`: `people/<username>/.vihko/settings.yaml`
for a person, `spaces/<name>/.vihko/settings.yaml` for a shared space. One
format for both. [Configuration](configuration.md#settings-of-a-person-or-a-space)
explains it.

| Key | Type | What it does |
|---|---|---|
| `version` | whole number from 1 | The file's format (1 when left out). A newer one is read as far as vihko can, with `newer_version` |
| `daily.<id>` | as in `vihko.yaml`: `label`, `folder`, `name`, `template` | The space's daily-note series. Patterns take `{YYYY}`, `{MM}`, `{DD}`, `{GGGG}` and `{WW}`, not `{user}` (`pattern_token`) |
| `attachments` | `mode`, `folder`, `suffix`, as in `vihko.yaml` but for what follows | Where new images of the space's notes go. Only the key of the mode applies (`folder` for `folder`, `suffix` for `per-note`); the other is left out without a word. A `suffix` that can't be one is `invalid_value`, and it has no length limit |
| `agents` | note | A person's space only: their guide for agents. In a shared space's file it doesn't apply, and is reported as `space_guide_note` (with the note it names) |
| `guide` | text, up to 20,000 characters | A shared space only: its guide for agents, the text itself. Only its managers change it. In a person's file it's an `unknown_key` |

- **Paths are relative to the space's root**, never from the notes root: no
  leading `/`, `..`, `.` or hidden segment (`invalid_path`). Renaming a space
  changes nothing in its file.
- **How it's read**: a key vihko doesn't know is ignored (`unknown_key`); a
  known key with a wrong value is left out, and the rest applies; a file
  that isn't YAML applies nothing. Each problem has a code (those of
  `vihko.yaml`, and `space_guide_note`), where it is and its line, and goes
  to the file's owner as `settings_invalid`. The file is never read through a
  symbolic link (neither `.vihko/` nor `settings.yaml`).
- **Who reads it**: a person's, they alone; a shared space's, its members, to
  apply it. A key never reads or changes a settings file. Nobody gets it as a
  note or a file.
- **How it adds up** with `vihko.yaml`, for each person: daily-note series
  are their own, then those of each shared space they're in, then
  `vihko.yaml`'s, and two that give the same note are one: the closest is
  kept, with its label and template. Only those where they can write today's note are offered, in that
  order (`GET /api/workspace`'s `daily`). The id of a series left out that
  way still works, as the one kept: as `series`, and as `dailySeries`, which
  the next `POST /api/daily` without `series` rewrites to the kept id. With
  no `dailySeries` in the profile, today's note is the first listed in the
  person's own space, and the first `POST /api/daily` (or `daily_note` that
  opens or creates it) without a `series` writes that series' id as the
  profile's `dailySeries`; with none in their own space, it never lands in
  a shared space by itself: `409 series_gone`, so the person chooses. A `dailySeries` that no longer exists
  for the person is `409 series_gone` too, and in both cases nothing is
  created. Templates aren't a setting: every note marked `template: true`
  the person reads is one. New images of a note follow
  its space's `attachments`, otherwise `vihko.yaml`'s. The guides for agents
  come in order: `mcp.instructions`, each shared space the key reaches, the
  person's own.
- **Series ids**: a space's series are offered as `me-<id>` (one's own
  space) or `sp-<8 hex digits>-<id>` (a shared space's, from its root), so
  they never take one of `vihko.yaml`'s: an id in `vihko.yaml` that starts with `me-` or `sp-`, in any case, is `invalid_id`.
  A `dailySeries` in the profile names them that way. A shared space's
  series change id when the space is renamed; a `dailySeries` that named one
  is rewritten to the new id. How the hex digits are made
  isn't covered.

## Environment variables

| Variable | Values |
|---|---|
| `VIHKO_PUBLIC_URL` | An `https://` origin |
| `VIHKO_TRUSTED_PROXIES` | Addresses or CIDR ranges, separated by commas or spaces |
| `VIHKO_INTEGRATIONS` | `off`, or unset. `off` keeps every integration off: the API with keys, the MCP server, and any later release adds |
| `VIHKO_EXTERNAL_IMAGES` | `allow`, `ask` or `block`. Unset: the installation's default, `ask`, kept in `state.db` the first time it starts |
| `VIHKO_MAX_IMAGE_MB` | A number of mebibytes, 20 by default |
| `VIHKO_SECRET_KEY` | A key of 32 characters or more |
| `VIHKO_SECRET_KEY_FILE` | A file holding that key. Not with `VIHKO_SECRET_KEY`: both set, vihko doesn't start |
| `VIHKO_LOG_LEVEL` | `info` (default) or `debug`. What a log line says beyond that isn't covered |
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

The example `compose.yaml` also reads `VIHKO_UID`, `VIHKO_GID` and
`VIHKO_HOST_PORT`. [Installation](install.md#environment-variables) says what
each one does. Other `VIHKO_*` variables in the source code are for tests.

## The Docker image

| What | In 0.1.0 |
|---|---|
| Image | `ghcr.io/kirianm/vihko` |
| Tags | `0.1.0` (never changes), `0.1` (moves forward only), and release candidates under their exact tag only. No `0` or `latest` while vihko is at 0.x: they arrive with 1.0 |
| Platforms | `linux/amd64` and `linux/arm64` |
| Volumes | `/data/notes` (the notes) and `/data/state` (vihko's state) |
| Port | 8080, plain HTTP |
| User | Any `uid:gid` in `user:` that can write both volumes; it needn't be root. Without `user:`, `node` (1000:1000), which owns `/data` in the image |
| Labels | The OCI `title`, `description`, `licenses` (`AGPL-3.0-only`), `version`, `source`, `url`, `revision` and `created`, as labels and annotations |
| Hardening | Runs with a read-only root filesystem, no capabilities (`cap_drop: [ALL]`) and `no-new-privileges` |
| Health check | `GET /api/health` answers `200` while the process serves |
| Required settings | None |
| The command | `vihko` on the `PATH`, run inside the container (`docker compose exec vihko vihko …`, or `run --rm` while vihko is stopped); the image's command is `vihko serve` |

## The command line

[Operations](operations.md#the-command-line) explains each command.

| Command | Arguments and options | Exit status |
|---|---|---|
| `vihko serve`, or `vihko` alone | — | `0` when stopped (`SIGTERM`, `SIGINT`); `1` if it can't start |
| `vihko user create <name> [--admin] [--adopt]` | The password on standard input (one final line break is dropped); the options before or after the name. Creates `people/<name>/` too; with `--adopt`, a folder already there with something in it becomes theirs as it is (renamed to their name if another case spells it) | `0` created; `1` not (the name taken or not valid, a weak password, `personal_folder_exists` without `--adopt`) |
| `vihko user reset-link <name>` | — | `0` with the link; `1` no such user |
| `vihko user reset-2fa <name>` | — | `0` removed, or there was none; `1` no such user |
| `vihko history purge <path> [--version <id>] [--dry-run]` | `--version=<id>` too. Without `--dry-run`, vihko must be stopped | `0` purged, or nothing to purge; `1` not (`state_in_use` while vihko runs) |
| `vihko version`, or `vihko --version` | — | `0`, printing the version alone on one line, without reading any configuration |

A command it doesn't know, or arguments a command doesn't take, print the
usage on standard error and exit with `2`, once the environment has been
read: a `VIHKO_*` variable that isn't valid exits with `1` first (but for
`vihko version`). A failure prints `error: …` or `error (<code>): …` on
standard error; `vihko serve` starts those lines with `[vihko] ` instead. What the commands print for people
isn't covered; `vihko version`'s output is.

## What vihko writes into your notes folder

[Notes and Markdown](notes.md) explains each of these. vihko writes nothing
else into a note unless someone asks it to (an edit, a comment, a
`set_frontmatter`).

| What | Form |
|---|---|
| The two folders | `people/` and `spaces/`, made when vihko starts if they're missing |
| A person's folder | `people/<username>/`, made when the user is created, and again at start if it went missing; renamed with them while their invitation is unused. Empty folders in `people/` with their name in another case are removed when they're created |
| A shared space's folder | `spaces/<name>/`, the space's name as written, made when the space is created, when a folder becomes a space of its own («Move to a new space»), when a deleted person's space is converted into a shared one, or when a deleted space is restored (with its folders); renamed with the space |
| A deleted person's space, transferred | Moved to `people/<recipient>/<their username>/`, or the first free `-<n>` after that name |
| A shared space's members | `permissions.<root>.grants` in `vihko.yaml` |
| Settings of a person or a space | `<space root>/.vihko/settings.yaml`, written when someone saves them in the UI: atomically, only the keys that changed (a `version` that isn't valid becomes 1), `version` added first when missing; comments and key order stay, the spacing and quoting of the rest of the file may not |
| The note's identity | `uid: <id>` in the frontmatter, added only when vihko writes the note anyway: created, edited or moved from vihko. vihko writes a ULID today and reads any text or number as a `uid` |
| An alias after a rename | The old name added to `aliases`, only when a link to the note from its own space couldn't be rewritten and `links.aliases` is on |
| Frontmatter changes | Only that key's value, in place; a new key at the end of the block; a note without frontmatter gets a block at the top. The rest stays byte for byte |
| Templates | `template: true` in the frontmatter when someone makes a note a template, or marks a folder's notes as templates; the key removed when they stop it being one. A note created from a template gets the template's text and frontmatter without that key and without `aliases`, and with a new `uid` when the template has one (the rest, `ai` included, byte for byte), its variables filled in |
| Comments | `<!-- @author YYYY-MM-DDTHH:MMZ · text -->`; a reply starts its text with `↳ `; comments one after another are a thread; resolving a thread deletes it |
| Links kept when a name is taken | When someone creates, restores or renames a note (or gives it an alias) that would make a link in a note they can't read lead elsewhere, vihko rewrites that link as after a move, so it keeps leading to its note |
| Links rewritten after a move | Only inside a space: the link keeps its destination. A wikilink gets a name or path that reaches the note without ambiguity, keeping its `#heading` and `\|text` (with the note's name as text when only the path from the notes root reaches it, for someone who sees only part of the space). A Markdown link gets a path relative to the note, percent-encoded as image links are. vihko never writes a link to another space: when a note or a folder changes space, nothing is rewritten across spaces |
| Links in tables | Inside a table row, the `\|` of a wikilink vihko writes is escaped as `\\|`, as Obsidian does, and stays so |
| Image links | `![alt](path)`, relative to the note, with spaces, brackets, parentheses, `%`, `#`, `?`, `<`, `>` and `\` percent-encoded |
| Where new images go | As `attachments` says, inside the note's space. A new image never takes a name already in use; the form of its name isn't covered |
| Moved images | Images only one note uses go with it when it changes folder. When it changes space, the images it shares with other notes are copied to the new space, and its links point to the copies |
| Retired settings keys, at start | A key vihko retired from `vihko.yaml` or a `.vihko/settings.yaml` is migrated when vihko starts, once: what it asked for is done in the notes, then the key is removed from the file (the rest of it byte for byte, comments and order included; a comment right above it stays), and whom the file belongs to gets `settings_migrated`. A file that can't be rewritten keeps the key, and the next start tries again |
| A deleted folder | Everything in it goes to the trash, its hidden folders (`.git/`, `.obsidian/`, `.vihko/`…) included, and restoring it puts them back; only a symbolic link in it stops it. Operating systems' clutter (`.DS_Store` and the like) is removed |
| A saved copy of an external image | «Save a copy» on an image of a note stores it as an upload does and replaces that image's destination with the copy's relative path, its alt text kept |

What vihko reads in your notes stays too: the frontmatter keys `uid`,
`title`, `tags`, `aliases`, `ai` (`ai: false` hides a note from agents) and
`template` (`template: true`, a YAML true, makes a note a template: offered
when creating a note, left out of search unless asked for, of tags and of
Home), every other key's simple values for searching,
`#tags`, both kinds of links (`[[a\|b]]` in a table included), files named
by an `![[…]]` or `[[…]]` with an extension (relative to the note, or by name
in its space), and the files it ignores (names starting with `.` or ending
in `~`, symbolic links but `vihko.yaml`, and copies Syncthing makes on a
conflict, `*.sync-conflict-…`, which vihko flags with `sync_conflict`).

How a link resolves is the same for everyone who reads it, and a link never
leads to another space, in any form: a wikilink whose first segment is
`people` or `spaces` is a path from the notes root; a Markdown link is an
exact path from the note's folder; a link or an image that starts with `/`
(`[[/path]]`, `[t](/path.md)`, `![](/path.png)`) is an exact path from the
root of the note's space, or from the notes root when its
first segment is `people` or `spaces`; each leads to a note only when that
note is in the link's own space. Any other wikilink is searched only among the notes
of its own space, by name and path, then by aliases of that space. An alias
that several notes of the space share is ambiguous. A link to another space
is broken, as a link to a note that doesn't exist.

## OAuth

OAuth exists while `VIHKO_PUBLIC_URL` is set and the MCP server is on;
otherwise every address below answers `404`.

| Address | What it is |
|---|---|
| `GET /.well-known/oauth-protected-resource/mcp` (and without `/mcp`) | Resource metadata (RFC 9728): `resource` (`<public URL>/mcp`), `authorization_servers`, `bearer_methods_supported`, `resource_name` |
| `GET /.well-known/oauth-authorization-server` | Server metadata (RFC 8414) |
| `POST /oauth/register` | Dynamic client registration (RFC 7591), only while the admin allows it (off by default). 5 registrations an hour from one address, and a cap on apps registered but never authorized (forgotten after a day): over either, `429 temporarily_unavailable` with `Retry-After` |
| `GET /oauth/authorize` | Where the person approves the app (a member only while the admin lets members have keys; approving is confirmed with their code or password). Asked for JSON, or with no UI, a request that can't go on answers `400` with `error` (`invalid_client`, `invalid_redirect_uri`, `client_not_allowed`, `invalid_client_metadata`…) |
| `POST /oauth/token` | Codes and refresh tokens. Each is used once: a second use of a code or a refresh token revokes every token that came from it |
| `POST /oauth/revoke` | Token revocation (RFC 7009) |

The server metadata offers the authorization code flow with PKCE (`S256`
only) and refresh tokens, the `query` response mode, the `iss` parameter in
the response, client authentication `none`, `client_secret_post` or
`client_secret_basic`, and clients that identify themselves with a metadata
document URL. A client must list `authorization_code` among its `grant_types`
and `code` among its `response_types` when it gives them; other grants it
lists are ignored. `registration_endpoint` is listed only while registration
is on. Tokens are opaque: read `expires_in`. A `resource` (RFC 8707), on
`authorize` or `token`, must be `<public URL>/mcp`: anything else is
`invalid_target`. The bodies of `register`, `token` and `revoke` take up to
64 KiB (`413` beyond).

## Known limits

- **A refused name looks like a taken one.** When creating, restoring,
  renaming or moving a note, or giving it an alias by an edit (in the
  editor, or by the API or MCP),
  would make an existing link lead to a note the person can't read (or make
  it ambiguous), what happens depends on where that link is. In a note the
  person reads, vihko refuses with the same answer as a taken name: `409
  exists` (`412 precondition_failed` with `If-None-Match: *`). In a note they
  can't read, it goes through, and vihko rewrites that link as the system so
  it keeps leading to its note (history reason `links_kept`), without saying
  so. A dry run doesn't check: its preview leaves out the rewrite that would
  name the hidden note, and the refusal comes when the move is made. A
  client can only tell a refusal from a taken name by reading the path
  afterwards: a taken name has a note there that the person can read; a
  refused one has none. An alias typed in the editor goes through the
  same check when the note is saved: one refused is taken out of the note
  before it is written, and whoever typed it is told.
- **Editing a folder shared from someone's space lets you work out names in
  the rest of it.** A link by name resolves among all the notes of its space,
  and one to a note you can't read looks broken. So whoever edits a folder
  shared from someone's own space can write an alias and a link, and learn
  from whether the link resolves whether the owner has a note by that name
  elsewhere in their space. It takes `edit` there (with `read` or `comment`
  it can't be done), and the share dialog says so when giving `edit`. What
  must stay private goes in another space.
- **Transferring a deleted person's space can mend broken links.** When the
  admin transfers the space of someone deleted to another person, a link by
  name in that space that was broken may start leading to a note of the
  receiving person with that name, since both are now in one space. The
  transfer dialog says so.
- **Held notes.** A note held after a move made outside vihko answers `409
  exists` to a move over it while the hold lasts.
- **Agents learn that hidden notes exist** when they name one their person
  reads (`agent_denied`), so they leave it alone. That is on purpose.

## What isn't covered

These can change in any release:

- **The web UI**: its screens, its keyboard shortcuts, and its URLs, other
  than those the guides tell you to use (`/mcp`, the invitation links).
- **Routes a key can't call**, including the [routes for the web
  UI](#routes-for-the-web-ui) above, and the UI's own fields on the routes
  open to keys. Only `/api/health` and `/api/setup` are covered among them.
- **The databases**: the tables of `state.db` and `index.db`. vihko migrates
  `state.db` on its own; `index.db` is rebuilt from the notes.
- **The files in the state volume**, their names and their layout: the
  history repository, the trash, the editor's recovery files, the lock,
  `retention.json`.
- **Log lines** and every text meant for people: error `message`s, the MCP
  server's instructions, tool descriptions.
- **Timings**: how long a version waits to be saved, how often vihko rescans,
  how long a token or a session lasts, how far back resolved comment threads
  are listed (30 days in 0.1.0).
- **How search ranks and quotes.**
- **Running from source**: the Node.js version it needs, the npm scripts and
  the repository's layout. `VIHKO_WEB_DIR` stays.
- **Short-lived files** vihko writes next to a note to make a write atomic
  (hidden names such as `.plan.md.vihko-…`), and the hidden folders it
  makes in `people/` for a moment while a person's folder is renamed or
  adopted (`.renaming-…`, `.adopting-…`).
