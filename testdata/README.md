# Vault de casos límite

`vault/` reúne los casos difíciles detectados en el análisis de referencias
(`docs/analisis/`). Los tests del indexador, la resolución de enlaces y la
escritura lo usan como entrada. Si se añade un caso, se documenta aquí su
comportamiento esperado y la decisión o el informe del que sale.

Los bytes importan: `recetas/Café.md` está en NFD, `frontmatter/bom-crlf.md`
tiene BOM y finales CRLF, `frontmatter/vacia.md` tiene 0 bytes. No editar estos
archivos con un editor que normalice.

## Resolución de enlaces (D-019)

| Desde | Enlace | Esperado |
|---|---|---|
| `proyectos/thoth/notas.md` | `[[Plan]]`, `[[plan]]`, `[[Plan\|el plan]]` | `proyectos/thoth/Plan.md` (misma carpeta; sin distinguir mayúsculas) |
| `proyectos/thoth/notas.md` | `![[Plan]]` | Igual: el embed se indexa como enlace (su render queda fuera de alcance) |
| `proyectos/thoth/notas.md` | `[[notas]]` | Resuelve a sí misma |
| `diario/2026-09-24.md` | `[[Plan]]` | **Ambiguo** con tres candidatos: `Plan.md`, `proyectos/thoth/Plan.md`, `proyectos/blog/Plan.md` |
| `diario/2026-09-24.md` | `[[proyectos/blog/Plan]]`, `[[blog/Plan]]` | `proyectos/blog/Plan.md` (ruta y sufijo de ruta) |
| `recetas/índice.md` | `[[Café]]`, `[[CAFÉ]]` | `recetas/Café.md`, cuyo nombre está en NFD |
| `recetas/índice.md` | `[[Notas de reunión (2026)]]` | `recetas/Notas de reunión (2026).md` |
| `hogar/enlaces.md` | `[[gw]]` | `hogar/Proxy.md` por alias |
| `hogar/enlaces.md` | `[[Red]]` | `hogar/Red.md`: el nombre gana al alias `Red` de `Firewall.md` |
| `hogar/enlaces.md` | `[[Proxy#Red]]` | Resuelto, ancla existente |
| `hogar/enlaces.md` | `[[Proxy#No existe]]` | Resuelto con **ancla rota** |
| `hogar/enlaces.md` | `[[Nota que no existe]]` | **Roto**; se conserva el texto literal |
| `hogar/enlaces.md` | `[…](Proxy.md)`, `[…](../proyectos/thoth/Plan.md)` | Resueltos (enlaces Markdown relativos) |
| `hogar/enlaces.md` | `[roto](no-existe.md)` | Roto |
| `hogar/enlaces.md` | `[externo](https://example.com/#ancla)` | Enlace externo: ni enlace entre notas ni tag |
| `codigo.md` | Todo lo que está en código en línea, bloques cercados o indentados | Ni enlaces ni tags. Fuera del código, `[[Plan]]` es ambiguo y `#hogar` es tag |
| `frontmatter/sin-frontmatter.md`, `frontmatter/bom-crlf.md` | `[[Plan]]` | Ambiguo (carpeta `frontmatter/` equidistante de los tres) |

## Tags (D-019)

| Archivo | Esperado |
|---|---|
| `tags.md` | Tags: `hogar` (frontmatter, `#hogar` y `#Hogar` son el mismo), `proyectos` (frontmatter, en minúsculas), `hogar/red` (anidado) |
| `tags.md` | `#123` no es tag. `# Título` es un encabezado, no un tag |
| `codigo.md` | `#notag` y `#tampoco` no son tags |

## Frontmatter

| Archivo | Esperado |
|---|---|
| `frontmatter/exotico.md` | Comentarios, lista en flujo, comillas, texto multilínea, anclas YAML y claves desconocidas. Añadir `uid` con un parche textual deja **todos los demás bytes intactos** |
| `frontmatter/invalido.md` | `frontmatter_error`. Se indexa como cuerpo, se trata como la nota más restringida (D-014) y thoth **nunca** escribe en ella |
| `frontmatter/sin-frontmatter.md` | Nota válida sin metadatos. Añadir `uid` crea el bloque sin tocar el cuerpo |
| `frontmatter/solo-frontmatter.md` | Nota válida con cuerpo vacío |
| `frontmatter/vacia.md` | Nota válida vacía (0 bytes) |
| `frontmatter/bom-crlf.md` | El BOM no impide detectar el frontmatter. Un parche conserva BOM y CRLF |

## Identidad (D-015)

| Archivo | Esperado |
|---|---|
| `uid/original.md`, `uid/copia.md` | Mismo `uid` en dos archivos (copiar y pegar). Se detecta y se señala como **conflicto de identidad**; ninguno se fusiona con el otro ni se elige en silencio |
| El resto | Sin `uid`: se identifican por su ruta y el indexador **no** escribe en ellos |

## Restricciones (D-014)

| Archivo | Esperado |
|---|---|
| `privado/sin-ia.md` | `ai: false`: invisible para cualquier credencial de agente |

## Lo que el indexador ignora

| Archivo | Motivo |
|---|---|
| `.obsidian/`, `.trash/`, `.stfolder/` | Directorios de otras herramientas |
| `hogar/.Proxy.md.swp`, `hogar/Proxy.md~` | Temporales y copias de editores |
| `hogar/.nfs00000000000268f3000008ac` | Silly rename de NFS (`docs/infra.md`) |
| `hogar/.Proxy.md.thoth-1234-0` | Temporal propio de thoth |
| `proyectos/thoth/Plan.sync-conflict-….md` | Conflicto de Syncthing: se muestra como **alerta**, no se indexa como nota |
| `adjuntos/imagen.png`, `adjuntos/tablero.canvas` | No son notas |
