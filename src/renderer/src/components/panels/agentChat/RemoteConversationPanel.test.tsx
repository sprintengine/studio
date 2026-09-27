import { JSDOM } from 'jsdom'
import { forwardRef, Fragment, useImperativeHandle, useRef, type ReactNode } from 'react'
import { expect, test, vi } from 'vitest'
import type { ConversationEvent, ConversationEventType } from '../../../../../shared/conversation-runtime'
import type {
  FleetConversation,
  FleetConversationFrame,
  FleetConversationKey,
  FleetConversationLink,
} from '../../../../../shared/tailnet-fleet'

// The virtual list measures a real viewport, which jsdom does not have; this
// stand-in renders every row.
vi.mock('@legendapp/list/react', () => ({
  LegendList: forwardRef(function LegendList(
    {
      data,
      renderItem,
      keyExtractor,
      className,
    }: {
      data: unknown[]
      renderItem: (props: { item: unknown; index: number }) => ReactNode
      keyExtractor: (item: unknown) => string
      className?: string
    },
    ref,
  ) {
    const scroller = useRef<HTMLDivElement>(null)
    useImperativeHandle(ref, () => ({
      scrollToEnd: async () => undefined,
      scrollToIndex: async () => undefined,
      scrollToOffset: async () => undefined,
      getScrollableNode: () => scroller.current,
      getState: () => ({ positionAtIndex: () => 0, positionByKey: () => 0 }),
    }))
    return (
      <div ref={scroller} className={className}>
        {data.map((item, index) => (
          <Fragment key={keyExtractor(item)}>{renderItem({ item, index })}</Fragment>
        ))}
      </div>
    )
  }),
}))

const key: FleetConversationKey = {
  connectionId: 'connection',
  workspaceId: 'remote-workspace',
  agentId: 'remote-agent',
}

let seq = 0
function event(type: ConversationEventType, payload: Record<string, unknown>): ConversationEvent {
  seq++
  return {
    id: `event-${seq}`,
    seq,
    sessionId: 'remote-session',
    workspaceId: key.workspaceId,
    agentId: key.agentId,
    providerId: 'claude-agent',
    modelId: 'opus',
    type,
    createdAt: seq * 1000,
    payload,
  }
}

const thread: FleetConversation = {
  workspaceId: key.workspaceId,
  agentId: key.agentId,
  title: 'Fix the flaky upload test',
  phase: 'waiting_for_approval',
  updatedAt: 5,
  createdAt: 1,
  providerId: 'claude-agent',
  modelId: 'opus',
  turnCount: 1,
  lastSeq: 9,
  sessionId: 'remote-session',
  capabilities: { images: true, approvals: true, questions: true, planMode: true, interrupt: true, checkpoints: true },
}

// Mounts the remote pane against a scripted Fleet API. The local
// conversation API is absent altogether: nothing in this view may reach it.
async function mountRemote({ access }: { access: 'read' | 'operate' }) {
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
  const receivers: Array<(frame: FleetConversationFrame) => void> = []
  const followed: FleetConversationKey[] = []
  const api = {
    platform: 'darwin',
    fleetConversationList: vi.fn(async () => ({ ok: true, conversations: [thread], access })),
    onFleetConversationSession: vi.fn(
      (input: { key: FleetConversationKey }, receive: (frame: FleetConversationFrame) => void) => {
        followed.push(input.key)
        receivers.push(receive)
        return () => undefined
      },
    ),
    fleetConversationSend: vi.fn(async () => ({ ok: true })),
    fleetConversationResolveApproval: vi.fn(async () => ({ ok: true })),
    fleetConversationInterrupt: vi.fn(async () => ({ ok: true })),
  }
  Object.assign(dom.window, {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    api,
  })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { default: RemoteConversationPanel } = await import('./RemoteConversationPanel')
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      createElement(RemoteConversationPanel, {
        workspaceId: 'local-workspace',
        connectionId: key.connectionId,
        machineName: 'mac-mini',
        remoteWorkspaceId: key.workspaceId,
        remoteAgentId: key.agentId,
      }),
    ),
  )
  const earlier = event('user_message', { turnId: 'earlier', text: 'Bump the timeout' })
  const events = [
    earlier,
    event('turn_started', { turnId: 'earlier' }),
    event('content_delta', { turnId: 'earlier', text: 'Raised it to ten seconds.' }),
    event('turn_completed', {
      turnId: 'earlier',
      checkpointTurnSeq: earlier.seq,
      checkpointAvailable: true,
      checkpointSummary: { files: 1, addedLines: 1, removedLines: 1 },
    }),
    event('user_message', { turnId: 'a', text: 'Why does the upload test flake?' }),
    event('turn_started', { turnId: 'a' }),
    event('content_delta', { turnId: 'a', text: 'Let me run it.' }),
    event('approval_requested', {
      turnId: 'a',
      requestId: 'approval-1',
      action: 'Bash',
      summary: 'npm test',
      input: { command: 'npm test' },
    }),
  ]
  const link: FleetConversationLink = { type: 'link', state: 'live', detail: 'Following on mac-mini.', access }
  await act(async () => {
    const receive = receivers.at(-1)!
    receive({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: null }, generation: 'g' })
    receive({ type: 'synchronized', seq: events.at(-1)!.seq!, generation: 'g' })
    receive(link)
  })
  const composer = () => host.querySelector('textarea')!
  return {
    host,
    act,
    api,
    followed,
    emit: (frame: FleetConversationFrame) => receivers.at(-1)!(frame),
    button: (label: string) =>
      Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.trim() === label),
    type: (value: string) => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(composer(), value)
      composer().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    },
    enter: () =>
      composer().dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      ),
    composer,
    async unmount() {
      await act(async () => root.unmount())
      dom.window.close()
      for (const name of Object.keys(globals)) {
        if (previous[name]) Object.defineProperty(globalThis, name, previous[name])
        else Reflect.deleteProperty(globalThis, name)
      }
    },
  }
}

test('a conversation on a paired machine renders in the chat view and is driven over the fleet', async () => {
  const chat = await mountRemote({ access: 'operate' })
  try {
    expect(chat.followed).toEqual([key])
    expect(chat.host.textContent).toContain('Why does the upload test flake?')
    expect(chat.host.textContent).toContain('Let me run it.')
    expect(chat.host.textContent).toContain('On mac-mini')
    expect(chat.host.textContent).toContain('Fix the flaky upload test')

    // An approval is answered over the fleet, and no rule that would outlive
    // the conversation is offered.
    expect(chat.host.textContent).not.toMatch(/always/i)
    await chat.act(async () => chat.button('Allow once')!.click())
    expect(chat.api.fleetConversationResolveApproval).toHaveBeenCalledWith({
      key,
      requestId: 'approval-1',
      decision: 'once',
    })

    // Neither the model nor the permission preset of a conversation over
    // there is this machine's to pick, and nothing offers to attach a file
    // from this disk.
    expect(chat.host.querySelector('[aria-label="Attach an image"]')).toBeNull()
    // A turn's changes can be read, but its files are on the other machine's
    // disk, so nothing offers to revert them.
    expect(chat.host.textContent).toContain('1 file changed')
    expect(chat.host.textContent).not.toContain('Revert to before this turn')
    expect(chat.host.textContent).not.toContain('Manual')
  } finally {
    await chat.unmount()
  }
})

test('a send goes to the machine that holds the conversation, with no session started here', async () => {
  const chat = await mountRemote({ access: 'operate' })
  try {
    // The turn is still waiting on its approval, so a send queues; answering
    // lets it through, as it would on the desktop itself.
    await chat.act(async () => chat.type('Try it with --runInBand'))
    await chat.act(async () => chat.enter())
    expect(chat.host.textContent).toContain('Queued')
    await chat.act(async () => chat.button('Deny')!.click())
    expect(chat.api.fleetConversationResolveApproval).toHaveBeenCalledWith({
      key,
      requestId: 'approval-1',
      decision: 'deny',
    })
    expect(chat.api.fleetConversationSend).not.toHaveBeenCalled()
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('approval_resolved', { requestId: 'approval-1', approved: false }) })
      chat.emit({ type: 'event', event: event('turn_completed', { turnId: 'a' }) })
    })
    expect(chat.api.fleetConversationSend).toHaveBeenCalledExactlyOnceWith({ key, message: 'Try it with --runInBand' })
    // No optimistic bubble: the machine's own `user_message` is the one shown.
    expect(chat.host.textContent?.match(/Try it with --runInBand/g) ?? []).toHaveLength(0)
    await chat.act(async () =>
      chat.emit({ type: 'event', event: event('user_message', { turnId: 'b', text: 'Try it with --runInBand' }) }),
    )
    expect(chat.host.textContent?.match(/Try it with --runInBand/g) ?? []).toHaveLength(1)
  } finally {
    await chat.unmount()
  }
})

test('a pairing that may only follow sees the conversation with every action closed', async () => {
  const chat = await mountRemote({ access: 'read' })
  try {
    expect(chat.host.textContent).toContain('Let me run it.')
    expect(chat.host.textContent).toContain('may follow this conversation on mac-mini but not drive it')
    expect(chat.composer().disabled).toBe(true)
    expect(chat.button('Deny')?.disabled).toBe(true)
    expect(chat.button('Allow once')?.disabled).toBe(true)
    expect(chat.host.querySelector('[aria-label="Stop responding"]')).toBeNull()
  } finally {
    await chat.unmount()
  }
})
