# Changelog

Every release of vihko, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). While vihko is at
0.x, a minor version (0.1 → 0.2) may change what scripts, agents and your
setup rely on, and a patch version only fixes things, as
[guide/upgrading.md](guide/upgrading.md) explains. Read a version's
**Upgrade notes** before installing it.

The line released earlier as 1.0.x was withdrawn; its history is in git, and
its entries are kept at the end of this file.

## [0.1.0-rc.8] - 2026-10-08

Fixes from a review of the rules of the spaces and of the published
contract against the code, before 0.1.0.

### Added

- **`PUT /api/profile/last-note`** and **`lastNote` in `GET/PUT
  /api/profile`**: the last note opened on this device, kept in the account
  (see *Changed*). For the web UI: a key gets 404.

### Changed

- **«On opening: Last note (on this device)» survives signing out.** It was
  read from the browser's list of recent notes, which goes when you sign
  out, so after signing in again it always opened Home. vihko now keeps each
  device's last note in your account (a device is a browser, by its device
  cookie, which it now keeps from one sign-in to the next), follows the note
  when it's moved or renamed, and opens Home instead of a note you can no
  longer read or that is gone. Nothing of it stays in the browser after you
  sign out; the palette's recent notes are still per browser, and still go
  then.
- **«Today's note» never lands in a shared space by itself.** With no series
  chosen it took the first one offered, which could be a shared space's; it
  now takes the first in your own space, and with none there it asks which
  one to use (`409 series_gone`, as when a chosen series is gone).
- **An alias typed in the editor goes through the same check as one added
  through the API or MCP**: one that would change where a link in a note you
  read leads, to a note you can't read, is taken out of the note before it's
  saved, and you're told.
- **A request with an API key is judged by the key alone**: a write from a
  page of another site (any `Origin`) is no longer refused with 403; the
  check is for sessions, whose cookie a browser sends by itself. There are
  still no CORS headers.
- **An OAuth token whose authorization no longer holds** (its person
  disabled, say) gets `401` and its challenge from any `Origin`, instead of a
  403 for the `Origin`.
- `GET /api/spaces/members` with a key, on a folder its person reads but
  that is outside the key's folders or closed to agents, answers `403
  agent_denied` with the reason, as for a note, instead of 404.
- MCP: `changes_since` from a version id needs `edit` where the note is, as
  `history` does (`forbidden`); `config_invalid` comes as over HTTP instead
  of `internal`; `audience` (a `move`'s dry run, `audience_widens`) carries
  `owner`, whose the note is before and after, as over HTTP; `daily_note`'s
  `series` takes any series offered, a space's (`sp-…`) and your own
  settings' (`me-…`) too.
- **Sizes read as sizes**: «51 bytes», «1.2 KB», «3,4 MB» in Spanish, in the
  trash and the retention settings (it said «51 byte»).
- The comments of a paragraph are counted as threads everywhere: a comment
  with its replies is one, on the phone as on the desktop.
- The sidebar's section headings look alike: a pinned folder's and «Shared
  with me» have the small capitals and an icon of the others.
- On a phone, the format bar's hidden buttons are hinted by a fade and an
  arrow at the edge that has more (tap it to scroll), instead of a button cut
  in half; and a notice sits above the bar instead of covering it.
- Spanish: «Ejecutar ahora» for the retention's «Run now».
- The guides and the contract describe 0.1.0 as the first version, and say
  what the code does where they didn't: what needs `edit` (a note's
  history), the codes, fields and limits that were missing, the defaults of
  `vihko.yaml`, and more. `ROADMAP.md` has what was set aside for later.

### Fixed

- **Links to files with a non-ASCII space in their name** (a macOS screenshot
  has one before AM/PM) broke in silence when a note was moved, and when the
  editor inserted the image: the space was written as `%202F` or `%A0`,
  which doesn't read back. It's now written as its UTF-8 bytes
  (`%E2%80%AF`).
- **Restoring a version over a note without a `uid`** (made outside vihko)
  overwrote it, although it is another note: `409 uid_mismatch`, as with two
  different `uid`s, and it can be restored as a new note. A restore that
  leaves the note hidden from the key that made it says `nowHidden`, as any
  write.
- **A `vihko.yaml` that is a symbolic link** was replaced by a plain file the
  first time vihko wrote it (sharing, a format migration), and the file it
  led to never got the change. vihko writes through the link now, to the
  file it leads to, and the link stays.
- **The start's migration of a retired settings key** read and wrote a
  person's or a space's `.vihko/settings.yaml` through a symbolic link,
  which could lead out of the notes folder. It never follows one now.
- **Converting a deleted person's space into a shared one** removed their
  `.vihko/` for good; it still doesn't come along, but goes to the trash.
- **The log named a note of a personal space** that couldn't be read; at
  `info` it says only that it is one.
- **Deleting a shared space could be confirmed before the dialog listed
  what goes with it**; «Delete» waits for the list now, and a list that
  can't be made is said, with «Retry».
- **Escape no longer closed «New shared space» after an error**: the focus
  was lost from the dialog. Any dialog keeps it now.
- The Privacy page, and the alerts of notes too large or unreadable, showed
  places as their folders on the disk (`people/…`); they name them as the UI
  does («My notes», a person, a space). The dialog of a folder to adopt says
  its folder is on the disk.
- «Move to a new space» said links keep working: links never cross spaces,
  and the ones from the rest of the space break, as its preview lists.

### Upgrade notes

- `state.db` goes to version 13 (each device's last note); the copy before
  is left next to it (`state.db.bak-v12`).
- «On opening: Last note» starts empty on each device: it opens Home until
  you open a note there again.
- If you never chose a daily-note series and none of yours is in your own
  space, «Today's note» asks once which one to use.
- An HTTP client with a key no longer gets a 403 for its `Origin`; one that
  relied on it to refuse writes from a browser page should check the page
  instead.

## [0.1.0-rc.7] - 2026-10-03

### Added

- **The Trash screen**, «Trash» in the sidebar under «Recent changes»
  (`?view=trash`). It lists what was deleted where you can edit, since you
  could read there, and the shared spaces deleted whole that you may bring
  back, one line each: its name, where it was, who deleted it and when, how
  much it takes (and, at the top, all of it), and when the admin's retention
  takes it, if it's on. A search box, and a choice of space, narrow it.
  Anyone who sees a line may restore it; a note whose name was taken
  meanwhile comes back under another name, or in another place, instead of
  failing. **Delete forever** and **Empty the trash…** are for a shared
  space's managers (its members restore, but never destroy), a personal
  space's owner, and who managed a deleted space; they ask first and are
  confirmed at the moment. A deleted space comes back whole from there too.
  `GET /api/trash` now says each entry's size, who deleted it, what the person
  may do with it and when it expires, with the deleted spaces and the total;
  `DELETE /api/trash/:id`, `POST /api/trash/empty` and `DELETE
  /api/spaces/deleted/:id` are new. They're for the web UI: a key gets 404,
  and MCP has no tools for them (an agent restores a deleted note from its
  history).

### Changed

- **Changing your password no longer revokes your keys and apps unless you
  ask.** «Change password…» in Account opens a dialog with two boxes instead
  of one: «Sign out my other sessions», ticked by default, and «Also revoke
  my API keys and authorised apps (MCP)», not ticked, since whatever used
  them has to be set up again. The current session always stays signed in,
  and a confirmation at the moment ends whatever you choose, as before.
  Revoking now also takes a member's keys that are suspended (they no longer
  come back when the admin lets members have keys again) and OAuth codes not
  yet exchanged for tokens. `POST /api/auth/password` takes `endSessions`
  and `revokeKeys` instead of `revokeOthers`, each `false` when absent, and
  answers `sessionsEnded` and `keysRevoked` as before.

### Fixed

- **«Recent changes» and «Users and groups» no longer drag the whole page
  up** once their content has scrolled to the end: the app's frame never
  scrolls, in any view; only the main area's content does, as in a note.
- **A space renamed when vihko was upgraded is named in the history again**
  («Space renamed to its name, “…”»): the name came out empty for everyone.
  Whoever reads the space gets its name, in the API and over MCP; whoever
  doesn't, `from` and `to` as `null`, as before.

### Upgrade notes

- `POST /api/auth/password` no longer takes `revokeOthers`: send
  `endSessions: true` and `revokeKeys: true` for what it did by default. A
  request with `revokeOthers`, or any other field it doesn't take, is
  `400 invalid` and changes nothing. Without either field, a new password
  ends nothing else; in 0.1.0-rc.6, an absent `revokeOthers` ended both.
- Keys and authorised apps are only revoked by a password change when you
  tick the second box.


## [0.1.0-rc.6] - 2026-10-03

Fixes from two reviews before 0.1.0: security, and flows that a family or a
small team meets after months of use.

### Added

- **The `note_not_saved` alert**, for the admins: an open note vihko can't
  save (a full disk, a folder or state volume it may not write to), with
  why (`reason`) and where (`volume`, `space`, and `path` only to an admin
  who reads the note).
- **«Save my version as a copy» whenever something you typed can't reach
  its note**: the note was moved somewhere you can't open, deleted, or
  moved while you were offline; you can no longer edit it; your session
  ended. The copy goes next to the note, or into your own space when you
  can't write there any more.
- Leaving the page while something you typed hasn't been sent asks first.
- **Images and attachments by name, as Obsidian writes them.**
  `![[photo.png]]` and `[[invoice.pdf]]` with no folder are found by name
  among the files of the note's space, as note names are (the nearest wins,
  a tie is no answer, never another space): an imported vault's images in
  its attachments folder show again. A link to a file that isn't a note, or
  a Markdown link to one next to the note, opens it in a new tab, where the
  browser shows it (a PDF, an image) or downloads it; it's never offered as a
  note to create. `GET /api/file?note=…&name=…` gets a file as a note names
  it; links to files carry `file: true` (`GET /api/note/links`, and the MCP
  `get_note` and `related`).
- **OAuth apps from chosen domains only**, if you want:
  `mcp.client_domains` in `vihko.yaml` lists the domains remote MCP apps may
  come from (each with its subdomains). An app from elsewhere can't register
  or be authorized, and the page names its domain. Empty or left out, any
  app may ask, as before.
- The authorization page shows the app's domain in large type, for one that
  registered itself too (where it goes back to), and warns when the name an
  app gives doesn't fit its domain.
- **A maximum note size**, `notes.maxSize` in `vihko.yaml` (5 MB by
  default). A larger note is listed by its name but nothing of its text is
  indexed, and it opens as plain text with a download, never in the live
  editor; the admins get the `notes_too_large` alert, and `GET /api/note`
  says `tooLarge: true`. The API and MCP refuse a write that would make a
  note larger (`413 note_too_large`). A huge note slowed every browser that
  opened it, and the server, for everyone.
- **A deleted shared space comes back whole.** Right after deleting one,
  «Undo»; later, «Restore space» in the notice its managers get, and in the
  admin's «Spaces»: its folders (empty ones too), its notes and files from
  the trash, its members with their levels (and when each was given access),
  as it was. Only under its own name: while another space has it, `409
  space_name_taken`. Who managed it when it was deleted may restore it, and
  so may the admin, who gains no access by it. `DELETE /api/spaces` answers
  `deleted`; `GET /api/spaces/deleted` and `POST /api/spaces/restore` are
  new. Before, the dialog promised a restore there was no way to make but
  note by note.
- **Notices of what is taken away**, besides those of what is given: taken
  out of a shared space or a folder (`removed_from`, with its name and whose
  it is as you last saw them), a shared space you're in deleted
  (`space_deleted`) or restored (`space_restored`), or renamed («Casa is now
  called Hogar», `space_renamed`).
- **Renaming someone invited.** A person who hasn't used their invitation
  yet can be renamed by the admin in «Users» (`PUT
  /api/admin/users/:id/username`): their folder, the grants to them and their
  link follow. Someone who signed in can't be renamed yet (`409
  not_invited`).
- **«Adopt their folder».** Recreating someone whose `people/<name>/` is
  still there with their notes (after `state.db` was lost, or restored from
  an old copy) was refused with `personal_folder_exists`, and the folder had
  to be moved aside and back by hand. The admin can now adopt it, in «Users»
  (`adopt: true` on `POST /api/admin/users`) or with `vihko user create
  <name> --adopt`: it becomes theirs as it is. Never by default.
- **«Restore previous permissions».** When the `permissions` section goes
  from `vihko.yaml` (an example pasted over it, the file deleted), the file
  applies, so nothing is shared, as before; now the admins get the
  `permissions_missing` alert, and its button writes back the last section
  that shared something, which vihko keeps in the state volume
  (`vihko.yaml.last-permissions`), under what the file says now. Confirmed
  at the moment. Dismissing the alert forgets it. An empty section written on
  purpose (`permissions: {}`) raises nothing.

### Changed

- **A confirmation lasts 15 minutes in that browser**, as GitHub's «sudo
  mode» does: after the current code, a recovery code, the password (without
  a second factor) or a sign-in with a code, the actions «confirmed at the
  moment» (keys, OAuth, recovery codes, the admin's changes to accounts and
  spaces, retention, purges) don't ask again until it ends, and their dialogs
  show no field for it. Only that browser session: another one, an agent key
  or an OAuth token never skips one. Signing out, a new password, and a second
  factor turned off or reset end it. `GET /api/account/2fa` says whether
  confirming is needed now (`confirmNeeded`, `confirmedUntil`).
- **Agents' substitutions while someone types.** `find_replace`,
  `replace_section` and `set_frontmatter` (and `PUT /api/note`) with an
  ETag the open note had in the last few minutes go in, applied to the
  text as it is now, when nothing changed since in what they replace or
  right next to it. Before, any keystroke made them fail.
- A note vihko can't save turns read-only for everyone who has it open,
  says so, and saves on its own once it can; writes to it through the API
  or MCP answer `internal` meanwhile, and so do moving and deleting it.
- The editor's «Offline» no longer promises that changes are sent on
  reconnecting: it says to keep the tab open.
- **A shared space's guide for agents is written by its managers only.** It's
  now text in the space's «Settings…» («Guide for agents»), kept in the
  space's settings file (`guide` in `.vihko/settings.yaml`), never a note:
  before, any member who could edit the note changed what every member's
  agents were told. `PUT /api/settings` takes `guide` for a shared space and
  refuses `agents` there (`space_guide_note`). A person's own guide is still
  a note of theirs, and `mcp.instructions` in `vihko.yaml` is unchanged.
- **«Today's note» asks when the series you chose is gone** (removed,
  renamed, or in a space you left), and remembers your answer, instead of
  quietly moving to another series, perhaps a shared space's.
  `GET/POST /api/daily` and the MCP `daily_note` without a series answer
  `409 series_gone` then; Preferences shows no series chosen until you pick
  one.
- **The closest daily series wins.** When your own series (or a space's)
  writes the same notes as one of `vihko.yaml`'s, yours is the one offered,
  with its name and template; before, the installation's hid it. A choice or
  a `series` naming the installation's id still works, as yours.
- **Deleting a folder or a space takes its hidden folders too, and names
  them first.** Another program's folders (`.obsidian/`, `.trash/`, `.git/`…)
  and a space's own `.vihko/` no longer keep a folder from being deleted:
  they go to the trash with it and come back with it. The delete dialogs
  list them, and the files that aren't notes, as soon as they open, the
  known ones by what they are («Obsidian settings (.obsidian)»). Only a
  symbolic link still stops a deletion. `not_empty`'s `contents` has
  `hidden`, and `DELETE /api/folder?dryRun=true` says what deleting would
  take without deleting anything.
- **External images wait for the reader on new installations.** A note's
  image from another site shows «External image from example.com» with
  **Show** (loads it, on this page) and **Save a copy** (vihko downloads it
  into the notes folder and the note points to the copy, its text kept).
  `VIHKO_EXTERNAL_IMAGES` takes `ask` for this; `allow` and `block` are as
  before, and `block` also offers **Save a copy**. Unset, an installation
  started with this version gets `ask`; one from before keeps `allow`.
- **Travelling**: when your browser is in another time zone than the one in
  your preferences (which decides what day «today» is), vihko offers once,
  in that browser, to switch to it; it never switches by itself.
- **The log keeps personal spaces' paths out.** At the default level a path
  inside a personal space is written as «a note in a personal space» with
  its `uid`; `VIHKO_LOG_LEVEL=debug` writes paths whole, to chase a problem.
- Files opened on their own: images (not SVG) and PDFs are shown in the
  browser (`Content-Disposition: inline`); an SVG, a web page or anything
  else is downloaded.
- **A link that starts with `/` counts from the root of its note's space**,
  in every form: `[[/recipes/Bread]]`, `[bread](/recipes/Bread.md)` and
  `![](/images/plan.png)`, as Obsidian counts from the root of its vault.
  Until now a wikilink counted from the notes root (and inside a space
  never resolved), a Markdown link from the note's folder, an image from
  the notes root. A first folder `people` or `spaces` still counts from the
  notes root. A vault copied into a space keeps its links written from its
  root; a rename keeps a Markdown link or an image written so in that form;
  `[[/…` suggests notes from the root of the space.
- **A space's name can't hold `<>:"|?*`, nor be a device name of
  Windows** (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, in
  any case, with or without an extension): the name is its folder, which
  Windows and SMB shares can't create. Creating or renaming a space with one
  answers `400 invalid` (`invalid_characters` or `invalid_name`). A space
  that already has such a name keeps it.
- A series of `vihko.yaml` whose id starts with `me-` or `sp-` (in any
  case) is `invalid_id`: those are the ids of a person's and a shared
  space's series, and one there could take theirs.
- **The live tree's event stream is `GET /api/live`**, no longer
  `GET /api/events`, which answers `404`: that name is kept for a log of
  events to come.
- **Deleting someone no longer takes away at once what they shared.** Their
  space closes, but the folders they shared from it stay shared, as they
  were, until the admin decides what becomes of it (transfer it, make it a
  shared space or delete it). The delete dialog lists who has access to what
  (`GET /api/admin/users/:id/space` adds `shared`: each shared folder with
  its people and levels, its path only where the admin reads it); deleting
  the space later tells those people (`removed_from`).
- **The admin never joins a shared space without being invited.** Only its
  managers add people, the admin included: `POST /api/admin/spaces/join` is
  `409 space_has_managers` for a space with any, and «Spaces» offers
  «Join» only for one without. Its exception is a rescue: a space whose
  managers are all disabled (or gone), which the admin may join, its
  members being told.
- **Taking someone out of a shared space takes their grants below it too**,
  as leaving it does: they no longer keep a subfolder shared with them on
  its own. The dialog says so.
- **A grant inside a shared space to one of its members only raises them.**
  The share dialog offers only the levels above theirs in the space, and
  `PUT /api/permissions` refuses one at or below it with `400
  grant_not_higher` (`subject`, `level`: theirs in the space). When a
  member's level in the space goes up, their grants below that no longer
  raise them go by themselves. Sharing a subfolder with someone who isn't in
  the space is as before.

### Security

- The image no longer carries npm, npx or corepack: vihko never runs them,
  and the packages bundled with npm had known vulnerabilities.
- **Moving a folder into another space no longer brings its grants along
  unless you manage where it goes.** With only `edit` in a shared space (or in
  a folder someone shares from their own space), moving a folder of yours
  there carried its grants, up to `manage` and to anyone, and so did a note's
  folder of images in `per-note` mode: a way to share what wasn't yours to
  share. Now such a folder takes the audience of where it lands; `ai: false`
  still goes with it, and so do its grants for whoever manages the
  destination, who could give them there anyway. Within a space nothing
  changes.
- The live tree's event stream (`GET /api/live`) ends with its session:
  at once when the person signs out, is disabled or changes their password;
  at the next keep-alive when the session expires. An open editor's
  connection also ends within seconds of its session expiring, not only
  when someone ends it.
- Disabling or deleting someone, and a new invitation link for an admin who
  hasn't chosen a password yet, are confirmed at the moment (the admin's
  current code, or their password without a second factor), as the other
  changes to someone's account already were, and the other admins are told
  (`user_account_changed` with `disabled`, `deleted` or `invite_link`). A
  session left open is no longer enough to lock people out, or to make an
  admin with a password of one's own.
- Replacing every occurrence of a word in a long note (`find_replace`), a
  search over a note with thousands of matches, and saving a note with very
  long paragraphs no longer keep the server busy for seconds or minutes:
  each takes time in proportion to the text.
- A search takes at most 1,000 characters, 20 filters and 32 words: more is
  `400 query_too_complex`, by HTTP and MCP alike.
- Second-factor codes have a limit of their own for each account: after 10
  wrong ones, from any address, the waits double up to an hour (a password's
  stop at a minute), and they're forgotten only after a day without
  failures. A sign-in waiting for its code ends after 5 wrong ones: the
  password again. Guessing a code over days no longer pays.
- A note vihko can't read on the disk (no permission, an I/O error) no
  longer stops vihko from starting, nor every later rescan: it's left as the
  index had it, the server's log names it, and the admins get the new
  `unreadable_notes` alert until it can be read.
- **A deleted or renamed space's name stays taken while its trash or its
  history holds anything.** A new space with that name inherited both: its
  members could read and restore what the old space's members deleted, and
  read its versions. Creating a space, renaming one, «Move to a new space» and
  converting a deleted person's space answer `409 space_name_taken` for it,
  as for a space that exists, until the retention or a purge empties that
  past. A space can still change the case of its own name.
- **Sharing a folder no longer shares its past.** Each person sees a note's
  history, and the trash, only from when they could read it: a folder
  shared with someone (or a space they're added to, or a group they join)
  shows them the versions made, and the notes deleted, since then. vihko
  keeps in `state.db` when each grant began; a grant written by hand in
  `vihko.yaml` counts from when vihko first reads it. The same in «History»,
  «Recent changes», versions, diffs, restore and revert, through the UI, the
  API and the MCP `history` tool.
- **A note with the same path as an earlier one has a history of its own**
  when their `uid` differs: a note deleted and another made later with its
  name no longer share their versions. Restoring a version of the earlier
  note over the one there now is `409 uid_mismatch`, and the UI offers
  «Restore as a new note» instead (`POST /api/history/restore` with `to`).
- What was deleted in a folder before it moved to another space stays in the
  trash where it was, with who could see it there, as its history does.
- **Taking something out of a person's own space is never done behind their
  back.** Whoever manages a folder shared from someone's space (or edits a
  note there) may still move it to another space, and the owner gets the new
  `moved_out` notice: what moved, who moved it, and where it went (the space,
  and the path while they read there).
- **A new password can shut out whatever got in with the old one.** «Change
  password» has a box, ticked by default: «Also sign out other sessions and
  revoke keys and authorised apps». `POST /api/auth/password` takes
  `revokeOthers` (true by default) and answers `sessionsEnded` and
  `keysRevoked`; with `false`, the other sessions and the keys stay.
- **What an admin does to someone's account reaches the other admins at
  once.** A notice now arrives on its person's open pages as it's made (the
  live stream, `GET /api/live`, has a new `notices` event), so the other
  admins see an admin taking someone's second factor away, or making them a
  reset link, while it happens, not the next time they look; the server's
  log keeps both on record.
- **Turning off «Members can create keys» suspends the keys and apps
  members already have**: they stop working, answering `403 key_suspended`
  by the API and MCP alike, without being deleted, and work again when it's
  turned back on (their status is `suspended` meanwhile). The confirmation
  says how many (`GET /api/integrations` gives the admin `memberKeys`).
- **A key made, or an app authorised, on your account is never unnoticed:**
  you get the `account_key_added` notice, even when you did it yourself (a
  session someone else took would do it unseen otherwise).

### Fixed

- Idle connections stay open 65 s instead of Node's 5: a reverse proxy (or
  any client) that reuses a connection as vihko closes it no longer gets a
  reset, which behind a proxy showed as an occasional 502.
- A click on someone else's cursor in the editor, on its dot or on the name
  over it, places your cursor in the text under it: the editor ignored it,
  and your cursor stayed where it was.
- The recently opened notes the search box offers (and «When I open vihko:
  Last note») are each person's, and are forgotten when they sign out: on a
  shared browser, whoever signs in next no longer sees, nor opens, the notes
  the one before was reading.
- Transferring a deleted person's space no longer tells the admin where
  it landed in the recipient's space (`plan.to` is null for an admin who
  doesn't read there): `-2` after the name said the recipient already had
  something with it.
- Home's «what others changed» looks only among the notes the person
  reads: many changes elsewhere in the installation no longer push what
  they read out of it.
- A space's settings (`.vihko/settings.yaml`) are never read or written
  through a symbolic link, as nothing else in the notes folder is: a link
  made on the disk (or by a sync tool) could write another space's settings
  or a file outside the notes folder. Saving them there is `400
  invalid_path`.
- Finding a note by its `uid` (the MCP `get_note` with `uid`) looks only
  among the notes its person reads: someone copying that `uid` into a note
  of theirs can no longer make the lookup miss, or land on their note. The
  `uid_conflict` alert only shows to someone who reads at least two of the
  notes that share the `uid`.
- A JSON body that isn't an object (`null`, a number, a list) is `400
  invalid` on every route, where some answered 500 and wrote a trace to the
  log, the first boot's and an invitation's among them, which need no
  session.
- A manager the admin disables no longer counts as one: the space shows
  without managers (the admin's directory, `GET /api/spaces`, the
  `space_without_managers` alert), and the admin can name another. Enabled
  again, they manage it as before.
- vihko starting with a `vihko.yaml` that can't be used (a typo before a
  restart, an upgrade's among them) no longer goes on with nothing
  configured, which dropped `history.exclude` and recorded what it keeps
  out, or turned a history that is off on: the last valid file is kept in the
  state volume and applies, with the `config_invalid` alert
  (`fallback: last_good`), until the file is fixed. Its permissions still
  fail closed, as before.
- Renaming a shared space no longer hides its notes' history from
  everyone, and renaming a folder within its space no longer hides the
  history from before the rename from whoever it's shared with: each version
  is judged where the note is now, in «History», «Recent changes», restore
  and revert. A note that came from another space keeps that part of its
  past as before.
- A mistake in the `permissions` of `vihko.yaml` (`grant:` for `grants:`)
  no longer stops everyone from moving or renaming any folder or space:
  vihko.yaml is only written when what moves has rules there. Moving a
  folder (or a note with its folder of images) that has rules while the file
  has a mistake answers `409 permissions_invalid`, and the UI says to ask
  whoever runs vihko.
- A note moved somewhere the person editing it can't open left them typing
  into nothing, «Saving…» forever. It now closes, as when it goes to the
  trash, and says so.
- Text typed while offline was lost without a word when the note was moved
  or deleted meanwhile, when the person's access was lowered, or when their
  session ended; and so was what was typed in the moment someone else
  moved or renamed the note, or while closing it or opening another one.
- What an agent appends while someone types at the end of the note no
  longer splits the word they are typing.
- **Old `templates` keys are converted by vihko itself.** A `templates` key
  left in `vihko.yaml` or in a person's or a space's `.vihko/settings.yaml`
  was an «unknown key» alert that could only be fixed on the server. Now, at
  start, vihko marks the notes of those folders as templates (as «Mark notes
  as templates…» does), removes the key from the file, keeping the rest of
  it, and tells whom the file belongs to how many notes it marked and which
  folders were gone. A retired key is one entry of a small list, so the
  next one is migrated the same way.
- A settings alert said «in vihko.yaml» for a person's or a space's
  settings file: it names its own file now (`~ana/.vihko/settings.yaml`),
  with the line, and only whom the file belongs to sees it. It opens the
  settings, where a key vihko doesn't know has **Remove** (`remove` in
  `PUT /api/settings`).
- A note made a template still showed among the ⌘K box's recent notes, and
  in «On opening» › «A note» while choosing one; templates stay out of both,
  as they stay out of search, tags and Home.
- A new installation creates its history with SHA-1 ids whatever the
  system's git would choose: with a git that makes SHA-256 repositories by
  default (as git 3.0 is to), the history would record nothing. An
  existing history is unchanged.
- Renaming a shared space changes the ids of its series (they're made from
  its folder), and «Today's note» of whoever had chosen one of them asked
  them to choose again (`series_gone`): their choice now follows the new id.
  A script or an agent that kept such an id gets `not_found` with it, as
  before: `GET /api/workspace` lists the ids.
- «On opening: a note» kept the note's old path when the note was renamed or
  moved (or its folder, or its space was renamed), and vihko opened Home
  instead: the choice now follows the note.

### Documentation

- Backups: what to undo by hand after restoring an older `state.db` (or
  rolling back to a `state.db.bak-v*`), which brings back keys, sessions,
  passwords and people revoked or changed since.
- `SECURITY.md` describes the 0.x policy: fixes in a patch release of the
  latest minor version, which `:0.1` picks up.
- The reverse proxy guide and `compose.yaml` say when `172.16.0.0/12` in
  `VIHKO_TRUSTED_PROXIES` isn't safe: the port published on every address,
  or a Docker network shared with other containers.
- The install guide recommends `VIHKO_SECRET_KEY_FILE`: a key in the
  environment stays visible in `docker inspect`.
- Purging says that backups taken before still hold what was purged.
- The agents guide says that a key's folders are paths: whoever can edit
  there can move notes into a key's reach.
- Guides for going from one person to a family (moving many notes at once on
  the disk, until the tree selects several), for someone leaving with their
  notes (there's no export yet: they are plain files), and for what to check
  after restoring an older `state.db`. The import guide no longer promises
  what didn't work (images by name now do; attachments open from links).
- Notes held after a move outside vihko are released only by whoever could
  have made that move from vihko; the guide and the error when deleting a
  folder with them say so.
- The compatibility page says that version ids are opaque and change when a
  purge or a retention run rewrites the history (a kept id then answers
  `404 not_found`), and that vihko is served at the root of its domain, which
  its addresses count on.

### Upgrade notes

- While vihko is at 0.x the image is published only as `X.Y.Z` and `X.Y`:
  there is no `:0` or `:latest` tag (a new minor version may change
  things). Use `:0.1`.
- A folder (or a note's folder of images) moved into another space where you
  only edit no longer keeps who it was shared with: it's shared as the
  folder it lands in. Whoever manages that space can share it again.
- A script or an agent that searches with more than 20 filters or 32 words,
  or a query over 1,000 characters, now gets `400 query_too_complex`: split
  the search.
- A client of the API or MCP that took `412 precondition_failed` for
  granted whenever someone had typed since its read now gets its write
  applied when it touches nothing they changed. Read the `etag` in the
  answer: it's the note's new one, with their changes.
- **Shared spaces with a guide for agents**: the note their settings named
  no longer reaches agents. Its managers get a `settings_invalid` alert
  (`space_guide_note`, with the note's name); copy the note's text into the
  space's «Settings…» → «Guide for agents» and save.
- Scripts and agents calling `POST /api/daily` (or `daily_note`) without a
  series may now get `409 series_gone`: pass a `series`, or set
  `dailySeries` in the profile.
- **External images**: nothing changes for an existing installation. Without
  `VIHKO_EXTERNAL_IMAGES` it keeps loading them, as before (the default it had
  is now kept in `state.db`). For the new default, set
  `VIHKO_EXTERNAL_IMAGES: ask` in `compose.yaml`.
- **`templates` folders, if any are left** in `vihko.yaml` or in a
  `.vihko/settings.yaml`: the first start of this version marks their notes
  as templates and removes the key; the admins (for `vihko.yaml`), the
  person or the space's managers get a notice saying how many. Nothing to
  do by hand.
- The index (`index.db`) is rebuilt on its own the first time this version
  starts (it now lists the files that aren't notes, to find them by name);
  nothing to do.
- **Links and images that start with `/`** now count from the root of the
  note's space. A Markdown link `[t](/plan.md)` that led to a `plan.md` next
  to the note now leads to the one at the root of the space: write it
  without the `/` (`[t](plan.md)`) to keep it next to the note. An image
  `![](/…)` written from the notes root (`/spaces/…`, `/people/…`) still
  works.
- **A series in `vihko.yaml` whose id starts with `me-` or `sp-`** makes the
  file invalid (`config_invalid`, the last valid file applies): rename that
  series, and whoever had chosen it chooses again in Preferences.
- **A reverse proxy told not to buffer `/api/events`** (as the reverse proxy
  guide said) should say `/api/live` now; otherwise the tree may update only
  when the page is reloaded. The UI uses the new address by itself.
- `state.db` goes to version 12 (a copy of version 11 is kept as
  `state.db.bak-v11`): when each grant began, since when each person is in a
  group, and the shared spaces deleted to the trash. The grants in
  `vihko.yaml` when 0.1.0-rc.6 first starts count from the start, and so do
  the groups' members then: nobody loses a past they could see. From then on,
  whoever is given access sees the past only from that moment.
- Notes larger than 5 MB (or `notes.maxSize`) stop being searchable and open
  as plain text: raise `notes.maxSize` in `vihko.yaml` if you have such notes
  and want them as before.
- With «Members can create keys» off (the default of a new installation
  since 0.1.0-rc.4), the keys and authorised apps members made while it was
  on stop working (`403 key_suspended`) until the admin turns it on again.
  Admins' keys aren't affected.
- Changing your password now revokes your keys and authorised apps too,
  unless you untick the box (or send `revokeOthers: false`): a script or an
  app that used one needs a new key afterwards.

## [0.1.0-rc.5] - 2026-10-02

Templates marked in the notes themselves, and searching by any frontmatter
field.

### Added

- **Search by frontmatter fields**, in the search box, `GET /api/search` and
  the MCP `search` tool: `type:decision` keeps the notes whose frontmatter has
  `type: decision` (any key whose name isn't reserved; in a list, any item;
  a number however it's written), `prop:key=value` does the same for any key
  at all, `prop:key` keeps the notes that have the key, and `-` in front
  excludes. Keys and values ignore case; quotes for spaces. Only simple
  values count (text, numbers, true/false, dates and lists of them), never
  those of notes you can't read.
- Reserved filter names: `tag:`, `path:`, `is:`, `has:`, `in:`, `prop:`,
  `before:` and `after:` are vihko's own, now or later, and never a
  frontmatter field (reach one with `prop:`). `is:`, `has:`, `in:`,
  `before:` and `after:` mean nothing yet and match no note.
- **Templates are notes marked `template: true`**, wherever they are. A
  note's menu in the tree has «Make a template» and «Stop being a template»;
  a folder's menu, «Mark notes as templates…», which says how many notes it
  will mark before it does. The tree shows a small mark on each template, and
  `GET /api/tree` gives `template: true` for them.
- A note made from a template gets the template's frontmatter (`type`, tags,
  any key, `ai` included) without its `template: true` and its `aliases`,
  every other byte as it was.
- `POST /api/folder/templates` and `POST /api/note/template`, for the UI.
- The search box's filter hints list the new filters.

### Changed

- Templates are offered from every space you read, marked, not from
  configured folders; `template:true` in the search box lists them. Naming a
  templates folder with `path:` no longer brings its notes into search.
- `GET /api/workspace` no longer has `templates`, and the note settings
  (`GET/PUT /api/settings`) no longer have `templates`.
- A query word with a colon in it (`re:budget`) is now a frontmatter filter,
  or a reserved one; quoted whole (`"re:budget"`) it's searched as text, and
  times (`10:30`) and addresses (`https://…`) stay words.
- Preferences: the box that chooses and defines daily notes is «Daily notes».
- The admin setting for saving copies of images from private addresses says
  what it guards, in plain words, and the notes guide explains it.

### Upgrade notes

- Test it with `ghcr.io/kirianm/vihko:0.1.0-rc.5` (the new `compose.yaml` names it).
- **Templates folders are no longer configured.** The `templates` key of
  `vihko.yaml` and of a person's or a space's settings (`.vihko/settings.yaml`)
  is now an unknown key: ignored, with a warning, until you remove it. Your
  templates stay where they are, but aren't offered until you **mark them**:
  open the menu of each templates folder in the tree → **Mark notes as
  templates…** → **Mark as templates**. That writes `template: true` into the
  frontmatter of each note in it, and nothing else. vihko doesn't mark them
  on its own. A daily series' `template` works as before, marked or not.
- The index (`index.db`) adds the frontmatter fields on its own the first
  time this version starts; nothing to do.
- Scripts that read `templates` from `GET /api/workspace` or the settings
  should use the notes with `template: true` instead (`GET /api/tree`, or a
  search for `template:true`).

## [0.1.0-rc.4] - 2026-10-02

What writing step-by-step guides for rc.3 turned up, and tests that only
failed with some random data.

### Added

- Step-by-step guides: your own note settings (a daily journal, templates,
  where new images go, a guide for agents), a shared space's settings and how
  the installation's, the space's and yours add up, Home and «On opening»,
  making and sharing spaces, «Shared with me», and turning retention on.
- `guideMissing` in `GET/PUT /api/settings`, and the `settings_guide_missing`
  alert: a guide for agents that names a note that doesn't exist is saved,
  with a warning, and its owner is told until the note exists.
- Tooltips with the shortcut on the sidebar's icon buttons.

### Changed

- **«Today's note» stays on the series you use.** With no choice saved, your
  own series come first, then your spaces', then the installation's; the
  first time you open today's note, that series becomes your choice
  (`dailySeries` in your profile), so a series a space adds later never
  takes over. Change it in Preferences.
- One name for it everywhere: «Today's note».
- Preferences: «Daily note series» and «Your note settings» sit together,
  each saying what it is for; the «My notes» menu says «Your note settings…».
- Members and Share dialogs ask before closing with unsaved changes; your own
  row offers «Leave» instead of removing yourself.
- Retention's confirm button says what will happen («Save», «Save and
  remove», «Run now», «Remove now»).
- A pinned folder is listed once; each sidebar section shows what kind it is;
  Home has its own mark, so a space called Home can't be taken for it.

### Fixed

- «X added you to <space>» kept the space's old path after a rename and said
  you no longer saw it; notices now follow folders as vihko moves them.
- A notice for a folder shared by its owner named the owner twice.

### Upgrade notes

- Test it with `ghcr.io/kirianm/vihko:0.1.0-rc.4` (the new `compose.yaml` names it).

## [0.1.0-rc.3] - 2026-10-01

### Upgrade notes

- Test it with `ghcr.io/kirianm/vihko:0.1.0-rc.3` (the new `compose.yaml` names it).
- **A shared space's folder is its name**: `spaces/Home/`, not
  `spaces/home-7k2q9x/`. When it starts, vihko renames each shared space made
  by rc.1 or rc.2 to the name it had (or, if that name can't be a folder's,
  to its folder's readable part), as a rename from vihko would: its notes,
  its rules in `vihko.yaml`, the keys, pins and trash entries that named it,
  and the history all follow, and the `name` key goes from `vihko.yaml`. If
  another space or folder already has that name, the space is left as it is
  and the admins get the alert `space_not_renamed`; each start tries again.
  Nothing to do otherwise. Scripts and agents that kept a space's path should
  ask `GET /api/spaces` (or `list_folder("")`) again.
- **Names of shared spaces are unique** in the installation, without regard
  to case, and visible to everyone in it (not what a space holds or who is in
  it). Creating or renaming a space to a name another has answers
  `409 space_name_taken`.
- **The `id` of shared spaces is gone** from `GET /api/spaces`,
  `GET /api/admin/spaces` and MCP's `list_folder("")`: a space is its `path`,
  and its `name` is its folder's.
- **Note addresses** of a shared space are `?note=Home/…`. One saved with an
  rc.1 or rc.2 folder (`?note=home-7k2q9x/…`) opens the note in the space it
  became, for whoever is in it.
- **`state.db` migrates** (a new version: what vihko opens when each person
  comes in). «Open today's note when vihko opens» carries over as «On
  opening: today's note». `openDailyOnStart` of `/api/profile` is deprecated:
  use `onOpen`.

### Added

- **Home**: where vihko opens, and where the sidebar's logo always leads.
  Your recent notes, what others changed lately in the notes you read (and
  who, where you may see the history), what was shared with you in the last
  30 days, and quick actions (new note, today's note, search, new space). All
  of it from the index, the history and your notices; nothing is stored for
  it, and nothing in it is anything you can't read. On a phone, vihko opens
  at Home too, with the folders behind the menu button.
- **«On opening»** in Preferences: Home (the default), the last note you had
  open on that device, a note you pick by its name, or today's note if it
  already exists (never created on coming in; offered when you have a daily
  series). It replaces «Open today's note when vihko opens».
- **The tree and the sidebar are live**: what someone else creates, renames,
  moves or deletes where you read, a folder shared with you or taken back, or
  a space you're added to or removed from, shows without reloading. The
  server only says «read your tree again» (`GET /api/events`, a server-sent
  event stream), and only to those a change concerns: never what changed,
  and never to someone who can't read it. A reverse proxy must not buffer
  `/api/events` (most don't for `text/event-stream`).
- **«Back»** on the pages (Account, Agents and API, Privacy, Users and
  groups, Spaces, Alerts, Recent changes): to the note or Home you came from.
- **Settings of a person or a space**, without touching `vihko.yaml`: daily
  notes, templates folders, where new images go and a guide for agents.
  Yours, in Preferences › «Your note settings»; a shared space's, from its
  «Settings…» (its managers). They live in the space,
  `people/<you>/.vihko/settings.yaml` or `spaces/<name>/.vihko/settings.yaml`
  (one format, with `version`, paths relative to the space), and add to the
  installation's: the series and templates of `vihko.yaml`, your spaces and
  your own (a series that gives the same notes as another is offered once);
  a space's images setting for its notes; agents get the installation's
  guide, then each space's their key reaches, then yours. vihko writes only
  what changed and keeps comments; a hand edit applies at once, and what's
  wrong in it is an alert to whom the file belongs (never the admin as
  such). `GET/PUT /api/settings`, alert `settings_invalid`.

### Changed

- **The frontmatter is protected in the editor**: select all (Ctrl/Cmd+A)
  selects the body, and deleting, typing, pasting or dropping in the body
  never reaches the frontmatter, so a note never loses its `uid`, aliases,
  tags or `ai: false` by accident. It's edited by opening its folded block
  (where select all takes its YAML). Other editors, the API and MCP are as
  before.
- **Renaming a shared space renames its folder** (and its notes' addresses);
  links between its notes stay as they are, since they never leave the space.
- `spaces/` holds shared spaces by name: any folder there is a space but a
  hidden one, one starting with `~`, one ending with `.`, `~` or `.md`, and
  `people` or `spaces`. A space's name can't hold `/` or `\` (`400 invalid`
  with `problem: invalid_characters`), nor be one of those names
  (`invalid_name`).

### Fixed

- «End» on a long line with a comment at its end could leave the cursor
  inside the comment's hidden syntax, and what was typed vanished into the
  comment: the keyboard never leaves the cursor inside a comment now.
- A phone no longer bounces a short note (or the page) past its ends.
- Templates no longer show in search (unless asked for by their folder with
  `path:`), in the tags and in Home.
- Reading a template's frontmatter (`date: {{date}}`) no longer writes a
  warning to vihko's log.
- Trashing a note open in the editor right after pasting an image into it
  could tell its editors before the image was in the trash: they are told
  once the whole entry is there.
- An open note whose folder was moved and moved back (through the API, by
  someone else) could end shown as missing, and a reload opened its old
  path: a `not_found` for a note vihko moved in the last two minutes says
  where it went (`movedTo`), to whoever reads it there, and the editor
  follows it.

### Added: retention

- **Retention**, off by default: in «Users and groups» → Retention the admin
  can have vihko empty the trash after so many days, and delete history
  versions older than so many days or months, once a week (Sundays at 03:00
  server time) or at once with «Run now». The current version of every note is always kept, and so is the whole
  history of notes still in the trash; once a note's trash entry is emptied,
  its history goes with it. Turning either on, or shortening it, shows first
  what the next run would remove (counts and sizes, never a path) and asks
  for your code or password, and so does «Run now». Every admin is told what
  each run removed. See
  [Operations](guide/operations.md#retention) and
  [Backups](guide/backups.md#retention-and-backups).
- `trashRetentionDays` and `historyRetentionDays` in `GET/PUT
  /api/admin/settings`, `GET /api/admin/retention`, `POST
  /api/admin/retention/preview`, `POST /api/admin/retention/run`, and the
  admins' `retention_ran` notice.

### Upgrade notes: retention

- Nothing changes until an admin turns retention on. When they do, what it
  removes is gone from vihko for good: keep backups for longer than the
  periods you choose if you want a way back. A run that removes versions
  rewrites the history, so links to a version (`&version=<id>`) kept from
  before it stop working; it runs weekly to keep that rare.

## [0.1.0-rc.2] - 2026-10-01

What the first real install of rc.1 brought up: links now stay inside their
space, the interface never shows the folders `people/` and `spaces/`, paths
are typed as people see them, purging works as it should, and the selects
look the same in every browser.

### Upgrade notes

- Test it with `ghcr.io/kirianm/vihko:0.1.0-rc.2` (the new `compose.yaml` names it).
- **Links no longer cross spaces.** A link, by name or by path (`[[spaces/…]]`,
  `[[people/…]]`, `[[/…]]`, a relative Markdown link), only leads to a note of
  its own space. Links rc.1 wrote into another space
  (`[[spaces/home-7k2q9x/Plan|Plan]]`) are broken from now on; nothing rewrites them. vihko rebuilds the links in
  its index once at start (nothing to do).
- **The move report's `crossSpaceLinks` is gone**, replaced by `brokenLinks`
  (over MCP, the new `broken_links`): the links a move to another space leaves
  broken, each with `path` and `to`. Each change in `relinked` has two more
  fields, `kind` and `to`.
- **Note addresses in the browser** are `?note=home-7k2q9x/…` for a shared
  space and `?note=~<username>/…` for a person's. Links and bookmarks with the
  old form (`?note=people/…`, `?note=spaces/…`) still open the note.

### Added

- **The move dialog lists, in plain words, the links a move to another space
  leaves broken** («In My notes / Home, the link to Trip will be broken (it
  now lives in Family)»), in the moved note and in the notes left behind, and
  asks to confirm.
- `GET /api/history/purgeable`: what the person may purge and reads, to pick
  from (deleted notes marked). The admin's purge form offers it, deleted notes
  first.
- Purge a note just deleted from the notice that offers to restore it, and one
  deleted earlier from its «deleted» line in Recent changes.

### Changed

- **Links stay inside their space** (wikilinks, embeds of notes and Markdown
  links to notes): a path into another space is broken, exactly like a link
  to a note that doesn't exist. vihko never writes a link to another space:
  a move to another space rewrites nothing across spaces (its links stay and
  resolve in the new space), the `[[` suggestions only offer notes of the
  same space, and «create» on a broken link only creates in that space.
  Images still travel with the note.
- **No screen, field or notice shows `people/` or `spaces/`**, the admin's
  included: spaces and people by their names. The browser's address uses the
  space's folder, or `~` and the username.
- The rename and move previews speak in sentences with the names people see,
  never raw Markdown or paths on disk.
- Every select (`<select>`) has the same look in Chromium, Firefox and Safari,
  light and dark: its own chevron in the theme's colours, with room for it.
- Paths people type in the interface are found as links are: as they see
  them («My notes / diary / day», «Home / recipes»), in any case. The admin's
  purge, where something is moved and a new note's folders in the palette use
  an existing folder whatever its capitals, and ask which one when several
  differ only in capitals. The API stays exact.

### Fixed

- Purging a note whose name was typed in other capitals, or from a path such
  as «my notes/…», found nothing after asking for the code again and again:
  the admin's purge form takes the path as the admin sees it, never asks for
  `people/…`, and finds the note in any case; when nothing there has history it says so instead of
  purging nothing; and it asks for the code or password once per purge.

## [0.1.0-rc.1] - 2026-10-01

The first release of the relaunch: vihko around **spaces**. Each person has a
space of their own, shared spaces hold what belongs to several people, and
anyone can share a folder of theirs with someone in particular. Your notes
are still plain Markdown files, now in two fixed folders: `people/` and
`spaces/`. What you can't see never gets in your way or tells you it exists.

Everything else of the withdrawn 1.0.1 is here: the collaborative editor,
history, agents over the API and MCP, groups, a second factor, and the same
Docker image and volumes.

### Added

- **Your own space**, «My notes»: `people/<username>/`, made with each
  account (the first admin's too, and on a single-person install). Only you
  see it, except what you share.
- **Shared spaces**: `spaces/<readable>-<id>/`, created by anyone (or only by
  admins, a setting), with members at four levels (read, comment, edit,
  manage). Rename, leave and delete them; every member sees who the others
  are.
- **Folders shared one by one** from your space, under «Shared with me» with
  their owner; pin them to the sidebar; stop seeing them.
- **Moving between spaces** says who gains and loses access, and whose the
  note becomes, before anything moves; images it shares with other notes are
  copied to the new space.
- **Links across spaces**, written from the notes root with the note's name
  as text (`[[spaces/home-7k2q9x/Plan|Plan]]`), kept in step when the note is
  renamed; the `[[` suggestions write them.
- **The admin's «Spaces» page**: every shared space's name, managers and
  member count, never its content; assign a manager to a space without one;
  join a space, visibly; decide what becomes of a deleted person's space
  (transfer it, make it a shared space, or delete it). Deleting a person
  offers to transfer or convert their space right there, and while a
  deleted person's space is undecided the admins get `closed_spaces`.
- **Move to a new space…** and **Move to My notes…**, in a folder's menu and
  in the share dialog: since a subfolder can't be closed to those who see the
  folder above it, the way out is to make it a space of its own
  (`POST /api/spaces/from-folder`), with the usual move confirmation.
- **Notices**: when someone adds you to a space or shares a folder with you;
  when the admin changes a space that concerns you; when a move of yours
  left links in other spaces that couldn't be updated.
- **Alerts** for the admins: what is in the notes folder outside every space
  (`outside_spaces`, with `into`, the admin's own space to move it into),
  folders in `people/` named after nobody, and shared spaces without members
  or managers.
- **HTTP API**: `GET /api/spaces` and `GET /api/spaces/members` for keys; the
  move report's `crossSpaceLinks`, `images.copied` and `audience.owner`; the
  error codes `outside_space`, `space_root`, `held_inside`,
  `leave_via_group`, `space_has_managers`, `space_needs_manager` and
  `personal_folder_exists`.
- **MCP**: `list_folder("")` lists the spaces the person reaches, each with
  its `space`; the server's instructions name the person's space, the shared
  spaces and the folders shared with them, and how to link across spaces.
- **`vihko.yaml`**: `name` at a shared space's root; `templates` takes a list
  of folders, each with `{user}`; `mcp.instructions` takes `{user}` too, so
  each person's agents get their own guide.
- `guide/compatibility.md` for 0.x: the whole surface, taken from the code.
- From the 1.0.1 work not published before: the dark theme's bold and
  headings stand out; Ctrl+E (inline code), Ctrl+Shift+S (strikethrough),
  Ctrl+K over a selection makes it a link; the admins see an alert when
  `state.db` migrates at start; a `vihko.yaml` rewrite raises its `version`.

### Changed

- **Sharing only adds.** Everyone who can read a folder sees everything in
  it; a subfolder can add people, never take them away. A folder's own
  grants no longer replace the inherited ones, and whoever manages a folder
  no longer manages it «from above».
- **A link by name resolves only within its own space**, and an alias that
  several notes share is ambiguous. A link to a note you can't read looks
  broken, exactly like one to a note that doesn't exist (no more lock); for
  agents, `agent_denied` keeps only the reasons `ai_false` and
  `outside_key_folders`.
- **A name that would make someone else's link lead to a note you can't
  read** isn't available for a new note, a rename, a move, a restore or an
  alias added by an edit when that link is in a note you read: `exists`, as
  for a taken name. When the link is in a note you can't read, vihko keeps it
  on its note as the system (history reason `links_kept`) and says nothing.
  A move's dry run doesn't check.
- **Permissions are checked before the disk**: a request about something you
  can't read answers `not_found`, whether it exists or not.
- `GET/PUT /api/permissions` (the UI's) answer `inherited`, `owner`, `space`
  and `ai`; «Permissions…» is now «Share…».
- `attachments.folder` is relative to each note's space.
- A series, templates folder or agents' guide outside a space is ignored,
  with a warning.
- The admin's purge notice names the path only to an admin who can read it,
  or who purged it. An admin joining a space tells its managers and the other
  admins.
- What could tell someone about what they can't read doesn't any more: a
  move's progress counts only the notes you read; the admin's rescan answers
  counts, the list of everyone's keys leaves out folders the admin doesn't
  read (`foldersHidden`), the purge preview of a path the admin can't read
  says nothing of it (`hidden`), and a transfer's preview never looks into
  the recipient's space; history cursors are opaque; restoring from the trash
  names only what is left where you read; signing out clears the editor's
  suggestions.
- Creating a note from a broken `[[spaces/…]]` or `[[people/…]]` link creates
  it at that path; where you can't create, the answer is a taken name's.
- `everyone`, `all`, `public` and `anyone` can't name a group; `.vihko/` is
  reserved at the root of every space.
- The command line prints an account error with its code, `error (<code>)`.
- The theme is kept on each device, not in the account.
- `GET /api/trash` (the UI's) gives each entry's `space`; a deleted shared
  space's notes stay restorable by its managers.
- Usernames can't start with a dot.
- `compose.yaml` pulls `ghcr.io/kirianm/vihko:0.1`.

### Removed

- The implicit rule (every admin managing the root), `{user}` rules and
  subjects, and the `""` key in `permissions`.
- Folder permissions that replace what a folder inherits, and managers from
  above.
- The `user_no_access` reason of `agent_denied`, and the «no access» lock on
  links.
- «Move their permissions» for notes held after a move made outside vihko:
  only «Release» remains.
- The admin's list of every folder's permissions.
- The `attachments_shared_folder` alert.

### Upgrade notes

- **No upgrade path from 1.0.x.** Start with an empty notes folder (and an
  empty state folder), then copy your notes into your own space,
  `people/<you>/`, or into a shared space's folder (see
  [Notes you already have](guide/install.md#notes-you-already-have)). A 1.0.x notes folder
  under 0.1.0 shows nothing: its notes are outside every space and its
  `permissions` section is rejected.
- rc.1: test it with `ghcr.io/kirianm/vihko:0.1.0-rc.1`; `:0.1`
  exists from 0.1.0 on.

<details>
<summary>Earlier: the withdrawn 1.0.x line</summary>

### 1.0.1 - 2026-09-29

**Use 1.0.1 instead of 1.0.0.** It corrects 1.0.0, published the same day,
once: taking the inventory of what 1.x promises (`guide/compatibility.md`,
new) showed a few things 1.0.0 got wrong, and connecting claude.ai to a real
installation showed it couldn't. The release candidates below have the detail.

#### Added

- `guide/compatibility.md`: everything 1.x keeps stable, taken from the code
  (the HTTP API route by route, the MCP tools, `vihko.yaml`, environment
  variables, the Docker image, the command line, what vihko writes into
  notes, OAuth), what isn't covered, and the rules: a security fix may change
  something; lists of values may gain values; limits may change, announced; a
  default may change to close something, never to open it.
- The command line is part of the promise: commands, options and exit status.
- Before publishing, a release starts the previous stable version with data
  and starts the new one on top (`npm run upgrade-smoke`).

#### Changed

- **HTTP API: the fields that came in `snake_case` are `camelCase`**
  (`meta.fmError`; a link's `dstPath`, `anchorOk`, `posFrom`,
  `othersNoAccess`). MCP keeps `snake_case`.
- `POST /api/note/edit` answers a malformed operation with `400 invalid`, as
  MCP does, and takes at most 50 operations.
- MCP answers invalid arguments with `invalid` and a writing tool called with a
  read-only key with `forbidden`, in vihko's `{ error, message }` JSON.

#### Fixed

- **claude.ai can connect.** `/mcp` refused its requests (`Origin:
  https://claude.ai`) with `403` before the `401` that tells a client how to
  sign in, and its published identity (client metadata document) was refused
  for listing a grant type vihko doesn't use. A credential that isn't valid
  now always gets that `401`; an OAuth token is also accepted from its app's
  own site. «OAuth apps can register themselves» isn't needed for claude.ai.
- Moving or renaming a note to a name with parentheses, `#`, `?` or brackets
  left the Markdown links to it broken.
- `/api/health` and `/api/setup` answered `404` when the request carried a key.
- `vihko user create --admin <name>` created an admin named `--admin`.
- On Windows, AltGr+D opened today's note instead of typing a character.
- The image's description no longer mentions webhooks.

#### Upgrade notes

- `:1` moves to 1.0.1; `docker compose pull && docker compose up -d`.
- Scripts that read `fm_error`, `dst_path`, `anchor_ok`, `pos_from` or
  `others_no_access` from the HTTP API read the `camelCase` names.
- Scripts that relied on `409 edit_mismatch` for a malformed edit get
  `400 invalid`, with at most 50 operations per call.

### 1.0.1-rc.3 - 2026-09-29

#### Fixed

- **claude.ai still got `403` at `/mcp`.** Its first request already carries
  an `Authorization: Bearer` header, empty or with a token that no longer
  holds, and the `Origin` was judged before such a credential. Now a
  credential that isn't valid (none, empty, unknown, expired or revoked) always
  gets the `401` that tells a client how to sign in, whatever the `Origin`;
  the `Origin` only counts once the credential is valid.

#### Upgrade notes

- Test it with `ghcr.io/kirianm/vihko:1.0.1-rc.3`.

### 1.0.1-rc.2 - 2026-09-29

The second candidate of 1.0.1: connecting claude.ai to a real installation
turned up two faults, and the page of what 1.x keeps stable now promises
effects rather than details, so what's planned for 1.x fits in it.

#### Fixed

- **claude.ai couldn't connect to `/mcp`.** Its connector sends
  `Origin: https://claude.ai`, and `/mcp` refused any other site's origin
  with `403` before the `401` that tells a client how to sign in. Now a
  request without credentials always gets that `401`; with an OAuth token,
  the origin of the app's own return address is accepted too; with a key,
  only vihko's own, as before.
- **claude.ai's published identity (its client metadata document) was
  refused**, because it lists a grant type vihko doesn't use. Grant types
  besides the code flow are now ignored, for registered apps too.
- The guides and the Agents page said claude.ai needs «OAuth apps can
  register themselves»; it doesn't, only apps such as `mcp-remote` do.

#### Changed

- `guide/compatibility.md` promises what matters and not the details that
  would tie 1.x down: a security fix may change something; lists of values may
  gain values; new limits may come (request rates included, with `429`); a
  default may change to close something, never to open it; MCP is promised
  over `POST`, with the protocol versions the specification sets; search
  ranking and snippets, key format after `vihko_`, new image names and
  timings aren't covered; rewritten links keep pointing at their note;
  `VIHKO_INTEGRATIONS=off` also turns off integrations that come later.
- The trash never empties on its own by default; a later release may add an
  optional retention.

#### Upgrade notes

- Test it with `ghcr.io/kirianm/vihko:1.0.1-rc.2`.
- To connect claude.ai, add the connector with your public address followed by
  `/mcp` and keep Claude's published identity; «OAuth apps can register
  themselves» can stay off.

### 1.0.1-rc.1 - 2026-09-29

A correction of 1.0.0, published the same day. Taking the inventory of what
1.x promises (`guide/compatibility.md`, new) showed a few things 1.0.0 got
wrong; 1.0.1 changes them outright, **once**, instead of keeping both forms
until 2.0. It's the only exception to the promise, and it's written down in
that page.

#### Added

- `guide/compatibility.md`: everything 1.x keeps stable, taken from the code
  (the HTTP API route by route, the MCP tools, `vihko.yaml`, environment
  variables, the Docker image, the command line, what vihko writes into notes,
  OAuth), and what isn't covered.
- The command line is part of the promise: commands, options and exit status
  (0 done, 1 an error, 2 the usage).
- Before publishing, a release now starts the previous stable version, fills
  it with users, a key, notes, an image and a comment, and starts the new
  version on the same data (`npm run upgrade-smoke`).

#### Changed

- **HTTP API: the fields that came in `snake_case` are `camelCase`**, like all
  the others: `meta.fm_error` is `meta.fmError`; a link's `dst_path`,
  `anchor_ok`, `pos_from` and `others_no_access` are `dstPath`, `anchorOk`,
  `posFrom` and `othersNoAccess`. The MCP tools keep `snake_case`, their
  convention throughout.
- `POST /api/note/edit` answers a malformed operation (unknown `op`, missing or
  wrong field, none or more than 50 operations, `set_frontmatter` on `uid`)
  with `400 invalid`, as MCP does; it was `409 edit_mismatch`.
- MCP: arguments that don't fit a tool answer `invalid`, and a writing tool
  called with a read-only key answers `forbidden`, both in vihko's
  `{ error, message }` JSON.
- Limits (image size, operations per call…) may go down within 1.x, announced
  here in the Upgrade notes.

#### Fixed

- **Moving or renaming a note to a name with parentheses, `#`, `?` or
  brackets (`a (1).md`) left the Markdown links to it broken.** Rewritten
  links are now encoded like image links, and keep their `<…>` form, anchor
  and title.
- `/api/health` and `/api/setup` answered 404 when the request carried a key.
- `vihko user create --admin <name>` created an admin named `--admin`, and
  `vihko serve` took any argument.
- On Windows, AltGr+D (a character on some keyboards) opened today's note
  instead of typing it.
- The image's description no longer mentions webhooks, which 1.0 doesn't
  have.
- The guides: only MCP `get_note` takes a `uid`; history author kinds `git`
  and `external` and several response fields documented; which environment
  variables are checked.

#### Upgrade notes

- Test it with `ghcr.io/kirianm/vihko:1.0.1-rc.1`; `:1` moves to 1.0.1 when
  it's released.
- Scripts that read `fm_error`, `dst_path`, `anchor_ok`, `pos_from` or
  `others_no_access` from the HTTP API read the `camelCase` names.
- Scripts that rely on `409 edit_mismatch` for a malformed edit get
  `400 invalid`, and at most 50 operations per call.
- `vihko user create` with arguments other than a name and `--admin`, or
  `vihko serve` with any argument, prints the usage and exits with 2.

### 1.0.0 - 2026-09-29

**Superseded by 1.0.1 the same day: use 1.0.1.**

The first stable release: a self-hosted notes system over plain Markdown
files, with its own web UI, several users and live collaboration. Your notes
stay a folder of `.md` files; the index, the history and the application state
live apart and never replace them.

What 1.0 brings, from the release candidates below:

- **Notes**: a live-preview editor for computer and phone with a formatting
  toolbar, wikilinks and Markdown links that follow renames and moves,
  backlinks, tags, tasks, tables, images, comments inside the note, search,
  templates and daily notes. Changes made by other editors or sync tools on
  the same folder are picked up while vihko runs.
- **Collaboration and people**: several people in the same note at once, with
  presence; users and groups, per-folder permissions (read, comment, edit,
  manage), personal folders, sign-up links and a second factor.
- **History**: every note's versions, diffs and restore, recent changes for
  the workspace, and purging what shouldn't have stayed.
- **Agents, optional and off by default**: an HTTP API with keys and an MCP
  server (with OAuth for remote clients), which only see and write what the
  person they act for can.
- **Operations**: one Docker image for amd64 and arm64, a hardened
  `compose.yaml`, automatic migrations with a backup, and guides for
  installing, backing up, upgrading and running it behind a reverse proxy.

#### Changed

- `compose.yaml` pulls `ghcr.io/kirianm/vihko:1`: every 1.x release, never an
  incompatible version.
- The README shows the product, on a computer and on a phone.

#### Upgrade notes

- From a release candidate: change the image line of your `compose.yaml` to
  `ghcr.io/kirianm/vihko:1` (or take the new file); nothing else changes since
  1.0.0-rc.4.

### 1.0.0-rc.4 - 2026-09-29

The fourth release candidate: what the third one's installation turned up.

#### Added

- **A formatting toolbar**, for anyone who doesn't write Markdown: above the
  note on a computer, over the keyboard on a phone (one row that scrolls).
  Text style (normal, headings 1–3), bold, italic, strikethrough, inline
  code, link, bulleted, numbered and task lists, quote, code block, table and
  image, besides `[[`, `#` and comments. Each button turns its format off
  when it's already on and shows when the cursor is inside it; line formats
  apply to every selected line. It only writes standard Markdown.
- Shortcuts: Ctrl+B bold, Ctrl+I italic (it was «select the enclosing
  syntax»), Ctrl+Alt+K link (⌘B, ⌘I and ⌥⌘K on a Mac).
- «New folder» in the command palette (`>`), inside the open note's folder.

#### Changed

- **Members can no longer create keys by default**, and **OAuth apps can no
  longer register themselves by default**: the vihko admin turns each on in
  Agents and API. The registration switch sits right under the MCP one;
  clients that identify themselves with a URL (CIMD) don't need it.
- The vihko admin's «Purge from the history» moved from Users and groups to
  Recent changes.
- On a phone, the save status in the bottom bar is an icon while all is well,
  and keeps its text when something needs your attention.

#### Fixed

- Recent changes stopped loading after any purge from the history, until
  vihko restarted.
- Strikethrough and inline code show as such in the editor.

#### Upgrade notes

- Take the image line of the new `compose.yaml`
  (`ghcr.io/kirianm/vihko:1.0.0-rc.4`).
- If you never touched «Members can create keys» or «OAuth apps can register
  themselves», they are now off. Members' existing keys and apps already
  registered keep working; turn the switches on in Agents and API if members
  should create keys or claude.ai or mcp-remote should connect anew.

### 1.0.0-rc.3 - 2026-09-29

#### Added

- **Agents can store images through MCP**: the `attach_image` tool (keys
  that can write) takes an image in base64 and the note it's for, stores it
  like an upload (next to the note by default, within the key's folders and
  never where agents are kept out) and answers with the link to write into
  the note. Images up to about 3 MB fit in one call.

#### Fixed

- The API's answer to an image upload carries `markdown`, the link ready to
  write into the note. Writing `src` as it was broke the link when the name
  had a space: the note didn't use the image, a key couldn't read it, and
  deleting the note left it behind.

#### Upgrade notes

- Take the image line of the new `compose.yaml`
  (`ghcr.io/kirianm/vihko:1.0.0-rc.3`); nothing else changes.
- Scripts that upload images through the API should write the answer's
  `markdown` into the note instead of building the link from `src`.

### 1.0.0-rc.2 - 2026-09-29

The second release candidate: what the first one's installations turned up.

#### Fixed

- **An undo made in another editor is no longer overwritten.** With a note
  open in vihko, undoing a change in another editor (saving back the text it
  had before) could be undone again by vihko, which wrote its own copy over
  the file. The other editor's save now wins, and live edits are still kept
  when another program saves from an old copy of the file.
- Markdown links (`[text](note.md)`, `[text](https://…)`), also in tables, can
  be clicked: a note opens, an external address opens in a new tab.
- Inserting an image right after pasting or clicking another no longer puts
  it inside the first one's reference; nothing inserted lands inside a link,
  an image or a comment.
- Renaming, moving or deleting a note takes its saved editor state along, so
  none is left behind in the state volume.
- Name fields no longer start with a capital letter on phones.
- «1 workspace alert», singular.

#### Added

- **A language preference**, in Preferences → Account and in ⌘K: English,
  Spanish or the browser's, saved in your account.
- Deleting a note sends the images only it uses to the trash with it, and
  restoring it brings them back.
- **Delete folder** lists what the folder holds and can send it all to the
  trash in one step.
- On a computer, commented text shows that it has comments and opens them on
  a click, with the side panel closed too.
- A warning at start when `VIHKO_TRUSTED_PROXIES` covers a wide range.
- The guide [First steps in the app](guide/first-steps.md), and fuller guides
  for a reverse proxy on another machine and for file ownership.

#### Changed

- **The example `compose.yaml` runs vihko as the owner of your notes**:
  `user: "${VIHKO_UID:-1000}:${VIHKO_GID:-1000}"`, with the ids in `.env`
  (the quick start writes it). When vihko can't write its folders it says so
  in one line with the fix, instead of a stack trace.
- vihko doesn't start when the notes folder is missing (an unmounted share
  would look like an empty one).
- Typing `folder/name` in New note creates the note in that folder (from the
  current one; `/folder/name` from the root), and its heading is only the
  name.
- A code block's fences hide while the cursor is outside it; its language
  shows as a small label.
- The workspace alerts' address is `?view=alerts` (`?view=avisos` still
  opens it).

#### Upgrade notes

- **Take the new `compose.yaml`** (`image: ghcr.io/kirianm/vihko:1.0.0-rc.2`
  and the `user:` line). Without a `.env`, vihko runs as 1000:1000 as before.
  If your notes belong to another user, write `VIHKO_UID` and `VIHKO_GID` to
  `.env` next to `compose.yaml` and give the `state` folder to that user; see
  [The user and file ownership](guide/install.md#the-user-and-file-ownership).
- `state.db` is migrated at the first start (a copy stays as
  `state.db.bak-v8`); to go back to 1.0.0-rc.1, follow
  [Rolling back](guide/upgrading.md#rolling-back).
- If your notes folder is a network share, make sure it's mounted before vihko
  starts: it no longer starts on an empty mount point.
- `VIHKO_TRUSTED_PROXIES` must be your proxy's own address, not a range around
  it (for example `10.0.0.50`, not `10.0.0.50/8`).

### 1.0.0-rc.1 - 2026-09-28

The first release candidate of vihko 1.0: a self-hosted notes system over a
folder of plain Markdown files, for one person or a small group. Install it
with the [installation guide](guide/install.md); a release candidate is only
published under its exact image tag, `ghcr.io/kirianm/vihko:1.0.0-rc.1`.

#### Added

- **Your notes stay files.** A folder of `.md` files you can open and change
  with any other editor or sync tool at the same time; vihko picks the changes
  up and keeps your frontmatter as it is. Its search index is disposable and
  rebuilt from the files.
- **A web app for desktop and phone**, installable as an app: the editor with
  live preview, links between notes with renames that rewrite them, tags,
  search, backlinks, images, templates and daily notes, in English and Spanish,
  light and dark.
- **Several people**, each with their own account: per-folder permissions
  (read, comment, edit, manage) passed down to subfolders, personal folders
  that not even the admin reads, groups, sign-up and password reset by one-time
  links (no email server needed), two-step verification, and sign-in limits.
- **Live co-editing** between people and the AI agents they allow in, with
  comments anchored to the text.
- **History of every note**, kept in the state volume: browse versions, see who
  wrote what, restore, and purge.
- **Optional API and MCP server**, off until an admin turns them on: keys for
  scripts and agents that never see more than their person, folders closed to
  agents, and remote MCP with OAuth for clients such as claude.ai.
- **One container, two folders**: amd64 and arm64 images, no database server,
  no reverse proxy required, and no telemetry: the server only reaches outside
  when someone asks it to (saving an image from its address, a remote MCP
  client's metadata).

#### Upgrade notes

- First release: there is nothing to upgrade from. Installations made from
  development builds before this candidate (under the project's earlier
  working name) aren't migrated: start them again from empty state.

</details>
