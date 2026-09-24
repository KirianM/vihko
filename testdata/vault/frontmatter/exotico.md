---
# comentario de cabecera
title: "Título con: dos puntos"
tags: [a, 'b', "c"]   # lista en flujo con comentario
fecha: 2026-09-24
multilinea: |
  línea uno
  línea dos
base: &base {x: 1}
copia: *base
anidado:
  clave: valor
desconocida_de_otra_herramienta: true
---
Cuerpo.
