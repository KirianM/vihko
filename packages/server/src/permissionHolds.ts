// Notes moved outside vihko (a shell, another editor) to where more people
// would read them: fail closed. Who reads a note
// depends on where it is; a note moved by hand into a folder shared with
// someone who couldn't read it before would be opened to them by nobody's
// decision. When the indexer pairs such a move (M1's detection: the same
// `uid`, or the same text), the note is held: nobody reads it (nor any
// agent) until it goes back, or someone who could have made that move from
// vihko (`edit` where it was and where it is) releases it, from the alert.
// A hold also lifts by itself once nobody reads it who didn't before.
//
// Only what M1's detection pairs is held: a note it can't pair (no `uid`, and
// changed on the way) is taken as a new note and gets its new place's
// audience from the moment the watcher (or the rescan, on NFS) sees it. That,
// and the seconds before either sees the move, is the window left open.
//
// Holds are events, not something a rescan can rebuild: they live in the
// state volume (like external-moves.json), never in index.db.
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { atLeast, folderOf, type Alert, type Level } from '@vihko/core'
import type { Holds } from './access.ts'
import { readText } from './fsutil.ts'
import type { PermissionsEngine } from './permissions.ts'

/** Notes held together: they left one folder (`folder`) in one batch. */
export interface Hold {
  id: string
  /** The folder the notes were in. */
  folder: string
  /** The notes, where they are now. */
  notes: string[]
  /** Who read them where they were (user ids). */
  readers: string[]
  /** Whether they were closed to agents there (`ai: false` on the folder). */
  aiClosed: boolean
  at: string
}

/** Who is looking at a hold: their level in a folder (a person's; holds are never an agent's). */
export interface HoldViewer {
  level: (folder: string) => Level | null
}

/** What a person may do with a hold. */
export interface HoldAccess {
  /** Whether they're told it exists (its alert), and may release it: they could have made the move from vihko. */
  decides: boolean
}

/** Who is told of a hold: whoever has `edit` where the notes were and where each of them is now. Nobody else is told. */
export function holdAccess(h: Hold, who: HoldViewer): HoldAccess {
  const edits = (folder: string) => atLeast(who.level(folder), 'edit')
  return { decides: edits(h.folder) && h.notes.every((n) => edits(folderOf(n))) }
}

const FILE = 'permission-holds.json'

export interface PermissionHoldsOptions {
  stateDir: string
  engine: PermissionsEngine
  now?: () => Date
  log?: (msg: string) => void
}

export class PermissionHolds implements Holds {
  private opts: PermissionHoldsOptions
  private list: Hold[] = []
  private held_ = new Set<string>()

  constructor(opts: PermissionHoldsOptions) {
    this.opts = opts
    const saved = readText(this.file)
    if (saved !== null) {
      try {
        const data = JSON.parse(saved) as { holds?: Partial<Hold>[] }
        // Only holds of this model (with the readers they had); 1.0's are no longer read.
        if (Array.isArray(data.holds)) this.list = data.holds.filter((h): h is Hold => Array.isArray(h.readers) && Array.isArray(h.notes) && typeof h.folder === 'string' && typeof h.id === 'string')
      } catch {
        // Unreadable: nothing is known to be held. Logged: whoever reads the log can check the folders.
        opts.log?.(`${FILE} is not valid JSON: starting without held notes`)
      }
    }
    this.reindex()
  }

  private get file() {
    return join(this.opts.stateDir, FILE)
  }

  /** Who reads what is in `folder` now (user ids), and whether agents are shut out of it. */
  private audience(folder: string): { readers: Set<string>; aiClosed: boolean } {
    const rules = this.opts.engine.spaceRules()
    return { readers: new Set(this.opts.engine.readers(folder, rules).map((r) => r.id)), aiClosed: rules.aiClosedAt(folder) !== null }
  }

  /** Whether a note in `folder` would be read by someone (or some agent) who didn't read it where it was. */
  private widens(folder: string, was: { readers: readonly string[]; aiClosed: boolean }): boolean {
    const now = this.audience(folder)
    const before = new Set(was.readers)
    return [...now.readers].some((id) => !before.has(id)) || (was.aiClosed && !now.aiClosed)
  }

  /**
   * Moves the indexer detected outside vihko: each that takes a note where
   * someone who didn't read it would, holds it. A held note that moves again
   * stays held at its new path (and is judged against where it first was).
   */
  consider(moves: readonly { from: string; to: string }[]) {
    if (moves.length === 0) return
    let changed = false
    const fresh = new Map<string, Hold>()
    for (const { from, to } of moves) {
      const f = from.normalize('NFC')
      const t = to.normalize('NFC')
      // Already held: it stays so where it went.
      const old = this.list.find((h) => h.notes.includes(f))
      if (old) { old.notes = old.notes.map((n) => (n === f ? t : n)); changed = true; continue }
      const origin = folderOf(f)
      const before = this.audience(origin)
      const was = { readers: [...before.readers].sort(), aiClosed: before.aiClosed }
      if (!this.widens(folderOf(t), was)) continue
      // One hold per folder left: whoever may decide is judged there.
      let h = fresh.get(origin)
      if (!h) fresh.set(origin, (h = { id: randomUUID(), folder: origin, notes: [], ...was, at: (this.opts.now?.() ?? new Date()).toISOString() }))
      h.notes.push(t)
    }
    for (const h of fresh.values()) {
      this.list.push(h)
      changed = true
      this.opts.log?.(`${h.notes.length} note(s) moved outside vihko to where more people would read them: nobody reads them until they go back or someone releases them`)
    }
    if (changed) { this.reindex(); this.save() }
  }

  /** Whether a note is held from everyone now. */
  held(path: string): boolean {
    if (!this.held_.has(path)) return false
    const h = this.list.find((x) => x.notes.includes(path))!
    // Lifted by itself once nobody would read it who didn't before (it went back, or the grants changed).
    return this.widens(folderOf(path), h)
  }

  get(id: string): Hold | null {
    return this.list.find((h) => h.id === id) ?? null
  }

  /** Lets them go: whatever the folder they're in gives applies. */
  release(id: string) {
    const before = this.list.length
    this.list = this.list.filter((h) => h.id !== id)
    if (this.list.length !== before) { this.reindex(); this.save() }
  }

  /** Whether any note held now is inside `folder` (`held_inside`: it can't be deleted until they're released). */
  heldInside(folder: string): boolean {
    const f = folder.normalize('NFC')
    return [...this.held_].some((p) => p.startsWith(f + '/') && this.held(p))
  }

  /**
   * The holds still in force, as alerts for `who` (`holdAccess`): the folder
   * the notes left and how many, never their paths. Holds whose notes are
   * gone or no longer widen are dropped.
   */
  alerts(exists: (path: string) => boolean, who: HoldViewer): Alert[] {
    const before = this.list.length
    this.list = this.list.filter((h) => {
      h.notes = h.notes.filter((n) => exists(n))
      return h.notes.some((n) => this.widens(folderOf(n), h))
    })
    if (this.list.length !== before) { this.reindex(); this.save() }
    return this.list.flatMap((h) => holdAccess(h, who).decides
      ? [{ code: 'permissions_held' as const, id: h.id, folder: h.folder, notes: h.notes.length, actions: ['release' as const] }]
      : [])
  }

  private reindex() {
    this.held_ = new Set(this.list.flatMap((h) => h.notes))
  }

  /** Atomic: a temporary file renamed over the old one (the state volume is local disk). */
  private save() {
    mkdirSync(this.opts.stateDir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ holds: this.list }, null, 2))
    renameSync(tmp, this.file)
  }
}
