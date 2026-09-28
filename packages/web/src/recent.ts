// Recently opened notes, for the palette with an empty query. It's a
// convenience of this browser: if there's no storage, the list stays empty.
const KEY = 'vihko.recent'
const MAX = 8

export function recentNotes(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX) : []
  } catch { return [] }
}

export function rememberNote(path: string) {
  const next = [path, ...recentNotes().filter((p) => p !== path)].slice(0, MAX)
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* no persistence */ }
}
