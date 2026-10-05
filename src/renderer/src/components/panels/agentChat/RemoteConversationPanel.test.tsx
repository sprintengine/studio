import { JSDOM } from 'jsdom'
import { forwardRef, Fragment, useImperativeHandle, useRef, type ReactNode } from 'react'
import { expect, test, vi } from 'vitest'
import type { ConversationEvent, ConversationEventType } from '../../../../../shared/conversation-runtime'
import type {
  MeshConversation,
  MeshConversationFrame,
  MeshConversationKey,
  MeshConversationLink,
} from '../../../../../shared/tailnet-mesh'

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

const key: MeshConversationKey = {
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

const thread: MeshConversation = {
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

// Mounts the remote pane against a scripted Mesh API. The local
// conversation API is absent altogether: nothing in this view may reach it.
async function mountRemote({
  access,
  permissionPreset,
  models,
  modelSwitch = false,
  permissionModes = false,
}: {
  access: 'read' | 'operate'
  permissionPreset?: MeshConversation['permissionPreset']
  models?: MeshConversation['models']
  modelSwitch?: boolean
  permissionModes?: boolean
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
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  const receivers: Array<(frame: MeshConversationFrame) => void> = []
  const followed: MeshConversationKey[] = []
  // The model the machine says the chat is on: what an accepted switch moves.
  let listedModel = thread.modelId
  const api = {
    platform: 'darwin',
    meshConversationList: vi.fn(async () => ({
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
      permissionModes,
    })),
    onMeshConversationSession: vi.fn(
      (input: { key: MeshConversationKey }, receive: (frame: MeshConversationFrame) => void) => {
        followed.push(input.key)
        receivers.push(receive)
        return () => undefined
      },
    ),
    // A turn's changed files are listed as soon as its card is drawn.
    meshConversationTurnDiff: vi.fn(async () => ({
      ok: true,
      diff: {
        files: [{ path: 'src/upload.ts', status: 'modified', addedLines: 1, removedLines: 1, binary: false }],
        submodulesExcluded: true,
      },
    })),
    meshConversationSend: vi.fn(async () => ({ ok: true })),
    meshConversationResolveApproval: vi.fn(async () => ({ ok: true })),
    meshConversationInterrupt: vi.fn(async () => ({ ok: true })),
    meshConversationSetPermissionPreset: vi.fn(async () => ({ ok: true })),
    meshConversationSetModel: vi.fn(async (input: { key: MeshConversationKey; modelId: string }) => {
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
  const { EditorView } = await import('@codemirror/view')
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
  const link: MeshConversationLink = { type: 'link', state: 'live', detail: 'Following on mac-mini.', access }
  await act(async () => {
    const receive = receivers.at(-1)!
    receive({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: null }, generation: 'g' })
    receive({ type: 'synchronized', seq: events.at(-1)!.seq!, generation: 'g' })
    receive(link)
  })
  // The composer is an editor: its editable element takes the keys, and the
  // draft is the editor's document.
  const composer = () => host.querySelector<HTMLElement>('.cm-content')!
  const editor = () => EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!
  return {
    host,
    document: dom.window.document,
    act,
    api,
    followed,
    emit: (frame: MeshConversationFrame) => receivers.at(-1)!(frame),
    button: (label: string) =>
      Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.trim() === label),
    type: (value: string) => {
      const view = editor()
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: { anchor: value.length },
        userEvent: 'input.type',
      })
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

test('a conversation on a paired machine renders in the chat view and is driven over the mesh', async () => {
  const chat = await mountRemote({ access: 'operate' })
  try {
    expect(chat.followed).toEqual([key])
    expect(chat.host.textContent).toContain('Why does the upload test flake?')
    expect(chat.host.textContent).toContain('Let me run it.')
    expect(chat.host.textContent).toContain('On mac-mini')
    expect(chat.host.textContent).toContain('Fix the flaky upload test')

    // An approval is answered over the mesh, and no rule that would outlive
    // the conversation is offered.
    expect(chat.host.textContent).not.toMatch(/always/i)
    await chat.act(async () => chat.button('Allow once')!.click())
    expect(chat.api.meshConversationResolveApproval).toHaveBeenCalledWith({
      key,
      requestId: 'approval-1',
      decision: 'once',
    })

    // Neither the model nor the permission preset of a conversation over
    // there is this machine's to pick, and nothing offers to attach a file
    // from this disk.
    // The "+" that would attach one (or skills) is not drawn at all.
    expect(chat.host.querySelector('[data-composer-options]')).toBeNull()
    expect(chat.host.querySelector('[aria-label="Attach an image"]')).toBeNull()
    // The strip under the composer marks the machine the chat runs on with its
    // glyph alone, named in its tooltip and accessible name; this computer has
    // no checkout of it, so no branch and no counts.
    const machine = chat.host.querySelector('[data-conversation-strip] [data-strip-machine]')
    expect(machine?.getAttribute('aria-label')).toBe('On mac-mini')
    expect(machine?.textContent).toBe('')
    expect(chat.host.querySelector('[data-conversation-strip] [data-strip-branch]')).toBeNull()
    expect(chat.host.querySelector('[data-conversation-strip] [data-diff-stat-pill]')).toBeNull()
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
    expect(chat.api.meshConversationResolveApproval).toHaveBeenCalledWith({
      key,
      requestId: 'approval-1',
      decision: 'deny',
    })
    expect(chat.api.meshConversationSend).not.toHaveBeenCalled()
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('approval_resolved', { requestId: 'approval-1', approved: false }) })
      chat.emit({ type: 'event', event: event('turn_completed', { turnId: 'a' }) })
    })
    expect(chat.api.meshConversationSend).toHaveBeenCalledExactlyOnceWith({ key, message: 'Try it with --runInBand' })
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
    expect(chat.composer().getAttribute('contenteditable')).toBe('false')
    expect(chat.button('Deny')?.disabled).toBe(true)
    expect(chat.button('Allow once')?.disabled).toBe(true)
    expect(chat.host.querySelector('[aria-label="Stop responding"]')).toBeNull()
  } finally {
    await chat.unmount()
  }
})

// The chat's permissions are on the engine picker's trailing row, as a
// launch's are: opened through the engine chip when the picker is not open.
const permissionsChip = async (chat: Awaited<ReturnType<typeof mountRemote>>) => {
  const find = () =>
    Array.from(chat.document.querySelectorAll('button')).find((item) =>
      item.getAttribute('aria-label')?.startsWith('Permissions:'),
    )
  if (!find()) await chat.act(async () => engineChip(chat.host)!.click())
  return find()
}

test('a chat on a machine that runs only two presets dims the other two, and a pick goes over the mesh', async () => {
  const chat = await mountRemote({ access: 'operate', permissionPreset: 'bypass' })
  try {
    // Bypass is a safeguard off: the engine chip says so while the picker
    // holding the permissions is closed.
    expect(engineChip(chat.host)?.getAttribute('aria-label')).toMatch(/— Permissions: Bypass permissions$/)
    expect(engineChip(chat.host)?.getAttribute('data-engine-warn')).toBe('true')
    // The permissions sit on the engine picker's trailing row.
    expect((await permissionsChip(chat))?.getAttribute('aria-label')).toBe('Permissions: Bypass permissions')
    const chip = await permissionsChip(chat)
    await chat.act(async () => chip!.click())
    const rows = Array.from(chat.document.querySelectorAll<HTMLButtonElement>('[data-preset-option="true"]'))
    expect(rows).toHaveLength(4)
    // An older machine reads Manual and Auto as No flag, so neither is offered
    // as if it would hold, and each says why. Strictest first, No flag last.
    expect(rows.map((row) => row.disabled)).toEqual([true, true, false, false])
    expect(rows[0]!.textContent).toContain('mac-mini needs a newer Studio for this.')
    await chat.act(async () => rows[3]!.click())
    expect(chat.api.meshConversationSetPermissionPreset).toHaveBeenCalledExactlyOnceWith({ key, preset: 'none' })
    expect((await permissionsChip(chat))?.getAttribute('aria-label')).toBe('Permissions: No flag')
  } finally {
    await chat.unmount()
  }
})

test('a chat on a machine that runs all four presets offers them, and Auto goes over the mesh', async () => {
  const chat = await mountRemote({ access: 'operate', permissionPreset: 'none', permissionModes: true })
  try {
    const chip = await permissionsChip(chat)
    await chat.act(async () => chip!.click())
    const rows = Array.from(chat.document.querySelectorAll<HTMLButtonElement>('[data-preset-option="true"]'))
    expect(rows.map((row) => row.disabled)).toEqual([false, false, false, false])
    await chat.act(async () => rows[1]!.click())
    expect(chat.api.meshConversationSetPermissionPreset).toHaveBeenCalledExactlyOnceWith({ key, preset: 'auto' })
    expect((await permissionsChip(chat))?.getAttribute('aria-label')).toBe('Permissions: Auto')
  } finally {
    await chat.unmount()
  }
})

test("a permission card's Allow and switch allows that request first, then moves the chat over the mesh", async () => {
  const chat = await mountRemote({ access: 'operate', permissionPreset: 'none', permissionModes: true })
  try {
    const order: string[] = []
    chat.api.meshConversationResolveApproval.mockImplementation(async () => {
      order.push('allow')
      return { ok: true }
    })
    chat.api.meshConversationSetPermissionPreset.mockImplementation(async () => {
      order.push('switch')
      return { ok: true }
    })
    const menu = Array.from(chat.host.querySelectorAll('button')).find(
      (item) => item.getAttribute('aria-label') === 'More ways to allow',
    )
    expect(menu).toBeDefined()
    await chat.act(async () => menu!.click())
    const row = (label: string) =>
      Array.from(chat.document.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)
    // Looser than No flag, and runnable there: Auto and Bypass.
    expect(row('Allow and switch to Auto')).toBeDefined()
    await chat.act(async () => row('Allow and switch to Bypass permissions')!.click())
    expect(chat.api.meshConversationResolveApproval).toHaveBeenCalledExactlyOnceWith({
      key,
      requestId: 'approval-1',
      decision: 'once',
    })
    expect(chat.api.meshConversationSetPermissionPreset).toHaveBeenCalledExactlyOnceWith({ key, preset: 'bypass' })
    expect(order).toEqual(['allow', 'switch'])
    expect((await permissionsChip(chat))?.getAttribute('aria-label')).toBe('Permissions: Bypass permissions')
  } finally {
    await chat.unmount()
  }
})

test('a refused allow leaves the chat on the mode it was on', async () => {
  const chat = await mountRemote({ access: 'operate', permissionPreset: 'none', permissionModes: true })
  try {
    chat.api.meshConversationResolveApproval.mockImplementation(async () => ({
      ok: false,
      code: 'invalid',
      message: 'This request has already been answered.',
    }))
    const menu = Array.from(chat.host.querySelectorAll('button')).find(
      (item) => item.getAttribute('aria-label') === 'More ways to allow',
    )
    await chat.act(async () => menu!.click())
    const row = Array.from(chat.document.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Allow and switch to Auto',
    )
    await chat.act(async () => row!.click())
    expect(chat.api.meshConversationSetPermissionPreset).not.toHaveBeenCalled()
    expect(chat.host.textContent).toContain('This request has already been answered.')
    expect((await permissionsChip(chat))?.getAttribute('aria-label')).toBe('Permissions: No flag')
  } finally {
    await chat.unmount()
  }
})

// The catalog the machine lists for the chat's CLI. This machine's own catalog
// for that CLI is empty here, so every model row the picker shows is the
// machine's.
const remoteModels: NonNullable<MeshConversation['models']> = {
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

test("a chat on a machine that offers model switching lists that machine's models, and a pick goes over the mesh", async () => {
  const chat = await mountRemote({ access: 'operate', models: remoteModels, modelSwitch: true })
  try {
    expect(engineChip(chat.host)?.textContent).toContain('Opus')
    await chat.act(async () => engineChip(chat.host)!.click())
    const rows = () => Array.from(chat.document.querySelectorAll<HTMLElement>('[data-model-row="true"]'))
    expect(rows().some((row) => row.textContent?.includes('Sonnet'))).toBe(true)
    const listReads = chat.api.meshConversationList.mock.calls.length
    await chat.act(async () =>
      rows()
        .find((row) => row.textContent?.includes('Sonnet'))!
        .click(),
    )
    expect(chat.api.meshConversationSetModel).toHaveBeenCalledExactlyOnceWith({ key, modelId: 'sonnet' })
    // The chip names the model the machine accepted, the machine is asked
    // again, and its word that the switch waits for the next turn is shown.
    expect(engineChip(chat.host)?.textContent).toContain('Sonnet')
    expect(chat.api.meshConversationList.mock.calls.length).toBeGreaterThan(listReads)
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
    expect(chat.api.meshConversationSetModel).not.toHaveBeenCalled()
  } finally {
    await chat.unmount()
  }
})

test('a link that drops does not list the machine; one that comes back live does', async () => {
  const chat = await mountRemote({ access: 'operate' })
  try {
    const reads = () => chat.api.meshConversationList.mock.calls.length
    const before = reads()
    await chat.act(async () =>
      chat.emit({ type: 'link', state: 'reconnecting', detail: 'Reconnecting to mac-mini.', access: 'operate' }),
    )
    await chat.act(async () =>
      chat.emit({ type: 'link', state: 'offline', detail: 'mac-mini is not answering.', access: 'operate' }),
    )
    expect(reads()).toBe(before)
    await chat.act(async () =>
      chat.emit({ type: 'link', state: 'live', detail: 'Following on mac-mini.', access: 'operate' }),
    )
    expect(reads()).toBe(before + 1)
  } finally {
    await chat.unmount()
  }
})
