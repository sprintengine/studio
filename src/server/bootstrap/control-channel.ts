import { parseServerBootstrapEnvelope, type ServerBootstrapEnvelope } from './envelope'

// The server's end of the channel to whoever started it. Two carriers make
// one: a utility process's parent port on the desktop (parent-port.ts), and
// stdin and stdout for a server started on WSL, over SSH or by CI (stdio.ts).
// The server is written against this shape and does not know which it has.

export type ServerControlChannel = {
  /** Send one frame to the supervisor. Dropped once the channel has closed. */
  send(frame: unknown): void
  /**
   * Every message from the supervisor, with the ports transferred beside it
   * (a window's, the shell's session). A carrier that cannot transfer ports
   * hands an empty list.
   */
  onMessage(listener: (message: unknown, ports: readonly unknown[]) => void): () => void
  /** The supervisor is gone: stdin ended. A parent port never says so; the process dies with its parent. */
  onClose(listener: () => void): () => void
  /** Whether ports can travel on this channel (a parent port), so windows can be attached. */
  readonly carriesPorts: boolean
}

export type ServerBootstrap = { envelope: ServerBootstrapEnvelope; channel: ServerControlChannel }

type MessageListener = (message: unknown, ports: readonly unknown[]) => void

/**
 * The listeners of one carrier. A message that arrives while nobody listens
 * (between the envelope and the serve loop taking over, say) is kept and
 * handed to the next listener, so a `shutdown` sent during boot is never lost.
 */
export function createMessageHub(): {
  dispatch(message: unknown, ports: readonly unknown[]): void
  add(listener: MessageListener): () => void
} {
  const listeners = new Set<MessageListener>()
  const held: Array<[unknown, readonly unknown[]]> = []
  let flushing = false
  // Held messages go out on a later turn, one at a time, in order: a listener
  // that stops listening on the first (the envelope's reader) leaves the rest
  // for whoever listens next, and is never called back before `add` returns.
  const flush = (): void => {
    if (flushing) return
    flushing = true
    queueMicrotask(() => {
      flushing = false
      while (held.length > 0 && listeners.size > 0) {
        const [message, ports] = held.shift()!
        for (const listener of [...listeners]) listener(message, ports)
      }
    })
  }
  return {
    dispatch(message, ports) {
      if (listeners.size === 0 || held.length > 0) {
        held.push([message, ports])
        if (listeners.size > 0) flush()
        return
      }
      for (const listener of [...listeners]) listener(message, ports)
    },
    add(listener) {
      listeners.add(listener)
      if (held.length > 0) flush()
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** Why a bootstrap did not produce an envelope: the server exits 64 and says this. */
export class ServerBootstrapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServerBootstrapError'
  }
}

/** How long a server waits for its envelope before it gives up. */
export const ENVELOPE_WAIT_MS = 15_000

/**
 * Wait for the envelope: the first message, which a carrier hands over either
 * bare (stdio's first line) or as `{ t: 'envelope', envelope }` (a parent
 * port, where it shares the channel with every later frame).
 */
export function readEnvelope(
  channel: ServerControlChannel,
  options: { timeoutMs?: number; unwrap: boolean },
): Promise<ServerBootstrap> {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (outcome: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      stopMessages()
      stopClose()
      outcome()
    }
    const timer = setTimeout(
      () => finish(() => reject(new ServerBootstrapError('No bootstrap envelope arrived.'))),
      options.timeoutMs ?? ENVELOPE_WAIT_MS,
    )
    const stopMessages = channel.onMessage((message) => {
      const candidate = options.unwrap ? unwrapEnvelope(message) : message
      const parsed = parseServerBootstrapEnvelope(candidate)
      finish(() =>
        parsed.ok ? resolve({ envelope: parsed.envelope, channel }) : reject(new ServerBootstrapError(parsed.message)),
      )
    })
    const stopClose = channel.onClose(() =>
      finish(() => reject(new ServerBootstrapError('The control channel closed before the envelope arrived.'))),
    )
  })
}

function unwrapEnvelope(message: unknown): unknown {
  if (typeof message !== 'object' || message === null) return message
  const frame = message as { t?: unknown; envelope?: unknown }
  return frame.t === 'envelope' ? frame.envelope : message
}
