// Notes that left a folder with rules of its own through a move made outside
// thoth (a shell, another editor): fail closed (m4 §1, D-014). The rules of
// thoth.yaml name folders; a folder renamed from outside leaves its rules at
// a path that no longer exists, and what it held would inherit from its new
// parent, which may be more open. When the indexer pairs such a move (M1's
// detection: the same `uid`, or the same text), the note is held: nobody
// reads it (nor any agent) until someone decides, from the alert:
//
// - «Move its permissions to …» (the folder the notes went to, when they all
//   point at one): the rules follow the folder, and the notes come back with
//   the same audience as before;
// - or release them, accepting what the new folder gives.
//
// A hold also lifts by itself once the rules that govern the note where it is
// now are the ones that governed it before (someone moved the rules by hand).
//
// Only what M1's detection pairs is held: a note it can't pair (no `uid`, and
// changed on the way) is taken as a new note and inherits from where it is,
// from the moment the watcher (or the rescan, on NFS) sees it. That, and the
// seconds before either sees the move, is the window left open.
//
// Holds are events, not something a rescan can rebuild: they live in the
// state volume (like external-moves.json), never in index.db.
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { folderOf, subjectKey, type Alert } from '@thoth/core'
import type { Holds } from './access.ts'
import { readText } from './fsutil.ts'
import type { PermissionsEngine } from './permissions.ts'

/** Notes held together: they left the folder whose rules governed them (`folder`) in one batch. */
export interface Hold {
  id: string
  /** The folder whose own rules governed the notes where they were. */
  folder: string
  /** Where that folder seems to have gone (every note moved under it the same way); null if unknown. */
  to: string | null
  /** The notes, where they are now. */
  notes: string[]
  /** What governed them before: its grants and whether closed to agents, to tell when that holds again. */
  was: string
  at: string
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
        const data = JSON.parse(saved) as { holds?: Hold[] }
        if (Array.isArray(data.holds)) this.list = data.holds
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

  /** What governs a folder now, as a key to compare: the resolved grants, who manages it from above (D-040 3.5) and whether agents are shut out. */
  private signature(folder: string): string {
    const { grants, above } = this.opts.engine.reaching(folder)
    const set = this.opts.engine.rules()
    const sorted = Object.entries(grants).map(([s, l]) => [subjectKey(s), l]).sort(([a], [b]) => (a! < b! ? -1 : 1))
    const managers = [...new Set(above.map((m) => subjectKey(m.subject)))].sort()
    return JSON.stringify([sorted, managers, set?.aiClosedAt(folder) != null])
  }

  /**
   * Moves the indexer detected outside thoth: those that took a note out of
   * the reach of the rules that governed it, into a folder where other rules
   * apply, hold it. A held note that moves again stays held at its new path.
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
      const g = this.opts.engine.grantsAt(folderOf(f)).governing
      // Governed by the implicit section, or by nothing: no folder's own rules to lose.
      if (!g || this.opts.engine.section.kind !== 'rules') continue
      const within = (p: string) => g.at === '' || p === g.at || p.startsWith(g.at + '/')
      // Still under the same rule: nothing changed hands.
      if (within(folderOf(t))) continue
      const was = this.signature(folderOf(f))
      if (was === this.signature(folderOf(t))) continue
      let h = fresh.get(g.at)
      if (!h) fresh.set(g.at, (h = { id: randomUUID(), folder: g.at, to: null, notes: [], was, at: (this.opts.now?.() ?? new Date()).toISOString() }))
      h.notes.push(t)
      // Where the folder went: `a/x/n.md` → `b/y/x/n.md` says `a` became `b/y`, if every note agrees.
      const rest = f.slice(g.at === '' ? 0 : g.at.length + 1)
      const dest = t.endsWith('/' + rest) ? t.slice(0, t.length - rest.length - 1) : null
      h.to = h.notes.length === 1 ? dest : h.to === dest ? dest : null
    }
    for (const h of fresh.values()) {
      this.list.push(h)
      changed = true
      this.opts.log?.(`${h.notes.length} note(s) moved outside thoth out of ${h.folder || 'the root'}, which has permissions of its own: nobody reads them until someone decides (move its permissions${h.to ? ` to ${h.to}` : ''}, or release them)`)
    }
    if (changed) { this.reindex(); this.save() }
  }

  /** Whether a note is held from everyone now. */
  held(path: string): boolean {
    if (!this.held_.has(path)) return false
    const h = this.list.find((x) => x.notes.includes(path))!
    // Lifted by itself once what governs it now is what governed it before.
    return this.signature(folderOf(path)) !== h.was
  }

  get(id: string): Hold | null {
    return this.list.find((h) => h.id === id) ?? null
  }

  /** Lets them go: whatever the folder they're in gives applies (or the rules were moved after them). */
  release(id: string) {
    const before = this.list.length
    this.list = this.list.filter((h) => h.id !== id)
    if (this.list.length !== before) { this.reindex(); this.save() }
  }

  /**
   * The holds still in force, as alerts for `sees` (the admin, or whoever
   * manages the folder): the folders' names and how many notes, never their
   * paths. Holds whose notes are gone or already governed as before are
   * dropped.
   */
  alerts(exists: (path: string) => boolean, sees: (h: Hold) => boolean): Alert[] {
    const before = this.list.length
    this.list = this.list.filter((h) => {
      h.notes = h.notes.filter((n) => exists(n))
      return h.notes.some((n) => this.signature(folderOf(n)) !== h.was)
    })
    if (this.list.length !== before) { this.reindex(); this.save() }
    return this.list.filter(sees).map((h) => ({
      code: 'permissions_held' as const, id: h.id, folder: h.folder, to: h.to, notes: h.notes.length,
      actions: [...(h.to !== null ? ['move_permissions' as const] : []), 'release' as const],
    }))
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
