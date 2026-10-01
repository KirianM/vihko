// The note settings of each space (core noteSettings.ts): a person's own,
// `people/<user>/.vihko/settings.yaml`, and a shared space's,
// `spaces/<name>/.vihko/settings.yaml`. They add to what vihko.yaml says for
// the whole installation:
//
// - daily-note series: a person is offered vihko.yaml's, those of the shared
//   spaces they belong to and their own, where they can write today's note;
//   two that give the same path are one (the first: vihko.yaml's, then a
//   space's, then theirs). A daily note is its path: nothing is duplicated or
//   moved by declaring a series twice.
// - templates folders: vihko.yaml's, their spaces' and their own, those they
//   read.
// - where new images go: a space's setting for the notes of that space,
//   otherwise vihko.yaml's.
// - the guide for agents: vihko.yaml's, then that of each shared space the
//   key reaches, then the person's own (each a note the key must read).
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
  type AttachmentsConfig, type ConfigError, type NoteSettings, type ResolvedNoteSettings, type Series,
} from '@vihko/core'
import { commitText, readText } from './fsutil.ts'
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

export class NoteSettingsStore {
  private notesDir: string
  private cache = new Map<string, Cached>()

  constructor(opts: { notesDir: string }) {
    this.notesDir = opts.notesDir
  }

  private file(root: string) {
    return join(this.notesDir, noteSettingsPath(root))
  }

  private stamp(root: string): string {
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
      const { settings, errors } = parseNoteSettings(text)
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
  async write(root: string, next: NoteSettings, opts: { ifMatch?: string } = {}): Promise<SettingsRead> {
    const r = root.normalize('NFC')
    const now = this.read(r)
    if (opts.ifMatch !== undefined && opts.ifMatch !== now.etag) throw new NoteError('precondition_failed', 'the settings have changed', now.etag)
    const before = now.etag === contentHash('') && this.stamp(r) === '' ? null : readText(this.file(r))
    const text = writeNoteSettings(before, next)
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
   * note, vihko.yaml's (`installation`) is kept over a space's (`spaces`), and
   * a space's over the person's own (`own`). Listed the other way round: the
   * person's own first, then their spaces', then the installation's, so the
   * first is the one closest to them (the default of «Today's note» until
   * they choose). Who is offered which is the caller's to judge.
   */
  series(installation: readonly Series[], spaces: readonly string[], own: string, username: string): Series[] {
    const seen = new Set<string>()
    const keep = (list: readonly Series[]) => list.filter((s) => {
      const key = seriesPattern(s).replaceAll('{user}', username).normalize('NFC').toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const fromInstallation = keep(installation)
    const fromSpaces = keep(spaces.flatMap((root) => this.read(root).resolved.daily))
    const fromOwn = keep(this.read(own).resolved.daily)
    return [...fromOwn, ...fromSpaces, ...fromInstallation]
  }

  /** Templates folders of `spaces` and the person's own space (`own`), in that order. */
  templates(spaces: readonly string[], own: string): string[] {
    return [...spaces.flatMap((root) => this.read(root).resolved.templates), ...this.read(own).resolved.templates]
  }

  /** The guides for agents of `spaces` and of the person's own space, as notes: [where it's from, the note]. */
  guides(spaces: readonly string[], own: string): { root: string; note: string }[] {
    const out: { root: string; note: string }[] = []
    for (const root of spaces) {
      const g = this.read(root).resolved.agents
      if (g) out.push({ root, note: g })
    }
    const mine = this.read(own).resolved.agents
    if (mine) out.push({ root: own, note: mine })
    return out
  }

  /** A person's own space's root. */
  static own(username: string): string {
    return personalRoot(username)
  }
}

export { NoteSettingsFileError }
