import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyPath, conflictOriginal } from '@thoth/core'

test('clasificación de rutas del vault de casos límite', () => {
  const cases: [string, string][] = [
    ['Plan.md', 'note'],
    ['proyectos/thoth/Plan.md', 'note'],
    ['recetas/Notas de reunión (2026).md', 'note'],
    ['NOTA.MD', 'note'],
    ['.obsidian/app.json', 'ignored'],
    ['.trash/borrada.md', 'ignored'],
    ['.stfolder/.keep', 'ignored'],
    ['hogar/.Proxy.md.swp', 'ignored'],
    ['hogar/Proxy.md~', 'ignored'],
    ['hogar/.nfs00000000000268f3000008ac', 'ignored'],
    ['hogar/.Proxy.md.thoth-1234-0', 'ignored'],
    ['proyectos/thoth/Plan.sync-conflict-20260924-120000-ABCDEFG.md', 'conflict'],
    ['adjuntos/imagen.png', 'other'],
    ['adjuntos/tablero.canvas', 'other'],
  ]
  for (const [path, kind] of cases) assert.equal(classifyPath(path), kind, path)
})

test('nota original de una copia de conflicto', () => {
  assert.equal(conflictOriginal('proyectos/thoth/Plan.sync-conflict-20260924-120000-ABCDEFG.md'), 'proyectos/thoth/Plan.md')
  assert.equal(conflictOriginal('v1.2/Notas de v1.2.sync-conflict-20260924-120000-ABCDEFG.md'), 'v1.2/Notas de v1.2.md')
})
