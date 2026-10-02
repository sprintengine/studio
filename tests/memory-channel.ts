import type { StudioFramePort } from '../src/server/rpc/studio-frame-port'

// A message channel in memory, for the suites that put a Studio connection on
// a port: what one end posts, the other hears a moment later, and closing
// either end tells both, as an Electron channel does. What was posted before
// the close is still delivered, ahead of the close, as a real channel's
// messages are: a `bye` written just before a connection ends is read.

export type MemoryChannelEnd = StudioFramePort & { readonly closed: boolean }

export function createMemoryChannel(): [MemoryChannelEnd, MemoryChannelEnd] {
  type State = { frames: Array<(frame: string) => void>; closes: Array<() => void> }
  const states: [State, State] = [
    { frames: [], closes: [] },
    { frames: [], closes: [] },
  ]
  let closed = false
  const shut = () => {
    if (closed) return
    closed = true
    for (const state of states) {
      const listeners = state.closes.splice(0)
      queueMicrotask(() => {
        for (const listener of listeners) listener()
      })
    }
  }
  const end = (mine: State, theirs: State): MemoryChannelEnd => ({
    get closed() {
      return closed
    },
    post: (frame) => {
      if (closed) return
      queueMicrotask(() => {
        for (const listener of theirs.frames) listener(frame)
      })
    },
    onFrame: (listener) => void mine.frames.push(listener),
    onClose: (listener) => {
      if (closed) queueMicrotask(listener)
      else mine.closes.push(listener)
    },
    close: shut,
  })
  return [end(states[0], states[1]), end(states[1], states[0])]
}
