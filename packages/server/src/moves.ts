// Moves made outside thoth (D-031.4): a note that disappears from one path
// and appears at another, in the same scan or watcher batch (or a few
// seconds apart, for tools that write the copy and remove the original in
// two steps), is the same note if both carry the same `uid` or, without a
// `uid`, the very same content. Anything less certain is not a move:
//
// - Several notes that could be the one (the same `uid` or the same content
//   on more than one path, removed or added): no guess, no move.
// - A rename that also changes the text of a note without `uid`: its hash
//   changes, so it is seen as a removal and an addition (documented cost of
//   D-015; the `uid` is what makes it traceable).
// - An empty note (only whitespace) never matches by content: every empty
//   note looks the same.

/** A move detected by the indexer. */
export interface DetectedMove {
  from: string
  to: string
  /** What proved it was the same note. */
  by: 'uid' | 'hash'
}

/** A note that left or entered the index. `recent`: seen in an earlier batch, still within the window. */
export interface MoveCandidate {
  path: string
  uid: string | null
  hash: string
  /** Only whitespace: never matched by content. */
  blank?: boolean
  recent?: boolean
}

/**
 * Pairs removed notes with added ones: first by `uid`, then, among those
 * with no `uid` on either side, by content hash. A pair is only made when
 * each side is the only candidate with that `uid` (or hash), and at least one
 * side is new in this batch (two old ones were already weighed together).
 */
export function matchMoves(removed: readonly MoveCandidate[], added: readonly MoveCandidate[]): { from: MoveCandidate; to: MoveCandidate; by: DetectedMove['by'] }[] {
  const out: { from: MoveCandidate; to: MoveCandidate; by: DetectedMove['by'] }[] = []
  const pair = (rs: readonly MoveCandidate[], as: readonly MoveCandidate[], key: (c: MoveCandidate) => string | null, by: DetectedMove['by']) => {
    const byKey = (list: readonly MoveCandidate[]) => {
      const m = new Map<string, MoveCandidate[]>()
      for (const c of list) {
        const k = key(c)
        if (k === null) continue
        let l = m.get(k)
        if (!l) m.set(k, (l = []))
        l.push(c)
      }
      return m
    }
    const aByKey = byKey(as)
    for (const [k, r] of byKey(rs)) {
      const a = aByKey.get(k)
      if (r.length !== 1 || a?.length !== 1) continue
      const from = r[0]!
      const to = a[0]!
      if (from.path === to.path || (from.recent && to.recent)) continue
      out.push({ from, to, by })
    }
  }
  pair(removed, added, (c) => c.uid, 'uid')
  // Content only speaks for notes without identity: one with a `uid` that
  // didn't pair by it (a duplicated `uid`) is not guessed by its text either.
  const noUid = (c: MoveCandidate) => c.uid === null
  pair(removed.filter(noUid), added.filter((c) => noUid(c) && !c.blank), (c) => c.hash, 'hash')
  return out
}
