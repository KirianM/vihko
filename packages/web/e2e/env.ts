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
/** Another origin for "external" images: a server in the test process (images.spec.ts). */
export const EXTERNAL_PORT = Number(process.env.E2E_EXTERNAL_PORT ?? 8132)
/** THOTH_PUBLIC_URL of the main test server: OAuth exists there (while MCP is on). Nothing answers at it; the specs use BASE_URL. */
export const PUBLIC_URL = 'https://thoth.e2e.test'
export const PASSWORD = 'contraseña-larga'
export const USERS: [string, boolean][] = [['noa', true], ['ana', false]]
export type Level = 'read' | 'comment' | 'edit' | 'manage'
export type Grants = Record<string, Level>
/**
 * The grants at the root every spec runs under (D-038): noa (the admin)
 * manages it and ana (a member) edits it, so both see everything.
 */
export const ROOT_GRANTS: Grants = { noa: 'manage', ana: 'edit' }

/**
 * The `permissions:` section of thoth.yaml: the root with ROOT_GRANTS, plus
 * (or changed by) `grants`; then `rules`, more folders with their grants.
 */
export function permissionsSection(grants: Grants = {}, rules: Record<string, Grants> = {}): string {
  const map = (g: Grants) => `{ ${Object.entries(g).map(([s, l]) => `${s.includes('{') ? JSON.stringify(s) : s}: ${l}`).join(', ')} }`
  return 'permissions:\n  "":\n    grants: ' + map({ ...ROOT_GRANTS, ...grants }) + '\n'
    + Object.entries(rules).map(([folder, g]) => `  ${JSON.stringify(folder)}:\n    grants: ${map(g)}\n`).join('')
}

/** The permissions every spec runs under, in thoth.yaml. A spec that writes thoth.yaml keeps them (`writeWorkspace`, `usePermissions`). */
export const PERMISSIONS = permissionsSection()

/**
 * This run of the specs, for the names of what they create on the shared
 * server: a deleted user's name stays reserved (D-038.8), so a spec run again
 * (a retry, or `--grep` on a server that is still up) needs new ones.
 */
export const RUN = Date.now().toString(36).slice(-5)
/** A name of this run: `unique('bruno')` is `bruno-<run>`. */
export const unique = (name: string) => `${name}-${RUN}`
