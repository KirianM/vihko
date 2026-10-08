# Backups

vihko keeps your data in two folders: the notes folder and the state volume.
Back up both. This guide says what's in each, how to take a copy that is
consistent, and how to restore it.

## What to back up

| What | Where | Why |
|---|---|---|
| **The notes folder** | `./notes` (`/data/notes`) | Everyone's notes and their images, in `people/` and `spaces/`: the source of truth. Includes `vihko.yaml`, the workspace configuration, with the members of each shared space and who shares what, and each space's own settings (`.vihko/settings.yaml` inside it). Back it up whole: a space's folder alone doesn't carry its members. |
| **`state.db`** | `./state` (`/data/state`) | People, groups, passwords, sessions, invitations, API keys, OAuth clients, second factors and settings. It can't be rebuilt from the notes. |
| **The history** | `state/history.git/` and `state/history/` | Every version of every note, when vihko manages the history (the default). It doesn't travel with the notes folder: copying the notes doesn't copy their history. |
| **The trash** | `state/trash/` | Deleted notes and folders, which people can still restore. |
| **Editor states** | `state/collab/` | For each note opened in the editor, its saved editor state (`.ystate`): the note as its last editor left it, so that a browser that was offline merges its typing into the same note instead of adding a second copy. And, for a note open when vihko stopped, its recovery log (`.ylog`): typing not yet written to the file. It holds one `.ystate` for every note ever opened, so it's rarely empty. Back it up with the rest of the state volume. |
| **Retention's progress** | `state/retention.json` | What [retention](operations.md#retention) still has to finish after a run cut short, and its last run's counts. Small. |
| **`vihko.yaml` copies** | `state/config-backups/` | The file as it was before an upgrade rewrote it. See [Upgrading](upgrading.md#what-happens-at-start). |
| **The last good `vihko.yaml`** | `state/vihko.yaml.last-valid` and `state/vihko.yaml.last-permissions` | The last file vihko could use, which applies if it starts with one it can't; and the last one whose `permissions` shared something, which «Restore previous permissions» writes back if the section disappears. Small. |
| **Pending work** | `state/permission-holds.json`, `state/external-moves.json`, `state/relink-retries.json` | Notes held after a move made outside vihko, moves outside vihko whose links can still be updated, and link rewrites to try again. Small. |
| **The second-factor key** | Wherever you keep `VIHKO_SECRET_KEY` or its file | Only if you use it. **Back it up apart from the state volume**, in a password manager for example: whoever has both can compute people's second-factor codes. See [The second-factor key](install.md#the-second-factor-key). |

In short: the whole notes folder and the whole state volume, plus the key if
you have one. Keep a copy of `compose.yaml` and `.env` too: small, and they
say which user vihko runs as (`VIHKO_UID`, `VIHKO_GID`) and how it's set up.

If the history is in *unmanaged* mode, vihko reads the git repository you keep
in your notes folder, so it's backed up with the notes. See
[History](history.md).

### What not to back up

- **`index.db`** (and `index.db-wal`, `index.db-shm`): the search index. vihko
  rebuilds it from the notes when it's missing. Leaving it out makes backups
  smaller; including it does no harm.
- **`vihko.lock`** and **`vihko.lock-journal`**: the lock that keeps a second
  vihko off the state (the `-journal` only while vihko runs). Harmless either
  way.

## Take a consistent copy

The state volume holds SQLite databases (in WAL mode, where recent changes
live in a separate `-wal` file) and a git repository. A plain file copy of it
while vihko writes can catch a database or a commit halfway, and give you a
backup that doesn't open. Take the copy one of these two ways.

### Stop vihko, copy, start it (simplest)

vihko stops in a second or two, writing everything out first. From the folder
of `compose.yaml`:

```sh
docker compose stop
(umask 077 && sudo tar -czf /backups/vihko-$(date +%F).tar.gz --exclude='state/index.db*' notes state)
docker compose start
```

`sudo` because the files belong to the container's user, which may not be
yours. `umask 077` makes the archive readable by its owner only: it holds
every note of every person, their whole history and `state.db`, with nothing
of vihko's rules around them. Whoever can read a backup reads everyone's
spaces. Keep the copies somewhere else than the server:
another disk, another machine, or a backup service, just as private.

For a nightly backup, put those three lines in a script and run it from
`cron` or a systemd timer, at an hour nobody writes. Someone editing at that
moment sees «Offline · keep this tab open» for a few seconds; the editor
saves what they typed once vihko is back (in the rare case it can't be merged,
the editor keeps their version aside for them).

### An atomic snapshot, with vihko running

If the state volume is on a filesystem that takes atomic snapshots (ZFS,
btrfs, LVM), a snapshot of the **whole** state volume, taken in one step while
vihko runs, is safe. Restoring it is the same as vihko being killed at the
instant of the snapshot (`kill -9`), which it recovers from without losing
anything it had saved.

This only holds for one snapshot of the whole volume. Copying it file by file
(`cp`, `rsync`, `tar`) while vihko runs is **not** safe.

### The notes folder on its own

The notes folder can be copied while vihko runs, with any tool: vihko writes
each note in one step (a temporary file, then a rename), so every file is
copied whole, from before or after a change. If your notes are already backed
up another way (snapshots of a NAS, a sync tool), keep doing that, and back up
the state volume as above.

vihko's temporary files start with a dot (`.plan.md.vihko-…`); they're only
there for an instant and you can leave them out.

## Restore

1. **Stop vihko**:

   ```sh
   docker compose down
   ```

2. **Move the current folders aside.** Don't delete them until the restore
   works:

   ```sh
   mv notes notes.before-restore
   mv state state.before-restore
   ```

3. **Extract the backup** as root, so files keep their owner:

   ```sh
   sudo tar -xzpf /backups/vihko-2026-10-01.tar.gz
   ```

4. **Use the same image version as when you took the backup, or a newer
   one.** A newer version migrates the restored `state.db` on its own; an older
   one refuses it (see [Rolling back](upgrading.md#rolling-back)).

5. **Use the same second-factor key**, if you had one. Without it, people with
   a second factor sign in with a recovery code, or an admin removes it (see
   [The second-factor key](install.md#the-second-factor-key)).

6. **Start vihko** and read the log:

   ```sh
   docker compose up -d
   docker compose logs --tail 20 vihko
   ```

   Without `index.db`, the first scan indexes every note:
   `index ready: 1250 added, …`.

### After restoring an older `state.db`

`state.db` holds people, their passwords and second factors, sessions, agent
keys, OAuth authorizations and the settings made in the UI. A copy from
before brings back **everything that was revoked or changed since**: keys and
authorizations you revoked, passwords changed after a scare, people you
disabled or deleted, second factors you took away and their old recovery
codes, sessions that were signed out, links that were never used, and the
settings as they were (the integration switches, retention). The same goes
for [rolling back](upgrading.md#rolling-back) to a `state.db.bak-v*`. An
older notes folder brings back its `vihko.yaml`, with the permissions of
then: someone you took out of a space is in it again. vihko can't tell on
its own (that is the copy's content). Restores often follow an incident, so
before you open vihko to everyone again, undo those by hand, as the admin,
with what vihko has today:

1. **Permissions.** Compare `vihko.yaml`'s `permissions` with what you
   expect (the members of each space, the folders shared). If you restored
   the notes from an older copy, take it from the newest copy you trust, or
   fix it by hand.
2. **Sign everyone out.** In Preferences → «Users and groups», each person's
   actions have «Sign out their sessions»: do it for everyone else, and end
   your own other sessions from Preferences → «Account» («Sign out the
   others»).
3. **Revoke again** the agent keys and OAuth authorizations revoked since
   the copy, and any you don't recognise: «Agents and API» lists everyone's
   for the admin, under «Everyone else’s keys».
4. **Disable or delete again** the people disabled or deleted since the
   copy, and check the roles.
5. **Passwords and second factors changed since the copy**: give those
   people a «Password reset link», and «Reset two-step verification» (or
   `vihko user reset-2fa <name>`) for anyone whose phone or recovery codes
   were the reason; they set up a new one at their next sign-in.
6. **Invitation and reset links** made before the copy work again until
   they expire (7 days): make a new one for anyone still invited, which
   ends the old one.
7. **Settings.** Check the switches in «Agents and API» and «Users and
   groups» (retention included) are as you want them now.
8. **Read the alerts**: a migration of `state.db`, folders whose grants no
   longer have a folder, and anything else vihko noticed.

If nothing happened between the copy and the restore (a disk failure, say),
there's nothing to undo.

### Restoring only part of it

- **Only the notes folder**, from an older copy: vihko notices the difference
  when it starts and saves it in the history as a new version (the log says
  `history sweep (startup): N changes`). The versions from after the copy are
  still in the history, so you can bring any note back from there.
- **Only the state volume**: people, keys and settings go back to the time of
  the copy; the notes don't.
- **No state volume at all** (lost, with the notes folder intact): vihko
  starts as new. Recreate each person with **Adopt their folder** in «Users
  and groups» (or `vihko user create <name> --adopt`): their `people/<name>/`
  becomes theirs again, as it is. Without it, a folder with something in it
  keeps its name from a new user.

### Retention and backups

With [retention](operations.md#retention) on, what leaves the trash or the
history is gone from vihko for good: **your backups are the only way
back**, so keep them for longer than the retention periods if you want that
way back. For instance, with the trash emptied after 30 days and backups kept
for 90, a note deleted by mistake can still be found in a backup for two more
months.

- A backup from before a run still holds what the run removed. Restoring it
  brings that back, and the next run removes it again unless you lengthen or
  turn off retention first.
- Restoring an older state volume doesn't touch the notes folder, and the
  other way round. Restore both, as above.
- The run rewrites `state/history.git/`. A copy taken while it runs can catch
  it half way: stop vihko, or use a snapshot, as described above. Avoid taking
  copies on Sundays at 03:00 server time, when it runs, if you copy with vihko
  running.

## Test your restore

A backup you've never restored is a hope. Once, and after any change to how you
back up, restore into a scratch folder and start a separate vihko on it, from
the folder of `compose.yaml`:

```sh
image=$(docker compose config --images vihko)
mkdir /tmp/vihko-restore-test && cd /tmp/vihko-restore-test
sudo tar -xzpf /backups/vihko-2026-10-01.tar.gz
docker run -d --name vihko-restore-test -p 127.0.0.1:8099:8080 \
  --user "$(stat -c %u:%g state)" \
  -v "$PWD/notes:/data/notes" -v "$PWD/state:/data/state" \
  "$image"
```

- `image`: the same image and tag as your `compose.yaml` uses, which
  `docker compose config --images vihko` prints (such as
  `ghcr.io/kirianm/vihko:0.1`). A newer version works too; an older one
  refuses a `state.db` that a newer one migrated.
- `--user`: the owner of the restored state folder, which is the user vihko
  ran as, `VIHKO_UID:VIHKO_GID` in your `.env`.

Open `http://127.0.0.1:8099` on the server (or through an SSH tunnel), sign in
with your usual account, open a few notes and their history. Then remove it:

```sh
docker rm -f vihko-restore-test
cd / && sudo rm -rf /tmp/vihko-restore-test
```

Never point the test copy at your real folders: it's a second vihko, and two
of them on the same notes would both write to them.
