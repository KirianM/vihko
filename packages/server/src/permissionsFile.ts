// vihko.yaml's `permissions`, written by vihko (D-014, D-038.4): from the
// permissions UI, when a folder moves or is deleted from vihko, and when a
// user or group is deleted or renamed. Only the entries asked for change
// (core/permissions.ts); the rest of the file stays as it was.
//
// - Atomic: a temporary file renamed into place (fsutil.ts), never over a
//   file that changed since it was read.
// - Optimistic concurrency: the caller says which text it planned the change
//   on (its hash, as `etag`); if the file changed since, 412 and the UI
//   reloads.
// - A file that can't be used (not YAML, or a rejected section with nothing
//   valid in force) is never edited by vihko: it's fixed by hand first.
// - The workspace is reread at once, so the change applies before the answer.
import { join } from 'node:path'
import { WORKSPACE_FILE, contentHash, moveRules, removeRules, rewriteSubject, setRule, type RuleValue } from '@vihko/core'
import type { Actor } from './actor.ts'
import { readText, replaceText } from './fsutil.ts'
import type { NoteHistory } from './notes.ts'
import { NoteError } from './notes.ts'
import type { PermissionsEngine } from './permissions.ts'
import type { Workspace } from './workspace.ts'

/** The file can't be edited by vihko as it is: it's fixed by hand first (409 `config_invalid`). */
export class ConfigInvalidError extends Error {
  readonly code = 'config_invalid'
}

export interface PermissionsFileOptions {
  notesDir: string
  workspace: Workspace
  engine: PermissionsEngine
  /** The history: each change is a version of vihko.yaml by whoever made it. */
  history?: Pick<NoteHistory, 'prepare'>
  /** After each change (the workspace already reread): open editors are checked again (hub.ts). */
  onChange?: () => void
  /**
   * After `setRule` changed a folder's rule (someone shared it, or changed
   * its members): the file's text before, and who did it. Whoever it now
   * reaches is told (spaceService.ts `notifyShared`). Never for a move, a
   * deletion or a renamed subject: nobody is added to anything by those.
   */
  onRuleSet?: (folder: string, before: string, actor: Actor) => void
}

export class PermissionsFile {
  private opts: PermissionsFileOptions
  /** One change at a time: each is planned over the file the previous one left. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(opts: PermissionsFileOptions) {
    this.opts = opts
  }

  private get file() {
    return join(this.opts.notesDir, WORKSPACE_FILE)
  }

  /** The file's text (null: there is none) and its ETag, which a change must name. */
  read(): { text: string | null; etag: string } {
    const text = readText(this.file)
    return { text, etag: contentHash(text ?? '') }
  }

  /**
   * Changes the file with `edit` (over its current text; '' if there is
   * none), as `actor`. `ifMatch`: only if the file is still the one with
   * that ETag (412 otherwise). Returns the new ETag.
   */
  update(edit: (text: string) => string, opts: { actor: Actor; ifMatch?: string }): Promise<{ etag: string; changed: boolean }> {
    const run = async () => {
      // What is in force is what the file says now (its watcher may not have told yet).
      this.opts.workspace.reload()
      const { text, etag } = this.read()
      if (opts.ifMatch !== undefined && opts.ifMatch !== etag) throw new NoteError('precondition_failed', `${WORKSPACE_FILE} has changed`, etag)
      // The file's section can't be used: what it means is unknown, and an edit on top of it is never guessed at.
      if (this.opts.workspace.permissionsFallback !== null && text !== null) throw new ConfigInvalidError(`${WORKSPACE_FILE} can't be used: fix it by hand first`)
      let next: string
      try {
        next = edit(text ?? '')
      } catch (err) {
        if (err instanceof Error && err.name === 'PermissionsFileError') throw new ConfigInvalidError(err.message)
        throw err
      }
      if (next === (text ?? '')) return { etag, changed: false }
      const w = this.opts.history?.prepare([{ path: WORKSPACE_FILE, before: text, after: next }], { actor: opts.actor, immediate: true })
      let r: Awaited<ReturnType<typeof replaceText>>
      try {
        r = await replaceText(this.file, next, text === null ? null : contentHash(text))
      } catch (err) {
        w?.abort()
        throw err
      }
      if (!r.replaced) {
        w?.abort()
        throw new NoteError('precondition_failed', `${WORKSPACE_FILE} changed while it was being written`, contentHash(r.current ?? ''))
      }
      w?.done()
      this.opts.workspace.reload()
      this.opts.onChange?.()
      return { etag: contentHash(next), changed: true }
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p
  }

  /** The admins' names, for the implicit section written with the first change. */
  private admins(): string[] {
    return this.opts.engine.directory.users().filter((u) => u.role === 'admin').map((u) => u.username)
  }

  /**
   * Sets one folder's rule (all null: removes it, so the folder inherits). A
   * shared space's root takes its `name` too (the space's members are its
   * grants): `setRule('spaces/home-7k2q9x', { name: 'Home', grants: { ana: 'manage' }, ai: null })`.
   */
  async setRule(folder: string, value: RuleValue, opts: { actor: Actor; ifMatch?: string }) {
    // The spaces model has no implicit section: nothing is written for it.
    const implicit = this.opts.engine.model === 'legacy' && this.opts.engine.section.kind === 'implicit' ? this.admins() : undefined
    let before = ''
    const r = await this.update((t) => {
      before = t
      return setRule(t, folder, value, { implicitAdmins: implicit })
    }, opts)
    if (r.changed) {
      try {
        this.opts.onRuleSet?.(folder, before, opts.actor)
      } catch {
        // Telling people is never why a change fails.
      }
    }
    return r
  }

  /** Moves the rules of a folder and those under it (see core `moveRules`). */
  moveRules(from: string, to: string, opts: { actor: Actor; extra?: (RuleValue & { folder: string })[]; keepFrom?: boolean }) {
    return this.update((t) => moveRules(t, from, to, { extra: opts.extra, keepFrom: opts.keepFrom }), opts)
  }

  /** Removes the rules of a folder and those under it. */
  removeRules(folder: string, opts: { actor: Actor }) {
    return this.update((t) => removeRules(t, folder), opts)
  }

  /**
   * Removes a user's or group's grants everywhere (`@name` for a group): a
   * user deleted (D-038.8). Their folders stay closed: a rule left without
   * grants never inherits. Piece U calls it.
   */
  removeSubjectGrants(subject: string, opts: { actor: Actor }) {
    return this.update((t) => rewriteSubject(t, subject, null), opts)
  }

  /** Renames a subject in every grant (`@old` → `@new`: a group renamed). Piece U calls it. */
  renameSubject(from: string, to: string, opts: { actor: Actor }) {
    return this.update((t) => rewriteSubject(t, from, to), opts)
  }
}
