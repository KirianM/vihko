// "Search or create" palette (⌘K): notes from the index (with `tag:` and
// `path:` filters), creating a note in the current folder, and commands (by
// typing ">"). React Aria combobox: focus stays in the field and the arrow keys
// move the active option.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
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

/** File name for a new note: no slashes or control characters, no leading dot (would be hidden), with `.md`. */
export function noteFileName(input: string): string | null {
  const name = input.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/\.md$/i, '')
    .trim()
  return name ? `${name}.md` : null
}

const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
const folderLabel = (folder: string) => folder.split('/').join(' / ')
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

function NoteOption({ path, title, snippet }: { path: string; title: string; snippet?: ReactNode }) {
  const folder = folderOf(path)
  return (
    <ListBoxItem id={`n:${path}`} textValue={title || baseName(path)} className="palette-item">
      <span className="palette-icon">{noteIcon}</span>
      <span className="palette-text">
        <span className="palette-title">
          {title || baseName(path)}
          {folder && <span className="palette-path"> {folderLabel(folder)} /</span>}
        </span>
        {snippet}
      </span>
    </ListBoxItem>
  )
}

interface Props {
  mode: PaletteMode
  /** Folder of the open note ('' = root): the new note is created there. */
  folder: string
  openPath: string | null
  notes: TreeNote[] | null
  /** Template notes (from the templates folder in vihko.yaml), offered when creating. */
  templates: string[]
  /** Opens today's note; null while daily notes are off. */
  onToday: (() => void) | null
  /** Saves the UI's language in the account and applies it (null = automatic). */
  onLanguage: (choice: LangChoice) => void
  onClose: () => void
  onMode: (mode: PaletteMode) => void
  onOpen: (path: string) => void
  onCreated: (path: string) => void
}

export function Palette({ mode, folder, openPath, notes, templates, onToday, onLanguage, onClose, onMode, onOpen, onCreated }: Props) {
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
      api.search(text).then((r) => {
        if (live) setFound({ q: text, results: r.results, start: r.highlight?.start ?? '\u0002', end: r.highlight?.end ?? '\u0003' })
      }).catch((e) => { if (live) setError(errorText(t, e)) })
    }, 120)
    return () => { live = false; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, mode, commandMode])

  const ctx: CommandContext = { theme: effective, openPath, newNote: () => onMode('create'), today: onToday, language: choice, chooseLanguage: onLanguage }
  const needle = fold(query.slice(1).trim())
  const matching = commandMode ? commands.filter((c) => (c.available?.(ctx) ?? true) && fold(t(c.label(ctx))).includes(needle)) : []

  const titles = new Map((notes ?? []).map((n) => [n.path, n.title]))
  const recent = mode === 'search' && !text ? recentNotes().filter((p) => titles.has(p) && p !== openPath) : []
  // Create shows up once the results for what was typed have arrived: this way a
  // quick ↵ opens the matching note instead of creating another with the same name.
  // A query with a filter (`tag:x`) is a search, never the name of a new note.
  const fileName = commandMode || (mode === 'search' && (found?.q !== text || hasSearchFilter(query))) ? null : noteFileName(query)

  async function create(name: string, template?: string) {
    const path = folder ? `${folder}/${name}` : name
    setBusy(true)
    setError(null)
    try {
      const r = template ? await api.createFromTemplate(path, template) : await api.createNote(path, `# ${query.trim()}\n`)
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
    else if (k === 'create' && fileName && !busy) void create(fileName)
    else if (k.startsWith('t:') && fileName && !busy) void create(fileName, k.slice(2))
    else if (k.startsWith('c:')) {
      const c = commands.find((x) => `c:${x.id}` === k)
      if (!c) return
      onClose()
      c.run(ctx)
    }
  }

  const where = folder ? folderLabel(folder) : t('palette.root')
  const [before, after] = t('palette.createIn', { name: fileName ? baseName(fileName) : '' }).split('{folder}')
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
              {fileName && (
                <ListBoxSection className="palette-section">
                  <Header className="palette-header">{t('palette.create')}</Header>
                  <ListBoxItem id="create" textValue={t('palette.createIn', { name: baseName(fileName), folder: where })} className="palette-item palette-create">
                    <span className="palette-icon palette-icon-accent">{Icon.plus}</span>
                    <span className="palette-grow">{before}<b>{where}</b>{after}</span>
                    <span className="palette-meta">{t('palette.currentFolder')}</span>
                  </ListBoxItem>
                </ListBoxSection>
              )}
              {fileName && templates.length > 0 && (
                <ListBoxSection className="palette-section">
                  <Header className="palette-header">{t('palette.fromTemplate')}</Header>
                  {templates.map((tpl) => {
                    const label = t('palette.createWith', { name: baseName(fileName), template: baseName(tpl) })
                    const [pre, post] = t('palette.createWith', { name: baseName(fileName) }).split('{template}')
                    return (
                      <ListBoxItem key={tpl} id={`t:${tpl}`} textValue={label} className="palette-item">
                        <span className="palette-icon">{noteIcon}</span>
                        <span className="palette-grow">{pre}<b>{baseName(tpl)}</b>{post}</span>
                      </ListBoxItem>
                    )
                  })}
                </ListBoxSection>
              )}
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
            {mode === 'search' && !commandMode && (
              <div className="palette-filters">
                <span className="palette-header">{t('palette.filtersHint')}</span>
                <span className="palette-chips">
                  {([['palette.exTag', 'palette.filterTag'], ['palette.exPath', 'palette.filterPath'], ['palette.exNot', 'palette.filterNot'], ['palette.exQuotes', 'palette.filterQuotes']] as const).map(([example, key]) => (
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
