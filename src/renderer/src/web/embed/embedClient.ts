import { connect, type StudioClient, type StudioTransport } from '../../../../../packages/agent-sdk/src/index'

// The embed page's Studio connection (phase 9 spec, 5.4). The page holds the
// embed's token, never a session: before each connection it trades the token
// for a single-use ticket, and opens `/ws` with the ticket in the address,
// where the server spends it at the upgrade. A reconnect asks for a fresh one.

/** What the server answered for the token: the ticket, and the conversation the embed shows. */
type EmbedSession = { ticket: string; conversation: { workspaceId: string; agentId: string } }

export class EmbedUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmbedUnavailable'
  }
}

async function exchange(embedId: string, token: string): Promise<EmbedSession> {
  const response = await fetch(new URL('../../embed/session', window.location.href), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embedId, token }),
    credentials: 'omit',
    cache: 'no-store',
  })
  const body = (await response.json().catch(() => ({}))) as Partial<EmbedSession> & { message?: string }
  if (!response.ok || typeof body.ticket !== 'string' || !body.conversation)
    throw new EmbedUnavailable(body.message ?? 'This conversation is no longer shared.')
  return { ticket: body.ticket, conversation: body.conversation }
}

function socketTransport(url: string): Promise<StudioTransport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const messages: Array<(frame: string) => void> = []
    const closes: Array<(error?: Error) => void> = []
    socket.addEventListener('error', () => reject(new Error('Studio could not be reached.')), { once: true })
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') for (const listener of messages) listener(event.data)
    })
    socket.addEventListener('close', () => {
      for (const listener of closes.splice(0)) listener()
    })
    socket.addEventListener(
      'open',
      () =>
        resolve({
          // The ticket was spent by the upgrade; the hello's credential is a placeholder.
          credential: { token: 'embed-ticket-spent' },
          send: (frame) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(frame)
          },
          close: () => socket.close(),
          onMessage: (listener) => void messages.push(listener),
          onClose: (listener) => void closes.push(listener),
        }),
      { once: true },
    )
  })
}

/** Connect for one embed. Resolves with the client and the conversation it may follow. */
export async function connectEmbed(
  embedId: string,
  token: string,
): Promise<{ client: StudioClient; conversation: EmbedSession['conversation'] }> {
  const first = await exchange(embedId, token)
  let pending: string | null = first.ticket
  const client = await connect({
    client: { name: 'Embedded conversation' },
    transport: async () => {
      const ticket = pending ?? (await exchange(embedId, token)).ticket
      pending = null
      const url = new URL('../../ws', window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('ticket', ticket)
      return socketTransport(url.toString())
    },
    reconnect: { initialDelayMs: 500, maxDelayMs: 15_000 },
  })
  return { client, conversation: first.conversation }
}
