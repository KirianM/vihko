# Contributing

## Pull requests

thoth is not accepting external pull requests for now. Issues are welcome:
bug reports, questions and ideas.

## Development

- Node 26 (`.nvmrc`). TypeScript runs directly on Node with no build step for
  the server: only erasable syntax (no `enum`, `namespace` or parameter
  properties).
- `npm ci`, `npm run typecheck`, `npm run build` (UI), `npm test`.
- UI development: run the server in one terminal
  (`THOTH_NOTES_DIR=… THOTH_STATE_DIR=… packages/server/src/cli.ts serve`)
  and `npm run dev -w @thoth/web` in another; Vite forwards `/api` and
  `/collab` to port 8080 (`THOTH_DEV_SERVER` for another one).
- Browser tests (`packages/web/e2e`, Playwright): `npm run build` and
  `npm run e2e -w @thoth/web`, which starts a server with a copy of
  `testdata/vault` and two users. If your machine cannot run Chromium, keep the
  server on the host (`npm run e2e:serve -w @thoth/web`) and run the browser in
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
  depends on another one: grants beyond the baseline (noa manages the root,
  ana edits it) go through `usePermissions()` of `e2e/helpers.ts`, which
  waits until thoth has read them and is called again at the end to put the
  baseline back; people and groups a spec creates are named with `unique()` of
  `e2e/env.ts` (a deleted user's name stays reserved, and a retry runs on the
  same server); and lists other specs add to (users, keys, groups) are checked
  for what the spec made, never as a whole.

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
  `thoth:acceptance` unless `ACCEPTANCE_IMAGE` names an image). It prints the
  numbers.
- `npm run acceptance:ui -w @thoth/web` (after `npm run build`): search, edit,
  a change from another editor and a rename from the UI, in a browser. Without
  Chromium on the machine, as with `e2e`: `npm run acceptance:serve -w
  @thoth/web` and the Playwright image with `ACC_BASE_URL`.

CI runs both on every pull request (see below). Before closing a milestone,
run them on a real machine with more rounds and write the numbers down:
`ACCEPTANCE_ROUNDS=20 ACCEPTANCE_REPORT=acceptance.jsonl npm run acceptance`.
Other variables: `ACCEPTANCE_NOTES`, `ACCEPTANCE_SEED`, `ACCEPTANCE_DIR`
(where the notes go, e.g. an NFS mount, to measure it), `ACCEPTANCE_STATE_DIR`
(always local disk), `ACCEPTANCE_DOCKER=0`, `ACCEPTANCE_DOCKER_ROUNDS` and
`ACCEPTANCE_KEEP` (leave the folders behind).

## CI

The CI runs on a machine of the maintainer, not on GitHub: `npm run ci` runs
the four jobs of `.github/workflows/ci.yml` and reports the result on the
commit as the `ci/local` status, which costs no GitHub Actions minutes. GitHub
Actions runs the workflow only for Dependabot's pull requests (nobody runs
those locally) and when started by hand.

```sh
npm run ci                        # the last commit of this checkout
npm run ci -- --pr 72             # pull request 72 merged onto its base, as GitHub tests it
npm run ci -- --pr 72 --post      # …and pending, then success or failure, as ci/local on its head commit
npm run ci -- --ref origin/main   # a commit (after git fetch, the latest main)
npm run ci -- --jobs check,e2e    # some jobs only
npm run ci -- --jobs e2e --grep 'two-factor\.spec'   # only the tests matching a pattern
npm run ci -- --parallel          # the jobs at the same time (faster, see below)
npm run ci -- --keep              # keep the run's folder to debug
npm run ci -- --clean             # remove the folders and logs of earlier runs
```

- **check**: `npm ci`, typecheck, build, `npm test`.
- **acceptance**: `npm run acceptance` with `ACCEPTANCE_DOCKER=0`.
- **docker**: builds the image (`thoth-ci:<run>`), starts it, waits for its
  `HEALTHCHECK` and checks it serves the UI, then the Docker acceptance with
  `ACCEPTANCE_IMAGE`.
- **e2e**: `npm run e2e` and `npm run acceptance:ui` of `@thoth/web`, with the
  servers on the host and the browser in the Playwright image of the installed
  `@playwright/test` (`--network host`).

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
to look at, in the test or in thoth, not noise.

Each run works in its own folder on local disk (`/var/tmp/thoth-ci/<run>`, or
`THOTH_CI_DIR`; never NFS, and not a tmpfs `/tmp`): a git worktree of the
commit (with `--pr`, the pull request's head merged onto its base, fetched
first; a conflict fails the run), its own `TMPDIR` and test data. It never
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

## Conventions

- Everything in the code is in English: identifiers, comments, test names, log
  messages and error hints. User-facing text lives in
  `packages/web/src/i18n.tsx` (English and Spanish); the server returns error
  and alert codes, never prose for the UI.
- One logical change per commit; commit messages and pull requests in English.
