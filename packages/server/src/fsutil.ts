// Protocolo de escritura segura sobre la carpeta de notas, validado en
// poc/crdt-bridge (ver su README): temporal sincronizado fuera de la ventana de
// carrera, recomprobación del hash justo antes del rename, enlace duro para
// rescatar escrituras "in situ" que caigan en la ventana, y lecturas estables
// frente a editores que truncan y reescriben.
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { contentHash } from '@thoth/core'

let counter = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Contenido del archivo, o null si no existe. */
export function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Lectura de un archivo que otro proceso puede estar escribiendo: solo se acepta
 * cuando dos lecturas seguidas coinciden. Si parece un vaciado masivo respecto a
 * `reference`, se exige más estabilidad.
 */
export async function readStable(file: string, reference?: string | null, gap = 60): Promise<string | null> {
  let a = readText(file)
  for (let i = 0; i < 20; i++) {
    const suspicious = reference != null && a !== null && a.length < reference.length / 2
    await sleep(suspicious ? gap * 5 : gap)
    const b = readText(file)
    if (a === b) return a
    a = b
  }
  return a
}

function fsyncDir(dir: string) {
  const fd = openSync(dir, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** Escribe y sincroniza un temporal oculto en el mismo directorio (lo ignora el indexador). */
export function writeTmp(file: string, text: string): string {
  const tmp = join(dirname(file), `.${basename(file)}.thoth-${process.pid}-${counter++}`)
  const fd = openSync(tmp, 'wx')
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return tmp
}

export type CommitResult =
  | { ok: true }
  /** El archivo no tenía el hash esperado: no se ha escrito nada. */
  | { ok: false; current: string | null }

export type ReplaceResult =
  /** El archivo no tenía el hash esperado: no se ha escrito nada. `current` es lo que hay. */
  | { replaced: false; current: string | null }
  /**
   * Escrito. `rescued` es lo que un editor escribió in situ durante la ventana del
   * rename y nuestro rename reemplazó (null si nada): quien llama decide qué hacer.
   */
  | { replaced: true; rescued: string | null }

/**
 * Sustituye `file` por `text` si su contenido actual tiene `expectedHash`, o lo
 * crea si `expectedHash` es null y no existe. Antes del rename se hace un enlace
 * duro al archivo previo para rescatar escrituras in situ que caigan en la ventana.
 */
export async function replaceText(file: string, text: string, expectedHash: string | null): Promise<ReplaceResult> {
  const tmp = writeTmp(file, text)
  try {
    if (expectedHash === null) {
      try {
        linkSync(tmp, file) // link() falla si el destino ya existe: crear sin pisar
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { replaced: false, current: readText(file) }
        throw err
      }
      fsyncDir(dirname(file))
      return { replaced: true, rescued: null }
    }
    const before = readText(file)
    if (before === null || contentHash(before) !== expectedHash) return { replaced: false, current: before }
    const prev = tmp + '.prev'
    linkSync(file, prev)
    renameSync(tmp, file)
    fsyncDir(dirname(file))
    const old = await readStable(prev) // el editor puede seguir escribiendo en el inodo antiguo
    rmSync(prev, { force: true })
    return { replaced: true, rescued: old !== null && contentHash(old) !== expectedHash ? old : null }
  } finally {
    rmSync(tmp, { force: true })
  }
}

/**
 * Como replaceText, pero si un editor escribió en la ventana se restaura su
 * versión y se informa como conflicto: para escrituras puntuales (API) que no
 * pueden fusionar.
 */
export async function commitText(file: string, text: string, expectedHash: string | null): Promise<CommitResult> {
  const r = await replaceText(file, text, expectedHash)
  if (!r.replaced) return { ok: false, current: r.current }
  if (r.rescued !== null) {
    const restore = writeTmp(file, r.rescued)
    renameSync(restore, file)
    fsyncDir(dirname(file))
    return { ok: false, current: r.rescued }
  }
  return { ok: true }
}
