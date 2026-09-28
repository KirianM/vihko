// The language of the UI as a preference of the person's account: saved in
// their profile (state.db), so that it follows them to every browser, with a
// copy in this one (i18n.tsx) for the sign-in screen. After signing in, the
// account's value wins and refreshes the copy.
import { useEffect } from 'react'
import { api } from './api.ts'
import { useLanguageChoice, type LangChoice } from './i18n.tsx'

/** Saves a choice in the person's profile and applies it here; rejects with the API's error. */
export function useChooseLanguage(): (choice: LangChoice) => Promise<void> {
  const { setChoice } = useLanguageChoice()
  return async (choice) => {
    const saved = await api.updateProfile({ language: choice })
    setChoice(saved.language)
  }
}

/** Once someone is signed in, their account's language (or automatic) replaces this browser's copy. */
export function useAccountLanguage(signedIn: boolean) {
  const { setChoice } = useLanguageChoice()
  useEffect(() => {
    if (!signedIn) return
    let live = true
    // Without it the UI stays in this browser's language: never a reason to fail.
    api.profile().then((p) => { if (live) setChoice(p.language) }, () => {})
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn])
}
