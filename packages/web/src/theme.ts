// Tema: por defecto sigue al sistema operativo; la persona puede fijar claro u
// oscuro (data-theme en <html>, que es lo que leen los tokens). Estado único para
// toda la aplicación: lo que no sale de los tokens (colores de usuario generados)
// también tiene que enterarse del cambio.
import { useSyncExternalStore } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'
const KEY = 'thoth.theme'
const media = window.matchMedia('(prefers-color-scheme: dark)')

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark') return v
  } catch { /* sin almacenamiento: sistema */ }
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

// Aplicar antes del primer render evita un parpadeo del tema equivocado.
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
  } catch { /* sin persistencia */ }
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
