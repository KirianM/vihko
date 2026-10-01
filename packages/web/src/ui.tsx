// Small shared pieces: brand mark, icons and the theme button.
import { createContext, useContext } from 'react'
import { Button } from 'react-aria-components'
import { useT } from './i18n.tsx'
import { usePathLabels, useSpaces } from './spaces.tsx'
import { useTheme } from './theme.ts'

export function Mark({ size = 22 }: { size?: number }) {
  return (
    // A notebook open on its spine, seen end-on (the V), and the agents' diamond above it.
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 6 H7 L12 13.5 L17 6 H21.5 L12 20.5 Z" />
      <path d="M12 3.5 L14.5 6 L12 8.5 L9.5 6 Z" />
    </svg>
  )
}

/**
 * For a field where someone types a user's or a group's name: phones don't
 * capitalise, correct or spell-check it (names are usually lowercase, and a
 * keyboard that starts with a capital suggests the wrong spelling).
 */
export const NAME_INPUT = { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } as const

/** Goes to «Home» (D-056.35): the sidebar's logo is the way there, from anywhere. Null outside the shell. */
export const GoHomeContext = createContext<(() => void) | null>(null)

/** The logo and the name; in the shell, a link to «Home». */
export function Brand({ size }: { size?: number }) {
  const t = useT()
  const home = useContext(GoHomeContext)
  const inside = <><Mark size={size} /><span>{t('app.name')}</span></>
  if (!home) return <div className="brand">{inside}</div>
  return (
    <a className="brand brand-link" href="./" aria-label={t('home.go')} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); home() }}>
      {inside}
    </a>
  )
}

/** Where «Back» on a settings page goes (D-056.35): where the person was before it (Shell). Null: no button. */
export const BackContext = createContext<(() => void) | null>(null)

/** «Back», on the settings pages: to the note, Home or page the person came from. */
export function BackButton() {
  const t = useT()
  const back = useContext(BackContext)
  if (!back) return null
  return <Button className="btn btn-quiet back-btn" onPress={back}>{Icon.prev}<span>{t('common.back')}</span></Button>
}

export const Icon = {
  check: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>,
  plus: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>,
  search: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>,
  chevron: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>,
  alert: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>,
  logout: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>,
  more: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>,
  rename: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>,
  trash: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>,
  image: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.8" /><path d="m21 16-5-5-9 9" /></svg>,
  close: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>,
  moon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>,
  menu: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>,
  list: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></svg>,
  comment: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>,
  calendar: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /><path d="M12 14h.01" strokeWidth="3" /></svg>,
  prev: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>,
  next: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>,
  folder: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>,
  folderPlus: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 10v6M9 13h6" /></svg>,
  eyeOff: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.9 3.9M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /><path d="m3 3 18 18" /></svg>,
  lock: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>,
  people: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8" /></svg>,
  sun: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>,
  // The formatting bar (editor/FormatBar.tsx), in the same line style as list and comment.
  heading: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 5v14M18 5v14M6 12h12" /></svg>,
  bold: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" /></svg>,
  italic: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M10 5h8M6 19h8M14 5l-4 14" /></svg>,
  strike: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12h16M16.5 7.5C16 5.6 14.3 4.5 12 4.5c-2.8 0-4.5 1.5-4.5 3.4 0 1.2.6 2.2 1.9 2.9M8 16.5c.5 1.9 2.2 3 4.5 3 2.8 0 4.5-1.5 4.5-3.4 0-.5-.1-.9-.3-1.3" /></svg>,
  code: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 7-5 5 5 5M15 7l5 5-5 5" /></svg>,
  link: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 13.5a4 4 0 0 0 5.7.4l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2" /><path d="M14 10.5a4 4 0 0 0-5.7-.4l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2" /></svg>,
  listOrdered: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 6h10M10 12h10M10 18h10" /><path d="M4 4.5 5.5 4v5M3.5 14.5c.3-.6.9-1 1.6-1 .8 0 1.4.5 1.4 1.2 0 1-1.6 1.7-3 3.3h3" strokeWidth="1.5" /></svg>,
  listTask: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 7h9M11 17h9" /><rect x="3" y="4" width="6" height="6" rx="1.5" /><rect x="3" y="14" width="6" height="6" rx="1.5" /><path d="m4.5 7 1.2 1.2L7.8 6" strokeWidth="1.5" /></svg>,
  quote: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 5v14M10 8h10M10 12h10M10 16h6" /></svg>,
  codeBlock: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m10 9.5-2.5 2.5 2.5 2.5M14 9.5l2.5 2.5-2.5 2.5" /></svg>,
  table: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M12 10v10" /></svg>,
  // Saving: an open ring (it turns while it lasts, styles.css).
  saving: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-8-8" /></svg>,
  chevronDown:<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>,
}

/** An agent's mark, as in the history: a diamond in accent (agents.css), never colour alone. */
export const Diamond = () => <span className="diamond" aria-hidden="true" />

export function ThemeToggle() {
  const t = useT()
  const { effective, toggle } = useTheme()
  const dark = effective === 'dark'
  return (
    <Button className="btn btn-icon theme-toggle" aria-label={t(dark ? 'theme.toLight' : 'theme.toDark')} onPress={toggle}>
      {dark ? Icon.sun : Icon.moon}
    </Button>
  )
}

/** `[[Tareas#Hoy|las tareas]]` → `Tareas#Hoy`: what a wikilink names, without its visible text. */
export const linkName = (raw: string) => raw.replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('|')[0]!.trim()

/** A note's name: the file name without the extension. */
export const noteName = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')

/**
 * Folder path and note name. The folders give way first when space runs out,
 * so the name stays readable; on a phone they go on two lines.
 */
export function Crumbs({ path }: { path: string | null }) {
  const t = useT()
  const perms = useContext(FolderPermissionsContext)
  const labels = usePathLabels()
  const spaces = useSpaces()
  const shown = path ? spaces.show(path) : null
  const parts = path ? path.split('/') : []
  // The space and its folders as the person sees them (D-056): never `people/<me>` nor a space's folder id.
  const folders = shown ? [labels.spaceLabel(shown), ...shown.folders] : parts.slice(0, -1)
  const folder = parts.slice(0, -1).join('/')
  return (
    <>
      <span className="crumbs">
        {folders.length > 0 && <span className="crumbs-path">{folders.join(' / ')}<span className="crumbs-sep"> / </span></span>}
        {parts.length > 0 && <b>{parts[parts.length - 1]!.replace(/\.md$/i, '')}</b>}
      </span>
      {path && perms?.can(folder) && (
        <Button className="btn btn-icon btn-quiet crumbs-perm" aria-label={t('folder.permissionsOf', { folder: labels.label(folder) })} onPress={() => perms.open(folder)}>{Icon.people}</Button>
      )}
    </>
  )
}

/** Opens the permissions of a note's folder from the header, where the person may (Shell). */
export const FolderPermissionsContext = createContext<{ can: (folder: string) => boolean; open: (folder: string) => void } | null>(null)

/** Opens the folder drawer on a phone (there's no sidebar there). */
export const OpenNavContext = createContext<(() => void) | null>(null)

/** Header button for the folder drawer; only visible on a phone. */
export function MenuButton() {
  const t = useT()
  const open = useContext(OpenNavContext)
  if (!open) return null
  return <Button className="btn btn-icon mobile-only" aria-label={t('shell.openFolders')} onPress={open}>{Icon.menu}</Button>
}
