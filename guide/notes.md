# Notes and Markdown

Your notes are a folder of plain Markdown files, and they stay that way. vihko
reads them, indexes them on the server, and writes to them only when someone
does something through vihko. You can keep editing the same files with any
other tool: vihko notices.

This page says what vihko reads in your files, what it writes to them, and
what it never touches.

## What vihko sees in the notes folder

| In the folder | For vihko |
|---|---|
| A file ending in `.md` (any case) | A note: indexed, searchable, editable |
| Any other file (images, PDFs…) | A file: shown and linked, with the permissions of its folder |
| A name starting with `.` (`.git/`, `.obsidian/`, `.trash/`) or ending in `~` | Ignored, with everything under it |
| A symbolic link, to a file or a folder | Ignored: vihko never reads, serves, indexes or writes through one |
| A Syncthing conflict copy (`Plan.sync-conflict-20260928-101200-ABCDEFG.md`) | Not indexed; an alert points to it next to the original |
| `vihko.yaml` at the root | The [workspace configuration](configuration.md), hidden from everyone |

vihko imposes no structure: any folders, any names. Nothing needs frontmatter.

Names are taken exactly as the disk spells them. On a filesystem that ignores
case (a macOS or Windows folder shared into the container, an SMB share),
`Projects/plan.md` would open `projects/plan.md`, but the permissions of a
folder go by its name as written: vihko answers only to the spelling on disk,
and any other spelling doesn't exist for it.

vihko keeps nothing of its own in the notes folder. Its database, index,
history, trash and editor recovery files live in the state volume. The only
things it writes there besides your notes are short-lived temporary files
(hidden names such as `.plan.md.vihko-…`) that make each write atomic: a new
version is written next to the file and renamed over it, so another program
never sees half a note.

## Frontmatter

vihko reads standard YAML frontmatter, between `---` lines at the top of a
note. It uses these keys and leaves every other one to you:

| Key | What vihko does with it |
|---|---|
| `uid` | The note's identity. See [The `uid`](#the-uid) |
| `title` | The note's title in lists and search. Without it, the first `# Heading`; without that, the file name |
| `tags` | Tags, a list or a single value, counted the same as `#tags` in the text |
| `aliases` | Other names the note answers to in `[[links]]`, as a last resort ([`links.aliases`](configuration.md#linksaliases) can turn this off) |
| `ai` | `ai: false` hides the note from every agent. Any doubtful value (`no`, `off`, `"false"`, `0`) counts as `false` |

```markdown
---
title: Launch plan
tags: [projects, q4]
aliases: [Plan, Launch]
ai: false
uid: 01K6A3Q2V7X9ZB4C8D5E6F7G8H
reviewer: someone@example.com
---
# Launch plan
```

A note whose frontmatter isn't valid YAML still opens, shows and saves, but
vihko treats it as the most restricted: it's hidden from agents, and vihko
never adds a `uid` to it.

When vihko changes frontmatter (adding a `uid` or an alias), it edits only that
key in the text. It never re-serialises the block: key order, comments,
quoting, list style and keys it doesn't know stay exactly as they were.

## The `uid`

The `uid` is what identifies a note for vihko: not its path, not its name. The
ones vihko writes are ULIDs (26 characters, such as
`01K6A3Q2V7X9ZB4C8D5E6F7G8H`), sortable by creation time; vihko reads any text
or number there as a `uid`.

vihko adds one only when it writes the note anyway:

- when a note is created from vihko (UI, API, MCP, a template, a daily note);
- when someone edits a note through vihko, in the same write;
- when a note is moved or renamed from vihko.

Reading or indexing a note never writes to it. A note you never edit from vihko
keeps no `uid`, and that's fine: until it has one, vihko identifies it by its
path.

What the `uid` buys you:

- a note renamed or moved **outside** vihko is still recognised as the same
  note, with its history;
- an open note that another tool renames follows its file;
- an agent can read a note by its `uid` (MCP `get_note`), whatever its path
  is now. Every other tool, and the HTTP API, take the path.

Don't copy a `uid` into another note. If two notes share one (a file
duplicated by hand), admins get an alert naming both: change or delete the
`uid` in the copy.

## Links

vihko reads both kinds of Markdown links. The editor writes wikilinks.

| Syntax | Meaning |
|---|---|
| `[[Plan]]` | The note named `Plan` |
| `[[Plan\|the plan]]` | The same, showing «the plan» |
| `[[Plan#Budget]]` | The heading «Budget» in `Plan` |
| `[[launch/Plan]]` | A note whose path ends in `launch/Plan` |
| `[[/projects/launch/Plan]]` | Exactly `projects/launch/Plan.md`, from the root |
| `[text](../launch/Plan.md)` | A standard Markdown link, relative to the note |
| `![[Plan]]` | Also a link to `Plan` (vihko doesn't show one note inside another) |

A `[[name]]` is resolved like this, in order:

1. **Exact name**, ignoring case (and Unicode forms). Never a partial match.
2. **Nearest wins.** With several candidates, the one that shares the deepest
   folder with the linking note wins; then the one fewer levels below that
   folder (a `Plan.md` next to you beats one in a subfolder).
3. **Still tied: ambiguous.** vihko never picks silently. The link is marked
   ambiguous; clicking it lists the candidates, and «Pin» rewrites that link to
   the shortest form that always leads to the one you chose.
4. **Aliases**, from the notes' frontmatter, as a last resort.

A link is shown as resolved, broken, ambiguous, pointing to a missing heading,
or **no access**: a note that exists but that you can't read is shown dimmed
with a lock, with no path, title or preview, so nobody is tempted to create a
duplicate.

Links inside code blocks and inline code aren't links.

## Renames and moves

When you rename or move a note from vihko, **vihko rewrites the links to it in
every other note**, so none of them changes its destination:

- It rewrites only the link text, nothing else of the note. A wikilink keeps
  its `#heading` and `|text`; a Markdown link gets the new path relative to
  the note, with what would break it (spaces, brackets, parentheses, `%`,
  `#`, `?`…) percent-encoded, and keeps its `#heading`, its `<…>` form and
  its title.
- It does it in every note, including ones you can't read or edit, as vihko
  itself on your behalf: those notes' history says «Links updated when “Plan”
  was renamed to “Launch plan”», with your name, and whoever can edit them can
  undo it.
- The preview never names notes you can't read.
- If moving the note would make some other link lead elsewhere (a closer note
  with the same name now takes over), that link is rewritten too, with the
  shortest form that keeps its destination.
- If a rewrite fails (the file changed meanwhile), vihko adds the old name to
  the note's `aliases`, so the link keeps working, and tells you which notes
  to check. With `links.aliases: false` it only tells you.

Images next to the note that only it uses move with it (see
[`attachments`](configuration.md#attachments-where-new-images-go)). Moving a
folder moves everything in it and rewrites the links into it the same way.

**Moved outside vihko** (a shell, a file manager, a sync tool): vihko notices
the same note at the new path (same `uid`, or the same content) and keeps it as
the same note. It does **not** rewrite links on its own, since the other tool
may be doing it. An alert says how many links still point to the old path, with
«Update links» to rewrite them as if the move had been made from vihko.

## Tags

`#tag` in the text and `tags:` in the frontmatter count the same.

- A tag starts after a space or at the start of a line, and holds letters,
  digits, `_`, `-` and `/`. It can't be only digits (`#123` isn't a tag).
- `#projects/q4` is a nested tag.
- Tags ignore case. Tags in code aren't tags.

In the search box, `tag:projects` finds the notes with that tag.

## Comments

Comments between people, and with agents, live **inside the note**, as HTML
comments that most Markdown viewers hide:

```markdown
We'll use Postgres for the index.<!-- @noa 2026-09-24T08:12Z · no, use SQLite -->
<!-- @claude 2026-09-24T08:15Z · ↳ agreed, changing it -->
```

- Each comment is `<!-- @author date · text -->`. The date is UTC, to the
  minute, with `Z`; vihko shows it in each reader's timezone.
- Comments one after another (with at most one line break between them) are a
  thread; `↳` marks a reply.
- A comment is anchored to the text before it, from the start of its sentence.
  If that text changes, the comments panel says so.
- Anyone who can read the note sees its comments. There are no private
  comments.
- Resolving a thread deletes it from the note. With the history on, it's kept
  there: for 30 days it's listed under «Resolved» in the comments panel, and
  can be reopened while its text is still in the note. See
  [History](history.md#resolved-comments).
- `-->` inside a comment's text is written `-- >`. A `<!-- -->` inside a code
  block is code, not a comment.

In another editor the comments show up as HTML comments. They travel with the
note, in backups and copies.

## Images

vihko shows local images referenced any of these ways, relative to the note:

```markdown
![A diagram](plan-2026-09-28-1012.png)
![[plan-2026-09-28-1012.png]]
[The diagram](plan-2026-09-28-1012.png)
```

Uploading, pasting or dropping an image stores it in the notes folder (where,
depends on [`attachments`](configuration.md#attachments-where-new-images-go))
and inserts a `![](…)` link with a relative path. From a URL, you choose:
«Save a copy» (vihko downloads it into the folder) or «Link to source»
(the note keeps the URL; for images that change, such as a chart).

Images from other sites (`![](https://…)`) load directly in the browser, which
tells that site someone is looking. `VIHKO_EXTERNAL_IMAGES=block` stops that
for the whole installation (see [Install](install.md)).

An image has the permissions of the folder it's in: a person who can't read
that folder can't see the image, even in a note they can read.

## The trash

Deleting a note moves it to the trash, in the state volume
(`trash/` there), never to a folder among your notes. Everyone who has it open
sees it close.

**Its images go with it**: the ones next to it that no other note uses, the
same ones that would go with it if you moved it to another folder (in
`per-note` mode, what its own folder of images holds that no other note uses).
Images another note also uses, in another folder, or in the shared
attachments folder of [`attachments`](configuration.md#attachments-where-new-images-go)
stay where they are. An agent takes along only images in its key's folders and
out of folders closed to agents.

- Right after deleting, «Restore» brings it back, with its images.
- Later, in «Recent changes», open the change that deleted it: «Restore it as
  it was before» puts it back from the history, images included.
- A person sees, and restores, only what was deleted from folders where they
  can edit.

Restoring never overwrites anything. If a note with that name exists by then,
the note isn't restored: rename or move that one first. If one of its images'
names was taken meanwhile by another file, the image comes back with a number
(`plan-2026-09-28-1012-2.png`) and the note links it there; an identical file
already there counts as restored.

vihko never empties the trash on its own by default. A later release may add
a setting to keep entries only for a while, off unless you turn it on. Each
entry sits in its own folder under
`trash/` in the state volume (`note.md`, its images under `files/`, and a
`meta.json` that lists them); delete those by hand if you need the space.

### Deleting a folder

«Delete folder» deletes an empty folder at once. Empty subfolders go with it,
and so does the clutter operating systems leave (`.DS_Store`, `._*` files,
`Thumbs.db`, `desktop.ini`), which vihko removes without asking.

If the folder holds notes or other files, the dialog lists them first
(hidden files such as `.keep` included) and offers to send them to the trash
along with the folder, in one step: each note goes as if deleted on its own,
with its images, and the other files as one more entry. «Restore» on the
notice that follows brings all of it back.

Two things keep a folder from being deleted, and the dialog says which:

- **What vihko never touches**: a hidden folder inside it (`.git/`,
  `.obsidian/`, another program's) or a symbolic link. vihko doesn't read,
  move or delete those; remove them with another tool first.
- **Things you can't edit**, such as someone's personal folder inside it:
  counted, never named.

Deleting a folder takes `manage` in it, as renaming or moving it does.

## Files changed outside vihko

Edit, add, move or delete files with any tool while vihko runs:

- **The index catches up** within seconds (a file watcher), and a full rescan
  every `VIHKO_RESCAN_SECONDS` (60 by default) catches what the watcher misses:
  network filesystems, changes made while vihko was stopped, lost events.
- **A note open in the editor** takes in the outside change: vihko merges it
  into what people are typing, live.
- **A note deleted outside while someone edits it** isn't recreated behind
  their back. Everyone who has it open is told, and the first to decide keeps
  their copy (the note is created again with what they wrote) or discards it.
  If nobody decides, the copy is kept and admins get an alert.
- **A scan that would remove most notes at once** (an unmounted network share
  looks like an empty folder) stops, removes nothing from the index, and
  alerts the admins.
- **The history** records outside changes as «Outside vihko», or «while vihko
  was stopped». See [History](history.md#changes-made-outside-vihko).

## What vihko never does to your files

- It never writes a note because it read or indexed it.
- It never rewrites frontmatter it doesn't need to change, and never reorders
  or reformats it.
- It never overwrites an image, or a note when creating one: a taken name gets
  a number.
- It never deletes a note outright: deleting goes to the trash, and so do the
  images and files that go with it. The only thing it removes outright is the
  operating systems' clutter in a folder you delete (`.DS_Store` and the like).
- It never writes into a git repository you keep in the notes folder (with
  `history.mode: unmanaged` it only reads it).
- It never keeps note content anywhere but the files, apart from what it
  derives or keeps for you in the state volume: the search index, the
  history, the trash and recovery copies of open notes.
