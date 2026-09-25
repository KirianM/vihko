// The workspace configuration (thoth.yaml at the root of the notes folder),
// read at start and again whenever the watcher or the periodic rescan says
// it may have changed. thoth never writes it. A file that can't be used never
// stops the server: thoth keeps the last valid configuration it read and
// raises a workspace alert until the file is fixed. Parts of a usable file
// that were left out (unknown keys, a rejected strict section) raise another.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMPTY_WORKSPACE, WORKSPACE_FILE, parseWorkspaceConfig, type ConfigError, type WorkspaceConfig } from '@thoth/core'

export interface WorkspaceOptions {
  notesDir: string
  log?: (msg: string) => void
}

export class Workspace {
  private opts: WorkspaceOptions
  /** Text of the file last read (null: it doesn't exist), to skip re-parsing an unchanged file. */
  private lastText: string | null | undefined = undefined
  private good: WorkspaceConfig = EMPTY_WORKSPACE
  private hasGood = false
  private problems: ConfigError[] = []
  /** What the configuration in force left out. */
  private ignored: ConfigError[] = []

  constructor(opts: WorkspaceOptions) {
    this.opts = opts
    this.reload()
  }

  /** The configuration in force: the file's, the last valid one or the empty one. */
  get config(): WorkspaceConfig {
    return this.good
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
        const was = JSON.stringify(this.problems)
        this.problems = [{ code: 'unreadable', at: null, line: null, detail: code ?? String(err) }]
        this.lastText = undefined
        return was !== JSON.stringify(this.problems)
      }
    }
    if (text === this.lastText) return false
    this.lastText = text
    const before = JSON.stringify([this.good, this.problems, this.ignored])
    if (text === null) {
      // No file: nothing is configured. Deleting it turns everything off.
      this.good = EMPTY_WORKSPACE
      this.hasGood = false
      this.problems = []
      this.ignored = []
    } else {
      const r = parseWorkspaceConfig(text)
      if (r.ok) {
        this.good = r.config
        this.hasGood = true
        this.problems = []
        this.ignored = r.warnings
      } else {
        this.problems = r.errors
      }
    }
    const changed = before !== JSON.stringify([this.good, this.problems, this.ignored])
    if (changed) {
      if (this.problems.length) this.opts.log?.(`${WORKSPACE_FILE} can't be used (${this.problems.map((e) => `${e.code}${e.at ? ` at ${e.at}` : ''}`).join(', ')}); ${this.hasGood ? 'keeping the last valid one' : 'nothing configured'}`)
      else this.opts.log?.(text === null ? `no ${WORKSPACE_FILE}: nothing configured` : `${WORKSPACE_FILE} loaded${this.ignored.length ? ` without ${this.ignored.map((e) => `${e.code}${e.at ? ` at ${e.at}` : ''}`).join(', ')}` : ''}`)
    }
    return changed
  }
}
