// Comandos de la paleta (modo «>»). Añadir uno es añadir una entrada a la lista;
// lo que necesite de la aplicación le llega por el contexto.
import type { MessageKey } from './i18n.tsx'
import { chooseTheme, type Theme } from './theme.ts'

export interface CommandContext {
  theme: Theme
  /** Nota abierta, si hay alguna. */
  openPath: string | null
  /** Pasa la paleta al modo de crear nota en la carpeta actual. */
  newNote: () => void
}

export interface Command {
  id: string
  label: (c: CommandContext) => MessageKey
  /** Si falta, el comando está siempre disponible. */
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
]
