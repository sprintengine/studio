import { createMessageHub, type ServerControlChannel } from './control-channel'

// The control channel of a server the desktop forked with `utilityProcess`:
// Electron's `process.parentPort`. Messages are structured clones, so a
// window's port can be transferred beside the frame that attaches it, and a
// sealed secret crosses as bytes rather than as text.
//
// The parent port has no close event: a utility process dies with its parent
// (measured, phase 6 spec E3), so there is never a server left to notice.

/** The slice of Electron's `ParentPort` this reads, so a test can hand in its own. */
export type ParentPortLike = {
  on(event: 'message', listener: (event: { data: unknown; ports?: readonly unknown[] }) => void): unknown
  postMessage(message: unknown): void
}

/** `process.parentPort` when this process is a utility process, else null. Read without naming Electron's types. */
export function utilityParentPort(): ParentPortLike | null {
  const port = (process as unknown as { parentPort?: ParentPortLike }).parentPort
  return port && typeof port.postMessage === 'function' ? port : null
}

export function parentPortChannel(port: ParentPortLike): ServerControlChannel {
  const hub = createMessageHub()
  port.on('message', (event) => hub.dispatch(event.data, event.ports ?? []))
  return {
    carriesPorts: true,
    send(frame) {
      port.postMessage(frame)
    },
    onMessage: (listener) => hub.add(listener),
    onClose: () => () => undefined,
  }
}
