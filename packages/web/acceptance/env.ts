// Configuration shared by the acceptance server and its browser specs.
import { fileURLToPath } from 'node:url'

export const ACC_PORT = Number(process.env.ACC_PORT ?? 8095)
/** Inside .data/ (git-ignored): the Playwright Docker image sees it by mounting the repo. */
export const ACC_DIR = process.env.ACC_DIR ?? fileURLToPath(new URL('../../../.data/acceptance', import.meta.url))
export const NOTES = ACC_DIR + '/notes'
export const BASE_URL = process.env.ACC_BASE_URL ?? `http://127.0.0.1:${ACC_PORT}`
export const PASSWORD = 'contraseña-larga'
export const USERS: [string, boolean][] = [['noa', true], ['ana', false]]
