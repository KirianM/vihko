// «Move with a warning» (D-038): when moving a note or a folder changes who
// can see it, the move's preview says who gains and who loses access (people
// and groups by name, agent keys counted), and the move waits for an explicit
// confirmation. Access comes from the folder, so a move takes on the new
// folder's permissions.
import { useId } from 'react'
import type { AudienceChange } from './api.ts'
import { useLang, useT } from './i18n.tsx'
import { Icon } from './ui.tsx'
import './permissions.css'

/** Whether moving changes who can see it. */
export function audienceChanges(a: AudienceChange | undefined | null): boolean {
  if (!a) return false
  return a.users.gain.length + a.users.lose.length + a.groups.gain.length + a.groups.lose.length + a.keys.gain + a.keys.lose > 0
}

/** The warning, with the confirmation the move needs (`confirmed`). Nothing when access doesn't change. */
export function AudienceWarning({ audience, confirmed, onConfirm }: { audience: AudienceChange | undefined; confirmed: boolean; onConfirm: (v: boolean) => void }) {
  const t = useT()
  const lang = useLang()
  const id = useId()
  if (!audience || !audienceChanges(audience)) return null
  const list = new Intl.ListFormat(lang, { type: 'conjunction' })
  const who = (users: { username: string }[], groups: string[], keys: number) => list.format([
    ...users.map((u) => u.username),
    ...groups.map((g) => `@${g}`),
    ...(keys ? [t(keys === 1 ? 'audience.keysOne' : 'audience.keys', { n: keys })] : []),
  ])
  const lose = audience.users.lose.length + audience.groups.lose.length + audience.keys.lose > 0
  const gain = audience.users.gain.length + audience.groups.gain.length + audience.keys.gain > 0
  return (
    <div className="audience" role="group" aria-labelledby={`${id}-title`}>
      <div className="audience-head">
        <span className="audience-icon">{Icon.lock}</span>
        <span>
          <strong id={`${id}-title`}>{t('audience.title')}</strong>
          <span className="audience-hint">{t('audience.hint')}</span>
        </span>
      </div>
      {lose && <p className="audience-row"><span className="audience-tag audience-lose">{t('audience.loseTag')}</span>{who(audience.users.lose, audience.groups.lose, audience.keys.lose)}</p>}
      {gain && <p className="audience-row"><span className="audience-tag audience-gain">{t('audience.gainTag')}</span>{who(audience.users.gain, audience.groups.gain, audience.keys.gain)}</p>}
      <label className="check audience-confirm">
        <input type="checkbox" checked={confirmed} onChange={(e) => onConfirm(e.target.checked)} />
        <span className="check-text">{t('audience.confirm')}</span>
      </label>
    </div>
  )
}
