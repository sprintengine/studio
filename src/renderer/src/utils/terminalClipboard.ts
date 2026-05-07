import type { Terminal } from '@xterm/xterm'

type TerminalClipboardHandlersOptions = {
  container: HTMLElement
  term: Terminal
  sessionId: string
  focusTerminal: () => void
  recordKeydown: (event: KeyboardEvent) => void
}

export function bindTerminalClipboardHandlers({
  container,
  term,
  sessionId,
  focusTerminal,
  recordKeydown,
}: TerminalClipboardHandlersOptions): () => void {
  let secondaryClickArmed = false

  const copySelection = async () => {
    const selection = term.getSelection()
    if (!selection) return
    await navigator.clipboard.writeText(selection)
  }

  const pasteText = async (text: string) => {
    if (!text) return
    await window.api.terminalWrite(sessionId, text.replace(/\r?\n/g, '\r'))
    focusTerminal()
  }

  const handleCopy = (event: ClipboardEvent) => {
    const selection = term.getSelection()
    if (!selection) return
    event.preventDefault()
    event.clipboardData?.setData('text/plain', selection)
    void navigator.clipboard.writeText(selection).catch(() => {})
  }

  const handlePaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (!text) return
    event.preventDefault()
    void pasteText(text)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    recordKeydown(event)
    const mod = event.ctrlKey || event.metaKey
    if (!mod) return

    const key = event.key.toLowerCase()
    if (key === 'c' && event.shiftKey) {
      event.preventDefault()
      void copySelection().catch(() => {})
    }

    if (key === 'v' && event.shiftKey) {
      event.preventDefault()
      void navigator.clipboard.readText().then(pasteText).catch(() => {})
    }
  }

  const handleMouseDown = (event: MouseEvent) => {
    secondaryClickArmed = event.button === 2 || (event.ctrlKey && event.button === 0)
    focusTerminal()
  }

  const handleContextMenu = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()

    const shouldRunTerminalContextAction = secondaryClickArmed
    secondaryClickArmed = false

    if (!shouldRunTerminalContextAction) {
      focusTerminal()
      return
    }

    if (term.hasSelection()) {
      void copySelection().catch(() => {})
      focusTerminal()
      return
    }

    void navigator.clipboard.readText().then(pasteText).catch(() => {})
    focusTerminal()
  }

  container.addEventListener('mousedown', handleMouseDown)
  container.addEventListener('copy', handleCopy)
  container.addEventListener('paste', handlePaste)
  container.addEventListener('keydown', handleKeyDown)
  container.addEventListener('contextmenu', handleContextMenu, { capture: true })

  return () => {
    container.removeEventListener('mousedown', handleMouseDown)
    container.removeEventListener('copy', handleCopy)
    container.removeEventListener('paste', handlePaste)
    container.removeEventListener('keydown', handleKeyDown)
    container.removeEventListener('contextmenu', handleContextMenu, { capture: true })
  }
}
