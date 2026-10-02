# First steps in the app

A short tour of vihko's web UI, task by task: enough to start writing and
sharing. Every note you make is a Markdown file in the notes folder; what that
file holds is in [Notes and Markdown](notes.md).

The UI is in English or Spanish, following your browser's language.

## The screen

- **Home**, where vihko opens (you can change that: see
  [Home and «On opening»](#home-and-on-opening)): your recent notes, what others changed lately in the notes you
  read, what someone shared with you in the last 30 days, and buttons for a
  new note, today's note, search and a new space. The logo at the top of the
  sidebar always takes you there. Home only ever shows what you can read. Its
  heading has a house: a shared space called «Home» is something else (in
  the sidebar, every space has the mark of its kind).
- **The sidebar**, on the left: the «Search or create…» box, «New note»
  (the `+`) and, when daily notes are set up, «Today's note»; then «Folders»
  and «Tags». «Folders» has one section per space, each with the mark of its
  kind:
  - **My notes** (a person): your own space. Only you see it, except what
    you share.
  - **Each shared space** you belong to (two people), by its name, such as
    «Home».
  - **New space**, to create one.
  - **Shared with me**: folders other people share with you, with whose they
    are. Pin one and it gets a section of its own (a folder), next to your
    spaces, instead of being listed here.

  At the bottom: «Recent changes», the workspace alerts when there are any,
  your name (it opens «Preferences») and «Sign out». [Spaces, people and
  sharing](users-and-permissions.md) explains the spaces. The tree follows
  what other people create, rename, move or delete where you read, and what
  is shared with you, without reloading.
- **The note**, in the middle: its text, always editable in place (unless
  you only read it). Changes are saved on their own: the header says
  «Saving…» and then «Saved to disk».
- **The side panel**, on the right («Show the side panel» in the note's
  header): the note's «Comments», «Links», «Outline» and «History».
- **The pages** (Preferences → Account, Agents and API, Privacy…, and the
  alerts and «Recent changes»): «Back», at the top, returns to the note or
  Home you were on.

In the editor, the frontmatter (the block between `---` lines at the top of a
note) shows folded. Select all (Ctrl/Cmd+A) selects the text below it, and
nothing you delete, type or paste in the text reaches it: a note never loses
its `uid`, tags or `ai: false` by accident. To change it, open the folded
block and edit it there.

## Create a note

- Press **New note** (the `+` in the sidebar), type a name and press Enter.
  The note is created in the folder of the note you have open (in «My notes»
  when none is open); the list says where, and «Create in» lets you pick
  another space or folder.
- **In a given folder:** open the folder's menu in the tree (right-click the
  folder, press its `⋯` button, or long-press it on a phone) → **New note
  here**. A space's own menu has it too. Or type a path in New note:
  `projects/Plan` creates `Plan` in the folder `projects` inside the current
  folder, and `/projects/Plan` counts from the root of the current space;
  missing folders are created, and the list says where the note will go. The
  note's heading is only its name (`# Plan`).
- **From a template:** when there are templates you can read (notes marked
  as templates, in your space or a shared one), New note also lists «From a
  template»: see [Templates](#templates).

A note starts with its name as a `# Heading`. Write Markdown as usual: the
editor shows headings, lists, tasks and links formatted while you type.
`- [ ]` makes a task; Ctrl+Enter (⌘Enter on a Mac) checks it.

The bar above the note formats the selection, and its buttons show their
shortcuts (⌘ instead of Ctrl on a Mac): Ctrl+B bold, Ctrl+I italic,
Ctrl+Shift+S strikethrough, Ctrl+E inline code, and Ctrl+K a link, with text
selected (Ctrl+Alt+K anywhere). Pressed again, a format comes off.

## Folders

- A space's menu, or a folder's menu → **New folder
  inside…**.
- A folder's menu also has **Rename or move…** and **Delete folder**. An
  empty folder goes at once; otherwise the dialog lists what it holds and
  **Send to trash and delete** sends it all to the trash in one step, which
  **Restore** brings back. Hidden folders such as `.git/` must be removed with
  another tool first: vihko never touches them.

To delete a note: **More actions** (`⋯`) → **Move to trash**. It goes there
with the images only it uses; **Restore**, in the notice that follows (or its
history), brings both back.

## Link notes

Type `[[` and the start of a note's name: the list suggests the notes of the
same space by title, file name and alias; Enter or Tab
inserts the link. After the name, `#` suggests the note's headings, and `|`
the text to show instead.

- A link is the note's name: `[[Plan]]`. Links stay inside their space
  («My notes», or a shared space): a link to a note of another space is
  broken, even for someone who reads both.
- Click a link to open its note. A link to a note that doesn't exist yet is
  marked «missing»: click it and choose «create» to make that note. A link to
  a note you can't read looks just the same, on purpose.
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
  | `type:decision` | Notes whose frontmatter has `type: decision` (any key, written as it is; in a list, any item) |
  | `prop:due` | Notes whose frontmatter has a `due` key, whatever its value |
  | `prop:tag=urgent` | The same as `key:value`, for any key: also a name vihko keeps for its own filters (`tag`, `path`, `is`, `has`, `in`, `prop`, `before`, `after`) |
  | `-tag:done`, `-path:archive/`, `-status:done` | Leaves those out |
  | `path:"my notes/"`, `status:"in progress"` | Quotes for values with spaces |

  So `budget tag:projects -tag:done` finds «budget» in the open projects, and
  `type:decision -status:done` lists the decisions not yet done. Keys and
  values ignore case.
  Results come from every space you can read, each with its space; a `path:`
  is inside the space you're in.
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

The dialog's «Space» lets you move a note to another space. That changes who
sees it and whose it is («It stops being yours: it will belong to the members
of Home»): the dialog says so, lists the links that will be broken (links
never cross spaces), and asks you to confirm.

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

## Share

- **With a group of people, for good:** **New space**, in the sidebar, makes
  a shared space; add its members with a level (read, comment, edit or
  manage). Everything in it belongs to all of them. Its menu has
  «Members…», «Rename…», «Leave» and «Delete space…», and, for its
  managers, «Settings…»: the space's own daily notes, where its images go
  and its guide for agents, for all its members.
- **One folder of yours, with someone:** in «My notes», the folder's menu →
  **Share…**, add people or groups and pick a level. They find it under
  «Shared with me»; it stays yours.

Sharing only adds: everyone who sees a folder sees everything in it. Keep
what someone shouldn't see in another folder or another space. How levels,
groups and spaces work, and how an admin adds people:
[Spaces, people and sharing](users-and-permissions.md).

Step by step:
[make a space and invite people](users-and-permissions.md#step-by-step-make-a-space-and-invite-people),
[share a folder of yours](users-and-permissions.md#step-by-step-share-a-folder-of-yours),
[pin what's shared with you](users-and-permissions.md#step-by-step-what-others-share-with-you)
and [turn a folder into a space of its own](users-and-permissions.md#step-by-step-move-a-folder-to-a-new-space).

## Preferences

Your name, at the bottom of the sidebar, opens **Preferences**:

- **Timezone**: what day «today» is for you.
- **Daily notes and templates**, a box with two things that are easy to
  mix up:
  - **Daily note series** chooses which of the series you already have
    «Today's note» opens. It only shows when you have at least one.
  - **Your note settings** is where you make your own: daily note series,
    where your new images go and a guide for agents.

  [Set up your own notes](#set-up-your-own-notes) goes through both, step
  by step.
- **On opening**: what vihko shows when you come in without asking for
  anything else. See [Home and «On opening»](#home-and-on-opening).
- **Account**: the language, your password, the browsers you're signed in
  from, and two-step verification.
- **Users and groups** and **Spaces** (admins): people, groups, the
  directory of shared spaces, and the settings.
- **Agents and API**: keys for scripts and assistants ([Agents](agents.md)).
- **Privacy**: what agents can see of your notes.

The sun or moon button, in the note's header, switches between the light and
dark theme (so does `>` in the ⌘K box). The theme is kept on each device, not
in your account: your phone can stay dark while your computer is light.

vihko speaks English and Spanish. It starts in your browser's language; to
change it, go to Preferences → Account → Language, or type `>language` in the
⌘K box. The choice is saved in your account and follows you to every browser.

## Set up your own notes

Unless the admin set some up for everyone, vihko starts with no daily notes
and no templates. You can add your own without asking anyone: they live in
your space and apply only to you. A template is just a note marked as one;
daily notes are set in «Your note settings».

### «Daily note series» or «Your note settings»?

Both are in Preferences, in the box «Daily notes and templates», and they do
different things:

| | What it's for |
|---|---|
| **Your note settings** | **Making** things of your own: a daily note series, where your new images go, a guide for agents |
| **Daily note series** | **Choosing** which series «Today's note» opens, among all you have: your own, those of the shared spaces you're in (set by their managers) and the installation's (set by the admin). It only shows once you have one |

So to start a journal you go to «Your note settings» first, and then, if you
have more than one series, you pick it in «Daily note series».

«Your note settings» is also in the menu of «My notes» in the sidebar (its
`⋯` button, or right-click it) → **Your note settings…**. Every path you type there is
inside «My notes»: `Journal` means «My notes / Journal».

### A daily journal

Say you want one note per day in «My notes / Journal», a folder per year,
each starting with the same headings.

**First, the template** (skip it if your notes can start empty):

1. In the sidebar, open the menu of «My notes» → **New folder inside…**,
   type `Templates` and press **Create folder**.
2. Open the menu of the new «Templates» folder → **New note here**, type
   `Daily` and press Enter.
3. The note opens with its name, «Daily», as its heading. Replace the word
   with `{{title}}` (it stays a heading), and write below it what every day
   should start with. In Markdown:

   ```markdown
   # {{title}}

   ## Plans

   - [ ]

   ## Notes
   ```

   `{{title}}` becomes the new note's name, here the date. Other variables
   (`{{date}}`, `{{user}}`, `{{date:FORMAT}}`) are in
   [Templates](notes.md#templates). The template is a note like
   any other: you can change it whenever you like, and only the notes made
   after that use the new text. The folded «frontmatter · 1 key» at its top
   is the note's `uid`; each note made from it gets a new one.
4. In the tree, open the menu of «Daily» → **Make a template**. That writes
   `template: true` in its frontmatter: it keeps it out of search, the tags
   and Home, and «New note» offers it too (see [Templates](#templates)).

**Then, the series:**

1. Press your name, at the bottom of the sidebar: Preferences opens. Press
   **Your note settings**.
2. Under «Daily notes», press **Add a series**.
3. Fill in:

   | Field | Write | Means |
   |---|---|---|
   | Name | `Journal` | What vihko calls it in Preferences |
   | Folder | `Journal/{YYYY}` | «My notes / Journal», a folder per year |
   | Note name | `{YYYY}-{MM}-{DD}` (already there) | One note per day, named by its date |
   | Template (optional) | `Templates/Daily` | The note you just wrote |

4. Press **Save**.

The calendar button, at the top of the sidebar next to `+`, now shows («Today's
note», its tooltip says, with the shortcut). Press it (or **Today's note** on
Home, `>today's note` in the ⌘K box, or Ctrl+Alt+D, ⌘⌥D on a Mac): vihko creates today's note, «My notes / Journal / 2026 / 2026-10-01»,
from the template, and opens it. Pressed again the same day, it opens that
note; it never overwrites one. The arrows in the note's header go to the
previous and next notes of the series that exist.

For a note per week, write `{GGGG}-W{WW}` as the note name and leave the
year out of the folder (`Journal`); for one per month, `{YYYY}-{MM}`. The
rules are in [Configuration](configuration.md#daily-daily-notes).

**If you have more than one series** (yours, and one of a space you're in,
say): Preferences → **Daily note series** → pick the one «Today's note»
should open → **Save**. Until you pick one, it opens the first in that list:
your own series come first, then your spaces', then the installation's. The
first time you open «Today's note», the series it opened becomes your choice,
so a series a space adds later never takes its place: you change it only in
Preferences.

### Templates

A template is any note with `template: true` in its frontmatter, wherever it
is: no folder makes one. To make a note a template, open its menu in the tree
→ **Make a template**; **Stop being a template**, in the same menu, takes the
mark off. A folder of templates, made by hand or brought from another tool,
is marked all at once:

1. Open the folder's menu → **Mark notes as templates…**.
2. The dialog says how many notes (in the folder and its subfolders) will
   become templates, how many already are, and any it can't mark because
   their frontmatter can't be read.
3. Press **Mark as templates**.

Each note gets `template: true` added to its frontmatter, and nothing else of
it changes. Now **New note** (the `+`), with a name typed, also lists «From a
template»: «Create “Trip to Porto” from the template Daily». You're offered
every template you can read: yours and those of the shared spaces you're in,
grouped by space; a small mark next to its name in the tree tells a template
apart.

The new note starts with the template's text, its variables filled in, and
its frontmatter (`type: decision`, its tags…) without `template: true` and
without its `aliases`, so it isn't a template itself. Templates stay out of search, the tags and Home,
since they're skeletons, not notes anyone wrote; you still open and edit
them from the tree, and `template:true` in the search box lists them.

### Where your new images go

By default, an image you paste goes next to its note, named after it and the
time. To keep the images of «My notes» in one folder instead:

1. Your name → **Your note settings**.
2. **New images** → **All in one folder**, and **Folder of images**:
   `Images`.
3. Press **Save**.

An image you paste into a note of «My notes» now goes to «My notes /
Images», named after the note and the time (`Porto-2026-10-01-0812.png` for
a note called «Porto»), wherever the note is. **A folder for each note**
puts each note's images in a folder of its own next to it
(`Porto.assets/`). **As the installation says** goes back to the admin's
choice. Images already in your notes stay where they are. This only applies
to «My notes»: a shared space has its own setting.

### A guide for agents

If you use an assistant through vihko's MCP server (see [Agents](agents.md)),
a guide tells it how your notes are organised, so it puts things where you
would.

1. Make the note: in «My notes», **New note**, name it `For agents`, and
   write what an assistant should know. For example:

   ```markdown
   # For agents

   - My journal is in Journal, one note per day named by its date
     (2026-10-01), inside a folder per year.
   - Recipes go in Recipes, one note each, with the tag #recipe.
   - Write in English. Never change the notes in Archive.
   ```

2. Your name → **Your note settings** → **Guide for agents (a note)**:
   `For agents` → **Save**.

An agent acting for you gets the note's text when it connects, after
vihko's own instructions, the installation's guide and the guides of the
shared spaces its key reaches. Editing the note is enough: the next time it
connects, it gets the new text. It only gets it if it can read the note: if
the key is limited to some folders, or the note is closed to agents
(`ai: false`), it gets the rest without it. If the note doesn't exist (a
typo, or you haven't made it yet), saving says so and keeps the dialog open,
and an alert («Your guide for agents doesn't exist») stays until the note is
there.

### What's on the disk

Your settings are saved in a hidden file of your space, which the admin
finds on the server at `people/<your username>/.vihko/settings.yaml`. You
never see it in vihko and don't need to: the form writes it. Its format is
in [Settings of a person or a space](configuration.md#settings-of-a-person-or-a-space).

A shared space has the same settings, for all its members, set by its
managers: see
[A shared space's notes](users-and-permissions.md#a-shared-spaces-notes),
which also explains how the installation's, the space's and yours add up.

## Home and «On opening»

**Home** is the page vihko opens by default: your recent notes, what others
changed lately in the notes you read, what was shared with you in the last
30 days, and the buttons **Write a note**, **Today's note** (when you have a
daily series), **Open search** and **Create a space**. It only ever shows
what you can read. The vihko logo, at the top of the sidebar, always takes
you there.

To open something else when you come in:

1. Your name → Preferences → **On opening**.
2. Choose:
   - **Home, vihko's start page**, the default;
   - **The last note (on this device)**: the note you had open last in this
     browser. Your phone and your computer each remember their own;
   - **A specific note**: type part of its name in **Note** and pick it from
     the list (its name and where it is). It shows above the box once
     chosen;
   - **Today's note, if it already exists** (only when you have a daily
     series): coming in never creates it, so on a day you haven't written
     yet you get Home.
3. Press **Save**.

«On opening» only applies when you come in without asking for anything
else: a link to a note opens that note. If the note you chose is deleted, or
you can no longer read it, vihko opens Home.

## On a phone

vihko works in the phone's browser, with the same features:

- vihko opens at Home here too; the folder tree opens from the menu button in the header; «New note»
  and «Today's note» are there too.
- The search button in the header opens the same box as ⌘K.
- Under the note, a bar inserts a link (`[[`), a tag (`#`), a list item or a
  comment, and shows whether the note is saved.
- The phone's back button closes whatever is open on top.

To add it to the home screen as an app, vihko needs HTTPS: see
[Reverse proxy](reverse-proxy.md).
