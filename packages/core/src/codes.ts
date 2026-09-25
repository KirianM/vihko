// Códigos estables que el servidor devuelve en lugar de texto (D-025): la UI los
// traduce. Renombrar un código rompe a los clientes; añadir uno nuevo, no.

/**
 * Campo `error` de toda respuesta de error de la API. El `message` que lo
 * acompaña es solo una pista para quien desarrolla: la UI nunca lo muestra.
 */
export type ErrorCode =
  | 'unauthorized' // sin sesión o caducada
  | 'invalid_credentials'
  | 'forbidden'
  | 'not_found'
  | 'invalid' // cuerpo o parámetros mal formados
  | 'internal'
  | 'precondition_required' // falta If-Match
  | 'precondition_failed' // If-Match no coincide
  | 'exists'
  | 'invalid_path'
  | 'edit_mismatch'
  | 'invalid_username'
  | 'weak_password'
  | 'user_exists'
  | 'already_setup'
  | 'invalid_token'

/**
 * Avisos del espacio: lo que thoth ha detectado en la carpeta de notas y
 * necesita una decisión. Cada uno lleva los datos para redactarlo y las acciones
 * que puede hacer quien pregunta (las de admin no aparecen para los demás).
 */
export type Alert =
  /** Un escaneo iba a retirar del índice demasiadas notas de golpe y se detuvo. */
  | { code: 'scan_aborted_mass_delete'; removing: number; total: number; actions: ('rescan' | 'confirm_removal')[] }
  /** La carpeta de notas no existe o no se puede leer. */
  | { code: 'scan_aborted_root_unavailable'; actions: 'rescan'[] }
  /** Nota borrada desde fuera con una copia pendiente de decisión (D-022). */
  | { code: 'orphaned_note'; path: string; actions: ('keep_copy' | 'discard_copy')[] }
  /** Varias notas con el mismo `uid`. Se arregla editando el frontmatter, nunca solo (D-015). */
  | { code: 'uid_conflict'; uid: string; paths: string[]; actions: never[] }
  /** Copia de conflicto de un sincronizador; `note` es la nota original si existe. */
  | { code: 'sync_conflict'; path: string; note: string | null; actions: never[] }

export type AlertCode = Alert['code']
export type AlertAction = Alert['actions'][number]
