import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme.ts'
import './fonts.ts'
import './styles.css'
import { App } from './App.tsx'
import { I18nProvider } from './i18n.tsx'
import { installDialogFocusGuard } from './dialogFocus.ts'

installDialogFocusGuard()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
