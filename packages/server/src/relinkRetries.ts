// Link rewrites a vihko move couldn't make, to try again (spec §4.4). When a
// rewrite fails, the old name stays as an alias (D-018's safety net), but no
// alias stands in for a folder's notes, nor for links aliases don't resolve
// (vihko.yaml). Those are tried again after the next rescan, as the system,
// by the same rule as the move; what still fails then is given up (the move
// says so to whoever made it, `onGiveUp`).
//
// A failed rewrite is an event, not something a rescan can rebuild, so it
// doesn't go in index.db: it lives in the state volume, as a small JSON file
// (like the external moves).
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Reason } from './actor.ts'
import { readText } from './fsutil.ts'

/** The rewrites of one move left to retry. */
export interface RelinkRetry {
  id: string
  /** When the move failed them (ISO). */
  at: string
  /** Why they are rewritten, as the move recorded its own (note_moved, folder_moved): the history names the move. */
  reason: Extract<Reason, { code: 'note_moved' | 'folder_moved' }>
  /** The notes the move took, where they were and where they went. */
  moves: { from: string; to: string }[]
  /** The notes whose links couldn't be rewritten. */
  sources: string[]
}

const FILE = 'relink-retries.json'

export class RelinkRetries {
  private stateDir: string
  private now: () => Date
  private entries: RelinkRetry[] = []

  constructor(opts: { stateDir: string; now?: () => Date; log?: (msg: string) => void }) {
    this.stateDir = opts.stateDir
    this.now = opts.now ?? (() => new Date())
    const saved = readText(this.file)
    if (saved !== null) {
      try {
        const data = JSON.parse(saved) as { entries?: RelinkRetry[] }
        if (Array.isArray(data.entries)) this.entries = data.entries
      } catch {
        opts.log?.(`${FILE} is not valid JSON: starting without link rewrites to retry`)
      }
    }
  }

  private get file() {
    return join(this.stateDir, FILE)
  }

  /** Remembers the rewrites a move left undone. Nothing to remember without sources. */
  record(entry: Omit<RelinkRetry, 'id' | 'at'>): RelinkRetry | null {
    if (entry.sources.length === 0) return null
    const e: RelinkRetry = { id: randomUUID(), at: this.now().toISOString(), ...entry, sources: [...new Set(entry.sources)].sort() }
    this.entries.push(e)
    this.save()
    return e
  }

  list(): RelinkRetry[] {
    return this.entries.map((e) => ({ ...e, moves: [...e.moves], sources: [...e.sources] }))
  }

  drop(id: string) {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.id !== id)
    if (this.entries.length !== before) this.save()
  }

  /** Atomic: a temporary file renamed over the old one (the state volume is local disk). */
  private save() {
    mkdirSync(this.stateDir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ entries: this.entries }, null, 2))
    renameSync(tmp, this.file)
  }
}
