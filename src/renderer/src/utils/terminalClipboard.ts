import type { Terminal } from '@xterm/xterm'

import { isTerminalChromeTarget } from './keyboard'

type TerminalClipboardHandlersOptions = {
  container: HTMLElement
  term: Terminal
  sessionId: string
  focusTerminal: () => void
  recordKeydown?: (event: KeyboardEvent) => void
  /**
   * Where the image-paste key goes. Defaults to this machine's terminal runtime.
   *
   * A REMOTE pane passes its own writer, because its session id names
   * a session on another machine: writing through the local path would either
   * land nowhere or, worse, in a local session that happens to share the id.
   * Pasted TEXT does not come here: it goes through xterm (see `pasteText`),
   * and so through the pane's own input path, remote or not. Copy needs no
   * override — the selection is in this xterm either way.
   */
  write?: (text: string) => void
  /**
   * The bytes that ask the CLI in this pane to attach the clipboard image, or
   * null when it has no such key. Read at paste time, since a pane's CLI is
   * resolved after the handlers bind.
   *
   * A terminal cannot carry an image — the CLI reads the clipboard itself when
   * it sees its image-paste key. Claude Code on Windows binds that to Alt+V, not
   * Ctrl+V, so a Ctrl+V with only an image on the clipboard used to do nothing:
   * there was no text to send and the CLI never heard a paste happened.
   */
  imagePasteKey?: () => string | null
}

// CLIs whose launch binary is Claude Code itself (claude-code, and the plugins
// that point Claude Code at another model: zai, kimi-claude).
const CLAUDE_CODE_BINARY_CLIS = new Set(['claude-code', 'zai', 'kimi-claude'])

/**
 * Claude Code's image-paste key for this pane, when Ctrl+V does not already
 * reach it: native Windows only. Under WSL, and on macOS/Linux, Claude Code
 * binds Ctrl+V itself.
 */
export function claudeImagePasteKey(
  cli: string | undefined,
  useWsl: boolean | undefined,
  platform: string = window.api.platform,
): string | null {
  if (platform !== 'win32' || useWsl || !cli || !CLAUDE_CODE_BINARY_CLIS.has(cli)) return null
  return 'v'
}

function clipboardHasImage(data: DataTransfer | null): boolean {
  if (!data) return false
  return Array.from(data.items ?? []).some((item) => item.kind === 'file' && item.type.startsWith('image/'))
}

type RuntimeClipboardApi = {
  clipboardReadText?: () => Promise<string>
  clipboardWriteText?: (text: string) => Promise<void>
}

/**
 * Put text on the system clipboard, reporting whether it landed.
 *
 * The one writer in the renderer, shared by the pane's own copy handlers below
 * and by OSC 52 (`terminalOsc52Clipboard.ts`) — a CLI copying through an escape
 * sequence and a user pressing the copy key must reach the same clipboard, or
 * "copy" means two things in one pane. Electron's clipboard over IPC rather
 * than `navigator.clipboard`, which needs document focus and a user gesture:
 * a CLI copying while the user is in another window is the normal case.
 *
 * Never throws. `false` means the text did not land — an empty string, a
 * runtime with no clipboard API (a test host), or a rejected IPC call.
 */
export async function writeTerminalClipboardText(text: string): Promise<boolean> {
  if (!text) return false
  const api = window.api as typeof window.api & RuntimeClipboardApi
  if (typeof api.clipboardWriteText !== 'function') return false
  try {
    await api.clipboardWriteText(text)
    return true
  } catch {
    return false
  }
}

export function bindTerminalClipboardHandlers({
  container,
  term,
  sessionId,
  focusTerminal,
  recordKeydown,
  write,
  imagePasteKey,
}: TerminalClipboardHandlersOptions): () => void {
  let lastKnownSelection = term.getSelection()
  let secondaryClickSelection = ''
  let pasteOnNextContextMenu = false
  let lastTerminalCopiedText = ''

  const writeClipboardText = writeTerminalClipboardText

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

  // Text is pasted through xterm, not written to the pty. `term.paste` turns
  // newlines into carriage returns as this used to by hand, and, when the
  // program in the pane has asked for bracketed paste (DECSET 2004, which every
  // agent CLI does), wraps the text in `ESC[200~` … `ESC[201~`. Without the
  // markers the CLI reads the paste as typed keystrokes: each newline is a
  // submit, and a large paste is fed through its key handling one character
  // at a time.
  //
  // The bytes then leave through the pane's own `onData` handler, the same
  // path a keystroke takes, so a suspended agent buffers the paste and resumes
  // rather than losing it, and a remote pane that may not type refuses it.
  const pasteText = async (text: string) => {
    if (!text) return
    term.paste(text)
    focusTerminal()
  }

  const handleCopy = (event: ClipboardEvent) => {
    if (isTerminalChromeTarget(event.target)) return
    const selection = getCopySelection()
    if (!selection) return
    event.preventDefault()
    event.clipboardData?.setData('text/plain', selection)
    lastTerminalCopiedText = selection
    void writeClipboardText(selection)
  }

  const handlePaste = (event: ClipboardEvent) => {
    if (isTerminalChromeTarget(event.target)) return
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (!text) {
      const key = clipboardHasImage(event.clipboardData ?? null) ? imagePasteKey?.() : null
      if (!key) return
      event.preventDefault()
      if (write) write(key)
      else void window.api.terminalWrite(sessionId, key)
      focusTerminal()
      return
    }
    event.preventDefault()
    void pasteText(text)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (isTerminalChromeTarget(event.target)) return
    recordKeydown?.(event)
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
    if (isTerminalChromeTarget(event.target)) return
    const isSecondaryClick = event.button === 2 || (event.ctrlKey && event.button === 0)
    if (!isSecondaryClick) pasteOnNextContextMenu = false
    secondaryClickSelection = isSecondaryClick ? getCopySelection() : ''
    focusTerminal()
  }

  const handleContextMenu = (event: MouseEvent) => {
    // A right-click in the pane's own chrome (the find field) is that control's
    // to answer — this handler would otherwise turn it into a terminal
    // copy-or-paste on a selection the user is not looking at.
    if (isTerminalChromeTarget(event.target)) return
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
