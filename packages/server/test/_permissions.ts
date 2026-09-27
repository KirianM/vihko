// The permissions most tests run under: noa (the admin) manages the root,
// ana (a member) edits everything. The tests written before M4 had every
// user see everything; with M4 a member sees nothing that isn't granted
// (D-038), so their setups grant it unless the test brings its own
// `permissions` (the permission tests themselves).

/** noa manages the root, ana edits it: everyone sees everything, as before M4. */
export const EVERYONE = 'permissions:\n  "":\n    grants: { noa: manage, ana: edit }\n'

/** A thoth.yaml with `EVERYONE` added, unless it has permissions of its own. */
export function withEveryone(config: string | undefined): string {
  if (config !== undefined && /^permissions:/m.test(config)) return config
  const base = config ?? ''
  return base === '' || base.endsWith('\n') ? base + EVERYONE : `${base}\n${EVERYONE}`
}
