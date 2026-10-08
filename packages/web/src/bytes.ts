// A size in bytes as a person reads it, in their language: «1 byte»,
// «51 bytes», «1.2 KB» («1,2 KB» in Spanish), «3.4 MB». Intl's own unit
// formatting says «51 byte» in English and isn't the same in every language,
// so the word for bytes is chosen by the plural rules and the larger units are
// the symbols everyone writes.

const UNITS = ['KB', 'MB', 'GB', 'TB'] as const

/** The word for a number of bytes, by the language's plural rules. */
const BYTE_WORDS: Record<string, { one: string; other: string }> = {
  en: { one: 'byte', other: 'bytes' },
  es: { one: 'byte', other: 'bytes' },
}

export function formatBytes(bytes: number, lang: string): string {
  const base = lang.split('-')[0]!.toLowerCase()
  const n = Math.max(0, Math.round(bytes))
  if (n < 1024) {
    const words = BYTE_WORDS[base] ?? BYTE_WORDS.en!
    const plural = new Intl.PluralRules(lang).select(n) === 'one' ? words.one : words.other
    return `${new Intl.NumberFormat(lang).format(n)} ${plural}`
  }
  let size = n / 1024
  let i = 0
  while (size >= 1024 && i < UNITS.length - 1) { size /= 1024; i++ }
  return `${new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(size)} ${UNITS[i]}`
}
