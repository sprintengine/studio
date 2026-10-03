import { connect as connectTcp, type Socket } from 'node:net'
import { Duplex, PassThrough } from 'node:stream'

import type { HelperProcess } from '../../main/hosts/wsl-helper-client'
import { FRONT_DOOR_LOOPBACK_HOST } from './front-door-listener'

// The Windows side's two ways to a WSL server's front door, each a plain byte
// stream that the mutual proof (front-door-proof.ts) then runs over:
//
// - `connectLoopback`: the literal 127.0.0.1 and the port the server reported,
//   tried for a few seconds, because WSL's forwarding can open the Windows
//   end a moment after the Linux `listen` (phase 7 spec, 3.4).
// - `openBridge`: one `wsl.exe` running the relay (`resources/wsl-server/
//   bridge.mjs`), its stdio spliced onto the server's bridge socket. It works
//   whatever `.wslconfig` says about networking.

/** What the relay prints before it reads a byte; must equal `BRIDGE_READY` in `resources/wsl-server/bridge.mjs`. */
export const BRIDGE_READY = '@@SPRINTENGINE_BRIDGE_READY'

const LOOPBACK_DEADLINE_MS = 3_000
const LOOPBACK_RETRY_MS = 150
const BRIDGE_READY_TIMEOUT_MS = 45_000

export type ConnectLoopbackOptions = {
  deadlineMs?: number
  /** Stands in for `net.connect` in tests. */
  connect?: (port: number, host: string) => Socket
  sleep?: (ms: number) => Promise<void>
}

/** A TCP connection to the front door's loopback port, retried until the deadline. */
export async function connectLoopback(port: number, options: ConnectLoopbackOptions = {}): Promise<Socket> {
  const open = options.connect ?? ((target: number, host: string) => connectTcp({ port: target, host }))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = Date.now() + (options.deadlineMs ?? LOOPBACK_DEADLINE_MS)
  let last: Error | null = null
  for (;;) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = open(port, FRONT_DOOR_LOOPBACK_HOST)
        const onError = (error: Error) => {
          socket.destroy()
          reject(error)
        }
        socket.once('error', onError)
        socket.once('connect', () => {
          socket.off('error', onError)
          resolve(socket)
        })
      })
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error))
      if (Date.now() + LOOPBACK_RETRY_MS > deadline) break
      await sleep(LOOPBACK_RETRY_MS)
    }
  }
  throw new Error(`127.0.0.1:${port} did not answer from Windows (${last?.message ?? 'no answer'}).`)
}

/**
 * The relay's stdio as one stream to the bridge socket at `socketPath`. The
 * relay is started by `spawn` (a `wsl.exe … --exec sh -s` whose script is
 * `script`); the script goes in first, then nothing until the relay says it is
 * reading, then the socket path, then the bytes of whatever runs over it.
 */
export function openBridge(
  spawn: () => HelperProcess,
  script: string,
  socketPath: string,
  options: { readyTimeoutMs?: number } = {},
): Promise<Duplex> {
  if (!socketPath.startsWith('/') || socketPath.includes('\n')) {
    return Promise.reject(new Error('The bridge needs the server socket as an absolute Linux path.'))
  }
  const child = spawn()
  child.stdin.write(script.endsWith('\n') ? script : `${script}\n`)
  return new Promise<Duplex>((resolve, reject) => {
    let head = Buffer.alloc(0)
    let stderr = ''
    let settled = false
    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      reject(new Error(message))
    }
    const timer = setTimeout(
      () => fail('The stdio bridge did not start in time.'),
      options.readyTimeoutMs ?? BRIDGE_READY_TIMEOUT_MS,
    )
    timer.unref?.()
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4_096) stderr += chunk.toString('utf8')
    })
    child.once('error', (error) => fail(`The stdio bridge could not be started: ${error.message}`))
    child.once('close', (code) =>
      fail(`The stdio bridge ended before it was ready (${stderr.trim() || `exit ${code ?? 'unknown'}`}).`),
    )
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk])
      const marker = head.indexOf(`${BRIDGE_READY}\n`)
      if (marker === -1) {
        // Anything a login profile prints is not ours; keep only the tail.
        if (head.length > 64 * 1024) head = head.subarray(head.length - 1_024)
        return
      }
      child.stdout.off('data', onData)
      child.stdout.pause()
      if (settled) return
      settled = true
      clearTimeout(timer)
      const rest = head.subarray(marker + BRIDGE_READY.length + 1)
      child.stdin.write(`${socketPath}\n`)
      resolve(bridgeStream(child, rest))
    }
    child.stdout.on('data', onData)
  })
}

/** The relay's stdout (after the ready line) and stdin as one duplex, which ends with the process. */
function bridgeStream(child: HelperProcess, first: Buffer): Duplex {
  const readable = new PassThrough()
  if (first.length > 0) readable.write(first)
  child.stdout.pipe(readable)
  let finished = false
  const stream = new Duplex({
    read() {
      readable.resume()
    },
    write(chunk: Buffer, _encoding, callback) {
      if (child.stdin.destroyed || !child.stdin.writable) {
        callback(new Error('The stdio bridge has ended.'))
        return
      }
      child.stdin.write(chunk, callback)
    },
    final(callback) {
      child.stdin.end()
      callback()
    },
    destroy(error, callback) {
      if (!finished) child.kill()
      callback(error)
    },
  })
  readable.on('data', (chunk: Buffer) => {
    if (!stream.push(chunk)) readable.pause()
  })
  readable.on('end', () => stream.push(null))
  child.once('close', () => {
    finished = true
    stream.push(null)
    stream.destroy()
  })
  return stream
}
