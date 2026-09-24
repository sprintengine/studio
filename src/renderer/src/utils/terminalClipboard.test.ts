import assert from 'node:assert/strict'
import { bindTerminalClipboardHandlers, claudeImagePasteKey } from './terminalClipboard'
import { test } from 'vitest'

test('terminalClipboard', async () => {
  function mouseEvent(type: string, options: { button?: number; ctrlKey?: boolean } = {}): MouseEvent {
    const event = new Event(type, { bubbles: true, cancelable: true }) as MouseEvent
    Object.defineProperty(event, 'button', { value: options.button ?? 0 })
    Object.defineProperty(event, 'ctrlKey', { value: options.ctrlKey ?? false })
    return event
  }

  async function flushPromises(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
  }

  async function testRightClickCopyClearsSelectionThenPaste(): Promise<void> {
    const container = new EventTarget() as HTMLElement
    const writes: string[] = []
    let clipboardText = 'paste text'
    let selection = 'copied text'
    let clearedSelection = 0

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          clipboardWriteText: async (text: string) => {
            clipboardText = text
          },
          clipboardReadText: async () => clipboardText,
          terminalWrite: async (_sessionId: string, text: string) => {
            writes.push(text)
          },
        },
      },
    })

    const dispose = bindTerminalClipboardHandlers({
      container,
      sessionId: 'terminal-test',
      focusTerminal: () => {},
      recordKeydown: () => {},
      term: {
        // Text reaches the pane through xterm, which brackets it (see pasteText).
        paste: (text: string) => {
          writes.push(text)
        },
        getSelection: () => selection,
        hasSelection: () => Boolean(selection),
        clearSelection: () => {
          selection = ''
          clearedSelection += 1
        },
      } as any,
    })

    container.dispatchEvent(mouseEvent('mousedown', { button: 2 }))
    container.dispatchEvent(mouseEvent('contextmenu', { button: 2 }))

    assert.equal(selection, '')
    assert.equal(clearedSelection, 1)
    await flushPromises()
    assert.equal(clipboardText, 'copied text')
    assert.deepEqual(writes, [])

    clipboardText = 'paste text'
    container.dispatchEvent(mouseEvent('mousedown', { button: 2 }))
    container.dispatchEvent(mouseEvent('contextmenu', { button: 2 }))
    await flushPromises()

    assert.deepEqual(writes, ['paste text'])

    dispose()
  }

  async function testRightClickUsesSelectionCapturedBeforeXtermClearsIt(): Promise<void> {
    const container = new EventTarget() as HTMLElement
    let clipboardText = ''
    let selection = 'captured text'
    let clearedSelection = 0
    let writes = 0

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          clipboardWriteText: async (text: string) => {
            clipboardText = text
          },
          clipboardReadText: async () => 'paste text',
          terminalWrite: async () => {
            writes += 1
          },
        },
      },
    })

    const dispose = bindTerminalClipboardHandlers({
      container,
      sessionId: 'terminal-test',
      focusTerminal: () => {},
      recordKeydown: () => {},
      term: {
        paste: () => {
          writes += 1
        },
        getSelection: () => selection,
        hasSelection: () => Boolean(selection),
        clearSelection: () => {
          selection = ''
          clearedSelection += 1
        },
      } as any,
    })

    container.dispatchEvent(mouseEvent('mousedown', { button: 2 }))
    selection = ''
    container.dispatchEvent(mouseEvent('contextmenu', { button: 2 }))
    await flushPromises()

    assert.equal(clipboardText, 'captured text')
    assert.equal(clearedSelection, 1)
    assert.equal(writes, 0)

    dispose()
  }

  async function testContextMenuWithoutMouseDownStillPastes(): Promise<void> {
    const container = new EventTarget() as HTMLElement
    const writes: string[] = []

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          clipboardWriteText: async () => {},
          clipboardReadText: async () => 'trackpad paste',
          terminalWrite: async (_sessionId: string, text: string) => {
            writes.push(text)
          },
        },
      },
    })

    const dispose = bindTerminalClipboardHandlers({
      container,
      sessionId: 'terminal-test',
      focusTerminal: () => {},
      recordKeydown: () => {},
      term: {
        // Text reaches the pane through xterm, which brackets it (see pasteText).
        paste: (text: string) => {
          writes.push(text)
        },
        getSelection: () => '',
        hasSelection: () => false,
        clearSelection: () => {},
      } as any,
    })

    container.dispatchEvent(mouseEvent('contextmenu', { button: 0 }))
    await flushPromises()

    assert.deepEqual(writes, ['trackpad paste'])

    dispose()
  }

  async function testRightClickAfterCopyPastesEvenWhenXtermReportsStaleSelection(): Promise<void> {
    const container = new EventTarget() as HTMLElement
    const writes: string[] = []
    let clipboardText = 'original'
    let copied = 0
    let clearedSelection = 0

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          clipboardWriteText: async (text: string) => {
            copied += 1
            clipboardText = text
          },
          clipboardReadText: async () => clipboardText,
          terminalWrite: async (_sessionId: string, text: string) => {
            writes.push(text)
          },
        },
      },
    })

    const dispose = bindTerminalClipboardHandlers({
      container,
      sessionId: 'terminal-test',
      focusTerminal: () => {},
      recordKeydown: () => {},
      term: {
        // Text reaches the pane through xterm, which brackets it (see pasteText).
        paste: (text: string) => {
          writes.push(text)
        },
        getSelection: () => 'stale selection',
        hasSelection: () => true,
        clearSelection: () => {
          clearedSelection += 1
        },
      } as any,
    })

    container.dispatchEvent(mouseEvent('mousedown', { button: 2 }))
    container.dispatchEvent(mouseEvent('contextmenu', { button: 2 }))
    await flushPromises()

    assert.equal(copied, 1)
    assert.equal(clearedSelection, 1)
    assert.equal(clipboardText, 'stale selection')
    assert.deepEqual(writes, [])

    container.dispatchEvent(mouseEvent('mousedown', { button: 2 }))
    container.dispatchEvent(mouseEvent('contextmenu', { button: 2 }))
    await flushPromises()

    assert.equal(copied, 1, 'second right-click should paste, not copy the stale selection again')
    assert.deepEqual(writes, ['stale selection'])

    dispose()
  }

  async function testPasteFallsBackToLastTerminalCopyWhenClipboardReadFails(): Promise<void> {
    const container = new EventTarget() as HTMLElement
    const writes: string[] = []
    let selection = 'remembered copy'

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          clipboardWriteText: async () => {
            throw new Error('clipboard write unavailable')
          },
          clipboardReadText: async () => {
            throw new Error('clipboard read unavailable')
          },
          terminalWrite: async (_sessionId: string, text: string) => {
            writes.push(text)
          },
        },
      },
    })

    const dispose = bindTerminalClipboardHandlers({
      container,
      sessionId: 'terminal-test',
      focusTerminal: () => {},
      recordKeydown: () => {},
      term: {
        // Text reaches the pane through xterm, which brackets it (see pasteText).
        paste: (text: string) => {
          writes.push(text)
        },
        getSelection: () => selection,
        hasSelection: () => Boolean(selection),
        clearSelection: () => {
          selection = ''
        },
      } as any,
    })

    container.dispatchEvent(mouseEvent('mousedown', { button: 2 }))
    container.dispatchEvent(mouseEvent('contextmenu', { button: 2 }))
    await flushPromises()

    assert.deepEqual(writes, [])

    container.dispatchEvent(mouseEvent('mousedown', { button: 2 }))
    container.dispatchEvent(mouseEvent('contextmenu', { button: 2 }))
    await flushPromises()

    assert.deepEqual(writes, ['remembered copy'])

    dispose()
  }

  function pasteEvent(data: { text?: string; imageType?: string }): ClipboardEvent {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    const items = data.imageType ? [{ kind: 'file', type: data.imageType }] : []
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: () => data.text ?? '', items },
    })
    return event
  }

  // An image-only clipboard has no text to send, so Ctrl+V used to do nothing in
  // a Claude Code pane on Windows. It now sends the CLI's own image-paste key.
  async function testImageOnlyPasteSendsTheCliImagePasteKey(): Promise<void> {
    const container = new EventTarget() as HTMLElement
    const writes: string[] = []

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          clipboardWriteText: async () => {},
          clipboardReadText: async () => '',
          terminalWrite: async (_sessionId: string, text: string) => {
            writes.push(text)
          },
        },
      },
    })

    let key: string | null = 'v'
    const dispose = bindTerminalClipboardHandlers({
      container,
      sessionId: 'terminal-test',
      focusTerminal: () => {},
      term: {
        getSelection: () => '',
        clearSelection: () => {},
        paste: (text: string) => {
          writes.push(text)
        },
      } as any,
      imagePasteKey: () => key,
    })

    const imagePaste = pasteEvent({ imageType: 'image/png' })
    container.dispatchEvent(imagePaste)
    assert.equal(imagePaste.defaultPrevented, true)
    assert.deepEqual(writes, ['v'])

    // Text on the clipboard still pastes as text, image or not.
    container.dispatchEvent(pasteEvent({ text: 'words', imageType: 'image/png' }))
    await flushPromises()
    assert.deepEqual(writes, ['v', 'words'])

    // A CLI with no image-paste key leaves the event alone.
    key = null
    const ignored = pasteEvent({ imageType: 'image/png' })
    container.dispatchEvent(ignored)
    assert.equal(ignored.defaultPrevented, false)
    assert.deepEqual(writes, ['v', 'words'])

    dispose()
  }

  function testClaudeImagePasteKeyIsNativeWindowsClaudeOnly(): void {
    assert.equal(claudeImagePasteKey('claude-code', false, 'win32'), 'v')
    assert.equal(claudeImagePasteKey('zai', undefined, 'win32'), 'v')
    assert.equal(claudeImagePasteKey('claude-code', true, 'win32'), null)
    assert.equal(claudeImagePasteKey('claude-code', false, 'darwin'), null)
    assert.equal(claudeImagePasteKey('codex', false, 'win32'), null)
    assert.equal(claudeImagePasteKey(undefined, false, 'win32'), null)
  }

  const suiteRun = testRightClickCopyClearsSelectionThenPaste()
    .then(testRightClickUsesSelectionCapturedBeforeXtermClearsIt)
    .then(testContextMenuWithoutMouseDownStillPastes)
    .then(testRightClickAfterCopyPastesEvenWhenXtermReportsStaleSelection)
    .then(testPasteFallsBackToLastTerminalCopyWhenClipboardReadFails)
    .then(testImageOnlyPasteSendsTheCliImagePasteKey)
    .then(testClaudeImagePasteKeyIsNativeWindowsClaudeOnly)

  await suiteRun
})

// Text pastes through xterm's own `paste`, which converts newlines and adds
// the bracketed-paste markers when the CLI in the pane has asked for them.
// Writing the text to the pty directly skipped both, so an agent CLI read a
// multi-line paste as keystrokes and submitted at the first newline.
test('pasted text goes through xterm, never straight to the pty', async () => {
  const container = new EventTarget() as HTMLElement
  const pasted: string[] = []
  const ptyWrites: string[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        clipboardWriteText: async () => {},
        clipboardReadText: async () => '',
        terminalWrite: async (_sessionId: string, text: string) => {
          ptyWrites.push(text)
        },
      },
    },
  })
  const dispose = bindTerminalClipboardHandlers({
    container,
    sessionId: 'terminal-test',
    focusTerminal: () => {},
    term: {
      getSelection: () => '',
      clearSelection: () => {},
      paste: (text: string) => {
        pasted.push(text)
      },
    } as never,
  })
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? 'line one\nline two\r\n' : ''), items: [] },
  })
  container.dispatchEvent(event)
  await Promise.resolve()

  assert.equal(event.defaultPrevented, true)
  assert.deepEqual(pasted, ['line one\nline two\r\n'], 'handed to xterm as the clipboard holds it')
  assert.deepEqual(ptyWrites, [], 'nothing reaches the pty around xterm')
  dispose()
})
