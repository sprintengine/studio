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

// The chat composers' field is an editor on a contenteditable element
// (agentChat/ComposerField), not an input: it takes text as a paste event, so a
// paste is handed to it again, carrying the text, rather than spliced into a
// value it does not have. Its own paste handling then runs as for any paste — a
// pasted image path still attaches. Not while it is read-only.
function composerEditable(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null
  const editable = target.closest<HTMLElement>('.cm-content')
  return editable?.isContentEditable ? editable : null
}

function clipboardCarriesFiles(data: DataTransfer | null): boolean {
  if (!data) return false
  if (Array.from(data.types ?? []).includes('Files')) return true
  return Array.from(data.items ?? []).some((item) => item.kind === 'file')
}

function pasteIntoComposer(editable: HTMLElement, text: string): void {
  const clipboardData = new DataTransfer()
  clipboardData.setData('text/plain', text)
  editable.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
}

export function bindElectronClipboardPasteBridge(root: Document = document): () => void {
  const handlePaste = (event: ClipboardEvent) => {
    if (event.defaultPrevented || isOwnedEditorSurface(event.target)) return
    const eventText = event.clipboardData?.getData('text/plain') ?? ''
    if (eventText) return

    const composer = composerEditable(event.target)
    if (composer) {
      // A screenshot is a paste with files and no text, and the composer
      // attaches it itself; a paste that is not stopped here reaches it.
      if (clipboardCarriesFiles(event.clipboardData) || typeof DataTransfer !== 'function') return
      event.preventDefault()
      void window.api
        .clipboardReadText()
        .then((text) => {
          if (text && composer.isConnected) pasteIntoComposer(composer, text)
        })
        .catch(() => {})
      return
    }

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
