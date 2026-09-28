# Edge-case vault

`vault/` gathers the hard cases found while studying other notes tools. The
tests for the indexer, link resolution and writes use it as input. When a case
is added, document its expected behaviour here.

Bytes matter: `recetas/Café.md` is NFD, `frontmatter/bom-crlf.md` has a BOM and
CRLF line endings, `frontmatter/vacia.md` has 0 bytes. Don't edit these files
with an editor that normalises them.

## Link resolution

| From | Link | Expected |
|---|---|---|
| `proyectos/vihko/notas.md` | `[[Plan]]`, `[[plan]]`, `[[Plan\|el plan]]` | `proyectos/vihko/Plan.md` (same folder; case-insensitive) |
| `proyectos/vihko/notas.md` | `![[Plan]]` | Same: the embed is indexed as a link (rendering it is out of scope) |
| `proyectos/vihko/notas.md` | `[[notas]]` | Resolves to itself |
| `diario/2026-09-24.md` | `[[Plan]]` | `Plan.md`: all three candidates share the root, and the root one is 0 levels below it versus 2 |
| `diario/2026-09-24.md` | `[[Tareas]]` | **Ambiguous** with two candidates at the same distance: `proyectos/vihko/Tareas.md` and `proyectos/blog/Tareas.md` |
| `diario/2026-09-24.md` | `[[proyectos/blog/Plan]]`, `[[blog/Plan]]` | `proyectos/blog/Plan.md` (path and path suffix) |
| `recetas/índice.md` | `[[Café]]`, `[[CAFÉ]]` | `recetas/Café.md`, whose name is NFD |
| `recetas/índice.md` | `[[Notas de reunión (2026)]]` | `recetas/Notas de reunión (2026).md` |
| `hogar/enlaces.md` | `[[gw]]` | `hogar/Proxy.md` by alias |
| `hogar/enlaces.md` | `[[Red]]` | `hogar/Red.md`: the name wins over `Firewall.md`'s `Red` alias |
| `hogar/enlaces.md` | `[[Proxy#Red]]` | Resolved, existing anchor |
| `hogar/enlaces.md` | `[[Proxy#No existe]]` | Resolved with a **broken anchor** |
| `hogar/enlaces.md` | `[[Nota que no existe]]` | **Broken**; the literal text is kept |
| `hogar/enlaces.md` | `[…](Proxy.md)`, `[…](../proyectos/vihko/Plan.md)` | Resolved (relative Markdown links) |
| `hogar/enlaces.md` | `[roto](no-existe.md)` | Broken |
| `hogar/enlaces.md` | `[externo](https://example.com/#ancla)` | External link: neither a note link nor a tag |
| `codigo.md` | Everything in inline code, fenced or indented blocks | Neither links nor tags. Outside code, `[[Plan]]` resolves to `Plan.md` (same folder) and `#hogar` is a tag |
| `frontmatter/sin-frontmatter.md`, `frontmatter/bom-crlf.md` | `[[Plan]]` | `Plan.md` (the shallowest under the common root) |

## Tags

| File | Expected |
|---|---|
| `tags.md` | Tags: `hogar` (frontmatter; `#hogar` and `#Hogar` are the same), `proyectos` (frontmatter, lowercased), `hogar/red` (nested) |
| `tags.md` | `#123` is not a tag. `# Título` is a heading, not a tag |
| `codigo.md` | `#notag` and `#tampoco` are not tags |

## Frontmatter

| File | Expected |
|---|---|
| `frontmatter/exotico.md` | Comments, flow list, quotes, multi-line text, YAML anchors and unknown keys. Adding `uid` with a textual patch leaves **every other byte intact** |
| `frontmatter/invalido.md` | `frontmatter_error`. Indexed as body, treated as the most restricted note, and vihko **never** writes to it |
| `frontmatter/sin-frontmatter.md` | Valid note without metadata. Adding `uid` creates the block without touching the body |
| `frontmatter/solo-frontmatter.md` | Valid note with an empty body |
| `frontmatter/vacia.md` | Valid empty note (0 bytes) |
| `frontmatter/bom-crlf.md` | The BOM doesn't prevent detecting the frontmatter. A patch keeps the BOM and CRLF |

## Identity

| File | Expected |
|---|---|
| `uid/original.md`, `uid/copia.md` | Same `uid` in two files (copy and paste). Detected and reported as an **identity conflict**; neither is merged into the other nor picked silently |
| The rest | No `uid`: identified by their path, and the indexer does **not** write to them |

## Restrictions

| File | Expected |
|---|---|
| `privado/sin-ia.md` | `ai: false`: invisible to any agent credential |

## What the indexer ignores

| File | Reason |
|---|---|
| `.obsidian/`, `.trash/`, `.stfolder/` | Other tools' folders |
| `hogar/.Proxy.md.swp`, `hogar/Proxy.md~` | Editor temp files and backups |
| `hogar/.nfs00000000000268f3000008ac` | NFS silly rename |
| `hogar/.Proxy.md.vihko-1234-0` | vihko's own temp file |
| `proyectos/vihko/Plan.sync-conflict-….md` | Syncthing conflict: shown as an **alert**, not indexed as a note |
| `adjuntos/imagen.png`, `adjuntos/tablero.canvas` | Not notes |
