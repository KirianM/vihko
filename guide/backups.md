# Backups

vihko keeps your data in two folders: the notes folder and the state volume.
Back up both. This guide says what's in each, how to take a copy that is
consistent, and how to restore it.

## What to back up

| What | Where | Why |
|---|---|---|
| **The notes folder** | `./notes` (`/data/notes`) | Your notes and their images: the source of truth. Includes `vihko.yaml`, the workspace configuration and its permissions. |
| **`state.db`** | `./state` (`/data/state`) | People, groups, passwords, sessions, invitations, API keys, OAuth clients, second factors and settings. It can't be rebuilt from the notes. |
| **The history** | `state/history.git/` and `state/history/` | Every version of every note, when vihko manages the history (the default). It doesn't travel with the notes folder: copying the notes doesn't copy their history. |
| **The trash** | `state/trash/` | Deleted notes and folders, which people can still restore. |
| **Recovery logs** | `state/collab/` | Typing not yet written to a note when vihko stopped. Usually empty after a clean stop. |
| **`vihko.yaml` copies** | `state/config-backups/` | The file as it was before an upgrade rewrote it. See [Upgrading](upgrading.md#what-happens-at-start). |
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
- **`vihko.lock`**: only there while vihko runs. Harmless either way.

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
every note, their whole history and `state.db`, with nothing of vihko's
permissions around them. Keep the copies somewhere else than the server:
another disk, another machine, or a backup service, just as private.

For a nightly backup, put those three lines in a script and run it from
`cron` or a systemd timer, at an hour nobody writes. Someone editing at that
moment sees «Offline · sent when reconnected» for a few seconds; the editor
sends what they typed once vihko is back (in the rare case it can't be merged,
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

### Restoring only part of it

- **Only the notes folder**, from an older copy: vihko notices the difference
  when it starts and saves it in the history as a new version (the log says
  `history sweep (enabled): N changes`). The versions from after the copy are
  still in the history, so you can bring any note back from there.
- **Only the state volume**: people, keys and settings go back to the time of
  the copy; the notes don't.

## Test your restore

A backup you've never restored is a hope. Once, and after any change to how you
back up, restore into a scratch folder and start a separate vihko on it:

```sh
mkdir /tmp/vihko-restore-test && cd /tmp/vihko-restore-test
sudo tar -xzpf /backups/vihko-2026-10-01.tar.gz
docker run -d --name vihko-restore-test -p 127.0.0.1:8099:8080 \
  --user "$(stat -c %u:%g state)" \
  -v "$PWD/notes:/data/notes" -v "$PWD/state:/data/state" \
  ghcr.io/kirianm/vihko:1
```

(`--user`: the owner of the restored state folder, which is the user vihko ran
as, `VIHKO_UID:VIHKO_GID` in your `.env`.)

Open `http://127.0.0.1:8099` on the server (or through an SSH tunnel), sign in
with your usual account, open a few notes and their history. Then remove it:

```sh
docker rm -f vihko-restore-test
cd / && sudo rm -rf /tmp/vihko-restore-test
```

Never point the test copy at your real folders: it's a second vihko, and two
of them on the same notes would both write to them.
