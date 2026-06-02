import type { Terminal } from '@xterm/xterm'

type TerminalClipboardHandlersOptions = {
  container: HTMLElement
  term: Terminal
  sessionId: string
  focusTerminal: () => void
  recordKeydown: (event: KeyboardEvent) => void
}

type RuntimeClipboardApi = {
  clipboardReadText?: () => Promise<string>
  clipboardWriteText?: (text: string) => Promise<void>
}

export function bindTerminalClipboardHandlers({
  container,
  term,
  sessionId,
  focusTerminal,
  recordKeydown,
}: TerminalClipboardHandlersOptions): () => void {
  let lastKnownSelection = term.getSelection()
  let secondaryClickSelection = ''
  let pasteOnNextContextMenu = false
  let lastTerminalCopiedText = ''

  const writeClipboardText = async (text: string): Promise<boolean> => {
    if (!text) return false
    const api = window.api as typeof window.api & RuntimeClipboardApi
    if (typeof api.clipboardWriteText === 'function') {
      try {
        await api.clipboardWriteText(text)
        return true
      } catch {
        return false
      }
    }

    return false
  }

  const readClipboardText = async (): Promise<string> => {
    const api = window.api as typeof window.api & RuntimeClipboardApi
    if (typeof api.clipboardReadText === 'function') {
      try {
        return await api.clipboardReadText()
      } catch {
        return ''
      }
    }

    return ''
  }

  const copyText = async (text: string) => {
    lastTerminalCopiedText = text
    await writeClipboardText(text)
  }

  const copySelection = async (selection = term.getSelection()) => {
    await copyText(selection)
  }

  const getCopySelection = () => secondaryClickSelection || term.getSelection() || lastKnownSelection

  const pasteText = async (text: string) => {
    if (!text) return
    await window.api.terminalWrite(sessionId, text.replace(/\r?\n/g, '\r'))
    focusTerminal()
  }

  const handleCopy = (event: ClipboardEvent) => {
    const selection = getCopySelection()
    if (!selection) return
    event.preventDefault()
    event.clipboardData?.setData('text/plain', selection)
    lastTerminalCopiedText = selection
    void writeClipboardText(selection)
  }

  const handlePaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (!text) return
    event.preventDefault()
    void pasteText(text)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    recordKeydown(event)
    pasteOnNextContextMenu = false
    const mod = event.ctrlKey || event.metaKey
    if (!mod) return

    const key = event.key.toLowerCase()
    if (key === 'c' && event.shiftKey) {
      event.preventDefault()
      void copySelection().catch(() => {})
    }

    if (key === 'v' && event.shiftKey) {
      event.preventDefault()
      void readClipboardText().then((text) => pasteText(text || lastTerminalCopiedText))
    }
  }

  const handleMouseDown = (event: MouseEvent) => {
    const isSecondaryClick = event.button === 2 || (event.ctrlKey && event.button === 0)
    if (!isSecondaryClick) pasteOnNextContextMenu = false
    secondaryClickSelection = isSecondaryClick ? getCopySelection() : ''
    focusTerminal()
  }

  const handleContextMenu = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()

    const selectedText = getCopySelection()
    secondaryClickSelection = ''

    if (selectedText && !pasteOnNextContextMenu) {
      term.clearSelection()
      lastKnownSelection = ''
      pasteOnNextContextMenu = true
      lastTerminalCopiedText = selectedText
      void copyText(selectedText).catch(() => {})
      focusTerminal()
      return
    }

    pasteOnNextContextMenu = false
    void readClipboardText()
      .then((text) => pasteText(text || lastTerminalCopiedText))
      .catch(() => pasteText(lastTerminalCopiedText))
    focusTerminal()
  }

  const selectionDisposable = term.onSelectionChange?.(() => {
    // Assign every time, including empty. The secondary-click path captures the
    // live selection at mousedown (capture phase) into secondaryClickSelection,
    // so this fallback only needs to reflect the current selection. Keeping a
    // stale non-empty value here turns a later right-click-to-paste into an
    // unintended copy of the old selection.
    lastKnownSelection = term.getSelection()
  }) ?? { dispose: () => {} }

  container.addEventListener('mousedown', handleMouseDown, { capture: true })
  container.addEventListener('copy', handleCopy)
  container.addEventListener('paste', handlePaste)
  container.addEventListener('keydown', handleKeyDown)
  container.addEventListener('contextmenu', handleContextMenu, { capture: true })

  return () => {
    container.removeEventListener('mousedown', handleMouseDown, { capture: true })
    container.removeEventListener('copy', handleCopy)
    container.removeEventListener('paste', handlePaste)
    container.removeEventListener('keydown', handleKeyDown)
    container.removeEventListener('contextmenu', handleContextMenu, { capture: true })
    selectionDisposable.dispose()
  }
}
