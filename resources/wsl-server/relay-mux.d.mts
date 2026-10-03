// Types for relay-mux.mjs: the relay's multiplexer, which runs on an SSH
// machine from the installed server tree and is imported by the desktop for
// its own end of the same pipe (phase 8).

import type { Socket } from 'node:net'
import type { Duplex, Readable, Writable } from 'node:stream'

export const MUX_VERSION: 1
export const FRAME: Readonly<{ open: 1; opened: 2; refused: 3; data: 4; credit: 5; fin: 6; close: 7 }>
export const MAX_DATA: number
export const INITIAL_WINDOW: number
export const MAX_TCP_STREAMS: number
export const TCP_CONNECT_TIMEOUT_MS: number

export type MuxFrame = { type: number; id: number; payload: Buffer }
export function encodeFrame(type: number, id: number, payload?: Buffer | string): Buffer
export class FrameDecoder {
  push(chunk: Buffer): MuxFrame[]
}

export type MuxOpenRequest =
  { kind: 'owner'; purpose: 'backend' | 'studio' } | { kind: 'tcp'; host: string; port: number }

/** Why the relay would not open a stream: `error.code` is one of these. */
export type MuxRefusalCode = 'refused' | 'unreachable' | 'timeout' | 'limit' | 'no-server' | 'closed'
export type MuxRefusal = Error & { code: MuxRefusalCode }

export class MuxEndpoint {
  constructor(options: {
    input: Readable
    output: Writable
    onOpen?: ((request: Record<string, unknown>, stream: Duplex) => Promise<void> | void) | null
    onClose?: ((reason: string) => void) | null
  })
  open(request: MuxOpenRequest): Promise<Duplex>
  readonly size: number
  readonly closed: boolean
  onClosed(listener: (reason: string) => void): void
  close(reason?: string): void
}

export function enterFrontDoorAsRelay(
  socket: Socket,
  options: { token: string; purpose: string; via: string; client: string | null; timeoutMs?: number },
): Promise<Socket>

export type ServerRecord = Record<string, unknown> & { socketPath?: string; version?: string; pid?: number }
export function readServerRecord(runDir: string): ServerRecord | null

export type RelayStats = {
  owner: number
  tcp: number
  refused: number
  bytesIn: number
  bytesOut: number
  targets: Set<string>
}
export function serveRelay(options: {
  input: Readable
  output: Writable
  runDir: string
  via?: string
  client?: string | null
  log?: (message: string) => void
}): { endpoint: MuxEndpoint; stats: RelayStats }
