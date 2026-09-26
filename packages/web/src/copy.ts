// Copying text to the clipboard: the clipboard API where the page may use it
// (https or localhost), a selection and `copy` otherwise (thoth on plain http
// in a home network, where `navigator.clipboard` doesn't exist).

/** Whether the text reached the clipboard. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
    return copyBySelection(text)
  } catch {
    return false
  }
}

function copyBySelection(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.setAttribute('aria-hidden', 'true')
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0'
  // Where the focus was goes back there. Inside the dialog that asked, if
  // any: a modal keeps the focus within it and would undo the selection.
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : null
  ;(back?.closest('[role="dialog"], [role="alertdialog"]') ?? document.body).append(area)
  area.select()
  try {
    return document.execCommand('copy')
  } finally {
    area.remove()
    back?.focus({ preventScroll: true })
  }
}
