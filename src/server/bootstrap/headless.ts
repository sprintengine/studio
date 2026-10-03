import { readFileSync } from 'node:fs'

import { readStudioEnvironmentId } from '../../main/studio-rpc/studio-rpc-service'
import { driveMountRootFromMounts, driveMountRootFromWslConf } from '../../shared/host-paths'
import { startStudioServer, type StudioServer, type StudioServerOptions } from '../studio-server'
import { serveConversationBackend } from '../wsl/backend-wire'
import { startFrontDoorListeners, type FrontDoorListeners } from '../wsl/front-door-listener'
import type { FrontDoorPurpose } from '../wsl/front-door-proof'
import { SERVER_EXIT, type FrontDoorReady, type ServerBootstrapEnvelope } from './envelope'
import { runShutdownLegs, type ServerStart } from './serve'
import type { Duplex } from 'node:stream'

// A headless server's start from its envelope: the same core, gateway and
// owner socket `studio-server serve` runs, with the locations the envelope
// names instead of flags. Its secrets are its own key file (decision R12);
// a headless server never seals through a shell.
//
// A server inside a WSL distribution (phase 7) is one of these, with a front
// door: the Windows side's two ways in (front-door-listener.ts), both behind
// the mutual proof. An admitted connection asks for the conversation backend
// the Windows side routes this distribution's chats to, or for a Studio
// protocol connection with the shell role, over which the Windows side offers
// the toolsets its own shell offers it.

export function headlessServerOptions(
  envelope: ServerBootstrapEnvelope,
  log: (message: string) => void,
): StudioServerOptions {
  return {
    dataDir: envelope.dataDir,
    logsDir: envelope.logsDir,
    version: envelope.app.version,
    packaged: envelope.paths.isPackaged,
    resourcesDir: envelope.paths.resourcesDir,
    appRoot: envelope.paths.appPath,
    listen: envelope.listeners.gateway,
    log,
  }
}

/** Where this distribution mounts the Windows drives: what is mounted, else what wsl.conf asks for. */
export function readDriveMountRoot(read: (path: string) => string | null = readText): string | null {
  const mounts = read('/proc/mounts')
  const mounted = mounts ? driveMountRootFromMounts(mounts) : null
  return mounted ?? driveMountRootFromWslConf(read('/etc/wsl.conf'))
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Hand an admitted front-door connection to what it asked for. */
export function serveFrontDoorPurpose(
  server: Pick<StudioServer, 'core' | 'rpc'>,
  purpose: FrontDoorPurpose,
  stream: Duplex,
  log: (message: string) => void,
): void {
  if (purpose === 'backend') {
    serveConversationBackend(server.core.conversations, stream, { log })
    return
  }
  // The ticket goes first, on its own line, before the Studio protocol starts:
  // the front door says hello with it.
  const { ticket } = server.rpc.connectShellStream(stream)
  stream.write(`${JSON.stringify({ t: 'ticket', ticket })}\n`)
}

export const startHeadlessServer: ServerStart = async ({ envelope, log, requestExit }) => {
  const server = await startStudioServer({
    ...headlessServerOptions(envelope, log),
    // The desktop opened this directory and took its lock: it is the one
    // writer now, and this server leaves saying so.
    onDataDirLost: () =>
      requestExit(SERVER_EXIT.dataDirBusy, 'SprintEngine Studio opened this data directory; stopping.'),
  })

  let doors: FrontDoorListeners | null = null
  let frontDoor: FrontDoorReady | undefined
  const door = envelope.listeners.frontDoor
  if (door && envelope.owner.tokenHash) {
    try {
      doors = await startFrontDoorListeners({
        tokenHash: envelope.owner.tokenHash,
        runDir: envelope.runDir,
        loopback: door.loopback,
        onAdmitted: (purpose, stream) => serveFrontDoorPurpose(server, purpose, stream, log),
        log,
      })
    } catch (error) {
      await server.stop()
      throw error
    }
    frontDoor = {
      port: doors.port,
      socketPath: doors.socketPath,
      driveMountRoot: envelope.wsl ? readDriveMountRoot() : null,
    }
    if (doors.port === null && doors.socketPath === null) {
      await doors.close()
      await server.stop()
      throw Object.assign(
        new Error('Neither of the front door’s ways in could open, so Windows cannot reach this server.'),
        {
          exitCode: SERVER_EXIT.temporary,
        },
      )
    }
  }

  return {
    environmentId: readStudioEnvironmentId(envelope.dataDir),
    gatewaySocket: server.ready.gatewaySocket,
    tailnetBound: null,
    ...(frontDoor ? { frontDoor } : {}),
    stop: async ({ onLeg }) => {
      // The front door first, so nothing new arrives while the core closes.
      if (doors) await runShutdownLegs([['front door', () => doors?.close()]], onLeg)
      await server.stop(onLeg)
    },
  }
}
