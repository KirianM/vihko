// «Move with a warning» (D-038, spec §3.3): when moving a note or a folder
// changes who can see it, the move's preview says who gains and who loses
// access (people and groups by name, agent keys counted), whose it becomes
// when it changes space (D-056), which links will name it by its path and
// which images are copied, and the move waits for an explicit confirmation.
// Access comes from the folder, so a move takes on the new folder's.
import { useId } from 'react'
import type { AudienceChange, CrossSpaceLinks, SpaceOwner } from './api.ts'
import { useLang, useT } from './i18n.tsx'
import { useSpaces } from './spaces.tsx'
import { Icon } from './ui.tsx'
import './permissions.css'

/** Whether moving changes who can see it, or whose it is. */
export function audienceChanges(a: AudienceChange | undefined | null): boolean {
  if (!a) return false
  return a.users.gain.length + a.users.lose.length + a.groups.gain.length + a.groups.lose.length + a.keys.gain + a.keys.lose > 0 || !!a.owner
}

/** Whose it becomes, in words (spec §3.3): out of one's own space, into someone's, between shared spaces. */
function ownerText(t: ReturnType<typeof useT>, me: string, owner: { before: SpaceOwner; after: SpaceOwner }): string | null {
  const { before, after } = owner
  if (!after) return null
  const mine = (o: SpaceOwner) => o?.kind === 'personal' && o.owner.normalize('NFC') === me.normalize('NFC')
  if (after.kind === 'shared') return t(mine(before) ? 'audience.ownerToSpaceFromMine' : 'audience.ownerToSpace', { space: after.name })
  if (mine(after)) return t('audience.ownerToMine')
  return t('audience.ownerToPerson', { owner: after.owner })
}

/**
 * The warning, with the confirmation the move needs (`confirmed`). Nothing
 * when neither access nor whose it is changes. `cross`: the links it writes
 * across spaces; `copied`: how many images are copied to the new space.
 */
export function AudienceWarning({ audience, confirmed, onConfirm, cross, copied = 0 }: {
  audience: AudienceChange | undefined
  confirmed: boolean
  onConfirm: (v: boolean) => void
  cross?: CrossSpaceLinks
  copied?: number
}) {
  const t = useT()
  const lang = useLang()
  const { me } = useSpaces()
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
  const owner = audience.owner ? ownerText(t, me, audience.owner) : null
  return (
    <div className="audience" role="group" aria-labelledby={`${id}-title`}>
      <div className="audience-head">
        <span className="audience-icon">{Icon.lock}</span>
        <span>
          <strong id={`${id}-title`}>{t(owner ? 'audience.titleSpace' : 'audience.title')}</strong>
          <span className="audience-hint">{t(owner ? 'audience.hintSpace' : 'audience.hint')}</span>
        </span>
      </div>
      {owner && <p className="audience-row audience-owner">{owner}</p>}
      {lose && <p className="audience-row"><span className="audience-tag audience-lose">{t('audience.loseTag')}</span>{who(audience.users.lose, audience.groups.lose, audience.keys.lose)}</p>}
      {gain && <p className="audience-row"><span className="audience-tag audience-gain">{t('audience.gainTag')}</span>{who(audience.users.gain, audience.groups.gain, audience.keys.gain)}</p>}
      {cross && cross.incoming > 0 && <p className="audience-row">{t(cross.incoming === 1 ? 'audience.crossInOne' : 'audience.crossIn', { n: cross.incoming, path: cross.path })}</p>}
      {cross && cross.outgoing > 0 && <p className="audience-row">{t(cross.outgoing === 1 ? 'audience.crossOutOne' : 'audience.crossOut', { n: cross.outgoing })}</p>}
      {copied > 0 && <p className="audience-row">{t(copied === 1 ? 'audience.copiedOne' : 'audience.copied', { n: copied })}</p>}
      <label className="check audience-confirm">
        <input type="checkbox" checked={confirmed} onChange={(e) => onConfirm(e.target.checked)} />
        <span className="check-text">{t('audience.confirm')}</span>
      </label>
    </div>
  )
}
