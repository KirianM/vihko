// «Revert this change»: undo what one version changed, on the note
// as it is now, and keep everything written since. A three-way merge: the
// base is the version's text, what is wanted is the note right before that
// version, and what is there is the note now.
//
//   version → before   what reverting does (the revert's pieces)
//   version → now      what was written since (the later pieces)
//
// Both are word diffs (diff.ts, bounded like every diff of the history). A
// revert piece is applied to the note now unless a later piece touched the
// same text: then it is skipped and reported with its text. Pieces that only
// meet at the start of a line don't clash (a paragraph added right after the
// agent's section stays, and the section is reverted); pieces that meet inside
// a line do («Postgres» → «Postgres 17» keeps «Postgres»). A piece the note
// already undid is left alone.
//
// On an open note the result is exact splices (edits.ts), computed on the text
// the editors have at that moment, so it never takes what someone is typing.
import { readFrontmatter, setFrontmatterKey } from '@vihko/core'
import { spliceOf, type Splice } from '../edits.ts'
import type { Actor } from '../actor.ts'
import { NoteError, type NoteService } from '../notes.ts'
import { contextAfter, contextBefore, wordDiff } from './diff.ts'
import { HistoryError, type HistoryReader } from './reader.ts'
import type { Recorder } from './recorder.ts'

/** Text `[a, b)` of the base replaced with `ins`. */
interface Hunk { a: number; b: number; ins: string }

/** A piece that is reverted: what the version wrote goes, what was there before comes back; with a bit of the note around it. */
export interface RevertedPiece { before: string; removed: string; restored: string; after: string }

/**
 * A piece that is not reverted because it was changed later: what the version
 * wrote there, what reverting would have brought back, and what the note has
 * there now; with a bit of the note around it.
 */
export interface SkippedPiece { before: string; version: string; previous: string; current: string; after: string }

export interface RevertPlan {
  /** Over the note now, in order (each one on the text the previous ones leave). */
  splices: Splice[]
  /** The first MAX_PIECES of each; `counts` has them all. */
  reverted: RevertedPiece[]
  skipped: SkippedPiece[]
  /** `already`: pieces the note already has as they were before the version (nothing to do). */
  counts: { reverted: number; skipped: number; already: number }
}

/** What reverting did (or, with `dryRun`, would do). */
export interface RevertReport extends Omit<RevertPlan, 'splices'> {
  dryRun: boolean
  /** Whether the note changed (never with `dryRun`). */
  changed: boolean
  /** The note's ETag: after the revert, or as it is (`dryRun`, or nothing to revert). */
  etag: string
}

const WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u

/** Pieces listed in a report (the counts are always whole). */
const MAX_PIECES = 100
/** Characters of the note shown on each side of a piece: from its line, or the nearest one with text when the piece is a whole line. */
const CONTEXT = 40
/** A piece's text longer than this is shortened in the middle. */
const MAX_PIECE_TEXT = 1_000

/**
 * The changes that turn `a` into `b`, in `a`'s positions, apart from each
 * other (an unchanged stretch between two). The smallest diff, with each line
 * break on its own (diff.ts, `merge`), so what changed on one line never
 * holds back what changed on another, even the next one; words changed with
 * only spaces between them on a line are one change («the quick fox» → «a
 * slow dog» is reverted whole or not at all, never word by word).
 */
function hunksOf(a: string, b: string): Hunk[] {
  const out: Hunk[] = []
  // What both sides share at either end isn't part of the change (words carry
  // their spaces: «Sync (v2)» → «Sync» is « (v2)» removed), cut only where a
  // word ends on both sides, never inside one («Sync» → «Syncthing» stays whole).
  const push = (h: Hunk) => {
    const removed = a.slice(h.a, h.b)
    const cut = (s: string, i: number) => i <= 0 || i >= s.length || !WORD_CHAR.test(s[i - 1]!) || !WORD_CHAR.test(s[i]!)
    let p = 0
    while (p < removed.length && p < h.ins.length && removed[p] === h.ins[p] && removed[p] !== '\n') p++
    while (p > 0 && !(cut(removed, p) && cut(h.ins, p))) p--
    let s = 0
    while (s < removed.length - p && s < h.ins.length - p && removed[removed.length - 1 - s] === h.ins[h.ins.length - 1 - s] && h.ins[h.ins.length - 1 - s] !== '\n') s++
    while (s > 0 && !(cut(removed, removed.length - s) && cut(h.ins, h.ins.length - s))) s--
    out.push({ a: h.a + p, b: h.b - s, ins: h.ins.slice(p, h.ins.length - s) })
  }
  let pos = 0
  let open: Hunk | null = null
  /** Spaces after the open change: part of it if another change follows. */
  let spaces = ''
  for (const [op, text] of wordDiff(a, b, { merge: true }).ops) {
    if (op === 0) {
      if (open && !spaces && /^[^\S\n]+$/.test(text)) spaces = text
      else if (open) { push(open); open = null; spaces = '' }
      pos += text.length
      continue
    }
    if (open && spaces) { open.b = pos; open.ins += spaces }
    spaces = ''
    open ??= { a: pos, b: pos, ins: '' }
    if (op === -1) { pos += text.length; open.b = pos }
    else open.ins += text
  }
  if (open) push(open)
  return out
}

/** The first index whose hunk ends at or after `x` (hunks sorted and apart). */
function firstEndingFrom(list: readonly Hunk[], x: number): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid]!.b < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

const shorten = (s: string) => (s.length <= MAX_PIECE_TEXT ? s : `${s.slice(0, MAX_PIECE_TEXT / 2)}…${s.slice(-MAX_PIECE_TEXT / 2)}`)

/**
 * The note's `uid` is its identity, not its path: if the version gave the note its
 * `uid`, reverting doesn't take it away (it goes back exactly where that
 * version put it).
 */
function keepUid(version: string, previous: string, uidKey: string): string {
  const uidIn = (text: string) => {
    const fm = readFrontmatter(text)
    const v = fm.error ? null : fm.data[uidKey]
    return typeof v === 'string' || typeof v === 'number' ? String(v) : null
  }
  const uid = uidIn(version)
  if (uid === null || uidIn(previous) !== null || readFrontmatter(previous).error) return previous
  return setFrontmatterKey(previous, uidKey, uid)
}

/**
 * How to undo, on `current`, what `version` changed from `previous`: the
 * splices, what they revert and what they leave because it was changed later.
 */
export function planRevert(version: string, previous: string, current: string, opts: { uidKey?: string } = {}): RevertPlan {
  const wanted = keepUid(version, previous, opts.uidKey ?? 'uid')
  const reverts = hunksOf(version, wanted)
  const later = hunksOf(version, current)
  // Where the later pieces move the rest of the text: `shift[k]` is the sum for the first k.
  const shift = [0]
  for (const l of later) shift.push(shift.at(-1)! + l.ins.length - (l.b - l.a))

  /**
   * A position of the version in the note now. `right`: after what was
   * inserted exactly there since; `left`: before it.
   */
  const toNow = (x: number, side: 'left' | 'right'): number => {
    const k = firstEndingFrom(later, x)
    const l = later[k]
    if (!l) return x + shift[k]!
    if (l.b === x && l.a < l.b) return x + shift[k + 1]!
    if (l.a === x && l.b === x) return x + shift[side === 'right' ? k + 1 : k]!
    if (l.a < x && x < l.b) return l.a + shift[k]! + (side === 'right' ? l.ins.length : 0)
    return x + shift[k]!
  }

  /** Whether two pieces that meet at `x` (`left` ends there, `right` starts there) are on separate lines. */
  const apartAt = (x: number, left: Hunk, right: Hunk) =>
    x === 0 || version[x - 1] === '\n'
    || (right.a === right.b && right.ins.startsWith('\n'))
    || (left.a === left.b && left.ins.endsWith('\n'))

  /** Whether the later piece `l` clashes with the revert piece `r`. */
  const clashes = (r: Hunk, l: Hunk): boolean => {
    if (Math.max(l.a, r.a) < Math.min(l.b, r.b)) return true
    if (l.a === l.b && r.a < l.a && l.a < r.b) return true
    if (r.a === r.b && l.a < r.a && r.a < l.b) return true
    // They meet at one point: both inserted there (the revert goes first), or one ends where the other starts.
    if (r.a === r.b && l.a === l.b && r.a === l.a) return !apartAt(r.a, r, l)
    if (l.b === r.a) return !apartAt(r.a, l, r)
    if (r.b === l.a) return !apartAt(r.b, r, l)
    return false
  }

  const applied: { from: number; to: number; r: Hunk }[] = []
  const clusters: { a: number; b: number; rs: Hunk[]; from: number; to: number }[] = []
  let already = 0
  for (const r of reverts) {
    const i0 = firstEndingFrom(later, r.a)
    const near: number[] = []
    for (let i = i0; i < later.length && later[i]!.a <= r.b; i++) near.push(i)
    if (near.some((i) => { const l = later[i]!; return l.a === r.a && l.b === r.b && l.ins === r.ins })) { already++; continue }
    const clash = near.filter((i) => clashes(r, later[i]!))
    const from = r.a === r.b ? toNow(r.a, 'left') : toNow(r.a, 'right')
    const to = r.a === r.b ? from : toNow(r.b, 'left')
    if (clash.length === 0 && current.slice(from, to) === version.slice(r.a, r.b)) {
      applied.push({ from, to, r })
      continue
    }
    // Skipped, with what was changed later around it (in the version, and in the note now).
    const first = clash.length ? later[clash[0]!]! : null
    const last = clash.length ? later[clash.at(-1)!]! : null
    const a = Math.min(r.a, first?.a ?? r.a)
    const b = Math.max(r.b, last?.b ?? r.b)
    const cFrom = clash.length ? a + shift[clash[0]!]! : from
    const cTo = clash.length ? b + shift[clash.at(-1)! + 1]! : to
    const prev = clusters.at(-1)
    if (prev && a <= prev.b) {
      prev.b = Math.max(prev.b, b)
      prev.rs.push(r)
      prev.from = Math.min(prev.from, cFrom)
      prev.to = Math.max(prev.to, cTo)
    } else clusters.push({ a, b, rs: [r], from: cFrom, to: cTo })
  }

  // From the last one: the earlier positions stay valid.
  const splices = [...applied].reverse().map(({ from, to, r }) => spliceOf(current, from, to, r.ins)).filter((s) => s.remove || s.insert)
  const reverted = applied.slice(0, MAX_PIECES).map(({ from, to, r }) => ({
    before: contextBefore(current, from, CONTEXT),
    removed: shorten(version.slice(r.a, r.b)),
    restored: shorten(r.ins),
    after: contextAfter(current, to, CONTEXT),
  }))
  const skipped = clusters.slice(0, MAX_PIECES).map((c) => {
    let previousText = ''
    let at = c.a
    for (const r of c.rs) { previousText += version.slice(at, r.a) + r.ins; at = r.b }
    previousText += version.slice(at, c.b)
    return {
      before: contextBefore(current, c.from, CONTEXT),
      version: shorten(version.slice(c.a, c.b)),
      previous: shorten(previousText),
      current: shorten(current.slice(c.from, c.to)),
      after: contextAfter(current, c.to, CONTEXT),
    }
  })
  return { splices, reverted, skipped, counts: { reverted: applied.length, skipped: clusters.length, already } }
}

/**
 * Reverts version `id` of the note at `path` (following its moves) on the
 * note as it is now: one write through the core (an open note changes live
 * for its editors, as exact splices), by `actor`, one commit with the reason
 * `reverted`, which can be reverted in turn. A version that creates or
 * deletes the note has nothing to undo on its text (`not_revertible`):
 * deleting is what undoes a creation, and restoring the version before is
 * what undoes a deletion. With `ifMatch`, only if the note is still that one
 * (an open note as its editors have it, as every read gives it). `guard`
 * sees every text the revert is planned on, the one the write finds too, and
 * may refuse it by throwing (an agent never reverts on a note hidden from it).
 */
export async function revertVersion(
  deps: { reader: HistoryReader; notes: NoteService; recorder: Pick<Recorder, 'operation'>; uidKey?: string },
  path: string,
  id: string,
  opts: { actor: Actor; ifMatch?: string; dryRun?: boolean; guard?: (text: string) => void },
): Promise<RevertReport> {
  const v = await deps.reader.version(path, id)
  if (!v) throw new HistoryError('not_found', `${id} is not a version of ${path}`)
  const { text, before } = v
  if (text === null) throw new HistoryError('not_revertible', 'that version deletes the note: restore the version before it instead')
  if (before === null) throw new HistoryError('not_revertible', 'that version creates the note: there is nothing before it to go back to')
  const now = deps.notes.readCurrent(path)
  opts.guard?.(now.text)
  if (opts.ifMatch !== undefined && opts.ifMatch !== now.etag) throw new NoteError('precondition_failed', `the note has changed: ${path}`, now.etag)
  const plan = (current: string) => {
    opts.guard?.(current)
    return planRevert(text, before, current, { uidKey: deps.uidKey })
  }
  const preview = plan(now.text)
  const report = (p: RevertPlan, extra: { dryRun: boolean; changed: boolean; etag: string }): RevertReport =>
    ({ ...extra, reverted: p.reverted, skipped: p.skipped, counts: p.counts })
  if (opts.dryRun || preview.splices.length === 0) return report(preview, { dryRun: !!opts.dryRun, changed: false, etag: now.etag })

  // Planned again on the text the write finds: an open note may have changed since the preview.
  let done = preview
  const { etag } = await deps.recorder.operation(opts.actor, { code: 'reverted', id: v.id, at: v.at }, () =>
    deps.notes.edit(path, (current) => { done = plan(current); return done.splices }, { ifMatch: opts.ifMatch, actor: opts.actor }))
  return report(done, { dryRun: false, changed: done.splices.length > 0, etag })
}
