// Conversión segura de lo que escribe el usuario a una consulta FTS5: nunca se
// pasa su texto como sintaxis FTS5 (operadores, comillas o columnas darían
// errores o resultados raros). Cada palabra es un término; la última, un prefijo.

/** Marcas de resaltado en los fragmentos: caracteres de control, no HTML. */
export const HIGHLIGHT_START = '\u0002'
export const HIGHLIGHT_END = '\u0003'

export function ftsQuery(input: string): string | null {
  const terms = input.normalize('NFC').match(/[\p{L}\p{N}_]+/gu)
  if (!terms) return null
  return terms.map((t, i) => `"${t}"` + (i === terms.length - 1 ? '*' : '')).join(' ')
}
