# Workspace configuration: `vihko.yaml`

`vihko.yaml` holds the settings that belong to your notes rather than to the
server: permissions, daily notes, templates, where images go, how the history
is kept. It lives at the root of the notes folder, so it travels, and is backed
up, with the notes.

Settings that belong to the installation (ports, volumes, the public address,
the second factor's key) are environment variables instead: see
[Install](install.md).

## The basics

- **It's optional.** Without the file nothing is turned on: no daily notes, no
  templates, images next to their note, the history managed by vihko, and every
  admin manages the whole notes folder.
- **You edit it on disk**, with any text editor, while vihko runs. vihko reads
  it when it starts, when it changes (the file watcher) and on every periodic
  rescan (`VIHKO_RESCAN_SECONDS`, 60 seconds by default). No restart needed.
- **Nobody sees it in vihko.** It never shows up in the folder tree, as a note or
  as a file, and vihko serves it to nobody, admins included, because it holds
  the permissions. Its history isn't shown either.
- **vihko writes to it in two cases:**
  - when someone with `manage` on a folder changes its permissions in the UI
    (and when a folder moves, a folder or person is deleted, or a group is
    renamed): vihko rewrites only the entries of `permissions` that change,
    and leaves the rest of the file, comments and key order included, as it
    was. See [How vihko writes the permissions](#how-vihko-writes-the-permissions);
  - when it starts after an upgrade that changed the file's format. See
    [Format changes on upgrade](#format-changes-on-upgrade).
- **Problems show up as alerts**, never as a crash. Only admins see them, in
  the workspace alerts (the «N workspace alerts» link that appears in the
  sidebar). See [When something is wrong](#when-something-is-wrong).

## A complete example

```yaml
version: 1

templates: Templates

daily:
  journal:
    label: Journal
    folder: people/{user}/journal
    template: Templates/Daily
  team:
    label: Team log
    folder: team/log
  weekly:
    folder: team/weeks
    name: "{GGGG}-W{WW}"

attachments:
  mode: per-note

links:
  aliases: true

history:
  mode: managed
  maxFileSize: 20
  exclude:
    - archive/**
    - "**/*.pdf"

mcp:
  instructions: handbook/for-agents

permissions:
  "":
    grants: { admin: manage, "@staff": read }
  projects:
    grants: { "@staff": edit, lead: manage }
  people/{user}:
    grants: { "{user}": manage }
  people/{user}/journal:
    ai: false
```

## Reference

| Key | Type | Default | What it does |
|---|---|---|---|
| [`version`](#version) | whole number | `1` | Which format the file follows |
| [`templates`](#templates) | folder | none | Folder whose notes are offered as templates |
| [`daily`](#daily-daily-notes) | map of series | none | Daily, weekly, monthly or yearly notes |
| [`attachments.mode`](#attachments-where-new-images-go) | `next-to-note`, `folder` or `per-note` | `next-to-note` | Where new images go |
| [`attachments.folder`](#attachments-where-new-images-go) | folder | none | The folder for `mode: folder` |
| [`attachments.suffix`](#attachments-where-new-images-go) | text | `.assets` | The folder suffix for `mode: per-note` |
| [`links.aliases`](#linksaliases) | `true` or `false` | `true` | Whether frontmatter aliases resolve `[[links]]` |
| [`history.mode`](#history) | `managed`, `unmanaged` or `off` | `managed` | How note history is kept |
| [`history.maxFileSize`](#history) | number (MB) | `20` | Largest file that enters the history |
| [`history.exclude`](#history) | list of patterns | none | Paths kept out of the history |
| [`mcp.instructions`](#mcpinstructions) | note path | none | A note served to agents as instructions |
| [`permissions`](#permissions) | map of folder rules | every admin manages the root | Who reads and writes what |

Paths in the file are relative to the root of the notes folder, with `/`
between folders. They can't start with `/`, go through `..` or `.`, or enter a
hidden folder (a name that starts with `.`). A trailing `/` on a folder is
fine.

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
templates: Templates
```

A folder. Every note in it, subfolders included, is offered under «From a
template» when you create a note from the search box (Ctrl+K, or ⌘K on a
Mac). Templates are
plain notes, and you only see the ones you can read.

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
    folder: people/{user}/journal  # optional; the root if left out
    name: "{YYYY}-{MM}-{DD}"       # optional; this is the default
    template: Templates/Daily      # optional note
  weekly:
    folder: team/weeks
    name: "{GGGG}-W{WW}"
```

Each entry is a **series**: a folder and a name pattern that give one note per
day, week, month or year. The first series is the default. Each person picks
theirs in Preferences («Daily note series»), with the option to open today's
note when vihko opens (it only opens a note that exists; it never creates
one).

«Today» (in the sidebar, the search box's commands, or Ctrl+Alt+D, ⌘⌥D on a
Mac) opens the note for today in that person's timezone. If it doesn't exist,
vihko creates it from the template; it never overwrites a note. The note header
has buttons for the previous and next note in the series.

| Key | Default | Notes |
|---|---|---|
| id (the key) | — | Letters, digits, `-` or `_`, starting with a letter or digit, up to 64 characters |
| `label` | the id | Name shown in the UI |
| `folder` | the root | Folder pattern |
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

- **With `{user}`**, each person has their own series (`people/noa/journal/…`).
  **Without it**, the note of the day is one for everyone who can edit that
  folder, and they write it together.
- Permissions apply as to any note: someone who can't edit the folder can't
  create the note there.
- vihko finds the note of a period by its path alone. If you rename today's
  note, «Today» creates another one.
- Several series can use the same file names (`2026-09-28.md` in each
  person's folder). A `[[2026-09-28]]` link from elsewhere may then be
  ambiguous; add `{user}` to the name if that bothers you.
- If the template doesn't exist, the series' notes are created empty and an
  admin alert says so.

### `attachments`: where new images go

```yaml
attachments:
  mode: next-to-note   # next-to-note (default), folder or per-note
  # folder: images     # only with mode: folder
  # suffix: .assets    # only with mode: per-note
```

This decides where vihko puts an image you upload, paste or save from a URL.
Images already in your notes stay where they are.

| Mode | Where a new image goes | Example for `projects/plan.md` |
|---|---|---|
| `next-to-note` (default) | Next to the note, named after it and the time (UTC) | `projects/plan-2026-09-28-1012.png` |
| `folder` | All in one folder, with the same kind of name | `images/plan-2026-09-28-1012.png` |
| `per-note` | In a folder of its own next to the note, named after the note plus `suffix` | `projects/plan.assets/2026-09-28-1012.png` |

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
  taken or the folder holds notes. The move's preview says what happens.
- vihko stores PNG, JPEG, GIF, WebP and AVIF, recognised by their content, up
  to `VIHKO_MAX_IMAGE_MB` (20 MB by default). It shows SVG and other images
  that are already in the folder, but never stores a new SVG.

> **With several people, avoid `mode: folder`.** An image has the permissions
> of the folder it's in, so the image of a private note would end up where
> everyone who reads the images folder can see it. Admins get an alert while
> `mode: folder` is set and there is more than one user.

### `links.aliases`

```yaml
links:
  aliases: false
```

On (the default), the `aliases` in a note's frontmatter resolve `[[links]]` as a
last resort, after names and paths. Turn it off if you share the folder with a
tool where they don't, such as Obsidian:

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
    - archive/**
    - "**/*.pdf"
    - drafts/private.md
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
  instructions: handbook/for-agents   # .md is added if missing
```

A note of the workspace whose text the MCP server gives connected agents as
instructions, after vihko's own: how your notes are organised, what goes
where. An agent only gets it if it can read that note (its key reaches the
folder, and the note isn't closed to agents). It's read fresh for each
request, so editing the note is enough. See [Agents](agents.md).

### `permissions`

```yaml
permissions:
  "":                              # the root
    grants: { admin: manage, "@staff": read }
  projects:
    grants: { "@staff": edit, lead: manage }
  people/{user}:                   # one personal folder per person
    grants: { "{user}": manage }
  people/{user}/journal:
    ai: false                      # closed to agents, with everything under it
```

Who reads and writes what, folder by folder. [Spaces, people and sharing](users-and-permissions.md)
explains the model in plain words and how to use it from the UI; this is the
exact reference of what the file accepts.

**Without the section** (or without the file), every admin manages the root:
a one-person installation works with nothing written. The first change made in
the permissions dialog writes that implicit rule into the file along with the
change, so nothing is lost.

**Keys** are folders, from the notes root:

- `""` is the root. Quote a key that starts with `{` or `@`, or that YAML
  would read as something else (`yes`, `null`, a number); `people/{user}`
  needs no quotes.
- One whole segment may be `{user}` (`people/{user}`, `people/{user}/journal`):
  the rule then holds for every folder at that place, as the folder of the
  user it's named like. Only one `{user}` per key, and no other `{…}`.
- The same folder can't have two rules.

**Each rule** takes two keys, both optional:

| Key | Value | Meaning |
|---|---|---|
| `grants` | map of subject → level | Who gets what in this folder. Left out (or `null`), the folder inherits. `{}` gives nobody anything here |
| `ai` | `false` | Closes the folder and everything under it to agents |

**Subjects** in `grants`:

| Subject | Who |
|---|---|
| `noa` | The user with that username (2 to 64 letters, digits, `.`, `_` or `-`) |
| `"@staff"` | Everyone in the group `staff` (quote it: `@` can't start a plain YAML key) |
| `"{user}"` | The person the folder is named after. Only in a `{user}` rule |

User and group names are compared without regard to case, and a subject can't
appear twice in one rule. Groups are created in the UI (Preferences → Users
and groups), not in this file.

**Levels**, from less to more: `read`, `comment`, `edit`, `manage`. What each
allows is in [Spaces, people and sharing](users-and-permissions.md#members).

**How a folder's access is worked out:**

1. **Its own grants, or its nearest ancestor's.** A folder with `grants` of its
   own uses them; one without inherits those of the nearest folder above that
   has some. Grants of its own **replace** what it would inherit; they never
   add to it.
2. **The most specific rule wins.** A rule written for the folder itself beats
   a `{user}` rule that matches it, and either beats an ancestor's.
3. **A person's level** is the highest their grants give them, by name or
   through any of their groups.
4. **Managers from above keep `manage`.** Whoever manages a folder manages
   everything under it, even a subfolder whose own grants don't name them.
5. **Except personal folders.** A folder a `{user}` rule matches, and
   everything under it, gets no managers from above: only its own grants
   count. That's how an admin who manages the root still can't read other
   people's personal folders.
6. **A personal folder named after nobody** (a `{user}` rule at
   `people/old-name`, where no such user exists, or someone deleted) gives no
   grants at all: nobody sees it, admins included. It never falls back to
   what the root gives.
7. **`ai: false`** holds for the folder and everything under it, on top of any
   note's own `ai: false`. `ai: true` never reopens anything: vihko ignores it
   and warns.

Being an admin grants nothing here: an admin reads only what the rules give
them, like anyone else.

**Unknown users and groups** in `grants` are ignored, with a warning, so that
deleting someone never invalidates the section. **Rules for folders that don't
exist** (moved or deleted outside vihko) are kept, with a warning, and apply
again if the folder comes back.

#### The section is strict

Anywhere else in the file, a key vihko doesn't know is ignored with a warning.
In `permissions`, **anything doubtful rejects the whole section**: an unknown
key (a typo such as `grant:`), a level that doesn't exist, a subject written
wrong, a folder key with `..`. Then:

- if vihko **starts** that way, nobody can read any note until you fix it;
- if it happens **while vihko runs**, the last valid permissions stay in force.

Either way admins get an alert with the reason and the line. vihko never fails
open. A mistake elsewhere in the file (a bad series pattern, say) doesn't touch
the permissions, but a file that isn't valid YAML at all leaves nobody reading
anything if vihko starts that way.

> **Deleting `vihko.yaml`** (or its `permissions` section) puts the implicit
> rule back: every admin manages the root and so reads every note, since
> without a `{user}` rule there are no personal folders, and members read
> nothing. Protect the file like a password file: whoever can write it on disk
> decides who reads what. While vihko runs, the implicit rule only replaces the
> permissions in force once the file has stayed without them for 2 seconds: a
> file an editor empties for an instant while saving it opens nothing.

#### How vihko writes the permissions

vihko writes `permissions` itself when someone changes a folder's permissions
from the UI, when a folder is renamed, moved or deleted from vihko (its rules
move or go with it), when a user is deleted (their grants are removed) and when
a group is renamed or deleted (its grants follow).

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
- A rule for a folder nobody has any grants left in (the only person granted
  was deleted) stays as `grants: {}`: the folder stays closed rather than
  starting to inherit from above.
- `{user}` rules are written by hand; the dialog shows them in each personal
  folder but doesn't create them.

A folder renamed or moved **outside vihko** (a shell, another app) leaves its
rules behind, and vihko can't always tell where it went. When it recognises
the notes that left, it holds them hidden from everyone and alerts the admin
and the folder's managers: move the permissions with them, or release them so
the folder they're in now applies. Notes that came out of a personal folder
are its owner's to decide; the admin only learns that they're held. See
[Spaces, people and sharing](users-and-permissions.md#folders-moved-outside-vihko).

## When something is wrong

vihko never refuses to start because of `vihko.yaml`, and it never guesses what
a wrong setting meant.

| Problem | What happens |
|---|---|
| A key vihko doesn't know (a typo, or a setting from a newer vihko) | Ignored; an alert lists it with its line. The rest applies |
| A `version` newer than vihko's | What vihko understands applies; an alert says so |
| A known key with a wrong value (a path outside the notes folder, a bad series pattern, `mode: sometimes`) | The file can't be used. vihko keeps the last valid version it read; if there is none since it started, nothing is configured (no daily notes, no templates). The permissions section is judged on its own |
| Not valid YAML, or can't be read | As above, and the permissions can't be read either: the last valid ones stay, or nobody reads anything if vihko started that way |
| Anything doubtful in `permissions` | The section is rejected ([see above](#the-section-is-strict)); the rest applies |
| `ai: true` in a rule | Ignored, with a warning |
| A grant to a user or group that doesn't exist | Ignored, with a warning |
| Rules for a folder that doesn't exist | Kept, with a warning |
| A series' template that doesn't exist | Its notes are created empty, with an alert |

What the alerts list depends on whether the file can be used:

- **It can't be used**: every mistake that makes it unusable is listed at
  once, each with its line (and in the log). Not valid YAML stops the reading
  at the first syntax mistake, so only that one is listed. The file's
  warnings (an unknown key, what's wrong in `permissions`) aren't listed yet:
  the warnings you see are those of the version in force, the last valid one.
  Fix the errors, and the file's own warnings show up.
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

vihko 1.0 has no format changes yet: this is how later versions will apply
theirs. The release notes of each version list them. To undo one, stop vihko,
put the copy back as `vihko.yaml`, and start the version you were running
before (see [Upgrading](upgrading.md)).
