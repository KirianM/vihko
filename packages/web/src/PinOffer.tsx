// After opening one of an ambiguous link's candidates: the note
// you came from still has the ambiguous link, and this offers to pin it to
// the note you are now in. Only on that explicit press is anything written.
import { useEffect, useState } from 'react'
import { Button } from 'react-aria-components'
import { api } from './api.ts'
import { errorText, useT } from './i18n.tsx'
import { Icon, linkName, noteName } from './ui.tsx'
import './actions.css'

/** An ambiguous link someone followed: the note it is in, its text, where it is and the candidate opened. */
export interface PinOffer {
  source: string
  raw: string
  at?: number
  target: string
}

/** How long the confirmation stays once the link is pinned. */
const DONE_MS = 6000

export function PinOfferToast({ offer, onDismiss }: { offer: PinOffer; onDismiss: () => void }) {
  const t = useT()
  const [state, setState] = useState<{ kind: 'idle' | 'busy' } | { kind: 'done'; raw: string } | { kind: 'error'; message: string }>({ kind: 'idle' })
  const vars = { link: linkName(offer.raw), source: noteName(offer.source), target: noteName(offer.target) }

  useEffect(() => {
    if (state.kind !== 'done') return
    const timer = setTimeout(onDismiss, DONE_MS)
    return () => clearTimeout(timer)
  }, [state.kind]) // eslint-disable-line react-hooks/exhaustive-deps

  const pin = async () => {
    setState({ kind: 'busy' })
    try {
      const r = await api.pinLink(offer.source, offer.raw, offer.at, offer.target)
      setState({ kind: 'done', raw: r.raw })
    } catch (err) {
      setState({ kind: 'error', message: errorText(t, err) })
    }
  }

  return (
    <div className="toast toast-warn pin-offer">
      <span className="toast-icon">{Icon.alert}</span>
      <span className="toast-text" role="status">
        {state.kind === 'done' ? t('pin.done', { ...vars, raw: state.raw }) : t('pin.offer', vars)}
        {state.kind === 'error' && <span className="error-text">{state.message}</span>}
      </span>
      {state.kind !== 'done' && (
        <Button className="btn" onPress={() => void pin()} isDisabled={state.kind === 'busy'}>{t('pin.action')}</Button>
      )}
      <Button className="btn btn-icon btn-quiet" aria-label={t('common.dismiss')} onPress={onDismiss}>{Icon.close}</Button>
    </div>
  )
}
