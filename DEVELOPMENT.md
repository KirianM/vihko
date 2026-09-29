# Development

How to build, test and release vihko: for whoever works on it, and for anyone
running their own fork (it's AGPL-3.0). To report a bug or suggest something,
see [CONTRIBUTING.md](CONTRIBUTING.md).

## Setting up

- Node 26 (`.nvmrc`). TypeScript runs directly on Node with no build step for
  the server: only erasable syntax (no `enum`, `namespace` or parameter
  properties).
- `npm ci`, `npm run typecheck`, `npm run build` (UI), `npm test`.
- Dependencies' install scripts run only when `allowScripts` in the root
  `package.json` approves them by name (today, `better-sqlite3`'s build).
  `.npmrc` sets `strict-allow-scripts`, so a new one fails the install
  (`ESTRICTALLOWSCRIPTS`) instead of running with a warning. Read the script
  before approving it (`true`) or denying it (`false`) there.
- UI development: run the server in one terminal
  (`VIHKO_NOTES_DIR=… VIHKO_STATE_DIR=… packages/server/src/cli.ts serve`)
  and `npm run dev -w @vihko/web` in another; Vite forwards `/api` and
  `/collab` to port 8080 (`VIHKO_DEV_SERVER` for another one).
- The image from your checkout: `compose.yaml` pulls the published one
  (from `ghcr.io/kirianm/vihko`); `compose.dev.yaml`, on top of it, builds
  `vihko:local` from the checkout instead:
  `docker compose -f compose.yaml -f compose.dev.yaml up -d --build`.
- Browser tests (`packages/web/e2e`, Playwright): `npm run build` and
  `npm run e2e -w @vihko/web`, which starts a server with a copy of
  `testdata/vault` and two users. If your machine cannot run Chromium, keep the
  server on the host (`npm run e2e:serve -w @vihko/web`) and run the browser in
  the official image, with the same version as `@playwright/test`:

  ```sh
  docker run --rm --network host --user $(id -u):$(id -g) -e HOME=/tmp \
    -e E2E_BASE_URL=http://127.0.0.1:8094 -v "$PWD:$PWD" -w "$PWD/packages/web" \
    mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test
  ```

  Ports: `E2E_PORT` (8094), the locked server `E2E_LOCKED_PORT` (`E2E_PORT`
  + 2), the images spec's external server `E2E_EXTERNAL_PORT` (8132) and the
  browser acceptance server `ACC_PORT` (8095).

  Every spec runs on that one server, one after another, so a spec never
  depends on another one: grants beyond the baseline (the admin manages the
  root, the member edits it: `ADMIN` and `MEMBER` of `e2e/env.ts`) go through
  `usePermissions()` of `e2e/helpers.ts`, which waits until vihko has read
  them and is called again at the end to put the baseline back; a spec's own
  values come from `specMother(import.meta.url)` of `e2e/env.ts` (a deleted
  user's name stays reserved, and a retry, in a new worker, draws other ones);
  and lists other specs add to (users, keys, groups) are checked for what the
  spec made, never as a whole.

## Test data

Tests don't hard-code people, credentials or incidental content: they ask
the object mother, `test/mother.ts`, for them (`const m =
mother(import.meta.url)`, then `m.aUser({ role: 'admin' })`, `m.aPassword()`,
`m.aGroupName()`, `m.aNotePath(m.aFolder())`, `m.aTag()`, `m.aSentence()`…).
Its values are invented with [faker](https://fakerjs.dev) (a development
dependency only), Spanish-flavoured so accents and «ñ» show up, and follow
vihko's rules for their kind: a username matches vihko's pattern and is unique
under vihko's comparison, a password is long enough, a note path is valid.
Tests speak of roles ("the admin", "a member") and build their expectations
from the values they were given. A literal stays only where it is the case
under test (a parser edge case, Unicode folding, a format's test vector) or
in an integration test on the fixed vault (`testdata/vault`), with a comment
saying why.

The values change on every run, from one seed per run: `VIHKO_TEST_SEED`, or
a random one. `npm test`, `npm run acceptance`, the Playwright suites and
their servers, and every job of `npm run ci` print it and hand the same seed
to every test process, so the same seed gives the same values. To reproduce
a failure, run again with the seed it printed:

```sh
VIHKO_TEST_SEED=1234567 npm test -- packages/server/test/users.test.ts
VIHKO_TEST_SEED=1234567 npm run ci -- --jobs e2e --grep 'users\.spec'
```

Each file draws from its own stream (the seed and the file's path), so a file
run alone gets the values it got in the full run (the whole file: with
`--test-name-pattern` the tests left out draw nothing, and the rest may get
other values). A test that fails with some
seeds only has a hidden assumption about its data: fix the test (or vihko),
never pin the seed. A browser server started by hand writes its seed next to
its data (`.data/e2e/seed`), and Playwright pointed at it with `E2E_BASE_URL`
reads it when `VIHKO_TEST_SEED` isn't set.

## Acceptance

The milestone's «Done when» as tests, over a generated vault of 1,000
realistic notes (seeded, with `testdata/vault` inside as the edge cases;
`node packages/server/test/acceptance/_vault.ts <dir>` writes one):

- `npm run acceptance` (`packages/server/test/acceptance`): cold and warm
  start, memory, search latency and correctness, opening notes; renaming
  heavily linked notes with every link of the vault compared before and after;
  changes made with another editor reaching open editors; deleting `index.db`
  and comparing the rebuilt dump; kill -9 rounds while two people type and an
  agent edits; the unmanaged history over the vault as its own git repository
  (`ACCEPTANCE_GIT_COMMITS` commits, 2,000 by default), which must stay byte
  for byte the same; and the same startup, search and kill -9 against the
  Docker image with `compose.yaml` (skipped without Docker; builds
  `vihko:acceptance` unless `ACCEPTANCE_IMAGE` names an image). It prints the
  numbers.
- `npm run acceptance:ui -w @vihko/web` (after `npm run build`): search, edit,
  a change from another editor and a rename from the UI, in a browser. Without
  Chromium on the machine, as with `e2e`: `npm run acceptance:serve -w
  @vihko/web` and the Playwright image with `ACC_BASE_URL`.

CI runs both on every pull request (see below). Before closing a milestone,
run them on a real machine with more rounds and write the numbers down:
`ACCEPTANCE_ROUNDS=20 ACCEPTANCE_REPORT=acceptance.jsonl npm run acceptance`.
Other variables: `ACCEPTANCE_NOTES`, `ACCEPTANCE_SEED`, `ACCEPTANCE_DIR`
(where the notes go, e.g. an NFS mount, to measure it), `ACCEPTANCE_STATE_DIR`
(always local disk), `ACCEPTANCE_DOCKER=0`, `ACCEPTANCE_DOCKER_ROUNDS` and
`ACCEPTANCE_KEEP` (leave the folders behind).

## CI

GitHub Actions runs `.github/workflows/ci.yml` on every pull request, and its
four checks are the ones `main` requires. `npm run ci` runs the same four jobs
on your own machine: to reproduce a failure with its seed, or to check a
branch before pushing it; with `--post` it reports the result on the commit as
the `ci/local` status. (Until the repository went public, with `v1.0.0-rc.1`,
the CI ran only this way, to save Actions minutes.)

```sh
npm run ci                        # the last commit of this checkout
npm run ci -- --pr 72             # pull request 72 merged onto its base, as GitHub tests it
npm run ci -- --pr 72 --post      # …and pending, then success or failure, as ci/local on its head commit
npm run ci -- --pr 72 --trust     # a pull request whose author has no write access (read it first)
npm run ci -- --ref origin/main   # a commit (after git fetch, the latest main)
npm run ci -- --jobs check,e2e    # some jobs only
npm run ci -- --jobs e2e --grep 'two-factor\.spec'   # only the tests matching a pattern
npm run ci -- --parallel          # the jobs at the same time (faster, see below)
npm run ci -- --keep              # keep the run's folder to debug
npm run ci -- --clean             # remove the folders and logs of earlier runs (not the npm cache)
```

- **check**: `npm ci`, typecheck, build, `npm test`.
- **acceptance**: `npm run acceptance` with `ACCEPTANCE_DOCKER=0`.
- **docker**: builds the image (`vihko-ci:<run>`), starts it, waits for its
  `HEALTHCHECK` and checks it serves the UI, then the Docker acceptance with
  `ACCEPTANCE_IMAGE`.
- **e2e**: `npm run e2e` and `npm run acceptance:ui` of `@vihko/web`, with the
  servers on the host and the browser in the Playwright image of the installed
  `@playwright/test` (`--network host`).

A pull request's code (its tests, npm scripts and Dockerfile) runs on the
machine as whoever runs the CI. So `--pr` first asks GitHub, through `gh`,
whether the pull request's author has write access to the repository (admin,
maintain or write: someone who could push that code anyway); if not, or if
GitHub can't say (an app such as Dependabot, an error), the run is refused
before anything is fetched, saying why. `--trust` runs it anyway: use it only
after reading the changes. Then, for every target, the code under test gets a
minimal environment: the locale, `TZ`, `DOCKER_HOST`, proxy and CA variables,
and nothing else of yours (no `GH_TOKEN` or `GITHUB_TOKEN`, no SSH agent, no
`XDG_RUNTIME_DIR`), with a home folder of its own in the run's folder, so your
`gh`, SSH, npm and Docker credentials are not found by default. npm's cache is
one shared by the runs (`npm-cache` in `VIHKO_CI_DIR`, kept by `--clean`).
Fetching the pull request and `--post` use your credentials, in the script's
own process, never in the code under test. The Playwright container gets only
the run's folder and the variables it needs. This is not a sandbox: the code
still runs as your user and can use Docker, so the author check is what
protects you.

To run again only what failed, a failed run prints the command: the same
target, the failed jobs and, for browser tests, `--grep` with their spec
files. `--grep` is a regular expression; Playwright matches it against the
file name and the titles, `node --test` against the test names only
(`--test-name-pattern`), and a browser suite none of whose tests match is
skipped, server included. A run with `--jobs` or `--grep` is not the CI: with
`--post` it reports as `ci/local-partial`, never as `ci/local`, so a pull
request is still merged only on a full run.

A browser test that fails runs once more, with a Playwright trace (traces are
recorded only then: recording every test slowed them all and could fail a
passing test at its teardown). If it passes then, it is flaky: the job passes,
but its line, the summary and the posted status name it. A flaky test is a bug
to look at, in the test or in vihko, not noise.

Each run works in its own folder on local disk (`/var/tmp/vihko-ci/<run>`, or
`VIHKO_CI_DIR`; never NFS, and not a tmpfs `/tmp`): a git worktree of the
commit (with `--pr`, the pull request's head merged onto its base, fetched
first; a conflict fails the run), its own `TMPDIR`, home folder and test data. It never
writes into your checkout. It picks free ports of its own, and names its
containers and image after itself, so runs, agents and other services on the
machine don't collide. The dependencies are installed and the UI built once,
in a `setup` stage every job starts from.

Each job has the workflow's `timeout-minutes`: a hang is a failure that names
the step. Its output goes to `logs/<job>.log` in the run's folder; the summary
prints OK or FAILED with the time of each job, and the log of the one that
failed (for e2e, also Playwright's report and traces). Whatever happens, a
failure, a timeout or Ctrl-C, the run stops its processes (by their working
directory, since killing `npm run` leaves its grandchildren alive), removes its
containers, networks, image and worktree, and keeps only the logs (for 7 days).
`--keep` keeps the folder, never the processes. A run killed outright is
cleaned up by the next one.

The jobs run one after another. On the 6-CPU machine the CI runs on, a full
run takes about 14 minutes: setup 5 s, check 2m45s, acceptance 1m55s, docker
30 s (with the image layers cached) and e2e 8m30s; `--jobs e2e --grep` with one
spec file, one or two. `--parallel` runs them at the
same time in about 8 minutes, but the load is theirs: in one of three such runs
a unit test that depends on two writes landing within 150 ms failed, which
never happened one after another. The acceptance has time thresholds and the
browser tests are sensitive to load too; a CI that fails from its own load is
worse than a slower one.

## Releasing

A release is a tag on `main`: `vX.Y.Z`, or `vX.Y.Z-rc.N` for a release
candidate. Pushing it runs `.github/workflows/release.yml`, which checks the
tag (it matches the root `package.json`'s version, and `CHANGELOG.md` has a
section for it) before pushing anything, builds the image for linux/amd64 and
linux/arm64 and pushes it to GHCR, and then makes the GitHub Release, whose
text is that `CHANGELOG.md` section.

| Tag | Image tags (`ghcr.io/kirianm/vihko:…`) | GitHub Release |
|---|---|---|
| `v1.2.3` | `1.2.3`, `1.2`, `1`, `latest` | a release, the latest |
| `v1.0.0-rc.1` (any `-…`) | `1.0.0-rc.1` only | a pre-release |

A moving tag only goes forward: a fix for an older line (`v1.1.5` once
`v1.2.0` is out, tagged on a branch of its own) gets `1.1.5` and `1.1`, not
`1` or `latest`, and isn't marked as the latest Release.

1. On a branch, set the new version in the root `package.json`, every
   workspace package and `package-lock.json` (a test checks they agree):
   `npm version 1.2.3 --no-git-tag-version --workspaces --include-workspace-root`.
2. Write the version's section at the top of `CHANGELOG.md` ([Keep a
   Changelog](https://keepachangelog.com/en/1.1.0/)), under a heading
   `## [1.2.3] - YYYY-MM-DD`: what changed for whoever installs vihko, from the
   pull requests merged since the last tag, with an "Upgrade notes" part for
   anything to do by hand and anything deprecated. The Release shows it as it
   is.
3. Open the pull request, run the CI and merge it.
4. Tag the merge commit and push the tag:

   ```sh
   git switch main && git pull --ff-only
   git tag -a v1.2.3 -m 'vihko 1.2.3'
   git push origin v1.2.3
   ```

5. Follow the run (`gh run watch`, or the Actions tab). The image job waits in
   the `release` environment until the maintainer approves it on the run's
   page: nothing is published before that. If the check job
   fails, nothing was published: delete the tag (`git push --delete origin
   v1.2.3`, `git tag -d v1.2.3`), fix it in a pull request and tag again. If a
   later job fails, run it again from the Actions tab.
6. Check the result: `docker buildx imagetools inspect
   ghcr.io/kirianm/vihko:1.2.3` lists linux/amd64 and linux/arm64, the moving
   tags have the same digest, the image pulls without logging in (`docker
   logout ghcr.io` first), and the Release (or pre-release) has the
   changelog's text. The first time only: the package's settings on GitHub
   (the repository's Packages) must say it is public and linked to the
   repository; a package doesn't take its visibility from the repository.
7. `compose.yaml` pulls what a new installation should get: the exact tag
   while there are only release candidates of a major, `:<major>` once its
   first stable version is out. Change its image line (and its copy in
   `guide/install.md`) in the release pull request that makes that change.

## Screenshots

The README's screenshots (`.github/assets/screenshots/`) come from a script,
so they can be made again whenever the UI changes. Before a release, run it
and commit the new pictures if they changed:

```sh
npm run screenshots
```

It builds the UI, starts a fresh vihko on a copy of the demo workspace in
`scripts/screenshots/vault` (plain Markdown; the note shown is
`handbook/Welcome.md`), with two people and a comment thread, and takes the
pictures with Chromium from the Playwright image of the installed
`@playwright/test` (Docker required, as for the browser tests): the desktop in
light and dark (1440×900 at 2×) and the phone (390×844 at 3×). The split
`desktop.png` and the side-by-side `mobile.png` are composed in that same
browser. vihko listens on port 4630 (`SCREENSHOTS_PORT`) and the browser on
the next one; everything else lives in a temporary folder, removed at the end.
To change what the pictures show, change the demo notes, not the pictures.

## Conventions

- Everything in the code is in English: identifiers, comments, test names, log
  messages and error hints. User-facing text lives in
  `packages/web/src/i18n.tsx` (English and Spanish); the server returns error
  and alert codes, never prose for the UI.
- One logical change per commit; commit messages and pull requests in English.
