import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createFilesystemReadHandlers } from '../../main/filesystem-read'
import { createFilesystemWatchSearchHandlers } from '../../main/filesystem-watch-search-handlers'
import { GitHubTokenStore } from '../../main/github-token-store'
import type { StudioRpcService } from '../../main/studio-rpc/studio-rpc-service'
import { createWorkspaceBackupService } from '../../main/workspace-backup'
import type { StudioCore } from '../core/studio-core'
import type { StudioGateway } from '../core/studio-gateway'
import { registerServerDomainIpc, type ServerDomainIpcHandles } from '../desktop/server-ipc'
import { createIpcTunnel } from '../ipc/ipc-tunnel'
import type { LocalClientBus } from '../platform/client-bus'
import type { StudioAuthenticator } from '../rpc/studio-rpc-types'
import { WEB_BROWSE_FOLDERS_CHANNEL } from '../../shared/web-client'
import { browseFolders, type FolderBrowserInput } from './folder-browser'
import { createWebListener, type WebExtraRoute, type WebListener } from './web-listener'
import { createWebSessionStore, type WebSessionStore, type WebTicketSubject } from './web-sessions'
import { openWebStaticRoot } from './web-static'
import { WEB_RUN_FILENAME, readWebRunFile, type WebRunFile } from './web-run-file'

// The web client's side of a standalone server (phase 9): the web listener,
// the browser sessions it admits, and what a web tab reaches through it. Off
// unless `studio-server serve --web` asks for it, so a server nobody opened a
// browser to answers no HTTP at all.
//
// A web tab is Studio's own renderer in a browser. It reaches the server two
// ways, both over the listener and both behind its session cookie:
//
// - the Studio protocol (`/ws`), which the chat view rides as it does in a
//   desktop window;
// - the `window.api` domains the server owns, over the same IPC tunnel the
//   desktop's windows use when the server runs out of process (`/ws/ipc`,
//   owner sessions only). Phase 10 turns those channels into protocol methods
//   one domain at a time; until then the tunnel is how the renderer's
//   workspace list, launch settings and the rest reach a server it does not
//   share a process with.
//
// The run file (`run/web.json`, 0600 in the owner-only `run/`) says where the
// listener is and holds the key `studio-server pair` mints a code with: being
// able to read it is being this server's owner on this machine.

export type WebFrontDoorOptions = {
  port: number
  publicOrigins: readonly string[]
  devOrigin?: string | null
  /** Where `build:web` wrote the bundle. */
  staticDir: string | null
  /** Third-party renderer modules on the web (R61): off unless the owner switches them on. */
  thirdPartyModules?: boolean
}

export type WebFrontDoor = {
  listener: WebListener
  sessions: WebSessionStore
  url: string
  stop(): Promise<void>
}

/** The authenticator a session's socket says hello under: the cookie was the proof, at the upgrade. */
export function sessionAuthenticator(sessions: WebSessionStore, sessionId: string): StudioAuthenticator {
  const clientId = `web:${sessionId}`
  return {
    authenticate() {
      const grant = sessions.grantFor(sessionId)
      return grant
        ? { ok: true, grant }
        : { ok: false, message: 'This browser’s pairing was removed or has expired. Pair it again.' }
    },
    grantFor: (id) => (id === clientId ? sessions.grantFor(sessionId) : null),
    onRevoked: (listener) =>
      sessions.onRevoked((revoked) => {
        if (revoked === sessionId) listener(clientId)
      }),
    onGrantChanged: () => () => undefined,
    recordSeen: () => sessions.recordSeen(sessionId),
  }
}

export async function startWebFrontDoor(input: {
  core: StudioCore
  gateway: StudioGateway
  rpc: StudioRpcService
  clients: LocalClientBus
  environmentId: string
  version: string
  options: WebFrontDoorOptions
  /** Authenticators for tickets that are not a session's (the embed's). */
  ticketAuthenticator?: (subject: WebTicketSubject) => StudioAuthenticator | null
  extraRoutes?: readonly WebExtraRoute[]
  log?: (message: string) => void
}): Promise<WebFrontDoor> {
  const { core, gateway, rpc } = input
  const dataDir = core.platform.paths.dataDir()
  const sessions = createWebSessionStore({ dataDir, environmentId: input.environmentId, log: input.log })

  // The tunnel's clients are web tabs. Everything the server publishes to its
  // clients reaches them as the push it is in a desktop window.
  const tunnel = createIpcTunnel({ log: input.log })
  const stopForwarding = input.clients.subscribe((topic, payload, target) => tunnel.publish(topic, payload, target))
  let domains: ServerDomainIpcHandles | null = null
  domains = registerServerDomainIpc(tunnel.registry as unknown as Parameters<typeof registerServerDomainIpc>[0], {
    core,
    gateway,
    studioRpc: rpc,
    githubTokenStore: new GitHubTokenStore(),
    workspaceBackup: createWorkspaceBackupService({
      resolveUserDataDir: () => dataDir,
      readRegistry: () => core.workspaceRegistry.getState(),
      minRegistryIntervalMs: 10_000,
    }),
    // No terminals on the web (ruling a): a chat is not handed to one.
    terminalHandoff: async () => ({ ok: false, message: 'Terminals are not available in a browser.' }),
    files: { ...createFilesystemWatchSearchHandlers(), ...createFilesystemReadHandlers() },
    // The cookie checked at the upgrade is the check: only an owner's session reaches the tunnel.
    assertAppSender: () => undefined,
  })

  // The web tab's own channels, beside the domains every window reaches.
  tunnel.registry.handle(WEB_BROWSE_FOLDERS_CHANNEL, (_event, request: FolderBrowserInput) =>
    browseFolders(request ?? {}),
  )

  const mintKey = randomBytes(32).toString('base64url')
  const listener = createWebListener({
    sessions,
    staticRoot:
      input.options.staticDir && existsSync(input.options.staticDir)
        ? openWebStaticRoot(input.options.staticDir)
        : null,
    port: input.options.port,
    publicOrigins: input.options.publicOrigins,
    devOrigin: input.options.devOrigin ?? null,
    mintKey,
    version: input.version,
    thirdPartyModules: () => input.options.thirdPartyModules === true,
    studio: {
      connect(stream, who) {
        if ('session' in who) {
          rpc.connectWeb(stream, {
            authenticator: sessionAuthenticator(sessions, who.session.id),
            ownWindow: who.session.owner,
          })
          return
        }
        const authenticator =
          who.ticket.kind === 'session'
            ? sessionAuthenticator(sessions, who.ticket.sessionId)
            : (input.ticketAuthenticator?.(who.ticket) ?? null)
        if (!authenticator) {
          stream.destroy()
          return
        }
        rpc.connectWeb(stream, { authenticator, ownWindow: false })
      },
    },
    tunnel: { attach: (client, port) => tunnel.attach(client, port), detach: (clientId) => tunnel.detach(clientId) },
    extraRoutes: input.extraRoutes,
    log: input.log,
  })
  const { port } = await listener.start()
  const url = `http://127.0.0.1:${port}`

  const runFile = join(dataDir, 'run', WEB_RUN_FILENAME)
  const body: WebRunFile = { pid: process.pid, port, url, origins: listener.origins(), mintKey }
  const staged = `${runFile}.${process.pid}.tmp`
  writeFileSync(staged, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(staged, 0o600)
  renameSync(staged, runFile)

  return {
    listener,
    sessions,
    url,
    async stop() {
      stopForwarding()
      await listener.stop()
      for (const client of tunnel.clients()) tunnel.detach(client.clientId)
      await domains?.conversationCommands.dispose().catch(() => undefined)
      domains = null
      // Only this run's file: another server may have written its own since.
      if (readWebRunFile(dataDir)?.pid === process.pid) {
        try {
          unlinkSync(runFile)
        } catch {
          // Already gone.
        }
      }
    },
  }
}
