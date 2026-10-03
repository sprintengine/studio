import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, rmSync, unlinkSync, chmodSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Duplex } from 'node:stream'

import { ensurePrivateDirectory, probeStudioSocket } from '../rpc/studio-rpc-listener'
import { admitFrontDoor, type FrontDoorPurpose } from './front-door-proof'

// Where a Studio server inside a WSL distribution lets the Windows side in
// (phase 7 spec, 3.4 and 4.3). Two doors, both behind the mutual proof
// (front-door-proof.ts), and nothing else:
//
// - **Loopback TCP**, bound to the literal 127.0.0.1 on a port the kernel
//   picks. Never 0.0.0.0 or `::`, which in WSL's mirrored networking mode is
//   a listener on the PC's LAN, and never the name `localhost`, which Node
//   may resolve to ::1 first. The guard refuses anything else before
//   `listen`. Windows reaches it through WSL's localhost forwarding.
// - **A Unix socket** in the server's private run directory, for the stdio
//   bridge: one `wsl.exe` whose stdio a tiny relay splices onto this socket,
//   for a PC where forwarding is off or the port is squatted. The socket is
//   0600 in a 0700 directory, which only this Linux user can enter; the
//   proof runs on it anyway, so there is one handshake.
//
// A connection that has not proven itself in ten seconds is closed, and only
// a few may be proving at once on each door: a process on Windows' loopback
// can reach the TCP door, and must not be able to hold the server's sockets
// open, nor shut the bridge, which only this Windows user can reach, by
// filling a count the two doors shared.

/** The one address the TCP door binds. */
export const FRONT_DOOR_LOOPBACK_HOST = '127.0.0.1'
const MAX_BIND_ATTEMPTS = 5
const MAX_UNPROVEN = 8
// POSIX sun_path is about 104 bytes; a long home falls back to a private temp directory.
const MAX_POSIX_SOCKET_PATH = 90

/**
 * Refuses any bind address but the literal IPv4 loopback. Called before every
 * `listen`, so a later change that passes a host through cannot widen the door.
 */
export function assertFrontDoorBindAddress(host: string): void {
  if (host !== FRONT_DOOR_LOOPBACK_HOST) {
    throw new Error(
      `The Studio server's front door listens on ${FRONT_DOOR_LOOPBACK_HOST} only; it refused to bind ${JSON.stringify(host)}.`,
    )
  }
}

export type FrontDoorListeners = {
  /** The loopback port, or null when the TCP door is off or could not bind. */
  port: number | null
  /** The bridge's Unix socket, or null when it could not be made. */
  socketPath: string | null
  close(): Promise<void>
}

export type FrontDoorListenerOptions = {
  /** The owner token's hash, from the envelope. */
  tokenHash: string
  /** The server's private run directory; the bridge socket goes here when its path is short enough. */
  runDir: string
  /** Open the TCP door. The bridge socket is always opened. */
  loopback: boolean
  /** A connection proved itself and asked for `purpose`; the stream is paused, ready for that protocol. */
  onAdmitted(purpose: FrontDoorPurpose, stream: Duplex): void
  /** How many admitted connections are open now, after one opened or closed (a detached server's idle rule). */
  onOpenCount?(count: number): void
  log?: (message: string) => void
  /** Stands in for `net.createServer().listen` in tests (a forced EADDRINUSE, say). */
  listenTcp?: (server: Server, host: string) => Promise<void>
  /** Where a socket goes when the run directory's path is too long; the OS temp directory by default. */
  temporaryDir?: string
  proofTimeoutMs?: number
}

function listenOnLoopback(server: Server, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    // `exclusive`: no handle shared with a cluster worker; port 0: the kernel picks.
    server.listen({ host, port: 0, exclusive: true })
  })
}

function listenOnPath(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ path, readableAll: false, writableAll: false }, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

/** Where the bridge socket goes: in the run directory, or a fresh private directory in temp when that path is too long. */
export function frontDoorSocketPath(runDir: string, temporaryDir: string = tmpdir()): string {
  const direct = join(runDir, 'front-door.sock')
  if (direct.length <= MAX_POSIX_SOCKET_PATH) return direct
  return join(temporaryDir, `sprintengine-${randomBytes(6).toString('hex')}`, 'front-door.sock')
}

export async function startFrontDoorListeners(options: FrontDoorListenerOptions): Promise<FrontDoorListeners> {
  const log = options.log ?? (() => undefined)
  const unproven = { loopback: 0, bridge: 0 }
  let admitted = 0
  const servers: Server[] = []
  const open = new Set<Socket>()

  const accept = (door: 'loopback' | 'bridge') => (socket: Socket) => {
    open.add(socket)
    socket.once('close', () => open.delete(socket))
    socket.on('error', () => undefined)
    if (unproven[door] >= MAX_UNPROVEN) {
      socket.destroy()
      return
    }
    unproven[door]++
    void admitFrontDoor(socket, {
      tokenHash: options.tokenHash,
      ...(options.proofTimeoutMs ? { timeoutMs: options.proofTimeoutMs } : {}),
    }).then(
      ({ purpose, via }) => {
        unproven[door]--
        // The audit line: which door, what for, and, through an SSH
        // machine's relay, from which SSH client. Never what is said.
        log(
          `Admitted a ${purpose} connection on the ${door} door` +
            (via
              ? ` via ${via.via}${via.client ? ` from ${via.client}` : ''}${via.relayPid ? ` (relay pid ${via.relayPid})` : ''}`
              : '') +
            '.',
        )
        admitted++
        options.onOpenCount?.(admitted)
        socket.once('close', () => {
          admitted--
          options.onOpenCount?.(admitted)
        })
        options.onAdmitted(purpose, socket)
      },
      (error: unknown) => {
        unproven[door]--
        // A squatter's decoy, or something that wandered in: logged with the door, not the bytes.
        log(`Refused a connection on the ${door} door: ${error instanceof Error ? error.message : String(error)}`)
      },
    )
  }

  let port: number | null = null
  if (options.loopback) {
    const listen = options.listenTcp ?? listenOnLoopback
    for (let attempt = 1; attempt <= MAX_BIND_ATTEMPTS && port === null; attempt++) {
      const server = createServer(accept('loopback'))
      try {
        assertFrontDoorBindAddress(FRONT_DOOR_LOOPBACK_HOST)
        await listen(server, FRONT_DOOR_LOOPBACK_HOST)
        const address = server.address()
        if (address && typeof address === 'object') {
          port = address.port
          servers.push(server)
        } else server.close()
      } catch (error) {
        server.close()
        const code = (error as NodeJS.ErrnoException).code
        // In mirrored networking the port space is Windows' too, so a fresh
        // port can still be taken; anything else will not pass on a retry.
        if (code !== 'EADDRINUSE' || attempt === MAX_BIND_ATTEMPTS) {
          log(`The loopback door did not open: ${error instanceof Error ? error.message : String(error)}`)
          break
        }
      }
    }
  }

  let socketPath: string | null = frontDoorSocketPath(options.runDir, options.temporaryDir)
  try {
    ensurePrivateDirectory(dirname(socketPath))
    const found = await probeStudioSocket(socketPath)
    if (found === 'live') throw new Error(`Another server is already listening on ${socketPath}.`)
    if (found === 'stale') {
      if (!lstatSync(socketPath).isSocket()) throw new Error(`${socketPath} is in the way and is not a socket.`)
      unlinkSync(socketPath)
    }
    const server = createServer(accept('bridge'))
    await listenOnPath(server, socketPath)
    chmodSync(socketPath, 0o600)
    servers.push(server)
  } catch (error) {
    log(`The bridge socket did not open: ${error instanceof Error ? error.message : String(error)}`)
    socketPath = null
  }

  const madeTemporary = socketPath !== null && !socketPath.startsWith(options.runDir)
  return {
    port,
    socketPath,
    async close() {
      for (const socket of open) socket.destroy()
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
      if (socketPath) {
        try {
          if (existsSync(socketPath) && lstatSync(socketPath).isSocket()) unlinkSync(socketPath)
        } catch {
          // Already gone.
        }
        if (madeTemporary) rmSync(dirname(socketPath), { recursive: true, force: true })
      }
    },
  }
}
