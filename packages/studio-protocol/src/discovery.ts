import { STUDIO_PROTOCOL_MIN_SUPPORTED, STUDIO_PROTOCOL_VERSION } from './handshake.js'

// How a client on the same machine finds a running Studio: a small JSON file
// in the run directory of Studio's data directory, written once the owner
// socket is listening and removed when it stops. It names the socket (or the
// pipe) and the protocol window, and nothing secret: the file is the owner's
// alone by its mode, but a credential is never kept in it.
//
// On Windows the pipe's name carries a random part minted at each start, so it
// cannot be guessed and claimed by another account first; this file is the
// only way to learn it.

/** The discovery file's name, inside `<data directory>/run/`. */
export const STUDIO_SERVER_DISCOVERY_FILENAME = 'server.json'
/** The run directory's name inside the data directory. */
export const STUDIO_RUN_DIRECTORY = 'run'

export type StudioServerDiscovery = {
  product: 'sprintengine-studio'
  socketPath: string
  transport: 'unix-socket' | 'named-pipe'
  /** One JSON frame per line. */
  framing: 'ndjson'
  protocolVersion: number
  minProtocolVersion: number
  /** The process serving the socket, so a stale file can be told from a live one. */
  pid: number
  /** The Studio version serving it. */
  version: string
  startedAt: string
}

/** A discovery file as this Studio writes it. */
export function studioServerDiscovery(input: {
  socketPath: string
  transport: StudioServerDiscovery['transport']
  pid: number
  version: string
  startedAt: string
}): StudioServerDiscovery {
  return {
    product: 'sprintengine-studio',
    socketPath: input.socketPath,
    transport: input.transport,
    framing: 'ndjson',
    protocolVersion: STUDIO_PROTOCOL_VERSION,
    minProtocolVersion: STUDIO_PROTOCOL_MIN_SUPPORTED,
    pid: input.pid,
    version: input.version,
    startedAt: input.startedAt,
  }
}

/** A discovery file's contents, or null when it is not one. */
export function parseStudioServerDiscovery(value: unknown): StudioServerDiscovery | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const file = value as Record<string, unknown>
  const version = (field: unknown): field is number =>
    typeof field === 'number' && Number.isSafeInteger(field) && field >= 1
  if (file.product !== 'sprintengine-studio' || file.framing !== 'ndjson') return null
  if (typeof file.socketPath !== 'string' || !file.socketPath || file.socketPath.length > 1024) return null
  if (file.transport !== 'unix-socket' && file.transport !== 'named-pipe') return null
  if (!version(file.protocolVersion) || !version(file.minProtocolVersion)) return null
  if (!version(file.pid) || typeof file.version !== 'string' || typeof file.startedAt !== 'string') return null
  return {
    product: 'sprintengine-studio',
    socketPath: file.socketPath,
    transport: file.transport,
    framing: 'ndjson',
    protocolVersion: file.protocolVersion,
    minProtocolVersion: file.minProtocolVersion,
    pid: file.pid,
    version: file.version,
    startedAt: file.startedAt,
  }
}
