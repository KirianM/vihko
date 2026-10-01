// Keyboard shortcuts the shell and the note editor share. The editor is loaded
// apart from the shell (Shell.tsx), so this module imports nothing of it.

/** A Mac (or an iPhone, an iPad): ⌘ where others have Ctrl, and Option changes the character a key types. */
export const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)

/**
 * Windows, where AltGr comes as Ctrl+Alt: a Ctrl+Alt shortcut is told apart
 * from a character typed with AltGr only by the key it types (e.key), as
 * CodeMirror does for the editor's own Ctrl+Alt shortcuts.
 */
export const WINDOWS = typeof navigator !== 'undefined' && /Win/.test(navigator.platform)

/** `Mod-Alt-k` as shown: Ctrl+Alt+K, or ⌥⌘K on a Mac. */
export function keys(binding: string): string {
  const parts = binding.split('-')
  const key = parts.pop()!.toUpperCase()
  const mods = parts.map((p) => (p === 'Mod' ? (MAC ? 'Meta' : 'Ctrl') : p))
  const mac: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }
  return MAC ? ['Ctrl', 'Alt', 'Shift', 'Meta'].filter((m) => mods.includes(m)).map((m) => mac[m]).join('') + key : [...mods, key].join('+')
}

type Taker = (e: KeyboardEvent) => boolean
const takers = new Set<Taker>()

/**
 * ⌘K / Ctrl+K opens the palette from anywhere (Shell.tsx), unless something
 * takes it first: the note editor, with text selected, makes that text a link
 * (as Outline, GitHub, Joplin and Typora do). `take` runs its command and
 * returns true, or returns false to leave the key to the palette. Returns the
 * function that stops it.
 */
export function takeModK(take: Taker): () => void {
  takers.add(take)
  return () => { takers.delete(take) }
}

/** Whether something took this ⌘K (and has already run its command) instead of the palette. */
export function modKTaken(e: KeyboardEvent): boolean {
  for (const take of takers) if (take(e)) return true
  return false
}
