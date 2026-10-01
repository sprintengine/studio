import assert from 'node:assert/strict'
import { test } from 'vitest'
import type * as Monaco from 'monaco-editor'

import { revealShownFor } from '../hooks/useAgentEditorReveal'
import {
  isOwnerTyping,
  OWNER_TYPING_WINDOW_MS,
  queueEditorLanding,
  registerMountedEditor,
  revealEditorRange,
  takeEditorLanding,
  trackWindowKeystrokes,
} from './agentEditorReveal'

type Listener = () => void

function fakeEditor(options: { focused?: boolean; lines?: number } = {}) {
  const keyListeners: Listener[] = []
  const mouseListeners: Listener[] = []
  const calls: string[] = []
  let decorationsCleared = false
  const editor = {
    hasTextFocus: () => options.focused === true,
    onKeyDown: (listener: Listener) => {
      keyListeners.push(listener)
      return { dispose: () => keyListeners.splice(keyListeners.indexOf(listener), 1) }
    },
    onMouseDown: (listener: Listener) => {
      mouseListeners.push(listener)
      return { dispose: () => mouseListeners.splice(mouseListeners.indexOf(listener), 1) }
    },
    onDidFocusEditorText: () => ({ dispose: () => undefined }),
    getModel: () => ({ getLineCount: () => options.lines ?? 100 }),
    revealLinesInCenter: (start: number, end: number) => calls.push(`reveal:${start}-${end}`),
    setPosition: () => calls.push('setPosition'),
    focus: () => calls.push('focus'),
    createDecorationsCollection: () => ({
      clear: () => {
        decorationsCleared = true
      },
    }),
  }
  return {
    editor: editor as unknown as Monaco.editor.IStandaloneCodeEditor,
    calls,
    typeKey: () => keyListeners.forEach((listener) => listener()),
    click: () => mouseListeners.forEach((listener) => listener()),
    get cleared() {
      return decorationsCleared
    },
  }
}

test('a window that shows the workspace opens behind the tab while the person types', () => {
  assert.deepEqual(revealShownFor({ windowVisible: true, ownerTyping: false }), {
    mode: 'foreground',
    shown: 'foreground',
  })
  assert.deepEqual(revealShownFor({ windowVisible: true, ownerTyping: true }), {
    mode: 'background',
    shown: 'background',
  })
  // Minimized: opened for when they come back, and the agent is told they cannot see it.
  assert.deepEqual(revealShownFor({ windowVisible: false, ownerTyping: false }), {
    mode: 'foreground',
    shown: 'not_visible',
  })
})

test('typing means the editor has the keyboard or took a keystroke a moment ago', () => {
  const focused = fakeEditor({ focused: true })
  const stopFocused = registerMountedEditor('ws-typing', '/Users/dev/a.ts', focused.editor)
  assert.equal(isOwnerTyping('ws-typing'), true)
  stopFocused()
  assert.equal(isOwnerTyping('ws-typing'), false)

  const idle = fakeEditor()
  const stopIdle = registerMountedEditor('ws-typing', '/Users/dev/a.ts', idle.editor)
  assert.equal(isOwnerTyping('ws-typing'), false)
  idle.typeKey()
  assert.equal(isOwnerTyping('ws-typing'), true)
  assert.equal(isOwnerTyping('ws-typing', Date.now() + OWNER_TYPING_WINDOW_MS + 1), false)
  // Another workspace's editor says nothing about this one.
  assert.equal(isOwnerTyping('ws-other'), false)
  stopIdle()
})

test('a landing waits for its file and is taken once', () => {
  queueEditorLanding('ws-land', '/Users/dev/a.ts', { range: { startLine: 3 }, takeFocus: false, highlight: true })
  assert.equal(takeEditorLanding('ws-land', '/Users/dev/b.ts'), null)
  assert.deepEqual(takeEditorLanding('ws-land', '/Users/dev/a.ts')?.range, { startLine: 3 })
  assert.equal(takeEditorLanding('ws-land', '/Users/dev/a.ts'), null)
})

test('an agent reveal scrolls to the range without moving the caret or the keyboard', () => {
  const fake = fakeEditor({ lines: 50 })
  const clear = revealEditorRange(fake.editor, { startLine: 40, endLine: 90 }, { highlight: true, moveCaret: false })
  // Clamped to the file's 50 lines.
  assert.deepEqual(fake.calls, ['reveal:40-50'])
  assert.equal(fake.cleared, false)
  clear()
  assert.equal(fake.cleared, true)
})

test('a key just pressed in any text field of the window counts as typing, not only the editor', () => {
  const stop = trackWindowKeystrokes({
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      ;(listener as () => void)()
    },
    removeEventListener: () => undefined,
  } as unknown as Window)
  const terminalInput = { tagName: 'TEXTAREA' } as unknown as Element
  const button = { tagName: 'BUTTON', isContentEditable: false } as unknown as Element
  assert.equal(isOwnerTyping('ws-terminal', Date.now(), terminalInput), true)
  assert.equal(isOwnerTyping('ws-terminal', Date.now(), button), false)
  assert.equal(isOwnerTyping('ws-terminal', Date.now() + OWNER_TYPING_WINDOW_MS + 1, terminalInput), false)
  stop()
})
