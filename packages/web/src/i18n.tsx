// Traducciones (D-025): ningún texto de la UI va escrito en los componentes.
// Añadir un idioma es añadir un diccionario con las mismas claves (el tipo lo exige).
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

const es = {
  'app.name': 'thoth',
  'common.loading': 'Cargando…',
  'common.retry': 'Reintentar',
  'setup.title': 'Crea el administrador',
  'setup.intro': 'Es la primera vez que arranca esta instalación. El token de un solo uso está en el log del servidor ({cmd}).',
  'setup.token': 'Token de primer arranque',
  'setup.tokenPlaceholder': 'Pega el token del log',
  'setup.submit': 'Crear y entrar',
  'setup.closed': 'Nada sale de este servidor: la API, el MCP y los webhooks están desactivados hasta que los actives.',
  'login.title': 'Entrar',
  'login.submit': 'Entrar',
  'login.failed': 'Usuario o contraseña incorrectos.',
  'field.username': 'Nombre de usuario',
  'field.password': 'Contraseña',
  'field.passwordHint': 'Al menos 10 caracteres.',
  'shell.folders': 'Carpetas',
  'shell.newNote': 'Nueva nota',
  'shell.search': 'Buscar o crear…',
  'shell.alerts': '{n} avisos del espacio',
  'shell.logout': 'Cerrar sesión',
  'shell.empty': 'Elige una nota en el árbol.',
  'shell.noNotes': 'La carpeta de notas está vacía.',
  'editor.label': 'Texto de la nota',
  'editor.saved': 'Guardado en disco',
  'editor.saving': 'Guardando…',
  'editor.connecting': 'Conectando…',
  'editor.offline': 'Sin conexión · se envía al reconectar',
  'editor.orphanStatus': 'Sin guardar en disco · copia a salvo',
  'editor.orphanTitle': 'Esta nota se ha borrado fuera de thoth',
  'editor.orphanBody': 'Alguien la borró de la carpeta (explorador de archivos, git…) mientras la editabais. Lo que llevas escrito está a salvo; thoth no la volverá a crear sin que lo decidas.',
  'editor.orphanKeep': 'Conservar mi copia',
  'editor.orphanDiscard': 'Descartar',
  'editor.linkAmbiguous': 'ambiguo · {n}',
  'editor.linkMissing': 'no existe',
  'editor.frontmatter': 'frontmatter · {n} claves',
  'editor.frontmatterOne': 'frontmatter · 1 clave',
  'role.admin': 'admin',
  'role.member': 'miembro',
  'theme.toDark': 'Cambiar a tema oscuro',
  'theme.toLight': 'Cambiar a tema claro',
  'error.unauthorized': 'Tu sesión ha caducado. Vuelve a entrar.',
  'error.forbidden': 'No tienes permiso para hacer esto.',
  'error.not_found': 'No existe o no tienes acceso.',
  'error.network': 'No se puede conectar con el servidor.',
  'error.internal': 'Ha fallado algo en el servidor.',
  'error.invalid': 'Los datos enviados no son válidos.',
  'error.invalid_username': 'Nombre de usuario no válido: de 2 a 64 letras, dígitos, «.», «_» o «-».',
  'error.weak_password': 'La contraseña debe tener al menos 10 caracteres.',
  'error.user_exists': 'Ese usuario ya existe.',
  'error.already_setup': 'Esta instalación ya tiene administrador. Entra con tu usuario.',
  'error.invalid_token': 'El token de primer arranque no es válido.',
}

const en: Record<keyof typeof es, string> = {
  'app.name': 'thoth',
  'common.loading': 'Loading…',
  'common.retry': 'Retry',
  'setup.title': 'Create the administrator',
  'setup.intro': 'This is the first start of this installation. The one-time token is in the server log ({cmd}).',
  'setup.token': 'First-start token',
  'setup.tokenPlaceholder': 'Paste the token from the log',
  'setup.submit': 'Create and sign in',
  'setup.closed': 'Nothing leaves this server: the API, MCP and webhooks stay off until you turn them on.',
  'login.title': 'Sign in',
  'login.submit': 'Sign in',
  'login.failed': 'Wrong username or password.',
  'field.username': 'Username',
  'field.password': 'Password',
  'field.passwordHint': 'At least 10 characters.',
  'shell.folders': 'Folders',
  'shell.newNote': 'New note',
  'shell.search': 'Search or create…',
  'shell.alerts': '{n} workspace alerts',
  'shell.logout': 'Sign out',
  'shell.empty': 'Pick a note in the tree.',
  'shell.noNotes': 'The notes folder is empty.',
  'editor.label': 'Note text',
  'editor.saved': 'Saved to disk',
  'editor.saving': 'Saving…',
  'editor.connecting': 'Connecting…',
  'editor.offline': 'Offline · sent when reconnected',
  'editor.orphanStatus': 'Not saved to disk · copy kept safe',
  'editor.orphanTitle': 'This note was deleted outside thoth',
  'editor.orphanBody': 'Someone removed it from the folder (file manager, git…) while it was being edited. What you wrote is safe; thoth will not recreate it until you decide.',
  'editor.orphanKeep': 'Keep my copy',
  'editor.orphanDiscard': 'Discard',
  'editor.linkAmbiguous': 'ambiguous · {n}',
  'editor.linkMissing': 'missing',
  'editor.frontmatter': 'frontmatter · {n} keys',
  'editor.frontmatterOne': 'frontmatter · 1 key',
  'role.admin': 'admin',
  'role.member': 'member',
  'theme.toDark': 'Switch to dark theme',
  'theme.toLight': 'Switch to light theme',
  'error.unauthorized': 'Your session has expired. Sign in again.',
  'error.forbidden': 'You are not allowed to do this.',
  'error.not_found': 'It does not exist or you have no access.',
  'error.network': 'Cannot reach the server.',
  'error.internal': 'Something failed on the server.',
  'error.invalid': 'The data sent is not valid.',
  'error.invalid_username': 'Invalid username: 2 to 64 letters, digits, ".", "_" or "-".',
  'error.weak_password': 'The password must be at least 10 characters long.',
  'error.user_exists': 'That user already exists.',
  'error.already_setup': 'This installation already has an administrator. Sign in with your user.',
  'error.invalid_token': 'The first-start token is not valid.',
}

export type MessageKey = keyof typeof es
export type Lang = 'es' | 'en'
const dictionaries: Record<Lang, Record<MessageKey, string>> = { es, en }

function initialLang(): Lang {
  try {
    const stored = localStorage.getItem('thoth.lang')
    if (stored === 'es' || stored === 'en') return stored
  } catch { /* almacenamiento no disponible */ }
  return navigator.language.toLowerCase().startsWith('es') ? 'es' : 'en'
}

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string
const I18nContext = createContext<{ t: Translate; lang: Lang; setLang: (l: Lang) => void } | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang)
  const value = useMemo(() => {
    const dict = dictionaries[lang]
    const t: Translate = (key, vars) => dict[key].replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? `{${k}}`))
    const setLang = (l: Lang) => {
      try { localStorage.setItem('thoth.lang', l) } catch { /* sin persistencia */ }
      setLangState(l)
    }
    return { t, lang, setLang }
  }, [lang])
  useEffect(() => { document.documentElement.lang = lang }, [lang])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/** Texto de un error de la API: el servidor da el código (D-025) y aquí se traduce. */
export function errorText(t: Translate, err: unknown): string {
  const code = err instanceof Error && 'code' in err ? `error.${String(err.code)}` : 'error.internal'
  return code in es ? t(code as MessageKey) : t('error.internal')
}

export function useT(): Translate {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useT fuera de I18nProvider')
  return ctx.t
}
