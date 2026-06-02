import assert from 'node:assert/strict'
import { bindTerminalClipboardHandlers } from './terminalClipboard'

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

void testRightClickCopyClearsSelectionThenPaste()
  .then(testRightClickUsesSelectionCapturedBeforeXtermClearsIt)
  .then(testContextMenuWithoutMouseDownStillPastes)
  .then(testRightClickAfterCopyPastesEvenWhenXtermReportsStaleSelection)
  .then(testPasteFallsBackToLastTerminalCopyWhenClipboardReadFails)
