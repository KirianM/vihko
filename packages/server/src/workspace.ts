// The workspace configuration (vihko.yaml at the root of the notes folder),
// read at start and again whenever the watcher or the periodic rescan says
// it may have changed (and at once after vihko writes its `permissions`,
// permissionsFile.ts). A file that can't be used never stops the server:
// vihko keeps the last valid configuration it read and raises a workspace
// alert until the file is fixed. Parts of a usable file that were left out
// (unknown keys, a rejected strict section) raise another.
//
// Permissions always fail closed (D-038): a section rejected (or a file that
// can't be used) when vihko starts leaves nobody reading anything until it's
// fixed; once a valid one was in force, it stays while the file is wrong. No
// file, or a file without the section: the implicit one (every admin
// manages the root). While vihko runs, that only once the file has stayed so
// for a moment (`settleMs`): an editor that truncates the file and writes it
// again leaves it empty for an instant, and the implicit rule would open
// every note, other people's personal folders included, to every admin.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLOSED_PERMISSIONS, EMPTY_WORKSPACE, IMPLICIT_PERMISSIONS, WORKSPACE_FILE, parseWorkspaceConfig, type ConfigError, type Permissions, type WorkspaceConfig } from '@vihko/core'

export interface WorkspaceOptions {
  notesDir: string
  log?: (msg: string) => void
  /**
   * How long the file must stay without permissions (deleted, emptied, the
   * section gone) before the implicit ones replace those in force (2 s).
   */
  settleMs?: number
  /** When the file has stayed so: reread it (main.ts, to apply it everywhere); `reload` by default. */
  onSettle?: () => void
}

/** Default of `settleMs`. */
export const PERMISSIONS_SETTLE_MS = 2000

export class Workspace {
  private opts: WorkspaceOptions
  /** Text of the file last read (null: it doesn't exist), to skip re-parsing an unchanged file. */
  private lastText: string | null | undefined = undefined
  private good: WorkspaceConfig = EMPTY_WORKSPACE
  private hasGood = false
  private problems: ConfigError[] = []
  /** What the configuration in force left out. */
  private ignored: ConfigError[] = []
  /** The permissions in force: closed until a valid section (or none) is read. */
  private perms: Permissions = CLOSED_PERMISSIONS
  private hasGoodPerms = false
  /** The permissions in the file can't be used (rejected, or the whole file): what applies instead. */
  private permsFallback: 'last_good' | 'closed' | null = null
  /** Read once (at start, nothing is in force to keep). */
  private started = false
  /** The file without permissions, since when (its text, null if missing): the implicit ones wait until it stays so. */
  private opening: { text: string | null; since: number } | null = null
  private settleTimer: NodeJS.Timeout | null = null

  constructor(opts: WorkspaceOptions) {
    this.opts = opts
    this.reload()
    this.started = true
  }

  /** The configuration in force: the file's, the last valid one or the empty one. */
  get config(): WorkspaceConfig {
    return this.good
  }

  /** The permissions in force (see the header). */
  get permissions(): Permissions {
    return this.perms
  }

  /**
   * Whether the permissions in the file are left out, and what applies
   * instead: the last valid ones, or nothing at all (`closed`); null when the
   * file's apply.
   */
  get permissionsFallback(): 'last_good' | 'closed' | null {
    return this.permsFallback
  }

  /**
   * Why the current file can't be used (empty when it can) and what is used
   * instead; and what the configuration in force left out (`warnings`).
   */
  get status(): { errors: ConfigError[]; warnings: ConfigError[]; fallback: 'last_good' | 'none' } {
    return { errors: this.problems, warnings: this.ignored, fallback: this.hasGood ? 'last_good' : 'none' }
  }

  /** Reads the file again. true if what is in force changed. */
  reload(): boolean {
    let text: string | null
    try {
      text = readFileSync(join(this.opts.notesDir, WORKSPACE_FILE), 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') text = null
      else {
        // It exists but can't be read: keep what is in force, like an invalid file.
        const was = JSON.stringify([this.problems, this.permsFallback])
        this.problems = [{ code: 'unreadable', at: null, line: null, detail: code ?? String(err) }]
        this.lastText = undefined
        this.permissionsUnusable()
        return was !== JSON.stringify([this.problems, this.permsFallback])
      }
    }
    if (text === this.lastText) return false
    this.lastText = text
    const before = JSON.stringify([this.good, this.problems, this.ignored, this.perms, this.permsFallback])
    if (text === null) {
      // No file: nothing is configured. Deleting it turns everything off, and the permissions are the implicit ones.
      this.good = EMPTY_WORKSPACE
      this.hasGood = false
      this.problems = []
      this.ignored = []
      this.offerPermissions(IMPLICIT_PERMISSIONS, text)
    } else {
      const r = parseWorkspaceConfig(text)
      if (r.ok) {
        this.good = r.config
        this.hasGood = true
        this.problems = []
        this.ignored = r.warnings
        const p = r.sections.permissions as Permissions
        if (p.kind === 'closed') this.permissionsUnusable()
        else this.offerPermissions(p, text)
      } else {
        this.problems = r.errors
        // The section stands on its own: a mistake elsewhere in the file doesn't touch it.
        const p = r.sections?.permissions as Permissions | undefined
        if (p === undefined || p.kind === 'closed') this.permissionsUnusable()
        else this.offerPermissions(p, text)
      }
    }
    const changed = before !== JSON.stringify([this.good, this.problems, this.ignored, this.perms, this.permsFallback])
    if (changed) {
      if (this.problems.length) this.opts.log?.(`${WORKSPACE_FILE} can't be used (${this.problems.map((e) => `${e.code}${e.at ? ` at ${e.at}` : ''}`).join(', ')}); ${this.hasGood ? 'keeping the last valid one' : 'nothing configured'}`)
      else this.opts.log?.(text === null ? `no ${WORKSPACE_FILE}: nothing configured` : `${WORKSPACE_FILE} loaded${this.ignored.length ? ` without ${this.ignored.map((e) => `${e.code}${e.at ? ` at ${e.at}` : ''}`).join(', ')}` : ''}`)
    }
    return changed
  }

  /**
   * The permissions the file has now: in force at once, except the implicit
   * ones while others are in force, which wait until the file has stayed so
   * for `settleMs` (see the header). Meanwhile those in force stay, and the
   * file is read again then.
   */
  private offerPermissions(p: Permissions, text: string | null) {
    const settle = this.opts.settleMs ?? PERMISSIONS_SETTLE_MS
    if (p.kind === 'implicit' && this.started && this.perms.kind !== 'implicit' && settle > 0) {
      const now = Date.now()
      if (this.opening === null || this.opening.text !== text) {
        this.opening = { text, since: now }
        this.opts.log?.(`${WORKSPACE_FILE} has no permissions now: if it stays so for ${settle / 1000} s, every admin manages the root`)
      }
      const wait = this.opening.since + settle - now
      if (wait > 0) {
        // The same text has to be looked at again, even if nothing says it changed.
        this.lastText = undefined
        if (!this.settleTimer) {
          this.settleTimer = setTimeout(() => {
            this.settleTimer = null
            if (this.opts.onSettle) this.opts.onSettle()
            else this.reload()
          }, wait + 20)
          this.settleTimer.unref()
        }
        return
      }
    }
    this.opening = null
    this.setPermissions(p)
  }

  private setPermissions(p: Permissions) {
    // The same rules keep their object: whoever compiled them keeps what it compiled.
    if (JSON.stringify(p) !== JSON.stringify(this.perms)) this.perms = p
    this.hasGoodPerms = true
    this.permsFallback = null
  }

  /** The file's permissions can't be used: the last valid ones stay, or nobody reads (never open). */
  private permissionsUnusable() {
    this.opening = null
    if (this.hasGoodPerms) this.permsFallback = 'last_good'
    else {
      this.perms = CLOSED_PERMISSIONS
      this.permsFallback = 'closed'
    }
  }
}
