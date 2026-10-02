// Creating a note from a broken link: the «missing · create» badge next to a
// `[[link]]` (or a `[text](note.md)`) whose note doesn't exist, and where that
// note goes. The editor only shows the badge; creating is the note view's job.
import { Facet } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { isRootTarget, joinPath, sameSpace } from '@vihko/core/resolve'
import { resolveImageRef } from '@vihko/core/images'
import { isFileTarget } from './files.ts'

/** A broken link the person asked to create: where the note goes and its title. */
export interface NewLinkedNote {
  /** Path of the new note, from the notes root, with `.md`. */
  path: string
  /** Its title (`# title`): the name as written in the link. */
  title: string
  /** The link's literal text, to check afterwards that it resolves there. */
  raw: string
}

export interface CreateLinkUi {
  /** Text of the action (`create`). */
  label: string
  /** Tooltip: what is created where. */
  where: (note: NewLinkedNote) => string
  create: (note: NewLinkedNote, anchor: HTMLElement) => void
}

export const createLinkUi = Facet.define<CreateLinkUi, CreateLinkUi | null>({ combine: (v) => v[0] ?? null })

/** A name for a file: no control characters or backslashes, no leading dot (hidden), no `.md`. */
function cleanSegment(s: string): string {
  return s.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\\/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .trim()
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

/**
 * Where the note of a missing wikilink is created so that the link resolves to
 * it: the link's name in the note's folder. A target with folders
 * (`[[project/Plan]]`) keeps them below that folder, and one from the root
 * (`[[/project/Plan]]`, `[[people/ana/Plan]]`) is created there. Only in the
 * note's own space (a link never leads to another space, so a note
 * anywhere else would leave it broken): null for a target elsewhere, or if no
 * valid name is left.
 */
export function wikiLinkNote(source: string, raw: string): NewLinkedNote | null {
  const embed = raw.startsWith('!')
  const inner = raw.slice(embed ? 3 : 2, -2)
  const target = inner.split('|')[0]!.replace(/#.*$/, '').trim()
  // A file's name (`[[invoice.pdf]]`) isn't a note to create.
  if (!target || isFileTarget(target)) return null
  const fromRoot = target.startsWith('/') || isRootTarget(target)
  const parts = target.replace(/^\/+/, '').replace(/\.md$/i, '').split('/').map((p) => p.trim())
  // A name that would have to change to be a valid file (hidden, control characters…) wouldn't match the link.
  if (parts.some((p) => p === '' || p === '..' || cleanSegment(p) !== p.normalize('NFC'))) return null
  const rel = parts.join('/') + '.md'
  const path = fromRoot ? rel : joinPath(dirOf(source), rel)
  return sameSpace(source, path) ? { path, title: parts[parts.length - 1]!, raw } : null
}

/** The same for `[text](dest.md)`: relative to the note, only for `.md` destinations in the note's own space. */
export function markdownLinkNote(source: string, raw: string, dest: string): NewLinkedNote | null {
  const path = resolveImageRef(source, dest)
  if (!path || !/\.md$/i.test(path) || !sameSpace(source, path)) return null
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
  if (path.split('/').some((p) => p.startsWith('.') || cleanSegment(p) !== p)) return null
  return { path, title: name, raw }
}

/** «missing · create» next to a broken link; just «missing» where nothing can be created. */
export function missingBadge(view: EditorView, missing: string, note: NewLinkedNote | null): HTMLElement {
  const badge = document.createElement('span')
  badge.className = 'cm-wikilink-badge'
  badge.textContent = missing
  const ui = view.state.facet(createLinkUi)
  if (!ui || !note) return badge
  badge.append(' · ')
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'cm-wikilink-create'
  b.textContent = ui.label
  b.title = ui.where(note)
  // The cursor must not move into the link: that would turn it back into text and drop the button.
  b.addEventListener('mousedown', (e) => e.preventDefault())
  b.addEventListener('click', (e) => {
    e.preventDefault()
    ui.create(note, b)
  })
  badge.append(b)
  return badge
}

/** For widgets' ignoreEvent: events on the create button are the button's, not the editor's. */
export const onCreateButton = (e: Event) => e.target instanceof Element && e.target.closest('.cm-wikilink-create') !== null
