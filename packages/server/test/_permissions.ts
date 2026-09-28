// The permissions most tests run under: the admin manages the root, the
// member edits everything. The tests written before M4 had every user see
// everything; with M4 a member sees nothing that isn't granted (D-038), so
// their setups grant it unless the test brings its own `permissions` (the
// permission tests themselves).

/** A YAML key for a subject: quoted, so any valid name reads as itself. */
export const yamlKey = (subject: string) => JSON.stringify(subject)

/** `admin` manages the root, `member` edits it: everyone sees everything, as before M4. */
export function everyone(admin: string, member: string): string {
  return `permissions:\n  "":\n    grants: { ${yamlKey(admin)}: manage, ${yamlKey(member)}: edit }\n`
}

/** A vihko.yaml with `everyone(admin, member)` added, unless it has permissions of its own. */
export function withEveryone(config: string | undefined, admin: string, member: string): string {
  if (config !== undefined && /^permissions:/m.test(config)) return config
  const base = config ?? ''
  const section = everyone(admin, member)
  return base === '' || base.endsWith('\n') ? base + section : `${base}\n${section}`
}
