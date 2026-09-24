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

/**
 * Sustituye `file` por `text` solo si su contenido actual tiene `expectedHash`
 * (null = el archivo no debe existir). Si un editor escribe in situ durante la
 * ventana del rename, su versión se restaura y se informa como conflicto.
 */
export async function commitText(file: string, text: string, expectedHash: string | null): Promise<CommitResult> {
  const tmp = writeTmp(file, text)
  try {
    if (expectedHash === null) {
      // Crear sin pisar: link() falla si el destino ya existe.
      try {
        linkSync(tmp, file)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, current: readText(file) }
        throw err
      }
      fsyncDir(dirname(file))
      return { ok: true }
    }

    const before = readText(file)
    if (before === null || contentHash(before) !== expectedHash) return { ok: false, current: before }
    const prev = tmp + '.prev'
    linkSync(file, prev)
    renameSync(tmp, file)
    fsyncDir(dirname(file))
    const old = await readStable(prev)
    rmSync(prev, { force: true })
    if (old !== null && contentHash(old) !== expectedHash) {
      // Un editor escribió sobre el archivo en la ventana y nuestro rename lo reemplazó.
      const restore = writeTmp(file, old)
      renameSync(restore, file)
      fsyncDir(dirname(file))
      return { ok: false, current: old }
    }
    return { ok: true }
  } finally {
    rmSync(tmp, { force: true })
  }
}
