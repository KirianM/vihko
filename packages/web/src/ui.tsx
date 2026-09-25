// Piezas pequeñas compartidas: marca, iconos y el botón de tema.
import { Button } from 'react-aria-components'
import { useT } from './i18n.tsx'
import { useTheme } from './theme.ts'

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20c4-1 7-4 8-9 1 5 4 8 8 9" />
      <path d="M12 11V3" />
      <circle cx="12" cy="3" r="1" />
    </svg>
  )
}

export function Brand({ size }: { size?: number }) {
  const t = useT()
  return (
    <div className="brand">
      <Mark size={size} />
      <span>{t('app.name')}</span>
    </div>
  )
}

export const Icon = {
  check: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>,
  plus: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>,
  search: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>,
  chevron: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>,
  alert: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>,
  logout: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>,
  moon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>,
  sun: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>,
}

export function ThemeToggle() {
  const t = useT()
  const { effective, toggle } = useTheme()
  const dark = effective === 'dark'
  return (
    <Button className="btn btn-icon" aria-label={t(dark ? 'theme.toLight' : 'theme.toDark')} onPress={toggle}>
      {dark ? Icon.sun : Icon.moon}
    </Button>
  )
}

export function Crumbs({ path }: { path: string | null }) {
  const parts = path ? path.split('/') : []
  return (
    <span className="crumbs">
      {parts.slice(0, -1).map((c) => `${c} / `).join('')}
      {parts.length > 0 && <b>{parts[parts.length - 1]!.replace(/\.md$/i, '')}</b>}
    </span>
  )
}
