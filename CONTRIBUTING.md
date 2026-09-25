# Contribuir

## Licencia y DCO

thoth se publica bajo [AGPL-3.0](LICENSE). No hay CLA: no se cede ningún
derecho. A cambio, cada commit tiene que llevar la firma del
[Developer Certificate of Origin](https://developercertificate.org/), que
certifica que tienes derecho a aportar ese código bajo la licencia del
proyecto:

```
Signed-off-by: Nombre Apellido <correo@ejemplo.org>
```

`git commit -s` la añade automáticamente. El CI rechaza las pull requests con
commits sin firmar.

## Antes de proponer cambios

Lee `docs/vision.md` y `docs/decisiones.md`. Buena parte de lo que parece una
mejora obvia ya se descartó por una razón concreta.

## Entorno

- Node 26 (`.nvmrc`; LTS desde el 2026-10-28). El código TypeScript se ejecuta directamente con
  Node, sin paso de compilación: solo sintaxis que se pueda borrar (nada de
  `enum` ni `namespace`).
- `npm ci`, `npm run typecheck`, `npm run build` (UI), `npm test`.
- UI en desarrollo: el servidor en una terminal
  (`THOTH_NOTES_DIR=… THOTH_STATE_DIR=… packages/server/src/cli.ts serve`)
  y `npm run dev -w @thoth/web` en otra; Vite reenvía `/api` y `/collab` al
  puerto 8080 (`THOTH_DEV_SERVER` para otro).
- Pruebas de navegador (`packages/web/e2e`, Playwright): `npm run build` y
  `npm run e2e -w @thoth/web`, que arranca un servidor con una copia de
  `testdata/vault` y dos usuarios. Si tu máquina no puede ejecutar Chromium, deja
  el servidor en el host (`npm run e2e:serve -w @thoth/web`) y lanza el navegador
  en la imagen oficial, con la misma versión que `@playwright/test`:

  ```sh
  docker run --rm --network host --user $(id -u):$(id -g) -e HOME=/tmp \
    -e E2E_BASE_URL=http://127.0.0.1:8094 -v "$PWD:$PWD" -w "$PWD/packages/web" \
    mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test
  ```

## Commits

- Un cambio lógico por commit.
- Mensajes, títulos y descripciones de PR en inglés.
