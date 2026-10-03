// Focus never falls out of an open dialog. A dialog's button that is
// disabled while it works (or a field that re-renders) drops the focus to
// the page's <body> when it was the focused element; an error then leaves the
// dialog with nothing focused, and Escape (handled where the focus is) stops
// closing it. Installed once for the whole page: when the focus is lost from
// inside a dialog to nothing, it goes back to that dialog (or, if the dialog
// went, nowhere); and an Escape pressed while nothing has the focus goes to
// the topmost open dialog, as if it had been pressed there.

/** A modal dialog (the sidebar's drawer and the palette are not: they close when the focus leaves them). */
const DIALOG = '.modal-overlay [role="dialog"], .modal-overlay [role="alertdialog"]'

/** The open dialog on top (the last one in the page), or null. */
function topDialog(doc: Document): HTMLElement | null {
  const all = doc.querySelectorAll<HTMLElement>(DIALOG)
  return all.length ? all[all.length - 1]! : null
}

const nothingFocused = (doc: Document) => doc.activeElement === null || doc.activeElement === doc.body

export function installDialogFocusGuard(doc: Document = document): () => void {
  const win = doc.defaultView ?? window
  /** Brings the focus back into `dialog` if it is still there and nothing else took it. */
  const restore = (dialog: HTMLElement | null) => {
    win.requestAnimationFrame(() => {
      if (!nothingFocused(doc)) return
      const target = dialog?.isConnected ? dialog : topDialog(doc)
      target?.focus({ preventScroll: true })
    })
  }
  const onFocusOut = (e: FocusEvent) => {
    if (e.relatedTarget !== null) return
    const from = e.target instanceof Element ? e.target.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]') : null
    if (from && !from.matches(DIALOG)) return
    if (from) restore(from)
  }
  // A focused element that becomes disabled loses the focus without a focusout in some browsers: checked after every click or key.
  const afterInput = () => { if (topDialog(doc)) win.setTimeout(() => restore(null), 0) }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !nothingFocused(doc)) return
    const dialog = topDialog(doc)
    if (!dialog) return
    e.preventDefault()
    e.stopPropagation()
    dialog.focus({ preventScroll: true })
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
  }
  doc.addEventListener('focusout', onFocusOut, true)
  doc.addEventListener('pointerup', afterInput, true)
  doc.addEventListener('keydown', onKeyDown, true)
  doc.addEventListener('keyup', afterInput, true)
  return () => {
    doc.removeEventListener('keyup', afterInput, true)
    doc.removeEventListener('focusout', onFocusOut, true)
    doc.removeEventListener('pointerup', afterInput, true)
    doc.removeEventListener('keydown', onKeyDown, true)
  }
}
