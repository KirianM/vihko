// Word-level diff for the history (fast-diff). First by lines, then each
// changed block by words: every line, word, run of spaces or punctuation mark
// becomes one character, so a diff never splits a word and the semantic
// cleanup groups changes that belong together.
//
// fast-diff has no time limit, and a diff of two long texts that have little
// in common grows with the product of their sizes (a minute for two different
// 400 KB texts). So the work is bounded: past a number of lines the middle of
// the texts is one block, and a block past a number of words is shown as
// removed and added whole. Only texts with little in common get there.
import diff from 'fast-diff'

/** `[-1, text]` removed, `[1, text]` added, `[0, text]` the same. */
export type DiffOp = [-1 | 0 | 1, string]

export interface WordDiff {
  ops: DiffOp[]
  /** Words and punctuation marks added and removed (spaces don't count). */
  added: number
  removed: number
}

const WORD = /[\p{L}\p{M}\p{N}_]+|\s+|[^\p{L}\p{M}\p{N}_\s]/gu
/**
 * For a merge: each word or mark with the spaces after it (a lone space never
 * pairs two unrelated texts), and every line break on its own.
 */
const MERGE_WORD = /[\p{L}\p{M}\p{N}_]+[^\S\n]*|\n|[^\S\n]+|[^\p{L}\p{M}\p{N}_\s][^\S\n]*/gu
/** Code units for tokens: everything but the surrogate range. */
const MAX_TOKENS = 0xd800 + (0x10000 - 0xe000)
/** Lines (both texts, once their common start and end are left out) diffed line by line… */
const MAX_LINES = 6_000
/** …words of a changed block (both sides) diffed word by word… */
const MAX_BLOCK_WORDS = 6_000
/** …and, over all the blocks of one diff, the sum of their words squared (the worst case of each). */
const WORD_BUDGET = 40_000_000

const unit = (n: number) => String.fromCharCode(n < 0xd800 ? n : n + 0x800)
const index = (c: number) => (c < 0xd800 ? c : c - 0x800)

/** How many words and marks a text has (not spaces). */
export function countWords(text: string): number {
  let n = 0
  for (const m of text.matchAll(WORD)) if (!/^\s+$/.test(m[0])) n++
  return n
}

/**
 * The diff of two token lists, each token as one character; null if there are
 * too many different tokens. `cleanup`: short unchanged stretches between
 * changes join them.
 */
function tokenDiff(a: readonly string[], b: readonly string[], cleanup: boolean): DiffOp[] | null {
  const ids = new Map<string, number>()
  const tokens: string[] = []
  const encode = (list: readonly string[]): string | null => {
    let out = ''
    for (const t of list) {
      let id = ids.get(t)
      if (id === undefined) {
        if (tokens.length >= MAX_TOKENS) return null
        id = tokens.length
        ids.set(t, id)
        tokens.push(t)
      }
      out += unit(id)
    }
    return out
  }
  const ea = encode(a)
  const eb = ea === null ? null : encode(b)
  if (ea === null || eb === null) return null
  return (diff(ea, eb, undefined, cleanup) as DiffOp[]).map(([op, s]) => {
    let text = ''
    for (let i = 0; i < s.length; i++) text += tokens[index(s.charCodeAt(i))]
    return [op, text] as DiffOp
  })
}

/** Lines with their line break. */
function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/**
 * The diff that turns `a` into `b`, word by word. By default a short
 * unchanged stretch joins the changes around it, which reads better. `merge`
 * keeps the smallest diff instead, over words that carry their spaces and
 * line breaks on their own (history/revert.ts: what changed on one line must
 * stay apart from what changed on another, even the next one). Same bounds
 * either way.
 */
export function wordDiff(a: string, b: string, opts: { merge?: boolean } = {}): WordDiff {
  const cleanup = !opts.merge
  const WORDS = opts.merge ? MERGE_WORD : WORD
  const ops: DiffOp[] = []
  const push = (op: -1 | 0 | 1, s: string) => {
    if (!s) return
    const last = ops.at(-1)
    if (last && last[0] === op) last[1] += s
    else ops.push([op, s])
  }
  let budget = WORD_BUDGET
  /** A changed block: by words if it is small enough, whole otherwise. */
  const refine = (del: string, ins: string) => {
    if (!del || !ins) { push(-1, del); push(1, ins); return }
    const wa = del.match(WORDS) ?? []
    const wb = ins.match(WORDS) ?? []
    const n = wa.length + wb.length
    const words = n <= MAX_BLOCK_WORDS && n * n <= budget ? tokenDiff(wa, wb, cleanup) : null
    if (words) budget -= n * n
    if (words) for (const [op, s] of words) push(op, s)
    else { push(-1, del); push(1, ins) }
  }

  if (a !== b) {
    const la = lines(a)
    const lb = lines(b)
    let p = 0
    while (p < la.length && p < lb.length && la[p] === lb[p]) p++
    let s = 0
    while (s < la.length - p && s < lb.length - p && la[la.length - 1 - s] === lb[lb.length - 1 - s]) s++
    push(0, la.slice(0, p).join(''))
    const ma = la.slice(p, la.length - s)
    const mb = lb.slice(p, lb.length - s)
    const byLines = ma.length + mb.length <= MAX_LINES ? tokenDiff(ma, mb, cleanup) : null
    if (byLines) {
      let del = ''
      let ins = ''
      for (const [op, text] of byLines) {
        if (op === -1) del += text
        else if (op === 1) ins += text
        else {
          refine(del, ins)
          del = ins = ''
          push(0, text)
        }
      }
      refine(del, ins)
    } else refine(ma.join(''), mb.join(''))
    push(0, la.slice(la.length - s).join(''))
  } else push(0, a)

  let added = 0
  let removed = 0
  for (const [op, text] of ops) {
    if (op === 1) added += countWords(text)
    else if (op === -1) removed += countWords(text)
  }
  return { ops, added, removed }
}

/** Only the counts (the version lists show them). */
export function wordStats(a: string, b: string): { added: number; removed: number } {
  if (a === b) return { added: 0, removed: 0 }
  const { added, removed } = wordDiff(a, b)
  return { added, removed }
}
