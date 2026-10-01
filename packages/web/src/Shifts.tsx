// Links a move leaves as they are but whose resolution changes (D-019: an
// ambiguous link is never resolved silently): in the rename and folder-move
// previews, by source note, so whoever moves decides whether to go ahead.
// In words: each link by the name it shows, never its Markdown.
import type { LinkState, Shift, ShiftGroup } from './api.ts'
import { useT } from './i18n.tsx'
import { shownName } from './MovePreview.tsx'
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

/** A link that led to a note and will be broken: a move to another space lists those apart (MovePreview `BrokenRows`). */
const isBreak = (c: Shift) => c.code === 'breaks' && c.before.status === 'resolved'

/** `withoutBreaks`: leave out the links that will be broken, already listed apart. */
export function ShiftPreview({ groups, withoutBreaks = false }: { groups: ShiftGroup[]; withoutBreaks?: boolean }) {
  const t = useT()
  const { label } = usePathLabels()
  const shown = withoutBreaks
    ? groups.flatMap((g) => {
      const changes = g.changes.filter((c) => !isBreak(c))
      return changes.length ? [{ ...g, links: changes.length, changes }] : []
    })
    : groups
  if (shown.length === 0) return null
  const n = shiftCount(shown)
  return (
    <section className="shifts" aria-label={t(n === 1 ? 'shift.titleOne' : 'shift.titleMany', { n })}>
      <div className="shifts-head">
        <span className="shifts-icon">{Icon.alert}</span>
        <span>
          <strong>{t(n === 1 ? 'shift.titleOne' : 'shift.titleMany', { n })}</strong>
          <span className="shifts-hint">{t('shift.hint')}</span>
        </span>
      </div>
      {shown.map((g) => (
        <div className="shifts-group" key={g.path}>
          <div className="shifts-src">
            <span>{label(g.path)}</span>
            <span className="shifts-count">{t(g.links === 1 ? 'shift.countOne' : 'shift.countMany', { n: g.links })}</span>
          </div>
          {g.changes.map((c, i) => (
            <div className="shifts-row" key={i}>
              {t('shift.row', { name: shownName(c.raw), what: describe(t, c, label) })}
            </div>
          ))}
        </div>
      ))}
    </section>
  )
}
