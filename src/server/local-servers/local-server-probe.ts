import { connect } from 'node:net'

import { isLoopbackHost } from './local-server-record'

// Is something accepting connections on a linked server's port? A TCP connect
// and nothing more: no HTTP request, so a dev server's request log does not
// fill with a line every few seconds, and a server that answers every path
// with an error still reads as running (it is; what it serves is its business).
//
// A loopback host is tried at 127.0.0.1 and then at ::1, because a dev server
// that resolved `localhost` to the IPv6 loopback listens there alone, and one
// that bound 127.0.0.1 is not reachable at ::1. Any other host (a LAN or
// tailnet address an agent linked) is connected to by name.

/** How long one connect may take before the port reads as closed. */
export const PROBE_TIMEOUT_MS = 1_000

/** Whether something accepts a connection at `host:port`. Never rejects. */
export type LocalServerProbe = (host: string, port: number) => Promise<boolean>

export function createTcpProbe(options: { timeoutMs?: number } = {}): LocalServerProbe {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  return async (host, port) => {
    if (isLoopbackHost(host)) {
      if (await tryConnect('127.0.0.1', port, timeoutMs)) return true
      return tryConnect('::1', port, timeoutMs)
    }
    return tryConnect(host.replace(/^\[(.*)\]$/u, '$1'), port, timeoutMs)
  }
}

function tryConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const socket = connect({ host, port })
    const finish = (open: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      // A swallowed late error: the socket is being torn down either way.
      socket.on('error', () => undefined)
      socket.destroy()
      resolve(open)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}
