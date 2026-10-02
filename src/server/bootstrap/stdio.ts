import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

import { createMessageHub, type ServerControlChannel } from './control-channel'

// The control channel of a server started by a parent that holds its stdio: a
// WSL distribution's front door, an SSH session, a CI job. One JSON frame per
// line each way. The first line in is the envelope itself; stdout carries
// frames only, and everything said to a person goes to stderr.
//
// stdin ending is the parent gone (a closed SSH session, a killed front door),
// which is the one way such a server learns it is alone.

export function stdioChannel(input: Readable, output: Writable): ServerControlChannel {
  const hub = createMessageHub()
  const closeListeners = new Set<() => void>()
  let closed = false
  const lines = createInterface({ input, crlfDelay: Infinity })
  lines.on('line', (line) => {
    if (!line.trim()) return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      // A line that is not JSON is not a frame. Said where a person reads it.
      process.stderr.write('[studio-server] ignored a control line that is not JSON\n')
      return
    }
    hub.dispatch(message, [])
  })
  lines.on('close', () => {
    if (closed) return
    closed = true
    for (const listener of [...closeListeners]) listener()
  })
  // A parent that went away mid-write: the next write fails, and is the same news as stdin ending.
  output.on('error', () => undefined)
  return {
    carriesPorts: false,
    send(frame) {
      // stdin may end before stdout: the last progress and the exit still go out.
      if (output.destroyed || !output.writable) return
      output.write(`${JSON.stringify(frame)}\n`)
    },
    onMessage: (listener) => hub.add(listener),
    onClose(listener) {
      if (closed) {
        listener()
        return () => undefined
      }
      closeListeners.add(listener)
      return () => {
        closeListeners.delete(listener)
      }
    },
  }
}
