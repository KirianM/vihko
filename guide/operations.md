# Operations

Running vihko day to day: the command line, the log, the health check, how it
notices changes to your files, notes on NFS, and fixes for common problems.

## The command line

The image has a `vihko` command. Run it inside the container, from the folder
of `compose.yaml`:

- while vihko runs: `docker compose exec vihko vihko <command>`;
- while it's stopped: `docker compose run --rm vihko vihko <command>`.

Add `-T` to `exec` when you pipe something into it (a password).

Run it as the container's own user, as these commands do. Not with `-u root`:
whatever it creates in the state volume would then belong to root, and vihko,
which doesn't run as root, might not be able to write there afterwards.

| Command | What it does | vihko running? |
|---|---|---|
| `vihko serve` | Starts the server. It's what the container runs (`vihko` alone does the same). | — |
| `vihko user create <name> [--admin]` | Creates a user, a member unless `--admin` (before or after the name). Reads the password from standard input. | Either |
| `vihko user reset-link <name>` | Prints a one-time link, valid 7 days, for that person to choose a new password. | Either |
| `vihko user reset-2fa <name>` | Removes that person's second factor (authenticator and recovery codes). | Either |
| `vihko history purge <path> [--version <id>] [--dry-run]` | Removes a file or folder from the history, for good. | Stopped (`--dry-run`: either) |
| `vihko version` or `vihko --version` | Prints the version. | Either |

A command that fails prints `error: …` or `error (<code>): …` and exits with
status 1; a command it doesn't understand, or arguments a command doesn't
take, print the usage and exit with status 2. `vihko version` prints the
version alone, for scripts. [What 1.x keeps stable](compatibility.md#the-command-line)
says which of this stays.

### Create a user

```sh
read -rs -p 'Password: ' pw && echo && printf '%s\n' "$pw" | docker compose exec -T vihko vihko user create alex --admin; unset pw
```

```text
user created: alex (admin)
```

Usernames have 2 to 64 letters, digits, `.`, `_` or `-`, and can't be one of
the few names JavaScript objects already have (`__proto__`, `constructor`,
`prototype`, `toString`…); the same goes for group names. Passwords have at
least 10 characters. Usually you invite people from the UI instead, and they choose
their own password: see [Users and permissions](users-and-permissions.md).

### Reset a lost password

For an admin who can't sign in (another admin can do it from the UI):

```sh
docker compose exec vihko vihko user reset-link alex
```

```text
password reset link for alex, valid until 2026-10-05T11:47:02.759Z (any earlier link of theirs no longer works):
  <vihko's address>/invite/ilqdm3qvTtRXHjtb-gn8tdMkOf3cmcTpCrxxXiFQgGU
```

Put vihko's address in front (`http://<your-server>:8080/invite/…`; with
`VIHKO_PUBLIC_URL` set, the link comes complete), open it and choose a new
password. For someone who never chose a password, it's an invitation link.
Any earlier link of theirs stops working.

The link doesn't skip the second factor: someone who also lost their phone
needs `reset-2fa` too.

### Reset a second factor

```sh
docker compose exec vihko vihko user reset-2fa alex
```

```text
second factor removed for alex: they sign in with their password alone (or set up a new one, if it's required)
```

Use it for someone who lost their authenticator and their recovery codes, or
whose second factor can't be read any more because `VIHKO_SECRET_KEY` was
lost or changed. With `reset-link`, it's the way back for an admin who lost
both password and phone.

### Purge something from the history

For what should never have been kept, such as a password pasted into a note
by mistake. It rewrites the history managed by vihko so that the content is in
no version at all.

1. Delete the file (or remove the secret from it), or add it to
   `history.exclude` in `vihko.yaml`. Otherwise its content enters the history
   again with its next version.
2. See what would change, with vihko running:

   ```sh
   docker compose exec vihko vihko history purge Projects/plan.md --dry-run
   ```

3. Stop vihko, purge, start it:

   ```sh
   docker compose stop
   docker compose run --rm vihko vihko history purge Projects/plan.md
   docker compose start
   ```

- `<path>` is a file or a folder, relative to the notes folder, and goes from
  every version.
- `--version <id>` (or `--version=<id>`) removes only what that file held in
  one version (the id in a version's address, `?version=<id>`; 7 characters
  are enough): wherever the file had that content, it gets what it had right
  before.
- vihko must be stopped: the command refuses with `error (state_in_use)` while
  it runs. `--dry-run` only reads, so it works either way.
- Only the managed history: in unmanaged mode the repository is yours, and it
  refuses.
- Everything else keeps its authors, dates and moves. The versions after the
  first one rewritten get new ids. It never touches the notes folder or the
  trash.
- If it stops halfway, the history stays as it was; running it again finishes
  the work.

More about the history in [History](history.md).

## The log

vihko writes its log to standard output, so Docker keeps it:

```sh
docker compose logs -f vihko          # follow it
docker compose logs --tail 50 vihko   # the last 50 lines
```

A normal start, after the first one:

```text
[vihko] vihko 1.0.0
[vihko] vihko.yaml loaded
[vihko] index ready: 0 added, 3 changed, 0 removed, 1247 unchanged
[vihko] saved editor states: 41 of 42 match their file
[vihko] history sweep (startup): 3 changes
[vihko] listening on http://0.0.0.0:8080
```

The lines to know:

| Line | What it means |
|---|---|
| `vihko <version>` | The first line of every start. |
| `no vihko.yaml: nothing configured` | There's no [`vihko.yaml`](configuration.md): no daily notes or templates, and every admin manages the whole notes folder. |
| `vihko.yaml loaded` | `vihko.yaml` was read and applies. Printed again whenever it changes. |
| `vihko.yaml loaded without unknown_key at <key>, …` | It applies, except what the line lists: `unknown_key at <key>` is a key vihko doesn't know (a typo, or a setting of a newer vihko), which is ignored; `section_rejected at permissions` means the permissions section was rejected. The admins see each one, with its line, in the workspace alerts. See [When something is wrong](configuration.md#when-something-is-wrong). |
| `index ready: …` | The first scan of the notes folder is done: notes added, changed, removed and unchanged since the index last saw them. |
| `saved editor states: N of M match their file` | M notes have a saved editor state in `state/collab/` (every note opened in the editor has one), and N of them still match their file. The others changed while vihko was stopped, or the state was restored from a backup: each is loaded from its file the next time it's opened (`the saved document doesn't match the file`, below). Nothing to do. |
| `removed N saved editor state(s) whose note no longer exists` | Saved editor states of notes deleted or moved away while vihko was stopped were cleaned up. A pending recovery is never removed. Nothing to do. |
| `history sweep (…): N changes` | The notes folder compared with the history: N changes vihko hadn't recorded were saved as versions. In brackets, when: `startup` (changes made while vihko was stopped), `enabled` (the first start with the history on: every note's starting point), `resumed` (the history had been off or unavailable), `periodic` (the regular check, hourly by default: `VIHKO_HISTORY_SWEEP_SECONDS`). Nothing is printed when there are no changes. |
| `listening on http://0.0.0.0:8080` | Ready. The address is inside the container. |
| `first boot: no users yet…` | No users yet; the next line has the one-time token. See [Installation](install.md#first-start). |
| `public URL …` | `VIHKO_PUBLIC_URL` is set. |
| `VIHKO_TRUSTED_PROXIES is unset: …` | You set a public URL but not the proxy's address. See [Reverse proxy](reverse-proxy.md#tell-vihko-about-the-proxy). |
| `VIHKO_TRUSTED_PROXIES: <range> is a wide range: …` | An entry covers more than a /12 (IPv4) or a /48 (IPv6): every device in it is believed as a proxy and could slip past the sign-in limits. Give the proxy's own address. See [Reverse proxy](reverse-proxy.md#tell-vihko-about-the-proxy). |
| `VIHKO_INTEGRATIONS=off: …` | The API with keys and the MCP server are locked off. |
| `VIHKO_SECRET_KEY: second factors are stored encrypted` | The key is in use. |
| `N second factor(s) can't be read …` | The key is missing or different from the one they were encrypted with. See [The second-factor key](install.md#the-second-factor-key). |
| `vihko.yaml rewritten to the current format: …` | An upgrade changed the file's format; the line says where the copy is. See [Upgrading](upgrading.md#what-happens-at-start). |
| `vihko.yaml can't be used (…)` | A mistake in `vihko.yaml`: vihko keeps the last valid version. The admins see the details in the workspace alerts. See [Configuration](configuration.md). |
| `moved outside vihko: a.md → b.md (…)` | A note was renamed or moved by another program; vihko followed it. |
| `external change integrated into …` | A note open in an editor was changed by another program; the editors show the change. |
| `<note>: the file changed after the note was closed, with vihko running; merged into its saved document` | Another program changed the note after its last editor closed it. When it's opened again, vihko merges that change into its saved editor state, so a browser that still had the note open offline merges its typing too. Normal when you also edit with other tools. |
| `<note>: the saved document doesn't match the file; new generation` | The note's file changed while vihko was stopped (or the state volume was restored from a backup): it's loaded from its file. A browser that had it open offline keeps its unsent typing aside and asks what to do with it. |
| `recovered … from the log (…)` | After a crash, typing that hadn't reached the file was recovered. |
| `scan aborted: mass_delete` | A scan found most notes gone and stopped. See [Notes vanished](#notes-vanished-scan-stopped). |
| `scan aborted: root_unavailable` | The notes folder isn't there (an unmounted share?). |
| `history sweep: N of M files look deleted; not recorded (…)` | Same guard, for the history. |
| `watcher: …` | The file watcher failed. The periodic rescan keeps vihko up to date meanwhile. |
| `history unavailable: …` / `history available again` | The history couldn't save versions for a while; notes are saved as usual. |
| `vihko runs as root (0:0), which it doesn't need: …` | `.env` (or its absence, as root) has vihko run as root. It works, but give the folders to an ordinary user: see [The user and file ownership](install.md#the-user-and-file-ownership). |
| `the state folder … belongs to …, not to the user vihko runs as …, so vihko can't close it to other users of this system …` | vihko starts, but can't make the state folder private (mode `700`). The line says the `chown` that fixes it. |
| `vihko can't write to the … folder …` / `vihko can't read the … folder …` / `the notes folder … doesn't exist …` | vihko stops, and Docker restarts it in a loop: see [Restarting in a loop](#restarting-in-a-loop-vihko-cant-write-to-the--folder). |

Errors that stop vihko at start print the message and a stack trace. The
first lines say what's wrong: see [Common problems](#common-problems).

Docker's default log driver keeps everything unless you limit it. To cap it,
add this to the `vihko` service:

```yaml
    logging:
      options:
        max-size: "10m"
        max-file: "3"
```

## The health check

`GET /api/health` answers `200 {"ok":true}` while vihko runs. It needs no
sign-in and says nothing else, not even the version.

The image has a Docker `HEALTHCHECK` that calls it every 30 seconds. The
`STATUS` column of `docker compose ps` shows the result, such as
`Up 2 hours (healthy)`; `(unhealthy)` after three failures in a row.

For an outside monitor, check `https://notes.example.com/api/health` (or
`http://<your-server>:8080/api/health`). It tells you the process answers; it
doesn't check that the notes folder is mounted. To see the version, sign in,
or run `vihko version`.

## How vihko notices changes

You can change notes with any program: another editor, a sync tool, a script.
vihko notices in two ways, and needs both:

- **The watcher** hears about changes made on this machine at once (Linux
  inotify).
- **The periodic rescan** goes through the whole notes folder every
  `VIHKO_RESCAN_SECONDS` (60 by default) and catches whatever the watcher
  missed: changes made from another machine on a network share, events the
  system dropped, changes made while vihko was stopped. It also rereads
  `vihko.yaml`.

A note open in an editor is also compared with its file every second, so a
change made elsewhere shows up in the open editors within seconds.

What vihko looks at:

- Files ending in `.md` are notes. Other files are attachments (images, PDFs).
- Anything whose name, or a folder above it, starts with a dot is ignored
  (`.git/`, `.obsidian/`, `.trash/`, temporary files, NFS's `.nfsXXXX`), and so
  are backup files ending in `~`.
- Conflict copies made by Syncthing (`plan.sync-conflict-….md`) aren't
  indexed; the admins see them in the workspace alerts.

### Notes vanished (scan stopped)

If a scan finds that more than half the notes (and more than 10) are gone at
once, vihko assumes the folder is unavailable rather than emptied. It stops
the scan, keeps every note in the index and the history, and shows the admins
a workspace alert: «Scan stopped: it was about to remove N of M notes». Check
that the notes folder is there (mounted, readable), then choose «Check again».
If you did delete them, choose «Yes, I deleted them».

## Notes on NFS

The notes folder can be on NFS (or SMB). The state volume can't: see
[Installation](install.md#the-state-volume).

**What works**: everything. vihko writes each note to a temporary file in the
same folder and renames it, so a reader never sees half a note, and it
doesn't rely on file locks in the notes folder. The index and the history
live in the state volume, on local disk, so they're as fast as anywhere.

**What to expect**:

- Changes made **through this machine** (vihko itself, or other programs on
  the same host) are seen at once. Changes made **from another machine**
  (your laptop, the file server itself) are only seen by the periodic
  rescan: within `VIHKO_RESCAN_SECONDS`, 60 by default. inotify can't see
  them. A lower value finds them sooner and walks the whole folder more
  often.
- Open notes pick up changes from other machines within seconds, subject to
  the NFS client's attribute cache.

**How to set it up**:

- **Mount with `hard`**, not `soft`. With `soft`, a server hiccup can turn
  into a failed or partial write with no visible error; with `hard`, the
  write waits until the server is back.
- **Mind the owner.** vihko writes as `VIHKO_UID:VIHKO_GID` from `.env`
  (`1000:1000` without them): the numeric ids that own the notes on the share,
  as `stat -c %u:%g` shows them from this host. If the export maps every
  client user to one account (`all_squash`, `mapall` and similar), files get
  that owner whatever vihko runs as; make sure that account can write the
  folder. Don't `chown` the share from here; give the local state folder the
  same owner instead. See
  [The user and file ownership](install.md#the-user-and-file-ownership).
- **Start vihko only once the share is mounted.** If vihko starts before the
  mount, it sees the empty folder under the mount point: the scan guard above
  keeps your index, but new notes would be written to the local disk and
  hidden once the share mounts. Two ways to avoid it:
  - Let Docker mount the share, as a named volume: if the mount fails, the
    container doesn't start.

    ```yaml
    services:
      vihko:
        # …
        volumes:
          - notes:/data/notes
          - ./state:/data/state

    volumes:
      notes:
        driver_opts:
          type: nfs
          o: "addr=192.0.2.20,rw,hard,nfsvers=4.1"
          device: ":/export/notes"
    ```

  - If the host mounts the share, make the empty mount point read-only while
    nothing is mounted on it (`sudo chattr +i /mnt/notes`, run before
    mounting), so a write there fails loudly instead of landing on local
    disk.

## The state lock

Only one vihko process uses a state volume at a time. The server holds a lock
on `vihko.lock` in the state volume while it runs; a second server, or
`vihko history purge`, refuses to start:

```text
error (state_in_use): the state folder is in use by another vihko process (/data/state/vihko.lock): is the server running?
```

The lock is released however the process ends, `kill -9` or a power cut
included: there's never a stale lock to clean up. (Over NFS, this lock is as
unreliable as SQLite's: one more reason to keep the state on local disk.)

The lock doesn't cover the notes folder: nothing stops two vihko with
different state volumes from using the same notes. Don't: they would both
write to the notes, and each keep its own history of them.

## Disk space

- `index.db` grows with your notes; you can delete it at any time (with vihko
  stopped) and it's rebuilt.
- The history grows with every version, attachments included (up to 20 MB
  each by default). Files you don't need versions of can be kept out with
  `history.exclude`: see [History](history.md).
- The trash keeps deleted notes (with their images) and the files of deleted
  folders until you remove them. There's no way to empty it from the UI yet:
  each entry is a folder in `state/trash/`; with vihko stopped, delete the
  ones you don't need.
- Every `state.db` migration leaves a `state.db.bak-v<N>` copy; remove old
  ones once you're happy with an update.

## Common problems

### "port is already allocated"

```text
Error response from daemon: … Bind for 0.0.0.0:8080 failed: port is already allocated
```

Another program uses port 8080 on the host. Pick another one:

```sh
echo 'VIHKO_HOST_PORT=8098' >> .env
docker compose up -d
```

`sudo ss -ltnp 'sport = :8080'` shows who has it.

### Restarting in a loop, "vihko can't write to the … folder"

```text
[vihko] vihko can't write to the state folder /data/state: it belongs to 0:0 (mode 755) and vihko runs as 1000:1000. Fix: chown -R 1000:1000 the state volume's folder on the host (./state next to the example compose.yaml); see guide/install.md, "The user and file ownership"
```

vihko's user (`VIHKO_UID:VIHKO_GID` in `.env`) can't write to one of its
folders, usually because it was created as root (by you, or by Docker when the
folder didn't exist). The line says which folder, and the fix: give the
folder to vihko's user, or set `.env` to the owner of your notes. For the
state folder, for example:

```sh
docker compose down
sudo chown -R 1000:1000 state
docker compose up -d
```

1.0.0-rc.1 said it differently: a warning that the state folder "can be read
by other users of this system", then `SqliteError: unable to open database
file` (`SQLITE_CANTOPEN`). The fix is the same. That error can still show
when the folder is right but a file in it isn't (one copied in as root
without `-p`): `sudo chown -R` on the state folder fixes both.

### Saving a note fails, `EACCES` in the log

The UI shows an internal error when you create or save a note, and the log
has:

```text
  code: 'EACCES',
  syscall: 'open',
  path: '/data/notes/.Inbox.md.vihko-1-0-f433221f'
```

vihko can read the notes folder, or that subfolder, but not write to it
(vihko checks the notes folder itself when it starts, not every subfolder).
Give the folder, and every subfolder, to vihko's user, or set `VIHKO_UID` and
`VIHKO_GID` in `.env` to the user that owns them (see
[The user and file ownership](install.md#the-user-and-file-ownership)). On
NFS, check how the export maps users (see [Notes on NFS](#notes-on-nfs)).

### The state volume is on NFS

It may seem to work for a while. What can go wrong: `database is locked`
errors, slow history, a damaged `state.db`, or two processes both getting the
state lock. Move it to local disk:

```sh
docker compose down
sudo rsync -a /mnt/share/vihko-state/ /srv/vihko/state/
```

Then point the state volume at the new folder in `compose.yaml` and
`docker compose up -d`. If `state.db` is already damaged, restore it from a
[backup](backups.md).

### "state.db is at version N, newer than this install"

You started an older image on a state volume a newer version already
migrated. Go back to the newer image, or follow
[Rolling back](upgrading.md#rolling-back).

### `error (state_in_use)`

Another vihko process has the state volume: the server, when you run
`history purge` without stopping it, or a second container on the same
folder. Stop the other one.

### Lost admin password

Run `vihko user reset-link <name>` ([above](#reset-a-lost-password)). If
there's another admin, they can make the link from «Users and groups»
instead.

### Lost phone and recovery codes

Run `vihko user reset-2fa <name>` ([above](#reset-a-second-factor)), or ask an
admin to remove it in «Users and groups». The person signs in with their
password and sets up a new second factor.

### The proxy answers 502 Bad Gateway

The reverse proxy can't connect to vihko. The usual cause: vihko's port is
bound to `127.0.0.1` while the proxy runs on another machine. See
[The proxy can't reach vihko](reverse-proxy.md#the-proxy-cant-reach-vihko-502-bad-gateway).

### Signing in fails with 403 behind a proxy

The proxy doesn't keep the `Host` header. See
[Reverse proxy](reverse-proxy.md#what-vihko-needs-from-the-proxy).

### Search results look wrong

The index is disposable: rebuild it.

```sh
docker compose stop
rm -f state/index.db state/index.db-wal state/index.db-shm
docker compose start
```

The log shows every note as added. Nothing else is affected. (Use `sudo` if
the files aren't yours.)

### Changes made elsewhere don't show up

Wait for the next rescan (`VIHKO_RESCAN_SECONDS`, 60 by default): changes
made from another machine on a network share are only seen then. Check the
log for `watcher:` or `scan aborted` lines, and that the file isn't hidden
(a name starting with a dot) or outside the notes folder.

## Known limits

vihko trusts the people who sign in not to exhaust the server on purpose.
Images are limited (two at a time per person, eight in all, and a size per
image), request bodies too, but some things aren't capped yet:

- how many live editing connections and open notes one person can hold at
  once (each open note is checked on disk every second, which weighs more on
  a network share);
- how many images a person uploads in total over time.

If someone abuses that, disable their account (Preferences → Users and
groups): their connections close at once. Caps for these are planned after
1.0.
