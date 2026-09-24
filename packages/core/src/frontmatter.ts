// Frontmatter YAML: localizarlo, leerlo y modificar una clave sin re-serializar
// el bloque. Todo lo que no se toca explícitamente se conserva byte a byte
// (comentarios, orden, comillas, estilo de listas, claves desconocidas).
import { isDeepStrictEqual } from 'node:util'
import { isMap, isScalar, parseDocument, stringify, type Document } from 'yaml'

export type Eol = '\n' | '\r\n'

export interface FrontmatterBlock {
  /** El archivo empieza por BOM (U+FEFF). */
  bom: boolean
  eol: Eol
  /** Offset de la línea `---` de apertura (tras el BOM). */
  start: number
  /** Offsets del YAML entre los delimitadores. */
  yamlStart: number
  yamlEnd: number
  /** Offset justo después de la línea de cierre (inicio del cuerpo). */
  end: number
}

export interface Frontmatter {
  /** null si la nota no tiene frontmatter. */
  block: FrontmatterBlock | null
  /** Datos del YAML; `{}` si no hay frontmatter o si es inválido. */
  data: Record<string, unknown>
  /** Mensaje si el YAML no se puede leer o no es un mapa. Una nota así nunca se escribe. */
  error: string | null
  /** Offset donde empieza el cuerpo. */
  bodyStart: number
}

export class FrontmatterError extends Error {}

const BOM = '﻿'
const CLOSING = /^(?:---|\.\.\.)[ \t]*$/

export function locateFrontmatter(text: string): FrontmatterBlock | null {
  const bom = text.startsWith(BOM)
  const start = bom ? 1 : 0
  let eol: Eol
  if (text.startsWith('---\r\n', start)) eol = '\r\n'
  else if (text.startsWith('---\n', start)) eol = '\n'
  else return null
  const yamlStart = start + 3 + eol.length
  let lineStart = yamlStart
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl === -1 ? text.length : nl
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (CLOSING.test(line)) {
      return { bom, eol, start, yamlStart, yamlEnd: lineStart, end: nl === -1 ? text.length : nl + 1 }
    }
    if (nl === -1) break
    lineStart = nl + 1
  }
  return null // sin cierre: no es frontmatter, todo es cuerpo
}

function parseYaml(raw: string): { doc: Document; data: Record<string, unknown> } | { error: string } {
  // Esquema core de YAML 1.2: sin fechas ni otras conversiones implícitas de YAML 1.1.
  const doc = parseDocument(raw, { schema: 'core', uniqueKeys: true, prettyErrors: false })
  if (doc.errors.length) return { error: doc.errors[0]!.message }
  if (doc.contents !== null && !isMap(doc.contents)) return { error: 'el frontmatter no es un mapa' }
  const data = (doc.toJS({ maxAliasCount: 100 }) ?? {}) as Record<string, unknown>
  return { doc, data }
}

export function readFrontmatter(text: string): Frontmatter {
  const block = locateFrontmatter(text)
  if (!block) return { block: null, data: {}, error: null, bodyStart: text.startsWith(BOM) ? 1 : 0 }
  const parsed = parseYaml(text.slice(block.yamlStart, block.yamlEnd))
  if ('error' in parsed) return { block, data: {}, error: parsed.error, bodyStart: block.end }
  return { block, data: parsed.data, error: null, bodyStart: block.end }
}

export type ScalarValue = string | number | boolean

function scalarText(value: ScalarValue): string {
  if (typeof value === 'string' && /[\r\n]/.test(value)) {
    throw new FrontmatterError('el parche de frontmatter solo admite valores de una línea')
  }
  return stringify(value, { lineWidth: 0 }).trimEnd()
}

/**
 * Devuelve `text` con la clave de primer nivel `key` fijada a `value`, tocando
 * solo los bytes de ese valor (o añadiendo una línea, o creando el bloque).
 * Lanza FrontmatterError si el frontmatter es inválido: una nota así no se escribe.
 */
export function setFrontmatterKey(text: string, key: string, value: ScalarValue): string {
  const block = locateFrontmatter(text)
  const valueText = scalarText(value)
  const keyText = scalarText(key)

  let out: string
  if (!block) {
    const bom = text.startsWith(BOM) ? BOM : ''
    const body = text.slice(bom.length)
    const eol: Eol = /\r\n/.test(body) ? '\r\n' : '\n'
    out = `${bom}---${eol}${keyText}: ${valueText}${eol}---${eol}${body}`
  } else {
    const raw = text.slice(block.yamlStart, block.yamlEnd)
    const parsed = parseYaml(raw)
    if ('error' in parsed) throw new FrontmatterError(`frontmatter inválido: ${parsed.error}`)
    const map = parsed.doc.contents
    const pair = isMap(map) ? map.items.find((p) => isScalar(p.key) && p.key.value === key) : undefined
    let newRaw: string
    if (!pair) {
      newRaw = raw + `${keyText}: ${valueText}${block.eol}`
    } else {
      const keyNode = pair.key as { range?: [number, number, number] }
      const valueNode = pair.value as { range?: [number, number, number] } | null
      const colon = raw.indexOf(':', keyNode.range![1])
      if (!valueNode?.range) {
        // `clave:` sin valor.
        newRaw = raw.slice(0, colon + 1) + ' ' + valueText + raw.slice(colon + 1)
      } else {
        const [vStart, vEnd] = valueNode.range
        // Valor en bloque en las líneas siguientes: se sustituye desde los dos puntos.
        const from = raw.slice(colon + 1, vStart).includes('\n') ? colon + 1 : vStart
        const to = vEnd
        newRaw = raw.slice(0, from) + (from === colon + 1 ? ' ' : '') + valueText + trailingEol(raw, from, to, block.eol) + raw.slice(to)
      }
    }
    out = text.slice(0, block.yamlStart) + newRaw + text.slice(block.yamlEnd)
  }

  verifyPatch(text, out, key, value)
  return out
}

/** Si lo sustituido abarcaba líneas completas, conserva el salto de línea final. */
function trailingEol(raw: string, from: number, to: number, eol: Eol): string {
  const replaced = raw.slice(from, to)
  return replaced.includes('\n') && replaced.endsWith('\n') ? eol : ''
}

/** Red de seguridad: el resultado debe tener el valor pedido y todo lo demás igual. */
function verifyPatch(before: string, after: string, key: string, value: ScalarValue) {
  const a = readFrontmatter(before)
  const b = readFrontmatter(after)
  if (b.error) throw new FrontmatterError(`el parche produjo YAML inválido: ${b.error}`)
  if (!isDeepStrictEqual(b.data[key], value)) throw new FrontmatterError('el parche no fijó el valor pedido')
  const restA = { ...a.data }
  const restB = { ...b.data }
  delete restA[key]
  delete restB[key]
  if (!isDeepStrictEqual(restA, restB)) throw new FrontmatterError('el parche alteró otras claves')
  if (before.slice(a.bodyStart) !== after.slice(b.bodyStart)) throw new FrontmatterError('el parche alteró el cuerpo')
}
