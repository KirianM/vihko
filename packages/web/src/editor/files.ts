// Files of the notes folder that aren't notes, as the browser reaches them:
// by their path, or as a note names them Obsidian's way (`![[photo.png]]`,
// `[[invoice.pdf]]`), which the server resolves relative to the note or by
// name in its space. Opened in a tab of their own: the browser shows what it
// can (an image, a PDF) and downloads the rest.

/** URL the browser loads a file of the notes folder from. */
export const fileUrl = (path: string) => `/api/file?path=${encodeURIComponent(path)}`

/** URL of the file `name` names, written in the note at `note` (relative to it, or by name in its space). */
export const namedFileUrl = (note: string, name: string) => `/api/file?note=${encodeURIComponent(note)}&name=${encodeURIComponent(name)}`

/** Opens a file in a new tab, without the page reaching this one. */
export function openFile(path: string) {
  window.open(fileUrl(path), '_blank', 'noopener,noreferrer')
}

/**
 * A file's extension: up to 8 letters or digits, with a letter, so that a
 * note named `v1.2` or `Report 2026.10` is still a note's name (as the
 * server's fileNames.ts judges it).
 */
const FILE_EXTENSION = /\.(?=[a-z0-9]*[a-z])[a-z0-9]{1,8}$/i

/** Whether a link's target names a file that isn't a note: it has an extension (FILE_EXTENSION), and it isn't `.md`. */
export function isFileTarget(target: string): boolean {
  const t = target.replace(/[#?].*$/, '').trim()
  const name = t.slice(t.lastIndexOf('/') + 1)
  return FILE_EXTENSION.test(name) && !name.startsWith('.') && !/\.md$/i.test(name)
}
