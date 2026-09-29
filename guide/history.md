# History

vihko keeps every change to your notes as a version, with who made it: a
person in the editor, an agent, vihko itself, or another program writing to the
folder. You can see what changed, compare versions, and undo, from the UI.

It's on by default. It's also the safety net for agents: before any agent
writes, the version from right before it is kept.

## Where the history lives

In the **managed** mode (the default), vihko keeps its own git repository in
the state volume, `history.git`, next to `state.db`. It isn't in your notes
folder, and vihko never pushes it anywhere.

- Your notes folder stays yours: no `.git` of vihko's in it. If you already
  keep your own git repository there, vihko doesn't read or touch it (unless
  you ask for [the unmanaged mode](#modes)).
- Copying the notes folder doesn't copy the history. **Back up the state
  volume** too; see [Backups](backups.md).
- `history.git` is a normal (bare) git repository: you can look at it with git
  itself, for instance
  `git --git-dir=/path/to/state/history.git log --stat`. Don't write to it.

## What goes into the history

- Every file in the notes folder that vihko doesn't ignore: notes by their
  text, images and other files by their bytes.
- Up to `history.maxFileSize` per file (20 MB by default). A larger file gets
  no versions, and an alert lists it for whoever can read it.
- Not the paths listed in `history.exclude`. Those files are still indexed,
  shown and edited; only their changes aren't saved. The note's History tab
  says so.
- `vihko.yaml` too, so permission changes have a version with their author,
  but its history isn't shown to anyone in vihko.

These settings are in [`vihko.yaml`](configuration.md#history).

## How versions are grouped

A version is a note (or file) as it was at a moment, with its authors.

- **Typing in the editor** builds up one open version per note. It closes after
  30 seconds without changes, or 5 minutes after it opened. People writing
  together in that window share the version. Someone who starts writing where
  others were first closes their version, with the text from right before, and
  goes on in a new one.
- **Every other write is a version of its own**: an agent's, a restore,
  creating, deleting or moving a note, uploading an image, a change made
  outside vihko. Right before it, whatever was pending on that file is closed.
  That's why «the version right before the agent» always exists.
- **Several writes in a row by the same agent** (five edits, say) build up
  one version, with the same 30 seconds / 5 minutes rule.
- **vihko's own operations**, such as rewriting links after a rename, are
  saved at once, as one change with everything they touched. Moving a note is
  two: the move, by whoever moved it, and the link updates, by vihko on their
  behalf.

While a version is still open, the History tab shows «In progress · saved in a
few seconds» at the top.

## Browsing a note's history

Open a note, then the side panel's **History** tab. You need `edit` on the note:
sharing a note to read doesn't share its past.

- Versions are grouped by day, in your timezone. Each row shows the time, the
  authors, why (for vihko's own changes), and how many words and punctuation
  marks were added and removed. Created, moved, deleted and restored versions
  are marked.
- A note's history follows it across renames and moves made from vihko, and
  across those made outside vihko that vihko recognised as the same note.

Selecting a version shows it in place of the editor, read-only, with the changes
marked word by word:

- «Compare with»: the previous version, or the note as it is now.
- «Change N of M» steps through the changes; «Content only» shows the text
  without marks, and «Copy the text» copies it, to rescue a paragraph.
- «Back to the note» (or Esc) returns to the editor, where you left it.
- The version is in the page's address (`?version=…`), so the browser's back
  button and links to it work.

### Restoring a version

«Restore this version» replaces the note's text with that version's, for
everyone who has it open. It asks you to confirm first.

- The restore is a new version («Restored from the version of …»), so it can be
  undone the same way.
- Images the version linked that no longer exist come back from the history,
  never over an image that's there now. vihko tells you which ones it brought
  back and which it couldn't (not in the history, or a different image has
  the name).
- On a version that deleted the note, the button reads «Restore it as it was
  before»: the note comes back.
- A version of a note that has moved since opens where the note is now. If
  the note no longer exists anywhere, restoring creates it again.

### Reverting one change

«Revert this change» undoes only what that version changed, on the note as it
is now, and keeps everything written since. It's the way to undo an agent's
edit without losing what you wrote after it.

- It shows first what it will undo, and what it can't: a part changed again
  since is left as it is and listed.
- Changes on different lines never clash. Within one line, they clash if they
  touch.
- The result is a new version, and can be undone.
- A version that created or deleted the note can't be reverted (restore
  instead); reverting a move doesn't move the note.

## Who wrote what

Every version names its authors, always with an icon and a text, never by
colour alone:

| Author | Shown as |
|---|---|
| A person | Their name, with their colour |
| An agent | The key's name «on behalf of» its person, with the agent mark (◆) |
| vihko | «vihko», with what it did: «Links updated when “Plan” was renamed to “Launch plan”, by Noa» |
| Another program | «Outside vihko», or «Outside vihko · while vihko was stopped» |
| Your own git (unmanaged mode) | The commit's author |

vihko looks names up when it shows them, rather than storing them in each
version. Deleted people and revoked keys keep their names in the history.

## Recent changes

«Recent changes», in the sidebar, lists what changed across the notes, newest
first and grouped by day: when, who, why, and which files, with what was
added and removed. Opening a file shows that version, from where you can
restore or revert it.

- Filter by author: a person, all agents or one key, vihko, or outside
  changes. It's the place to review what an agent did.
- You only see changes to notes where you have `edit`. A change that touched
  nothing you can edit doesn't appear.

## Resolved comments

Resolving a comment thread deletes it from the note, but the history keeps it.
At the bottom of the Comments tab, «Resolved» lists the threads that left the
note in the last 30 days: the whole thread, who resolved it and when.
«Reopen» puts the thread back after the text it commented, while that text is
still in the note.

«Resolved by» names every author of the version that removed the thread: when
several people were typing in the same version, that's all of them.

Without the managed history, resolving asks for confirmation, since it can't
be undone (in the unmanaged mode, only threads that reached one of your commits
come back).

## Changes made outside vihko

When a file changes and vihko didn't write it (another editor, a sync tool, a
script), the new content is a version by «Outside vihko»:

- vihko sees it through its file watcher, the periodic rescan, and a full
  sweep of the folder against the history every hour.
- Changes in a row to one file build up one version, with the same 30 seconds
  / 5 minutes rule. Any write of vihko's to that file closes it first.
- Its date is the file's modification time.
- What changed while vihko was stopped is found when it starts, and marked
  «while vihko was stopped».
- Moves and deletions made outside are versions too; a move vihko recognises
  keeps the note's history together.

The history never blocks a write. If git fails (missing, disk full, a damaged
repository), notes are still saved, what's pending waits in the state volume,
vihko retries on its own, and admins get an alert. If git fails for so long
that 5,000 changes wait, the oldest are merged into later ones: some versions
in between are lost, never content or authors, and an alert says so while it
lasts.

## Keeping things out: `history.exclude`

```yaml
history:
  exclude:
    - archive/**
    - "**/*.pdf"
```

- Changing the list applies at once. What the history already holds stays; to
  remove it, [purge it](#purging).
- A note moved into an excluded folder leaves the history (for the history,
  it's deleted by whoever moved it); moved out, it enters, with its content.

## Modes

`history.mode` in `vihko.yaml`:

| Mode | What it does |
|---|---|
| `managed` (default) | vihko keeps its own history in the state volume, as described on this page |
| `unmanaged` | vihko only **reads** the git repository your notes folder is in, and never writes to it |
| `off` | No history. The History tab and «Recent changes» are gone |

**Switching.** Turning it `off` stops recording and keeps `history.git` as it
is. Turning it back to `managed` resumes: a first version by vihko, «History
resumed: what changed while it was off», takes in what changed meanwhile,
attributed to nobody. The very first time, a version «History turned on: the
starting point» holds every file.

**Unmanaged mode** is for a folder you already version with git yourself:

- The repository can be the notes folder's own, or one it's inside.
- A version is one of your commits, by its author. Only what you've committed
  shows up; vihko says so in the History tab.
- Restoring or reverting writes the file, as a person would: for your git,
  it's an uncommitted change.
- Renames are followed with git's own rename detection, which only
  recognises files more than 50% alike.
- Purging isn't available: the repository is yours.
- Without a repository, admins get an alert, and the History tab says so.

With the API or MCP on and the history not `managed`, admins get an alert:
what an agent writes gets no version of its own in vihko to undo it by.

## Purging

Everything stays in the history for good. Purging rewrites the history without
something that should never have been kept, such as a password pasted into a
note. It can't be undone.

### From the UI

- **Whoever manages a folder** purges one of its notes: «Purge this note's
  history…» in the History tab takes every version of that note out, and
  «Purge this version…», on a version, takes out only what that version
  wrote (wherever it was, what was there right before stays). It never touches
  other notes, or what's under a folder.
- **An admin** purges any path by its name, a note or a whole folder, or one
  version of a note, with «Purge from the history…» in **Recent changes**,
  without having to read it. When it includes something the admin
  can't read, they confirm at the moment (their app's code, or their
  password).

Before purging, vihko shows how many versions are affected, and warns when the
same content is still in the history elsewhere (a copy of the note, or its
versions from before a move). While it rewrites, the history pauses for a few
seconds.

Afterwards:

- The admins get a notice with the path and who purged it, and so does every
  person who wrote in what went (agents and whoever purged aside). Never the
  content; the path only while they can still read it.
- **The note itself doesn't change.** If it still holds what you wanted gone,
  edit it too: its current text enters the history again with its next
  version.
- The trash, and the recovery copies of open notes in the state volume,
  aren't touched.

### From the command line

`vihko history purge` does the same with vihko stopped, from the server, and
can dry-run:

```sh
docker compose stop vihko
docker compose run --rm vihko vihko history purge projects/secrets.md --dry-run
docker compose run --rm vihko vihko history purge projects/secrets.md
docker compose start vihko
```

- The path is a file or a folder, relative to the notes folder: it goes from
  every version. With `--version <id>` (a version's id, as in `?version=<id>`;
  7 characters are enough), only what that file held in that version goes.
- `--dry-run` lists the versions and files it would change, and changes
  nothing. It works with vihko running.
- The real purge refuses while vihko runs on the same state volume. If it's
  stopped half way, the history stays as it was; running it again finishes.
- Everything else keeps its authors, dates and moves. A version left with no
  change is dropped, and the versions after the first rewritten one get new
  ids. The repository is compacted: the content is in no commit, reflog or
  pack, unless the same content is also stored under another path, which the
  command reports.
- If the file is still in the notes folder, it enters the history again with
  its next version: delete it, or add it to `history.exclude` first (the
  command warns).

## Known limits

- A note's history is shown only to people who can edit it **now**. Someone who
  lost `edit` loses its history with it, and regains it with it.
- People typing in the same 30-second window share a version, so «resolved by»
  and the version's authors can name more than one person.
- Someone with `comment` makes versions (their comments) of a note whose history
  they can't see.
- In the unmanaged mode, renames with big changes, and history with branches,
  may not be followed.
