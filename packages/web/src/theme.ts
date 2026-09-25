// Theme: follows the OS by default; the person can pin light or dark
// (data-theme on <html>, which is what the tokens read). Single state for the
// whole application: whatever doesn't come from the tokens (generated user
// colors) also needs to hear about the change.
import { useSyncExternalStore } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'
const KEY = 'thoth.theme'
const media = window.matchMedia('(prefers-color-scheme: dark)')

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark') return v
  } catch { /* no storage: fall back to system */ }
  return 'system'
}

let pref = readPref()
const listeners = new Set<() => void>()
const notify = () => { for (const l of listeners) l() }

function apply(p: ThemePref) {
  const root = document.documentElement
  if (p === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', p)
}

// Applying before the first render avoids a flash of the wrong theme.
apply(pref)
media.addEventListener('change', notify)

export function currentTheme(): Theme {
  return pref === 'system' ? (media.matches ? 'dark' : 'light') : pref
}

export function onThemeChange(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function chooseTheme(next: ThemePref) {
  try {
    if (next === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  } catch { /* no persistence */ }
  pref = next
  apply(next)
  notify()
}

export function useTheme() {
  const effective = useSyncExternalStore(onThemeChange, currentTheme)
  const current = useSyncExternalStore(onThemeChange, () => pref)
  return {
    pref: current,
    effective,
    choose: chooseTheme,
    toggle: () => chooseTheme(effective === 'dark' ? 'light' : 'dark'),
  }
}
