import { mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

import { createServerLog, type ServerLog } from '../../main/server-supervisor/server-log'
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

/**
 * Everything this server says to a person, kept in `log` as well as said on
 * stderr. A server whose parent holds its stdio (a WSL distribution's, whose
 * starter keeps only a tail to say why a start failed) would otherwise leave
 * no record of a refused connection or a chat's failure anywhere. Its stdout
 * is frames only, so stderr is all of it, and goes in as plain lines.
 */
export function keepStderrIn(log: Pick<ServerLog, 'write'>, stderr: Writable = process.stderr): void {
  const write = stderr.write.bind(stderr) as (...args: unknown[]) => boolean
  stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    try {
      if (typeof chunk === 'string') log.write('out', chunk)
      else if (chunk instanceof Uint8Array) log.write('out', Buffer.from(chunk))
    } catch {
      // A log that cannot be written never costs the line on stderr.
    }
    return write(chunk, ...rest)
  }) as Writable['write']
}

/**
 * `keepStderrIn` a log in `logsDir`, made owner-only. A directory that cannot
 * be made (a home another user owns part of, a full disk) costs the log and
 * nothing else: the server starts all the same, and says so on stderr.
 */
export function keepStderrInLogsDir(logsDir: string, stderr: Writable = process.stderr): void {
  try {
    mkdirSync(logsDir, { recursive: true, mode: 0o700 })
  } catch (error) {
    stderr.write(
      `[studio-server] keeps no log: ${logsDir} could not be made (${error instanceof Error ? error.message : String(error)})\n`,
    )
    return
  }
  keepStderrIn(createServerLog({ logsDir }), stderr)
}
