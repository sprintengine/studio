import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  ConversationEvent,
  ConversationSessionFrame,
  ConversationSubscribeInput,
} from '../../../../../shared/conversation-runtime'
import { installStudioLoopback, type StudioLoopback } from '../../../../../../tests/studio-chat-loopback'

// The chat view on the Studio protocol, end to end inside one process: the
// window's client and transport, a port, the RPC, and main's chat backend over
// a scripted conversation IPC. What a person would notice — a reply that
// repeats or skips text after the connection drops mid-turn, a picture that
// arrives cut, a socket's own words in an error — is what these look for.

beforeEach(() => {
  vi.stubEnv('STUDIO_CHAT_TRANSPORT_UNDER_TEST', 'studio')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

const until = async (check: () => boolean, what: string) => {
  for (let tries = 0; !check() && tries < 400; tries++) await new Promise((resolve) => setTimeout(resolve, 5))
  if (!check()) throw new Error(`Timed out waiting for ${what}`)
}

function event(seq: number, type: ConversationEvent['type'], payload: Record<string, unknown>): ConversationEvent {
  return {
    id: `event-${seq}`,
    seq,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock',
    modelId: 'mock',
    createdAt: seq,
    type,
    payload,
  }
}

async function setup(api: Record<string, unknown>) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.assign(dom.window, { api })
  const loopback = installStudioLoopback(dom.window as unknown as { api: Record<string, unknown> }) as StudioLoopback
  const restore = () => {
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
  return { dom, loopback, restore }
}

test('a reply streaming when the connection drops resumes from its cursor, with nothing repeated and nothing lost', async () => {
  const subscriptions: { input: ConversationSubscribeInput; receive: (frame: ConversationSessionFrame) => void }[] = []
  const { loopback, restore } = await setup({
    onConversationSession: (input: ConversationSubscribeInput, receive: (frame: ConversationSessionFrame) => void) => {
      subscriptions.push({ input, receive })
      return () => undefined
    },
  })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useConversationSession } = await import('./useConversationSession')
  let hook!: ReturnType<typeof useConversationSession>
  function Harness() {
    hook = useConversationSession('/Users/dev/project', 'workspace', 'agent')
    return null
  }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(createElement(Harness)))
    await until(() => subscriptions.length === 1, 'the first subscription')
    // The view names its conversation by its folder, as its IPC does.
    expect(subscriptions[0].input.key).toEqual({
      workspaceRoot: '/Users/dev/project',
      workspaceId: 'workspace',
      agentId: 'agent',
    })
    const first = subscriptions[0].receive
    await act(async () => {
      first({
        type: 'snapshot',
        page: { events: [event(1, 'user_message', { text: 'hi' })], hasMore: false, beforeCursor: null },
        generation: 'log-1',
      })
      first({ type: 'synchronized', seq: 1, generation: 'log-1' })
    })
    await until(() => hook.hydrated, 'the transcript')
    await act(async () => {
      first({ type: 'event', event: event(2, 'turn_started', {}) })
      first({ type: 'event', event: event(3, 'content_delta', { text: 'Hel' }) })
      first({ type: 'event', event: event(4, 'content_delta', { text: 'lo' }) })
    })
    await until(() => hook.events.length === 4, 'the streamed text')
    const opened = loopback.connections()
    // The connection goes mid-turn; the window's client reconnects by itself
    // and follows again from the last sequence it holds.
    loopback.drop()
    await until(() => subscriptions.length === 2, 'the resumed subscription')
    expect(loopback.connections()).toBe(opened + 1)
    expect(subscriptions[1].input).toMatchObject({ afterSeq: 4, generation: 'log-1' })
    const second = subscriptions[1].receive
    await act(async () => {
      // A catch-up that starts at the last event the view already has.
      second({ type: 'event', event: event(4, 'content_delta', { text: 'lo' }) })
      second({ type: 'event', event: event(5, 'content_delta', { text: ' world' }) })
      second({ type: 'synchronized', seq: 5, generation: 'log-1' })
      second({ type: 'event', event: event(6, 'content_delta', { text: '!' }) })
    })
    await until(() => hook.events.length === 6, 'the rest of the reply')
    expect(hook.events.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6])
    const text = hook.events
      .filter((entry) => entry.type === 'content_delta')
      .map((entry) => String(entry.payload?.text ?? ''))
      .join('')
    expect(text).toBe('Hello world!')
    expect(hook.error).toBeNull()
  } finally {
    await act(async () => root.unmount())
    restore()
  }
})

test('a picture goes up in pieces and reaches the runtime whole; the socket’s own words never reach the chat', async () => {
  const sends: Array<Record<string, unknown>> = []
  const { loopback, restore } = await setup({
    conversationSessionSendTurn: async (input: Record<string, unknown>) => {
      sends.push(input)
      return { ok: true, session: { sessionId: 'session', workspaceId: 'workspace', agentId: 'agent' } }
    },
  })
  try {
    const { useConversationTransport } = await import('./conversationTransport')
    const { createElement } = await import('react')
    const { renderToString } = await import('react-dom/server')
    let transport!: ReturnType<typeof useConversationTransport>
    renderToString(
      createElement(() => {
        transport = useConversationTransport()
        return null
      }),
    )
    // Three pieces' worth of a picture, of a length that is not a multiple of a piece.
    const bytes = Buffer.from(Array.from({ length: 1_400_001 }, (_, index) => (index * 7) % 256))
    const dataBase64 = bytes.toString('base64')
    const sent = await transport.send({
      sessionId: 'session',
      message: 'look',
      attachments: [
        { id: 'one', mediaType: 'image/png', dataBase64, byteLength: bytes.length, name: 'one.png' },
        { id: 'two', mediaType: 'image/jpeg', dataBase64: 'iVBORw0KGgo=', byteLength: 8 },
      ],
    })
    expect(sent.ok).toBe(true)
    expect(sends).toHaveLength(1)
    const carried = sends[0].attachments as Array<Record<string, unknown>>
    expect(carried.map(({ id, mediaType, name, byteLength }) => ({ id, mediaType, name, byteLength }))).toEqual([
      { id: 'one', mediaType: 'image/png', name: 'one.png', byteLength: bytes.length },
      { id: 'two', mediaType: 'image/jpeg', name: undefined, byteLength: 8 },
    ])
    expect(carried[0].dataBase64).toBe(dataBase64)
    expect(sends[0]).not.toHaveProperty('commandId')

    // A reconnect Studio refuses ends the client; the call in flight is told
    // in one plain sentence, not in the socket's words.
    const api = window.api as unknown as Record<string, () => Promise<{ connectionId: string; ticket: string }>>
    const connect = api.studioConnect
    api.studioConnect = async () => ({ ...(await connect()), ticket: 'seport_not_the_ticket_000000' })
    loopback.drop()
    const refused = await transport.services.providers.list({})
    expect(refused).toEqual({
      ok: false,
      message: 'This window lost its connection to Studio. It reconnects by itself; try again in a moment.',
    })
  } finally {
    restore()
  }
})
