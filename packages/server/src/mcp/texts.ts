// Texts an agent has been given, by ETag: what `changes_since` diffs against
// when it's asked "what changed since this ETag". Only in memory, bounded,
// and per key: an agent only ever diffs against a text it was served itself
// (never another key's), and a server restart only costs a fallback (the
// history, or the whole text). Never note content on disk (rule 2).

/** Entries kept at most, and their total size in characters. */
const MAX_ENTRIES = 2000
const MAX_CHARS = 32 * 1024 * 1024

export class TextCache {
  private entries = new Map<string, string>()
  private chars = 0
  private maxEntries: number
  private maxChars: number

  constructor(opts: { maxEntries?: number; maxChars?: number } = {}) {
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES
    this.maxChars = opts.maxChars ?? MAX_CHARS
  }

  private static key(keyId: string, path: string, etag: string) {
    return `${keyId}\u0000${path}\u0000${etag}`
  }

  /** Remembers that `keyId` was given `text` (ETag `etag`) of the note at `path`. */
  put(keyId: string, path: string, etag: string, text: string) {
    if (text.length > this.maxChars / 4) return // one huge note shouldn't push out everything else
    const k = TextCache.key(keyId, path, etag)
    const old = this.entries.get(k)
    if (old !== undefined) {
      this.entries.delete(k)
      this.chars -= old.length
    }
    this.entries.set(k, text)
    this.chars += text.length
    // Oldest first (a Map keeps insertion order; a hit moves to the end).
    for (const [key, t] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.chars <= this.maxChars) break
      this.entries.delete(key)
      this.chars -= t.length
    }
  }

  get(keyId: string, path: string, etag: string): string | null {
    const k = TextCache.key(keyId, path, etag)
    const t = this.entries.get(k)
    if (t === undefined) return null
    this.entries.delete(k)
    this.entries.set(k, t)
    return t
  }
}
