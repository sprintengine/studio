import { PassThrough, type Readable, type Writable } from 'node:stream'

import { MuxEndpoint } from '../../../../resources/wsl-server/relay-mux.mjs'

// The desktop's end of an SSH machine's relay (phase 8 spec, 5.4): wait for
// the relay's ready line on the session's stdout, skipping whatever a login
// profile printed before it, then speak the multiplexer on the rest.

export const RELAY_MARKER = '@@SPRINTENGINE_RELAY'

/** What the relay said about the server it found, from that server's record. */
export type RelayReady = {
  mux: number
  pid: number
  server: {
    pid: number | null
    version: string | null
    origin: string | null
    backendWire: number | null
    environmentId: string | null
    hostId: string | null
    startedBy: string | null
  } | null
}

export type AttachedRelay = { ready: RelayReady; endpoint: MuxEndpoint; noise: string }

const MAX_NOISE = 64 * 1024

/**
 * Resolves once `@@SPRINTENGINE_RELAY {…}` has arrived on `stdout`; the bytes
 * after its line are the multiplexer's. Rejects when the stream ends first,
 * or after `timeoutMs`, with what came before for diagnostics.
 */
export function attachRelay(
  stdout: Readable,
  stdin: Writable,
  options: { timeoutMs?: number; onNoise?: (text: string) => void } = {},
): Promise<AttachedRelay> {
  return new Promise((resolve, reject) => {
    let head = Buffer.alloc(0)
    let settled = false
    const finish = (error: Error | null, value?: AttachedRelay) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stdout.off('data', onData)
      stdout.off('end', onEnd)
      if (error) reject(error)
      else resolve(value!)
    }
    const onEnd = () =>
      finish(new Error(`The relay ended before it was ready. ${head.toString('utf8').trim().slice(-400)}`))
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk])
      const at = head.indexOf(`${RELAY_MARKER} `)
      const lineEnd = at === -1 ? -1 : head.indexOf(0x0a, at)
      if (lineEnd === -1) {
        if (head.length > MAX_NOISE) head = head.subarray(head.length - 1_024)
        return
      }
      let ready: RelayReady
      try {
        ready = JSON.parse(head.subarray(at + RELAY_MARKER.length + 1, lineEnd).toString('utf8')) as RelayReady
      } catch {
        finish(new Error('The relay said it was ready in words this app does not read.'))
        return
      }
      const noise = head.subarray(0, at).toString('utf8')
      if (noise.trim()) options.onNoise?.(noise)
      const rest = head.subarray(lineEnd + 1)
      stdout.pause()
      const input = new PassThrough()
      if (rest.length > 0) input.write(rest)
      stdout.pipe(input)
      finish(null, { ready, endpoint: new MuxEndpoint({ input, output: stdin }), noise })
    }
    const timer = setTimeout(
      () => finish(new Error('The relay did not say it was ready in time.')),
      options.timeoutMs ?? 15_000,
    )
    stdout.on('data', onData)
    stdout.once('end', onEnd)
    // A session that paused it to hand it over: flowing again, from the bytes it kept.
    stdout.resume()
  })
}
