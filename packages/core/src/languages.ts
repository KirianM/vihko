// The languages the UI is translated into. The server stores a person's
// choice (profiles.ts) and checks it against this list; the UI has one
// dictionary for each (i18n.tsx), and its type makes sure none is missing.
export const LANGUAGES = ['en', 'es'] as const

export type Language = (typeof LANGUAGES)[number]

export const isLanguage = (v: unknown): v is Language => typeof v === 'string' && (LANGUAGES as readonly string[]).includes(v)
