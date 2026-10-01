import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'
import type { TranscriptEntry, TranscriptToolEntry } from './conversationProjection'

// Counts how often a step is presented, which each tool row does when it renders.
const presented = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../../../shared/conversation/presentation', async (original) => {
  const actual = await original<typeof import('../../../../../shared/conversation/presentation')>()
  return {
    ...actual,
    presentToolItem: (...args: Parameters<typeof actual.presentToolItem>) => {
      presented.count++
      return actual.presentToolItem(...args)
    },
  }
})

test('a token streaming into a turn re-renders its reply, not its steps', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.assign(dom.window, {
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    api: { platform: 'darwin' },
  })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { AssistantTurnBlock } = await import('./timelineRows')
  const step = (id: string, status: TranscriptToolEntry['status'], command: string): TranscriptToolEntry => ({
    kind: 'tool',
    id,
    turnId: 'turn',
    name: 'Bash',
    toolKind: 'command',
    status,
    input: { command },
    startedAt: 1,
    ...(status === 'done' ? { completedAt: 2 } : {}),
  })
  const tools = [step('a', 'done', 'npm test'), step('b', 'done', 'git status'), step('c', 'running', 'npm run lint')]
  const entry = (text: string): Extract<TranscriptEntry, { kind: 'assistant' }> => ({
    kind: 'assistant',
    turnId: 'turn',
    text,
    reasoning: '',
    status: 'streaming',
    intermediateText: [{ text: 'Checking first.', beforeToolUseId: 'a' }],
  })
  const chrome = { assistantName: 'Claude', onRetry: () => undefined, retryDisabled: false }
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  const render = (text: string) =>
    createElement(AssistantTurnBlock, { entry: entry(text), tools, decisions: [], chrome })
  try {
    await act(async () => root.render(render('Hel')))
    expect(presented.count).toBeGreaterThan(0)
    const settled = presented.count
    for (const text of ['Hello', 'Hello the', 'Hello there']) await act(async () => root.render(render(text)))
    expect(host.textContent).toContain('Hello there')
    expect(presented.count).toBe(settled)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
