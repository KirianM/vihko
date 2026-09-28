// Whether a request comes from the page vihko serves, by its Origin header.
// Both headers come from whoever sent the request: anything that isn't a URL
// (`Origin: null` from an opaque origin, a Host that isn't one) is simply
// not the same origin, never an exception.

/** The host (name and port) of a URL, or null when it isn't one. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

/**
 * Whether `origin` (an Origin header) names the host the request was sent
 * to (`host`: the Host header, or the host of the request's URL).
 */
export function sameHost(origin: string, host: string | undefined): boolean {
  if (!host) return false
  const a = hostOf(origin)
  return a !== null && a === hostOf(`http://${host}`)
}
