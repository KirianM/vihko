// What a session leaves in memory (suggestion caches and the like), cleared
// when it ends: signing out, or the session expiring. Whoever signs in next
// in the same tab never gets what was loaded for the one before.
// A module that keeps such things registers here, so the shell doesn't have
// to load it (the editor is loaded on demand).
const clearers = new Set<() => void>()

/** `clear` runs every time a session ends. */
export function onSessionEnd(clear: () => void): void {
  clearers.add(clear)
}

/** The session ended: everything registered forgets what it kept. */
export function endSession(): void {
  for (const clear of clearers) clear()
}
