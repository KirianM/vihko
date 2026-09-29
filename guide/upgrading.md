# Upgrading

How vihko's versions work, how to update, and how to go back if an update goes
wrong.

## What a version number promises

vihko follows [semantic versioning](https://semver.org). The major version
(the `1` in `1.4.2`) goes up for any change that makes you do something by
hand, or that breaks something built on vihko, in any of these:

- `vihko.yaml`, the workspace configuration;
- the HTTP API;
- the MCP tools;
- what vihko writes into your notes (the `uid` in the frontmatter, comments,
  attachments);
- the Docker interface: the volumes, the environment variables and the port.

Within a major version, updates only add or fix things. When something in that
list has to change, the old form keeps working, with a deprecation warning,
until the next major version.

Two things are outside the promise:

- **The web UI** can change in any release.
- **The inside of `state.db`**: vihko migrates it on its own when it starts
  (see [What happens at start](#what-happens-at-start)).

## Which image tag to use

| Tag | Use it when |
|---|---|
| `ghcr.io/kirianm/vihko:1` | Recommended. Every 1.x release, never 2.0. |
| `ghcr.io/kirianm/vihko:1.4` | You want fixes only, no new features. |
| `ghcr.io/kirianm/vihko:1.4.2` | You want to choose each update yourself, or to [roll back](#rolling-back). |
| `ghcr.io/kirianm/vihko:latest` | Don't. It jumps to a new major version on a `docker compose pull`, and a major version can need you to do something first. |
| `ghcr.io/kirianm/vihko:1.1.0-rc.1` | Testing a release candidate. Candidates are only published under their exact tag; `1` and `latest` never point to one. |

A moving tag (`1`, `1.4`, `latest`) only goes forward: a fix published for an
older line doesn't move it back.

## How to update

1. **Note the version you run now**, in case you need to come back:

   ```sh
   docker compose exec vihko vihko version
   ```

2. **Read what changed**: the release notes on
   [GitHub Releases](https://github.com/KirianM/vihko/releases), the same text
   as [CHANGELOG.md](../CHANGELOG.md). Its *Upgrade notes* list anything to do
   by hand and anything deprecated. Always read them before a new major
   version.

3. **Back up** the notes folder and the state volume: see
   [Backups](backups.md). A copy made just before the update is the surest
   way back.

4. **Update**, from the folder of `compose.yaml`:

   ```sh
   docker compose pull
   docker compose up -d
   ```

   `pull` fetches the newest image for your tag; `up -d` recreates the
   container only if the image changed. Your folders aren't touched.

5. **Read the log** and check that it starts with the new version and ends with
   `listening on`:

   ```sh
   docker compose logs --tail 20 vihko
   ```

To move to a new major version, change the tag in `compose.yaml` (from `:1` to
`:2`) after reading its upgrade notes, then run step 4.

From a release candidate, change the tag to the next candidate, or to the
moving tag of its line (such as `:1`) once its release is out.

## What happens at start

When a new version starts for the first time, it brings your data up to date
before it serves anything:

- **`state.db` migrates** if the new version changed its tables. First vihko
  copies it to `state.db.bak-v<N>` in the state volume, where `<N>` is the
  schema version it had. Then it applies the changes in one transaction: if
  anything fails, `state.db` stays as it was and vihko doesn't start. Migrations
  only go forward. The copies are never deleted by vihko: remove old ones
  yourself once you're happy with an update.

- **`vihko.yaml` is rewritten** if the new version changed how something is
  written in it. Only what changed is rewritten; comments, key order and keys
  vihko doesn't know stay as they were. The file as it was is copied first to
  the state volume, `config-backups/vihko.yaml.<date and time>` (vihko keeps
  the latest 10 copies there, never in the notes folder). Each rewrite is
  logged (`vihko.yaml rewritten to the current format: …`) and shown to the
  admins in the workspace alerts until one dismisses it. A file that isn't
  valid YAML, or that can't be written, is left alone and the alert says so;
  the next start tries again. vihko only does this at start, never while it
  runs.

- **The index rebuilds** if the new version changed it. vihko scans the whole
  notes folder before it listens; with many notes this takes a little while.
  The log line `index ready: …` marks the end.

Nothing else changes: your notes, the history and the trash stay as they are.

## Rolling back

If an update goes wrong, go back to the previous version and the `state.db` it
had. The migration copy makes that possible.

What you lose: **everything saved in `state.db` since the update**, such as
people or groups added, passwords changed, invitations, API keys and OAuth
authorizations, second factors set up, settings changed and sessions started
(people may have to sign in again). Your notes are files, and aren't rolled
back. Versions saved in the history since the update stay.

An older vihko refuses to start with a newer `state.db`, and restarts in a
loop with:

```text
Error: state.db is at version 9, newer than this install (8). Did you roll back to an older version of vihko?
```

To go back:

1. **Stop vihko**:

   ```sh
   docker compose down
   ```

2. **Find the copy the update made.** It's the newest `state.db.bak-v*`, dated
   at the moment of the update:

   ```sh
   ls -l state/state.db.bak-v*
   ```

   If the update made no new copy, `state.db` didn't change: skip to step 5.
   vihko keeps the state folder closed to every user but its own: if that
   isn't yours, put `sudo` in front of this step's and the next ones'
   commands.

3. **Put the copy back**, keeping the newer database aside:

   ```sh
   mv state/state.db state/state.db.newer
   rm -f state/state.db-wal state/state.db-shm
   cp -p state/state.db.bak-v8 state/state.db
   ```

   (Use the copy you found in step 2; `-p` keeps its owner.)

4. **If the update rewrote `vihko.yaml`** (the log said so, or there's a new
   file in `state/config-backups/`), put back the copy made at the update:

   ```sh
   ls -l state/config-backups/
   cp state/config-backups/vihko.yaml.2026-11-02T09-15-00.000Z notes/vihko.yaml
   ```

   Compare the two files first: changes made to `vihko.yaml` after the update,
   such as permissions changed from the UI, are only in the current file.

5. **Pin the previous version** in `compose.yaml`, the one you noted before
   updating:

   ```yaml
       image: ghcr.io/kirianm/vihko:1.3.2
   ```

6. **Start it** and read the log:

   ```sh
   docker compose up -d
   docker compose logs --tail 20 vihko
   ```

   The index rebuilds on its own if the versions differ.

Stay on the pinned tag until a fixed release is out, then go back to `:1` and
update as usual. If the update broke something, please
[open an issue](https://github.com/KirianM/vihko/issues).

If you don't have the migration copy (you deleted it, or you're going back
more than one update), restore `state.db` from a [backup](backups.md) taken
before the update instead.
