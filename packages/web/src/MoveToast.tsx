// Notice after a rename or move that could not rewrite every link: which notes
// were left behind and whether the old name was kept as an alias for them.
import { Button } from 'react-aria-components'
import type { MoveReport } from './api.ts'
import { useT } from './i18n.tsx'
import { Icon, noteName } from './ui.tsx'
import './actions.css'

export function MoveToast({ report, onDismiss }: { report: MoveReport; onDismiss: () => void }) {
  const t = useT()
  // The moved note itself is listed when the alias could not be added: its links are not the issue.
  const notes = report.failed.filter((f) => f.path !== report.to).map((f) => noteName(f.path)).join(', ')
  const vars = { name: noteName(report.to), notes, old: report.aliasAdded ?? '' }
  return (
    <div className="toast toast-warn">
      <span className="toast-icon">{Icon.alert}</span>
      <span className="toast-text" role="alert">{t(report.aliasAdded ? 'move.partialAlias' : 'move.partial', vars)}</span>
      <Button className="btn btn-icon btn-quiet" aria-label={t('common.dismiss')} onPress={onDismiss}>{Icon.close}</Button>
    </div>
  )
}
