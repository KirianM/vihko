// Spaces as the UI shows them (D-056, spec §5): what the person reaches
// (GET /api/spaces) and how every real path is shown to them. One function
// for the whole interface (`displayPath` of core): «My notes / diary / day»
// for their own, «<space> / recipes / Bread» in a shared space, «ana /
// trips / Rome» in a folder someone shares. Never `people/<me>` nor a
// space's folder (a shared space's folder is its name, D-056.33).
import { createContext, useContext, useMemo } from 'react'
import { addressOf, displayPath, parseSpacePath, pathOfAddress, personalRoot, spaceRootOf, type DisplayPath } from '@vihko/core/spaces'
import type { RootNames } from './typedPath.ts'
import type { SpacesInfo } from './api.ts'
import { inEveryLanguage, useT } from './i18n.tsx'

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
    return { me, info, name, show: (path: string) => displayPath(path, me) }
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

/**
 * How a person may type each space they reach (typedPath.ts): their own as
 * «My notes» in any language, or `~<username>`; a shared space by its name
 * (its folder's, as the address shows it); a space a folder is shared from by
 * its owner (`ana`, `~ana`) or its space's name. `more`: other roots the
 * person may name (the admin: every space and person, for purging by name).
 */
export function rootNamesOf(s: Spaces, more: RootNames[] = []): RootNames[] {
  const out: RootNames[] = []
  const personal = s.info?.personal?.path ?? (s.me ? personalRoot(s.me) : null)
  if (personal) out.push({ root: personal, names: [...inEveryLanguage('spaces.mine'), `~${s.me}`] })
  for (const sp of s.info?.spaces ?? []) out.push({ root: sp.path, names: [sp.name] })
  for (const sh of s.info?.shared ?? []) {
    if (sh.owner) out.push({ root: personalRoot(sh.owner), names: [sh.owner, `~${sh.owner}`] })
    else if (sh.space) out.push({ root: sh.space.path, names: [sh.space.name] })
  }
  return [...out, ...more]
}

/** The roots of every person and shared space by the names the admin may type (purging what they can't read, by its name). */
export function everyRoot(spaces: readonly { path: string; name: string }[], usernames: readonly string[]): RootNames[] {
  return [
    ...spaces.map((sp) => ({ root: sp.path, names: [sp.name] })),
    ...usernames.map((u) => ({ root: personalRoot(u), names: [u, `~${u}`] })),
  ]
}

/**
 * A note's link in the browser (D-056.29): `?note=<address>` (core
 * `addressOf`: `Home/list.md`, `~ana/trips/Rome.md`), and the
 * version shown over it. Never `people/` nor `spaces/`.
 */
export function noteHref(path: string, version?: string): string {
  const note = `?note=${encodeURIComponent(addressOf(path) ?? path)}`
  return version === undefined ? note : `${note}&version=${encodeURIComponent(version)}`
}

/** The real path of `?note=` in a URL's query (an address, or a path from before D-056.29), or null. */
export function notePathOf(search: string): string | null {
  const v = new URLSearchParams(search).get('note')
  return v === null ? null : pathOfAddress(v)?.path ?? null
}

/** A folder path relative to its space's root (`''` at the root), and the root; null outside every space. */
export function splitSpace(path: string): { root: string; inner: string } | null {
  const p = parseSpacePath(path)
  return p ? { root: p.space.root, inner: p.inner } : null
}

