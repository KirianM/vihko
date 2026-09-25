// Notas abiertas hace poco, para la paleta con la consulta vacía. Es una
// comodidad de este navegador: si no hay almacenamiento, la lista queda vacía.
const KEY = 'thoth.recent'
const MAX = 8

export function recentNotes(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX) : []
  } catch { return [] }
}

export function rememberNote(path: string) {
  const next = [path, ...recentNotes().filter((p) => p !== path)].slice(0, MAX)
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* sin persistencia */ }
}
