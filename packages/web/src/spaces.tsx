// Spaces as the UI shows them (D-056, spec §5): what the person reaches
// (GET /api/spaces) and how every real path is shown to them. One function
// for the whole interface (`displayPath` of core): «My notes / diary / day»
// for their own, «<space> / recipes / Bread» in a shared space, «ana /
// trips / Rome» in a folder someone shares. Never `people/<me>` nor a
// space's folder id.
import { createContext, useContext, useMemo } from 'react'
import { displayPath, parseSpacePath, spaceRootOf, type DisplayPath } from '@vihko/core/spaces'
import type { SpacesInfo } from './api.ts'
import { useT } from './i18n.tsx'

export interface Spaces {
  /** The person's username. */
  me: string
  /** What they reach; null until loaded. */
  info: SpacesInfo | null
  /** A shared space's name, by its root (the ones they belong to, or reach a folder of). */
  name: (root: string) => string | null
  /** A real path as they see it (null for one in no space). */
  show: (path: string) => DisplayPath | null
}

const empty: Spaces = { me: '', info: null, name: () => null, show: () => null }
export const SpacesContext = createContext<Spaces>(empty)

/** The spaces of the signed-in person, for the whole shell. */
export function useSpacesValue(me: string, info: SpacesInfo | null): Spaces {
  return useMemo(() => {
    const names = new Map<string, string>()
    for (const s of info?.spaces ?? []) names.set(s.path, s.name)
    for (const s of info?.shared ?? []) if (s.space) names.set(s.space.path, s.space.name)
    const name = (root: string) => names.get(root) ?? null
    return { me, info, name, show: (path: string) => displayPath(path, me, name) }
  }, [me, info])
}

export const useSpaces = () => useContext(SpacesContext)

/** The root of the space a path is in, or null. */
export const rootOf = (path: string) => spaceRootOf(path)

/** Whether a folder is the root of the person's own space. */
export const isMine = (s: Spaces, folder: string) => s.info?.personal?.path === folder

/**
 * How a path is labelled for this person (spec §5.6):
 * - `label(path)`: «My notes / diary / day» (the space, its folders, the name);
 * - `space(path)`: the space alone («My notes», «Home», «ana»);
 * - `where(path)`: the space and the folders, for a folder or where a note is;
 * - `folders(path)`: the folders inside the space (`diary / 2026`), or ''.
 */
export function usePathLabels(given?: Spaces) {
  const t = useT()
  const context = useSpaces()
  const s = given ?? context
  return useMemo(() => {
    const spaceLabel = (d: DisplayPath) => d.space.kind === 'mine' ? t('spaces.mine') : d.space.kind === 'person' ? d.space.owner : d.space.name
    /** The space as a tag beside a result: nothing for one's own, «Home», «ana's». */
    const spaceTag = (path: string): string | null => {
      const d = s.show(path)
      if (!d || d.space.kind === 'mine') return null
      return d.space.kind === 'person' ? t('spaces.of', { owner: d.space.owner }) : d.space.name
    }
    const label = (path: string): string => {
      const d = s.show(path)
      if (!d) return path.replace(/\.md$/i, '').split('/').join(' / ')
      return [spaceLabel(d), ...d.folders, ...(d.name ? [d.name] : [])].join(' / ')
    }
    const space = (path: string): string => {
      const d = s.show(path)
      return d ? spaceLabel(d) : ''
    }
    /** A folder (or a note's folder when `note`) as «My notes / diary». */
    const where = (path: string, note = false): string => {
      const folder = note ? (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '') : path
      return label(folder)
    }
    const folders = (path: string): string => {
      const d = s.show(path)
      return d ? d.folders.join(' / ') : ''
    }
    return { label, space, where, folders, spaceTag, spaceLabel }
  }, [t, s])
}

/** A folder path relative to its space's root (`''` at the root), and the root; null outside every space. */
export function splitSpace(path: string): { root: string; inner: string } | null {
  const p = parseSpacePath(path)
  return p ? { root: p.space.root, inner: p.inner } : null
}
