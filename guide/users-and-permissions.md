# Spaces, people and sharing

vihko is made for one group: a family, a team, a few friends who know each
other and trust whoever runs the server. Everyone signs in with their own
account and has a space of their own. What belongs to several people goes in
a shared space, and a folder of your own can be shared with someone in
particular. This page is for everyone who wants to know who sees their notes,
and for the admin who adds people.

Everything here happens in the UI. Your own account (language, password,
second factor, sessions) is in **Preferences** → «Account»; people and groups,
for the admin, in «Users and groups»; the shared spaces of the installation,
for the admin, in «Spaces». How it's written in `vihko.yaml` is in
[Configuration](configuration.md#permissions).

## Three kinds of place

| | What it is | Whose | In the notes folder |
|---|---|---|---|
| **My notes** | Your own space | Yours: only you see it, except what you share | `people/<your username>/` |
| **A shared space**, such as «Home» | A place for what belongs to several people | Its members': everyone in it sees everything in it | `spaces/<name>/`, such as `spaces/Home/` |
| **Shared with me** | Folders other people share with you from their own space, or a folder of a shared space you're not a member of | Still theirs, or still the space's | Where they are: `people/ana/trips/` |

The sidebar shows them in that order: «My notes», then each shared space you
belong to, by name, then «Shared with me». A folder in «Shared with me» can be
pinned (its menu → «Pin to the sidebar»), and then it gets a section of its
own, next to your spaces. It shows with its real name and whose it is
(«trips · ana’s»); you can't rename or move it, since it isn't yours.

**A new person** sees «My notes», empty, and can start writing at once.
Nothing else shows until someone adds them to a space or shares a folder with
them.

### One group per installation

The vihko admin manages people, groups and settings, but **doesn't read other
people's notes**: being an admin gives access to nothing. The admin sees the
names of the shared spaces, who manages each and how many members it has,
never what's inside, and never the folders people share from their own space.

That is a rule of vihko's interface. Your notes are plain files on the
server's disk, and **whoever can open the server's disk can read them**,
everyone's: the person who runs the server, a backup, anyone with access to
the machine. So one installation is for one group that trusts whoever runs
it. Groups that don't know each other should each have their own
installation; vihko doesn't keep several isolated groups apart in one.

## Roles

| | Member | Admin |
|---|---|---|
| Has their own space, «My notes» | ✓ | ✓ |
| Reads and writes what is shared with them | ✓ | ✓, the same |
| Creates shared spaces | ✓ (unless the admin reserves it to admins) | ✓ |
| Shares a folder | Where they manage it | Where they manage it, the same |
| Manages users, groups and settings; sees system alerts | | ✓ |
| Sees the directory of shared spaces (names and managers, never content) | | ✓ |

## Shared spaces

### Step by step: make a space and invite people

Say Noa wants a place for the household, which Sam can write in and Ana,
who lives elsewhere, can only read.

1. In the sidebar, press **New space** (or **Create a space** on Home).
2. **Name**: `Family`. Everyone in the installation can see a space's name,
   never what's in it.
3. Under **Members (optional)**, choose `sam` in «Add…», `Edit` as the
   level, and press **Add**. Do the same for `ana` with `Read`. You can also
   leave it empty and add people later.
4. Press **Create space**.

«Family» shows in the sidebar, under «My notes», and you manage it. Sam and
Ana see it at once in their sidebar, and a notice: «noa added you to
Family». On the server it's the folder `spaces/Family/`.

**Adding someone later, or changing their level:**

1. Open the space's menu: its `⋯` button in the sidebar, or right-click its
   name → **Members…**.
2. To add: choose the person or group in «Add…», a level, and press **Add**.
   To change a level, pick another one in that person's row; to take
   someone out, press the `×` on their row. Your own row has **Leave**
   instead of a `×`, so you can't lock yourself out by mistake.
3. Press **Save**. Nothing changes until you do. If you close the dialog
   (its button, Escape or a click outside) with changes not saved, it asks
   first: **Keep editing**, **Discard changes** or **Save and close**.

**Which level to give** (the full table is under [Members](#members)):

| Level | For someone who… |
|---|---|
| Read | only reads: a relative who looks up the recipes |
| Comment | reads and leaves comments, without changing the text |
| Edit | writes: creates, changes, moves and deletes notes |
| Manage | also runs the space: its members, its name, its settings, deleting it |

A space can have several managers. Members who don't manage it see its menu
with «Members…» (to see who's in) and «Leave».

**Renaming it:** the space's menu → **Rename…**, type the new name, press
**Rename**. Its folder on the server is renamed too, and links between its
notes keep working.

**Leaving it:** the space's menu → **Leave** → **Leave the space**. Nothing
is deleted; to come back, someone who manages it adds you again. If you're
in it through a group, the dialog says so: ask the admin to take you out of
the group. See [Leave a space](#leave-a-space).

### Create one

In the sidebar, **New space**. Give it a name and, if you like, its first
members, each with a level. You manage it: you can add more people later.

Its name is also its folder's (`spaces/Home/`) and the start of its notes'
addresses (`?note=Home/…`). It can change whenever you like («Rename…» in
its menu): its folder is renamed with it, and links between its notes keep
working, since they never leave the space. An address someone saved with the
old name stops working.

The admin can reserve creating spaces to admins: Preferences → Spaces → «Who
can create spaces». Then the «New space» button only shows for admins.

**Names of shared spaces are unique, and everyone in the installation can see
them.** Two spaces can't have the same name, not even in different case
(«Home» and «home»): if a name is taken, vihko says «There's already a space
called Home: choose another name», to anyone, whether they're in that space
or not. So a name tells everyone that a space exists; what it holds and who
is in it stay private. Choose names you don't mind others seeing. A name
can't have `/` or `\`, start with `.` or `~`, or end with `.`, `~` or `.md`.

### Members

Open the space's menu in the sidebar → **Members…**. Everyone in the space
sees who the other members are and at what level. Whoever manages it adds
people or groups («Add…», with a level) and changes or removes them.

| | `read` | `comment` | `edit` | `manage` |
|---|---|---|---|---|
| Open notes, follow their links, see their images and comments | ✓ | ✓ | ✓ | ✓ |
| Add comments, and resolve their own threads | | ✓ | ✓ | ✓ |
| Create, edit, move and delete notes; upload images; resolve any comment; create subfolders | | | ✓ | ✓ |
| See a note's history and «Recent changes», restore and revert versions | | | ✓ | ✓ |
| Share a folder further, close it to agents, rename, move or delete folders, purge from the history | | | | ✓ |
| At the space's root: change its members, rename the space, delete it | | | | ✓ |

- With `read` or `comment`, the editor is read-only and its header says «Read
  only» or «Comments only».
- With `comment`, you can resolve a thread you started only while nobody else
  has replied to it.
- Moving a note takes `edit` where it is and where it goes. Moving a folder
  takes `manage` on it and `edit` where it goes.
- Sharing a note to `read` doesn't share its past: the history takes `edit`.

### Sharing only adds

Everyone who has access to a folder sees **everything inside it**, also what
is added later. You can add people to a subfolder (a space's `recipes/` shared
with a neighbour who isn't a member, say), but never take someone away from a
subfolder they reach from above: the dialog shows those rows as «Through
<folder>», without a way to remove them there.

A member of a shared space can only be raised in a subfolder: the share
dialog offers them only the levels above the one they have in the whole
space (someone who reads Home may edit `recipes/`). When their level in the
space goes up, a grant below that no longer raises them goes by itself, and
taking someone out of the space takes their grants below it too, as leaving
does.

Sharing a folder doesn't share its past: whoever you share it with (or add to
a space, or to a group) sees its history and its trash from that moment on,
not what was written or deleted there before.

So what someone shouldn't see goes somewhere else: another folder of your own
space, or another shared space. This is on purpose. Where you can create a
note, you see everything around it, and nothing hidden there can get in your
way or tell you it exists.

**Move to a new space.** Say «gifts» is a folder of the shared space Home, and
the presents are for someone who is also a member. The folder's menu (or the
share dialog) → **Move to a new space…** makes it a shared space of its own,
named «gifts» (you can change the name), which you manage: only the people the
folder itself was shared with come along, and you add whoever else should see
it. The usual move confirmation says who stops seeing it, and links to its
notes keep working. From a shared space you can also **Move to My notes…**, to
keep it to yourself. Making the new space takes being allowed to create spaces
(see [What the admin can do with spaces](#what-the-admin-can-do-with-spaces)).

A person's level is the highest any grant gives them, by name or through any
of their groups.

### Step by step: move a folder to a new space

Say «Family» has a folder «Gifts», and this year's presents are for Sam, who
is a member. Nobody can be kept out of a folder of Family, so the folder
moves out:

1. Open the menu of the folder «Gifts» → **Move to a new space…** (you need
   to manage the folder, and to be allowed to create spaces).
2. **Name**: the new space's name, «Gifts» unless you change it.
3. Read what the dialog says: «It will belong to the members of Gifts», and
   under «Lose it», who stops seeing it (here Sam, and everyone else in
   Family). It also says how many notes and files go with it and whether any
   link changes.
4. Tick **I understand who can see it changes** and press **Move to the new
   space**.

«Gifts» is now a shared space of its own, in the sidebar, which you manage.
Only the people the folder itself had been shared with come along; the
members of Family don't. Its notes keep their links. Add the people who
should see it with its menu → **Members…**, as in
[make a space and invite people](#step-by-step-make-a-space-and-invite-people).

To keep a folder of a shared space to yourself instead, its menu has **Move
to My notes…**, with the same confirmation.

### Leave a space

The space's menu → **Leave**. Nothing is deleted: the space and its notes stay
for the others, and someone who manages it has to add you again to come back.

- If you're in the space through a group, you can't leave it yourself: the
  dialog says which group, and the admin takes you out of the group.
- The last person who manages a space can leave too. The space goes on with
  its members, and the admins get an alert to assign it a new manager.

### Delete a space

The space's menu → **Delete space…** (it takes `manage`). Its notes go to the
trash, and its members stop seeing it at once; they get a notice. **Undo**,
right after, brings it back whole; later, so does **Restore space** in the
notice its managers get, in their **Trash** (where they may also delete it
forever) and, for the admin, in «Spaces» and their Trash: its folders, its
notes and its members with their levels, as they were. Only under its own
name: while another space has it, it can't come back.

A deleted or renamed space's name stays taken while its trash or its history
holds anything, so that a new space with that name never inherits them. It's
free again once the retention or a purge empties that past.

### A shared space's notes

Whoever manages a space can give it daily notes, a place for its images and
a guide for agents, for all its members. Templates need no setting: a note
marked as a template in the space is offered to all its members. It's the same form as a
person's own [note settings](first-steps.md#set-up-your-own-notes), and
every path in it is inside the space.

Say «Family» wants a shopping list per week that everyone writes in,
templates of its own, its photos in one folder, and a guide that tells
assistants where things go.

1. Make what the settings will point to: in «Family», a folder `Templates`
   with a note `Shopping` in it (`# {{title}}` and the usual headings).
2. Open the menu of the folder `Templates` → **Mark notes as templates…** →
   **Mark as templates**: its notes, «Shopping» and any you add later by the
   same means, are now templates (see [Templates](notes.md#templates)).
3. Open the space's menu → **Settings…** (only its managers have it). The
   dialog is «Settings of “Family”».
4. Under «Daily notes», **Add a series**: Name `Shopping`, Folder
   `Shopping`, Note name `{GGGG}-W{WW}` (one per week), Template
   `Templates/Shopping`.
5. **New images** → **All in one folder**, **Folder of images**: `Photos`.
6. **Guide for agents**: what an assistant should know, for example
   «Recipes go in Recipes, one note each». It's kept in the space's
   settings, not in a note, so only the space's managers change it.
7. Press **Save**.

What the members get:

- **«Shopping»** among their daily note series, if they can edit in Family
  (with `read` or `comment` they can't write the note, so it isn't offered).
  It's **one note per week for everyone**, «Family / Shopping /
  2026-W40»: whoever opens it first that week creates it, and the others
  open the same one. Each member chooses in Preferences → «Daily note
  series» whether «Today's note» opens it or their own journal.
- **The templates of «Family»** (any note marked as one there) under «From a
  template» when they make a note, anywhere.
- **Images** pasted into any note of Family go to «Family / Photos». Images
  of their own notes don't change.
- **Their agents** get that guide when they connect, for what they do in
  Family. A member who edits Family's notes can't change it: only its
  managers, in «Settings…».

The settings are saved in a hidden file of the space
(`spaces/Family/.vihko/settings.yaml` on the server); members never see it,
and someone who isn't a member never reads it.

#### How the installation's, the space's and yours add up

There are three places for these settings: `vihko.yaml`, which only the
admin edits on the server, for the whole installation; each shared space's
«Settings…», for its members; and each person's «Your note settings», for
themselves. Nothing replaces anything, except for images:

| Setting | What a person gets |
|---|---|
| Daily note series | All of them: their own, those of the spaces where they can edit, and the installation's, in that order. They choose one in Preferences; until they do, «Today's note» opens the first, and the first one it opens stays their choice. Two series that write the same notes are one, the closest (theirs, then a space's), with its template. If their choice goes away, «Today's note» asks again |
| Templates | Not a setting: every note marked `template: true` they can read, in any space |
| Where a new image goes | The setting of **the note's space**, if it has one; otherwise the installation's. Never someone else's |
| Guide for agents | All of them, one after another: the installation's, then each space's, then their own |

An example. «Family» has the settings above. Noa, a member of Family, has a
«Journal» series of her own, her guide «For agents» and, in «My notes /
Templates», templates of her own.
Then Noa:

- has two daily series, «Shopping» and «Journal», and picks «Journal» in
  Preferences: «Today's note» opens her journal, and she opens the week's
  shopping list from the tree, in «Family / Shopping»;
- sees her templates and those of «Family»;
- pastes a photo into a Family note and it goes to «Family / Photos»; one
  pasted into her journal goes next to the note (the installation's
  default, since her own settings don't say otherwise);
- connects an assistant, which reads vihko's instructions, then «About this
  space», then her «For agents».

If two series would give the same note, it's offered once. The details,
and the format of the files, are in
[Settings of a person or a space](configuration.md#settings-of-a-person-or-a-space).

## Sharing a folder of your own

### Step by step: share a folder of yours

Say Sam keeps his trip plans in «My notes / Trips» and wants Noa to read
them and comment, without making a shared space.

1. In the sidebar, open the menu of the folder «Trips» (its `⋯` button, or
   right-click it) → **Share…**. The dialog is «Share “Trips”».
2. Choose `noa` in «Add…», `Comment` as the level, and press **Add**.
3. Press **Save**. «Add» only puts Noa in the list: closing without saving
   asks first, as in a space's members.

The folder now shows a «Shared» mark in Sam's tree. It stays in Sam's space
and stays his: only he renames, moves or deletes it. To change Noa's level
or stop sharing, open **Share…** again, change the level or press the `×`
on her row, and **Save**.

### Step by step: what others share with you

Noa gets a notice, «sam shared “Trips” with you», and the folder shows:

- on **Home**, under «Shared with you lately»;
- in the sidebar, under **Shared with me** (folded, with a count): «Trips
  sam’s».

To keep it at hand:

1. Unfold «Shared with me», open the menu of «Trips» (`⋯`) → **Pin to the
   sidebar**.
2. «Trips sam’s» now has a section of its own in the sidebar, next to your
   spaces, with its notes, and leaves «Shared with me» (which goes away when
   everything in it is pinned). **Unpin from the sidebar**, in the same
   menu, puts it back there.

The same menu has **Who has access…** (everyone who sees it, and at what
level) and **Leave**, which stops you seeing it («Stop seeing it»). Nothing
is deleted; to see it again, Sam has to share it again.

### How it works

In «My notes», open a folder's menu → **Share…**, add people or groups and
pick a level. They see that folder, and everything in it, under «Shared with
me», with your name. The rest of your space stays yours alone. Your space as a
whole can't be shared: for something that belongs to several people, make a
shared space.

- The folder stays in your space and stays yours. Only you rename, move or
  delete it. Someone you gave `manage` can share it further and order what's
  inside it.
- Whoever can edit in it creates notes there; they're kept in your space, and
  the UI says so.
- Whoever receives it can pin it to the sidebar, see who else has access
  («Who has access…»), or stop seeing it («Leave», then «Stop seeing it»).
  Stopping seeing it deletes nothing: to see it again, you have to share it
  again.
- **A known limit of sharing to edit.** A link by name finds notes anywhere in
  your space, and one to a note someone can't read looks broken to them. So
  whoever can edit the folder you share can write an alias and a link in it,
  and tell from whether the link works if you have a note by that name in the
  rest of your space. It takes `edit` (not `read` or `comment`); the share
  dialog says so when you give it. Keep what nobody may even guess at in
  another space.

**The share dialog.** «Share…» opens it on any folder you manage, in your
space or in a shared space. It lists who has access and why: «Here» for what
this folder adds, «Through <folder>» for what comes from above, and «It’s
their space» for the owner of a personal space. The tab «Who has access» lists
every person who reaches the folder, at what level and why. The card
«Closed to agents» is there too (see
[Closing things to agents](#closing-things-to-agents)).

A folder with grants of its own shows a «Shared» mark in the tree.

If someone changed `vihko.yaml` by hand while you had the dialog open, saving
doesn't overwrite it: the dialog reloads with the grants as they are now, and
you review your change and save again.

People who are added to a space, or get a folder shared with them, see a
notice: «ana added you to Home», «ana shared “trips” with you». If the space
or the folder is renamed or moved from vihko, the notice names it as it is
now.

## Moving things between spaces

Moving a note or a folder to another space changes who can see it, and whose
it is. The move dialog says so before anything happens, and asks you to tick a
box:

- who gains and who loses access (people and groups by name, keys counted);
- whose it becomes: «It stops being yours: it will belong to the members of
  Home», or «It will be kept in ana’s space»;
- the links that will be broken, in plain words («In My notes / Home, the
  link to Trip will be broken (it now lives in Family)»): links never cross
  spaces, so nothing is rewritten between the two, and the note's own links
  now resolve in its new space;
- images the note shares with other notes, which are copied to the new space
  so its new readers see them.

An agent that tries a move that would show a note to more people is refused
unless it confirms, and it's told to ask you first.

## Adding people

vihko doesn't send email. You create the account, copy a one-time link, and
send it yourself over a channel you trust.

1. Go to Preferences → Users and groups → **New user**.
2. Type a username and choose a role. The username is 2 to 64 letters,
   digits, `.`, `_` or `-`, doesn't start with a dot, and can only be changed
   while their invitation is unused (the user's «Actions» → **Rename…**: their
   folder and what's shared with them follow): it's also the name of their
   folder, `people/<username>/`. Names are
   unique ignoring case (`Noa` and `noa` are the same person). A new admin,
   like making someone admin, asks you to confirm at the moment (see
   [Confirming at the moment](#confirming-at-the-moment)), and the other
   admins get a notice.
3. Press «Create and get the link», copy the link and send it.

The person opens the link, chooses their password (at least 10 characters) and
is signed in, with their own empty «My notes». If the second factor is
required, they set it up right there.

- The link works **once**, for **7 days**. It's only shown when made: if it
  gets lost, make another one («New invitation link»); the previous one stops
  working.
- The link uses `VIHKO_PUBLIC_URL` when it's set, and otherwise the address
  your browser used to reach vihko.
- Until they use it, the account shows as «Invitation pending».
- Nobody, the admin included, ever knows anyone's password.
- If a folder with that name already exists in `people/` with something in it
  (put there from outside vihko), the user isn't created
  (`personal_folder_exists`): move that folder away first, or choose another
  name. An empty one is simply theirs. If it is theirs (their account was
  lost with `state.db`, say), **Adopt their folder** creates them with it, as
  it is; `vihko user create <name> --adopt` does the same.

### From the command line

The same without the UI, inside the container (`docker compose exec vihko …`
while it runs). This is the only way to give someone a password yourself.

```sh
# Create a user; the password is read from standard input
docker compose exec -T vihko vihko user create noa <<< 'a long passphrase here'
docker compose exec -T vihko vihko user create lead --admin <<< 'another long passphrase'

# A one-time link (7 days) for someone to choose a new password
docker compose exec vihko vihko user reset-link noa

# Take away someone's second factor
docker compose exec vihko vihko user reset-2fa noa
```

A password typed on the command line stays in your shell's history; to avoid
that, read it from a file (`… user create noa < password.txt`) and delete the
file afterwards.

`reset-link` and `reset-2fa` together are the way back for an admin who lost
both password and phone. `reset-link` prints the full link when
`VIHKO_PUBLIC_URL` is set, and otherwise a path to put after vihko's address.

## Language, passwords and sessions

- **Language:** Preferences → Account → Language, or `>language` in the
  search (⌘K / Ctrl+K). vihko speaks English and Spanish; «Automatic», the
  default, uses your browser's language. Your choice is saved in your
  account.
- **Changing your password:** Preferences → Account → Password. It asks for the
  current one and ends any reset link made for you. Unless you untick «Also
  sign out other sessions and revoke keys and authorised apps», it signs out
  your other sessions and revokes your agent keys and the apps you authorised:
  whatever got in with the old password is out.
- **Keys and apps:** every key made, or app authorised, on your account
  leaves you a notice, even when you did it yourself.
- **Sessions:** Account lists the browsers you're signed in from. A session
  unused for 30 days expires. You can sign out any of them, or all the others.
- **A forgotten password:** the admin makes a reset link (the user's
  «Actions» → «Password reset link») and sends it. Their current password keeps
  working until the link is used; using it signs out all their sessions.

When an admin makes a reset link, resets someone's second factor or changes
their role, vihko asks the admin to confirm at the moment. The person sees a
notice the next time they sign in («Lead made a link to reset your password»),
and so do the other admins. An admin can do these things, but not unnoticed.

## Groups

A group lets you share with several people at once: add `@family` to a space
and everyone in the group is a member. Only admins create groups and decide
who's in them, in Preferences → Users and groups → Groups.

- A group name follows the same rules as a username. In grants it's written
  with `@` in front: `@family`, `@staff`.
- **Renaming** a group renames it in every grant (vihko rewrites
  `vihko.yaml`).
- **Deleting** a group removes its grants everywhere: its members lose what
  they had only through it. The people aren't deleted.
- **Taking someone out of a group** takes away at once what they had through
  it; a note they had open closes.

## What the admin can do with spaces

Preferences → **Spaces** (admins only) lists every shared space: its name, who
manages it, and how many members it has. Never what's inside.

- **Assign a manager** to a space that has none (its last manager left, or
  nobody was ever given access). The person and the other admins are told.
- **Join** a space without managers (all of them disabled, or none left), to
  rescue it, as one more member at a level the admin chooses (`read` by
  default). It's confirmed at the moment, its members and the other admins are
  told, and the admin shows up in its member list. A space with managers is
  theirs: only they add people, the admin included, so the admin never sees
  inside a space they weren't invited to.
- **Restore a deleted space** whole (the admin sees every one, under «Deleted
  spaces»), without gaining access to it.
- **Who can create spaces**: everyone (the default) or admins only.
- The page also shows what is in the notes folder outside every space, and
  the spaces of deleted people (below).

Both changes ask the admin to confirm at the moment (their app's code, or
their password).

## Disabling and deleting people

Both are in the user's «Actions» menu.

**Disable** (reversible):

- Their sessions end at once, and a note they have open closes. They can't
  sign in.
- Their agent keys and the apps they authorized stop working while they're
  disabled.
- Their space, what they shared, their keys and their groups are kept: others
  keep seeing what they shared. Enabling them again makes everything work
  again.

**Delete** (only someone already disabled; it can't be undone):

- The account goes: sessions, links, profile, group memberships, second factor
  and notices. Their keys are revoked for good (they stay listed as revoked).
- Their grants are removed from `vihko.yaml`.
- **Their space closes**: nobody sees it, the admin neither, but the folders
  they shared stay shared, as they were, until the admin decides what becomes
  of it. The delete dialog lists who has access to what, and asks what
  becomes of the space: **decide later** (the default), **transfer it** to
  someone, or **make it a shared space**, with the same choices and counts as
  below. Transferring or converting it right there is confirmed at the moment
  with the admin's code or password, before the person is deleted. Deleting
  the space later tells whoever still had a folder of it.
- Their notes stay on disk, and the history still says what they wrote, under
  their name.
- **Their username is reserved**: nobody else can take it, so a newcomer
  never inherits their folder.

Decided later, the closed space shows in Preferences → Spaces, under «Spaces
of deleted people», and the admins get an alert for as long as one is waiting
for a decision. The admin decides what becomes of it, without reading
anything in it, and confirms at the moment:

- **Transfer…** to someone: it goes whole into their space, as a folder named
  after the deleted person (`people/noa/sam/`, or `people/noa/sam-2/` if
  that name is taken there). What was shared stays shared.
  A broken link by name in its notes may start leading to a note of whoever
  receives it, if one has that name; the dialog says so.
- **Make it a shared space…**, with the members the admin chooses (at least
  one who manages it). Its members will see everything the person had, also
  what they never shared; the dialog says so. The person's own settings
  folder (`.vihko/`) doesn't come along.
- **Delete…**: its files are deleted from the disk, with no trash, since
  nobody could see it. The history keeps what it had, with nobody to read it;
  the admin can purge it by path ([History](history.md#purging)).

Links to notes in it, from anywhere, are rewritten to the new place. The
person who receives it, and the other admins, are told.

The last active admin can't be disabled, deleted or lose the admin role.

### Someone leaving with their notes

vihko has no export yet. It doesn't need one to let someone take their
notes: they are plain Markdown files, in folders, on the server's disk.

- **Their own space** is the folder `notes/people/<username>/`. Whoever
  administers the server copies it (with `cp -a`, `rsync`, or a zip of it)
  and hands it over: the notes, their images and other files, and their
  settings (`.vihko/settings.yaml`). Any Markdown editor opens it; in
  Obsidian, open the folder as a vault, and the links by name work as they
  did in vihko.
- **What they wrote in a shared space** is the space's, its members'. Copy
  only what the space's members agree to, from `notes/spaces/<name>/`.
- **The history** of their notes isn't in those files. A note's earlier
  versions can be copied one by one from its History; for all of it, the
  admin can read the history's git repository
  ([History](history.md)).

Then disable or delete the account as above. Deleting doesn't remove the
files from the disk unless the admin chooses **Delete…** for the closed
space.

## Changing roles

«Make admin» and «Remove the admin role», in the user's «Actions». A new admin
manages users, groups, settings and the directory of spaces, and still reads
only their own space and what is shared with them.

## Closing things to agents

Agents (API keys and MCP clients, see [Agents](agents.md)) act for a person
and never see more than that person. On top of that, you can close things to
every agent of every person:

- **All of My notes:** its menu → **Agents…** → «Closed to agents».
- **A folder** you manage, in your space or in a shared space: in its share
  dialog, turn on «Closed to agents». It holds for everything under it, new
  notes included, and can only be undone where it was set. In `vihko.yaml`
  it's `ai: false` on the folder.
- **A note:** `ai: false` in its frontmatter.

Nothing can be reopened from below: `ai: true` on a subfolder is ignored. A
closed note or folder doesn't exist for agents: searches and lists never show
it, and an agent that names one is told it isn't available to agents.

## Folders moved outside vihko

If you move a note or a folder with another program (a shell, a file manager)
to where people who didn't read it would, vihko holds the notes it recognises
(by their `uid`, or unchanged content): hidden from everyone until someone
decides. Whoever could have made that move from vihko (`edit` where they were
and where they are) gets an alert with «Release them»; the notes go back to
normal by themselves if they're moved back. A folder with held notes inside
can't be deleted until they're released.

**Only whoever moved them can release them**, in practice: the alert, and
«Release them», go only to someone with `edit` both where the notes were and
where they are now. A manager of the folder they landed in who couldn't edit
where they came from doesn't get it, and can't delete that folder meanwhile:
ask whoever moved them to release them, or move them back with the same
program.

Grants in `vihko.yaml` for a folder that no longer exists are kept, and apply
again if the folder comes back; whoever manages its space gets an alert. Moves
made from vihko take their grants with them.

## Two-step verification

Besides the password, vihko can ask for a 6-digit code from an authenticator
app (TOTP: Aegis, 2FAS, Google Authenticator, Microsoft Authenticator,
1Password, Bitwarden…).

### The policy

The admin chooses it in Preferences → Users and groups → Settings:

| Policy | What it means |
|---|---|
| Optional (default) | Each person decides in their Account |
| Required | Whoever doesn't have it sets it up when signing in, before anything else, also when accepting an invitation. Sessions already open go on; sign them out to ask for it now |
| Off | Nobody new can set it up. Whoever already has it is still asked for it, and can change or turn it off |

Changing the policy asks the admin to confirm at the moment. The «2FA» column
of the user list shows who has it, and «At sign-in» for those who will set it
up the next time they sign in.

### Turning it on

1. Preferences → Account → Two-step verification → **Turn on**, and confirm
   with your password.
2. Scan the QR code with the app, or type the key.
3. Type the code the app shows. Nothing is turned on until a code works, so an
   app that never scanned the code can't lock you out.
4. **Save the 10 recovery codes** it shows, away from your phone: in a password
   manager, or printed. They are shown only once.

From then on, signing in asks for the app's code after the password. «No phone?
Use a recovery code» takes one of those instead; each works once. In Account you
can make new recovery codes (the old ones stop working), change to another app
(the old one works until the new one is verified) or turn it off (unless it's
required). Each of these asks for a code of your second factor, the app's or a
recovery code, and never for your password: someone who found your session
open, and knows your password, still can't take your second factor over.

If the app's codes never work, check that the phone sets its time
automatically.

### Lost phone

- With recovery codes: sign in with one, then change the app in Account with
  another (and make new codes once the new app works).
- Without one: ask an admin. In the user's «Actions», «Reset two-step
  verification» takes it away; the person signs in with their password alone
  and sets it up again (at once, if it's required). Their open sessions and
  agent keys keep working.
- An admin who lost both password and phone: another admin can help, or, from
  the server, `vihko user reset-2fa <name>` and `vihko user reset-link <name>`
  (see [From the command line](#from-the-command-line)).

### The key that protects the second factor

vihko has to keep each person's authenticator secret in `state.db` to check
their codes. Set `VIHKO_SECRET_KEY` (or `VIHKO_SECRET_KEY_FILE`) and it keeps
them encrypted, so a copy of `state.db` alone, a backup say, isn't enough to
compute anyone's codes. Keep the key apart from the backups of the state
volume. How to set it, and what happens if it's lost or changed (vihko starts,
alerts the admins, and those people use a recovery code or get their second
factor reset), is in [Install](install.md).

Recovery codes need no key: vihko keeps them as passwords are kept, only as a
slow hash, so a copy of `state.db` doesn't give them away either. (Codes made
by an earlier version were kept with a faster hash; they keep working, and
making new ones replaces them.)

### Confirming at the moment

Some actions ask you to prove it's you even though you're signed in: the
app's code, or your password if you have no second factor.

- creating or rotating an agent key, changing one so it can do more, and
  authorizing an app (OAuth);
- an admin making a reset link for someone, resetting someone's second factor,
  changing someone's role, creating a new admin, or enabling a disabled one;
- an admin changing the second-factor policy;
- an admin assigning a manager to a space, joining a space, or deciding what
  becomes of a deleted person's space;
- an admin purging from the history something they can't read;
- an admin turning on, or shortening, the trash's or the history's
  [retention](operations.md#retention), or running it now.

A session left open on someone's computer isn't enough to do any of these.

A confirmation lasts **15 minutes in that browser**: the current code, a
recovery code, your password (without a second factor), or signing in with
your code. Meanwhile these actions don't ask again, and their dialogs show no
field for it; after that, they ask as before. It's only that browser's
session: another browser, an agent key or an app authorized with OAuth never
skips a confirmation. Signing out, changing your password, and turning your
second factor off (or an admin resetting it) end it at once.

Agent keys never ask for a second factor: they're separate credentials, made
from a session that already passed it, and you can revoke them.

## Sign-in limits

To stop anyone guessing passwords, vihko slows down repeated failures. After a
few wrong attempts, the sign-in page says «Too many failed attempts. You can
try again in …» and shows the wait. The wait doubles with each new failure:

| Counter | Free failures | Longest wait |
|---|---|---|
| One browser or address, one username | 5 | 15 minutes |
| One username, from anywhere | 10 | 1 minute |
| One address, any username | 20 | 15 minutes |

- A browser you've signed in from before only counts its own failures, so
  nobody can lock you out by failing with your name. From a new browser,
  while someone keeps guessing your name, you wait at most a minute.
- A successful sign-in clears your counters. A counter is forgotten an hour
  after its last failure, and restarting vihko forgets them all.
- Second-factor codes have counters of their own («Too many wrong codes. Wait
  a little before trying again»): knowing the password gives no fresh guesses
  at the code.
- Invitation and reset links are limited by address.
- With many failures in the last day, admins get an alert.

Behind a reverse proxy, set `VIHKO_TRUSTED_PROXIES`, or every client counts as
the proxy and one person's typos slow down everyone. See
[Reverse proxy](reverse-proxy.md).

## Notices to a person

Besides the workspace alerts, vihko keeps notices addressed to one person, shown
when they sign in and in the alerts until they dismiss them:

- an admin made a reset link for them, reset their second factor, or changed
  their role (the other admins get one too);
- to every other admin: an admin created a new admin («Lead made Noa an
  admin», as for a role change);
- someone added them to a shared space, or shared a folder with them;
- the admin made them a manager of a space, joined a space they manage, or
  gave them (or its members) a deleted person's space; the other admins are
  told too;
- a move of theirs left links that couldn't be updated, even after vihko
  tried again;
- someone purged from the history a note or a version they wrote in (see
  [History](history.md#purging));
- to every admin: what a [retention](operations.md#retention) run
  removed (how many trash entries and history versions, never which), or that
  it failed. The authors of what it removes aren't told: it's the
  installation's setting, not someone's decision about their notes.

Notices never include note content, and name a space or a folder only while
the person can still see it.
