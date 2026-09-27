// Notes moved outside thoth (D-031.4), kept until their links are updated or
// nothing is left to update. The indexer detects the moves (moves.ts) and
// keeps each note's identity; this remembers them so the alert can offer
// «Update links». Nothing is ever rewritten on its own: the tool that moved
// the note may be rewriting the links itself at the same time.
//
// A detected move is an event, not something a rescan can rebuild, so it
// doesn't go in index.db (D-011): it lives in the state volume, as a small
// JSON file. How many links are left behind is never stored: it's counted
// from the index whenever it's asked, so the alert follows what the other
// tool (or a person) fixes, and goes away when nothing points to the old
// paths any more.
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normKey, pathKeys } from '@thoth/core'
import type { Db } from './db.ts'
import { readText } from './fsutil.ts'
import type { Indexer } from './indexer.ts'
import type { DetectedMove } from './moves.ts'
import { beforeMoves } from './relink.ts'

/** The moves detected together (one scan or watcher batch): one alert. */
export interface ExternalMoveGroup {
  id: string
  /** When they were detected (ISO). */
  at: string
  moves: DetectedMove[]
}

/** A group as the alert shows it: its moves still in place and the links they left behind. */
export interface PendingExternalMove {
  id: string
  moves: { from: string; to: string }[]
  /**
   * Links written for the old paths that no longer reach their note: links
   * in other notes that led to a moved note, and the moved notes' own links
   * that led somewhere from where they were.
   */
  links: number
}

export interface ExternalMovesOptions {
  stateDir: string
  db: Db
  indexer: Indexer
  now?: () => Date
  log?: (msg: string) => void
}

const FILE = 'external-moves.json'

interface LinkRow { src_path: string; ord: number; kind: 'wiki' | 'embed' | 'markdown'; target: string; anchor: string | null }

export class ExternalMoves {
  private opts: ExternalMovesOptions
  private groups: ExternalMoveGroup[] = []

  constructor(opts: ExternalMovesOptions) {
    this.opts = opts
    const saved = readText(this.file)
    if (saved !== null) {
      try {
        const data = JSON.parse(saved) as { groups?: ExternalMoveGroup[] }
        if (Array.isArray(data.groups)) this.groups = data.groups
      } catch {
        opts.log?.(`${FILE} is not valid JSON: starting without pending external moves`)
      }
    }
  }

  private get file() {
    return join(this.opts.stateDir, FILE)
  }

  /**
   * Remembers the moves of one batch as a group. A note that moves again
   * carries its earlier move along (`a → b`, then `b → c`, is `a → c`), and
   * one that moves back cancels it.
   */
  record(moves: readonly DetectedMove[]) {
    if (moves.length === 0) return
    for (const m of moves) {
      for (const g of this.groups) {
        g.moves = g.moves.flatMap((x) => (x.to !== m.from ? [x] : x.from === m.to ? [] : [{ ...x, to: m.to }]))
      }
    }
    this.groups = this.groups.filter((g) => g.moves.length > 0)
    this.groups.push({ id: randomUUID(), at: (this.opts.now?.() ?? new Date()).toISOString(), moves: moves.map((m) => ({ ...m })) })
    this.save()
  }

  get(id: string): ExternalMoveGroup | null {
    return this.groups.find((g) => g.id === id) ?? null
  }

  drop(id: string) {
    const before = this.groups.length
    this.groups = this.groups.filter((g) => g.id !== id)
    if (this.groups.length !== before) this.save()
  }

  /**
   * The groups with links left behind. Moves no longer in place (the note
   * moved on or was deleted, or a note is back at the old path) are dropped,
   * and so is a group with nothing left to update. With `visible` and
   * `readable`, as one person sees them (only their moves, only the links
   * in notes they can read; a group with none of either isn't listed).
   */
  pending(visible?: (m: { from: string; to: string }) => boolean, readable?: (path: string) => boolean): PendingExternalMove[] {
    const out: PendingExternalMove[] = []
    const links = this.opts.indexer.links
    let changed = false
    this.groups = this.groups.filter((g) => {
      const live = g.moves.filter((m) => links.has(m.to) && !links.has(m.from))
      if (live.length !== g.moves.length) { g.moves = live; changed = true }
      const n = live.length ? this.leftBehind(live) : 0
      if (n === 0) { changed = true; return false }
      // As someone sees it: the moves they see, and the links in the notes they can read.
      const shown = visible ? live.filter(visible) : live
      const seen = readable ? (shown.length ? this.leftBehind(shown, readable) : 0) : n
      if (seen > 0) out.push({ id: g.id, moves: shown.map((m) => ({ from: m.from, to: m.to })), links: seen })
      return true
    })
    if (changed) this.save()
    return out
  }

  /**
   * How many links the moves left behind, counted from the index alone (no
   * note is read); with `readable`, only those in notes it allows.
   */
  private leftBehind(moves: readonly { from: string; to: string }[], readable: (path: string) => boolean = () => true): number {
    const after = this.opts.indexer.links
    const before = beforeMoves(after, moves)
    const forward = new Map(moves.map((m) => [m.from, m.to]))
    const back = new Map(moves.map((m) => [m.to, m.from]))
    const keys = new Set<string>()
    for (const m of moves) {
      for (const k of [...pathKeys(m.from), ...pathKeys(m.to), ...(after.get(m.to)?.aliases ?? []).map(normKey)]) keys.add(k)
    }
    const rows = new Map<string, LinkRow>()
    const cols = 'select src_path, ord, kind, target, anchor from links'
    const byKey = this.opts.db.prepare(`${cols} where key = ?`)
    const bySrc = this.opts.db.prepare(`${cols} where src_path = ?`)
    const add = (list: unknown[]) => { for (const r of list as LinkRow[]) rows.set(`${r.src_path}\u0000${r.ord}`, r) }
    for (const k of keys) add(byKey.all(k))
    for (const to of back.keys()) add(bySrc.all(to))
    let n = 0
    for (const r of rows.values()) {
      if (!readable(r.src_path)) continue
      const own = back.get(r.src_path)
      const was = before.resolve(own ?? r.src_path, r)
      if (was.status !== 'resolved') continue
      if (own === undefined && !forward.has(was.path)) continue // another note's link that never led to a moved one
      const want = forward.get(was.path) ?? was.path
      const now = after.resolve(r.src_path, r)
      if (now.status !== 'resolved' || now.path !== want) n++
    }
    return n
  }

  /** Atomic: a temporary file renamed over the old one (the state volume is local disk). */
  private save() {
    mkdirSync(this.opts.stateDir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ groups: this.groups }, null, 2))
    renameSync(tmp, this.file)
  }
}
