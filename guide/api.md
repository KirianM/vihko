# HTTP API

vihko's HTTP API lets a script or another program read and write notes with a
key. It's the same API the web UI uses: a key reaches the routes listed in this
guide, and nothing else.

The API is part of vihko's compatibility promise, like `vihko.yaml` and the MCP
tools: a change that breaks a client that follows this guide only comes with a
new major version, and anything removed stays available, marked deprecated,
until then. The paths have no version prefix. Fields may be added to responses
at any time: ignore those you don't know.

For AI assistants, the MCP server is usually a better fit: see
[Agents and integrations](agents.md).

## Before you start

1. The vihko admin turns on **HTTP API with keys**, in Preferences → **Agents
   and API**. While it's off, every request with a key gets `404`.
2. You create a key in the same page, under **Your keys**. A new key is
   read-only; tick **Can write** for a script that writes. See
   [Keys](agents.md#keys) for what a key can see.

The examples use `http://vihko.example.lan:8080` as vihko's address and keep
the key in a variable:

```sh
export VIHKO=http://vihko.example.lan:8080
export VIHKO_KEY=vihko_…   # the key, as shown when you created it
```

## Authentication

Send the key in the `Authorization` header of every request:

```sh
curl -H "Authorization: Bearer $VIHKO_KEY" "$VIHKO/api/tree"
```

A request with a key is judged by the key alone, never by a session cookie.

| Answer | When |
|---|---|
| `401 unauthorized` | The key is wrong, revoked or expired, or its person is disabled |
| `403 forbidden` | A read-only key on a route that writes |
| `404 not_found` | The API is off, or the route isn't open to keys |

The key acts for its person, within its folders, and never sees notes or
folders closed to agents (`ai: false`). A note the key can't see answers
`404 not_found`, as if it didn't exist, except when you name one that exists
but is hidden from agents: then `403 agent_denied` with a `reason`
(`ai_false`, `outside_key_folders` or `user_no_access`). Lists and searches
never include such notes.

## Requests and answers

- The base path is `/api`. Everything is JSON (`Content-Type:
  application/json`), except file uploads and downloads.
- Notes are named by their path from the notes root, with the `.md` extension:
  `projects/plan.md`. In a query string, URL-encode it: with `curl`, use `-G`
  and `--data-urlencode "path=projects/my plan.md"`.
- Dates are ISO 8601 in UTC.
- When vihko writes a note, it may add a `uid` to its frontmatter: the note's
  identity, which stays when the note moves. Leave it as it is.

### Errors

Every error has a stable code in `error`, and a hint for developers in
`message`, which may change. Check the code, never the message.

```json
{ "error": "precondition_failed", "message": "…", "etag": "sha256:…" }
```

The codes you can meet with a key:

| Code | Status | Meaning |
|---|---|---|
| `unauthorized` | 401 | Not a valid key (see above) |
| `forbidden` | 403 | A read-only key on a route that writes, or something the key's person may not do there: writing where they only read, a note's history where they can't edit |
| `agent_denied` | 403 | The note exists but is not for agents; `reason` says why. Don't delete or replace links to it |
| `not_found` | 404 | No such note, version or route, or one the key can't see |
| `invalid` | 400 | A body or parameter that isn't valid (also a body that isn't JSON) |
| `invalid_path` | 400 | Not a valid note or folder path (absolute, `..`, hidden segments, not `.md`) |
| `control_characters` | 400 | A path with a control character (a tab, a line break) |
| `exists` | 409 | Creating a note that already exists |
| `edit_mismatch` | 409 | An edit operation doesn't fit the text: `find` not found the expected number of times, a heading that isn't there |
| `not_configured` | 409 | The daily note, with no series in `vihko.yaml` |
| `audience_widens` | 409 | A move would show the note to people who can't see it now; `audience` says who. Repeat with `confirmAudience: true` only if its person agrees |
| `not_revertible` | 409 | Reverting a version that creates or deletes the note |
| `history_off` | 409 | `vihko.yaml` turns the history off |
| `too_large` | 413 | An image over the size limit |
| `unsupported_type` | 415 | An upload that isn't a PNG, JPEG, GIF, WebP or AVIF image |
| `busy` | 429 | Too many images being uploaded at once; `Retry-After` says when to try again |
| `precondition_required` | 428 | A write that needs `If-Match` (or `ifMatch`) and has none |
| `precondition_failed` | 412 | The note changed since that ETag; `etag` is the current one |
| `history_unavailable` | 503 | The history can't be read right now |
| `internal` | 500 | Something went wrong in vihko; its log says what |

A body over the size limit answers `413` with `invalid`.

## Concurrency: ETags

Every note has an ETag: the SHA-256 of its text, written `sha256:<hex>`. You
get it in the `ETag` header (quoted, as HTTP has it) and in the body of every
read and write.

vihko never overwrites text you haven't seen:

- **Replacing a whole note** (`PUT /api/note`) needs `If-Match` with the ETag
  you read. Without it, `428 precondition_required`. If the note changed since,
  `412 precondition_failed` with the current ETag, and nothing is written: read
  it again, merge, and retry.
- **Creating with `PUT`**: `If-None-Match: *` writes only if the note doesn't
  exist (`412` if it does).
- **Edits by operation** (`POST /api/note/edit`): operations that replace text
  (`find_replace`, `replace_section`, `set_frontmatter`) need the ETag, as
  `ifMatch` in the body or as `If-Match`. Appends don't: they apply to the text
  as it is, which is how you add to a note someone is typing in.
- **Moving and deleting** take `If-Match` too, optionally.

Both quoted (`"sha256:…"`) and bare ETags are accepted.

If someone has the note open in the editor, a read gives the text as they see
it, which may be a few seconds ahead of the file on disk, and writes go into
their editor live.

## Limits

| What | Limit |
|---|---|
| Request body | 20 MiB (`413`) |
| Image upload | `VIHKO_MAX_IMAGE_MB`, 20 MB by default (`413 too_large`) |
| Images received at once | 2 per person, 8 in all, uploads and copies from a URL together (`429 busy`) |
| Search results | 50 with words, 500 with filters alone |
| History pages | 50 versions or changes at most |

## Endpoints

| Method | Path | Key | What it does |
|---|---|---|---|
| `GET` | `/api/tree` | read | Every note and folder the key can see |
| `GET` | `/api/note` | read | A note's text and ETag |
| `GET` | `/api/note/links` | read | A note's outgoing links and backlinks |
| `GET` | `/api/note/headings` | read | A note's headings |
| `GET` | `/api/note/comments` | read | A note's comment threads |
| `GET` | `/api/search` | read | Full-text search with filters |
| `GET` | `/api/tags` | read | Tags in use |
| `GET` | `/api/daily` | read | Where today's note is and whether it exists |
| `GET` | `/api/file` | read | An image or other attachment |
| `POST` | `/api/note` | write | Create a note |
| `PUT` | `/api/note` | write | Replace a note's text (or create it) |
| `POST` | `/api/note/edit` | write | Edit a note by operations |
| `POST` | `/api/note/move` | write | Move or rename a note |
| `DELETE` | `/api/note` | write | Move a note to the trash |
| `POST` | `/api/daily` | write | Open or create today's note |
| `POST` | `/api/attachments` | write | Upload an image |
| `GET` | `/api/history/status` | read | Whether the history is on and working |
| `GET` | `/api/history/versions` | read | A note's versions |
| `GET` | `/api/history/version` | read | A note's text in one version |
| `GET` | `/api/history/diff` | read | What changed between two versions |
| `GET` | `/api/history/changes` | read | Recent changes across notes |
| `GET` | `/api/history/resolved` | read | Comment threads resolved in the last 30 days |
| `POST` | `/api/history/restore` | write | Bring back a version's text |
| `POST` | `/api/history/revert` | write | Undo what one version changed |
| `GET` | `/api/health` | none | The server answers (no key needed) |
| `GET`, `POST` | `/api/setup` | none | [Create the first admin](#create-the-first-admin), with the token from the log |

"read" routes work with any key; "write" routes need a key that may write,
and `edit` for its person where the note is. Everything else in `/api` is for
the web UI only and answers `404` to a key: folders (creating, moving and
deleting them), the trash, comments, alerts, users, keys and settings.

### List notes and folders

`GET /api/tree`

```sh
curl -H "Authorization: Bearer $VIHKO_KEY" "$VIHKO/api/tree"
```

```json
{
  "notes": [
    { "path": "projects/plan.md", "title": "Plan", "uid": "01JB2R…", "aliases": [] }
  ],
  "folders": ["projects"],
  "pathOnly": []
}
```

`uid` is `null` for a note vihko hasn't needed to give one yet. A folder in
`pathOnly` is shown only as the way to something below it that the key can
see.

### Read a note

`GET /api/note?path=<path>`

```sh
curl -G -H "Authorization: Bearer $VIHKO_KEY" "$VIHKO/api/note" \
  --data-urlencode "path=projects/plan.md"
```

```json
{
  "path": "projects/plan.md",
  "text": "# Plan\n\n- Draft the budget\n- Book the room\n",
  "etag": "sha256:7e24…",
  "meta": { "title": "Plan", "uid": null, "fm_error": null },
  "hiddenFromAgents": null
}
```

To see what's around a note:

- `GET /api/note/links?path=` gives `outgoing` (each link with its `status`:
  `resolved`, `ambiguous` with `candidates`, `missing`, or `no_access`) and
  `backlinks` (the notes that link to it, with the text around each link).
- `GET /api/note/headings?path=` gives `headings`, each with its `level` and
  `text`.
- `GET /api/note/comments?path=` gives the note's comment `threads`, each with
  the text it was anchored to (`original`) and whether that text has `changed`.

### Search

`GET /api/search?q=<query>`

Words are searched in each note's title, aliases and text; the last word also
as a prefix. Filters narrow it:

| Filter | Keeps |
|---|---|
| `path:projects/2026` | Notes in that folder and below, or that one note (quote a path with spaces: `path:"my notes"`) |
| `tag:work` | Notes with that tag, or a tag nested under it (`work/meetings`) |
| `-path:…`, `-tag:…` | Excludes instead |

```sh
curl -G -H "Authorization: Bearer $VIHKO_KEY" "$VIHKO/api/search" \
  --data-urlencode "q=budget path:projects -tag:done"
```

```json
{
  "results": [
    { "path": "projects/plan.md", "title": "Plan", "snippet": "- Draft the \u0002budget\u0003" }
  ],
  "highlight": { "start": "\u0002", "end": "\u0003" }
}
```

Snippets mark each hit between the two characters in `highlight`. With words,
up to 50 results, best first; with filters alone, up to 500, by path.

`GET /api/tags` lists the tags in use, most used first: `count` is the notes
with that tag, `total` those with it or a tag nested under it.

### Create a note

`POST /api/note` with `{ "path", "text" }`, or `{ "path", "template" }` to
create it from a template note (its `{{title}}`, `{{date}}` and the like filled
in). It never overwrites: `409 exists` if the note is there.

```sh
curl -H "Authorization: Bearer $VIHKO_KEY" -H "Content-Type: application/json" \
  "$VIHKO/api/note" \
  -d '{"path": "projects/meeting.md", "text": "# Meeting\n\n"}'
```

`201` with the new note's `path`, `uid` and `etag`. Folders on the way are
created.

### Replace a note's text

`PUT /api/note?path=<path>` with `{ "text" }` and `If-Match`:

```sh
curl -X PUT -H "Authorization: Bearer $VIHKO_KEY" -H "Content-Type: application/json" \
  -H 'If-Match: "sha256:7e24…"' \
  "$VIHKO/api/note?path=projects/plan.md" \
  -d '{"text": "# Plan\n\n- Draft the budget\n- Book the room\n"}'
```

With a body, `curl -G` would move it into the query string too, so write the
path in the URL yourself, percent-encoded (`my%20plan.md`).

`200` with the new `etag`. With `If-None-Match: *` instead of `If-Match`, it
creates the note only if it doesn't exist (`201`).

### Edit a note by operations

`POST /api/note/edit` with `{ "path", "ops", "ifMatch"?, "dryRun"? }`. The
operations apply in order, all or none, on the current text, even while
someone has the note open.

| `op` | Fields | What it does |
|---|---|---|
| `append` | `text` | Adds `text` at the end of the note, on a new line |
| `append_under_heading` | `heading`, `text` | Adds `text` at the end of that heading's section, before its subheadings |
| `find_replace` | `find`, `replace`, `expectedCount`? | Replaces the exact text `find`, which must appear `expectedCount` times (1 by default) |
| `replace_section` | `heading`, `text` | Replaces everything under the heading (subsections included); the heading stays |
| `set_frontmatter` | `key`, `value` | Sets one frontmatter key to text, a number, `true`/`false` or a list, touching nothing else |

`heading` is the heading's text, or with its level (`"## Tasks"`) when the
same text is at several levels. `find_replace`, `replace_section` and
`set_frontmatter` need `ifMatch`.

```sh
curl -H "Authorization: Bearer $VIHKO_KEY" -H "Content-Type: application/json" \
  "$VIHKO/api/note/edit" \
  -d '{"path": "projects/plan.md", "ops": [{"op": "append_under_heading", "heading": "Plan", "text": "- Send the invites"}]}'
```

```json
{ "etag": "sha256:9a0e…" }
```

With `"dryRun": true`, nothing is written: the answer lists the `changes` it
would make (`at`, `removed`, `inserted`) and the `etag` they apply to.

If the write hides the note from agents (it sets `ai: false`), it still
succeeds and the answer adds `"nowHidden": true` with a `reason`: from then on
the key can't see the note.

### Move or rename a note

`POST /api/note/move` with `{ "from", "to", "dryRun"?, "confirmAudience"? }`.
vihko rewrites every link to the note, in every note, and the moved note's own
relative links. It never overwrites.

```sh
curl -H "Authorization: Bearer $VIHKO_KEY" -H "Content-Type: application/json" \
  "$VIHKO/api/note/move" \
  -d '{"from": "projects/meeting.md", "to": "archive/2026/meeting.md", "dryRun": true}'
```

The report says which notes' links were (or would be) rewritten (`relinked`),
links whose destination changes anyway (`shifted`), links that keep working
(`kept`), what failed (`failed`), the old name when vihko added it as an alias
because a link couldn't be rewritten (`aliasAdded`), what happened to the
note's images
(`images`) and, in a dry run, who gains or loses access (`audience`). `hidden`
is `true` when notes the key can't see were rewritten too.

Who can see a note depends on its folder. A move that would show the note to
anyone who can't see it now fails with `409 audience_widens` and that
`audience`. Only with its person's agreement, repeat it with
`"confirmAudience": true`.

### Delete a note

`DELETE /api/note?path=<path>` moves the note to the trash, where a person can
restore it from the UI. `If-Match` is optional: with it, only if the note
hasn't changed.

```sh
curl -X DELETE -H "Authorization: Bearer $VIHKO_KEY" \
  "$VIHKO/api/note?path=projects/meeting.md"
```

The answer is the trash entry: its `id`, `path`, `deletedAt`, who deleted it
(`actor`), the `etag` of the text it had and, if any went with it, `files`:
the images next to it that no other note used, which go to the trash with the
note (see [The trash](notes.md#the-trash)). A key takes along only images in
its folders and out of folders closed to agents; the rest stay.

### Today's note

`GET /api/daily` says where the key's person's note for today is (in their
time zone, from the series in `vihko.yaml`) and whether it `exists`. `POST
/api/daily` opens it, or creates it from its template (`201`). Both take a
`series` (in the query for `GET`, in the body for `POST`) to use another
series than the person's own.

```sh
curl -X POST -H "Authorization: Bearer $VIHKO_KEY" -H "Content-Type: application/json" \
  "$VIHKO/api/daily" -d '{}'
```

```json
{ "series": "journal", "path": "Journal/2026-09-28.md", "created": true }
```

### Images and attachments

Upload an image with its bytes as the body, naming the note it's for:

```sh
curl -H "Authorization: Bearer $VIHKO_KEY" -H "Content-Type: image/png" \
  "$VIHKO/api/attachments?note=projects/plan.md" --data-binary @diagram.png
```

`201` with the stored file's `path`, its `src` (the path relative to the
note) and `markdown`, the link ready to write into the note, with what would
break a Markdown link escaped:

```json
{ "path": "projects/my plan-2026-09-28-1201.png", "src": "my plan-2026-09-28-1201.png", "markdown": "![](my%20plan-2026-09-28-1201.png)" }
```

vihko stores it where `vihko.yaml` says (next to the note by default), but
doesn't add the link: do that with an edit, for example an `append` of the
`markdown` it returned. Don't write `src` into the note as it is: a space in
it would break the link, and the image would count as unused.

`GET /api/file?path=<path>` downloads a file in the notes folder that isn't a
note. A key gets it only if it's in the key's folders, a note the key can read
uses it (links to it), and no note hidden from agents does: an image you just
uploaded is `404` to the key until a note links it. Notes themselves are read
with `GET /api/note`.

### History

Available when the history is on (see [History](history.md)). A note's history
is only for whoever can edit the note: a key whose person only reads it gets
`403 forbidden`.

| Request | Answer |
|---|---|
| `GET /api/history/status` | Whether the history is on (`mode`) and working |
| `GET /api/history/versions?path=&limit=&cursor=` | `versions`, newest first, each with its `id`, `at`, `authors` and `reason`; `next` is the cursor of the next page |
| `GET /api/history/version?path=&id=` | That version's `text` |
| `GET /api/history/diff?path=&id=&against=` | What the version changed against `previous` (default), `current` or another version id |
| `GET /api/history/changes?limit=&cursor=&author=` | Recent changes across the notes the key can see, and the `authors` to filter by (`author` takes an author's `key`) |
| `GET /api/history/resolved?path=` | Comment threads that left the note in the last 30 days |
| `POST /api/history/restore` `{ path, id, ifMatch? }` | Writes that version's text back, as a new version |
| `POST /api/history/revert` `{ path, id, ifMatch?, dryRun? }` | Undoes only what that version changed, keeping later changes; what clashes is left and listed in `skipped` |

An author is a person (`kind: "user"`), an agent (`kind: "agent"`, with the
key's `name`, `onBehalfOf` and `via`: `api`, `mcp` or `oauth`), or vihko
itself (`kind: "system"`).

vihko groups a burst of writes to a note into one version once the note has
been quiet for a while. Until then, `versions` lists who is writing under
`pending`, and the change isn't a version yet.

```sh
curl -G -H "Authorization: Bearer $VIHKO_KEY" "$VIHKO/api/history/versions" \
  --data-urlencode "path=projects/plan.md" --data-urlencode "limit=5"
```

Restoring and reverting write like any edit: they appear in the history under
the key's name.

### Health

`GET /api/health` answers `{ "ok": true }` without a key, for monitoring and
Docker's health check. It doesn't say which version runs.

### Create the first admin

On the first start, before anyone has an account, vihko prints a one-time
token in its log ([Installation](install.md#first-start)). These two routes
need neither a key nor a session (send them without `Authorization`), and do
what the browser's «Create the
administrator» page does, for a script that sets up a new installation:

- `GET /api/setup` answers `{ "needed": true }` while there are no users, and
  `{ "needed": false }` from then on.
- `POST /api/setup` with `{ "token", "username", "password" }` creates the
  admin.

```sh
curl -H "Content-Type: application/json" "$VIHKO/api/setup" \
  -d '{"token": "<token from the log>", "username": "alex", "password": "a long passphrase"}'
```

```json
{ "user": { "id": "…", "username": "alex", "role": "admin", "disabled": false } }
```

It creates the account and signs nobody in: sign in afterwards, in the
browser. The token works once; once there's a user, it's gone for good.

| Code | Status | When |
|---|---|---|
| `invalid_token` | 400 | Not the token of this start (each start while there are no users prints a new one) |
| `invalid_username` | 400 | The username isn't 2 to 64 letters, digits, `.`, `_` or `-` |
| `weak_password` | 400 | The password has fewer than 10 characters (or more than 1024) |
| `invalid` | 400 | The body isn't JSON |
| `already_setup` | 409 | There is a user already |
| `too_many_attempts` | 429 | Too many wrong tokens from this address; `Retry-After` says when to try again |

## A complete example

Read a note, change it, and write it back only if nobody changed it in between
(with [`jq`](https://jqlang.org) to handle the JSON):

```sh
#!/bin/sh
set -eu
note="projects/plan.md"

etag=$(curl -sf -G -H "Authorization: Bearer $VIHKO_KEY" "$VIHKO/api/note" \
  --data-urlencode "path=$note" | jq -r .etag)

curl -sf -H "Authorization: Bearer $VIHKO_KEY" -H "Content-Type: application/json" \
  "$VIHKO/api/note/edit" \
  -d "$(jq -n --arg p "$note" --arg e "$etag" \
    '{path: $p, ifMatch: $e, ops: [{op: "find_replace", find: "- Book the room", replace: "- [x] Book the room"}]}')"
```

If someone edited the note in between, the second request is refused with
`412 precondition_failed` (and `curl -f` exits with an error): read the note
again and retry.
