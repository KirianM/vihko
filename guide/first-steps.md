# First steps in the app

A short tour of vihko's web UI, task by task: enough to start writing and
sharing. Every note you make is a Markdown file in the notes folder; what that
file holds is in [Notes and Markdown](notes.md).

The UI is in English or Spanish, following your browser's language.

## The screen

- **The sidebar**, on the left: «Folders» (the folder tree) and «Tags», the
  «Search or create…» box, and buttons for «New note», «New folder» and, when
  daily notes are set up, «Today's note». At the bottom: «Recent changes»,
  the workspace alerts when there are any, your name (it opens
  «Preferences») and «Sign out».
- **The note**, in the middle: its text, always editable in place (unless
  you only read it). Changes are saved on their own: the header says
  «Saving…» and then «Saved to disk».
- **The side panel**, on the right («Show the side panel» in the note's
  header): the note's «Comments», «Links», «Outline» and «History».

## Create a note

- Press **New note** (the `+` in the sidebar), type a name and press Enter.
  The note is created in the folder of the note you have open (at the root
  when none is open); the list says where: «Create “Plan” in projects».
- **In a given folder:** open the folder's menu in the tree (right-click the
  folder, press its `⋯` button, or long-press it on a phone) → **New note
  here**. Or type a path in New note: `projects/Plan` creates `Plan` in the
  folder `projects` inside the current folder, and `/projects/Plan` counts
  from the root of the notes; missing folders are created, and the list says
  where the note will go. The note's heading is only its name (`# Plan`).
- **From a template:** when `vihko.yaml` names a templates folder, New note
  also lists «From a template» (see [Configuration](configuration.md#templates)).

A note starts with its name as a `# Heading`. Write Markdown as usual: the
editor shows headings, lists, tasks and links formatted while you type.
`- [ ]` makes a task; Ctrl+Enter (⌘Enter on a Mac) checks it.

The bar above the note formats the selection, and its buttons show their
shortcuts (⌘ instead of Ctrl on a Mac): Ctrl+B bold, Ctrl+I italic,
Ctrl+Shift+S strikethrough, Ctrl+E inline code, and Ctrl+K a link, with text
selected (Ctrl+Alt+K anywhere). Pressed again, a format comes off.

## Folders

- **New folder** (the folder icon in the sidebar), or a folder's menu →
  **New folder inside…**.
- A folder's menu also has **Rename or move…** and **Delete folder**. An
  empty folder goes at once; otherwise the dialog lists what it holds and
  **Send to trash and delete** sends it all to the trash in one step, which
  **Restore** brings back. Hidden folders such as `.git/` must be removed with
  another tool first: vihko never touches them.

To delete a note: **More actions** (`⋯`) → **Move to trash**. It goes there
with the images only it uses; **Restore**, in the notice that follows (or its
history), brings both back.

## Link notes

Type `[[` and the start of a note's name: the list suggests notes by title,
file name and alias; Enter or Tab inserts the link. After the name, `#`
suggests the note's headings, and `|` the text to show instead.

- Click a link to open its note. A link to a note that doesn't exist yet is
  marked «missing»: click it and choose «create» to make that note.
- The side panel's «Links» tab lists the note's outgoing links and its
  backlinks (the notes that link here).

## Tags

Write `#` and a word anywhere in the text (`#projects`, `#projects/q4`): the
editor suggests the tags already in use. Tags in the frontmatter (`tags:`)
count the same. The sidebar's «Tags» tab lists them, with their notes.

## Search, and the ⌘K box

**Search or create…** in the sidebar, or Ctrl+K (⌘K on a Mac), opens one box
for everything (in a note, with text selected, Ctrl+K makes it a link
instead):

- **Find a note**: type words. It searches titles, aliases and text, ignoring
  accents, and shows each hit in context. With nothing typed, it lists your
  recent notes.
- **Filters**, alone or with words:

  | Filter | Keeps |
  |---|---|
  | `tag:projects` | Notes with that tag, or one nested under it |
  | `path:recipes/` | Notes in that folder and below |
  | `-tag:done`, `-path:archive/` | Leaves those out |
  | `path:"my notes/"` | Quotes for values with spaces |

  So `budget tag:projects -tag:done` finds «budget» in the open projects.
- **Create a note**: type a name that no note has and choose «Create».
- **Commands**: type `>` for the list: new note, today's note, insert image,
  dark or light theme.

## Rename or move a note

In the note's header, **More actions** (`⋯`) → **Rename or move…** (also in
the note's menu in the tree). Change the name, the folder, or both. Before you
confirm, the dialog shows which links will be updated; the button says how
many («Rename and update 3 links»). On a computer you can also drag a note or
a folder onto another folder in the tree; the same dialog opens when there are
links to update, or when the move changes who can see it.

vihko rewrites **every link to the note, in every note**, so none of them
breaks, and takes along the images only that note uses. Moving a folder does
the same for everything in it. The details: [Renames and moves](notes.md#renames-and-moves).

## Images

Paste an image, drop it on the note, or use **More actions** → **Insert
image…** to pick a file or give a web address. vihko stores the image in the
notes folder (next to the note, by default) and inserts the link. For an
address, «Save a copy» downloads the image and «Link to source» keeps only the
address. Where images go is set in [Configuration](configuration.md#attachments-where-new-images-go).

## Comments

Select some text and press **Comment on selection** in the side panel's
«Comments» tab (or Ctrl+Alt+M; ⌘⌥M on a Mac). Others reply under it, and
«Resolve» closes the thread, which removes it from the note. Comments are
stored inside the note: see [Comments](notes.md#comments).

## History

The side panel's **History** tab lists the note's versions, newest first, with
who changed what. Open one to see its changes, then **Restore this version**
or **Revert this change** (which undoes only that change and keeps later
ones). **Recent changes**, in the sidebar, lists what changed in all your
notes. A deleted note is restored from there. More in [History](history.md).

The history is for whoever can edit the note.

## Share a folder

People get access by folder, never by note. With `manage` on a folder (or as
an admin), open its menu in the tree → **Permissions…**, press «Change
permissions», add people or groups and pick a level: read, comment, edit or
manage. How levels, groups and personal folders work, and how an admin adds
people: [Users and permissions](users-and-permissions.md).

## Preferences

Your name, at the bottom of the sidebar, opens **Preferences**:

- **Timezone**: what day «today» is for you.
- **Daily note series**, and «Open today's note when vihko opens», when
  `vihko.yaml` declares daily notes ([Configuration](configuration.md#daily-daily-notes)).
- **Account**: the language, your password, the browsers you're signed in
  from, and two-step verification.
- **Users and groups** (admins): people, groups, and the settings.
- **Agents and API**: keys for scripts and assistants ([Agents](agents.md)).
- **Privacy**: what agents can see of your notes.

The sun or moon button, in the note's header, switches between the light and
dark theme (so does `>` in the ⌘K box).

vihko speaks English and Spanish. It starts in your browser's language; to
change it, go to Preferences → Account → Language, or type `>language` in the
⌘K box. The choice is saved in your account and follows you to every browser.

## On a phone

vihko works in the phone's browser, with the same features:

- The folder tree opens from the menu button in the note's header; «New note»
  and «Today's note» are there too.
- The search button in the header opens the same box as ⌘K.
- Under the note, a bar inserts a link (`[[`), a tag (`#`), a list item or a
  comment, and shows whether the note is saved.
- The phone's back button closes whatever is open on top.

To add it to the home screen as an app, vihko needs HTTPS: see
[Reverse proxy](reverse-proxy.md).
