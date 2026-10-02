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
  - `people/` and `spaces/` are fixed. A shared space's folder is its name
    (since 0.1.0-rc.3): renaming the space renames its folder.
  - A username is permanent: it is the name of the person's folder and part
    of every link into it.
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
| `people/<username>/…` | A person's own space («My notes» in the UI). `<username>` is the person's username as it was created; it never changes |
| `spaces/<name>/…` | A shared space, such as `spaces/Home/`. The folder is the space's name as it was written (in NFC), and renaming the space renames it |
| `people/<username>/.vihko/`, `spaces/<name>/.vihko/` | The settings of that person or space (since 0.1.0-rc.3, `settings.yaml`: see [Settings of a person or a space](#settings-of-a-person-or-a-space)), never notes. Hidden, like every name that starts with a dot, and refused as a note or folder in any case (`invalid_path`). A person's doesn't come along when their space becomes a shared one |
| `vihko.yaml` | The workspace configuration, at the root. Nobody sees it in vihko |
| Anything else | In no space: nobody sees it in vihko, and the admins get the `outside_spaces` alert |

- `people` and `spaces` are fixed names. Nothing can be created at the root of
  the notes folder, or directly in `people/` or `spaces/`: a request that
  tries gets `400 outside_space`. A space's root is never created, renamed,
  moved or deleted as a folder: `400 space_root` (a shared space is deleted as
  a space; see below).
- Any folder in `spaces/` is a shared space, but one whose name starts with
  `.` or `~`, ends with `.`, `~` or `.md`, or is `people` or `spaces` in any
  case: those are in no space. One made on the disk has no members until the
  admin assigns a manager.
- A folder in `people/` named after no user (active, disabled or deleted) is
  seen by nobody, and the admins get `person_folder_without_user`.
- **A shared space's name is unique in the installation**, without regard to
  case, and it is not secret: everyone who can sign in can learn that a name
  is taken (creating a space with it answers `space_name_taken`), and the
  admin's directory lists every shared space by name. What a space holds and
  who is in it stay private. A name can't hold `/` or `\`, start with `.` or
  `~`, end with `.`, `~` or `.md`, or be `people` or `spaces`.
- Shared spaces made by 0.1.0-rc.1 or rc.2 were `spaces/<readable>-<id>/`,
  with their name in `vihko.yaml` (`name`). Each start renames such a folder
  to its name (or, when the name can't be a folder's, to its readable part)
  as a rename from vihko would, and removes `name`; when another space or
  folder has that name, it's left as it is and the admins get
  `space_not_renamed` until a start can.
- The UI never shows `people/` nor `spaces/`. A note's address in the
  browser is `?note=<address>`, the same for everyone who can open it: a
  shared space by its name (`?note=Home/plan.md`), a person's space by `~`
  and the username (`?note=~ana/trips/Rome.md`). An address with the path
  from the notes root (as vihko wrote it before 0.1.0-rc.2) still opens the
  note and is replaced by the new form, and so does one of a space renamed
  from rc.1 or rc.2 (`?note=home-7k2q9x/plan.md`), for whoever is in it.
  Other query parameters (`view`, `version`) may be added; addresses of
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
| Key format | Starts with `vihko_`; the rest is opaque (in 0.1.0, a 26-character id, `_` and a 43-character secret) |
| The API switch off | Every request with a key answers `404 not_found` |
| A route not open to keys | `404 not_found` |
| A read-only key on a route that writes | `403 forbidden` |
| Bodies | JSON, except image uploads (raw bytes) and file downloads |
| Field names | `camelCase`, in requests and answers |
| Note paths | From the notes root, with `.md`, inside a space: `spaces/home-7k2q9x/plan.md` |
| Dates | ISO 8601, UTC |
| A note's ETag | `sha256:<hex>` of its text, in the body and in the `ETag` header (quoted) |
| Cursors | `next`, passed back as `cursor`: opaque (encrypted), valid until vihko restarts |
| Conditional writes | `If-Match` (quoted or bare), `ifMatch` in the body where a route takes it, `If-None-Match: *` on `PUT /api/note` |
| Errors | `{ "error": <code>, "message": <hint> }`, with `etag` on `precondition_failed`, `reason` on `agent_denied`, `audience` on `audience_widens`, `path` on an `exists` that names the disk's spelling, `movedTo` on a `not_found` for a note vihko moved from there in the last two minutes (only to whoever reads it where it went), `contents` on `not_empty`, `group` on `leave_via_group`, `retryAfter` on `too_many_attempts`; `Retry-After` on `429` |
| What the key's person can't read | `404 not_found`, the same whether it exists or not |
| What the person reads but is hidden from agents | `403 agent_denied` with `reason`: `ai_false` (the note or a folder above it is closed to agents) or `outside_key_folders` |
| A write that hides the note from the key | Succeeds, and adds `nowHidden: true`, `reason` and `message` |

### Routes open to keys

"Key" says which keys may call the route: any key (read) or a key that may
write (write).

| Method and path | Key | Request | Response |
|---|---|---|---|
| `GET /api/tree` | read | — | `notes` (`path`, `title`, `uid`, `aliases`, and `template: true` for a template, since 0.1.0-rc.5), `folders`, `pathOnly` |
| `GET /api/spaces` | read | — | `personal` (`path`, or null when the key doesn't reach it), `spaces` (`path`, `name`, `level`, `managers`, `aiClosed`), `shared` (`path`, `level`, `pinned`, and `owner` in a personal space or `space` with `path`, `name`), `canCreate` (always false for a key). A shared space's `name` is its folder's |
| `GET /api/spaces/members` | read | `path` (a folder) | `path`, `space` (`path`, `name`, or null in a personal space), `owner` (or null in a shared space), `members` (`username`, `level`, `via`: `subject`, `level`, `from` (null where the asker doesn't read that folder), and `owner: true` for a person's own space) |
| `GET /api/note` | read | `path` | `path`, `text`, `etag`, `meta` (`title`, `uid`, `fmError`, or null), `hiddenFromAgents` |
| `GET /api/note/links` | read | `path` | `outgoing` (`raw`, `kind`, `target`, `anchor`, `status`, `dstPath`, `anchorOk`, `candidates`, `posFrom`, and `othersNoAccess`, `reason`, `self` when they apply; `file`, since 0.1.0-rc.6, when a wikilink with no note of its name leads to a file of the space, `[[invoice.pdf]]`: `dstPath` is the file), `backlinks` (`path`, `title`, `raw`, `context`), `titles` |
| `GET /api/note/headings` | read | `path` | `headings` (`level`, `text`) |
| `GET /api/note/comments` | read | `path` | `threads` (`id`, `original`, `changed`) |
| `GET /api/search` | read | `q` | `results` (`path`, `title`, `snippet`), `highlight` (`start`, `end`). The query's filters are under [Search filters](#search-filters) |
| `GET /api/tags` | read | — | `tags` (`tag`, `count`, `total`) |
| `GET /api/daily` | read | `series`? | `series`, `path`, `exists` |
| `GET /api/file` | read | `path`, or `note` and `name` (0.1.0-rc.6) | The file's bytes, with its `Content-Type` and an opaque `ETag`. With `note` and `name`, the file as that note names it (`![[photo.png]]`): relative to the note, or by name among the files of its space, the nearest winning, a tie or another space `404`. `Content-Disposition: inline` for images (not SVG) and PDFs, `attachment` for anything else |
| `POST /api/note` | write | `path`, and `text` or `template` (any note the key reads; its frontmatter is copied without `template: true` and `aliases`) | `201`: `path`, `uid`, `etag` |
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
| `POST /api/history/restore` | write | `path`, `id`, `ifMatch`? | `etag`, `images` (`restored`, `missing`) |
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
  took the name, or null where the reader can't read it) and `by`. A space
  of 0.1.0-rc.1 or rc.2 renamed to its name when vihko started has the
  reason `space_renamed`, with `from` and `to` (its roots).
- **Edits by operation**: `append` (`text`), `append_under_heading`
  (`heading`, `text`), `find_replace` (`find`, `replace`, `expectedCount`),
  `replace_section` (`heading`, `text`) and `set_frontmatter` (`key`,
  `value`). The last three need the ETag. An edit has 1 to 50 of them; one
  that isn't well formed (an unknown `op`, a field missing or of the wrong
  type, `set_frontmatter` on `uid`) is `400 invalid`, and one that doesn't fit
  the text is `409 edit_mismatch`.
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
| `forbidden` | 403 | A read-only key on a route that writes, or something the key's person may not do there |
| `agent_denied` | 403 | Hidden from agents; `reason` says why |
| `not_found` | 404 | No such note, folder, version or route, or one the key's person can't read |
| `invalid` | 400 (413 for a body over the limit) | A body or parameter that isn't valid |
| `invalid_path` | 400 | Not a valid note or folder path |
| `control_characters` | 400 | A path with a control character |
| `outside_space` | 400 | Creating or moving something where no space is: the notes root, `people/`, `spaces/`, or anything in no space |
| `space_root` | 400 | A space's root named as a folder to create, rename, move or delete |
| `exists` | 409 | The name is taken, or isn't available there (see [Known limits](#known-limits)) |
| `edit_mismatch` | 409 | An edit operation doesn't fit the text |
| `not_configured` | 409 | The daily note, with no series for the person |
| `series_gone` | 409 | The daily note without `series`, when the series the person chose (`dailySeries`) no longer exists for them: they choose another (0.1.0-rc.6) |
| `audience_widens` | 409 | A move would show the note to someone who can't see it now |
| `not_revertible` | 409 | Reverting a version that creates or deletes the note |
| `history_off` | 409 | The history is off |
| `too_large` | 413 | An image over the size limit |
| `unsupported_type` | 415 | Not an image type vihko stores |
| `busy` | 429 | Too many images received at once |
| `precondition_required` | 428 | A write without the `If-Match` it needs |
| `precondition_failed` | 412 | The note changed since that ETag, or `If-None-Match: *` over a name that is taken or not available |
| `history_unavailable` | 503 | The history can't be read right now |
| `internal` | 500 | Something went wrong in vihko |

Creating the first admin adds `invalid_token`, `invalid_username` and
`weak_password` (400), `already_setup` and `personal_folder_exists` (409), and
`too_many_attempts` (429).

### Limits

| What | 0.1.0 |
|---|---|
| Request body | 20 MiB |
| Image upload | `VIHKO_MAX_IMAGE_MB`, 20 MB by default |
| Images received at once | 2 per person, 8 in all |
| Search results | 50 with words, 500 with filters alone |
| History pages for a key | 50 |

### Routes for the web UI

The routes below need a signed-in session and answer `404` to a key. They're
listed because 0.1.0 added or changed them for spaces; like every route a key
can't call, they can change in any release.

| Method and path | Who | Request | Response, and codes of its own |
|---|---|---|---|
| `POST /api/spaces` | Anyone, or only admins with the setting `spacesCreation: admins` (`403 forbidden` otherwise) | `name`, `members`? (`{ "<user>" or "@<group>": level }`) | `201`: `space` (as in `GET /api/spaces`), at `spaces/<name>`. The creator manages it. `409 space_name_taken` with `name` (as the other space writes it) when a space has that name in any case; `400 invalid` with `problem` for a name that can't be a space's folder (`empty`, `too_long`, `control_characters`, `spaces_around`, `invalid_characters`, `invalid_name`) |
| `POST /api/spaces/from-folder` | `manage` in the folder and `edit` in its parent, and who may create spaces | `path` (a folder inside a space), `name`? (the folder's own by default), `dryRun`? | A dry run: `report` (the folder move's, with `audience`). Otherwise `201`: `space` (as in `GET /api/spaces`), `report`. The folder becomes a shared space of its own, `spaces/<name>`: what it holds goes to the new space's root, with the folder's own grants and its mover managing it. `400 space_root` for a space's root; `409 space_name_taken` (in a dry run too) and `400 invalid` as for `POST /api/spaces` |
| `POST /api/spaces/rename` | `manage` at the space's root | `path`, `name` | `space`, at its new path. Its folder becomes `spaces/<name>` with everything in it, its rules, and the keys, pins, notices and trash entries that named it; links don't change. Another case of its own name renames it too. `409 space_name_taken` and `400 invalid` as for `POST /api/spaces` |
| `DELETE /api/spaces` | `manage` at the space's root | `path`, `trash`? (query) | `path`. With `trash=true`, what it holds goes to the trash, which its managers keep seeing; otherwise only an empty space goes (`409 not_empty`) |
| `POST /api/spaces/leave` | A grant of one's own there | `path` | `path`. One's own grants there and below go; nothing is deleted. `409 leave_via_group` with `group` when it comes through a group; `400 invalid` for one's own space, or a grant from a folder above |
| `POST /api/spaces/pin` | What is shared with one | `path`, `pinned` | `path`, `pinned` |
| `GET /api/admin/spaces` | The vihko admin | — | `spaces` (`path`, `name`, `managers`, `members` (a count), `aiClosed`), `closed` (`userId`, `username`, `path`: the spaces of deleted people) |
| `POST /api/admin/spaces/managers` | The vihko admin, confirmed at the moment | `path`, `userId`, `confirm` | `space`. Only for a space without managers: `409 space_has_managers` otherwise |
| `POST /api/admin/spaces/join` | The vihko admin, confirmed at the moment | `path`, `level`? (`read` by default), `confirm` | `space` |
| `GET /api/admin/users/:id/space` | The vihko admin | — | `path`, `exists`, `sharedFolders`, `people` (counts) |
| `POST /api/admin/users/:id/space` | The vihko admin, confirmed at the moment | `action` (`transfer`, `convert` or `delete`), `to` (a user id, for `transfer`), `name` and `members` (for `convert`), `dryRun`?, `confirm`, `deleteUser`? | `plan` (`action`, `from`, `to`, `notes`, `files`, `sharedFolders`, `people`). `400 space_needs_manager` when a conversion names nobody who manages it. A transfer goes to `people/<recipient>/<deleted username>`, or, if that name is taken there, the first free `-<n>` after it, found only when it moves (a dry run never looks into the recipient's space). With `deleteUser: true`, the person is disabled but not deleted yet: what is asked (a transfer or a conversion) is checked and confirmed, then they're deleted and their space settled |
| `GET /api/permissions` | `manage` in the folder | `folder` | `folder`, `etag` (of `vihko.yaml`), `section` (`none`, `rules` or `closed`), `own` (`grants`), `inherited` (`from`, `grants`: every folder above it in its space with grants), `owner`, `space` (`path`, `name`), `ai` (`closed`, `from`), `canEdit`, `access` (who has access, and why) |
| `PUT /api/permissions` | `manage` in the folder | `folder`, `grants`? (or null), `ai`? (`false` or null), `ifMatch` | As `GET`; `412` when `vihko.yaml` changed; `400 invalid` for grants at a personal space's root |
| `GET /api/permissions/folders` | Anyone | — | `folders` (`path`, `level`, `ownGrants`, `aiClosed`, `canEdit`): only what the asker sees |
| `POST /api/permissions/holds/:id` | Who could have made that move from vihko | `action: "release"` | `ok` |
| `POST /api/folder` | `edit` in the parent | `path` | `201`: `path`. `outside_space`, `space_root` |
| `POST /api/folder/templates` | `edit` in it | `path` (a folder), `dryRun`? | Since 0.1.0-rc.5: `marked`, `already`, `skipped` (counts, of the notes in the folder and below: those it marks, or would mark, with `template: true`; those already marked; those whose frontmatter can't be read). Each is written as any edit of that note. `404 not_found` for a folder the person doesn't see |
| `POST /api/note/template` | `edit` where the note is | `path`, `template` (`true` or `false`) | Since 0.1.0-rc.5: `etag`. `true` sets `template: true`, `false` removes the key; nothing else of the note changes |
| `POST /api/folder/move` | `manage` in it and `edit` in both parents | `from`, `to`, `dryRun`?, `background`? | The folder move's report, with `images.copied` when it changes space. The root of a folder someone shares with you is only theirs to move |
| `DELETE /api/folder` | `manage` in it | `path`, `trash`?, `dryRun`? | `path`, `trashed`. `409 held_inside` while notes held after a move made outside vihko are in it. `409 not_empty`'s `contents`: `notes`, `files`, `hidden` (its hidden folders, which go to the trash with it since 0.1.0-rc.6: `total`, `paths`, and `files`, how many files they hold) and `kept` (symbolic links, which stop it). With `dryRun=true` (0.1.0-rc.6) nothing is deleted: `path` and `contents`, with the same checks |
| `GET /api/home` | Anyone | — | «Home» (0.1.0-rc.3): `recent` (`path`, `title`, `at`: notes the person changed lately; without a history, those of their own space changed last), `changed` (the same and `by`: what others changed lately in notes the person reads; `by` (`kind` `user`, `agent` or `external`, `name`, `onBehalfOf`) only where they may see the history, null elsewhere), `shared` (`kind` `space` or `folder`, `path`, `name`, `owner`, `by`, `at`: what was shared with them in the last 30 days, while they see it). At most 8 each; nothing the person can't read |
| `GET /api/events` | Anyone | — | A server-sent event stream (0.1.0-rc.3): `ready` when it opens, then `tree` (data `{}`) whenever a change concerns what the person sees: a note made, renamed, moved or deleted where they read, a folder made or gone there, or what they reach (their spaces, what is shared with them, their levels) changed. It never says what changed. A comment keeps it open every 25 s |
| `GET/PUT /api/profile` | Anyone, their own | `timezone`?, `dailySeries`?, `onOpen`? (`home`, `last`, `note` or `daily`), `onOpenNote`? (a note's path, with `note`), `language`?; `openDailyOnStart`? (deprecated: `true` is `onOpen: daily`) | `timezone`, `dailySeries`, `onOpen`, `onOpenNote`, `openDailyOnStart` (deprecated: `onOpen` is `daily`), `language`. `onOpen: note` names only a note the person reads: `404 not_found` otherwise, and one they no longer read comes back as `home` |
| `GET /api/trash` | Anyone | — | `entries`, each with `space` (its space's root, or null) |
| `POST /api/trash/:id/restore` | Where the entry was | `to`? | `path`, `etag`, `files`, `left`: what stayed in the trash, only where the person reads |
| `GET /api/keys` | Anyone | `all=1` (the vihko admin: everyone's) | `keys`; with `all=1`, each with `user`, and `foldersHidden` when someone else's key reaches folders the admin doesn't read (those aren't listed in `folders`) |
| `POST /api/history/purge` | Whoever manages the note's folder; the vihko admin, any path | `path`, `version`?, `dryRun`?, `confirm` | `path`, `version`, `dryRun`, `versions`, `filesRemoved`, `onDisk`, `sharedWith`, `movedFrom`, `confirmRequired`. The admin's dry run of a path they can't read answers `hidden: true` with nothing of it (no versions, nothing on the disk), whether it exists or not |
| `GET /api/history/purgeable` | Anyone signed in (never a key) | — | `paths`: `{ path, deleted }` for each file the managed history holds versions of that the person may purge and reads now (whoever manages a folder, its notes; the vihko admin, any file they read); `deleted` when its last version deletes it. Empty in any other history mode. A path the person can't read is never listed |
| `POST /api/admin/rescan` | The vihko admin | `force`?, `confirmRemoval`? | Counts only: `added`, `changed`, `removed`, `moved`, `unchanged`, `aborted`, `massDelete` |
| `GET /api/move-jobs/:id` | Whoever started the move | — | `done` and `total` count only the notes the person reads |
| `GET/PUT /api/admin/settings` | The vihko admin | `spacesCreation`? (`everyone` or `admins`), `trashRetentionDays`?, `historyRetentionDays`? (a whole number of days, 1 to 36500, or null: off), `confirm`? | The settings, with `spacesCreation`, `trashRetentionDays` and `historyRetentionDays` (null by default). Turning a retention period on or shortening it needs `confirm` (`400 confirmation_required` without it); a longer one, or null, doesn't |
| `GET /api/workspace` | Anyone | — | `daily`: the series the person can write today's note in, from `vihko.yaml`, their shared spaces' settings and their own (0.1.0-rc.3); `links` (`aliases`). No `templates` since 0.1.0-rc.5: templates are marked in the notes (`GET /api/tree`) |
| `GET /api/settings` | One's own; a shared space's members | `space`? (a shared space's root; one's own space when left out) | Since 0.1.0-rc.3: `space` (the root), `etag`, `settings` (`version`, `daily` (`id`, `label`, `folder`, `name`, `template`), `attachments` (`mode`, and `folder` or `suffix`; null: as `vihko.yaml` says), `agents`; paths relative to the space), `errors` (what is wrong in the file: `code`, `at`, `line`, `detail`), `guideMissing` (since 0.1.0-rc.4: `agents` names a note that doesn't exist), `canEdit` (oneself, or a manager). `404 not_found` for a space the person isn't in, or anything that isn't a space's root |
| `PUT /api/settings` | One's own; a shared space's managers | `space`?, `settings` (as `GET` gives them), `ifMatch` | As `GET`. `400 invalid` with `errors` (nothing written), `428 precondition_required` without `ifMatch`, `412 precondition_failed` when the file changed, `403 forbidden` for a member who doesn't manage the space |
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
| `<key>:<value>` | Since 0.1.0-rc.5. Notes whose frontmatter has that top-level key with that value, for any key that starts with a letter or `_` (then letters, digits, `_`, `.`, `-`) and isn't a reserved name (below). A value that starts with `//` isn't one (an address stays a word) |
| `prop:<key>=<value>` | Since 0.1.0-rc.5. The same, for any key at all, a reserved name included |
| `prop:<key>` | Since 0.1.0-rc.5. With no value: notes whose frontmatter has that key, with any value or none |

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
- Keys and values compare case-insensitively (full case folding, NFC), whole.
  A list matches when any of its items does. A number matches the same number
  however it's written (`5`, `5.0`). Only simple values are searched: text,
  numbers, `true`/`false`, dates (as written) and lists of them; a key whose
  value is a map isn't.
- Templates (`template: true`) are left out unless a filter on `template`
  that doesn't exclude asks for them (`template:true`, `prop:template`).
- Only notes the principal reads are ever searched or counted.

A new user (`POST /api/admin/users`, `vihko user create`) gets their folder,
`people/<username>/`; when that folder already exists with something in it,
creating the user is refused with `409 personal_folder_exists`.

### Alerts and notices

`GET /api/alerts` (the UI's) answers codes with their data, never text. The
codes 0.1.0 added for spaces:

| Code | Who sees it | What it says |
|---|---|---|
| `outside_spaces` | Admins | `paths`: top-level names, and folders in `spaces/` that aren't a space, that nobody sees; `into`: the admin's own space (`people/<admin>`), where they can move them on the disk. Also a `config_warnings` entry for a `vihko.yaml` path outside the spaces |
| `closed_spaces` | Admins | `people`: usernames of deleted people whose space nobody has decided about yet (transferred, made a shared space or deleted) |
| `person_folder_without_user` | Admins | `names`: folders in `people/` named after no user |
| `space_without_members` | Admins | `path`, `name`: a shared space nobody has access to |
| `space_without_managers` | Admins | `path`, `name`: a shared space with members but nobody who manages it |
| `space_not_renamed` | Admins | `path`, `name` (its folder now) and `wanted` (its name in 0.1.0-rc.1 or rc.2): a space vihko couldn't rename to its name when it started, because another space or folder has it. Each start tries again |
| `missing_folder` | Whoever manages the space | `folders`: grants in `vihko.yaml` for folders that don't exist. Never the admin as such |
| `permissions_held` | Who could have made that move from vihko | `id`, `folder`, `notes` (a count): notes held after a move made outside vihko |
| `shared_with_you` | The person added | `kind` (`space` or `folder`), `by`, `path`, `name`, `owner`, `space`: someone added them to a space or shared a folder with them. Names and path only while they can still see it |
| `space_changed` | The people concerned, and the other admins | `change` (`manager_assigned`, `admin_joined`, `personal_transferred`, `personal_converted`, `personal_deleted`), `by`, `user`, `to`, `space` |
| `links_not_updated` | Whoever made the move | Links in other notes a move of theirs couldn't update, even retried. No path, name or count |
| `settings_invalid` | The person, for their own settings; a shared space's managers, for the space's. Never the admin as such | `space` (null for one's own; otherwise `path` and `name`), `errors` (`code`, `at`, `line`, `detail`): what is wrong in a settings file (0.1.0-rc.3) |
| `settings_guide_missing` | As `settings_invalid` | `space` (always null since 0.1.0-rc.6: a shared space's guide is text), `note`: a person's settings name a guide for agents (`agents`) that isn't a note, so agents get nothing from it (0.1.0-rc.4) |
| `retention_ran` | Every admin | `trashEntries`, `versions`, `failed`: what a retention run (weekly, or «Run now») removed (or that it failed part way). Counts only |

`history_purged` names the path only to an admin who can read where it was,
or who purged it; to the others, `path` is null.

## The MCP server

The [Agents guide](agents.md) explains how to connect.

### The endpoint

| What | In 0.1.0 |
|---|---|
| Address | `/mcp`, on the same address and port as the UI |
| Transport | Streamable HTTP, without sessions: a client needs only `POST`. `GET` and `DELETE` answer `405` |
| Protocol versions | Those of the MCP specification the server offers: in 0.1.0, 2026-07-28 and the 2024 and 2025 revisions |
| Credential | `Authorization: Bearer` with a key, or an OAuth access token (see [OAuth](#oauth)) |
| The MCP switch off | `404`, whatever the request |
| No credential, or a wrong one | `401`, with a `WWW-Authenticate: Bearer` challenge (naming the resource metadata while OAuth exists) |
| An `Origin` that isn't vihko's own | `403` with a key; with an OAuth access token, accepted from the origin of one of its app's redirect URIs and `403` from any other; without a valid credential, the `401` above |
| Request size | Up to 4 MiB (`413` beyond it): an image of about 3 MB for `attach_image` |

### Conventions

- Paths are from the notes root, with `.md`, inside a space, as over HTTP.
- Parameters are `snake_case`. `camelCase` is accepted too, and so are these
  other names: `note`, `file` and `note_path` for `path`; `etag` for
  `if_match`; `q` for `query`; `source` and `destination` for `from` and `to`;
  `id` for `version`.
- A result's first block is its data as JSON, between `<data-…>` markers. A
  note's text comes in a block of its own, between `<note-…>` markers. Both
  markers carry a random tag. The same data may also come as
  `structuredContent`.
- An error is a result with `isError`, whose text is JSON: `error` (a code),
  `message`, and as they apply `etag`, `hint`, `reason` and `audience`. The
  codes are those of the HTTP API. Arguments that don't fit a tool's schema
  are `invalid`.
- Results are `snake_case`. Lists are paged: pass `next_offset` back as
  `offset`, or `next` as `cursor`.
- A write that hides the note from the agent succeeds and adds `now_hidden:
  true`, `reason` and `message`.
- A read-only key is offered only the reading tools; calling a writing tool
  answers `forbidden`.
- Agents don't create, rename, delete or leave spaces, share folders, or move
  folders: those are for people, in the UI.

### Reading tools

| Tool | Parameters | Result |
|---|---|---|
| `search` | `query` (required; the filters of [Search filters](#search-filters)), `limit` (1 to 50, 20), `offset` (0) | `results` (`path`, `title`, `snippet`), `next_offset` |
| `get_note` | `path` or `uid`, `offset` (0), `max_chars` (1,000 to 200,000; 100,000) | `path`, `etag`, `title`, `uid`, `frontmatter`, `links` (`outgoing`: `link`, `target`, `anchor`, `status`, `path`, `candidates`, and `others_no_access`, `reason` when they apply, `file` (0.1.0-rc.6) for a link that leads to a file that isn't a note; `incoming`: `path`, `title`, `count`; `more`), `text` (`offset`, `length`, `total`, `next_offset`); the text as a block |
| `list_folder` | `folder` (`""`, the default, or a folder), `recursive` (false), `limit` (1 to 500, 100), `offset` (0) | `folder`, `entries` (`kind` `folder` with `path`, or `note` with `path` and `title`), `next_offset`. With `""`, the roots the person reaches (below) |
| `related` | `path` (required), `limit` (1 to 200, 50), `offset` (0) | `path`, `links_to`, `linked_from`, `next_offset` |
| `resolve_link` | `from`, `link` (required) | `from`, `link`, `target`, `anchor`, `status`, `path`, `title`, `anchor_found`, `candidates`, and `others_no_access`, `reason` when they apply |
| `changes_since` | `path`, `since` (an ETag or a version id; required), `wait_seconds` (0 to 30, 0), `include_text` (false) | `path`, `etag`, `changed`; when changed, `words`, `changes` and `truncated`, or `base_known: false` with the whole text |
| `history` | `path` (required), `version`, `include_text` (false), `cursor`, `limit` (1 to 20, 10) | `path`, `versions`, `next`; with `version`: `path`, `version`, `at`, `change`, `words`, `changes`, `truncated` |
| `daily_note` | `series` | `series`, `path`, `exists`, and `etag` with the text as a block when it exists |

**`list_folder` with `""`** lists, first, one entry per root the person
reaches within the key, each `kind: "folder"` with its `path` and a `space`:

| `space.kind` | The root | Other fields |
|---|---|---|
| `personal` | Their own space, `people/<username>` | — |
| `shared` | A shared space they belong to | `name`, `level` |
| `received` | A folder someone shares with them | `level`, and `owner` (in a personal space) or `name` (of its shared space) |

With `recursive`, the folders and notes under those roots follow.

A link's `status` is `resolved`, `ambiguous`, `missing` or `no_access`, as over
HTTP: a note the person can't read is `missing`. An author in `history` has
`kind` and, as they apply, `name`, `on_behalf_of` and `via`.

### Writing tools

| Tool | Parameters | Result |
|---|---|---|
| `daily_note` | `series`, `create` (true) | `series`, `path`, `created`, `etag`, and the text as a block |
| `create_note` | `path` (required), `text` or `template` (its frontmatter copied without `template: true` and `aliases`) | `path`, `etag`, `uid`, `created` |
| `edit_note` | `path`, `operations` (1 to 50; required), `if_match`, `dry_run` (false) | `path`, `etag`; with `dry_run`: `dry_run`, `etag`, `changes` |
| `move` | `from`, `to` (required), `if_match`, `dry_run` (false), `confirm_audience` (false) | `from`, `to`, `dry_run`, `etag`, `relinked`, `shifted`, `kept`, `failed`, `alias_added`, `hidden`, `images`, and `audience` when it applies |
| `delete` | `path` (required), `if_match` | `path`, `trashed`, `at`, and `images` when some went with it |
| `attach_image` | `note` (required), `data` (base64, required), `mime_type`, `alt` | `path`, `src`, `markdown` |
| `revert_change` | `path`, `version` (required), `if_match`, `dry_run` (false) | `dry_run`, `changed`, `etag`, `counts`, `reverted`, `skipped` |

The operations of `edit_note` are those of the HTTP API, with
`expected_count` for `expectedCount`.

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
then (0.1.0-rc.3) the guide of each shared space the key reaches and the
person's own (`agents` in their settings), each when the key can read that
note. Their wording isn't covered.

## `vihko.yaml`

Every key vihko reads. [Configuration](configuration.md) explains each one.

| Key | Type | What it does |
|---|---|---|
| `version` | whole number from 1 | The file's format (1 when left out) |
| `daily` | map of series by id | Daily, weekly, monthly or yearly notes |
| `daily.<id>.label` | text | The series' name in the UI |
| `daily.<id>.folder` | folder pattern | Where its notes go |
| `daily.<id>.name` | name pattern | Each note's file name, without `.md` |
| `daily.<id>.template` | note | The note its notes start from |
| `attachments.mode` | `next-to-note`, `folder` or `per-note` | Where new images go |
| `attachments.folder` | folder | The folder for `mode: folder`, **relative to the root of each note's space** |
| `attachments.suffix` | text | The folder suffix for `mode: per-note` |
| `links.aliases` | `true` or `false` | Whether frontmatter aliases resolve `[[links]]` |
| `history.mode` | `managed`, `unmanaged` or `off` | How the history is kept |
| `history.maxFileSize` | number of MB | The largest file that enters the history |
| `history.exclude` | pattern, or list of patterns | Paths kept out of the history |
| `mcp.instructions` | note | A note served to agents as instructions; may hold `{user}` |
| `mcp.client_domains` | list of domains (or one) | Since 0.1.0-rc.6: the domains OAuth apps may come from, with their subdomains (a metadata document's host, or every redirect URI of an app that registers itself). Empty: any. An app from elsewhere can't register (`invalid_redirect_uri`) or be authorized (`client_not_allowed`, with `host`, on `GET/POST /api/oauth/authorize`) |
| `permissions.<folder>.name` | text | A shared space's name, only at its root |
| `permissions.<folder>.grants` | map of subject to level | Who gets what in that folder and below |
| `permissions.<folder>.ai` | `false` | Closes the folder and everything below it to agents |

What goes with them:

- **Paths** are from the notes root. A series' folder or `mcp.instructions`
  outside `people/` and `spaces/` is ignored, with an `outside_spaces`
  warning. `{user}` in a series' pattern or `mcp.instructions` is the
  person's username (with
  `people/{user}/agents.md`, each person's agents get their own guide).
- **Patterns** in `daily`: `{YYYY}`, `{MM}`, `{DD}`, `{GGGG}`, `{WW}` and
  `{user}`. «Today» only offers the series where the person can write today's
  note.
- **Template variables**: `{{title}}`, `{{user}}`, `{{date}}` and
  `{{date:FORMAT}}`, with the tokens `YYYY`, `YY`, `MM`, `M`, `DD`, `D`,
  `GGGG`, `WW`, `W`, `HH`, `mm` and text in `[brackets]`.
- **No `templates` key** since 0.1.0-rc.5: a template is a note marked
  `template: true`. An old `templates` is an unknown key (ignored, with a
  warning).
- **Permission keys** are real folders: a shared space's root
  (`spaces/<name>`) or a folder below it, or a folder inside a personal
  space (`people/<user>/<folder>`, and below). A personal space's root
  (`people/<user>`) takes only `ai: false`. Anything else rejects the
  section: `""`, `people`, `spaces`, a path in no space, a `{user}` segment,
  grants at a personal space's root, `name` anywhere but a shared space's
  root, a key written twice.
- **`name`** at a shared space's root is 0.1.0-rc.1 and rc.2's (the
  space's name). Since rc.3 the folder is the name: vihko never writes it,
  reads it only to rename such a space's folder when it starts, and then
  removes it.
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
  warning; a wrong value in a known key keeps the last valid file; the
  `permissions` section is strict and fails closed: rejected, no grant
  applies, and each person keeps only their own space. Without the section,
  the same: nobody shares anything.
- **How vihko writes it**: the `permissions` entries that change when someone
  shares a folder, creates, renames, deletes or leaves a space, moves or
  deletes a folder, or when a user or group is deleted or renamed; and a
  format rewrite at start after an upgrade, which may raise `version`.
  Comments, key order and keys it doesn't know stay.

## Settings of a person or a space

Since 0.1.0-rc.3, each space can have a settings file at
`<space root>/.vihko/settings.yaml`: `people/<username>/.vihko/settings.yaml`
for a person, `spaces/<name>/.vihko/settings.yaml` for a shared space. One
format for both. [Configuration](configuration.md#settings-of-a-person-or-a-space)
explains it.

| Key | Type | What it does |
|---|---|---|
| `version` | whole number from 1 | The file's format (1 when left out). A newer one is read as far as vihko can, with `newer_version` |
| `daily.<id>` | as in `vihko.yaml`: `label`, `folder`, `name`, `template` | The space's daily-note series. Patterns take `{YYYY}`, `{MM}`, `{DD}`, `{GGGG}` and `{WW}`, not `{user}` (`pattern_token`) |
| `attachments` | as in `vihko.yaml`: `mode`, `folder`, `suffix` | Where new images of the space's notes go |
| `agents` | note | A person's space only: their guide for agents. In a shared space's file it doesn't apply, and is reported as `space_guide_note` (with the note it names) |
| `guide` | text, up to 20,000 characters | A shared space only: its guide for agents, the text itself. Only its managers change it. In a person's file it's an `unknown_key` |

- **Paths are relative to the space's root**, never from the notes root: no
  leading `/`, `..`, `.` or hidden segment (`invalid_path`). Renaming a space
  changes nothing in its file.
- **How it's read**: a key vihko doesn't know is ignored (`unknown_key`); a
  known key with a wrong value is left out, and the rest applies; a file
  that isn't YAML applies nothing. Each problem has a code (the same as
  `vihko.yaml`'s), where it is and its line, and goes to the file's owner as
  `settings_invalid`.
- **Who reads it**: a person's, they alone; a shared space's, its members, to
  apply it. A key never reads or changes a settings file. Nobody gets it as a
  note or a file.
- **How it adds up** with `vihko.yaml`, for each person: daily-note series
  are their own, then those of each shared space they're in, then
  `vihko.yaml`'s, and two that give the same note are one: the closest is
  kept, with its label and template (since 0.1.0-rc.6; before, `vihko.yaml`'s
  was). Only those where they can write today's note are offered, in that
  order (`GET /api/workspace`'s `daily`). The id of a series left out that
  way still works, as the one kept: as `series`, and as `dailySeries`, which
  the next `POST /api/daily` without `series` rewrites to the kept id. With
  no `dailySeries` in the profile, today's note is the first listed, and the
  first `POST /api/daily` (or `daily_note` that opens or creates it) without
  a `series` writes that series' id as the profile's `dailySeries`. A
  `dailySeries` that no longer exists for the person is `409 series_gone`
  (since 0.1.0-rc.6; before, the first listed was used), and nothing is
  created. Templates aren't a setting (since 0.1.0-rc.5; an old
  `templates` key is an unknown one): every note marked `template: true` the
  person reads is one. New images of a note follow
  its space's `attachments`, otherwise `vihko.yaml`'s. The guides for agents
  come in order: `mcp.instructions`, each shared space the key reaches, the
  person's own.
- **Series ids**: a space's series are offered as `me-<id>` (one's own
  space) or `sp-<8 hex digits>-<id>` (a shared space's, from its root), so
  they never take one of `vihko.yaml`'s. A `dailySeries` in the profile
  names them that way. How the hex digits are made isn't covered.

## Environment variables

| Variable | Values |
|---|---|
| `VIHKO_PUBLIC_URL` | An `https://` origin |
| `VIHKO_TRUSTED_PROXIES` | Addresses or CIDR ranges, separated by commas or spaces |
| `VIHKO_INTEGRATIONS` | `off`, or unset. `off` keeps every integration off: the API with keys, the MCP server, and any later release adds |
| `VIHKO_EXTERNAL_IMAGES` | `allow`, `ask` (0.1.0-rc.6) or `block`. Unset: the installation's default, kept in `state.db` the first time it starts: `ask` for one started with 0.1.0-rc.6 or later, `allow` for one from before |
| `VIHKO_MAX_IMAGE_MB` | A number of megabytes, 20 by default |
| `VIHKO_SECRET_KEY` | A key of 32 characters or more |
| `VIHKO_SECRET_KEY_FILE` | A file holding that key |
| `VIHKO_LOG_LEVEL` | `info` (default) or `debug` (0.1.0-rc.6). What a log line says beyond that isn't covered |
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
| Tags | `0.1.0` (never changes), `0.1` and `0` and `latest` (move forward only), and release candidates under their exact tag only. In 0.x, pin the minor line: `:0.1` |
| Platforms | `linux/amd64` and `linux/arm64` |
| Volumes | `/data/notes` (the notes) and `/data/state` (vihko's state) |
| Port | 8080, plain HTTP |
| User | Any `uid:gid` in `user:` that can write both volumes; it needn't be root |
| Hardening | Runs with a read-only root filesystem, no capabilities (`cap_drop: [ALL]`) and `no-new-privileges` |
| Health check | `GET /api/health` answers `200` while the process serves |
| Required settings | None |
| The command | `vihko` on the `PATH`, run inside the container (`docker compose exec vihko vihko …`, or `run --rm` while vihko is stopped); the image's command is `vihko serve` |

## The command line

[Operations](operations.md#the-command-line) explains each command.

| Command | Arguments and options | Exit status |
|---|---|---|
| `vihko serve`, or `vihko` alone | — | `0` when stopped (`SIGTERM`, `SIGINT`); `1` if it can't start |
| `vihko user create <name> [--admin]` | The password on standard input (one final line break is dropped); `--admin` before or after the name. Creates `people/<name>/` too | `0` created; `1` not (the name taken or not valid, a weak password, `personal_folder_exists`) |
| `vihko user reset-link <name>` | — | `0` with the link; `1` no such user |
| `vihko user reset-2fa <name>` | — | `0` removed, or there was none; `1` no such user |
| `vihko history purge <path> [--version <id>] [--dry-run]` | `--version=<id>` too | `0` purged, or nothing to purge; `1` not |
| `vihko version`, or `vihko --version` | — | `0`, printing the version alone on one line, without reading any configuration |

A command it doesn't know, or arguments a command doesn't take, print the
usage on standard error and exit with `2`. A failure prints `error: …` or
`error (<code>): …` on standard error. What the commands print for people
isn't covered; `vihko version`'s output is.

## What vihko writes into your notes folder

[Notes and Markdown](notes.md) explains each of these. vihko writes nothing
else into a note unless someone asks it to (an edit, a comment, a
`set_frontmatter`).

| What | Form |
|---|---|
| The two folders | `people/` and `spaces/`, made when vihko starts if they're missing |
| A person's folder | `people/<username>/`, made when the user is created, and again at start if it went missing |
| A shared space's folder | `spaces/<name>/`, the space's name as written, made when the space is created, or when a folder becomes a space of its own («Move to a new space»), and renamed with the space. A space of 0.1.0-rc.1 or rc.2 (`spaces/<readable>-<id>/`) is renamed to its name when vihko starts |
| A shared space's members | `permissions.<root>.grants` in `vihko.yaml` |
| Settings of a person or a space | `<space root>/.vihko/settings.yaml`, written when someone saves them in the UI: atomically, only the keys that changed, `version` added first when missing; comments and key order stay |
| The note's identity | `uid: <id>` in the frontmatter, added only when vihko writes the note anyway: created, edited or moved from vihko. vihko writes a ULID today and reads any text or number as a `uid` |
| An alias after a rename | The old name added to `aliases`, only when a link to the note from its own space couldn't be rewritten and `links.aliases` is on |
| Frontmatter changes | Only that key's value, in place; a new key at the end of the block; a note without frontmatter gets a block at the top. The rest stays byte for byte |
| Templates | `template: true` in the frontmatter when someone makes a note a template, or marks a folder's notes as templates; the key removed when they stop it being one. A note created from a template gets the template's text and frontmatter without that key and without `aliases` (the rest, `ai` included, byte for byte), its variables filled in |
| Comments | `<!-- @author YYYY-MM-DDTHH:MMZ · text -->`; a reply starts its text with `↳ `; comments one after another are a thread; resolving a thread deletes it |
| Links kept when a name is taken | When someone creates, restores or renames a note (or gives it an alias) that would make a link in a note they can't read lead elsewhere, vihko rewrites that link as after a move, so it keeps leading to its note |
| Links rewritten after a move | Only inside a space: the link keeps its destination. A wikilink gets a name or path that reaches the note without ambiguity, keeping its `#heading` and `\|text` (with the note's name as text when only the path from the notes root reaches it, for someone who sees only part of the space). A Markdown link gets a path relative to the note, percent-encoded as image links are. vihko never writes a link to another space: when a note or a folder changes space, nothing is rewritten across spaces |
| Links in tables | Inside a table row, the `\|` of a wikilink vihko writes is `\|` escaped as `\\|`, as Obsidian does, and stays so |
| Image links | `![alt](path)`, relative to the note, with spaces, brackets, parentheses, `%`, `#`, `?`, `<`, `>` and `\` percent-encoded |
| Where new images go | As `attachments` says, inside the note's space. A new image never takes a name already in use; the form of its name isn't covered |
| Moved images | Images only one note uses go with it when it changes folder. When it changes space, the images it shares with other notes are copied to the new space, and its links point to the copies |
| A deleted folder | Since 0.1.0-rc.6, everything in it goes to the trash, its hidden folders (`.git/`, `.obsidian/`, `.vihko/`…) included, and restoring it puts them back; only a symbolic link in it stops it. Operating systems' clutter (`.DS_Store` and the like) is removed |
| A saved copy of an external image | Since 0.1.0-rc.6, «Save a copy» on an image of a note stores it as an upload does and replaces that image's destination with the copy's relative path, its alt text kept |

What vihko reads in your notes stays too: the frontmatter keys `uid`,
`title`, `tags`, `aliases`, `ai` (`ai: false` hides a note from agents) and
`template` (`template: true`, a YAML true, makes a note a template: offered
when creating a note, left out of search unless asked for, of tags and of
Home), every other key's simple values for searching,
`#tags`, both kinds of links (`[[a\|b]]` in a table included), files named
by an `![[…]]` or `[[…]]` with an extension (relative to the note, or by name
in its space, since 0.1.0-rc.6), and the files it ignores (names starting
with `.` or ending in `~`, and symbolic links).

How a link resolves is the same for everyone who reads it, and a link never
leads to another space, in any form: a wikilink whose first segment is
`people` or `spaces` is a path from the notes root; a Markdown link, or
`[[/path]]`, is an exact path; each leads to a note only when that note is
in the link's own space. Any other wikilink is searched only among the notes
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
| `POST /oauth/register` | Dynamic client registration (RFC 7591), only while the admin allows it |
| `GET /oauth/authorize` | Where the person approves the app |
| `POST /oauth/token` | Codes and refresh tokens |
| `POST /oauth/revoke` | Token revocation (RFC 7009) |

The server metadata offers the authorization code flow with PKCE (`S256`
only) and refresh tokens, the `query` response mode, the `iss` parameter in
the response, client authentication `none`, `client_secret_post` or
`client_secret_basic`, and clients that identify themselves with a metadata
document URL. A client must list `authorization_code` among its `grant_types`
and `code` among its `response_types` when it gives them; other grants it
lists are ignored. `registration_endpoint` is listed only while registration
is on. Tokens are opaque: read `expires_in`.

## Known limits

- **A refused name looks like a taken one.** When creating, restoring,
  renaming or moving a note, or giving it an alias by an edit (API or MCP),
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
  refused one has none. An alias typed in the editor isn't checked.
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
  (hidden names such as `.plan.md.vihko-…`).
