# Agents and integrations

An agent is anything that reaches your notes without the web UI: Claude Code,
Claude Desktop, claude.ai, another MCP client, or a script of yours. Every
agent acts for one person, and never sees or writes more than that person.

There are three ways in:

| Way in | For | Credential |
|---|---|---|
| MCP server at `/mcp` | AI assistants on your network (Claude Code, Claude Desktop, any MCP client) | A key |
| MCP server at `/mcp` with OAuth | Remote assistants that connect from their own servers (claude.ai) | An authorization the person approves in vihko |
| HTTP API at `/api/…` | Scripts and other programs | A key |

This guide covers the first two, and what keys are. The HTTP API has its own
guide: [HTTP API](api.md).

## Integrations are off until the admin turns them on

A new vihko accepts no key and has no MCP server. Nothing gets in or out except
through the web UI.

To turn them on, as the vihko admin:

1. Open **Preferences** (the button with your name in the sidebar) and choose
   **Agents and API**.
2. Under **Integrations**, turn on what you need:
   - **HTTP API with keys**: requests with a key reach the API.
   - **MCP server**: `/mcp` exists.
   - **Members can create keys**, if members are to have keys of their own.
     Until you turn it on, only admins can create keys.

The switches apply at once; there is nothing to restart. While a switch is off,
its door doesn't exist: every request with a key to `/api/…` gets `404`, and so
does `/mcp`, as if there were nothing there. The web UI works the same either
way.

The last two switches, and one more:

- **Members can create keys** (off by default). While it's off, members can't
  create keys or approve apps with OAuth; those they have keep working and
  they can revoke them, but can't change or rotate them. An admin always can.
- **OAuth apps can register themselves** (off by default), right under **MCP
  server**. It only shows when vihko has a public address
  (`VIHKO_PUBLIC_URL`). Connecting claude.ai or `mcp-remote`, which register
  themselves, needs it on; apps that identify themselves with a URL don't. See
  [Remote MCP with OAuth](#remote-mcp-with-oauth).

Whoever runs the server can lock the API and the MCP server off with the
environment variable `VIHKO_INTEGRATIONS=off`. Then they stay off whatever the
page says, and the page shows them locked. Removing the variable and restarting
vihko lifts the lock.

If the API or the MCP server is on while `vihko.yaml` keeps the history
unmanaged or off, vihko shows an alert: what an agent writes then has no
version of its own to undo it by. Keep the managed history on when agents write.
See [History](history.md).

## Keys

A key is a credential you give to one agent: `vihko_`, a 26-character id, `_`
and a 43-character secret.

```text
vihko_01JB2Q7ZK4M8N6P3R5T7V9X1YC_…
```

The key acts for you. It sees at most what you see now: when your permissions
change, the key follows them. On top of that, each key has its own limits.

| Setting | Default | What it does |
|---|---|---|
| Name | (required) | Who the key is for: "Claude Code", "Backup script". The history and the editor show it |
| Permissions | Read only | **Read only**, or **Reads and writes**: create, edit, move and trash notes, and add images to them |
| Folders | Every folder you see | Or only the folders you choose, with everything inside them |
| Expiry | Never expires | 7 days, 30 days, 90 days or 1 year |

Whatever the settings, a key never sees:

- a note with `ai: false` in its frontmatter (also `no`, `off`, `"false"` or
  `0`), or a note whose frontmatter can't be read;
- anything in a folder closed to agents (`ai: false` on the folder, set in its
  permissions: see [Users and permissions](users-and-permissions.md));
- an image or other file that such a note uses;
- anything outside the key's folders, or that its person can't read.

A key that may write only writes where its person has `edit`.

### Create a key

1. In **Agents and API**, under **Your keys**, choose **New key**.
2. Give it a name, and choose its permissions, folders and expiry.
3. Confirm it's you: the current code of your second factor or, if you have
   none, your password. vihko asks even though you're signed in, because a key
   gives access to your notes.
4. Copy the key. It's shown only this once; vihko keeps only a hash of it.

The same dialog shows ready-made configurations for Claude Code, Claude
Desktop, a generic MCP client and the HTTP API, with the key already in them.

Create one key per agent or app, so you can see what each one did and revoke
them one by one.

### Change, rotate and revoke

Each key in the list shows its permissions, folders, expiry, when it was last
used and how (via the API, via MCP, or via MCP with OAuth). **What it sees**
lists what the key reaches right now.

- **Edit** changes the name, permissions, folders or expiry. A change that
  lets the key do more (from read only to reads and writes, another folder or
  every folder, a later expiry or none) asks you to confirm it's you, as
  creating a key does. Renaming it, or letting it do less, doesn't.
- **Rotate** gives the key a new secret, shown once, and confirmed like a new
  key. It keeps its name, permissions, folders and history. The old secret keeps
  working for 10 minutes, so you can update the agent's configuration; then it
  stops.
- **Revoke** stops the key at once, wherever it is used. It can't be undone:
  the agent needs a new key. Revoked keys stay listed, because the history
  still names them.

An expired key stops working for good: it can't be edited (not even to give it
a later expiry) or rotated; create a new one. A key whose person is disabled
stops working too.

Only the owner of a key edits or rotates it. The vihko admin sees everyone's
keys under **Everyone else's keys** and can revoke any of them, but never sees
a key's secret.

## What an agent can't see

Notes hidden from an agent don't exist for it: they don't show up in searches,
listings, backlinks, tags, counts or recent changes.

An agent only learns that such a note exists if it already has its name:

- A link to it, in a note the agent can read, has the status `no_access`.
- Naming it (reading it by its path, writing to its path, asking for its
  history) answers `agent_denied` with a reason: `ai_false`,
  `outside_key_folders` or `user_no_access`.

This is on purpose. An agent that took a hidden note for a broken link might
delete the link, point it elsewhere or write a new note in its place. The
denial tells it to leave the note alone, and says nothing of what's in it.

One known limit: searches and listings use the index. A note marked `ai: false`
from outside vihko (another editor, a sync tool) drops out of them once vihko
picks up the change: seconds with the file watcher, up to a rescan on a network
filesystem. Reading the note directly checks its text at once.

## Connect over MCP with a key

vihko's MCP server is at `/mcp` on the same address and port as the UI, for
example `http://vihko.example.lan:8080/mcp`. It speaks MCP's **Streamable
HTTP** transport, without sessions: clients send `POST` requests with the key
in an `Authorization: Bearer` header. There is no stdio transport and no
separate SSE endpoint (`GET` and `DELETE` on `/mcp` answer `405`).

Replace the address and the key in the examples below with yours. The **New
key** dialog shows them filled in.

### Claude Code

```sh
claude mcp add --transport http vihko http://vihko.example.lan:8080/mcp \
  --header "Authorization: Bearer vihko_…"
```

Add `--scope user` to have it in all your projects. In Claude Code, `/mcp`
lists the server and its tools.

### Claude Desktop

Claude Desktop connects through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote),
which needs Node.js. Keep the key in a file only you can read, so it doesn't
show in the computer's process list:

1. Save this line in a file, for example `~/.config/vihko-mcp.txt`, and make it
   readable only by you (`chmod 600`):

   ```text
   Authorization: Bearer vihko_…
   ```

2. Add the server to `claude_desktop_config.json`, with the file's full path:

   ```json
   {
     "mcpServers": {
       "vihko": {
         "command": "npx",
         "args": ["-y", "mcp-remote", "http://vihko.example.lan:8080/mcp",
                  "--header-file", "/home/you/.config/vihko-mcp.txt", "--allow-http"]
       }
     }
   }
   ```

   `--allow-http` is only needed when vihko is served over plain `http`. Leave
   it out for an `https` address.

3. Restart Claude Desktop.

### Other MCP clients

A client that takes MCP servers over HTTP with headers (the `mcpServers`
format):

```json
{
  "mcpServers": {
    "vihko": {
      "type": "http",
      "url": "http://vihko.example.lan:8080/mcp",
      "headers": { "Authorization": "Bearer vihko_…" }
    }
  }
}
```

To try the server by hand, the [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
connects with transport **Streamable HTTP**, the URL, and the header
`Authorization: Bearer vihko_…`.

A request from a browser page on another site (with an `Origin` header that
isn't vihko's) is refused with `403`: a web page can't use your key through
your browser.

## The tools

The server offers these tools. A read-only key gets only the reading ones (and
`daily_note` only looks); calling a writing tool with it fails as an unknown
tool.

**Reading**

| Tool | What it does |
|---|---|
| `search` | Full-text search over the notes the key can read, best first, with `path:` and `tag:` filters and `-` to exclude one |
| `get_note` | A note by its path or `uid`: its text, ETag, frontmatter, title, and its outgoing and incoming links. Long notes come in pieces |
| `list_folder` | The folders and notes in a folder (`""` is the root), optionally everything under it |
| `related` | How a note connects to others: its links with the titles they lead to, and the notes that link to it with the text around each link |
| `resolve_link` | Where a link written in a note leads: resolved, ambiguous (with candidates), missing or `no_access` |
| `daily_note` | Today's note of the person the key acts for, in their time zone. With a key that writes, it creates the note from its template if it doesn't exist yet (`create: false` only looks) |

**Writing** (keys that may write)

| Tool | What it does |
|---|---|
| `create_note` | A new note from text or from a template note. Never overwrites |
| `edit_note` | Operations applied in order, all or none: `find_replace`, `append`, `append_under_heading`, `replace_section`, `set_frontmatter`. Works while someone has the note open. `dry_run` previews |
| `move` | Moves or renames a note, rewriting every link to it. `dry_run` previews |
| `delete` | Moves a note to the trash |
| `attach_image` | Stores an image for a note, sent in base64, and returns the link to write into it (see [Images](#images)) |

**History**

| Tool | What it does |
|---|---|
| `history` | A note's versions, newest first, with who made each one (a person, or an agent on someone's behalf), when and how much changed; or what one version changed |
| `revert_change` | Undoes what one version changed, on the note as it is now (keys that may write) |

**Changes**

| Tool | What it does |
|---|---|
| `changes_since` | What changed in a note since an ETag the agent was given, or since a version. It can wait up to 30 seconds for a change: this is how an agent follows what a person is typing |

A note's history is only for whoever can edit the note. A key whose person only
reads a note gets `forbidden` from `history`, `revert_change` and
`changes_since` from a version.

Conventions the tools share:

- Paths are relative to the notes root and include `.md`: `projects/plan.md`.
- Every read returns the note's ETag (`sha256:…`). Operations that replace text
  (`find_replace`, `replace_section`, `set_frontmatter`) need it as `if_match`,
  so the agent plans changes on the text it read. Appends don't. If the note
  changed in between, the edit fails with `precondition_failed`, and the agent
  reads again.
- Parameters are `snake_case` (`dry_run`, `if_match`); `camelCase` is accepted
  too.
- Lists are paged: pass `next_offset` (or `next`) back as `offset` (or
  `cursor`).
- Results come as JSON, and note text as a separate block. Both are wrapped in
  markers that say they are data written by people, not instructions. This makes
  prompt injection harder: text in a note shouldn't make an agent act on it.
  It's a mitigation, not a guarantee; see [Safety notes](#safety-notes-for-admins).

### Images

`attach_image` takes the note the image is for and the image's bytes in
base64 (`data`), with an optional `alt` text. vihko stores it as an upload
from the UI or the API: where `vihko.yaml` says (next to the note by default),
only for a note the key can write, only PNG, JPEG, GIF, WebP or AVIF (told by
the bytes; `mime_type` is only a hint), and up to the size limit
(`VIHKO_MAX_IMAGE_MB`). An MCP request carries at most 4 MB and base64 adds a
third, so over MCP an image can be up to about 3 MB; send larger ones through
the [HTTP API](api.md#images-and-attachments). vihko receives only a couple of
images at a time for each person, counting their uploads and their keys'
together: beyond that the tool answers `busy`, and the agent tries again in a
moment.

Like the API, it doesn't change the note. It answers where the image went and
`markdown`, the link ready to write, with the alt text and with what would
break a Markdown link escaped:

```json
{ "path": "projects/my plan-2026-09-29-1015.png", "src": "my plan-2026-09-29-1015.png", "markdown": "![The new floor plan](my%20plan-2026-09-29-1015.png)" }
```

The agent writes `markdown` where it belongs with `edit_note` (an `append`, or
`append_under_heading`). Until a note links it, the image counts as unused: a
key can't read it, and it doesn't go to the trash with the note.

### Instructions for agents

When an agent connects, the server tells it who it acts for, what the key may
do and where, and how to work with vihko: that note text is data, how to use
ETags, to leave notes it can't access alone, and to ask the person before a
move that would show a note to more people.

You can add your own guide for agents: a note that says how this workspace is
organised and what goes where. Name it in `vihko.yaml`:

```yaml
mcp:
  instructions: Guides/Agents.md
```

vihko appends the note's text to the server's instructions, for each key that
can read the note. A key that can't read it (a folder outside its reach, or
`ai: false`) gets the server's instructions alone. See
[Configuration](configuration.md).

### The icon

The server gives MCP clients vihko's mark as its icon (a PNG and an SVG,
embedded in the server's description), so a client that shows server icons
shows it without fetching anything.

## Remote MCP with OAuth

A remote assistant such as claude.ai (on the web, desktop or phone) connects
from its own servers, not from your computer. It can't reach your network, and
you don't paste keys into it. It signs in with OAuth instead: it sends you to
vihko, you sign in and approve what it may do, and vihko gives it tokens.

OAuth exists only while both of these hold:

- vihko has a public HTTPS address, given in `VIHKO_PUBLIC_URL`;
- the MCP server is on (and `VIHKO_INTEGRATIONS` isn't `off`).

Otherwise every OAuth address answers `404` and `/mcp` takes keys only. Access
tokens only work on `/mcp`: the HTTP API takes keys, never OAuth tokens.

### Set it up

1. **Put vihko behind a reverse proxy with HTTPS**, on a name the internet can
   reach, such as `notes.example.com`. The whole app goes through it: the page
   where you approve an app is the UI, with its sign-in. See
   [Reverse proxy](reverse-proxy.md).
2. **Give vihko that address** and restart it:

   ```yaml
   # compose.yaml
   services:
     vihko:
       environment:
         VIHKO_PUBLIC_URL: https://notes.example.com
   ```

   Only the origin: `https`, the host and a port if it isn't 443, nothing
   after it. Otherwise vihko refuses to start.
3. **Turn on the MCP server** in Agents and API. The page then shows
   **Connect without a key (OAuth)** with the address to give remote assistants:
   `https://notes.example.com/mcp`.
4. **Turn on OAuth apps can register themselves**, right under it, to connect
   claude.ai or `mcp-remote`: they register themselves before asking for
   access (see [How apps introduce themselves](#how-apps-introduce-themselves)).
   Apps that identify themselves with a URL don't need it.
5. For members to connect apps, also turn on **Members can create keys**: an
   authorization is a key.

### Connect claude.ai

1. In claude.ai, open **Settings → Connectors** and choose **Add custom
   connector**.
2. Give it a name, and the URL `https://notes.example.com/mcp`.
3. Connect. claude.ai registers itself with vihko and sends you to vihko's
   authorization page.
4. Sign in to vihko, if you aren't already.
5. Check the page: which app asks, its domain when it has one, and the address
   it goes back to.
6. Choose what it may do: tick **Can write** or leave it read-only, and give it
   every folder you see or only some. The default is read-only and every
   folder.
7. Confirm it's you (your second factor's code, or your password), and choose
   **Authorize**.

claude.ai now has vihko's tools. Other clients that speak MCP with OAuth work
the same way; for example, `mcp-remote` without a `--header` option runs this
flow in your browser.

### What the person approves

The authorization is one more key of the person who approved it, named after
the app and marked **OAuth** in Agents and API:

- It acts for that person, with what they chose and within what they see, like
  any key. It never sees `ai: false` notes or folders.
- There is no key to copy or rotate. Change what it may do with **Edit** (as
  with any key, letting it do more asks you to confirm it's you), or
  **Revoke** it: that stops its tokens at once, and the app has to ask again.
- Approving the same app again changes what that authorization may do (to what
  you choose then); it stays one entry, so the history keeps one author.
- The history and the editor show it "via MCP (OAuth)".
- Members can approve apps only while **Members can create keys** is on (it's
  off by default), since an authorization is a key. Otherwise they can only
  deny.

Access tokens last an hour. Refresh tokens change on every use and expire after
30 days unused. A refresh token used twice (a sign it was stolen) revokes every
token that came from it.

### How apps introduce themselves

An app has to be known to vihko before it can ask for access. There are two
ways, and neither gives access to any note: only a person approving it does.

**Registration.** The app registers itself (OAuth dynamic client registration,
at `/oauth/register`) with its name and the addresses it goes back to. This is
what claude.ai does. Anyone can register, so the approval page marks the name
as not checked and shows the address the app goes back to. Registration is
limited to 5 apps an hour from each address (then `429` with `Retry-After`;
behind a proxy, set `VIHKO_TRUSTED_PROXIES` so each client counts apart). An
app registered but never approved is forgotten after a day. It's off until the
vihko admin turns on **OAuth apps can register themselves** in Agents and API;
while it's off, `/oauth/register` answers `404` and vihko's metadata doesn't
offer it. Once your apps are connected, the admin can turn it off again: apps
already registered keep working.

**A metadata document.** The app names itself by an `https` address that
describes it (a Client ID Metadata Document, which the MCP authorization
specification prefers). This works with **OAuth apps can register themselves**
off. vihko then fetches that address. It's the only request
vihko ever makes to an address someone else chose, and it's fenced in:

- only when someone signed in to vihko starts authorizing that app, never
  before;
- only `https` on port 443, to a host name, never an IP address;
- never to an address that isn't public (private networks, loopback,
  link-local and the like), checked after resolving the name, and the
  connection goes to the address that was checked;
- no redirects followed, at most 5 KB and 5 seconds;
- kept in memory for a few minutes, never on disk.

The approval page then shows the app's domain: that is who publishes it. This
way in isn't affected by the registration switch.

**Where an app may go back to.** An `https` address, `http` only to the same
computer (`127.0.0.1`, `[::1]` or `localhost`, on any port), or an app's own
scheme. Nothing that runs in the browser (`javascript:`, `data:` and the like).
It must match what the app registered exactly. When the app asks to go back to
the same computer, the approval page warns you: authorize it only if you just
connected it yourself.

vihko never sends your browser to an app on its own. A request that isn't valid
(an unknown app, an address it didn't register) is shown as an error on vihko's
page. The browser only goes back to the app when you authorize or deny.

## What agents' writes look like

Agents write directly to notes, within their key. There is no suggestion mode:
nothing waits for approval. The safeguards are what the key reaches, the
history, and a few rules:

- `create_note` never overwrites an existing note.
- Replacing text needs the ETag of the text the agent read.
- `delete` moves the note to the trash, where a person can restore it, with
  the images next to it that no other note uses (only those in the key's
  folders and out of folders closed to agents).
- A move that would show the note to anyone who can't see it now fails with
  `audience_widens` and who would gain access. The server tells the agent to
  ask you first, and to confirm only after you agree.
- An agent can hide a note from agents by writing `ai: false` in its
  frontmatter. The write goes through, the note is from then on hidden from
  every agent, and only a person can undo it, from the UI.

Everything an agent writes is marked as its own:

- **In the editor**, while you have the note open, an agent's changes arrive
  live. The note's header shows the agent with a diamond: "Claude Code · on
  behalf of Noa". What it just wrote is highlighted for a few seconds.
- **In the history**, each version names its author. An agent's versions show
  the diamond, its key's name and who it acted for: "Claude Code · on behalf of
  Noa", and how it came in (API, MCP or OAuth). **Recent changes** can be
  filtered by that author.
- **Comments.** An agent with a key that writes can add a comment to a note by
  writing it in the note's comment format; it shows up like anyone else's. A
  read-only key can't comment. See [Notes](notes.md).

To undo what an agent did, open the note's history, pick its version, and
choose **Revert this change** (undoes only that version's change, keeping what
was written after it) or **Restore this version** (brings the whole text back).
Both are new versions, which can be undone in turn. A deleted note is in the
trash. See [History](history.md).

## Safety notes for admins

- **Close what agents shouldn't read.** Mark folders with private or sensitive
  content as closed to agents: diaries, health, finances, anything with
  passwords or personal data of other people. A folder's permissions dialog has
  **Closed to agents**; it applies to everything inside, including notes
  created later, and nothing inside can reopen it. For a single note, add
  `ai: false` to its frontmatter.
- **Give each key the least it needs.** A new key is read-only and reaches
  every folder its person sees. Limit it to the folders the agent works in, and
  only let it write when it has to. Use one key per agent.
- **Set an expiry** for keys that are for a task or a trial.
- **Rotate keys** that may have leaked (pasted in a chat, committed to a
  repository, left in a shared machine), and revoke keys you no longer use. The
  list shows when each key was last used.
- **What an agent reads leaves vihko.** A cloud assistant sends it to its
  provider, and vihko has no say in what happens next. The Privacy page in
  Preferences explains this to every user.
- **Agents read text other people wrote.** A note written by someone else, or
  pasted from the web, can try to instruct an agent. vihko marks note text as
  data, but can't make an agent immune. Be careful with keys that may write,
  above all in folders where other people or sync tools write.
- **Turn off app registration** once your OAuth apps are connected, and lock
  everything off with `VIHKO_INTEGRATIONS=off` on installations that should
  never have integrations.
- **Keep the managed history on** while agents write, so every change they make
  can be reverted.
- **Use strong passwords and a second factor** when vihko has a public address:
  anyone on the internet can reach its sign-in page. See
  [Users and permissions](users-and-permissions.md).

## Not there yet

- **Webhooks** (vihko calling your services when notes change) are planned,
  not built.
- Apps can't be registered by hand while registration is off: turn it on for
  as long as it takes to connect a new app.
- The frontmatter key that hides a note from agents is always `ai`; it can't be
  renamed in `vihko.yaml`.
