// Tema: por defecto sigue al sistema operativo; la persona puede fijar claro u
// oscuro (data-theme en <html>, que es lo que leen los tokens).
import { useCallback, useEffect, useState } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'
const KEY = 'thoth.theme'
const media = () => window.matchMedia('(prefers-color-scheme: dark)')

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark') return v
  } catch { /* sin almacenamiento: sistema */ }
  return 'system'
}

function apply(pref: ThemePref) {
  const root = document.documentElement
  if (pref === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', pref)
}

// Aplicar antes del primer render evita un parpadeo del tema equivocado.
apply(readPref())

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readPref)
  const [systemDark, setSystemDark] = useState(() => media().matches)

  useEffect(() => {
    const m = media()
    const onChange = () => setSystemDark(m.matches)
    m.addEventListener('change', onChange)
    return () => m.removeEventListener('change', onChange)
  }, [])

  const effective: 'light' | 'dark' = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref

  const choose = useCallback((next: ThemePref) => {
    try {
      if (next === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, next)
    } catch { /* sin persistencia */ }
    apply(next)
    setPref(next)
  }, [])

  const toggle = useCallback(() => choose(effective === 'dark' ? 'light' : 'dark'), [choose, effective])

  return { pref, effective, choose, toggle }
}
