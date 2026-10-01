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
  - `people/` and `spaces/` are fixed. A shared space's folder is
    `<readable>-<id>`: its id never changes, and its readable part isn't
    renamed when the space is.
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
| `spaces/<readable>-<id>/…` | A shared space, such as `spaces/home-7k2q9x/`. `<id>` is 6 lowercase letters and digits after the last hyphen: the space's identity. `<readable>` is made from the space's name when it's created and never changes; the name people see is kept in `vihko.yaml` and can change |
| `people/<username>/.vihko/`, `spaces/<readable>-<id>/.vihko/` | Reserved for the settings of that person or space in a later version (settings, never notes). Hidden, like every name that starts with a dot, and refused as a note or folder in any case (`invalid_path`). A person's doesn't come along when their space becomes a shared one |
| `vihko.yaml` | The workspace configuration, at the root. Nobody sees it in vihko |
| Anything else | In no space: nobody sees it in vihko, and the admins get the `outside_spaces` alert |

- `people` and `spaces` are fixed names. Nothing can be created at the root of
  the notes folder, or directly in `people/` or `spaces/`: a request that
  tries gets `400 outside_space`. A space's root is never created, renamed,
  moved or deleted as a folder: `400 space_root` (a shared space is deleted as
  a space; see below).
- A folder in `spaces/` without an id at the end is not a space. One whose
  name happens to end in `-` and six letters or digits is taken as a space,
  with no members until the admin assigns a manager. Only someone writing on
  the disk can make either.
- A folder in `people/` named after no user (active, disabled or deleted) is
  seen by nobody, and the admins get `person_folder_without_user`.
- A shared space's name is not unique (the id tells spaces apart), and it is
  not secret: the admin's directory lists every shared space by name.

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
| Errors | `{ "error": <code>, "message": <hint> }`, with `etag` on `precondition_failed`, `reason` on `agent_denied`, `audience` on `audience_widens`, `path` on an `exists` that names the disk's spelling, `contents` on `not_empty`, `group` on `leave_via_group`, `retryAfter` on `too_many_attempts`; `Retry-After` on `429` |
| What the key's person can't read | `404 not_found`, the same whether it exists or not |
| What the person reads but is hidden from agents | `403 agent_denied` with `reason`: `ai_false` (the note or a folder above it is closed to agents) or `outside_key_folders` |
| A write that hides the note from the key | Succeeds, and adds `nowHidden: true`, `reason` and `message` |

### Routes open to keys

"Key" says which keys may call the route: any key (read) or a key that may
write (write).

| Method and path | Key | Request | Response |
|---|---|---|---|
| `GET /api/tree` | read | — | `notes` (`path`, `title`, `uid`, `aliases`), `folders`, `pathOnly` |
| `GET /api/spaces` | read | — | `personal` (`path`, or null when the key doesn't reach it), `spaces` (`path`, `id`, `name`, `level`, `managers`, `aiClosed`), `shared` (`path`, `level`, `pinned`, and `owner` in a personal space or `space` with `path`, `id`, `name`), `canCreate` (always false for a key) |
| `GET /api/spaces/members` | read | `path` (a folder) | `path`, `space` (`path`, `name`, or null in a personal space), `owner` (or null in a shared space), `members` (`username`, `level`, `via`: `subject`, `level`, `from` (null where the asker doesn't read that folder), and `owner: true` for a person's own space) |
| `GET /api/note` | read | `path` | `path`, `text`, `etag`, `meta` (`title`, `uid`, `fmError`, or null), `hiddenFromAgents` |
| `GET /api/note/links` | read | `path` | `outgoing` (`raw`, `kind`, `target`, `anchor`, `status`, `dstPath`, `anchorOk`, `candidates`, `posFrom`, and `othersNoAccess`, `reason`, `self` when they apply), `backlinks` (`path`, `title`, `raw`, `context`), `titles` |
| `GET /api/note/headings` | read | `path` | `headings` (`level`, `text`) |
| `GET /api/note/comments` | read | `path` | `threads` (`id`, `original`, `changed`) |
| `GET /api/search` | read | `q` | `results` (`path`, `title`, `snippet`), `highlight` (`start`, `end`) |
| `GET /api/tags` | read | — | `tags` (`tag`, `count`, `total`) |
| `GET /api/daily` | read | `series`? | `series`, `path`, `exists` |
| `GET /api/file` | read | `path` | The file's bytes, with its `Content-Type` and an opaque `ETag` |
| `POST /api/note` | write | `path`, and `text` or `template` | `201`: `path`, `uid`, `etag` |
| `PUT /api/note` | write | `path` (query), `text`, `If-Match` or `If-None-Match: *` | `200` or `201`: `etag` |
| `POST /api/note/edit` | write | `path`, `ops`, `ifMatch`?, `dryRun`? | `etag`; with `dryRun`: `dryRun`, `etag`, `changes` (`at`, `removed`, `inserted`) |
| `POST /api/note/move` | write | `from`, `to`, `dryRun`?, `confirmAudience`?, `If-Match`? | `from`, `to`, `dryRun`, `etag`, `relinked`, `shifted`, `kept`, `failed`, `aliasAdded`, `images` (`moved`, `copied`, `stayed`, `folder`, `failed`), `hidden`, `crossSpaceLinks` (`path`, `incoming`, `outgoing`) when it changes space, and `audience` in a dry run |
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
  `crossSpaceLinks` counts the links the move writes with a path from the
  notes root: `incoming`, in notes of other spaces the key sees, and
  `outgoing`, in the moved note, to notes of the space it leaves; `path` is
  the note's new path without `.md`. `images.copied` lists the images the note
  uses that would stay behind in the space it leaves, copied to the new one
  (`from`, `to`).
- **The history**: an author has `kind` (`user`, `agent`, `system`, `git` or
  `external`), `name` and `key` (the value for the `author` filter), and, as
  they apply, `id`, `onBehalfOf` (`id`, `name`) and `via` (`api`, `mcp` or
  `oauth`). A reason is a `code` with its data. A link the system rewrote
  so that it keeps leading to its note when another note took its name
  (created, restored or given an alias by someone who can't read the note
  holding the link) has the reason `links_kept`, with `to` (the note that
  took the name, or null where the reader can't read it) and `by`.
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
| `not_configured` | 409 | The daily note, with no series in `vihko.yaml` |
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
| `POST /api/spaces` | Anyone, or only admins with the setting `spacesCreation: admins` (`403 forbidden` otherwise) | `name`, `members`? (`{ "<user>" or "@<group>": level }`) | `201`: `space` (as in `GET /api/spaces`). The creator manages it |
| `POST /api/spaces/from-folder` | `manage` in the folder and `edit` in its parent, and who may create spaces | `path` (a folder inside a space), `name`? (the folder's own by default), `dryRun`? | A dry run: `report` (the folder move's, with `audience`). Otherwise `201`: `space` (as in `GET /api/spaces`), `report`. The folder becomes a shared space of its own: what it holds goes to the new space's root, with the folder's own grants and its mover managing it. `400 space_root` for a space's root |
| `POST /api/spaces/rename` | `manage` at the space's root | `path`, `name` | `space`. Only the name changes, never the folder |
| `DELETE /api/spaces` | `manage` at the space's root | `path`, `trash`? (query) | `path`. With `trash=true`, what it holds goes to the trash, which its managers keep seeing; otherwise only an empty space goes (`409 not_empty`) |
| `POST /api/spaces/leave` | A grant of one's own there | `path` | `path`. One's own grants there and below go; nothing is deleted. `409 leave_via_group` with `group` when it comes through a group; `400 invalid` for one's own space, or a grant from a folder above |
| `POST /api/spaces/pin` | What is shared with one | `path`, `pinned` | `path`, `pinned` |
| `GET /api/admin/spaces` | The vihko admin | — | `spaces` (`path`, `id`, `name`, `managers`, `members` (a count), `aiClosed`), `closed` (`userId`, `username`, `path`: the spaces of deleted people) |
| `POST /api/admin/spaces/managers` | The vihko admin, confirmed at the moment | `path`, `userId`, `confirm` | `space`. Only for a space without managers: `409 space_has_managers` otherwise |
| `POST /api/admin/spaces/join` | The vihko admin, confirmed at the moment | `path`, `level`? (`read` by default), `confirm` | `space` |
| `GET /api/admin/users/:id/space` | The vihko admin | — | `path`, `exists`, `sharedFolders`, `people` (counts) |
| `POST /api/admin/users/:id/space` | The vihko admin, confirmed at the moment | `action` (`transfer`, `convert` or `delete`), `to` (a user id, for `transfer`), `name` and `members` (for `convert`), `dryRun`?, `confirm`, `deleteUser`? | `plan` (`action`, `from`, `to`, `notes`, `files`, `sharedFolders`, `people`). `400 space_needs_manager` when a conversion names nobody who manages it. A transfer goes to `people/<recipient>/<deleted username>`, or, if that name is taken there, the first free `-<n>` after it, found only when it moves (a dry run never looks into the recipient's space). With `deleteUser: true`, the person is disabled but not deleted yet: what is asked (a transfer or a conversion) is checked and confirmed, then they're deleted and their space settled |
| `GET /api/permissions` | `manage` in the folder | `folder` | `folder`, `etag` (of `vihko.yaml`), `section` (`none`, `rules` or `closed`), `own` (`grants`), `inherited` (`from`, `grants`: every folder above it in its space with grants), `owner`, `space` (`path`, `name`), `ai` (`closed`, `from`), `canEdit`, `access` (who has access, and why) |
| `PUT /api/permissions` | `manage` in the folder | `folder`, `grants`? (or null), `ai`? (`false` or null), `ifMatch` | As `GET`; `412` when `vihko.yaml` changed; `400 invalid` for grants at a personal space's root |
| `GET /api/permissions/folders` | Anyone | — | `folders` (`path`, `level`, `ownGrants`, `aiClosed`, `canEdit`): only what the asker sees |
| `POST /api/permissions/holds/:id` | Who could have made that move from vihko | `action: "release"` | `ok` |
| `POST /api/folder` | `edit` in the parent | `path` | `201`: `path`. `outside_space`, `space_root` |
| `POST /api/folder/move` | `manage` in it and `edit` in both parents | `from`, `to`, `dryRun`?, `background`? | The folder move's report, with `images.copied` when it changes space. The root of a folder someone shares with you is only theirs to move |
| `DELETE /api/folder` | `manage` in it | `path`, `trash`? | `path`, `trashed`. `409 held_inside` while notes held after a move made outside vihko are in it |
| `GET /api/trash` | Anyone | — | `entries`, each with `space` (its space's root, or null) |
| `POST /api/trash/:id/restore` | Where the entry was | `to`? | `path`, `etag`, `files`, `left`: what stayed in the trash, only where the person reads |
| `GET /api/keys` | Anyone | `all=1` (the vihko admin: everyone's) | `keys`; with `all=1`, each with `user`, and `foldersHidden` when someone else's key reaches folders the admin doesn't read (those aren't listed in `folders`) |
| `POST /api/history/purge` | Whoever manages the note's folder; the vihko admin, any path | `path`, `version`?, `dryRun`?, `confirm` | `path`, `version`, `dryRun`, `versions`, `filesRemoved`, `onDisk`, `sharedWith`, `movedFrom`, `confirmRequired`. The admin's dry run of a path they can't read answers `hidden: true` with nothing of it (no versions, nothing on the disk), whether it exists or not |
| `POST /api/admin/rescan` | The vihko admin | `force`?, `confirmRemoval`? | Counts only: `added`, `changed`, `removed`, `moved`, `unchanged`, `aborted`, `massDelete` |
| `GET /api/move-jobs/:id` | Whoever started the move | — | `done` and `total` count only the notes the person reads |
| `GET/PUT /api/admin/settings` | The vihko admin | `spacesCreation`? (`everyone` or `admins`) | The settings, with `spacesCreation` |
| `GET /api/workspace` | Anyone | — | `templates`: the templates folders the person can read, `{user}` made theirs |

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
| `missing_folder` | Whoever manages the space | `folders`: grants in `vihko.yaml` for folders that don't exist. Never the admin as such |
| `permissions_held` | Who could have made that move from vihko | `id`, `folder`, `notes` (a count): notes held after a move made outside vihko |
| `shared_with_you` | The person added | `kind` (`space` or `folder`), `by`, `path`, `name`, `owner`, `space`: someone added them to a space or shared a folder with them. Names and path only while they can still see it |
| `space_changed` | The people concerned, and the other admins | `change` (`manager_assigned`, `admin_joined`, `personal_transferred`, `personal_converted`, `personal_deleted`), `by`, `user`, `to`, `space` |
| `links_not_updated` | Whoever made the move | Links in other notes a move of theirs couldn't update, even retried. No path, name or count |

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
| `search` | `query` (required), `limit` (1 to 50, 20), `offset` (0) | `results` (`path`, `title`, `snippet`), `next_offset` |
| `get_note` | `path` or `uid`, `offset` (0), `max_chars` (1,000 to 200,000; 100,000) | `path`, `etag`, `title`, `uid`, `frontmatter`, `links` (`outgoing`: `link`, `target`, `anchor`, `status`, `path`, `candidates`, and `others_no_access`, `reason` when they apply; `incoming`: `path`, `title`, `count`; `more`), `text` (`offset`, `length`, `total`, `next_offset`); the text as a block |
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
| `shared` | A shared space they belong to | `id`, `name`, `level` |
| `received` | A folder someone shares with them | `level`, and `owner` (in a personal space) or `name` and `id` (of its shared space) |

With `recursive`, the folders and notes under those roots follow.

A link's `status` is `resolved`, `ambiguous`, `missing` or `no_access`, as over
HTTP: a note the person can't read is `missing`. An author in `history` has
`kind` and, as they apply, `name`, `on_behalf_of` and `via`.

### Writing tools

| Tool | Parameters | Result |
|---|---|---|
| `daily_note` | `series`, `create` (true) | `series`, `path`, `created`, `etag`, and the text as a block |
| `create_note` | `path` (required), `text` or `template` | `path`, `etag`, `uid`, `created` |
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
and across spaces; that moving a note to another space changes who sees it
and whose it is; what to do with notes it can't see; and, for a key that
writes, how to use ETags, `confirm_audience` and `ai: false`. Then the
workspace's own guide, when `mcp.instructions` names a note the key can read.
Their wording isn't covered.

## `vihko.yaml`

Every key vihko reads. [Configuration](configuration.md) explains each one.

| Key | Type | What it does |
|---|---|---|
| `version` | whole number from 1 | The file's format (1 when left out) |
| `templates` | folder, or list of folders | Where the templates are; each may hold `{user}` |
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
| `permissions.<folder>.name` | text | A shared space's name, only at its root |
| `permissions.<folder>.grants` | map of subject to level | Who gets what in that folder and below |
| `permissions.<folder>.ai` | `false` | Closes the folder and everything below it to agents |

What goes with them:

- **Paths** are from the notes root. A series' folder, a templates folder or
  `mcp.instructions` outside `people/` and `spaces/` is ignored, with an
  `outside_spaces` warning. `{user}` in a templates folder, a series' pattern
  or `mcp.instructions` is the person's username (with
  `people/{user}/agents.md`, each person's agents get their own guide).
- **Patterns** in `daily`: `{YYYY}`, `{MM}`, `{DD}`, `{GGGG}`, `{WW}` and
  `{user}`. «Today» only offers the series where the person can write today's
  note.
- **Template variables**: `{{title}}`, `{{user}}`, `{{date}}` and
  `{{date:FORMAT}}`, with the tokens `YYYY`, `YY`, `MM`, `M`, `DD`, `D`,
  `GGGG`, `WW`, `W`, `HH`, `mm` and text in `[brackets]`.
- **Permission keys** are real folders: a shared space's root
  (`spaces/<readable>-<id>`) or a folder below it, or a folder inside a
  personal space (`people/<user>/<folder>`, and below). A personal space's
  root (`people/<user>`) takes only `ai: false`. Anything else rejects the
  section: `""`, `people`, `spaces`, a path in no space, a `{user}` segment,
  grants at a personal space's root, `name` anywhere but a shared space's
  root, a key written twice.
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

## Environment variables

| Variable | Values |
|---|---|
| `VIHKO_PUBLIC_URL` | An `https://` origin |
| `VIHKO_TRUSTED_PROXIES` | Addresses or CIDR ranges, separated by commas or spaces |
| `VIHKO_INTEGRATIONS` | `off`, or unset. `off` keeps every integration off: the API with keys, the MCP server, and any later release adds |
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
| A shared space's folder | `spaces/<readable>-<id>/`, made when the space is created, or when a folder becomes a space of its own («Move to a new space»). The readable part is the name in lowercase, without accents, anything else than letters and digits made a hyphen, at most 40 characters (`space` when nothing is left) |
| A shared space's name and members | `permissions.<root>.name` and `.grants` in `vihko.yaml` |
| The note's identity | `uid: <id>` in the frontmatter, added only when vihko writes the note anyway: created, edited or moved from vihko. vihko writes a ULID today and reads any text or number as a `uid` |
| An alias after a rename | The old name added to `aliases`, only when a link to the note from its own space couldn't be rewritten and `links.aliases` is on |
| Frontmatter changes | Only that key's value, in place; a new key at the end of the block; a note without frontmatter gets a block at the top. The rest stays byte for byte |
| Comments | `<!-- @author YYYY-MM-DDTHH:MMZ · text -->`; a reply starts its text with `↳ `; comments one after another are a thread; resolving a thread deletes it |
| Links kept when a name is taken | When someone creates, restores or renames a note (or gives it an alias) that would make a link in a note they can't read lead elsewhere, vihko rewrites that link as after a move, so it keeps leading to its note |
| Links rewritten after a move | The link keeps its destination. A wikilink inside its space gets a name or path that reaches the note without ambiguity, keeping its `#heading` and `\|text`. A wikilink to another space is written from the notes root, without a leading `/`, with the note's name as its visible text: `[[spaces/home-7k2q9x/shopping list\|shopping list]]`. That text follows the note when it's renamed from vihko, if it's still the note's name. A Markdown link gets a path relative to the note, percent-encoded as image links are |
| Links in tables | Inside a table row, the `\|` of a wikilink vihko writes is `\|` escaped as `\\|`, as Obsidian does, and stays so |
| Image links | `![alt](path)`, relative to the note, with spaces, brackets, parentheses, `%`, `#`, `?`, `<`, `>` and `\` percent-encoded |
| Where new images go | As `attachments` says, inside the note's space. A new image never takes a name already in use; the form of its name isn't covered |
| Moved images | Images only one note uses go with it when it changes folder. When it changes space, the images it shares with other notes are copied to the new space, and its links point to the copies |

What vihko reads in your notes stays too: the frontmatter keys `uid`,
`title`, `tags`, `aliases` and `ai` (`ai: false` hides a note from agents),
`#tags`, both kinds of links (`[[a\|b]]` in a table included), and the files it
ignores (names starting with `.` or ending in `~`, and symbolic links).

How a link resolves is the same for everyone who reads it: a wikilink whose
first segment is `people` or `spaces` is a path from the notes root; a
Markdown link, or `[[/path]]`, is an exact path; any other wikilink is
searched only among the notes of its own space, by name and path, then by
aliases of that space. An alias that several notes of the space share is
ambiguous. A name never reaches another space.

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
  history repository, the trash, the editor's recovery files, the lock.
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
