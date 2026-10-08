import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  STUDIO_RUN_DIRECTORY,
  STUDIO_SERVER_DISCOVERY_FILENAME,
  parseStudioServerDiscovery,
  studioServerDiscovery,
} from '../../../packages/studio-protocol/src/public'
import { writeFileAtomicSync } from '../platform/atomic-file'
import type { StudioRpcConnection } from './studio-rpc-connection'

// The owner socket: where the Studio RPC listens on this machine.
//
// Secured the way the automation socket is — a Unix domain socket the owner
// alone can open, or a named pipe on Windows — with three things that socket
// leaves to the single-instance lock, because this one is a long-lived door
// for applications rather than for agents the app itself launched:
//
// - The socket lives in a directory only its owner can enter (`run/`, 0700,
//   checked to be a real directory owned by this user, never a symlink), so
//   the moment between `listen` creating the socket and `chmod` narrowing it
//   is not a window: nobody else can reach the path at all.
// - A socket file left at the path is probed before it is removed. A crashed
//   run leaves one nothing answers, and it is replaced; one that answers is
//   another Studio serving the same data directory (two dev builds pinned to
//   one profile), and this one refuses to start rather than disconnect it.
// - On Windows the pipe's name carries a random part minted at each start, so
//   no other account can claim the name first and collect the credential a
//   client sends; the discovery file in the owner's data directory is the only
//   way to learn it.
//
// None of that is the authentication. Every connection presents a credential
// in its hello, because a pipe's default access is wider than its owner.

// POSIX sun_path is about 104 bytes; a long data directory falls back to a
// private directory in the per-user temp dir, as the automation socket does.
const MAX_POSIX_SOCKET_PATH = 90
const MAX_CONNECTIONS = 64
const PROBE_TIMEOUT_MS = 1_000

export type StudioRpcListener = {
  start(): Promise<void>
  /** Tell every client Studio is closing, then stop listening and remove the socket and discovery file. */
  stop(retryAfterMs?: number): Promise<void>
  isRunning(): boolean
  socketPath(): string | null
  /** Every open connection, for revocation and diagnostics. */
  connections(): readonly StudioRpcConnection[]
}

export type StudioRpcListenerOptions = {
  /** Studio's data directory; the socket and discovery file go in its `run/`. */
  dataDir: string
  /** The Studio version the discovery file names. */
  version: string
  createConnection(
    socket: Socket,
    connectionId: string,
    onClosed: (connection: StudioRpcConnection) => void,
  ): StudioRpcConnection
  /** A socket path or pipe name of the caller's choosing (tests); otherwise one is resolved. */
  socketPath?: string
  maxConnections?: number
  /** Told whenever a connection opens or closes. */
  onConnectionsChanged?: () => void
  platform?: NodeJS.Platform
  log?: (message: string) => void
}

/** Where the owner socket goes for a data directory. A pipe name is fresh on every call. */
export function resolveStudioSocketPath(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
  temporaryDir: string = tmpdir(),
): string {
  const profile = createHash('sha256').update(dataDir).digest('hex').slice(0, 12)
  if (platform === 'win32') return `\\\\.\\pipe\\sprintengine-studio-${profile}-${randomBytes(8).toString('hex')}`
  const direct = join(dataDir, STUDIO_RUN_DIRECTORY, 'studio.sock')
  if (direct.length <= MAX_POSIX_SOCKET_PATH) return direct
  // A random name, so the directory cannot be predicted and prepared by
  // another account first (clients learn the path from the discovery file),
  // and a short one: macOS's per-user temp dir alone is about fifty bytes of
  // the hundred a socket path may have.
  return join(temporaryDir, `sprintengine-${randomBytes(6).toString('hex')}`, 'studio.sock')
}

/**
 * Make `directory` (and its parents) and hold it to its owner: a real
 * directory, not a symlink, owned by this user, with no access for anyone
 * else. Throws rather than serve from a directory someone else could enter or
 * had prepared in advance.
 */
export function ensurePrivateDirectory(directory: string, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (platform === 'win32') return
  const stats = lstatSync(directory)
  if (stats.isSymbolicLink() || !stats.isDirectory())
    throw new Error(`${directory} is not a directory Studio can keep private.`)
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid())
    throw new Error(`${directory} belongs to another user, so Studio will not listen there.`)
  if ((stats.mode & 0o077) !== 0) chmodSync(directory, 0o700)
}

/** Whether something answers on a socket path: a live server, a stale file, or nothing. */
export function probeStudioSocket(path: string): Promise<'live' | 'stale' | 'absent'> {
  return new Promise((resolve) => {
    if (!path.startsWith('\\\\') && !existsSync(path)) {
      resolve('absent')
      return
    }
    const socket = connect(path)
    const settle = (answer: 'live' | 'stale' | 'absent') => {
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.on('error', () => undefined)
      socket.destroy()
      resolve(answer)
    }
    // Something that accepts and never speaks is still something: left alone.
    const timer = setTimeout(() => settle('live'), PROBE_TIMEOUT_MS)
    socket.once('connect', () => settle('live'))
    socket.once('error', (error: NodeJS.ErrnoException) =>
      settle(error.code === 'ENOENT' ? 'absent' : error.code === 'EACCES' ? 'live' : 'stale'),
    )
  })
}

export function createStudioRpcListener(options: StudioRpcListenerOptions): StudioRpcListener {
  const platform = options.platform ?? process.platform
  const maxConnections = options.maxConnections ?? MAX_CONNECTIONS
  const runDir = join(options.dataDir, STUDIO_RUN_DIRECTORY)
  const discoveryPath = join(runDir, STUDIO_SERVER_DISCOVERY_FILENAME)
  const open = new Set<StudioRpcConnection>()
  let server: Server | null = null
  let path: string | null = null
  let sequence = 0

  function onConnection(socket: Socket): void {
    if (open.size >= maxConnections) {
      socket.on('error', () => undefined)
      socket.end(
        `${JSON.stringify({
          t: 'bye',
          code: 'too_many_connections',
          message: `Studio is serving ${maxConnections} connections already.`,
          retryAfterMs: 1_000,
        })}\n`,
      )
      return
    }
    const connection = options.createConnection(socket, `c${++sequence}`, (closed) => {
      if (open.delete(closed)) options.onConnectionsChanged?.()
    })
    if (connection.isClosed()) return
    open.add(connection)
    options.onConnectionsChanged?.()
  }

  function writeDiscovery(socketPath: string): void {
    const body = `${JSON.stringify(
      studioServerDiscovery({
        socketPath,
        transport: platform === 'win32' ? 'named-pipe' : 'unix-socket',
        pid: process.pid,
        version: options.version,
        startedAt: new Date().toISOString(),
      }),
      null,
      2,
    )}\n`
    // Written beside and renamed over, so a client never reads half a file.
    writeFileAtomicSync(discoveryPath, body, { mode: 0o600, exactMode: platform !== 'win32' })
  }

  function readDiscovery(): ReturnType<typeof parseStudioServerDiscovery> {
    try {
      return parseStudioServerDiscovery(JSON.parse(readFileSync(discoveryPath, 'utf8')))
    } catch {
      return null
    }
  }

  function removeDiscovery(socketPath: string): void {
    try {
      const written = parseStudioServerDiscovery(JSON.parse(readFileSync(discoveryPath, 'utf8')))
      // Only this run's file: another Studio may have written its own since.
      if (written?.pid === process.pid && written.socketPath === socketPath) unlinkSync(discoveryPath)
    } catch {
      // Absent or unreadable: nothing of this run's to remove.
    }
  }

  return {
    async start() {
      if (server) return
      ensurePrivateDirectory(runDir, platform)
      // The discovery file names where a Studio already serving this data
      // directory listens. A pipe, or a temp socket with a random name, is
      // never at the path this start would choose, so it is asked about here.
      const announced = readDiscovery()
      if (announced && (await probeStudioSocket(announced.socketPath)) === 'live')
        throw new Error(`Another Studio is already serving this data directory on ${announced.socketPath}.`)
      const socketPath = options.socketPath ?? resolveStudioSocketPath(options.dataDir, platform)
      if (platform !== 'win32') {
        ensurePrivateDirectory(dirname(socketPath), platform)
        const found = await probeStudioSocket(socketPath)
        if (found === 'live') throw new Error(`Another Studio is already serving this data directory on ${socketPath}.`)
        if (found === 'stale') {
          if (!lstatSync(socketPath).isSocket())
            throw new Error(`${socketPath} is in the way and is not a socket, so Studio left it alone.`)
          unlinkSync(socketPath)
        }
      }
      const next = createServer((socket) => onConnection(socket))
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          next.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          next.removeListener('error', onError)
          resolve()
        }
        next.once('error', onError)
        next.once('listening', onListening)
        // Never widened to other accounts (Node's `readableAll` and
        // `writableAll`). On Windows Node cannot set the pipe's security
        // descriptor or refuse remote clients by flag; the pipe keeps the
        // default access its creator gets, its name is unguessable, and every
        // client must present a token Studio minted (see the design, 9.1).
        next.listen({ path: socketPath, readableAll: false, writableAll: false })
      })
      if (platform !== 'win32') chmodSync(socketPath, 0o600)
      next.on('error', (error) => options.log?.(`Studio RPC listener error: ${error.message}`))
      try {
        writeDiscovery(socketPath)
      } catch (error) {
        // A client cannot find an undiscoverable listener; do not leave one up.
        await new Promise<void>((resolve) => next.close(() => resolve()))
        if (platform !== 'win32' && existsSync(socketPath)) unlinkSync(socketPath)
        throw error
      }
      server = next
      path = socketPath
    },

    async stop(retryAfterMs = 1_000) {
      const current = server
      const socketPath = path
      if (!current || !socketPath) return
      server = null
      path = null
      for (const connection of [...open]) connection.bye('shutting_down', 'Studio is closing.', retryAfterMs)
      open.clear()
      await new Promise<void>((resolve) => current.close(() => resolve()))
      if (platform !== 'win32') {
        try {
          if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath)
        } catch {
          // Already gone.
        }
        // A private temp directory minted for this run goes with it.
        if (!socketPath.startsWith(runDir) && socketPath !== options.socketPath)
          rmSync(dirname(socketPath), { recursive: true, force: true })
      }
      removeDiscovery(socketPath)
    },

    isRunning: () => server !== null,
    socketPath: () => path,
    connections: () => [...open],
  }
}
