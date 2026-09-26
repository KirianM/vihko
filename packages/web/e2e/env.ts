// Configuration shared by the test server and the tests.
import { fileURLToPath } from 'node:url'

export const E2E_PORT = Number(process.env.E2E_PORT ?? 8094)
/** Inside .data/ (git-ignored): this way the Playwright Docker image sees it by mounting the repo. */
export const E2E_DIR = process.env.E2E_DIR ?? fileURLToPath(new URL('../../../.data/e2e', import.meta.url))
export const NOTES = E2E_DIR + '/notes'
export const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${E2E_PORT}`
/** A second server, with THOTH_INTEGRATIONS=off: the API and MCP locked by the server's administrator. */
export const LOCKED_PORT = Number(process.env.E2E_LOCKED_PORT ?? E2E_PORT + 2) // +1 is the acceptance server's (8095)
export const LOCKED_URL = process.env.E2E_LOCKED_URL ?? `http://127.0.0.1:${LOCKED_PORT}`
/** THOTH_PUBLIC_URL of the main test server: OAuth exists there (while MCP is on). Nothing answers at it; the specs use BASE_URL. */
export const PUBLIC_URL = 'https://thoth.e2e.test'
export const PASSWORD = 'contraseña-larga'
export const USERS: [string, boolean][] = [['noa', true], ['ana', false]]
