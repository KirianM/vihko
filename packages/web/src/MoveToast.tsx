// Notice after a rename or move that could not do everything: which notes'
// links were left behind (and whether the old name was kept as an alias for
// them), and which images could not go with the note.
import { Button } from 'react-aria-components'
import type { MoveReport } from './api.ts'
import { useT } from './i18n.tsx'
import { Icon, noteName } from './ui.tsx'
import './actions.css'

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export function MoveToast({ report, onDismiss }: { report: MoveReport; onDismiss: () => void }) {
  const t = useT()
  // The moved note itself is listed when the alias could not be added: its links are not the issue.
  const notes = report.failed.filter((f) => f.path !== report.to).map((f) => noteName(f.path)).join(', ')
  const vars = { name: noteName(report.to), notes, old: report.aliasAdded ?? '' }
  const images = (outcome: 'stayed' | 'copied') => report.images.failed.filter((f) => f.outcome === outcome).map((f) => fileName(f.path)).join(', ')
  const stayed = images('stayed')
  const copied = images('copied')
  const text = [
    notes && t(report.aliasAdded ? 'move.partialAlias' : 'move.partial', vars),
    stayed && t('move.imagesStayed', { name: vars.name, images: stayed }),
    copied && t('move.imagesCopied', { name: vars.name, images: copied }),
  ].filter(Boolean).join(' ')
  return (
    <div className="toast toast-warn">
      <span className="toast-icon">{Icon.alert}</span>
      <span className="toast-text" role="alert">{text}</span>
      <Button className="btn btn-icon btn-quiet" aria-label={t('common.dismiss')} onPress={onDismiss}>{Icon.close}</Button>
    </div>
  )
}
