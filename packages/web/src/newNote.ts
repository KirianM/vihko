// Where a note typed by name goes (the palette's «create»): a `/` separates
// folders, as a path does in the API (`POST /api/note`), from the folder the
// palette creates in, or from the root when it starts with `/`.

export interface NewNote {
  /** The note's path, with `.md`. */
  path: string
  /** Its folder ('' = the root). */
  folder: string
  /** Its name: the file's without `.md`, and the title it starts with. */
  title: string
}

/** One name of a path: no control characters, `\` or runs of spaces, no leading dot (it would be hidden) and no `.md`. */
function cleanName(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\\/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/\.md$/i, '')
    .trim()
}

/**
 * The note `input` names, created from `folder` ('' = the root): its last
 * part is the note, the ones before it folders (`projects/Launch plan` is
 * `Launch plan.md` in `projects`, inside `folder`); a leading `/` starts from
 * `root`, the root of the space `folder` is in (D-056: nothing is created at
 * the notes root). Empty parts are left out (`a//b`, and `..`, which is
 * nothing once its dots go). null when there is no name (nothing typed, or a
 * trailing `/`).
 */
export function newNote(input: string, folder: string, root = ''): NewNote | null {
  const typed = input.normalize('NFC')
  const parts = typed.split('/')
  const title = cleanName(parts.pop()!)
  if (!title) return null
  const base = (typed.trimStart().startsWith('/') ? root : folder).split('/').filter(Boolean)
  const dir = [...base, ...parts.map(cleanName).filter(Boolean)].join('/')
  return { path: dir ? `${dir}/${title}.md` : `${title}.md`, folder: dir, title }
}
