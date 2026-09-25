// Presence: who has the note open, each person with their color (userColor.ts).
// Only the hue travels over the network; each browser paints it with its own theme.
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { useEffect, useState } from 'react'
import { currentTheme, onThemeChange } from '../theme.ts'
import { distinctHue, userColor } from '../userColor.ts'

type Awareness = NonNullable<HocuspocusProvider['awareness']>
type PeerState = { user?: { name?: string; hue?: number } }

/**
 * Announces the person in the note. Their hue separates from that of whoever has
 * a lower clientID, and only those: this way no one depends on who arrives later,
 * and hues don't oscillate. The cursor color (y-codemirror needs a hex) is
 * recomputed when the theme changes.
 */
export function announce(awareness: Awareness, user: { id: string; username: string }): () => void {
  const choose = () => {
    const before: number[] = []
    for (const [id, s] of awareness.getStates()) {
      const hue = (s as PeerState).user?.hue
      if (id < awareness.clientID && typeof hue === 'number') before.push(hue)
    }
    const hue = distinctHue(user.id, before)
    const color = userColor(hue, currentTheme())
    const cur = (awareness.getLocalState() as { user?: { hue?: number; color?: string } } | null)?.user
    if (cur?.hue === hue && cur.color === color) return
    awareness.setLocalStateField('user', { name: user.username, hue, color, colorLight: color + '33' })
  }
  choose()
  awareness.on('change', choose)
  const offTheme = onThemeChange(choose)
  return () => {
    awareness.off('change', choose)
    offTheme()
  }
}

export interface Peer { name: string; hue: number }

export function usePresence(provider: HocuspocusProvider | undefined): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([])
  useEffect(() => {
    const awareness = provider?.awareness
    if (!awareness) return
    const read = () => {
      const byName = new Map<string, number>()
      for (const s of awareness.getStates().values()) {
        const u = (s as PeerState).user
        if (u?.name && typeof u.hue === 'number' && !byName.has(u.name)) byName.set(u.name, u.hue)
      }
      setPeers([...byName].sort(([a], [b]) => a.localeCompare(b)).map(([name, hue]) => ({ name, hue })))
    }
    read()
    awareness.on('change', read)
    return () => awareness.off('change', read)
  }, [provider])
  return peers
}
