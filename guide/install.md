# Installation

This guide takes you from nothing to a running vihko with its first admin. It
assumes you know Docker and Compose; it doesn't assume you know vihko.

## Requirements

- **Linux with Docker Engine and Compose v2** (`docker compose`, not the old
  `docker-compose`). The image is published for `linux/amd64` and
  `linux/arm64`.
- **Two folders on the host**:
  - one for your notes, on any disk: local, or a network share such as NFS;
  - one for vihko's state, **on local disk**, never on a network filesystem
    ([why](#the-state-volume)).
- **A free TCP port**, 8080 by default.
- **A modern browser.** vihko has no desktop or mobile app; on a phone, use
  the browser. Installing it as an app (a PWA) needs HTTPS: see
  [Reverse proxy](reverse-proxy.md).

Nothing else: no database server, no Redis, no reverse proxy, no external
identity provider.

## Install

1. Make a folder for vihko and download the compose file into it:

   ```sh
   mkdir vihko && cd vihko
   curl -fsSLO https://raw.githubusercontent.com/KirianM/vihko/main/compose.yaml
   ```

   The `compose.yaml` on `main` always pulls the current release: its
   `image:` line names it (see [The image and its tags](#the-image-and-its-tags)).

2. Read [the compose file](#the-compose-file) below and adjust it: which
   image tag, which port, and where your notes are. To use a notes folder you
   already have, change `./notes` to its path.

3. Create the two folders yourself, before the first start, and write the
   owner of the notes folder into `.env`, next to `compose.yaml`:

   ```sh
   mkdir notes state
   printf 'VIHKO_UID=%s\nVIHKO_GID=%s\n' "$(stat -c %u notes)" "$(stat -c %g notes)" > .env
   ```

   vihko runs as that user, and `state/` must belong to it too. If a folder
   in a bind mount doesn't exist, Docker creates it owned by `root`, and vihko
   (which doesn't run as root) can't write to it. **As root, or with notes you
   already have**, follow [The user and file ownership](#the-user-and-file-ownership)
   instead.

4. Start it:

   ```sh
   docker compose up -d
   ```

Then go on with [First start](#first-start).

## The compose file

This is the whole `compose.yaml`:

```yaml
# Minimal example. Adjust the volume paths to your system.
services:
  vihko:
    # :1 gets every 1.x release (fixes and features) and never an
    # incompatible version: that is a new major, which you choose by changing
    # the tag.
    image: ghcr.io/kirianm/vihko:1
    restart: unless-stopped
    # Hardening: nothing is written outside the two volumes, no Linux
    # capabilities, and no way to gain privileges. vihko needs none of them.
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    ports:
      # Host port: 8080 unless you say otherwise. If it is taken,
      # VIHKO_HOST_PORT=8098 docker compose up -d (or put it in a .env file).
      # Don't expose it to the Internet without HTTPS in front (a reverse proxy).
      - "${VIHKO_HOST_PORT:-8080}:8080"
      # Only with a reverse proxy on THIS machine: this line instead of the one
      # above, so that only the proxy reaches vihko. A proxy on another machine
      # needs the line above. See guide/reverse-proxy.md.
      # - "127.0.0.1:${VIHKO_HOST_PORT:-8080}:8080"
    volumes:
      # Notes: any Markdown folder (local disk or NFS).
      - ./notes:/data/notes
      # State: ALWAYS on local disk (SQLite is not reliable over NFS).
      - ./state:/data/state
    # The user vihko runs as: the owner of the notes folder (on NFS, the one the
    # server imposes), set in .env; state/ must belong to the same user.
    # See guide/install.md, "The user and file ownership".
    user: "${VIHKO_UID:-1000}:${VIHKO_GID:-1000}"
    # environment:
    #   # Only behind a reverse proxy with HTTPS: the public address, for remote
    #   # MCP clients such as claude.ai (OAuth). See guide/reverse-proxy.md.
    #   VIHKO_PUBLIC_URL: https://notes.example.com
    #   # The reverse proxy's address as vihko sees it, so the login limits
    #   # count each client apart (X-Forwarded-For is believed only from it).
    #   # A proxy on this machine or in this file: 172.16.0.0/12. On another
    #   # machine: its address alone (such as 10.0.0.50), never a range.
    #   VIHKO_TRUSTED_PROXIES: 172.16.0.0/12
```

### The image and its tags

`ghcr.io/kirianm/vihko` is the only place vihko's image is published. The tags:

| Tag | What you get |
|---|---|
| `1` | The latest 1.x release. Recommended: fixes and new features, never an incompatible change (save the exceptions in [Upgrading](upgrading.md#what-a-version-number-promises)). |
| `1.2` | The latest 1.2.x release: fixes only. |
| `1.2.3` | Exactly that release. It never changes. |
| `latest` | The latest release, **whatever its major version**. It can jump from 1.x to 2.0 on a `docker compose pull`. Avoid it. |
| `1.1.0-rc.1` | A release candidate, only under its exact tag. |

[Upgrading](upgrading.md) explains what a major version means and how to move
between versions.

### `restart: unless-stopped`

Docker starts vihko again after a crash or a reboot, unless you stopped it
yourself. If vihko can't start (a wrong variable, a folder it can't write),
Docker keeps restarting it: read the log (`docker compose logs vihko`) to see
why.

### `read_only`, `cap_drop` and `security_opt`

Hardening that costs nothing: the container's own files are read-only (vihko
only writes to its two volumes), it holds no Linux capabilities, and nothing
inside it can gain privileges. If something in the container broke because of
them, vihko would fail at start and say what it couldn't write; you can remove
the three lines, but you shouldn't need to.

### The port

vihko listens on port 8080 inside the container. The line
`"${VIHKO_HOST_PORT:-8080}:8080"` publishes it on port 8080 of every network
interface of the host. To use another host port, set `VIHKO_HOST_PORT`, on the
command line or in a `.env` file next to `compose.yaml`:

```sh
echo 'VIHKO_HOST_PORT=8098' >> .env
docker compose up -d
```

vihko speaks plain HTTP. That's fine on a network you trust. **Never publish
the port to the Internet without HTTPS in front**: put a reverse proxy before
it. The commented `127.0.0.1` line is only for a proxy **on the same
machine**: with it, nothing else can connect, a proxy on another machine
included. For a proxy elsewhere on your network, keep the default line. See
[Who reaches vihko's port](reverse-proxy.md#who-reaches-vihkos-port).

### The notes volume

`./notes:/data/notes` is your notes: a folder of Markdown files, the source of
truth. It can be an empty folder or one you already have, even one shared with
other editors or sync tools. vihko imposes no structure on it.

It can live on local disk or on a network filesystem (NFS, SMB). On a network
filesystem, vihko sees changes made from other machines through a periodic
rescan, every 60 seconds by default; see
[Notes on NFS](operations.md#notes-on-nfs).

Prefer a case-sensitive filesystem for it. A folder that ignores case (one
shared from macOS or Windows into the container, an SMB share) works: vihko
tells so once, from the names at the folder's root, and then answers only to each
name as the disk spells it (see [Notes and Markdown](notes.md)), which costs a
folder listing now and then. A case-sensitive root whose subfolders ignore
case (ext4's `chattr +F` on a subfolder) isn't supported: vihko doesn't see it,
and there another spelling of a folder would reach it past its permissions.

Back it up. See [Backups](backups.md).

### The state volume

`./state:/data/state` is vihko's own data:

| Path | What it is | Back it up? |
|---|---|---|
| `state.db` | Users, groups, sessions, invitations, API keys and OAuth clients, settings, second factors | Yes |
| `history.git/`, `history/` | The history of your notes (a git repository), when the history is managed by vihko | Yes |
| `trash/` | Deleted notes and folders, which people can restore from the UI | Yes |
| `collab/` | Saved editor states of the notes opened in the editor (`.ystate`), and recovery logs of notes being edited (`.ylog`), so a crash loses no typing | Yes |
| `config-backups/` | Copies of `vihko.yaml` made before vihko rewrote it after an upgrade | Yes |
| `state.db.bak-v<N>` | A copy of `state.db` made before an upgrade migrated it. See [Rolling back](upgrading.md#rolling-back) | Optional |
| `index.db` | The search index. Derived from the notes, rebuilt when needed | No |
| `state.db-wal`, `state.db-shm`, `index.db-wal`, `index.db-shm` | SQLite's companion files of the two databases, while vihko runs | With its database |
| `vihko.lock`, `vihko.lock-journal` | Keep a second vihko process off the same state: an empty SQLite database that vihko holds locked while it runs (`-journal` is only there meanwhile) | No |

**Keep it on local disk.** `state.db` and `index.db` are SQLite databases, and
SQLite's locking is not reliable over NFS or SMB: two processes could both
think they hold a lock, and the database can be corrupted. The history is a git
repository, and git over a network filesystem is also many times slower. A bind
mount of a host folder that is itself an NFS mount *is* NFS, as far as SQLite is
concerned.

A Docker named volume works too (`- vihko-state:/data/state`, with a
`volumes:` section); a folder next to `compose.yaml` is simply easier to back
up.

**It's private.** Everything in it, the history of personal folders included,
is readable by whoever can open the folder on the host: vihko's permissions
only apply to people who go through vihko. vihko closes the folder to other
users of the host when it starts (mode `700`, owner only). If it can't,
because the folder belongs to another user, the log says so. The notes folder
is yours to protect the same way, if others have accounts on the host.

### The user and file ownership

vihko doesn't run as root. It runs as the user in `user:`,
`"${VIHKO_UID:-1000}:${VIHKO_GID:-1000}"`: the numeric ids in the `.env` file
next to `compose.yaml`, or `1000:1000` (called `node` in the image) without
them. That user must be able to write both folders, and every note vihko
writes gets that owner. So:

- **`VIHKO_UID` and `VIHKO_GID` are the owner of your notes folder**, and
- **the state folder belongs to that same user.**

Pick the case that is yours. Run the commands in the folder of
`compose.yaml`.

**A new install, as your own user.** The folders you create are yours, and
vihko runs as you:

```sh
mkdir notes state
printf 'VIHKO_UID=%s\nVIHKO_GID=%s\n' "$(stat -c %u notes)" "$(stat -c %g notes)" > .env
```

**A new install, as root** (a container or a virtual machine with no other
user, say). Folders made by root would have vihko run as root, which it doesn't
need. Give them to an ordinary user first: the one who will also edit the
files, if there is one, or `1000:1000`:

```sh
mkdir notes state
chown 1000:1000 notes state
printf 'VIHKO_UID=%s\nVIHKO_GID=%s\n' "$(stat -c %u notes)" "$(stat -c %g notes)" > .env
```

**Notes you already have**, on this disk or on NFS. Point the notes volume at
the folder in `compose.yaml` (`- /srv/notes:/data/notes`), write its owner
into `.env`, and give the state folder the same owner. Leave the notes' owner
as it is: on NFS, it's the one the server imposes (and the NFS client's root
usually can't change it anyway).

```sh
mkdir state
printf 'VIHKO_UID=%s\nVIHKO_GID=%s\n' "$(stat -c %u /srv/notes)" "$(stat -c %g /srv/notes)" > .env
sudo chown "$(stat -c %u:%g /srv/notes)" state
```

`sudo` is needed there only when the notes aren't yours; as root, leave it
out. If `stat` says the notes belong to root (`0`), don't run vihko as root:
give the folder to an ordinary user first (on NFS, on the server). If vihko
runs as root anyway, its log says so when it starts.

On NFS, the export may map every write to one user (`all_squash`, `mapall`
and similar). Then files get whatever owner the export imposes, and
`VIHKO_UID` must be a user the export lets write: the owner `stat` shows is
usually that one. See [Notes on NFS](operations.md#notes-on-nfs).

**If a folder isn't writable by vihko's user**, vihko doesn't start: it
restarts in a loop, and its log says which folder, whose it is, who vihko runs
as, and the fix, in one line:

```text
[vihko] vihko can't write to the state folder /data/state: it belongs to 0:0 (mode 755) and vihko runs as 1000:1000. Fix: chown -R 1000:1000 the state volume's folder on the host (./state next to the example compose.yaml); see guide/install.md, "The user and file ownership"
```

(`/data/state` is the folder inside the container; on the host, it's the
folder of the state volume.) Stop vihko, fix the owner or `.env`, start it:

```sh
docker compose down
sudo chown -R 1000:1000 state
docker compose up -d
```

**To run vihko as another user later**, change `.env`, and give the state
folder, with everything in it, to the new user:
`sudo chown -R <uid>:<gid> state`. The notes too, if they aren't that user's
already.

### `environment:`

Uncomment `environment:` to set [environment variables](#environment-variables).
None is required. The two in the file only matter behind a reverse proxy.

## First start

Read the log:

```sh
docker compose logs vihko
```

```text
[vihko] vihko 1.0.1
[vihko] no vihko.yaml: nothing configured
[vihko] index ready: 0 added, 0 changed, 0 removed, 0 unchanged
[vihko] listening on http://0.0.0.0:8080
[vihko] first boot: no users yet. Create the admin with this one-time token
[vihko]   (in the UI, or with POST /api/setup): svzc3Vc0ydY_JXYOCzDmQwa_d9i9TxOPwxybVPsep90
[vihko]   or from the command line: vihko user create <name> --admin
```

(`listening on http://0.0.0.0:8080` is the address inside the container; you
reach it on the host port you published.)

### Create the admin in the browser

1. Open `http://<your-server>:8080`.
2. vihko shows «Create the administrator». Paste the token from the log.
3. Choose a username (2 to 64 letters, digits, `.`, `_` or `-`) and a password
   of at least 10 characters. You're signed in.

The token works once. While there are no users, vihko prints a new one every
time it starts; once the admin exists, it prints none. A script can do the
same without the browser, with the `POST /api/setup` the log mentions: see
[Create the first admin](api.md#create-the-first-admin).

### Or from the command line

Instead of the token, you can create the admin inside the container. The
password is read from standard input:

```sh
read -rs -p 'Password: ' pw && echo && printf '%s\n' "$pw" | docker compose exec -T vihko vihko user create alex --admin; unset pw
```

```text
user created: alex (admin)
```

`read -rs` keeps the password off the screen and out of your shell history.
Without `--admin`, the user is a member. [Operations](operations.md#the-command-line)
lists every command.

### Next steps

- Find your way around the app: [First steps in the app](first-steps.md).
- Invite people: [Spaces, people and sharing](users-and-permissions.md).
- Configure the workspace (daily notes, templates, where images go):
  [Configuration](configuration.md).
- Set up [backups](backups.md) now, before you have notes to lose.

## Environment variables

All optional. Set them under `environment:` in `compose.yaml`:

```yaml
    environment:
      VIHKO_RESCAN_SECONDS: "120"
      VIHKO_EXTERNAL_IMAGES: block
```

vihko checks them when it starts: a value it can't use stops it, with a
message in the log that names the variable. (`VIHKO_HOST` isn't checked yet:
give it a sensible value.)

| Variable | Default | What it does |
|---|---|---|
| `VIHKO_PUBLIC_URL` | unset | The `https://` address vihko is reached at from outside, behind a reverse proxy: the origin only, such as `https://notes.example.com`. It makes OAuth available for remote MCP clients (while the MCP server is on), and invitation and password-reset links use it. See [Reverse proxy](reverse-proxy.md) and [Agents](agents.md). |
| `VIHKO_TRUSTED_PROXIES` | unset | Addresses or CIDR ranges of your reverse proxies, separated by commas or spaces (`172.16.0.0/12, 10.0.0.50`). Only from them does vihko believe `X-Forwarded-For`, to tell clients apart for the sign-in limits. Unset, every request counts as coming from the connection's address. A proxy on another machine is its one address: a range such as `10.0.0.50/8` trusts the whole `10.0.0.0/8`. See [Reverse proxy](reverse-proxy.md#tell-vihko-about-the-proxy). |
| `VIHKO_INTEGRATIONS` | unset | `off` keeps every integration off, whatever an admin turns on in the UI: the API with keys, the MCP server, and any a later 1.x release adds. The only other accepted value is unset. |
| `VIHKO_EXTERNAL_IMAGES` | `allow` | `block` stops browsers loading images that notes link from other sites (which tells those sites who reads the note, and when); a box with the site's domain is shown instead. |
| `VIHKO_MAX_IMAGE_MB` | `20` | The largest image vihko stores from an upload, a paste or a URL, in megabytes. An agent's `attach_image` takes about 3 MB at most whatever it says: that is what fits in an MCP request (see [Agents](agents.md#images)). |
| `VIHKO_SECRET_KEY` | unset | A key of 32 characters or more that encrypts the second-factor secrets stored in `state.db`, so that a copy of `state.db` alone can't produce anyone's codes. See [The second-factor key](#the-second-factor-key). |
| `VIHKO_SECRET_KEY_FILE` | unset | The same key, read from a file (a Docker secret, such as `/run/secrets/vihko_key`). Set one of the two, not both. |
| `VIHKO_RESCAN_SECONDS` | `60` | How often vihko scans the whole notes folder for changes the file watcher missed (network filesystems, changes made while it was stopped). |
| `VIHKO_NOTES_DIR` | `/data/notes` | The notes folder, inside the container. Change the volume instead. |
| `VIHKO_STATE_DIR` | `/data/state` | The state folder, inside the container. Change the volume instead. |
| `VIHKO_HOST` | `0.0.0.0` | The address vihko listens on, inside the container. |
| `VIHKO_PORT` | `8080` | The port vihko listens on, inside the container. To change the port on the host, change the `ports:` line (or `VIHKO_HOST_PORT`) instead. |
| `VIHKO_WEB_DIR` | the built UI in the image | Where the built web UI is. Only for running from source; without a UI there, vihko serves the API only. |

For tuning the note history (rarely needed):

| Variable | Default | What it does |
|---|---|---|
| `VIHKO_HISTORY_QUIET_SECONDS` | `30` | A version of a note is saved after this long without changes. |
| `VIHKO_HISTORY_MAX_SECONDS` | `300` | …or at the latest this long after its first change. |
| `VIHKO_HISTORY_SWEEP_SECONDS` | `3600` | How often the whole notes folder is compared with the history, to catch changes it missed. |
| `VIHKO_GIT` | `git` | The git program the history uses. The image includes one. |

Read by Compose, not by vihko:

| Variable | Default | What it does |
|---|---|---|
| `VIHKO_UID`, `VIHKO_GID` | `1000` | The user and group vihko runs as, in the example `compose.yaml`: the owner of the notes folder. See [The user and file ownership](#the-user-and-file-ownership). |
| `VIHKO_HOST_PORT` | `8080` | The host port in the example `compose.yaml`. |

Other `VIHKO_*` variables you may see in the source code are for development
and tests only ([DEVELOPMENT.md](../DEVELOPMENT.md)).

### The second-factor key

People can protect their account with a second factor (an authenticator app).
To check their codes, vihko keeps each person's authenticator secret in
`state.db`. Without `VIHKO_SECRET_KEY`, anyone with a copy of `state.db` (a
backup, say) could compute those codes. With it, the secrets are stored
encrypted (AES-256-GCM).

1. Make a key:

   ```sh
   openssl rand -base64 32
   ```

2. Give it to vihko, as `VIHKO_SECRET_KEY` under `environment:`, or in a file
   through a Docker secret:

   ```yaml
   services:
     vihko:
       # …
       environment:
         VIHKO_SECRET_KEY_FILE: /run/secrets/vihko_key
       secrets:
         - vihko_key
   secrets:
     vihko_key:
       file: ./vihko_key.txt
   ```

   The file must be readable by vihko's user (`VIHKO_UID` in `.env`, which
   also owns the state folder): `chmod 600 vihko_key.txt` and
   `sudo chown "$(stat -c %u:%g state)" vihko_key.txt`.

3. Restart vihko (`docker compose up -d`). The log says
   `VIHKO_SECRET_KEY: second factors are stored encrypted`, and how many it
   encrypted now, if people had already set one up.

- **Keep the key apart from your backups of the state volume**, and back it up
  somewhere else: a backup that holds both protects nothing.
- A key shorter than 32 characters, both variables at once, or a file vihko
  can't read, stop it at start.
- vihko never writes the key to disk or to its log.
- **If you lose or change the key**, the second factors encrypted with the old
  one can't be checked. vihko still starts; the log and the admins' alerts say
  whose. Those people can sign in with a recovery code, or an admin removes
  their second factor (in «Users and groups», or with
  `vihko user reset-2fa <name>`) so they set it up again. Putting the old key
  back makes them work again.

More on second factors for people: [Spaces, people and sharing](users-and-permissions.md).

## Closed by default

A new installation lets nothing in or out except through the people who sign
in:

- **Only the web UI and its sign-in page answer.** There is no self sign-up:
  accounts exist only when an admin invites someone.
- **The API with keys and the MCP server are off** until an admin turns them
  on, in Preferences → Agents and API, and only admins can create keys until
  the admin lets members too, on the same page. `VIHKO_INTEGRATIONS=off` keeps
  the API and MCP off whatever the UI says. See [Agents](agents.md).
- **OAuth doesn't exist** (every OAuth address answers 404) unless you set
  `VIHKO_PUBLIC_URL` *and* the MCP server is on. Even then, apps can't
  register themselves (as `mcp-remote` does) until an admin turns on **OAuth
  apps can register themselves**; apps that identify themselves with a URL,
  such as claude.ai, don't need it.
- **vihko makes no requests of its own**: no telemetry, no update checks, no
  CDNs, no fonts or scripts from other sites. It only reaches out when a
  person asks it to: copying an image from a URL someone pasted, or, for
  remote MCP, fetching the description of the app that someone is authorizing.
- **Browsers load images that notes link from other sites**, as they would
  anywhere. `VIHKO_EXTERNAL_IMAGES=block` stops that.
- **The port is published on your whole network**, over plain HTTP. On the
  Internet, always use HTTPS: see [Reverse proxy](reverse-proxy.md).

Webhooks are planned, not part of 1.0.

## Running without Docker

Docker is the supported way to run vihko. Running it straight from a checkout
with Node works, and is how vihko is developed, but it's only documented for
development: see [DEVELOPMENT.md](../DEVELOPMENT.md#setting-up). You need
the Node version in `.nvmrc`, `git`, `npm ci` and `npm run build`, and then:

```sh
VIHKO_NOTES_DIR=/path/to/notes VIHKO_STATE_DIR=/path/to/state packages/server/src/cli.ts serve
```

There are no system packages or service files. Everything in this guide about
the two folders, the environment variables and the command line applies the
same way. Running from source isn't part of the 1.x promise: the Node.js
version, the npm scripts and the repository's layout can change in any
release (see [What isn't covered](compatibility.md#what-isnt-covered)).
