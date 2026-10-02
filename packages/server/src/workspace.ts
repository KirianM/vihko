// The workspace configuration (vihko.yaml at the root of the notes folder),
// read at start and again whenever the watcher or the periodic rescan says
// it may have changed (and at once after vihko writes its `permissions`,
// permissionsFile.ts). A file that can't be used never stops the server:
// vihko keeps the last valid configuration it read and raises a workspace
// alert until the file is fixed. Parts of a usable file that were left out
// (unknown keys, a rejected strict section) raise another.
//
// Permissions always fail closed: a section rejected (or a
// file that can't be used) when vihko starts shares nothing until it's
// fixed (each person keeps their own space); once a valid one was in force,
// it stays while the file is wrong. No file, or a file without the section:
// nothing is shared either (`none`). While vihko runs, that only once the
// file has stayed so for a moment (`settleMs`): an editor that truncates the
// file and writes it again leaves it empty for an instant, and every shared
// space would vanish from its members' open editors meanwhile.
//
// The last valid file is kept in the state volume too (`stateDir`), so that
// vihko starting with one that can't be used (a typo before an upgrade's
// restart) goes on with it, not with nothing: an empty configuration would
// drop `history.exclude` and record what it keeps out, or turn a history
// that is off on. Its permissions still fail closed, as above.
import { readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readText, writeTmp } from './fsutil.ts'
import { CLOSED_PERMISSIONS, EMPTY_WORKSPACE, NO_PERMISSIONS, WORKSPACE_FILE, parseWorkspaceConfig, type ConfigError, type Permissions, type WorkspaceConfig } from '@vihko/core'

export interface WorkspaceOptions {
  notesDir: string
  /** The state volume, where the last valid file is kept (LAST_VALID_FILE); none: it isn't. */
  stateDir?: string
  log?: (msg: string) => void
  /**
   * How long the file must stay without permissions (deleted, emptied, the
   * section gone) before no permissions replace those in force (2 s).
   */
  settleMs?: number
  /** When the file has stayed so: reread it (main.ts, to apply it everywhere); `reload` by default. */
  onSettle?: () => void
}

/** Default of `settleMs`. */
export const PERMISSIONS_SETTLE_MS = 2000

/** The last valid vihko.yaml, in the state volume. */
export const LAST_VALID_FILE = 'vihko.yaml.last-valid'

/**
 * The last vihko.yaml whose `permissions` shared something, in the state
 * volume: if the section disappears from the file (pasted over, deleted),
 * what applies is the file (nothing shared), and the admin can put these
 * back (`lastPermissions`).
 */
export const LAST_PERMISSIONS_FILE = 'vihko.yaml.last-permissions'

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
  /** The file without permissions, since when (its text, null if missing): no permissions wait until it stays so. */
  private opening: { text: string | null; since: number } | null = null
  private settleTimer: NodeJS.Timeout | null = null
  /** The text kept as the last valid file (undefined: not looked at yet). */
  private kept: string | null | undefined = undefined

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
        if (!this.hasGood) this.useKept()
        this.permissionsUnusable()
        return was !== JSON.stringify([this.problems, this.permsFallback])
      }
    }
    if (text === this.lastText) return false
    this.lastText = text
    const before = JSON.stringify([this.good, this.problems, this.ignored, this.perms, this.permsFallback])
    if (text === null) {
      // No file: nothing is configured. Deleting it turns everything off, and nothing is shared.
      this.good = EMPTY_WORKSPACE
      this.hasGood = false
      this.problems = []
      this.ignored = []
      this.keep(null)
      this.offerPermissions(NO_PERMISSIONS, text)
    } else {
      const r = parseWorkspaceConfig(text)
      if (r.ok) {
        this.good = r.config
        this.hasGood = true
        this.problems = []
        this.ignored = r.warnings
        this.keep(text)
        const p = r.sections.permissions as Permissions
        if (p.kind === 'closed') this.permissionsUnusable()
        else this.offerPermissions(p, text)
        this.keepPermissions(p, text)
      } else {
        this.problems = r.errors
        if (!this.hasGood) this.useKept()
        // The section stands on its own: a mistake elsewhere in the file doesn't touch it.
        const p = r.sections?.permissions as Permissions | undefined
        if (p === undefined || p.kind === 'closed') this.permissionsUnusable()
        else {
          this.offerPermissions(p, text)
          this.keepPermissions(p, text)
        }
      }
    }
    const changed = before !== JSON.stringify([this.good, this.problems, this.ignored, this.perms, this.permsFallback])
    if (changed) {
      if (this.problems.length) this.opts.log?.(`${WORKSPACE_FILE} can't be used (${this.problems.map((e) => `${e.code}${e.at ? ` at ${e.at}` : ''}`).join(', ')}); ${this.hasGood ? 'keeping the last valid one' : 'nothing configured'}`)
      else this.opts.log?.(text === null ? `no ${WORKSPACE_FILE}: nothing configured` : `${WORKSPACE_FILE} loaded${this.ignored.length ? ` without ${this.ignored.map((e) => `${e.code}${e.at ? ` at ${e.at}` : ''}`).join(', ')}` : ''}`)
    }
    return changed
  }

  /** Keeps `text` as the last valid file in the state volume (null: there is none, nothing is configured). */
  private keep(text: string | null) {
    const dir = this.opts.stateDir
    if (dir === undefined) return
    const file = join(dir, LAST_VALID_FILE)
    if (this.kept === undefined) this.kept = readText(file)
    if (this.kept === text) return
    try {
      if (text === null) rmSync(file, { force: true })
      else renameSync(writeTmp(file, text), file)
      this.kept = text
    } catch (err) {
      this.opts.log?.(`the last valid ${WORKSPACE_FILE} couldn't be kept in the state volume: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** The text kept as LAST_PERMISSIONS_FILE (undefined: not looked at yet). */
  private keptPermissions: string | null | undefined = undefined

  /** Keeps the file's text when its permissions share something (LAST_PERMISSIONS_FILE). */
  private keepPermissions(p: Permissions, text: string) {
    const dir = this.opts.stateDir
    if (dir === undefined || p.kind !== 'rules' || p.rules.length === 0) return
    if (this.lastPermissions() === text) return
    const file = join(dir, LAST_PERMISSIONS_FILE)
    try {
      renameSync(writeTmp(file, text), file)
      this.keptPermissions = text
    } catch (err) {
      this.opts.log?.(`the last permissions of ${WORKSPACE_FILE} couldn't be kept in the state volume: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** The last vihko.yaml whose permissions shared something (its whole text), kept in the state volume; null if none. */
  lastPermissions(): string | null {
    const dir = this.opts.stateDir
    if (dir === undefined) return null
    if (this.keptPermissions === undefined) this.keptPermissions = readText(join(dir, LAST_PERMISSIONS_FILE))
    return this.keptPermissions
  }

  /** Forgets the permissions kept (the admin dismissed their alert, or put them back). */
  forgetLastPermissions() {
    const dir = this.opts.stateDir
    if (dir === undefined) return
    rmSync(join(dir, LAST_PERMISSIONS_FILE), { force: true })
    this.keptPermissions = null
  }

  /**
   * Whether the file has no `permissions` (or there's no file) and nothing is
   * shared because of it, while vihko kept ones that shared something: the
   * admin's `permissions_missing` alert. An empty section written on purpose
   * (`permissions: {}`) isn't missing.
   */
  get permissionsMissing(): boolean {
    return this.perms.kind === 'none' && this.permsFallback === null && this.lastPermissions() !== null
  }

  /** With nothing valid read yet: the last valid file kept in the state volume, if there is one. */
  private useKept() {
    const dir = this.opts.stateDir
    if (dir === undefined) return
    const text = readText(join(dir, LAST_VALID_FILE))
    this.kept = text
    if (text === null) return
    const r = parseWorkspaceConfig(text)
    if (!r.ok) return
    this.good = r.config
    this.hasGood = true
    this.opts.log?.(`${WORKSPACE_FILE} can't be used: going on with the last valid one, kept in the state volume (${LAST_VALID_FILE})`)
  }

  /**
   * The permissions the file has now: in force at once, except none at all
   * while some grants are in force, which waits until the file has stayed so
   * for `settleMs` (see the header). Meanwhile those in force stay, and the
   * file is read again then.
   */
  private offerPermissions(p: Permissions, text: string | null) {
    const settle = this.opts.settleMs ?? PERMISSIONS_SETTLE_MS
    if (p.kind === 'none' && this.started && this.perms.kind === 'rules' && this.perms.rules.length > 0 && settle > 0) {
      const now = Date.now()
      if (this.opening === null || this.opening.text !== text) {
        this.opening = { text, since: now }
        this.opts.log?.(`${WORKSPACE_FILE} has no permissions now: if it stays so for ${settle / 1000} s, nothing is shared`)
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
