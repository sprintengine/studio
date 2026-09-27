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
async function mountRemote({
  access,
  permissionPreset,
  models,
  modelSwitch = false,
}: {
  access: 'read' | 'operate'
  permissionPreset?: FleetConversation['permissionPreset']
  models?: FleetConversation['models']
  modelSwitch?: boolean
}) {
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
  // The model the machine says the chat is on: what an accepted switch moves.
  let listedModel = thread.modelId
  const api = {
    platform: 'darwin',
    fleetConversationList: vi.fn(async () => ({
      ok: true,
      conversations: [
        {
          ...thread,
          modelId: listedModel,
          ...(permissionPreset ? { permissionPreset } : {}),
          ...(models ? { models } : {}),
        },
      ],
      access,
      modelSwitch,
    })),
    onFleetConversationSession: vi.fn(
      (input: { key: FleetConversationKey }, receive: (frame: FleetConversationFrame) => void) => {
        followed.push(input.key)
        receivers.push(receive)
        return () => undefined
      },
    ),
    // A turn's changed files are listed as soon as its card is drawn.
    fleetConversationTurnDiff: vi.fn(async () => ({
      ok: true,
      diff: {
        files: [{ path: 'src/upload.ts', status: 'modified', addedLines: 1, removedLines: 1, binary: false }],
        submodulesExcluded: true,
      },
    })),
    fleetConversationSend: vi.fn(async () => ({ ok: true })),
    fleetConversationResolveApproval: vi.fn(async () => ({ ok: true })),
    fleetConversationInterrupt: vi.fn(async () => ({ ok: true })),
    fleetConversationSetPermissionPreset: vi.fn(async () => ({ ok: true })),
    fleetConversationSetModel: vi.fn(async (input: { key: FleetConversationKey; modelId: string }) => {
      listedModel = input.modelId
      return { ok: true, notice: 'The new model starts with your next message.' }
    }),
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
    document: dom.window.document,
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
    // Its tree is listed, but the diff window and the editor open this disk's files.
    expect(chat.host.querySelector('[aria-label^="src/upload.ts, modified"]')).not.toBeNull()
    expect(chat.host.querySelector('[aria-label="Open diff"]')).toBeNull()
    expect(chat.host.querySelector('[aria-label="Open src/upload.ts"]')).toBeNull()
    // A machine whose list does not name the preset in force gets no switcher:
    // a picker showing a guess would be worse than none.
    expect(chat.host.textContent).not.toContain('Bypass permissions')
    expect(chat.host.textContent).not.toContain('CLI default')
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

test('a chat whose machine names its preset offers the same two presets on its engine picker, and a pick goes over the fleet', async () => {
  const chat = await mountRemote({ access: 'operate', permissionPreset: 'bypass' })
  try {
    // One control for engine, effort and permissions: the chip opens the
    // terminal agent's picker, whose trailing row holds the preset.
    const chip = () =>
      Array.from(chat.host.querySelectorAll('button')).find((item) =>
        item.getAttribute('aria-label')?.startsWith('Engine:'),
      )
    const permissions = () =>
      Array.from(chat.document.querySelectorAll('button')).find((item) =>
        item.getAttribute('aria-label')?.startsWith('Permissions:'),
      )
    expect(chip()).toBeDefined()
    await chat.act(async () => chip()!.click())
    expect(permissions()?.getAttribute('aria-label')).toBe('Permissions: Bypass permissions')
    await chat.act(async () => permissions()!.click())
    const rows = Array.from(chat.document.querySelectorAll<HTMLButtonElement>('[data-preset-option="true"]'))
    expect(
      rows.map((row) => row.textContent?.startsWith('Bypass permissions') || row.textContent?.startsWith('No flag')),
    ).toEqual([true, true])
    expect(rows.some((row) => row.disabled)).toBe(false)
    await chat.act(async () => rows[1]!.click())
    expect(chat.api.fleetConversationSetPermissionPreset).toHaveBeenCalledExactlyOnceWith({ key, preset: 'none' })
    await chat.act(async () => chip()!.click())
    expect(permissions()?.getAttribute('aria-label')).toBe('Permissions: No flag')
  } finally {
    await chat.unmount()
  }
})

// The catalog the machine lists for the chat's CLI. This machine's own catalog
// for that CLI is empty here, so every model row the picker shows is the
// machine's.
const remoteModels: NonNullable<FleetConversation['models']> = {
  cli: 'claude-code',
  cliLabel: 'Claude Code',
  liveModelSwitch: true,
  options: [
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
  ],
}

const engineChip = (host: HTMLElement) =>
  Array.from(host.querySelectorAll('button')).find((item) => item.getAttribute('aria-label')?.startsWith('Engine:'))

test("a chat on a machine that offers model switching lists that machine's models, and a pick goes over the fleet", async () => {
  const chat = await mountRemote({ access: 'operate', models: remoteModels, modelSwitch: true })
  try {
    expect(engineChip(chat.host)?.textContent).toContain('Opus')
    await chat.act(async () => engineChip(chat.host)!.click())
    const rows = () => Array.from(chat.document.querySelectorAll<HTMLElement>('[data-model-row="true"]'))
    expect(rows().some((row) => row.textContent?.includes('Sonnet'))).toBe(true)
    const listReads = chat.api.fleetConversationList.mock.calls.length
    await chat.act(async () =>
      rows()
        .find((row) => row.textContent?.includes('Sonnet'))!
        .click(),
    )
    expect(chat.api.fleetConversationSetModel).toHaveBeenCalledExactlyOnceWith({ key, modelId: 'sonnet' })
    // The chip names the model the machine accepted, the machine is asked
    // again, and its word that the switch waits for the next turn is shown.
    expect(engineChip(chat.host)?.textContent).toContain('Sonnet')
    expect(chat.api.fleetConversationList.mock.calls.length).toBeGreaterThan(listReads)
    expect(chat.host.textContent).toContain('The new model starts with your next message.')
  } finally {
    await chat.unmount()
  }
})

test('a machine that does not offer model switching keeps the chat on its model, whatever its list carries', async () => {
  const chat = await mountRemote({ access: 'operate', models: remoteModels, modelSwitch: false })
  try {
    await chat.act(async () => engineChip(chat.host)!.click())
    const rows = Array.from(chat.document.querySelectorAll<HTMLElement>('[data-model-row="true"]'))
    expect(rows.some((row) => row.textContent?.includes('Sonnet'))).toBe(false)
    expect(chat.api.fleetConversationSetModel).not.toHaveBeenCalled()
  } finally {
    await chat.unmount()
  }
})
