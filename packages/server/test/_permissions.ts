// The permissions most tests run under (D-056): every note is in a space, and
// the tests that aren't about permissions keep theirs in one shared space
// (SHARED), where the admin manages and the member edits: everyone sees
// everything in it, as before M4. The setups copy the test vault into it
// (_app.ts, _history.ts, _collab.ts), so a vault note is `inShared('Plan.md')`.
// A test that brings its own `permissions` (the permission tests
// themselves) gets the file as it wrote it.
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** The shared space's name, which is its folder (D-056.33). */
export const SHARED_NAME = m.aSpaceName()
/** The shared space most tests keep their notes in: `spaces/<name>`. */
export const SHARED = `spaces/${m.aSpaceFolder(SHARED_NAME)}`

/** `path` (from the shared space's root; `''` for the root itself) as a real path. */
export const inShared = (path: string) => (path === '' ? SHARED : `${SHARED}/${path}`)

/** A YAML key for a subject: quoted, so any valid name reads as itself. */
export const yamlKey = (subject: string) => JSON.stringify(subject)

/** The shared space with these grants (subject → level), as a `permissions` section. */
export function sharedSpace(grants: Record<string, string>): string {
  const g = Object.entries(grants).map(([s, l]) => `${yamlKey(s)}: ${l}`).join(', ')
  return `permissions:\n  ${JSON.stringify(SHARED)}:\n    grants: { ${g} }\n`
}

/** `admin` manages the shared space, `member` edits it: everyone sees everything in it. */
export function everyone(admin: string, member: string): string {
  return sharedSpace({ [admin]: 'manage', [member]: 'edit' })
}

/** A vihko.yaml with `everyone(admin, member)` added, unless it has permissions of its own. */
export function withEveryone(config: string | undefined, admin: string, member: string): string {
  if (config !== undefined && /^permissions:/m.test(config)) return config
  const base = config ?? ''
  const section = everyone(admin, member)
  return base === '' || base.endsWith('\n') ? base + section : `${base}\n${section}`
}
