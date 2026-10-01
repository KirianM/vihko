// What an agent key (or an OAuth authorization, which is one) may do, and
// whether a change lets it do more. Letting it do more is confirmed
// at the moment, as creating it is; narrowing or renaming it isn't. Shared by
// the server, which decides, and the UI, which asks for the confirmation
// before sending the change.

export interface KeyScope {
  canWrite: boolean
  /** Folders it reaches, as keys store them (NFC, none inside another); empty: every folder its user sees. */
  folders: readonly string[]
  /** When it stops working (ISO 8601); null: never. */
  expiresAt: string | null
}

/** Whether `folder` is `other` or inside it. */
const within = (folder: string, other: string) => folder === other || folder.startsWith(other + '/')

/**
 * Whether changing a key from `before` to `after` (what the change sets; the
 * rest stays) lets it do more: write where it only read, reach a folder it
 * didn't (or every folder, where it had some), or work longer (a later
 * expiry, or none where it had one).
 */
export function keyWidens(before: KeyScope, after: Partial<KeyScope>): boolean {
  if (after.canWrite === true && !before.canWrite) return true
  if (after.folders !== undefined && before.folders.length > 0) {
    if (after.folders.length === 0) return true
    if (after.folders.some((f) => !before.folders.some((g) => within(f, g)))) return true
  }
  if (after.expiresAt !== undefined && before.expiresAt !== null) {
    if (after.expiresAt === null || Date.parse(after.expiresAt) > Date.parse(before.expiresAt)) return true
  }
  return false
}
