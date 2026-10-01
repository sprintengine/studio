import type { StudioAuth } from './protocol.js'

// How a client reaches a Studio: anything that carries whole frames both ways.
//
// The client is transport-agnostic. Node's owner socket (`./node`) is one
// transport; a WebSocket, a pipe through `ssh`, or a test double are others.
// A transport delivers one frame per `onMessage` call and sends one per
// `send`; framing on the wire (one JSON line per frame on the socket) is the
// transport's own business.

export type StudioTransport = {
  /**
   * The credential this one connection says hello with, when the transport
   * brings its own: a ticket minted for it alone, say, which is spent by that
   * hello. It takes the place of `ConnectOptions.auth` for this connection.
   */
  credential?: StudioAuth
  /** Send one frame, already encoded as JSON. */
  send(frame: string): void
  /** Close the connection. `onClose` still fires. */
  close(): void
  onMessage(listener: (frame: string) => void): void
  /** Fires once, when the connection is gone for any reason. */
  onClose(listener: (error?: Error) => void): void
  /**
   * Stop reading for a while, so a Studio sees the backpressure of a consumer
   * that is not keeping up. Optional: a transport without it reads on, and
   * frames wait in the client instead.
   */
  pause?(): void
  resume?(): void
}

/** Opens a fresh connection. Called again for every reconnect, so it may re-discover where Studio is. */
export type StudioTransportFactory = () => Promise<StudioTransport>
