// «Home»: where vihko opens by default and where the sidebar's
// logo always leads. The person's recent notes, what others changed in what
// they read, what was shared with them lately, and the quick actions. All of
// it from GET /api/home (the index, the history and their notices): nothing
// is kept for it, and nothing in it is anything they can't read.
import { useEffect, useState } from 'react'
import { Button } from 'react-aria-components'
import { ApiError, api, type HomeView } from './api.ts'
import { useDates } from './history/ui.tsx'
import { errorText, useT } from './i18n.tsx'
import { SearchButton } from './Palette.tsx'
import { noteHref, usePathLabels } from './spaces.tsx'
import { Icon, MenuButton, ThemeToggle } from './ui.tsx'
import './home.css'

export interface HomeProps {
  user: { username: string }
  /** Something to reload for (the tree changed): Home is asked again. */
  refresh: unknown
  onOpen: (path: string) => void
  /** Shows a folder or space in the sidebar (on a phone, opens the drawer). */
  onReveal: (path: string) => void
  onNewNote: (() => void) | null
  onToday: (() => void) | null
  onSearch: () => void
  onNewSpace: (() => void) | null
  onUnauthorized: () => void
}

export function HomePage({ user, refresh, onOpen, onReveal, onNewNote, onToday, onSearch, onNewSpace, onUnauthorized }: HomeProps) {
  const t = useT()
  const dates = useDates()
  const labels = usePathLabels()
  const [view, setView] = useState<HomeView | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api.home().then((v) => { if (live) { setView(v); setError(null) } }).catch((err) => {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized()
      if (live) setError(errorText(t, err))
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh])

  const link = (path: string, title: string, by?: string | null) => (
    <a className="home-note" href={noteHref(path)} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); onOpen(path) }}>
      <span className="home-note-title">{title}</span>
      <span className="home-note-where">{by ? t('home.changedBy', { where: labels.where(path, true), who: by }) : labels.where(path, true)}</span>
    </a>
  )
  const byText = (by: HomeView['changed'][number]['by']) => {
    if (!by) return null
    if (by.kind === 'external') return t('home.byOutside')
    if (by.kind === 'agent') return t('history.agentPlain', { name: by.name ?? t('home.anAgent'), user: by.onBehalfOf ?? '' })
    return by.name
  }

  return (
    <>
      <header className="main-head">
        <MenuButton />
        <span className="spacer" />
        <SearchButton />
        <ThemeToggle />
      </header>
      <div className="home-page">
        <div className="home-top">
          {/* The house: Home is vihko's start page, never a space (even one called «Home»: spaces have their people mark). */}
          <h1 className="home-title">{Icon.home}<span>{t('home.title')}</span></h1>
          <p className="home-hello">{t('home.hello', { user: user.username })}</p>
        </div>
        <div className="home-actions" role="group" aria-label={t('home.actions')}>
          {onNewNote && <Button className="btn btn-primary" onPress={onNewNote}>{Icon.plus}{t('home.newNote')}</Button>}
          {onToday && <Button className="btn" onPress={onToday}>{Icon.calendar}{t('shell.today')}</Button>}
          <Button className="btn" onPress={onSearch}>{Icon.search}{t('home.search')}</Button>
          {onNewSpace && <Button className="btn" onPress={onNewSpace}>{Icon.people}{t('home.newSpace')}</Button>}
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
        {!view && !error && <p className="home-empty">{t('common.loading')}</p>}
        {view && (
          <div className="home-grid">
            <section className="home-card" aria-labelledby="home-recent">
              <h2 id="home-recent">{t('home.recent')}</h2>
              {view.recent.length === 0 ? <p className="home-empty">{t('home.recentEmpty')}</p> : (
                <ul className="home-list">
                  {view.recent.map((n) => (
                    <li key={n.path}>
                      {link(n.path, n.title)}
                      <span className="home-when">{dates.dateTime(n.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="home-card" aria-labelledby="home-changed">
              <h2 id="home-changed">{t('home.changed')}</h2>
              {view.changed.length === 0 ? <p className="home-empty">{t('home.changedEmpty')}</p> : (
                <ul className="home-list">
                  {view.changed.map((n) => {
                    const by = byText(n.by)
                    return (
                      <li key={n.path}>
                        {link(n.path, n.title, by)}
                        <span className="home-when">{dates.dateTime(n.at)}</span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
            <section className="home-card home-card-wide" aria-labelledby="home-shared">
              <h2 id="home-shared">{t('home.shared')}</h2>
              {view.shared.length === 0 ? <p className="home-empty">{t('home.sharedEmpty')}</p> : (
                <ul className="home-list">
                  {view.shared.map((s) => (
                    <li key={`${s.path}#${s.at}`}>
                      <Button className="home-note home-shared" onPress={() => onReveal(s.path)}>
                        <span className="home-note-title">{s.kind === 'space' ? Icon.people : Icon.folder}{s.kind === 'space' ? s.name : s.owner ? `${s.name} · ${t('spaces.of', { owner: s.owner })}` : s.name}</span>
                        <span className="home-note-where">{t(s.kind === 'space' ? 'home.sharedSpace' : 'home.sharedFolder', { by: s.by })}</span>
                      </Button>
                      <span className="home-when">{dates.dateTime(s.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </>
  )
}
