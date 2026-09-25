// Phone layout helpers: the breakpoint, the browser's back button closing
// overlays, and the visible viewport (the on-screen keyboard shrinks it).
import { useEffect, useRef, useState } from 'react'

/** Below this width there is no sidebar: the tree opens as a drawer. Same value as styles.css. */
export const MOBILE = '(max-width: 760px)'

export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const m = matchMedia(query)
    const on = () => setMatches(m.matches)
    on()
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [query])
  return matches
}

export const useMobile = () => useMedia(MOBILE)

// --- Back button closes the topmost overlay ---------------------------------
// While any overlay is open there is one extra history entry. Back pops it and
// closes the topmost overlay; closing it any other way (Esc, tap outside)
// removes the entry. Overlays that swap in the same render (drawer → palette)
// reuse the entry instead of popping and pushing.
// history.back() lands on the entry from before the overlay opened, whose URL
// may be stale (a note was opened from the drawer): it gets the current one.

const stack: { close: () => void }[] = []
let pushed = false
/** URL to restore after our own history.back(): the app may have changed it meanwhile. */
let restoreUrl: string | null = null

addEventListener('popstate', () => {
  if (restoreUrl !== null) {
    history.replaceState(null, '', restoreUrl)
    restoreUrl = null
    return
  }
  if (!pushed) return
  pushed = false
  stack[stack.length - 1]?.close()
})

function release() {
  // After this render's effects (another overlay may open, the app may update the URL).
  setTimeout(() => {
    if (stack.length > 0 || !pushed) return
    pushed = false
    restoreUrl = location.href
    history.back()
  })
}

/** While `open`, the browser's back button (Android, swipe back) calls `close` instead of leaving. */
export function useBackClose(open: boolean, close: () => void) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    const entry = { close: () => closeRef.current() }
    stack.push(entry)
    if (!pushed) {
      history.pushState(null, '', location.href)
      pushed = true
    }
    return () => {
      stack.splice(stack.indexOf(entry), 1)
      if (stack.length === 0) release()
      else if (!pushed) { history.pushState(null, '', location.href); pushed = true }
    }
  }, [open])
}

// --- Visible viewport ---------------------------------------------------------
// iOS Safari doesn't resize the page when the keyboard opens: the layout keeps
// its height and the keyboard covers the bottom (the editor bar, the cursor).
// The visual viewport does shrink, so the shell takes its size from it
// (--app-height, --app-top). Chrome on Android resizes the page itself
// (interactive-widget=resizes-content in index.html) and this is a no-op there.

export function useVisualViewport(enabled: boolean) {
  useEffect(() => {
    const vv = window.visualViewport
    const root = document.documentElement.style
    if (!enabled || !vv) return
    const on = () => {
      root.setProperty('--app-height', `${vv.height}px`)
      root.setProperty('--app-top', `${vv.offsetTop}px`)
    }
    on()
    vv.addEventListener('resize', on)
    vv.addEventListener('scroll', on)
    return () => {
      vv.removeEventListener('resize', on)
      vv.removeEventListener('scroll', on)
      root.removeProperty('--app-height')
      root.removeProperty('--app-top')
    }
  }, [enabled])
}
