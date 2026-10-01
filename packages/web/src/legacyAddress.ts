// Addresses of shared spaces of 0.1.0-rc.1 and rc.2 (`?note=casa-7k2q9x/…`,
// from a bookmark or a link someone sent), followed to the space vihko
// renamed that folder to when it started (D-056.33). Only among the spaces
// the person reaches: nothing else is guessed or revealed.
import { legacySpaceFolder, parseSpacePath, readablePart } from '@vihko/core/spaces'
import type { SpacesInfo } from './api.ts'

/**
 * A path in a shared space of rc.1 or rc.2 (`spaces/casa-7k2q9x/…`) at the
 * space it became: among the shared spaces this person reaches, the only one
 * whose name gives that folder's readable part. Null if the path is in a space
 * they reach as it is, isn't such a folder, or none or several match.
 */
export function renamedPath(path: string, info: Pick<SpacesInfo, 'spaces' | 'shared'>): string | null {
  const s = parseSpacePath(path)
  if (!s || s.space.kind !== 'shared') return null
  const old = legacySpaceFolder(s.space.folder)
  if (!old) return null
  const roots = new Set([...info.spaces.map((x) => x.path), ...info.shared.flatMap((x) => (x.space ? [x.space.path] : []))])
  if (roots.has(s.space.root)) return null
  const matches = [...roots].filter((r) => readablePart(r.slice(r.indexOf('/') + 1)) === old.readable)
  if (matches.length !== 1) return null
  return s.inner === '' ? matches[0]! : `${matches[0]!}/${s.inner}`
}
