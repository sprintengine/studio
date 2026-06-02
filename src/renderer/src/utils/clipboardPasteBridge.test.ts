import assert from 'node:assert/strict'
import { bindElectronClipboardPasteBridge } from './clipboardPasteBridge'

class TestInputEvent extends Event {
  data: string | null
  inputType: string

  constructor(type: string, options: EventInit & { data?: string | null; inputType?: string } = {}) {
    super(type, options)
    this.data = options.data ?? null
    this.inputType = options.inputType ?? ''
  }
}

class TestElement extends EventTarget {
  className = ''
  isConnected = true
  parent: TestElement | null = null

  closest(selector: string): TestElement | null {
    if (selector.includes('.xterm') && this.className.split(/\s+/u).includes('xterm')) return this
    if (selector.includes('.monaco-editor') && this.className.split(/\s+/u).includes('monaco-editor')) return this
    return this.parent?.closest(selector) ?? null
  }

  contains(candidate: unknown): boolean {
    let current = candidate instanceof TestElement ? candidate : null
    while (current) {
      if (current === this) return true
      current = current.parent
    }
    return false
  }

  appendChild(child: TestElement): void {
    child.parent = this
  }

  remove(): void {
    this.isConnected = false
  }
}

class TestInput extends TestElement {
  disabled = false
  readOnly = false
  type = 'text'
  value = ''
  selectionStart: number | null = 0
  selectionEnd: number | null = 0

  focus(): void {
    testDocument.activeElement = this
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start
    this.selectionEnd = end
  }

  setRangeText(text: string, start: number, end: number, selectionMode?: SelectionMode): void {
    this.value = `${this.value.slice(0, start)}${text}${this.value.slice(end)}`
    if (selectionMode === 'end') {
      this.selectionStart = start + text.length
      this.selectionEnd = start + text.length
    }
  }
}

class TestTextArea extends TestInput {}

class TestDocument extends EventTarget {
  body = new TestElement()
  activeElement: TestElement | null = null

  createElement(tag: string): TestElement {
    return tag === 'textarea' ? new TestTextArea() : new TestInput()
  }
}

const testDocument = new TestDocument()

Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: TestElement })
Object.defineProperty(globalThis, 'HTMLInputElement', { configurable: true, value: TestInput })
Object.defineProperty(globalThis, 'HTMLTextAreaElement', { configurable: true, value: TestTextArea })
Object.defineProperty(globalThis, 'InputEvent', { configurable: true, value: TestInputEvent })
Object.defineProperty(globalThis, 'document', { configurable: true, value: testDocument })
Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function pasteEvent(text = ''): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => type === 'text/plain' ? text : '',
    },
  })
  return event
}

async function testPastesIntoInputFromElectronClipboard(): Promise<void> {
  const input = new TestInput()
  input.value = 'hello '
  testDocument.body.appendChild(input)
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
  let inputEvents = 0
  input.addEventListener('input', () => {
    inputEvents += 1
  })

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      clipboardReadText: async () => 'world',
    },
  })

  const dispose = bindElectronClipboardPasteBridge(input as unknown as Document)
  input.dispatchEvent(pasteEvent())
  await flushPromises()

  assert.equal(input.value, 'hello world')
  assert.equal(inputEvents, 1)
  dispose()
  input.remove()
}

async function testLeavesNormalPasteEventsAlone(): Promise<void> {
  const input = new TestInput()
  testDocument.body.appendChild(input)
  input.focus()
  let reads = 0

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      clipboardReadText: async () => {
        reads += 1
        return 'bridge'
      },
    },
  })

  const dispose = bindElectronClipboardPasteBridge(input as unknown as Document)
  input.dispatchEvent(pasteEvent('native'))
  await flushPromises()

  assert.equal(input.value, '')
  assert.equal(reads, 0)
  dispose()
  input.remove()
}

async function testSkipsTerminalOwnedTextarea(): Promise<void> {
  const wrapper = new TestElement()
  wrapper.className = 'xterm'
  const textarea = new TestTextArea()
  wrapper.appendChild(textarea)
  testDocument.body.appendChild(wrapper)
  textarea.focus()
  let reads = 0

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      clipboardReadText: async () => {
        reads += 1
        return 'terminal'
      },
    },
  })

  const dispose = bindElectronClipboardPasteBridge(textarea as unknown as Document)
  textarea.dispatchEvent(pasteEvent())
  await flushPromises()

  assert.equal(textarea.value, '')
  assert.equal(reads, 0)
  dispose()
  wrapper.remove()
}

async function testSkipsCodeEditorOwnedTextarea(): Promise<void> {
  const wrapper = new TestElement()
  wrapper.className = 'monaco-editor'
  const textarea = new TestTextArea()
  wrapper.appendChild(textarea)
  testDocument.body.appendChild(wrapper)
  textarea.focus()
  let reads = 0

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      clipboardReadText: async () => {
        reads += 1
        return 'editor'
      },
    },
  })

  const dispose = bindElectronClipboardPasteBridge(textarea as unknown as Document)
  textarea.dispatchEvent(pasteEvent())
  await flushPromises()

  assert.equal(textarea.value, '')
  assert.equal(reads, 0)
  dispose()
  wrapper.remove()
}

void testPastesIntoInputFromElectronClipboard()
  .then(testLeavesNormalPasteEventsAlone)
  .then(testSkipsTerminalOwnedTextarea)
  .then(testSkipsCodeEditorOwnedTextarea)
