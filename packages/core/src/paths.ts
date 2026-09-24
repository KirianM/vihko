// Qué es cada archivo de la carpeta de notas para thoth.

export type PathKind = 'note' | 'conflict' | 'ignored' | 'other'

const SYNC_CONFLICT = /\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}(?:\.[^/]*)?$/

/**
 * Clasifica una ruta relativa a la raíz de notas (con `/`):
 * - `ignored`: cualquier segmento oculto (`.obsidian/`, `.trash/`, `.git/`, `.nfsXXXX`,
 *   temporales de editores y de thoth) o copias de seguridad terminadas en `~`.
 * - `conflict`: copia de conflicto de Syncthing de una nota. Se avisa; no se indexa.
 * - `note`: archivo `.md`.
 * - `other`: cualquier otro archivo (adjuntos).
 */
export function classifyPath(rel: string): PathKind {
  const parts = rel.split('/')
  const name = parts[parts.length - 1]!
  if (parts.some((p) => p.startsWith('.')) || name.endsWith('~')) return 'ignored'
  const isMd = /\.md$/i.test(name)
  if (SYNC_CONFLICT.test(name)) return isMd ? 'conflict' : 'ignored'
  return isMd ? 'note' : 'other'
}

/** true si un directorio no debe recorrerse (ahorra entrar en `.git/` y similares). */
export const isIgnoredDir = (name: string) => name.startsWith('.')
