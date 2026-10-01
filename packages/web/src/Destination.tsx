// Where something is moved to: a picker of the places the person
// can write in (their own space, the shared spaces where they edit, the
// folders shared with them to edit) and, inside the one picked, the folder,
// typed (a new one is made) or picked from those that exist.
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button, Input, Label, Text, TextField } from 'react-aria-components'
import { api, atLeast } from './api.ts'
import { useT } from './i18n.tsx'
import { usePathLabels, useSpaces } from './spaces.tsx'
import { alignFolder } from './typedPath.ts'

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

/**
 * The two fields: the place (picking one starts at its root: `onRoot` clears
 * the folder), and the folder inside it («Folder», with the existing ones
 * suggested). The folder is typed as the person sees it and found as a link
 * is (typedPath.ts): in any case, an existing folder keeps its spelling, so
 * `onInner` gets it as it is on disk; what names no folder is created as
 * typed. Folders that differ only in case are offered to choose from, and
 * `onAmbiguous` says the destination isn't settled until one is chosen.
 */
export function DestinationFields({ root, inner, onRoot, onInner, onAmbiguous, hint }: {
  root: string
  inner: string
  onRoot: (root: string) => void
  onInner: (inner: string) => void
  onAmbiguous?: (ambiguous: boolean) => void
  hint: string
}) {
  const t = useT()
  const places = usePlaces()
  const labels = usePathLabels()
  const id = useId()
  const [folders, setFolders] = useState<{ path: string; edit: boolean }[]>([])
  useEffect(() => {
    api.permissionFolders().then((r) => setFolders(r.folders.map((f) => ({ path: f.path, edit: atLeast(f.level, 'edit') })))).catch(() => {})
  }, [])
  // What the person typed, kept as typed: the parent gets it as it is on disk.
  const [typed, setTyped] = useState(inner)
  const sent = useRef(inner)
  const [several, setSeveral] = useState<string[] | null>(null)
  // A change from outside (another place picked, a preset): what the field shows.
  useEffect(() => {
    if (inner !== sent.current) { setTyped(inner); setSeveral(null); sent.current = inner }
  }, [inner])
  const known = places.some((p) => p.root === root)
  const under = folders.filter((f) => f.path.startsWith(root + '/')).map((f) => ({ ...f, path: f.path.slice(root.length + 1) }))
  const inside = under.filter((f) => f.edit).map((f) => f.path).sort()
  const send = (value: string) => { sent.current = value; onInner(value) }
  const change = (value: string) => {
    setTyped(value)
    const a = alignFolder(value, under.map((f) => f.path))
    if ('several' in a) {
      setSeveral(a.several)
      onAmbiguous?.(true)
      send(value)
    } else {
      setSeveral(null)
      onAmbiguous?.(false)
      send(a.inner)
    }
  }
  // The folders arrive after something may have been typed: found again then.
  useEffect(() => {
    if (typed.trim()) change(typed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders])
  const choose = (value: string) => {
    setTyped(value)
    setSeveral(null)
    onAmbiguous?.(false)
    send(value)
  }
  return (
    <>
      <label className="field">
        <span>{t('move.space')}</span>
        <select className="select" value={root} onChange={(e) => onRoot(e.target.value)}>
          {!known && <option value={root}>{labels.label(root)}</option>}
          {places.map((p) => <option key={p.root} value={p.root}>{p.label}</option>)}
        </select>
      </label>
      <TextField className="field" value={typed} onChange={change}>
        <Label>{t('rename.folder')}</Label>
        <Input list={`${id}-folders`} />
        <Text slot="description" className="hint">{hint}</Text>
      </TextField>
      <datalist id={`${id}-folders`}>{inside.map((f) => <option key={f} value={f} />)}</datalist>
      {several && <CaseChooser paths={several.map((p) => joinPlace(root, p))} onChoose={(p) => choose(p === root ? '' : p.slice(root.length + 1))} />}
    </>
  )
}

/**
 * «Which one?»: paths that differ only in case (typedPath.ts), each as the
 * person sees it, to choose from. Only what they can see is ever offered.
 * `kind`: what each one is, when that tells them apart (a note or a folder).
 */
export function CaseChooser({ paths, onChoose, kind }: { paths: string[]; onChoose: (path: string) => void; kind?: (path: string) => 'note' | 'folder' | 'file' }) {
  const t = useT()
  const labels = usePathLabels()
  return (
    <div className="case-choose" role="group" aria-label={t('typed.several')}>
      <p className="hint">{t('typed.several')}</p>
      <ul className="case-choose-list">
        {paths.map((p) => (
          <li key={p}>
            <Button className="btn btn-sm" onPress={() => onChoose(p)}>
              {labels.label(p)}
              {kind && <> <span className="case-choose-kind">{t(`typed.${kind(p)}`)}</span></>}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
