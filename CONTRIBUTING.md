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

## Conventions

- Everything in the code is in English: identifiers, comments, test names, log
  messages and error hints. User-facing text lives in
  `packages/web/src/i18n.tsx` (English and Spanish); the server returns error
  and alert codes, never prose for the UI.
- One logical change per commit; commit messages and pull requests in English.
