# Roadmap

vihko is at 0.x: the relaunch of the project around spaces. Each 0.x minor
version is a usable release with a checkable definition of done; a minor
version may change the model or the contract, always with upgrade notes. 1.0
comes once real use says the model has settled. What came before the
relaunch is summarised at the end.

## 0.1.0 · Spaces

Goal: one installation for one group, where each person has a space of their
own and what belongs to several people lives in shared spaces, without
anything you can't see getting in your way or telling you it exists.

- [x] Two fixed folders in the notes folder: `people/<username>/` (each
      person's own space, «My notes», made with their account, also for a
      single-person install) and `spaces/<name>/` (shared spaces, whose
      folder is their name: unique in the installation, renamed with them).
      What appears outside them is seen by nobody, and the admins are told.
- [x] Permissions engine: sharing only adds. Everyone who reads a folder sees
      everything in it; a subfolder can add people, never take them away. No
      implicit rule, no `{user}` rules, no managers from above; being an admin
      grants nothing. Permissions are checked before the disk, so a name you
      can't see never answers differently from one that doesn't exist.
- [x] Shared spaces: anyone creates one (or only admins, a setting), its
      creator manages it; members, renaming, leaving (not through a group),
      deleting to the trash its managers keep seeing.
- [x] Folders shared from one's own space, in «Shared with me» with their
      owner; pinning them to the sidebar; who has access, shown read-only to
      every member.
- [x] Links stay within their space: a link (by name or by path) never
      leads to another space, and vihko never writes one; a link to what you
      can't read looks broken; a rename, move or new note that would retarget
      a link to a hidden note isn't available; moving to another space
      rewrites nothing across spaces, says in plain words which links will
      be broken, and copies the images a note shares.
- [x] Moving between spaces says who gains and loses access, and whose it
      becomes, before anything moves; agents confirm it explicitly.
- [x] The admin: a directory of shared spaces (names, managers, member
      counts, never content), assigning a manager, joining a space visibly,
      and deciding what becomes of a deleted person's closed space
      (transfer, make it shared, delete). Notices to the people concerned.
- [x] API and MCP: `GET /api/spaces` and `/api/spaces/members`;
      `list_folder("")` lists the spaces a person reaches; the server's
      instructions tell agents where the person keeps their notes. Keys'
      folders, pins and the trash follow folders moved from vihko.
- [x] `vihko.yaml`: permissions keyed by spaces, `attachments.folder`
      relative to each space.
- [x] Leak tests over every route, tool and editor message, extended to
      writes (create, rename, move over hidden names), and browser tests with
      three people.
- [x] Note settings of each person and each shared space
      (`.vihko/settings.yaml`): daily-note series, where images go and a
      guide for agents, adding to `vihko.yaml`'s; edited from vihko or by
      hand.
- [x] Templates are notes marked `template: true`, wherever they are, marked
      from a note's or a folder's menu; a new note gets the template's
      frontmatter without the mark.
- [x] Search by any frontmatter field (`type:decision`, `prop:key=value`,
      `prop:key`), in the search box, the API and MCP; `tag`, `path`, `is`,
      `has`, `in`, `prop`, `before` and `after` reserved for vihko's own
      filters.
- [x] Home, where vihko opens (recent notes, others' changes, what was
      shared lately), and «On opening» to choose otherwise; the tree and
      the sidebar follow others' changes live; the frontmatter out of reach
      of what is done in the note's body.
- [x] Also: the dark theme's bold and headings; Ctrl+E, Ctrl+Shift+S and
      Ctrl+K over a selection; an alert to the admins when `state.db`
      migrates at start; `vihko.yaml` rewrites raise its `version`; an
      upgrade smoke test before each release.
- [x] Retention, off by default: the admin can have the trash emptied after
      so many days and history versions older than so many days or months
      deleted, every week or at once; each note keeps its current version, and a note
      in the trash its whole history. Previewed in counts and confirmed.
- [x] A trash screen: what's in it, how much it takes, restore, and empty it
      with confirmation.

**Done when:** three people (an admin and two members) work at the same time
with their own spaces, a shared space and a folder shared between two of
them; the leak battery passes over every HTTP route, MCP tool and editor
message; and an installation built from the documentation alone works.

## 0.2 · Reading and editing

- [ ] A reading mode with a switch («Read / Edit»), on the same editor: no
      Markdown shows, links and tasks work with a tap, others' changes show
      live, and the reader isn't a cursor. Whoever can't edit is always in
      reading mode.
- [ ] «Open notes in»: automatic (reading on a phone, editing on a
      computer), editing or reading; remembered while browsing.
- [ ] «Show the Markdown»: on the line being edited, always, or as little as
      possible (experimental, on the same editor; no WYSIWYG editor).
- [ ] The UI's per-person settings: opening mode and Markdown in the
      account, next to the language and «On opening» (what their notes do
      is already their space's settings file, in 0.1.0).
- [ ] A link picker when adding a link (`[[`, the toolbar button, Ctrl+K)
      with «This space» (a normal link) and «Other spaces», which inserts a
      Markdown link to the note's vihko address by its uid, written
      relative, without the domain (`[text](/?n=<uid>)`): it survives
      renames, moves and a new domain, and shows no paths, and vihko writes the
      uid into the linked note the first time it's needed. The editor
      recognises its own addresses: the note's title and space when the
      reader can read it, a plain link otherwise.

## 0.3 · Videos

- [ ] Videos in notes without transcoding (MP4, MOV, WebM, told by their
      bytes), with a warning when the browser can't play the format. vihko
      writes `![](clip.mp4)` and also reads `![[clip.mp4]]`.
- [ ] `VIHKO_MAX_VIDEO_MB`, 500 MB by default; files served by ranges and
      streamed.
- [ ] External videos as a card that loads nothing from outside, with an
      optional «click to load» for domains the admin lists.
- [ ] Uploading videos through the API (`POST /api/attachments`).

## Later

- Public or wiki areas: a space or folder open to every person with an
  account, at a level (`public: read | comment | edit`).
- Events: an event log with a cursor; webhooks (HMAC with timestamp, real
  retries, SQLite outbox, stable event id, delivery log, auto-disable); a
  loop breaker. Per person, like API keys: each person creates their own
  webhooks and reads their own log (in Agents and API), and an event only
  tells what that person can read under the agents' rules (nothing marked
  `ai: false`, nothing in a folder closed to agents, only the folders the
  webhook is limited to). The admin only turns the feature on or off (off by
  default) and decides whether members may create their own; they never see
  or configure anyone's targets. Done when a real integration with another
  application works using only these generic pieces.
- Retrieval: configurable conventions for note types (decisions,
  projects…); embeddings in a worker thread with `sqlite-vec` and hybrid
  search, never of what the agent can't see; intent tools
  (`project_context`, `decisions`, `timeline`).
- Importing an existing vault into a space from the UI, rewriting its links
  from the root.
- Themes: light and dark as the first two of a theme system (palette and type
  per theme), so others can be added.
- Purge from the history everything no longer in the folder, listing what is
  lost before confirming.
- Syntax highlighting in code blocks, per language, each loaded only when a
  note needs it.
- E-reader: EPUB per collection and OPDS, with highlights flowing back.
- Graph view.
- OIDC, passkeys.
- Suggestion mode for agents.
- Quotes with a text selector in the UI.
- Asking for access (with the event log): to join a shared space you know
  of (its name isn't secret), or for a higher level in a folder someone
  already shares with you; never from a link that looks broken, which may
  lead to what you can't see.
- Offline in the browser: what's typed without a connection kept on the
  device (IndexedDB) and offered back when it returns.
- Renaming people who already use vihko: their space's folder, their grants
  and the links to their notes, as renaming a space does.
- Exporting a space (or one's own notes) as a zip, with its images and files.
- Selecting several notes in the tree, to move or delete them at once.
- A stable hidden id for each space, so that renaming it on the disk keeps
  its members, choices and links.

## Why this order

1. **The model first.** Spaces change where every note lives and who sees
   it; everything after it builds on that, so it comes before anything else
   and alone.
2. **Reading before videos.** How people read and edit touches every note
   every day; videos are a new kind of content on top.
3. **Integrations later.** Events and retrieval wait until the model and the
   contract have settled, so they don't have to be redone.

## Before the relaunch: the 1.0.x line

vihko was first built as one folder tree for everyone, with per-folder
permissions, and released as 1.0.x. That line was withdrawn: its single tree
couldn't keep what someone can't see from showing (a name taken by a hidden
note, a lock on a link) and gave nobody a space of their own. Its history is
in git; the milestones it went through:

- **M1 · Notes, one user**: Markdown files as the source of truth, a
  disposable SQLite index with a watcher and a periodic rescan, a
  collaborative editor (Yjs, CodeMirror 6) that keeps the file as the truth,
  links that follow renames, tags, search, images, templates and daily notes,
  `vihko.yaml`, Docker.
- **M2 · History**: every change kept in git in the state volume with its
  author, restore, «Recent changes», resolved comments, `history.exclude` and
  purging.
- **M3 · Agents**: an HTTP API with keys and an MCP server (with OAuth for
  remote clients), off by default, never seeing more than their person;
  login limits; reverting one change.
- **M4 · Multi-user**: users and groups, one-time links, per-folder
  permissions, read-only and comment-only editing, presence, a second factor,
  leak tests over every endpoint.
- **M5 · Release**: release policy, the name, documentation, two security
  reviews, the public repository, and 1.0.0 and 1.0.1.

All of that is still in vihko 0.1.0, reshaped for spaces.
