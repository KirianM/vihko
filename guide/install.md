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

2. Read [the compose file](#the-compose-file) below and adjust it: which
   image tag, which port, and where your notes are. To use a notes folder you
   already have, change `./notes` to its path.

3. Create the two folders yourself, before the first start:

   ```sh
   mkdir notes state
   ```

   If a folder in a bind mount doesn't exist, Docker creates it owned by
   `root`, and vihko (which doesn't run as root) can't write to it. See
   [The user and file ownership](#the-user-and-file-ownership).

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
    # The first release candidate, under its exact tag (a candidate is only
    # published that way). From 1.0.0 on, this line says :1, which gets every
    # 1.x release (fixes and features) and never an incompatible version: that
    # is a new major, which you choose by changing the tag.
    image: ghcr.io/kirianm/vihko:1.0.0-rc.1
    restart: unless-stopped
    ports:
      # Host port: 8080 unless you say otherwise. If it is taken,
      # VIHKO_HOST_PORT=8098 docker compose up -d (or put it in a .env file).
      # Don't expose it to the Internet without HTTPS in front (a reverse proxy).
      - "${VIHKO_HOST_PORT:-8080}:8080"
      # Behind a reverse proxy on this host, only the proxy needs to reach it:
      # this line instead of the one above.
      # - "127.0.0.1:${VIHKO_HOST_PORT:-8080}:8080"
    volumes:
      # Notes: any Markdown folder (local disk or NFS).
      - ./notes:/data/notes
      # State: ALWAYS on local disk (SQLite is not reliable over NFS).
      - ./state:/data/state
    # User that writes your notes (1000:1000 by default).
    # user: "1000:1000"
    # environment:
    #   # Only behind a reverse proxy with HTTPS: the public address, for remote
    #   # MCP clients such as claude.ai (OAuth). See guide/reverse-proxy.md.
    #   VIHKO_PUBLIC_URL: https://notes.example.com
    #   # The reverse proxy's address as vihko sees it, so the login limits
    #   # count each client apart (X-Forwarded-For is believed only from it).
    #   VIHKO_TRUSTED_PROXIES: 172.16.0.0/12
```

### The image and its tags

`ghcr.io/kirianm/vihko` is the only place vihko's image is published. The tags:

| Tag | What you get |
|---|---|
| `1` | The latest 1.x release. Recommended: fixes and new features, never a change that needs you to do something by hand. |
| `1.2` | The latest 1.2.x release: fixes only. |
| `1.2.3` | Exactly that release. It never changes. |
| `latest` | The latest release, **whatever its major version**. It can jump from 1.x to 2.0 on a `docker compose pull`. Avoid it. |
| `1.0.0-rc.1` | A release candidate, only under its exact tag. |

[Upgrading](upgrading.md) explains what a major version means and how to move
between versions.

### `restart: unless-stopped`

Docker starts vihko again after a crash or a reboot, unless you stopped it
yourself. If vihko can't start (a wrong variable, a folder it can't write),
Docker keeps restarting it: read the log (`docker compose logs vihko`) to see
why.

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
it and bind the port to `127.0.0.1` (the commented line). See
[Reverse proxy](reverse-proxy.md).

### The notes volume

`./notes:/data/notes` is your notes: a folder of Markdown files, the source of
truth. It can be an empty folder or one you already have, even one shared with
other editors or sync tools. vihko imposes no structure on it.

It can live on local disk or on a network filesystem (NFS, SMB). On a network
filesystem, vihko sees changes made from other machines through a periodic
rescan, every 60 seconds by default; see
[Notes on NFS](operations.md#notes-on-nfs).

Back it up. See [Backups](backups.md).

### The state volume

`./state:/data/state` is vihko's own data:

| Path | What it is | Back it up? |
|---|---|---|
| `state.db` | Users, groups, sessions, invitations, API keys and OAuth clients, settings, second factors | Yes |
| `history.git/`, `history/` | The history of your notes (a git repository), when the history is managed by vihko | Yes |
| `trash/` | Deleted notes and folders, which people can restore from the UI | Yes |
| `collab/` | Recovery logs of notes being edited, so a crash loses no typing | Yes |
| `config-backups/` | Copies of `vihko.yaml` made before vihko rewrote it after an upgrade | Yes |
| `index.db` | The search index. Derived from the notes, rebuilt when needed | No |
| `vihko.lock` | Keeps a second vihko process off the same state | No |

**Keep it on local disk.** `state.db` and `index.db` are SQLite databases, and
SQLite's locking is not reliable over NFS or SMB: two processes could both
think they hold a lock, and the database can be corrupted. The history is a git
repository, and git over a network filesystem is also many times slower. A bind
mount of a host folder that is itself an NFS mount *is* NFS, as far as SQLite is
concerned.

A Docker named volume works too (`- vihko-state:/data/state`, with a
`volumes:` section); a folder next to `compose.yaml` is simply easier to back
up.

### The user and file ownership

The container runs as user `1000:1000` (called `node` in the image), not as
root. That user must be able to read and write both folders, and every note
vihko writes gets that owner.

To run it as another user, typically the one that owns your notes, uncomment
`user:` and give the numeric ids:

```yaml
    user: "1001:1001"
```

Then make both folders belong to it:

```sh
sudo chown -R 1001:1001 notes state
```

If you let Docker create the folders, they belong to `root` and vihko can't
start: it restarts in a loop and the log shows `SqliteError: unable to open
database file` (`SQLITE_CANTOPEN`). Stop it, fix the owner, start it:

```sh
docker compose down
sudo chown -R 1000:1000 notes state
docker compose up -d
```

On NFS, the export may map every write to one user (`all_squash`, `mapall`
and similar). Then files get whatever owner the export imposes, and `user:`
must be a user the export lets write. See
[Notes on NFS](operations.md#notes-on-nfs).

### `environment:`

Uncomment `environment:` to set [environment variables](#environment-variables).
None is required. The two in the file only matter behind a reverse proxy.

## First start

Read the log:

```sh
docker compose logs vihko
```

```text
[vihko] vihko 1.0.0-rc.1
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
time it starts; once the admin exists, it prints none.

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

- Invite people: [Users and permissions](users-and-permissions.md).
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
message in the log that names the variable. (`VIHKO_RESCAN_SECONDS`,
`VIHKO_HOST` and `VIHKO_PORT` aren't checked yet: give them sensible values.)

| Variable | Default | What it does |
|---|---|---|
| `VIHKO_PUBLIC_URL` | unset | The `https://` address vihko is reached at from outside, behind a reverse proxy: the origin only, such as `https://notes.example.com`. It makes OAuth available for remote MCP clients (while the MCP server is on), and invitation and password-reset links use it. See [Reverse proxy](reverse-proxy.md) and [Agents](agents.md). |
| `VIHKO_TRUSTED_PROXIES` | unset | Addresses or CIDR ranges of your reverse proxies, separated by commas or spaces (`172.16.0.0/12, 10.0.0.5`). Only from them does vihko believe `X-Forwarded-For`, to tell clients apart for the sign-in limits. Unset, every request counts as coming from the connection's address. See [Reverse proxy](reverse-proxy.md#tell-vihko-about-the-proxy). |
| `VIHKO_INTEGRATIONS` | unset | `off` keeps the API with keys and the MCP server off, whatever an admin turns on in the UI. The only other accepted value is unset. |
| `VIHKO_EXTERNAL_IMAGES` | `allow` | `block` stops browsers loading images that notes link from other sites (which tells those sites who reads the note, and when); a box with the site's domain is shown instead. |
| `VIHKO_MAX_IMAGE_MB` | `20` | The largest image vihko stores from an upload, a paste or a URL, in megabytes. |
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
| `VIHKO_HOST_PORT` | `8080` | The host port in the example `compose.yaml`. |

Other `VIHKO_*` variables you may see in the source code are for development
and tests only ([CONTRIBUTING.md](../CONTRIBUTING.md)).

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

   The file must be readable by the container's user (`1000` unless you
   changed `user:`): `chmod 600 vihko_key.txt` and
   `sudo chown 1000:1000 vihko_key.txt`.

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

More on second factors for people: [Users and permissions](users-and-permissions.md).

## Closed by default

A new installation lets nothing in or out except through the people who sign
in:

- **Only the web UI and its sign-in page answer.** There is no self sign-up:
  accounts exist only when an admin invites someone.
- **The API with keys and the MCP server are off** until an admin turns them
  on, in Preferences → Agents and API. `VIHKO_INTEGRATIONS=off` keeps them off
  whatever the UI says. See [Agents](agents.md).
- **OAuth doesn't exist** (every OAuth address answers 404) unless you set
  `VIHKO_PUBLIC_URL` *and* the MCP server is on.
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
development: see [CONTRIBUTING.md](../CONTRIBUTING.md#development). You need
the Node version in `.nvmrc`, `git`, `npm ci` and `npm run build`, and then:

```sh
VIHKO_NOTES_DIR=/path/to/notes VIHKO_STATE_DIR=/path/to/state packages/server/src/cli.ts serve
```

There are no system packages or service files. Everything in this guide about
the two folders, the environment variables and the command line applies the
same way.
