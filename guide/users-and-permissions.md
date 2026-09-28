# Users and permissions

vihko is made for a small group: a family, a team, a few friends. Everyone
signs in with their own account, and folder permissions decide who reads and
writes what. This page is for the admin who sets that up, and for anyone who
wants to know who can see their notes.

Everything here happens in the UI, under **Preferences** (in the sidebar):
«Account» for your own account (language, password, second factor and
sessions), «Users and groups» for the admin. The exact
rules behind the permissions, as written in `vihko.yaml`, are in
[Configuration](configuration.md#permissions).

## Roles

There are two roles.

| | Member | Admin |
|---|---|---|
| Reads and writes notes | What the folder permissions grant them | The same: what the permissions grant them |
| Shares a folder | Where they have `manage` | Any folder |
| Manages users, groups, the second-factor policy and other settings | | ✓ |
| Sees system alerts (configuration, history, sign-in attempts) | | ✓ |

**The admin manages, but doesn't read by right.** Being an admin grants no
access to notes: an admin reads only what the permissions give them, like
anyone else. In practice:

- While `vihko.yaml` has no permissions, every admin manages the root, so a
  one-person installation just works. The first change in a permissions
  dialog writes that rule into the file, with the admins of that moment;
  an admin added later gets only what they're granted.
- Whoever manages the root reads everything **except other people's personal
  folders** (see [Personal folders](#personal-folders-with-user)).
- An admin can change any folder's permissions, including a personal
  folder's, and so give themselves access. That's a grant like any other,
  visible to everyone who looks at that folder's permissions. It isn't hidden.
- In «Users and groups» → «Folder permissions», an admin sees every folder's
  name, to manage its permissions, never its notes.

Everyone signed in sees the names of users and groups (to share with them),
never their status, role or second factor.

The admin's settings, in Preferences → Users and groups → Settings, are the
[second-factor policy](#the-policy) and «Members can download images from the
local network»: off by default, members can only save copies of images from
public internet addresses, so nobody can use vihko to reach other machines on
your network. Admins always can. Whether members may create agent keys is set
in «Agents and API» (see [Agents](agents.md)).

## Adding people

vihko doesn't send email. You create the account, copy a one-time link, and
send it yourself over a channel you trust.

1. Go to Preferences → Users and groups → **New user**.
2. Type a username and choose a role. The username is 2 to 64 letters,
   digits, `.`, `_` or `-`, and can't be changed later. Names are unique
   ignoring case (`Noa` and `noa` are the same person). A new admin, like
   making someone admin, asks you to confirm at the moment (see
   [Confirming at the moment](#confirming-at-the-moment)), and the other
   admins get a notice.
3. Press «Create and get the link», copy the link and send it.

The person opens the link, chooses their password (at least 10 characters) and
is signed in. If the second factor is required, they set it up right there.

- The link works **once**, for **7 days**. It's only shown when made: if it
  gets lost, make another one («New invitation link»); the previous one stops
  working.
- The link uses `VIHKO_PUBLIC_URL` when it's set, and otherwise the address
  your browser used to reach vihko. Make sure that address works for the
  person you send it to.
- Until they use it, the account shows as «Invitation pending».
- Nobody, the admin included, ever knows anyone's password.

A new person can see nothing until a folder is shared with them. They see «You
have no access to any folder yet» instead of the folder tree.

### From the command line

The same without the UI, inside the container (`docker compose exec vihko …`
while it runs). This is the only way to give someone a password yourself:
it's for whoever runs the server, and neither the UI nor vihko's HTTP API
does it (they only make links).

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
file afterwards. The password must be at least 10 characters.

`reset-link` and `reset-2fa` together are the way back for an admin who lost
both password and phone. `reset-link` prints the full link when
`VIHKO_PUBLIC_URL` is set, and otherwise a path to put after vihko's address.
Any earlier link for that person stops working. A second factor they have is
still asked for after the reset.

## Language, passwords and sessions

- **Language:** Preferences → Account → Language, or `>language` in the
  search (⌘K / Ctrl+K). vihko speaks English and Spanish; «Automatic», the
  default, uses your browser's language. Your choice is saved in your
  account, so it follows you to every browser you sign in from, and each
  browser remembers it for its sign-in screen. Until you sign in, a browser
  you've never used shows its own language.
- **Changing your password:** Preferences → Account → Password. It asks for the
  current one, signs out your other sessions, and ends any reset link made for
  you.
- **Sessions:** Account lists the browsers you're signed in from. A session
  unused for 30 days expires. You can sign out any of them, or all the others.
- **A forgotten password:** the admin makes a reset link (the user's
  «Actions» → «Password reset link») and sends it. Their current password keeps
  working until the link is used; using it signs out all their sessions.

When an admin makes a reset link, resets someone's second factor or changes
their role, vihko asks the admin to confirm at the moment (see
[Confirming at the moment](#confirming-at-the-moment)). The person sees a notice
the next time they sign in («Lead made a link to reset your password»), and so
do the other admins. An admin can do these things, but not unnoticed.

## Groups

A group lets you share with several people at once. Only admins create groups
and decide who's in them, in Preferences → Users and groups → Groups.

- A group name follows the same rules as a username. In permissions it's
  written with `@` in front: `@family`, `@staff`.
- **Renaming** a group renames it in every folder's permissions (vihko
  rewrites `vihko.yaml`).
- **Deleting** a group removes its grants everywhere: its members lose what
  they had only through it. The people aren't deleted.

## Sharing a folder

Permissions belong to folders, never to single notes: a note has the
permissions of the folder it's in, and so does an image or any other file.

To share a folder, open its menu in the folder tree → **Permissions…**. You can
do it if you have `manage` on it, or if you're an admin.

1. Press «Change permissions». The dialog starts from what the folder inherits.
2. Add people or groups with «Add…», and pick a level for each.
3. Press «Save».

The dialog also has:

- **Inherited from …**: what the folder gets from above when it has no
  permissions of its own. «Restore inheritance» drops its own permissions.
- **Who has access**: every person who reaches the folder, at what level and
  why («Directly», «Through @family», «manages /projects»).
- **Closed to agents**: see [Closing folders to agents](#closing-folders-to-agents).

A folder with permissions of its own, or closed to agents, shows a lock in
the tree.

If someone changed `vihko.yaml` by hand while you had the dialog open, saving
doesn't overwrite it: the dialog reloads with the permissions as they are now,
and you review your change and save again.

### The four levels

| | `read` | `comment` | `edit` | `manage` |
|---|---|---|---|---|
| Open notes, follow their links, see their images and comments | ✓ | ✓ | ✓ | ✓ |
| Add comments, and resolve their own threads | | ✓ | ✓ | ✓ |
| Create, edit, move and delete notes; upload images; resolve any comment; create subfolders | | | ✓ | ✓ |
| See a note's history and «Recent changes», restore and revert versions | | | ✓ | ✓ |
| Change the folder's permissions (up to `manage`), close it to agents, rename, move or delete the folder, purge its notes from the history | | | | ✓ |

- With `read` or `comment`, the editor is read-only and its header says «Read
  only» or «Comments only».
- With `comment`, you can resolve a thread you started only while nobody else
  has replied to it; with replies from others, it takes `edit`.
- Moving a note takes `edit` where it is and where it goes. Moving a folder
  takes `manage` on it and `edit` where it goes.
- Sharing a note to `read` doesn't share its past: the history takes `edit`.

### How permissions pass down

- **Subfolders inherit** the permissions of the nearest folder above that has
  some.
- **A folder's own permissions replace what it would inherit.** They never add
  to it: to keep someone from above, include them.
- **Whoever manages a folder manages everything under it**, even a subfolder
  whose own permissions don't name them. You can't close a subfolder to the
  person who manages the folder above; use a personal folder for that.
- **A person's level** is the highest they get, by name or through any of their
  groups.

The exact rules, with the edge cases, are in
[Configuration](configuration.md#permissions).

## Personal folders with `{user}`

A `{user}` rule gives each person a folder of their own, also to people who
join later. Write it in `vihko.yaml` by hand (the dialog shows it but doesn't
create it):

```yaml
permissions:
  "":
    grants: { lead: manage }
  people/{user}:
    grants: { "{user}": manage }
```

Now `people/noa/` is Noa's, `people/sam/` is Sam's, and so on. A personal
folder is different from any other:

- **Nobody from above gets in.** Whoever manages the root, or `people/`, doesn't
  manage or read a personal folder, admins included. Only its own grants count.
- **Its owner shares it.** With `manage` there, they can share it or any
  subfolder with others, and those grants show in the folder's permissions.
- **A folder named after nobody is closed.** `people/archive/`, when there is
  no user `archive`, gives no access to anyone.
- **It stays personal when a folder above it moves.** Moving `people/` moves
  its `{user}` rule along. A move that would leave someone's personal folder
  where no `{user}` rule reaches it (with `people/{user}/journal`, moving
  `people/noa` to `archive/noa`) is refused, unless you manage that personal
  folder yourself: only its owner takes it out, seeing who gains access.

**The first time**, the folder doesn't exist yet, and nobody sees a folder
that doesn't exist: until it does, a new person's tree says «You have no
access to any folder yet» (unless something else is shared with them). Either
of these creates it:

- **Someone who can edit the folder above**, such as the admin who manages
  the root: in the tree, `people`'s menu → «New folder inside…» → `noa`. It
  disappears from the admin's own tree at once, since they can't read it, and
  shows up in Noa's.
- **The owner, by creating a note in it.** The `{user}` rule gives Noa
  `manage` in `people/noa/` before it exists, so anything that creates a note
  there creates the folder too: typing `people/noa/Plan` in «Search or
  create…» (⌘K) and choosing «Create», a daily note of a series in
  `people/{user}/…` («Today's note»), or an agent's key. Noa has to know the
  path: nothing in the UI shows it before it exists, and «New note» only
  appears once she can edit some folder she sees.

A daily-note series with `{user}` in its folder (see
[Configuration](configuration.md#daily-daily-notes)) fits well inside it:
`people/{user}/journal`.

To give someone else's personal folder to another person (after deleting
someone, say), an admin writes a rule for that exact folder in `vihko.yaml`
or in its permissions dialog: a rule for the folder itself wins over the
`{user}` rule, but the folder stays personal (nobody from above gets in).

## Closing folders to agents

Agents (API keys and MCP clients, see [Agents](agents.md)) act for a person
and never see more than that person. On top of that, you can close things to
every agent of every person:

- **A folder:** in its permissions dialog, turn on «Closed to agents» (it takes
  `manage`). It holds for everything under it, new notes included, and can
  only be undone where it was set. In `vihko.yaml` it's `ai: false` on the
  folder's rule.
- **A note:** `ai: false` in its frontmatter.

Neither can be reopened from below: `ai: true` on a subfolder is ignored. A
closed note or folder doesn't exist for agents: searches and lists never show
it, and an agent that names one gets told it isn't available to agents. Keys
limited to some folders are set up where the key is made; see
[Agents](agents.md).

## Moving things changes who sees them

A note has the permissions of its folder, so moving it can open it to more
people, or close it to some. When a move changes who can see something, the
move dialog says so («2 people and 1 key lose access; @family gains it») and
asks you to tick a box to confirm. The count only names users and groups
(which everyone can see) and a number of keys.

An agent that tries a move that would open a note to more people gets refused
unless it confirms, and it's told to ask you first.

### Folders moved outside vihko

If a folder with permissions of its own is renamed or moved outside vihko (a
shell, a file manager), its rules in `vihko.yaml` stay behind, and its notes
would take the permissions of wherever they landed. vihko fails closed where it
can tell:

- Notes it recognises as having left that folder are **held**: hidden from
  everyone until someone decides. The admin, and whoever manages the folder
  the rules were for, get an alert with two choices: «Move their permissions»
  (the rules follow the notes) or «Release them» (the permissions of the
  folder they're in apply).
- Notes that came out of a **personal folder** (or a folder inside one) are
  decided only by whoever manages that personal folder: its owner, who gets
  the alert with both choices. The admin gets an alert too, so they know
  something needs attention, but it only says how many notes are held and
  which personal folder they came from: no names, no content, and no choices.
  If the owner's account has been deleted, nobody can release them from vihko:
  they stay held until someone with access to the server's disk moves them
  back (or wherever they should be).
- Rules for a folder that no longer exists are kept, with an alert, and apply
  again if the folder comes back.

vihko can only hold notes it recognises (by their `uid`, or unchanged content).
A note it can't match takes the permissions of its new folder a few seconds
after the move, when the watcher or the rescan sees it. Moving folders from
vihko has none of this: their rules move with them.

## Disabling and deleting people

Both are in the user's «Actions» menu.

**Disable** (reversible):

- Their sessions end at once, and a note they have open closes. They can't
  sign in: the sign-in page says «Wrong username or password», as for anyone.
- Their agent keys and the apps they authorized stop working while they're
  disabled.
- Their permissions, keys and groups are kept. Enabling them again makes
  everything work again (they sign in again). Enabling an admin asks you to
  confirm at the moment, as making someone admin does.

**Delete** (only someone already disabled; it can't be undone):

- The account goes: sessions, links, profile, group memberships, second factor
  and notices.
- Their keys are revoked for good (they stay listed as revoked, so the history
  can still name them).
- Their grants are removed from `vihko.yaml`. A folder whose only grant was
  theirs stays closed: it doesn't start inheriting from above.
- **Their personal folder stays closed**: nobody sees it until an admin gives
  it to someone on purpose.
- **Their notes stay**, and the history still says what they wrote, under
  their name.
- **Their username is reserved**: it can't be given to anyone else, so a
  newcomer never inherits their personal folder.

The last active admin can't be disabled, deleted or lose the admin role.

## Changing roles

«Make admin» and «Remove the admin role», in the user's «Actions». A new admin
manages users, groups, settings and any folder's permissions, and still reads
only what they're granted. Someone who stops being an admin keeps what the
permissions grant them.

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
- an admin purging from the history something they can't read.

A session left open on someone's computer isn't enough to do any of these.

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
- someone purged from the history a note or a version they wrote in (see
  [History](history.md#purging)).

Notices never include note content.
