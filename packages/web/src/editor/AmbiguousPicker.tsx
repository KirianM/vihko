// An ambiguous link (never resolved silently) opens this picker, from
// the editor or from the panel's links: its candidates, by title and path.
// Opening one goes there (and the note view offers «Pin this destination»);
// «Pin» rewrites that link, right here, so it leads to that note alone
// Nothing is written unless someone asks.
//
// A GridList rather than a ListBox: each row has a second action (Pin), and
// a ListBox option can't hold a button. The keyboard moves between rows with
// the arrows and into the row's button with → ; on a phone every target is
// the full touch size.
import { useState } from 'react'
import { Button, Dialog, GridList, GridListItem, Heading, Popover } from 'react-aria-components'
import { api } from '../api.ts'
import { errorText, useT } from '../i18n.tsx'
import { linkName } from '../ui.tsx'
import { usePathLabels } from '../spaces.tsx'
import './picker.css'

/** An ambiguous link somewhere in the note: its text, where it is (a hint), and where it may lead. */
export interface AmbiguousLink {
  raw: string
  at?: number
  candidates: readonly string[]
}

/** The picker, open on a link, anchored to what was clicked. */
export interface PickerState {
  link: AmbiguousLink
  anchor: { current: HTMLElement }
}

export function AmbiguousPicker({ source, state, titles, onClose, onOpen, onPinned }: {
  /** The note holding the link. */
  source: string
  state: PickerState
  /** Titles of the candidates, by path (those missing show the file name). */
  titles: Record<string, string>
  onClose: () => void
  /** Open that candidate (the note view offers to pin it there). */
  onOpen: (target: string) => void
  /** The link was rewritten; `raw` is how it reads now. */
  onPinned: (target: string, raw: string) => void
}) {
  const t = useT()
  const labels = usePathLabels()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { link } = state
  const name = linkName(link.raw)
  const titleOf = (p: string) => titles[p] ?? p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '')

  const pin = async (target: string) => {
    setBusy(target)
    setError(null)
    try {
      const r = await api.pinLink(source, link.raw, link.at, target)
      onPinned(target, r.raw)
    } catch (err) {
      setError(errorText(t, err))
      setBusy(null)
    }
  }

  return (
    <Popover className="menu-popover picker-popover" triggerRef={state.anchor} isOpen placement="bottom start" onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog className="picker" aria-label={t('picker.title', { name })}>
        <Heading slot="title" className="picker-head">{t('picker.title', { name })}</Heading>
        <GridList className="picker-list" aria-label={t('picker.title', { name })} items={link.candidates.map((p) => ({ id: p }))}
          autoFocus="first" onAction={(key) => onOpen(String(key))} disabledKeys={busy ? link.candidates : []}>
          {(item) => (
            <GridListItem id={item.id} className="picker-item" textValue={titleOf(item.id)}>
              <span className="picker-text">
                <span className="picker-title">{titleOf(item.id)}</span>
                <span className="picker-path">{labels.label(item.id)}</span>
              </span>
              <Button className="btn btn-sm picker-pin" aria-label={t('picker.pinLabel', { path: labels.label(item.id) })} isDisabled={busy !== null}
                onPress={() => void pin(item.id)}>
                {busy === item.id ? t('picker.pinning') : t('picker.pin')}
              </Button>
            </GridListItem>
          )}
        </GridList>
        {error ? <p className="error-text picker-note" role="alert">{error}</p> : <p className="picker-note">{t('picker.hint')}</p>}
      </Dialog>
    </Popover>
  )
}
