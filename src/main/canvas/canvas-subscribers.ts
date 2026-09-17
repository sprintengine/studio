// Which windows are watching which board, as the service needs it: a number.
//
// The service pushes scenes to "subscribers", and a subscriber is a WebContents
// — but the service is deliberately electron-free, so it holds ids and this
// holds the objects. The seam is also what makes the lifetime rule simple:
// a window that goes away is dropped here once, and every board it held stops
// pushing to it, rather than each board carrying a dead reference.

import type { WebContents } from 'electron'

export type CanvasSubscriberRegistry = {
  /** Adopt a sender and return its id. Idempotent for the same WebContents. */
  add(contents: WebContents): number
  /** Push to one subscriber; a no-op once it is gone. */
  sendTo(subscriberId: number, channel: string, payload: unknown): void
  /** Called with the id when a subscribed window is destroyed. */
  onGone(listener: (subscriberId: number) => void): () => void
  dispose(): void
}

export function createCanvasSubscriberRegistry(): CanvasSubscriberRegistry {
  const contentsById = new Map<number, WebContents>()
  const listeners = new Set<(subscriberId: number) => void>()

  return {
    add(contents: WebContents): number {
      const id = contents.id
      if (contentsById.has(id)) return id
      contentsById.set(id, contents)
      // `destroyed` rather than a per-board unsubscribe: a window that is
      // closed, reloaded or crashed never gets to say goodbye, and a board
      // pushing at it forever is the leak this exists to prevent.
      contents.once('destroyed', () => {
        contentsById.delete(id)
        for (const listener of [...listeners]) listener(id)
      })
      return id
    },

    sendTo(subscriberId: number, channel: string, payload: unknown): void {
      const contents = contentsById.get(subscriberId)
      if (!contents || contents.isDestroyed()) return
      contents.send(channel, payload)
    },

    onGone(listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    dispose(): void {
      contentsById.clear()
      listeners.clear()
    },
  }
}
