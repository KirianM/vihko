// The note settings of each space (core noteSettings.ts): a person's own,
// `people/<user>/.vihko/settings.yaml`, and a shared space's,
// `spaces/<name>/.vihko/settings.yaml`. They add to what vihko.yaml says for
// the whole installation:
//
// - daily-note series: a person is offered vihko.yaml's, those of the shared
//   spaces they belong to and their own, where they can write today's note;
//   two that give the same path are one, the closest to the person (theirs,
//   then a space's, then vihko.yaml's), with its label and template. A daily
//   note is its path: nothing is duplicated or moved by declaring a series
//   twice.
// - where new images go: a space's setting for the notes of that space,
//   otherwise vihko.yaml's.
// - the guide for agents: vihko.yaml's, then that of each shared space the
//   key reaches (its text, in the file: only its managers write it), then the
//   person's own (a note of theirs the key must read).
//
// Nothing of someone else's settings ever applies to a person, and the files
// are never served: `.vihko/` is hidden and reserved (core spaces.ts). Each
// file is read again when it changes on the disk (its size and time), so a
// hand edit applies at once; one that can't be read applies nothing of what
// is wrong in it, and whoever it belongs to is told (an alert): the person,
// or a shared space's managers. Never the admin as such.
import { createHash } from 'node:crypto'
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  NoteSettingsFileError, contentHash, noteSettingsPath, parseNoteSettings, personalRoot, resolveNoteSettings, seriesPattern, spaceRootOf, writeNoteSettings,
  type AttachmentsConfig, type ConfigError, type NoteSettings, type NoteSettingsKind, type ResolvedNoteSettings, type Series,
} from '@vihko/core'
import { commitText, followable, readText } from './fsutil.ts'
import { NoteError } from './notes.ts'

interface Cached {
  /** size:mtime of the file when read (`''`: none). */
  stamp: string
  text: string | null
  settings: NoteSettings
  errors: ConfigError[]
  resolved: ResolvedNoteSettings
}

/** What a space's settings are now: as written (relative), as they apply, what's wrong, and the ETag to change them. */
export interface SettingsRead {
  root: string
  etag: string
  settings: NoteSettings
  errors: ConfigError[]
  resolved: ResolvedNoteSettings
}

/** The prefix of a space's series ids, so they never take vihko.yaml's (or each other's). */
export function seriesPrefix(root: string): string {
  return root.startsWith('people/') ? 'me-' : `sp-${createHash('sha1').update(root.normalize('NFC')).digest('hex').slice(0, 8)}-`
}

/** Whose settings a space's root holds: a person's own, or a shared space's. */
export function settingsKind(root: string): NoteSettingsKind {
  return root.startsWith('people/') ? 'personal' : 'shared'
}

export class NoteSettingsStore {
  private notesDir: string
  private cache = new Map<string, Cached>()

  constructor(opts: { notesDir: string }) {
    this.notesDir = opts.notesDir
  }

  private file(root: string) {
    return join(this.notesDir, noteSettingsPath(root))
  }

  /**
   * Whether vihko may follow the settings file's path: never through a
   * symbolic link (fsutil.ts followable), which would read or write another
   * space's settings, or any file of the server. One that goes through a
   * link isn't there for vihko.
   */
  private followable(root: string): boolean {
    return followable(this.notesDir, noteSettingsPath(root))
  }

  private stamp(root: string): string {
    if (!this.followable(root)) return ''
    try {
      const s = statSync(this.file(root))
      return s.isFile() ? `${s.size}:${s.mtimeMs}` : ''
    } catch {
      return ''
    }
  }

  /** The settings of the space at `root` (a person's root, or a shared space's). */
  read(root: string): SettingsRead {
    const r = root.normalize('NFC')
    const stamp = this.stamp(r)
    let c = this.cache.get(r)
    if (!c || c.stamp !== stamp) {
      let text: string | null = null
      try { text = stamp === '' ? null : readText(this.file(r)) } catch { text = null }
      const { settings, errors } = parseNoteSettings(text, settingsKind(r))
      c = { stamp, text, settings, errors, resolved: resolveNoteSettings(settings, r, seriesPrefix(r)) }
      this.cache.set(r, c)
      if (this.cache.size > 2000) this.cache.clear()
    }
    return { root: r, etag: contentHash(c.text ?? ''), settings: c.settings, errors: c.errors, resolved: c.resolved }
  }

  /**
   * Writes the settings of the space at `root` (atomic, never over a file
   * that changed since `ifMatch` was read: `precondition_failed`), keeping
   * what the file has around them (core writeNoteSettings). A file that
   * isn't YAML is fixed by hand first (NoteSettingsFileError).
   */
  async write(root: string, next: NoteSettings, opts: { ifMatch?: string; remove?: readonly string[] } = {}): Promise<SettingsRead> {
    const r = root.normalize('NFC')
    const now = this.read(r)
    if (opts.ifMatch !== undefined && opts.ifMatch !== now.etag) throw new NoteError('precondition_failed', 'the settings have changed', now.etag)
    if (!this.followable(r)) throw new NoteError('invalid_path', `vihko doesn't follow a symbolic link: ${noteSettingsPath(r)}`)
    const before = now.etag === contentHash('') && this.stamp(r) === '' ? null : readText(this.file(r))
    const text = writeNoteSettings(before, next, settingsKind(r), opts.remove ?? [])
    mkdirSync(dirname(this.file(r)), { recursive: true })
    const w = await commitText(this.file(r), text, before === null ? null : contentHash(before))
    if (!w.ok) throw new NoteError('precondition_failed', 'the settings have changed', this.read(r).etag)
    this.cache.delete(r)
    return this.read(r)
  }

  /** Where new images of the note at `path` go, if its space's settings say: null when they don't. */
  attachmentsFor(path: string): AttachmentsConfig | null {
    const root = spaceRootOf(path)
    return root === null ? null : this.read(root).resolved.attachments
  }

  /**
   * Daily-note series, one per path (see the header): when two give the same
   * note, the person's own (`own`) is kept over a space's (`spaces`), and a
   * space's over vihko.yaml's (`installation`): the closest, with its
   * template. Listed in that order too, so the first is the one closest to
   * them (the default of «Today's note» until they choose). `sameAs`: for
   * each series left out, the id of the one kept for its path (a choice of
   * it still means those notes). Who is offered which is the caller's to
   * judge.
   */
  series(installation: readonly Series[], spaces: readonly string[], own: string, username: string): { list: Series[]; sameAs: Map<string, string> } {
    const kept = new Map<string, string>()
    const sameAs = new Map<string, string>()
    const keep = (list: readonly Series[]) => list.filter((s) => {
      const key = seriesPattern(s).replaceAll('{user}', username).normalize('NFC').toLowerCase()
      const first = kept.get(key)
      if (first !== undefined) {
        if (first !== s.id) sameAs.set(s.id, first)
        return false
      }
      kept.set(key, s.id)
      return true
    })
    const fromOwn = keep(this.read(own).resolved.daily)
    const fromSpaces = keep(spaces.flatMap((root) => this.read(root).resolved.daily))
    const fromInstallation = keep(installation)
    return { list: [...fromOwn, ...fromSpaces, ...fromInstallation], sameAs }
  }

  /** A person's own space's root. */
  static own(username: string): string {
    return personalRoot(username)
  }
}

export { NoteSettingsFileError }
