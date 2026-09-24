// Ediciones por operación: se aplican sobre el texto actual de forma atómica, sin
// exigir que el resto de la nota no haya cambiado. Es lo que permite a un agente
// escribir en una nota mientras alguien la edita (el ETag cambia en cada
// pulsación, así que una sustitución completa con If-Match nunca acertaría).
import { NoteError } from './notes.ts'

export type EditOp =
  /** Sustituye `find` (texto exacto) por `replace`. Falla si no aparece exactamente `expectedCount` veces (1 por defecto). */
  | { op: 'find_replace'; find: string; replace: string; expectedCount?: number }
  /** Añade texto al final de la nota (con salto de línea si hace falta). */
  | { op: 'append'; text: string }

export function applyEdits(text: string, ops: EditOp[]): string {
  let out = text
  for (const [i, e] of ops.entries()) {
    if (e.op === 'find_replace') {
      if (!e.find) throw new NoteError('edit_mismatch', `operación ${i}: find vacío`)
      const expected = e.expectedCount ?? 1
      const count = out.split(e.find).length - 1
      if (count !== expected) {
        throw new NoteError('edit_mismatch', `operación ${i}: se esperaban ${expected} apariciones y hay ${count}`)
      }
      out = out.split(e.find).join(e.replace)
    } else if (e.op === 'append') {
      out += (out === '' || out.endsWith('\n') ? '' : '\n') + e.text
    } else {
      throw new NoteError('edit_mismatch', `operación ${i}: tipo desconocido`)
    }
  }
  return out
}
