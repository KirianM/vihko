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

CI runs both on every pull request. Before closing a milestone, run them on a
real machine with more rounds and write the numbers down:
`ACCEPTANCE_ROUNDS=20 ACCEPTANCE_REPORT=acceptance.jsonl npm run acceptance`.
Other variables: `ACCEPTANCE_NOTES`, `ACCEPTANCE_SEED`, `ACCEPTANCE_DIR`
(where the notes go, e.g. an NFS mount, to measure it), `ACCEPTANCE_STATE_DIR`
(always local disk), `ACCEPTANCE_DOCKER=0`, `ACCEPTANCE_DOCKER_ROUNDS` and
`ACCEPTANCE_KEEP` (leave the folders behind).

## Conventions

- Everything in the code is in English: identifiers, comments, test names, log
  messages and error hints. User-facing text lives in
  `packages/web/src/i18n.tsx` (English and Spanish); the server returns error
  and alert codes, never prose for the UI.
- One logical change per commit; commit messages and pull requests in English.
