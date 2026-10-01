# Workspace configuration: `vihko.yaml`

`vihko.yaml` holds the settings that belong to your notes rather than to the
server: who shares what, the shared spaces' names, daily notes, templates,
where images go, how the history is kept. It lives at the root of the notes
folder, so it travels, and is backed up, with the notes.

Settings that belong to the installation (ports, volumes, the public address,
the second factor's key) are environment variables instead: see
[Install](install.md). Settings that belong to a person (language, timezone,
which daily note is theirs) are in their account. A person, and a shared
space, can add their own daily notes, templates and guide for agents in a
settings file of their space: see
[Settings of a person or a space](#settings-of-a-person-or-a-space).

## The basics

- **It's optional.** Without the file nothing is turned on and nothing is
  shared: each person has their own space, there are no daily notes or
  templates, images go next to their note, and the history is managed by
  vihko.
- **Part of it is written by vihko.** Sharing a folder, and creating,
  renaming, leaving or deleting a space, all from the UI, write the
  `permissions` section. You edit the rest on disk, with any text editor,
  while vihko runs. vihko reads it when it starts, when it changes (the file
  watcher) and on every periodic rescan (`VIHKO_RESCAN_SECONDS`, 60 seconds
  by default). No restart needed.
- **Nobody sees it in vihko.** It never shows up in the folder tree, as a note or
  as a file, and vihko serves it to nobody, admins included, because it says
  who reads what. Its history isn't shown either.
- **vihko writes to it in two cases:**
  - when people share folders and manage spaces from the UI (and when a folder
    moves, a folder or person is deleted, or a group is renamed): vihko
    rewrites only the entries of `permissions` that change, and leaves the
    rest of the file, comments and key order included, as it was. See
    [How vihko writes the permissions](#how-vihko-writes-the-permissions);
  - when it starts after an upgrade that changed the file's format. See
    [Format changes on upgrade](#format-changes-on-upgrade).
- **Problems show up as alerts**, never as a crash. Only admins see them, in
  the workspace alerts (the «N workspace alerts» link that appears in the
  sidebar). See [When something is wrong](#when-something-is-wrong).

## A complete example

```yaml
version: 1

templates:
  - people/{user}/Templates
  - spaces/Home/Templates

daily:
  journal:
    label: Journal
    folder: people/{user}/journal
  household:
    label: Household log
    folder: spaces/Home/log
    template: spaces/Home/Templates/Log
  weekly:
    folder: spaces/Home/weeks
    name: "{GGGG}-W{WW}"

attachments:
  mode: folder
  folder: attachments          # inside each note's space

links:
  aliases: true

history:
  mode: managed
  maxFileSize: 20
  exclude:
    - spaces/Home/archive/**
    - "**/*.pdf"

mcp:
  instructions: spaces/Home/For agents

permissions:
  spaces/Home:                     # the shared space «Home»: its folder is its name
    grants: { noa: manage, "@family": edit }
  spaces/Home/recipes:             # a neighbour who isn't in Home sees recipes too
    grants: { sam: read }
  spaces/Home/finances:
    ai: false
  people/noa/trips:                # a folder of Noa's, shared with Sam
    grants: { sam: comment }
  people/noa/journal:
    ai: false
```

## Reference

| Key | Type | Default | What it does |
|---|---|---|---|
| [`version`](#version) | whole number | `1` | Which format the file follows |
| [`templates`](#templates) | folder, or list of folders | none | Folders whose notes are offered as templates |
| [`daily`](#daily-daily-notes) | map of series | none | Daily, weekly, monthly or yearly notes |
| [`attachments.mode`](#attachments-where-new-images-go) | `next-to-note`, `folder` or `per-note` | `next-to-note` | Where new images go |
| [`attachments.folder`](#attachments-where-new-images-go) | folder | none | The folder for `mode: folder`, inside each space |
| [`attachments.suffix`](#attachments-where-new-images-go) | text | `.assets` | The folder suffix for `mode: per-note` |
| [`links.aliases`](#linksaliases) | `true` or `false` | `true` | Whether frontmatter aliases resolve `[[links]]` |
| [`history.mode`](#history) | `managed`, `unmanaged` or `off` | `managed` | How note history is kept |
| [`history.maxFileSize`](#history) | number (MB) | `20` | Largest file that enters the history |
| [`history.exclude`](#history) | list of patterns | none | Paths kept out of the history |
| [`mcp.instructions`](#mcpinstructions) | note path | none | A note served to agents as instructions |
| [`permissions`](#permissions) | map of folder rules | nothing shared | Shared spaces, and who shares what |

Paths in the file are relative to the root of the notes folder, with `/`
between folders. They can't start with `/`, go through `..` or `.`, or enter a
hidden folder (a name that starts with `.`). A trailing `/` on a folder is
fine.

Paths to notes and folders must be **inside a space**: `people/<user>/…` or
`spaces/<name>/…` (see [Notes and Markdown](notes.md)). A series'
folder, a templates folder or `mcp.instructions` anywhere else is ignored, and
the admins get a warning (`outside_spaces`). A shared space's folder, its
name, shows in the address bar when you open one of its notes
(`?note=Home%2F…`; a person's space shows as `~<username>`), and on
the disk.

### `version`

```yaml
version: 1
```

The format the file follows. Leave it out and it's `1`. It must be a whole
number from 1 up; anything else makes the file unusable. A `version` newer than
your vihko understands isn't an error: what vihko understands applies, and an
alert says the file is newer.

You don't need to change it by hand. The number goes up only with a
[format change](#format-changes-on-upgrade): when vihko rewrites the file to
a newer format, it raises `version` to match (and adds it if the file had
none), so that an older vihko, if you go back to one, can tell the file is
newer than it understands.

### `templates`

```yaml
templates: people/{user}/Templates
# or several:
templates:
  - people/{user}/Templates
  - spaces/Home/Templates
```

A folder, or a list of folders. `{user}` is the person creating the note, so
`people/{user}/Templates` gives each person their own. Every note in those
folders, subfolders included, is offered under «From a template» when you
create a note from the search box (Ctrl+K, or ⌘K on a Mac), grouped by space.
Templates are plain notes, and you only see the ones you can read; a template
from another space works the same, since only its text is copied (its links
by name then resolve in the new note's space).

The notes in a templates folder are skeletons, not notes anyone wrote: they're
left out of search (unless you ask for the folder with `path:`), of the tags
and their counts, and of Home. They stay in the tree, and you open and edit
them as any note.

When vihko creates a note from a template, it copies the template's text and
fills in these variables, in the timezone of the person creating it. Nothing
else runs: a template can't execute code, loop or read other notes.

| Variable | Becomes |
|---|---|
| `{{title}}` | The new note's name (its file name without `.md`) |
| `{{user}}` | The username of whoever creates it |
| `{{date}}` | Today, as `YYYY-MM-DD` |
| `{{date:FORMAT}}` | Now, in the format you give |

`FORMAT` takes these tokens; text in `[brackets]` is copied as it is.

| Token | Meaning | Example |
|---|---|---|
| `YYYY` / `YY` | Year, four or two digits | `2026` / `26` |
| `MM` / `M` | Month, two digits or as is | `09` / `9` |
| `DD` / `D` | Day of the month | `05` / `5` |
| `GGGG` | ISO week-numbering year | `2026` |
| `WW` / `W` | ISO week | `09` / `9` |
| `HH` / `mm` | Hour (24 h) and minute | `14` / `05` |

For example, `{{date:[Week] W, YYYY}}` gives `Week 39, 2026`. Anything else in
`{{…}}` is left as it is.

### `daily`: daily notes

```yaml
daily:
  journal:                         # the series' id
    label: Journal                 # optional, shown in the UI
    folder: people/{user}/journal  # where its notes go: inside a space
    name: "{YYYY}-{MM}-{DD}"       # optional; this is the default
    template: spaces/Home/Templates/Daily   # optional note
  weekly:
    folder: spaces/Home/weeks
    name: "{GGGG}-W{WW}"
```

Each entry is a **series**: a folder and a name pattern that give one note per
day, week, month or year. Each person picks theirs in Preferences («Daily
note series»), with the option to open today's note when vihko opens (it only
opens a note that exists; it never creates one). Until they pick one, the
default is their own first series, else the first of their shared spaces',
else the first here; the first time «Today» opens a note, that series becomes
their choice, so a series added later never takes its place. A person can also make series of their own without this file: see
[A daily journal](first-steps.md#a-daily-journal).

«Today» (in the sidebar, the search box's commands, or Ctrl+Alt+D, ⌘⌥D on a
Mac) opens the note for today in that person's timezone. If it doesn't exist,
vihko creates it from the template; it never overwrites a note. The note header
has buttons for the previous and next note in the series.

| Key | Default | Notes |
|---|---|---|
| id (the key) | — | Letters, digits, `-` or `_`, starting with a letter or digit, up to 64 characters |
| `label` | the id | Name shown in the UI |
| `folder` | the root | Folder pattern. It must be inside a space: a series at the root of the notes folder, or anywhere else outside `people/` and `spaces/`, is ignored |
| `name` | `{YYYY}-{MM}-{DD}` | File name pattern, without `.md` and without `/` |
| `template` | none | A note, from the notes root; `.md` is added if missing |

Patterns take these variables, in `folder` or in `name`:

| Variable | Meaning |
|---|---|
| `{YYYY}`, `{MM}`, `{DD}` | Year, month and day |
| `{GGGG}`, `{WW}` | ISO week-numbering year and ISO week |
| `{user}` | The username of the person whose note it is |

Together, `folder` and `name` must name exactly one note per period:

| Period | Needs | Example |
|---|---|---|
| Day | `{YYYY}`, `{MM}` and `{DD}` | `{YYYY}/{MM}/{DD}` |
| ISO week | `{GGGG}` and `{WW}`, without `{YYYY}`, `{MM}` or `{DD}` | `{GGGG}-W{WW}` |
| Month | `{YYYY}` and `{MM}` | `{YYYY}-{MM}` |
| Year | `{YYYY}` | `{YYYY}` |

- **`people/{user}/…`** gives each person their own series, in their own
  space. **A folder in a shared space** gives one note of the day for all its
  members, who write it together; add `{user}` to the name for one each.
- «Today» only offers a person the series where they can write today's note:
  a `people/{user}/…` series to everyone, a shared space's series to its
  members who can edit there.
- vihko finds the note of a period by its path alone. If you rename today's
  note, «Today» creates another one.
- If the template doesn't exist, the series' notes are created empty and an
  admin alert says so. A template the person can't read isn't used.
- A person can add series for themselves, and a shared space's managers for
  the space, without `vihko.yaml`: see
  [Settings of a person or a space](#settings-of-a-person-or-a-space).

### `attachments`: where new images go

```yaml
attachments:
  mode: next-to-note   # next-to-note (default), folder or per-note
  # folder: images     # only with mode: folder
  # suffix: .assets    # only with mode: per-note
```

This decides where vihko puts an image you upload, paste or save from a URL.
Images already in your notes stay where they are.

| Mode | Where a new image goes | Example for `spaces/Home/projects/plan.md` |
|---|---|---|
| `next-to-note` (default) | Next to the note, named after it and the time (UTC) | `spaces/Home/projects/plan-2026-09-28-1012.png` |
| `folder` | All in one folder **of the note's space**, with the same kind of name | `spaces/Home/images/plan-2026-09-28-1012.png` |
| `per-note` | In a folder of its own next to the note, named after the note plus `suffix` | `spaces/Home/projects/plan.assets/2026-09-28-1012.png` |

- `folder` is relative to the root of each note's space: with `folder:
  images`, an image of a note in «My notes» goes to `people/<you>/images/`,
  and one of a note in «Home» to `spaces/Home/images/`. No folder
  ever mixes the images of two spaces.
- `folder` alone implies `mode: folder`. `mode: folder` without `folder` is an
  error, and so is `folder` with another mode, or `suffix` without
  `mode: per-note`: a key that would look active without being so.
- `suffix` is `.assets` by default (as in Typora). It can't be empty, contain
  `/`, start or end with a space, end in `.md`, or be longer than 32
  characters.
- A name that is taken gets a number (`…-1012-2.png`). vihko never overwrites
  an image.
- **When a note moves to another folder**, the images next to it that no other
  note uses go with it, in every mode, and every link to them is rewritten. In
  `per-note` mode its image folder moves whole and is renamed to match; it
  stays where it is (and links are rewritten to reach it) if the new name is
  taken or the folder holds notes. **When it moves to another space**, the
  images it shares with other notes are copied where a new image of it would
  go there. The move's preview says what happens.
- vihko stores PNG, JPEG, GIF, WebP and AVIF, recognised by their content, up
  to `VIHKO_MAX_IMAGE_MB` (20 MB by default). It shows SVG and other images
  that are already in the folder, but never stores a new SVG.

### `links.aliases`

```yaml
links:
  aliases: false
```

On (the default), the `aliases` in a note's frontmatter resolve `[[links]]` as a
last resort, after names and paths, among the notes of the link's own space.
Turn it off if you share the folder with a tool where they don't, such as
Obsidian:

- `[[alias]]` is then a broken link, as in that tool;
- autocomplete still offers aliases, but inserts `[[Note|alias]]`;
- a rename that couldn't rewrite some link no longer adds the old name as an
  alias.

Changing it re-resolves every link at once, without reindexing. See
[Notes and Markdown](notes.md) for how links resolve.

### `history`

```yaml
history:
  mode: managed        # managed (default), unmanaged or off
  maxFileSize: 20      # MB
  exclude:
    - spaces/Home/archive/**
    - "**/*.pdf"
    - people/noa/drafts/private.md
```

| Key | Default | Values |
|---|---|---|
| `mode` | `managed` | `managed`: vihko keeps its own history in the state volume. `unmanaged`: vihko only reads the git repository your notes folder already has. `off`: no history |
| `maxFileSize` | `20` | A number of MB greater than 0 (decimals are fine). Larger files don't enter the history, and an alert lists them |
| `exclude` | none | A list of path patterns (or one pattern as text) kept out of the managed history |

Patterns in `exclude`:

- `*` matches any characters within one name, `?` exactly one, and `**` (a
  whole segment) any number of folders, none included.
- A pattern covers what's under it: `archive`, `archive/` and `archive/**` all
  exclude that folder. `*.pdf` only matches at the root; `**/*.pdf` matches
  everywhere.
- Case matters. `[…]`, `{…}`, a leading `!` and `\` aren't supported: a
  pattern with them is an error, rather than one that silently matches
  nothing.

Excluded files are still indexed, shown and edited; only their changes aren't
saved as versions. Changing the list applies at once, and what the history
already holds stays. [History](history.md) explains the modes, what an
exclusion does to a note that moves in or out, and how to remove something
from the history for good.

### `mcp.instructions`

```yaml
mcp:
  instructions: spaces/Home/For agents   # .md is added if missing
```

A note whose text the MCP server gives connected agents as instructions,
after vihko's own: how your notes are organised, what goes where. It must be
inside a space, and an agent only gets it if it can read that note (its
person reads it, its key reaches the folder, and the note isn't closed to
agents): a note in a shared space reaches its members' agents. It's read
fresh for each request, so editing the note is enough. See
[Agents](agents.md).

`{user}` in the path is the username of the person the agent acts for, so
each person can keep their own guide in their own space:

```yaml
mcp:
  instructions: people/{user}/For agents
```

Someone without that note gets vihko's instructions alone. A shared space and
a person can add a guide of their own after this one (`agents` in their
[settings](#settings-of-a-person-or-a-space)).

### `permissions`

```yaml
permissions:
  spaces/Home:                     # a shared space: its members
    grants: { noa: manage, "@family": edit }
  spaces/Home/recipes:             # adds sam, who isn't a member of Home
    grants: { sam: read }
  spaces/Home/finances:
    ai: false                      # closed to agents, with everything under it
  people/noa/trips:                # a folder of Noa's, shared with Sam
    grants: { sam: comment }
  people/noa:
    ai: false                      # all of Noa's space closed to agents
```

The shared spaces and who shares what, folder by folder. vihko writes this
section itself when people share folders and manage spaces in the UI, so you
rarely need to touch it. [Spaces, people and sharing](users-and-permissions.md)
explains the model in plain words; this is the exact reference of what the
file accepts.

**Without the section** (or without the file), nothing is shared: each person
has their own space, and nobody else's. A shared space's folder without a rule
at its root has no members, and the admins get an alert to assign it a
manager.

**Keys** are real folders, from the notes root:

| Key | What it can hold |
|---|---|
| `spaces/<name>` (a shared space's root) | `grants`, `ai` |
| A folder below a shared space's root | `grants`, `ai` |
| `people/<user>` (a person's space) | Only `ai: false`. A person's space is never shared whole: share a folder in it, or use a shared space |
| A folder inside a person's space, `people/<user>/<folder>` and below | `grants`, `ai` |

Anything else **rejects the section**: `""` (the root), `people`, `spaces`, a
folder outside them, a `{user}` segment, grants at `people/<user>`, `name`
anywhere but a shared space's root, or the same folder written twice. Quote a
key that YAML would read as something else.

**Each rule** takes these keys, all optional:

| Key | Value | Meaning |
|---|---|---|
| `grants` | map of subject → level | Who gets what in this folder and below. Left out, or `{}`: nobody is added here |
| `ai` | `false` | Closes the folder and everything under it to agents |

A shared space's name is its folder's: there's no key for it. (0.1.0-rc.1
and rc.2 wrote `name` at a shared space's root, with a folder like
`spaces/home-7k2q9x`; vihko renames such a folder to that name when it
starts and removes `name`.)

**Subjects** in `grants`:

| Subject | Who |
|---|---|
| `noa` | The user with that username |
| `"@family"` | Everyone in the group `family` (quote it: `@` can't start a plain YAML key) |

User and group names are compared without regard to case, and a subject can't
appear twice in one rule. Groups are created in the UI (Preferences → Users
and groups), not in this file.

**Levels**, from less to more: `read`, `comment`, `edit`, `manage`. What each
allows is in [Spaces, people and sharing](users-and-permissions.md#members).

**How a person's level in a folder is worked out:**

1. **In their own space** (`people/<their username>/…`): `manage`, whatever
   the file says.
2. **In the space of someone deleted**: nothing, for everyone.
3. **Anywhere else, grants only add.** Their level is the highest that the
   grants of the folder, and of every folder above it up to its space's root,
   give them, by name or through any of their groups. A subfolder never gives
   anyone less than its parent.
4. **Being an admin adds nothing.**
5. **`ai: false`** holds for the folder and everything under it, on top of any
   note's own `ai: false`. `ai: true` never reopens anything: vihko ignores it
   and warns.

**Unknown users and groups** in `grants` are ignored, with a warning, so that
deleting someone never invalidates the section. **Rules for folders that
don't exist** (moved or deleted outside vihko, or not seen yet on a network
disk) are kept, and apply again if the folder comes back; whoever manages
that space gets an alert. When vihko creates a folder, it first drops any
rule left over at that path, so a new folder never inherits a forgotten
audience.

#### The section is strict

Anywhere else in the file, a key vihko doesn't know is ignored with a warning.
In `permissions`, **anything doubtful rejects the whole section**: an unknown
key (a typo such as `grant:`), a level that doesn't exist, a subject written
wrong, a key that isn't allowed. Then:

- if vihko **starts** that way, nothing is shared until you fix it: each person
  keeps their own space, and nobody sees anything else;
- if it happens **while vihko runs**, the last valid section stays in force.

Either way admins get an alert with the reason and the line. vihko never fails
open. A mistake elsewhere in the file (a bad series pattern, say) doesn't touch
the permissions.

> **Whoever can write `vihko.yaml` on disk decides who reads what.** Protect
> it like a password file. Deleting it, or its `permissions` section, unshares
> everything: each person keeps only their own space. While vihko runs, that
> takes effect once the file has stayed without the section for 2 seconds: a
> file an editor empties for an instant while saving it changes nothing.

#### How vihko writes the permissions

vihko writes `permissions` itself when someone shares a folder or changes its
grants from the UI; when someone creates, renames, leaves or deletes a shared
space; when the admin assigns a manager, joins a space or settles a deleted
person's space; when a folder is moved or deleted from vihko (its rules move
or go with it); when a user is deleted (their grants are removed); and when a
group is renamed or deleted (its grants follow).

- Only the entries that change are rewritten, in place. Comments, blank lines,
  quoting, key order and every other section stay byte for byte. A comment on a
  rule's line, or at the end of its `grants:` line, is kept. The exception is a
  section written in flow style over several lines (`{ … }` spanning lines):
  vihko rewrites it keeping comments and order, but not its spacing.
- Writes are atomic (a temporary file renamed into place), and never over a
  file that changed since vihko read it: if you saved it by hand in between,
  the dialog reloads and asks you to review your change.
- vihko won't edit a file it can't use (not valid YAML, or a rejected
  section): fix it by hand first. The dialog says so.
- A shared space's root keeps its rule, with its `name`, even with no grants
  left.

A folder renamed or moved **outside vihko** (a shell, another app) leaves its
rules behind. Notes vihko recognises as having moved to where someone who
didn't read them would are held, hidden from everyone, until someone who
could have made that move releases them. See
[Spaces, people and sharing](users-and-permissions.md#folders-moved-outside-vihko).

## Settings of a person or a space

`vihko.yaml` is for the whole installation, and only an admin with access to
the disk edits it. A person can add their own daily notes, templates and
guide for agents, and a shared space its own, without touching it: each
space has a settings file, in the same format for both. This is the
reference; step by step, from the UI:
[your own](first-steps.md#set-up-your-own-notes) and
[a shared space's](users-and-permissions.md#a-shared-spaces-notes).

| Whose | File | Edited from |
|---|---|---|
| A person's own | `people/<username>/.vihko/settings.yaml` | Preferences › «Your note settings» (or «My notes» › «Settings…» in the sidebar) |
| A shared space's | `spaces/<name>/.vihko/settings.yaml` | The space's «Settings…» in the sidebar (its managers) |

```yaml
version: 1

daily:
  journal:
    label: Journal
    folder: journal/{YYYY}      # inside this space
    name: "{YYYY}-{MM}-{DD}"
    template: Templates/Daily

templates: Templates            # a folder, or a list of folders

attachments:                    # where new images of this space's notes go
  mode: folder
  folder: images

agents: For agents              # a note of this space: its guide for agents
```

- **Every path is relative to the space**: `journal/{YYYY}` in Noa's file is
  `people/noa/journal/{YYYY}`. Nothing in the file names `people/` or
  `spaces/`, so renaming a space changes nothing in it. A path can't leave
  the space (`..`, a leading `/`) or enter a hidden folder, and `{user}`
  isn't allowed in a series (the space already says whose it is).
- The keys mean what they mean in `vihko.yaml`: [`daily`](#daily-daily-notes),
  [`templates`](#templates), [`attachments`](#attachments-where-new-images-go),
  and `agents`, which is the space's [`mcp.instructions`](#mcpinstructions).
  `version` is the format's number, `1` now; a file without it is version 1.
- **Who reads and changes it.** A person's file is theirs alone. A shared
  space's file is changed by its managers, and read by its members only to
  apply it; someone who isn't a member never reads it. Nobody sees the file
  as a note: `.vihko/` is hidden, never indexed, never served and never in a
  note's history.
- **vihko writes it** when someone saves the form, atomically, and only the
  keys that changed: comments and key order stay. You can also edit it by
  hand while vihko runs; it applies at once.

### How they add up

| Setting | What a person gets |
|---|---|
| Daily-note series | `vihko.yaml`'s, those of the shared spaces they belong to, and their own: those where they can write today's note. Two series that give the same note are one (the first in that order is kept), so a personal series that repeats one of the installation's isn't offered twice. They're listed the other way round, their own first: until a person chooses, the first is the default |
| Templates folders | `vihko.yaml`'s, those of their spaces, and their own: those they can read |
| Where new images go | For a note of a space, that space's setting if it has one; otherwise `vihko.yaml`'s |
| Guide for agents | `vihko.yaml`'s, then that of each shared space the agent's key reaches, then the person's own, in that order. Each is a note the agent must be able to read |

An example with all three, in plain words: [How the installation's, the
space's and yours add up](users-and-permissions.md#how-the-installations-the-spaces-and-yours-add-up).

A space's series get an id of their own (`me-<id>` for one's own space,
`sp-<code>-<id>` for a shared one's), so they never take the id of one in
`vihko.yaml`.

### When a settings file is wrong

A file edited by hand can have mistakes. vihko applies what it can:

- a key it doesn't know is ignored; a key with a wrong value (a series with a
  bad pattern, a path out of the space) is left out, and the rest applies;
- a file that isn't valid YAML applies nothing;
- a `version` newer than vihko's applies what vihko understands.

Each mistake is an alert, with its line, **to whom the file belongs**: the
person, for their own; the managers, for a shared space's. Never to the
admin as such. The form refuses to save settings with a mistake and says
which.

## When something is wrong

vihko never refuses to start because of `vihko.yaml`, and it never guesses what
a wrong setting meant.

| Problem | What happens |
|---|---|
| A key vihko doesn't know (a typo, or a setting from a newer vihko) | Ignored; an alert lists it with its line. The rest applies |
| A `version` newer than vihko's | What vihko understands applies; an alert says so |
| A known key with a wrong value (a path outside the notes folder, a bad series pattern, `mode: sometimes`) | The file can't be used. vihko keeps the last valid version it read; if there is none since it started, nothing is configured (no daily notes, no templates). The permissions section is judged on its own |
| A series, templates folder or `mcp.instructions` outside the spaces | Ignored, with a warning (`outside_spaces`) |
| Not valid YAML, or can't be read | As above, and the permissions can't be read either: the last valid ones stay, or nothing is shared if vihko started that way |
| Anything doubtful in `permissions` | The section is rejected ([see above](#the-section-is-strict)); the rest applies |
| `ai: true` in a rule | Ignored, with a warning |
| A grant to a user or group that doesn't exist | Ignored, with a warning |
| Rules for a folder that doesn't exist | Kept; an alert to whoever manages its space |
| A series' template that doesn't exist | Its notes are created empty, with an alert |

A warning about a `permissions` key in a space the admin doesn't read never
names that folder to them.

What the alerts list depends on whether the file can be used:

- **It can't be used**: every mistake that makes it unusable is listed at
  once, each with its line (and in the log). Not valid YAML stops the reading
  at the first syntax mistake, so only that one is listed. The file's
  warnings aren't listed yet: the warnings you see are those of the version
  in force, the last valid one. Fix the errors, and the file's own warnings
  show up.
- **It can be used**: every warning is listed at once, each with its line.

Fixing the file is enough: vihko picks it up within seconds, without a
restart, and lists whatever is left.

## Format changes on upgrade

When a new version of vihko changes how something is written in `vihko.yaml`,
vihko rewrites the file itself **when it starts**, before reading it:

- It changes only what the new format needs, and keeps comments, key order and
  keys it doesn't know. Running it again changes nothing. It also raises
  [`version`](#version) to the new format's number.
- It first copies the file as it was to the state volume, in
  `config-backups/` (`config-backups/vihko.yaml.<date and time>`), never to
  the notes folder. It keeps the latest 10 copies.
- Each rewrite goes to the log and to the admins' alerts, with what changed
  and where the copy is, until an admin dismisses it.
- A file that isn't valid YAML, or can't be written, is left as it is, with an
  alert; the next start tries again.
- vihko never rewrites the file while it runs. An old form you write by hand is
  still read until the next start rewrites it.

vihko 0.1 has no format changes yet: this is how later versions will apply
theirs. The release notes of each version list them. To undo one, stop vihko,
put the copy back as `vihko.yaml`, and start the version you were running
before (see [Upgrading](upgrading.md)).
