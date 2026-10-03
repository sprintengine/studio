import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { captureLoginEnv } from '../../../resources/wsl-helper/lib/login-env.mjs'
import { readStudioEnvironmentId } from '../../main/studio-rpc/studio-rpc-service'
import { driveMountRootFromMounts, driveMountRootFromWslConf } from '../../shared/host-paths'
import { startStudioServer, type StudioServer, type StudioServerOptions } from '../studio-server'
import { BACKEND_WIRE_VERSION, serveConversationBackend } from '../wsl/backend-wire'
import { startFrontDoorListeners, type FrontDoorListeners } from '../wsl/front-door-listener'
import type { FrontDoorPurpose } from '../wsl/front-door-proof'
import { SERVER_EXIT, type FrontDoorReady, type ServerBootstrapEnvelope } from './envelope'
import { runShutdownLegs, type ServerStart } from './serve'
import { readHostId, writeServerRecord } from './server-record'
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

/**
 * Inside WSL the server was started by `wsl.exe --exec` with almost no
 * environment: no profile has run, so PATH lacks where the person's CLIs live.
 * The helper's capture is read once here, the same fixed list of variables,
 * and laid over this process's environment before any chat can spawn.
 */
async function adoptLoginEnvironment(log: (message: string) => void): Promise<void> {
  const started = Date.now()
  const env = await captureLoginEnv({ ...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}) })
  Object.assign(process.env, env)
  const took = Date.now() - started
  if (took > 7_000)
    log(`The login profile took ${Math.round(took / 1000)} s to read; chats use what it had set by then.`)
}

type Sessions = Pick<StudioServer['core']['conversations'], 'listSessions'>

/** Whether a chat is working: starting, mid-turn, waiting on a person, or running background agents. */
export function chatsAreWorking(conversations: Sessions): boolean {
  const listed = conversations.listSessions()
  if (!listed.ok) return false
  return listed.sessions.some(
    (session) =>
      session.status === 'starting' ||
      session.status === 'active' ||
      session.status === 'awaiting_approval' ||
      session.turnStartedAt !== undefined ||
      (session.backgroundAgents ?? 0) > 0,
  )
}

/**
 * A detached server's idle rule (decision R32): it stops once no client has
 * been connected for `idleMs` and no chat is working, and never while one is.
 */
export function createIdleRule(input: { idleMs: number; working: () => boolean; stop: (reason: string) => void }): {
  connections(count: number): void
  dispose(): void
} {
  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (input.working()) {
        arm()
        return
      }
      input.stop(`No client for ${Math.round(input.idleMs / 60_000)} minutes and no chat working; stopping.`)
    }, input.idleMs)
    timer.unref?.()
  }
  arm()
  return {
    connections(count) {
      if (count > 0) {
        if (timer) clearTimeout(timer)
        timer = null
      } else arm()
    },
    dispose() {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

export const startHeadlessServer: ServerStart = async ({ envelope, log, requestExit }) => {
  // In parallel with the start: nothing spawns a CLI before `ready`. A server
  // started over `wsl.exe --exec` or an SSH session has run no profile, so
  // PATH lacks where the person's CLIs live.
  const loginEnvironment =
    envelope.wsl || envelope.detached ? adoptLoginEnvironment(log).catch(() => undefined) : Promise.resolve()
  const server = await startStudioServer({
    ...headlessServerOptions(envelope, log),
    // The desktop opened this directory and took its lock: it is the one
    // writer now, and this server leaves saying so.
    onDataDirLost: () =>
      requestExit(SERVER_EXIT.dataDirBusy, 'SprintEngine Studio opened this data directory; stopping.'),
  })

  let doors: FrontDoorListeners | null = null
  let frontDoor: FrontDoorReady | undefined
  const detached = envelope.detached
  const idle =
    detached && detached.idleMs !== null
      ? createIdleRule({
          idleMs: detached.idleMs,
          working: () => chatsAreWorking(server.core.conversations),
          stop: (reason) => requestExit(SERVER_EXIT.ok, reason),
        })
      : null
  const door = envelope.listeners.frontDoor
  if (door && envelope.owner.tokenHash) {
    try {
      doors = await startFrontDoorListeners({
        tokenHash: envelope.owner.tokenHash,
        runDir: envelope.runDir,
        loopback: door.loopback,
        onAdmitted: (purpose, stream) => serveFrontDoorPurpose(server, purpose, stream, log),
        ...(idle ? { onOpenCount: (count: number) => idle.connections(count) } : {}),
        log,
      })
    } catch (error) {
      idle?.dispose()
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

  await loginEnvironment
  const environmentId = readStudioEnvironmentId(envelope.dataDir)
  // The record the next client's probe and relay read. Written once the doors
  // are open, removed first when the server stops, so a record names a
  // server that can be reached (a crash leaves one, which the run lock's
  // dead holder tells apart).
  if (detached && frontDoor?.socketPath) {
    writeServerRecord(envelope.runDir, {
      v: 1,
      pid: process.pid,
      version: envelope.app.version,
      origin: detached.origin,
      startedBy: detached.startedBy,
      startedAt: new Date().toISOString(),
      hostId: readHostId(),
      environmentId,
      socketPath: frontDoor.socketPath,
      backendWire: BACKEND_WIRE_VERSION,
      dataDir: envelope.dataDir,
    })
  }
  return {
    environmentId,
    gatewaySocket: server.ready.gatewaySocket,
    tailnetBound: null,
    ...(frontDoor ? { frontDoor } : {}),
    stop: async ({ onLeg }) => {
      idle?.dispose()
      if (detached) rmSync(join(envelope.runDir, 'server.json'), { force: true })
      // The front door first, so nothing new arrives while the core closes.
      if (doors) await runShutdownLegs([['front door', () => doors?.close()]], onLeg)
      await server.stop(onLeg)
    },
  }
}
