function isEditableInput(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return false
  if (target.disabled || target.readOnly) return false
  if (target instanceof HTMLTextAreaElement) return true
  return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(
    target.type,
  )
}

const CODE_EDITOR_CLASS = ['mona', 'co-editor'].join('')

function isOwnedEditorSurface(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('.xterm') || target.closest(`.${CODE_EDITOR_CLASS}`))
}

function insertIntoInput(target: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const start = target.selectionStart ?? target.value.length
  const end = target.selectionEnd ?? target.value.length
  target.setRangeText(text, start, end, 'end')
  target.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      data: text,
      inputType: 'insertFromPaste',
    }),
  )
}

export function bindElectronClipboardPasteBridge(root: Document = document): () => void {
  const handlePaste = (event: ClipboardEvent) => {
    if (event.defaultPrevented || isOwnedEditorSurface(event.target)) return
    const eventText = event.clipboardData?.getData('text/plain') ?? ''
    if (eventText) return

    const inputTarget = isEditableInput(event.target) ? event.target : null
    if (!inputTarget) return

    event.preventDefault()
    const activeTarget = event.target
    void window.api
      .clipboardReadText()
      .then((text) => {
        if (!text) return
        if (document.activeElement === inputTarget) {
          insertIntoInput(inputTarget, text)
          return
        }
        if (activeTarget instanceof HTMLElement && activeTarget.isConnected) {
          insertIntoInput(inputTarget, text)
        }
      })
      .catch(() => {})
  }

  root.addEventListener('paste', handlePaste, { capture: true })
  return () => root.removeEventListener('paste', handlePaste, { capture: true })
}
