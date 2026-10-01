// Links a move leaves as they are but whose resolution changes (D-019: an
// ambiguous link is never resolved silently): in the rename and folder-move
// previews, by source note, so whoever moves decides whether to go ahead.
import type { LinkState, Shift, ShiftGroup } from './api.ts'
import { useT } from './i18n.tsx'
import { Icon, noteName } from './ui.tsx'
import { usePathLabels } from './spaces.tsx'

type Label = (path: string) => string

const target = (s: LinkState, label: Label) => (s.status === 'resolved' ? label(s.path) : '')

export const shiftCount = (groups: ShiftGroup[]) => groups.reduce((n, g) => n + g.links, 0)

/** The notice after a move whose report has shifted links: how many, and in which notes (the first five). */
export function shiftedNotice(t: ReturnType<typeof useT>, name: string, groups: ShiftGroup[]): string {
  const n = shiftCount(groups)
  if (n === 0) return ''
  const names = groups.map((g) => noteName(g.path))
  const notes = names.length > 5 ? t('move.more', { notes: names.slice(0, 5).join(', '), n: names.length - 5 }) : names.join(', ')
  return t(n === 1 ? 'move.shiftedOne' : 'move.shiftedMany', { name, n, notes })
}

function describe(t: ReturnType<typeof useT>, c: Shift, label: Label): string {
  if (c.code === 'resolves') return t(c.before.status === 'ambiguous' ? 'shift.resolvesAmbiguous' : 'shift.resolvesMissing', { target: target(c.after, label) })
  if (c.code === 'ambiguous') return t('shift.ambiguous', { candidates: c.after.status === 'ambiguous' ? c.after.candidates.map(label).join(', ') : '' })
  if (c.code === 'retargets') return t('shift.retargets', { target: target(c.after, label), was: target(c.before, label) })
  return t('shift.breaks')
}

export function ShiftPreview({ groups }: { groups: ShiftGroup[] }) {
  const t = useT()
  const { label } = usePathLabels()
  if (groups.length === 0) return null
  const n = shiftCount(groups)
  return (
    <section className="shifts" aria-label={t(n === 1 ? 'shift.titleOne' : 'shift.titleMany', { n })}>
      <div className="shifts-head">
        <span className="shifts-icon">{Icon.alert}</span>
        <span>
          <strong>{t(n === 1 ? 'shift.titleOne' : 'shift.titleMany', { n })}</strong>
          <span className="shifts-hint">{t('shift.hint')}</span>
        </span>
      </div>
      {groups.map((g) => (
        <div className="shifts-group" key={g.path}>
          <div className="shifts-src">
            <span>{label(g.path)}</span>
            <span className="shifts-count">{t(g.links === 1 ? 'shift.countOne' : 'shift.countMany', { n: g.links })}</span>
          </div>
          {g.changes.map((c, i) => (
            <div className="shifts-row" key={i}>
              <code>{c.raw}</code> <span>{describe(t, c, label)}</span>
            </div>
          ))}
        </div>
      ))}
    </section>
  )
}
