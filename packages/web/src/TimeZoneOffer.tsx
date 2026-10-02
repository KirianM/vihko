// Someone travelling: their profile's timezone (which decides «today» for
// daily notes and dates) is one, and their browser says another. vihko never
// changes it by itself: it offers, once for each pair in this browser, to
// use the browser's. A zone with the same time now (another name for it, or
// a neighbour) is no news.
import { useState } from 'react'
import { Button } from 'react-aria-components'
import { api, type Profile } from './api.ts'
import { errorText, useT } from './i18n.tsx'
import { Icon } from './ui.tsx'
import { browserTimeZone } from './Preferences.tsx'
import './actions.css'

const KEY = 'vihko.timezoneOffered'

/** A zone's offset from UTC now (`GMT+02:00`), or null for a zone the browser doesn't know. */
function offsetNow(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? null
  } catch {
    return null
  }
}

function offered(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

/**
 * The browser's timezone, if it's worth offering instead of the profile's
 * `saved` one: it isn't the same time now, and this browser hasn't offered
 * this change before. Offering it is remembered here (once is enough).
 */
export function timeZoneOffer(saved: string | null): string | null {
  const browser = browserTimeZone()
  if (!saved || saved === browser || offsetNow(saved) === offsetNow(browser)) return null
  const pair = `${saved}>${browser}`
  const before = offered()
  if (before.includes(pair)) return null
  try { localStorage.setItem(KEY, JSON.stringify([pair, ...before].slice(0, 20))) } catch { /* no storage: it may be offered again */ }
  return browser
}

export function TimeZoneToast({ saved, browser, onChanged, onDismiss }: {
  saved: string
  browser: string
  /** Switched: the profile as it is now. */
  onChanged: (p: Profile) => void
  onDismiss: () => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = (z: string) => z.replaceAll('_', ' ')
  const use = async () => {
    setBusy(true)
    setError(null)
    try {
      onChanged(await api.updateProfile({ timezone: browser }))
    } catch (err) {
      setError(errorText(t, err))
      setBusy(false)
    }
  }
  return (
    <div className="toast timezone-offer">
      <span className="toast-icon">{Icon.calendar}</span>
      <span className="toast-text" role="status">
        {t('timezone.offer', { browser: name(browser), saved: name(saved) })}
        {error && <span className="error-text">{error}</span>}
      </span>
      <Button className="btn" onPress={() => void use()} isDisabled={busy}>{t('timezone.use', { browser: name(browser) })}</Button>
      <Button className="btn btn-quiet" onPress={onDismiss}>{t('timezone.keep')}</Button>
    </div>
  )
}
