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

- Node 24 LTS (`.nvmrc`). El código TypeScript se ejecuta directamente con
  Node, sin paso de compilación: solo sintaxis que se pueda borrar (nada de
  `enum` ni `namespace`).
- `npm ci`, `npm run typecheck`, `npm test`.

## Commits

- Un cambio lógico por commit.
- Mensajes, títulos y descripciones de PR en inglés.
