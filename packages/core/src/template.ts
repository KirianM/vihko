// Templates: a plain `.md` note whose text is copied into a new note, with a
// fixed set of variables filled in. Never any code: a template can't run
// anything, loop or read other notes.
import { formatDate, type CivilDateTime } from './dates.ts'

export interface TemplateVars {
  /** Now, in the timezone of the person creating the note. */
  now: CivilDateTime
  /** Name of the person creating the note. */
  user: string
  /** Title of the new note: its file name without `.md`. */
  title: string
}

/** Format of a bare `{{date}}`. */
export const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD'

/**
 * Fills in `{{date}}`, `{{date:FORMAT}}` (tokens in `formatDate`), `{{user}}`
 * and `{{title}}`. Spaces just inside the braces are allowed. Anything else
 * in `{{…}}` is left as is, and the values put in are never expanded again (a
 * title that contains `{{date}}` stays literal).
 */
export function renderTemplate(text: string, vars: TemplateVars): string {
  return text.replace(/\{\{\s*([A-Za-z]+)(?::([^{}]*?))?\s*\}\}/g, (whole, name: string, format: string | undefined) => {
    switch (name) {
      case 'date': return formatDate(format === undefined ? DEFAULT_DATE_FORMAT : format, vars.now)
      case 'user': return format === undefined ? vars.user : whole
      case 'title': return format === undefined ? vars.title : whole
      default: return whole
    }
  })
}
