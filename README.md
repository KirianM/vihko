# thoth

> Nombre provisional. Thoth: escriba, conocimiento y escritura.

Sistema de notas self-hosted y open source sobre archivos Markdown, con UI web
propia, multiusuario, e índice en el servidor consultable desde la UI y,
opcionalmente, desde API, MCP y webhooks.

Tus notas siguen siendo una carpeta de `.md`. Si thoth desaparece, no pierdes
nada.

## El problema que resuelve

Los proyectos existentes fallan todos en el mismo punto, por la misma tensión:

- **Archivos como fuente de verdad** → el servidor no sabe nada y el índice
  acaba en el cliente. Es el caso de SilverBullet, que necesita un Chromium
  headless en el servidor para exponer sus consultas por API.
- **Base de datos como fuente de verdad** → ganas consultas, relaciones,
  permisos y versionado, y pierdes portabilidad y editores intercambiables.
  Trilium, Outline, Docmost, Kival.

thoth elige un tercer punto: **archivos como fuente de verdad + índice en el
servidor**, renunciando al offline completo. Ver `docs/decisiones.md`.

## Qué es y qué no

- Un sistema de notas completo por sí mismo, con UI web propia.
- API, MCP y webhooks integrados pero **opcionales y desactivados por
  defecto**. Sin activarlos, nada entra ni sale salvo por el usuario.
- Pensado para que lo autoaloje cualquiera con Docker, sin reverse proxy,
  Postgres ni proveedor de identidad obligatorios.
- Sin telemetría, sin autoactualización, sin funciones detrás de una versión
  de pago.

## Qué hay aquí

| Documento | Contenido |
|---|---|
| `CLAUDE.md` | Contexto para agentes que trabajen en el repo |

## Estado

Diseño cerrado; implementación por empezar (M1). Repositorio privado hasta la
v1.0 (M5).

## Licencia

[AGPL-3.0](LICENSE). Contribuciones con DCO (`Signed-off-by`), sin CLA. Ver
`docs/decisiones.md` (D-020).

## Stack

TypeScript en servidor y UI, sobre Node LTS: Yjs + Hocuspocus para la
colaboración, CodeMirror 6 como editor, SQLite (`better-sqlite3`, FTS5,
`sqlite-vec`) para el índice y el SDK oficial de MCP. Ver `docs/decisiones.md`
(D-021).
