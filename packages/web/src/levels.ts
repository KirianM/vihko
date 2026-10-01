// Effective levels in the UI, as the server judges them (access.ts): sharing
// only adds, so a level in a folder holds in everything below it. The UI
// knows the levels of the folders it has listed (GET /api/permissions/folders);
// a folder made since, or one it hasn't listed, takes the nearest one above.
import type { Level } from './api.ts'

/** The folders from `folder` up to its top one: `a/b/c`, `a/b`, `a`. */
function upwards(folder: string): string[] {
  const out: string[] = []
  for (let f = folder; f !== ''; f = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '') out.push(f)
  return out
}

/**
 * Whether the person manages `folder` (`manage` there, given there or
 * inherited from above): what the server asks of whoever purges a note's
 * history (`canManage` of the note's folder). `levelOf`: a listed folder's
 * level, undefined for one not listed.
 */
export function managesFolder(levelOf: (folder: string) => Level | null | undefined, folder: string): boolean {
  return upwards(folder).some((f) => levelOf(f) === 'manage')
}

/** The folder a note is in (`''` at the root). */
export const noteFolder = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
