// Palette commands (">" mode). Adding one means adding an entry to the list;
// whatever it needs from the application arrives through the context.
import type { MessageKey } from './i18n.tsx'
import { chooseTheme, type Theme } from './theme.ts'

/** Window event: insert an image in the open note. */
export const INSERT_IMAGE = 'thoth:insert-image'

export interface CommandContext {
  theme: Theme
  /** Open note, if there is one. */
  openPath: string | null
  /** Switches the palette to create-note mode in the current folder. */
  newNote: () => void
  /** Opens (or creates) today's note; null while thoth.yaml declares no series. */
  today: (() => void) | null
}

export interface Command {
  id: string
  label: (c: CommandContext) => MessageKey
  /** If missing, the command is always available. */
  available?: (c: CommandContext) => boolean
  run: (c: CommandContext) => void
}

export const commands: Command[] = [
  {
    id: 'theme',
    label: (c) => (c.theme === 'dark' ? 'cmd.themeLight' : 'cmd.themeDark'),
    run: (c) => chooseTheme(c.theme === 'dark' ? 'light' : 'dark'),
  },
  { id: 'new-note', label: () => 'cmd.newNote', run: (c) => c.newNote() },
  { id: 'today', label: () => 'cmd.today', available: (c) => c.today !== null, run: (c) => c.today?.() },
  // The open note listens for this event and opens its «Insert image» dialog.
  { id: 'insert-image', label: () => 'cmd.insertImage', available: (c) => c.openPath !== null, run: () => { window.dispatchEvent(new Event(INSERT_IMAGE)) } },
]
