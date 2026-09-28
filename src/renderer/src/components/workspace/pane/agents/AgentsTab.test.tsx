import { JSDOM } from 'jsdom'
import { expect, test } from 'vitest'
import type {
  ConversationEvent,
  ConversationEventType,
  ConversationSessionFrame,
} from '../../../../../../shared/conversation-runtime'

let seq = 0
function event(type: ConversationEventType, payload: Record<string, unknown>): ConversationEvent {
  seq++
  return {
    id: `event-${seq}`,
    seq,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'claude-agent',
    modelId: 'sonnet',
    type,
    createdAt: seq * 1000,
    payload,
  }
}

// A chat that sent two agents off: one still working (a step in, reporting what
// it is doing), one finished with its report.
const transcript = [
  event('session_updated', {
    providerSessionId: 'native',
    agents: [{ name: 'Explore', description: 'Fast read-only search agent for locating code.' }],
  }),
  event('turn_started', { turnId: 'turn-1' }),
  event('tool_started', {
    turnId: 'turn-1',
    toolCallId: 'lane-find',
    tool: 'Agent',
    subagentLane: true,
    subagentType: 'Explore',
    input: { description: 'Find the router', subagent_type: 'Explore' },
  }),
  event('subagent_status', { toolUseId: 'lane-find', status: 'running', background: true }),
  event('tool_started', {
    turnId: 'turn-1',
    toolCallId: 'lane-plan',
    tool: 'Agent',
    subagentLane: true,
    subagentType: 'Plan',
    input: { description: 'Plan the migration', subagent_type: 'Plan' },
  }),
  event('subagent_status', { toolUseId: 'lane-plan', status: 'running', background: true }),
  event('turn_completed', { turnId: 'turn-1' }),
  event('tool_started', {
    turnId: 'turn-1',
    toolCallId: 'grep-1',
    tool: 'Grep',
    summary: 'Grep: createRouter',
    parentToolUseId: 'lane-find',
  }),
  event('subagent_status', {
    toolUseId: 'lane-find',
    status: 'running',
    progressSummary: 'Searching for the router',
    usage: { totalTokens: 9_000, toolUses: 1, durationMs: 2_000 },
  }),
  event('tool_output', { toolCallId: 'lane-plan', output: 'Move the tables first.', backgroundResult: true }),
  event('subagent_status', {
    toolUseId: 'lane-plan',
    status: 'completed',
    usage: { totalTokens: 21_000, toolUses: 4, durationMs: 9_000 },
  }),
]

async function mountAgentsTab({ focused = true }: { focused?: boolean } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  const frames: ((frame: ConversationSessionFrame) => void)[] = []
  Object.assign(dom.window, {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    api: {
      platform: 'darwin',
      onConversationSession: (_input: unknown, receive: (frame: ConversationSessionFrame) => void) => {
        frames.push(receive)
        return () => undefined
      },
    },
  })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useWorkspaceStore } = await import('../../../../store/workspaceStore')
  const { AgentsTab } = await import('./AgentsTab')
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: 'workspace',
        name: 'Project',
        folderPath: '/Users/dev/project',
        agents: {
          agent: {
            id: 'agent',
            name: 'Router work',
            runtimeKind: 'conversation',
            conversation: { providerId: 'claude-agent', modelId: 'sonnet' },
          },
        },
      },
    ] as never,
    focusedAgentByWorkspaceId: focused ? { workspace: 'agent' } : {},
  })
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(AgentsTab, { workspaceId: 'workspace', active: true })))
  return {
    host,
    act,
    async deliver(events: ConversationEvent[]) {
      await act(async () => {
        frames.at(-1)?.({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: null } })
        frames.at(-1)?.({ type: 'synchronized', seq: events.at(-1)?.seq ?? 0 })
      })
    },
    button: (label: string) =>
      Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.includes(label)),
    subscriptions: () => frames.length,
    async unmount() {
      await act(async () => root.unmount())
      dom.window.close()
      for (const key of Object.keys(globals)) {
        if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

test('with no chat in focus the tab says where agents come from', async () => {
  const tab = await mountAgentsTab({ focused: false })
  try {
    expect(tab.host.textContent).toContain('No chat in focus')
    expect(tab.subscriptions()).toBe(0)
  } finally {
    await tab.unmount()
  }
})

test('the focused chat’s agents are listed working first, and one opens onto its own thread', async () => {
  const tab = await mountAgentsTab()
  try {
    await tab.deliver(transcript)
    const text = tab.host.textContent ?? ''
    expect(text).toContain('Router work')
    expect(text).toContain('Working · 1')
    expect(text).toContain('Finished · 1')
    expect(text).toContain('Find the router')
    expect(text).toContain('Searching for the router')
    expect(text).toContain('Plan the migration')
    expect(text).toContain('Done in')
    expect(text).toContain('Move the tables first.')
    expect(text).toContain('1 working · 1 finished · 30k tokens')
    expect(text.indexOf('Find the router')).toBeLessThan(text.indexOf('Plan the migration'))

    await tab.act(async () => tab.button('Find the router')!.click())
    const thread = tab.host.textContent ?? ''
    expect(thread).toContain('‹ All agents')
    expect(thread).toContain('Fast read-only search agent for locating code.')
    expect(thread).toContain('Now: Searching for the router')
    expect(thread).toContain('Steps')
    expect(thread).toContain('createRouter')
    expect(thread).not.toContain('Report')

    await tab.act(async () => tab.button('All agents')!.click())
    expect(tab.host.textContent).toContain('Finished · 1')
  } finally {
    await tab.unmount()
  }
})

test('a chat asking for one of its agents opens the tab on that agent', async () => {
  const tab = await mountAgentsTab()
  try {
    await tab.deliver(transcript)
    const { openAgentsPane } = await import('./agentsPaneFocus')
    await tab.act(async () => openAgentsPane('workspace', 'agent', 'lane-plan'))
    const thread = tab.host.textContent ?? ''
    expect(thread).toContain('‹ All agents')
    expect(thread).toContain('Plan the migration')
    expect(thread).toContain('Report')
    expect(thread).toContain('It took no steps of its own.')
  } finally {
    await tab.unmount()
  }
})

test('an agent’s words sit before the step they lead into, and its report is not said twice', async () => {
  const { placeAgentMessages } = await import('./AgentsTab')
  const lane = {
    kind: 'tool' as const,
    id: 'lane',
    turnId: 'turn',
    name: 'Agent',
    status: 'done' as const,
    subagentLane: true,
    output: 'The router lives in src/router.ts.\n\nIt exports createRouter.',
    children: [
      { kind: 'tool' as const, id: 'grep', turnId: 'turn', name: 'Grep', status: 'done' as const, startedAt: 20 },
      { kind: 'tool' as const, id: 'read', turnId: 'turn', name: 'Read', status: 'done' as const, startedAt: 40 },
    ],
    messages: [
      { at: 10, text: 'Searching for the router.' },
      { at: 30, text: 'Found a candidate; reading it.' },
      { at: 50, text: 'One more note.' },
      { at: 60, text: 'The router lives in src/router.ts.' },
    ],
  }
  expect(placeAgentMessages(lane)).toEqual({
    beforeSteps: [
      { text: 'Searching for the router.', beforeToolUseId: 'grep' },
      { text: 'Found a candidate; reading it.', beforeToolUseId: 'read' },
    ],
    afterSteps: ['One more note.'],
  })
  // While it works, nothing it said is its report yet.
  expect(placeAgentMessages({ ...lane, status: 'running' }).afterSteps).toEqual([
    'One more note.',
    'The router lives in src/router.ts.',
  ])
})
