// Where something is moved to (spec §5.4): a picker of the places the person
// can write in (their own space, the shared spaces where they edit, the
// folders shared with them to edit) and, inside the one picked, the folder,
// typed (a new one is made) or picked from those that exist.
import { useEffect, useId, useMemo, useState } from 'react'
import { Input, Label, Text, TextField } from 'react-aria-components'
import { api, atLeast } from './api.ts'
import { useT } from './i18n.tsx'
import { useSpaces } from './spaces.tsx'

/** A place something can be moved to: a root and how it's named. */
export interface Place { root: string; label: string }

/** The places the person can write in, their own space first. */
export function usePlaces(): Place[] {
  const t = useT()
  const { info } = useSpaces()
  return useMemo(() => {
    if (!info) return []
    const out: Place[] = []
    if (info.personal) out.push({ root: info.personal.path, label: t('spaces.mine') })
    for (const s of info.spaces) if (atLeast(s.level, 'edit')) out.push({ root: s.path, label: s.name })
    for (const s of info.shared) {
      if (!atLeast(s.level, 'edit')) continue
      const name = s.path.slice(s.path.lastIndexOf('/') + 1)
      out.push({ root: s.path, label: `${name} · ${s.owner ? t('spaces.of', { owner: s.owner }) : s.space?.name ?? ''}` })
    }
    return out
  }, [info, t])
}

/** A folder as a place and the folder inside it; the place whose root is the longest prefix. */
export function splitPlace(places: Place[], folder: string): { root: string; inner: string } {
  let best: Place | null = null
  for (const p of places) if ((folder === p.root || folder.startsWith(p.root + '/')) && (!best || p.root.length > best.root.length)) best = p
  if (!best) return { root: folder, inner: '' }
  return { root: best.root, inner: folder === best.root ? '' : folder.slice(best.root.length + 1) }
}

/** The folder a place and a folder inside it name. */
export const joinPlace = (root: string, inner: string) => {
  const i = inner.trim().replace(/^\/+|\/+$/g, '')
  return i ? `${root}/${i}` : root
}

/** The two fields: the place (picking one starts at its root: `onRoot` clears the folder), and the folder inside it («Folder», with the existing ones suggested). */
export function DestinationFields({ root, inner, onRoot, onInner, hint }: { root: string; inner: string; onRoot: (root: string) => void; onInner: (inner: string) => void; hint: string }) {
  const t = useT()
  const places = usePlaces()
  const id = useId()
  const [folders, setFolders] = useState<string[]>([])
  useEffect(() => {
    api.permissionFolders().then((r) => setFolders(r.folders.filter((f) => atLeast(f.level, 'edit')).map((f) => f.path))).catch(() => {})
  }, [])
  const known = places.some((p) => p.root === root)
  const inside = folders.filter((f) => f.startsWith(root + '/')).map((f) => f.slice(root.length + 1)).sort()
  return (
    <>
      <label className="field">
        <span>{t('move.space')}</span>
        <select className="select" value={root} onChange={(e) => onRoot(e.target.value)}>
          {!known && <option value={root}>{root}</option>}
          {places.map((p) => <option key={p.root} value={p.root}>{p.label}</option>)}
        </select>
      </label>
      <TextField className="field" value={inner} onChange={onInner}>
        <Label>{t('rename.folder')}</Label>
        <Input list={`${id}-folders`} />
        <Text slot="description" className="hint">{hint}</Text>
      </TextField>
      <datalist id={`${id}-folders`}>{inside.map((f) => <option key={f} value={f} />)}</datalist>
    </>
  )
}
