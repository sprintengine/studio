import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { connect as connectSocket } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { connect, type ConnectOptions, type StudioClient } from './client.js'
import { StudioError } from './errors.js'
import {
  STUDIO_RUN_DIRECTORY,
  STUDIO_SERVER_DISCOVERY_FILENAME,
  parseStudioServerDiscovery,
  type StudioServerDiscovery,
} from './protocol.js'
import type { StudioTransport, StudioTransportFactory } from './transport.js'

// Reaching the Studio on this machine from Node: where its data directory is,
// where its owner socket is (from the discovery file it writes there), a
// transport over that socket, and keeping the token a pairing code is
// exchanged for.

/**
 * Studio's data directory for the current user: `SPRINTENGINE_USER_DATA_DIR`
 * when set (a pinned development profile), else the platform's application
 * data directory.
 */
export function studioDataDir(
  input: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string } = {},
): string {
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const home = input.home ?? homedir()
  const pinned = env.SPRINTENGINE_USER_DATA_DIR?.trim()
  if (pinned) return pinned
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'SprintEngine Studio')
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'SprintEngine Studio')
  return join(env.XDG_CONFIG_HOME?.trim() || join(home, '.config'), 'SprintEngine Studio')
}

/**
 * Where the running Studio's owner socket is. Throws `not_running` when no
 * Studio has written one, or the one that did has exited.
 */
export async function discoverStudio(input: { dataDir?: string } = {}): Promise<StudioServerDiscovery> {
  const path = join(input.dataDir ?? studioDataDir(), STUDIO_RUN_DIRECTORY, STUDIO_SERVER_DISCOVERY_FILENAME)
  let found: StudioServerDiscovery | null = null
  try {
    found = parseStudioServerDiscovery(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    found = null
  }
  if (!found) throw new StudioError('not_running', `Studio is not running here (no ${path}).`)
  try {
    // Signal 0 asks only whether the process exists.
    process.kill(found.pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH')
      throw new StudioError('not_running', 'The Studio that wrote the discovery file has exited.')
  }
  return found
}

/**
 * A transport over Studio's owner socket: one JSON frame per line. Each call
 * opens a fresh connection and, unless `socketPath` is given, reads the
 * discovery file again, so a reconnect finds a Studio that restarted on a new
 * socket or pipe.
 */
export function socketTransport(input: { socketPath?: string; dataDir?: string } = {}): StudioTransportFactory {
  return async () => {
    const path = input.socketPath ?? (await discoverStudio({ dataDir: input.dataDir })).socketPath
    const socket = connectSocket(path)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', (error) =>
        reject(new StudioError('disconnected', `Studio's socket refused: ${error.message}`)),
      )
    })
    socket.setEncoding('utf8')
    const messageListeners: Array<(frame: string) => void> = []
    const closeListeners: Array<(error?: Error) => void> = []
    let buffer = ''
    let failure: Error | undefined
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim()) for (const listener of messageListeners) listener(line)
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('error', (error) => {
      failure = error
    })
    socket.once('close', () => {
      for (const listener of closeListeners) listener(failure)
    })
    const transport: StudioTransport = {
      send: (frame) => void socket.write(`${frame}\n`),
      close: () => socket.end(() => socket.destroy()),
      onMessage: (listener) => void messageListeners.push(listener),
      onClose: (listener) => void closeListeners.push(listener),
      pause: () => void socket.pause(),
      resume: () => void socket.resume(),
    }
    return transport
  }
}

/** The token kept in a file, or null when there is none yet. */
export async function readTokenFile(path: string): Promise<string | null> {
  try {
    const token = (await readFile(path, 'utf8')).trim()
    return token || null
  } catch {
    return null
  }
}

/**
 * Keep a token where only its owner can read it: the file 0600 in a 0700
 * directory, written beside and renamed over so it is never half there. A
 * token is a credential; keep it out of a repository, argv and the environment.
 */
export async function writeTokenFile(path: string, token: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const staged = `${path}.${process.pid}.tmp`
  await writeFile(staged, `${token}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') await chmod(staged, 0o600)
  await rename(staged, path)
}

export type ConnectToStudioOptions = Omit<ConnectOptions, 'transport' | 'auth' | 'client' | 'onToken'> & {
  /** What this app is called, for the audit. The name it shows in Settings is the one it was paired under. */
  name: string
  version?: string
  /** A token from an earlier pairing. */
  token?: string
  /** Where the token is kept: read when present, written when a pairing code is redeemed. */
  tokenFile?: string
  /** A one-time code from Studio's Settings, used when there is no token yet. */
  pairingCode?: string
  dataDir?: string
  socketPath?: string
}

/**
 * Connect to the Studio on this machine. Uses `token`, else the token in
 * `tokenFile`, else redeems `pairingCode` and keeps the token it is exchanged
 * for in `tokenFile`.
 */
export async function connectToStudio(options: ConnectToStudioOptions): Promise<StudioClient> {
  const { name, version, token, tokenFile, pairingCode, dataDir, socketPath, ...rest } = options
  const kept = token ?? (tokenFile ? await readTokenFile(tokenFile) : null)
  const auth = kept ? { token: kept } : pairingCode ? { pairingCode } : null
  if (!auth)
    throw new StudioError(
      'unauthorized',
      'No token, and no pairing code. Pair this app in Studio’s Settings → Agents → Local apps.',
    )
  return connect({
    ...rest,
    transport: socketTransport({
      ...(socketPath === undefined ? {} : { socketPath }),
      ...(dataDir === undefined ? {} : { dataDir }),
    }),
    client: { name, ...(version === undefined ? {} : { version }) },
    auth,
    ...(tokenFile ? { onToken: (minted: string) => writeTokenFile(tokenFile, minted) } : {}),
  })
}
