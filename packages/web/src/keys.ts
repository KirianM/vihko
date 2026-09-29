// Keyboard shortcuts the shell and the note editor share. The editor is loaded
// apart from the shell (Shell.tsx), so this module imports nothing of it.

/**
 * Windows, where AltGr comes as Ctrl+Alt: a Ctrl+Alt shortcut is told apart
 * from a character typed with AltGr only by the key it types (e.key), as
 * CodeMirror does for the editor's own Ctrl+Alt shortcuts.
 */
export const WINDOWS = typeof navigator !== 'undefined' && /Win/.test(navigator.platform)
