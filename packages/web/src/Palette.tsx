// "Search or create" palette (⌘K): notes from the index (with `tag:` and
// `path:` filters), creating a note in the current folder (or at a path from
// it: newNote.ts), and commands (by typing ">"). React Aria combobox: focus
// stays in the field and the arrow keys move the active option.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Autocomplete, Button, Dialog, Header, Input, ListBox, ListBoxItem, ListBoxSection, Modal, ModalOverlay, TextField, type Key,
} from 'react-aria-components'
import { hasSearchFilter } from '@vihko/core/query'
import { api, type SearchResult, type TreeNote } from './api.ts'
import { commands, type CommandContext } from './commands.ts'
import { errorText, useLanguageChoice, useT, type LangChoice } from './i18n.tsx'
import { recentNotes } from './recent.ts'
import { useTheme } from './theme.ts'
import { useBackClose, useMobile } from './mobile.ts'
import { alignNewNote, newNote, scopePathFilters, type NewNote } from './newNote.ts'
import { rootOf, usePathLabels } from './spaces.tsx'
import { usePlaces } from './Destination.tsx'
import { Icon } from './ui.tsx'

export type PaletteMode = 'search' | 'create'

/** Opens the palette from any header (there's no sidebar on mobile). */
export const OpenPaletteContext = createContext<(() => void) | null>(null)

/** Header search button; only visible on mobile. */
export function SearchButton() {
  const t = useT()
  const open = useContext(OpenPaletteContext)
  if (!open) return null
  return <Button className="btn btn-icon mobile-only" aria-label={t('palette.input')} onPress={open}>{Icon.search}</Button>
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
/** To compare commands ignoring case and accents. */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** Snippet with the server's highlight markers turned into <mark>. */
function Snippet({ text, start, end }: { text: string; start: string; end: string }) {
  const parts: ReactNode[] = []
  let rest = text
  for (let i = 0; rest; i++) {
    const a = rest.indexOf(start)
    if (a === -1) { parts.push(rest); break }
    const b = rest.indexOf(end, a)
    parts.push(rest.slice(0, a))
    parts.push(<mark key={i}>{rest.slice(a + start.length, b === -1 ? undefined : b)}</mark>)
    rest = b === -1 ? '' : rest.slice(b + end.length)
  }
  return <span className="palette-snippet">{parts}</span>
}

const noteIcon = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></svg>
const commandIcon = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>

/** A note among the results: its title, its folders in its space and, when it isn't one's own, its space. */
function NoteOption({ path, title, snippet }: { path: string; title: string; snippet?: ReactNode }) {
  const labels = usePathLabels()
  const folders = labels.folders(path)
  const space = labels.spaceTag(path)
  return (
    <ListBoxItem id={`n:${path}`} textValue={title || baseName(path)} className="palette-item">
      <span className="palette-icon">{noteIcon}</span>
      <span className="palette-text">
        <span className="palette-title">
          {title || baseName(path)}
          {folders && <span className="palette-path"> {folders} /</span>}
          {space && <span className="palette-space">{space}</span>}
        </span>
        {snippet}
      </span>
    </ListBoxItem>
  )
}

interface Props {
  mode: PaletteMode
  /** Folder of the open note ('' = root): the new note is created there, or in the folders its name gives from there. */
  folder: string
  openPath: string | null
  notes: TreeNote[] | null
  /** Template notes (marked `template: true`, those the person reads), offered when creating. */
  templates: string[]
  /** Opens today's note; null while daily notes are off. */
  onToday: (() => void) | null
  /** Opens «New folder» where this person may create one; null where they may not (commands.ts). */
  onNewFolder: (() => void) | null
  /** Saves the UI's language in the account and applies it (null = automatic). */
  onLanguage: (choice: LangChoice) => void
  onClose: () => void
  onMode: (mode: PaletteMode) => void
  onOpen: (path: string) => void
  onCreated: (path: string) => void
}

export function Palette({ mode, folder: current, openPath, notes, templates, onToday, onNewFolder, onLanguage, onClose, onMode, onOpen, onCreated }: Props) {
  // Where a new note goes: the current folder, or another place picked with «in …».
  const places = usePlaces()
  const [folder, setFolder] = useState(current)
  const t = useT()
  const { effective } = useTheme()
  const { choice } = useLanguageChoice()
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<{ q: string; results: SearchResult[]; start: string; end: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Full screen on a phone: the back button closes it, like any other screen.
  useBackClose(useMobile(), onClose)

  const commandMode = mode === 'search' && query.startsWith('>')
  const text = query.trim()

  useEffect(() => {
    setError(null)
    if (mode !== 'search' || commandMode || !text) return setFound(null)
    let live = true
    // One request per typing pause, and only the last one's response counts.
    const timer = setTimeout(() => {
      api.search(scopePathFilters(text, rootOf(current) ?? '')).then((r) => {
        if (live) setFound({ q: text, results: r.results, start: r.highlight?.start ?? '\u0002', end: r.highlight?.end ?? '\u0003' })
      }).catch((e) => { if (live) setError(errorText(t, e)) })
    }, 120)
    return () => { live = false; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, mode, commandMode])

  const ctx: CommandContext = { theme: effective, openPath, newNote: () => onMode('create'), newFolder: onNewFolder, today: onToday, language: choice, chooseLanguage: onLanguage }
  const needle = fold(query.slice(1).trim())
  const matching = commandMode ? commands.filter((c) => (c.available?.(ctx) ?? true) && fold(t(c.label(ctx))).includes(needle)) : []

  const titles = new Map((notes ?? []).map((n) => [n.path, n.title]))
  const recent = mode === 'search' && !text ? recentNotes().filter((p) => titles.has(p) && p !== openPath) : []
  // Create shows up once the results for what was typed have arrived: this way a
  // quick ↵ opens the matching note instead of creating another with the same name.
  // A query with a filter (`tag:x`) is a search, never the name of a new note.
  // A leading «/» is the root of the space it's created in, never the notes root.
  const typedNote = commandMode || (mode === 'search' && (found?.q !== text || hasSearchFilter(query))) ? null : newNote(query, folder, rootOf(folder) ?? folder)
  // Its folders as they are on disk, typed in any case (typedPath.ts); several in case: one to choose.
  const knownFolders = useMemo(() => {
    const out = new Set<string>()
    for (const n of notes ?? []) for (let i = n.path.indexOf('/'); i !== -1; i = n.path.indexOf('/', i + 1)) out.add(n.path.slice(0, i))
    return [...out]
  }, [notes])
  const choices = typedNote ? alignNewNote(typedNote, query.trimStart().startsWith('/') ? (rootOf(folder) ?? folder) : folder, knownFolders) : []
  const note = choices.length === 1 ? choices[0]! : null

  async function create(note: NewNote, template?: string) {
    setBusy(true)
    setError(null)
    try {
      const r = template ? await api.createFromTemplate(note.path, template) : await api.createNote(note.path, `# ${note.title}\n`)
      onCreated(r.path)
    } catch (e) {
      setError(errorText(t, e))
    } finally {
      setBusy(false)
    }
  }

  function act(key: Key) {
    const k = String(key)
    if (k.startsWith('n:')) { onClose(); onOpen(k.slice(2)) }
    else if (k === 'create' && note && !busy) void create(note)
    else if (k.startsWith('create:') && !busy) { const c = choices[Number(k.slice(7))]; if (c) void create(c) }
    else if (k.startsWith('t:') && note && !busy) void create(note, k.slice(2))
    else if (k.startsWith('c:')) {
      const c = commands.find((x) => `c:${x.id}` === k)
      if (!c) return
      onClose()
      c.run(ctx)
    }
  }

  const labels = usePathLabels()
  const where = note ? labels.where(note.folder) : ''
  // Templates by the space they're in, one's own first.
  const templateGroups = (() => {
    const groups = new Map<string, string[]>()
    for (const tpl of templates) {
      const space = labels.space(tpl)
      groups.set(space, [...(groups.get(space) ?? []), tpl])
    }
    return [...groups.entries()]
  })()
  const [before, after] = t('palette.createIn', { name: note?.title ?? typedNote?.title ?? '' }).split('{folder}')
  const hints = mode === 'create' ? ['palette.keyCreate'] as const
    : commandMode ? ['palette.keyMove', 'palette.keyRun'] as const
    : ['palette.keyMove', 'palette.keyOpen'] as const

  const empty = commandMode ? t('palette.noCommands')
    : mode === 'create' ? t('palette.createEmpty')
    : text ? (found ? t('palette.noResults') : t('common.loading'))
    : t('palette.noRecent')

  return (
    <ModalOverlay className="palette-overlay" isOpen isDismissable onOpenChange={(open) => { if (!open) onClose() }}>
      <Modal className="palette">
        <Dialog className="palette-dialog" aria-label={t(mode === 'create' ? 'palette.createLabel' : 'palette.label')}>
          <Autocomplete inputValue={query} onInputChange={setQuery}>
            <div className="palette-head">
              <TextField className="palette-field" aria-label={t(mode === 'create' ? 'palette.createInput' : 'palette.input')} autoFocus>
                {mode === 'create' ? Icon.plus : Icon.search}
                <Input className="palette-input" placeholder={t(mode === 'create' ? 'palette.createInput' : 'palette.placeholder')} />
                {mode === 'search' && !commandMode && <span className="palette-help">{t('palette.help')}</span>}
              </TextField>
              <Button className="palette-cancel" onPress={onClose}>{t('palette.cancel')}</Button>
            </div>
            {error && <p className="palette-error error-text" role="alert">{error}</p>}
            <ListBox
              className="palette-list"
              aria-label={t('palette.results')}
              onAction={act}
              renderEmptyState={() => <div className="palette-empty">{empty}</div>}
            >
              {mode === 'search' && !commandMode && text && found && found.results.length > 0 && (
                <ListBoxSection className="palette-section">
                  <Header className="palette-header">{t('palette.notes')}</Header>
                  {found.results.map((r) => (
                    <NoteOption key={r.path} path={r.path} title={r.title} snippet={r.snippet ? <Snippet text={r.snippet} start={found.start} end={found.end} /> : undefined} />
                  ))}
                </ListBoxSection>
              )}
              {recent.length > 0 && (
                <ListBoxSection className="palette-section">
                  <Header className="palette-header">{t('palette.recent')}</Header>
                  {recent.map((p) => <NoteOption key={p} path={p} title={titles.get(p) ?? ''} />)}
                </ListBoxSection>
              )}
              {note && (
                <ListBoxSection className="palette-section">
                  <Header className="palette-header">{t('palette.create')}</Header>
                  <ListBoxItem id="create" textValue={t('palette.createIn', { name: note.title, folder: where })} className="palette-item palette-create">
                    <span className="palette-icon palette-icon-accent">{Icon.plus}</span>
                    <span className="palette-grow">{before}<b>{where}</b>{after}</span>
                    {note.folder === current && <span className="palette-meta">{t('palette.currentFolder')}</span>}
                  </ListBoxItem>
                </ListBoxSection>
              )}
              {choices.length > 1 && (
                <ListBoxSection className="palette-section">
                  <Header className="palette-header">{t('typed.several')}</Header>
                  {choices.map((c, i) => {
                    const at = labels.where(c.folder)
                    return (
                      <ListBoxItem key={c.path} id={`create:${i}`} textValue={t('palette.createIn', { name: c.title, folder: at })} className="palette-item palette-create">
                        <span className="palette-icon palette-icon-accent">{Icon.plus}</span>
                        <span className="palette-grow">{before}<b>{at}</b>{after}</span>
                      </ListBoxItem>
                    )
                  })}
                </ListBoxSection>
              )}
              {note && templateGroups.map(([space, list]) => (
                <ListBoxSection key={space} className="palette-section">
                  <Header className="palette-header">{templateGroups.length > 1 ? t('palette.fromTemplateIn', { space }) : t('palette.fromTemplate')}</Header>
                  {list.map((tpl) => {
                    const label = t('palette.createWith', { name: note.title, template: baseName(tpl) })
                    const [pre, post] = t('palette.createWith', { name: note.title }).split('{template}')
                    return (
                      <ListBoxItem key={tpl} id={`t:${tpl}`} textValue={label} className="palette-item">
                        <span className="palette-icon">{noteIcon}</span>
                        <span className="palette-grow">{pre}<b>{baseName(tpl)}</b>{post}</span>
                      </ListBoxItem>
                    )
                  })}
                </ListBoxSection>
              ))}
              {matching.length > 0 && (
                <ListBoxSection className="palette-section">
                  <Header className="palette-header">{t('palette.commands')}</Header>
                  {matching.map((c) => (
                    <ListBoxItem key={c.id} id={`c:${c.id}`} textValue={t(c.label(ctx))} className="palette-item">
                      <span className="palette-icon">{commandIcon}</span>
                      <span className="palette-grow">{t(c.label(ctx))}</span>
                    </ListBoxItem>
                  ))}
                </ListBoxSection>
              )}
            </ListBox>
            {mode === 'create' && places.length > 1 && (
              <label className="palette-into">
                <span className="palette-header">{t('palette.into')}</span>
                <select className="select" value={places.some((p) => p.root === folder) ? folder : ''} onChange={(e) => setFolder(e.target.value || current)}>
                  {!places.some((p) => p.root === folder) && <option value="">{labels.where(folder)}</option>}
                  {places.map((p) => <option key={p.root} value={p.root}>{p.label}</option>)}
                </select>
              </label>
            )}
            {mode === 'search' && !commandMode && (
              <div className="palette-filters">
                <span className="palette-header">{t('palette.filtersHint')}</span>
                <span className="palette-chips">
                  {([['palette.exTag', 'palette.filterTag'], ['palette.exPath', 'palette.filterPath'], ['palette.exField', 'palette.filterField'], ['palette.exHas', 'palette.filterHas'], ['palette.exProp', 'palette.filterProp'], ['palette.exNot', 'palette.filterNot'], ['palette.exQuotes', 'palette.filterQuotes']] as const).map(([example, key]) => (
                    <span key={key} className="palette-chip palette-filter"><code>{t(example)}</code> {t(key)}</span>
                  ))}
                </span>
              </div>
            )}
            {mode === 'search' && !commandMode && (
              <div className="palette-commands">
                <span className="palette-header">{t('palette.commandsHint')} <kbd>&gt;</kbd></span>
                <span className="palette-chips">
                  {commands.filter((c) => c.available?.(ctx) ?? true).map((c) => <span key={c.id} className="palette-chip">&gt; {t(c.label(ctx))}</span>)}
                </span>
              </div>
            )}
          </Autocomplete>
          <footer className="palette-foot" aria-hidden="true">
            {hints.map((h) => <span key={h}>{t(h)}</span>)}
            <span>{t('palette.keyClose')}</span>
          </footer>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
