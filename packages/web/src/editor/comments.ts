// Comentarios dentro de la nota (D-023): comentarios HTML con autor, fecha y texto.
//
//   Usaremos Postgres para el índice.<!-- @noa 2026-09-24 10:12 · esto no, usa SQLite -->
//   <!-- @claude 2026-09-24 10:15 · ↳ de acuerdo, lo cambio -->
//
// - Hilo: comentarios consecutivos (solo espacios o un salto de línea entre ellos).
//   `↳` marca las respuestas.
// - Ancla: el texto que precede al primer comentario del hilo en su línea, desde el
//   inicio de la frase (o de la línea, o desde el comentario anterior). Así el ancla
//   se deduce del archivo, sin marcas de inicio ni posiciones guardadas aparte.
// - Fecha: hora local de quien comenta, `AAAA-MM-DD HH:MM`, sin zona.
//
// Módulo puro (sin DOM ni CodeMirror): lo prueba el runner de Node. Quien lo usa
// aplica los cambios que devuelve sobre el Y.Text de la sesión.

export interface Comment {
  from: number
  to: number
  author: string
  date: string
  text: string
  reply: boolean
}

export interface Thread {
  /** Estable mientras no cambie el primer comentario: autor, fecha, texto y aparición. */
  id: string
  comments: Comment[]
  /** Desde el primer comentario hasta el final del último. */
  from: number
  to: number
  /** Texto comentado; vacío si el hilo está solo en su línea. */
  anchorFrom: number
  anchorTo: number
}

/** Cambio sobre el texto: borrar [from, to) e insertar `insert`. */
export interface Change {
  from: number
  to: number
  insert: string
}

const COMMENT = /<!--[ \t]*@([\p{L}\p{N}._-]+)[ \t]+(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)[ \t]*·[ \t]*([\s\S]*?)[ \t]*-->/gu
const REPLY = /^↳[ \t]*/
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/
/** Fin de frase: un signo de cierre seguido de espacio. */
const SENTENCE_END = /[.!?…][)"'»”’]*\s+/g
/** Marcas de bloque al inicio de línea que no forman parte del texto comentado. */
const BLOCK_PREFIX = /^[ \t]*(?:>[ \t]?)*(?:#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/

/** Rangos de bloques de código cercados: ahí un `<!-- -->` es código, no un comentario. */
function fencedRanges(doc: string): [number, number][] {
  const out: [number, number][] = []
  let open: { at: number; mark: string } | null = null
  let pos = 0
  for (const line of doc.split('\n')) {
    const m = FENCE.exec(line)
    if (m) {
      if (!open) open = { at: pos, mark: m[1]! }
      else if (m[1]![0] === open.mark[0] && m[1]!.length >= open.mark.length && line.trim() === m[1]) {
        out.push([open.at, pos + line.length])
        open = null
      }
    }
    pos += line.length + 1
  }
  if (open) out.push([open.at, doc.length])
  return out
}

export function parseComments(doc: string): Comment[] {
  const fences = fencedRanges(doc)
  const out: Comment[] = []
  for (const m of doc.matchAll(COMMENT)) {
    const from = m.index
    if (fences.some(([a, b]) => from >= a && from < b)) continue
    const body = m[3]!.trim()
    out.push({
      from,
      to: from + m[0].length,
      author: m[1]!,
      date: m[2]!,
      text: body.replace(REPLY, ''),
      reply: REPLY.test(body),
    })
  }
  return out
}

/** Entre dos comentarios del mismo hilo solo cabe espacio y, como mucho, un salto de línea. */
const joins = (between: string) => /^[ \t]*(?:\n[ \t]*)?$/.test(between)

function anchorOf(doc: string, at: number, floor: number): [number, number] {
  const lineStart = doc.lastIndexOf('\n', at - 1) + 1
  let start = Math.max(lineStart, floor)
  // La frase en la que acaba el texto: último fin de frase antes del final (sin contar
  // el signo con el que acaba el propio texto comentado).
  const before = doc.slice(start, at)
  const trimmed = before.replace(/[.!?…][)"'»”’]*\s*$/, '')
  let last = -1
  for (const m of trimmed.matchAll(SENTENCE_END)) last = m.index + m[0].length
  if (last > 0) start += last
  else if (start === lineStart) start += BLOCK_PREFIX.exec(before)![0].length
  let end = at
  while (start < end && /\s/.test(doc[start]!)) start++
  while (end > start && /\s/.test(doc[end - 1]!)) end--
  return [start, end]
}

export function parseThreads(doc: string): Thread[] {
  const threads: Thread[] = []
  const seen = new Map<string, number>()
  let prevEnd = 0
  for (const c of parseComments(doc)) {
    const cur = threads[threads.length - 1]
    if (cur && joins(doc.slice(cur.to, c.from))) {
      cur.comments.push(c)
      cur.to = c.to
    } else {
      const [anchorFrom, anchorTo] = anchorOf(doc, c.from, prevEnd)
      const base = `${c.author}|${c.date}|${c.text}`
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      threads.push({ id: `${base}|${n}`, comments: [c], from: c.from, to: c.to, anchorFrom, anchorTo })
    }
    prevEnd = c.to
  }
  return threads
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Hora local, `AAAA-MM-DD HH:MM`. */
export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Una línea, sin nada que cierre el comentario antes de tiempo. */
export function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/--+>/g, (m) => m.slice(0, -1) + ' >')
}

export function formatComment(author: string, date: Date, text: string, reply = false): string {
  return `<!-- @${author} ${formatDate(date)} · ${reply ? '↳ ' : ''}${cleanText(text)} -->`
}

/**
 * Dónde se inserta un comentario nuevo sobre la selección [from, to): pegado al final
 * de lo seleccionado, sin partir una palabra. Sin selección, al final de la frase (o de
 * la línea) donde está el cursor. Dentro de un comentario, tras su hilo.
 */
export function commentPosition(doc: string, from: number, to: number): number {
  let at = to
  if (from === to) {
    const lineEnd = doc.indexOf('\n', at) === -1 ? doc.length : doc.indexOf('\n', at)
    const rest = doc.slice(at, lineEnd)
    const m = /[.!?…][)"'»”’]*(?=\s|$)/.exec(rest)
    at = m ? at + m.index + m[0].length : lineEnd
    // Sin espacios colgando antes del comentario.
    while (at > from && /[ \t]/.test(doc[at - 1]!)) at--
  } else {
    while (at > from && /\s/.test(doc[at - 1]!)) at--
    while (at < doc.length && /[\p{L}\p{N}_]/u.test(doc[at]!) && at > 0 && /[\p{L}\p{N}_]/u.test(doc[at - 1]!)) at++
  }
  for (const t of parseThreads(doc)) if (at > t.from && at < t.to) return t.to
  for (const c of parseComments(doc)) if (at > c.from && at < c.to) return c.to
  return at
}

export function addComment(doc: string, at: number, author: string, date: Date, text: string): Change {
  return { from: at, to: at, insert: formatComment(author, date, text) }
}

/**
 * Respuesta al final del hilo. En su propia línea (como en D-023) si el hilo cierra la
 * línea y lo siguiente es una línea en blanco o el final; si no, pegada al hilo, para
 * no partir el párrafo en dos.
 */
export function replyTo(doc: string, thread: Thread, author: string, date: Date, text: string): Change {
  const comment = formatComment(author, date, text, true)
  const lineEnd = doc.indexOf('\n', thread.to) === -1 ? doc.length : doc.indexOf('\n', thread.to)
  const restBlank = doc.slice(thread.to, lineEnd).trim() === ''
  const nextEnd = doc.indexOf('\n', lineEnd + 1) === -1 ? doc.length : doc.indexOf('\n', lineEnd + 1)
  const nextBlank = lineEnd >= doc.length || doc.slice(lineEnd + 1, nextEnd).trim() === ''
  if (restBlank && nextBlank) return { from: lineEnd, to: lineEnd, insert: '\n' + comment }
  return { from: thread.to, to: thread.to, insert: comment }
}

/** Resolver es borrar el hilo (D-023). Si ocupaba la línea entera, se va la línea. */
export function resolveThread(doc: string, thread: Thread): Change {
  const lineStart = doc.lastIndexOf('\n', thread.from - 1) + 1
  const lineEnd = doc.indexOf('\n', thread.to) === -1 ? doc.length : doc.indexOf('\n', thread.to)
  if (doc.slice(lineStart, thread.from).trim() === '' && doc.slice(thread.to, lineEnd).trim() === '') {
    if (lineEnd < doc.length) return { from: lineStart, to: lineEnd + 1, insert: '' }
    if (lineStart > 0) return { from: lineStart - 1, to: lineEnd, insert: '' }
    return { from: lineStart, to: lineEnd, insert: '' }
  }
  return { from: thread.from, to: thread.to, insert: '' }
}
