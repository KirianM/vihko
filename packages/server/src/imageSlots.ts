// Images being received (an upload's body, a copy downloading, an image an
// agent sends over MCP) are held in memory whole, up to the size limit each:
// only a few at a time, per person and in all, so that many at once can't
// exhaust the server's memory. The HTTP API and the MCP server share one
// count: a person's uploads and their agents' images wait their turn together.

/** Images received at once: by one person (an agent counts as the person it acts for), and in all. */
export const IMAGES_PER_USER = 2
export const IMAGES_IN_FLIGHT = 8

export class ImageSlots {
  private total = 0
  private byUser = new Map<string, number>()

  /** A slot for `userId`, to give back with the function it returns; null when there is none free now. */
  take(userId: string): (() => void) | null {
    const mine = this.byUser.get(userId) ?? 0
    if (mine >= IMAGES_PER_USER || this.total >= IMAGES_IN_FLIGHT) return null
    this.byUser.set(userId, mine + 1)
    this.total++
    let given = false
    return () => {
      if (given) return
      given = true
      this.total--
      const left = (this.byUser.get(userId) ?? 1) - 1
      if (left > 0) this.byUser.set(userId, left)
      else this.byUser.delete(userId)
    }
  }
}
