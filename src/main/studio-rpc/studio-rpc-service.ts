import { randomUUID } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { toolError, toolSuccess } from '../../shared/modules/mcp-tools'
import type { StudioLocalAppOfferView, StudioLocalAppsStatus } from '../../shared/studio-local-apps'
import { createStudioRpcServer, type StudioRpcServer } from '../../server/rpc/studio-rpc-server'
import type {
  StudioAuditEntry,
  StudioAuthenticator,
  StudioConversationBackend,
} from '../../server/rpc/studio-rpc-types'
import type { GatewayAuditStore } from '../automation/gateway-audit'
import { createResyncBackoff } from '../automation/tailnet/tailnet-conversation-stream'
import { createStudioLocalAppStore, type StudioLocalAppStore } from './studio-local-app-store'

// The Studio RPC inside the running app: the owner socket in <userData>/run,
// the paired local apps it admits, and the Settings front door that pairs and
// revokes them. Started with the app and stopped with it; a listener that
// cannot start (another Studio on this profile, a directory someone else owns)
// is reported in Settings and changes nothing else the app does.

export const STUDIO_ENVIRONMENT_FILENAME = 'studio-environment.json'

export type StudioRpcService = {
  start(): Promise<void>
  stop(): Promise<void>
  getStatus(): StudioLocalAppsStatus
  /** Mint a one-time pairing code for an app, named and scoped in Settings. */
  offer(input: unknown): StudioLocalAppOfferView
  cancelOffer(id: unknown): StudioLocalAppsStatus
  revoke(id: unknown): StudioLocalAppsStatus
  /** This run's owner credential, for the desktop's own client. Never written to disk. */
  ownerToken(): string
}

export type StudioRpcServiceOptions = {
  resolveUserDataDir: () => string
  appVersion: string
  /** Built on first start: the conversation host it wraps is constructed late in the app's composition. */
  backend: () => StudioConversationBackend
  /** The gateway's audit, so one file records every listener's mutations. */
  audit: () => GatewayAuditStore
  onChanged?: (status: StudioLocalAppsStatus) => void
  log?: (message: string) => void
  /** A socket path or pipe name of the caller's choosing (tests). */
  socketPath?: string
}

/**
 * The id this data directory is known by to every client, minted the first
 * time it is asked for and kept for good, so a client that reaches this
 * Studio by two routes recognises it as one.
 */
export function readStudioEnvironmentId(userDataDir: string): string {
  const path = join(userDataDir, STUDIO_ENVIRONMENT_FILENAME)
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { id?: unknown }
    if (typeof stored.id === 'string' && /^[0-9a-f-]{36}$/.test(stored.id)) return stored.id
  } catch {
    // Absent or unreadable: minted below.
  }
  const id = randomUUID()
  writeFileSync(path, `${JSON.stringify({ id }, null, 2)}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(path, 0o600)
  return id
}

export function createStudioRpcService(options: StudioRpcServiceOptions): StudioRpcService {
  let store: StudioLocalAppStore | null = null
  let server: StudioRpcServer | null = null
  let lastError: string | null = null
  let starting: Promise<void> | null = null

  const appStore = (): StudioLocalAppStore => {
    if (!store) {
      store = createStudioLocalAppStore({ resolveUserDataDir: options.resolveUserDataDir, log: options.log })
      store.onChanged(() => announce())
    }
    return store
  }

  function status(): StudioLocalAppsStatus {
    const connected = new Set(
      (server?.connections() ?? []).map((connection) => connection.clientId()).filter((id) => id !== null),
    )
    return {
      running: server?.isRunning() ?? false,
      socketPath: server?.socketPath() ?? null,
      lastError,
      apps: appStore()
        .list()
        .map((app) => ({ ...app, connected: connected.has(app.id) })),
      offers: appStore().offers(),
    }
  }
  function announce(): void {
    try {
      options.onChanged?.(status())
    } catch (error) {
      options.log?.(`Local apps push failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function authenticator(apps: StudioLocalAppStore): StudioAuthenticator {
    return {
      authenticate(auth) {
        if ('pairingCode' in auth) {
          const redeemed = apps.redeem(auth.pairingCode)
          return redeemed.ok
            ? { ok: true, grant: redeemed.grant, pairingToken: redeemed.token }
            : { ok: false, message: redeemed.message }
        }
        const grant = apps.authenticate(auth.token)
        return grant
          ? { ok: true, grant }
          : {
              ok: false,
              message: 'This app is not paired with Studio, or its pairing was revoked. Pair it again in Settings.',
            }
      },
      grantFor: (clientId) => apps.grantFor(clientId),
      onRevoked: (listener) => apps.onRevoked(listener),
      // A grant is fixed at pairing; it changes only by revocation.
      onGrantChanged: () => () => undefined,
      recordSeen: (clientId) => apps.recordSeen(clientId),
    }
  }

  // One record per mutation and per refusal at the door, into the gateway's
  // own audit: the app is the connection, the conversation and command id the
  // targets. A message's text never reaches it.
  function audit(entry: StudioAuditEntry): void {
    options.audit().record({
      connection: {
        kind: 'studio-client',
        ...(entry.clientId ? { clientId: entry.clientId } : {}),
        clientName: entry.clientName,
      },
      tool: entry.tool,
      durationMs: entry.durationMs,
      args: {
        ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
        ...(entry.agentId ? { agentId: entry.agentId } : {}),
        ...(entry.commandId ? { id: entry.commandId } : {}),
      },
      result: entry.ok
        ? toolSuccess({ ok: true })
        : toolError(entry.code ?? 'refused', 'The Studio RPC request was not carried out.'),
    })
  }

  async function startNow(): Promise<void> {
    const dataDir = options.resolveUserDataDir()
    const apps = appStore()
    const next = createStudioRpcServer({
      dataDir,
      version: options.appVersion,
      environmentId: readStudioEnvironmentId(dataDir),
      backend: options.backend(),
      authenticator: authenticator(apps),
      audit,
      resyncRetryAfterMs: createResyncBackoff(),
      onConnectionsChanged: () => announce(),
      ...(options.socketPath ? { socketPath: options.socketPath } : {}),
      log: options.log,
    })
    try {
      await next.start()
      server = next
      lastError = null
    } catch (error) {
      lastError = `The local app socket did not start: ${error instanceof Error ? error.message : String(error)}`
      options.log?.(lastError)
    }
    announce()
  }

  return {
    start() {
      if (server?.isRunning()) return Promise.resolve()
      starting ??= startNow().finally(() => {
        starting = null
      })
      return starting
    },
    async stop() {
      await starting
      const current = server
      server = null
      await current?.stop()
    },
    getStatus: status,
    offer(input) {
      const { offer, code } = appStore().offer(input)
      return { offer, code, status: status() }
    },
    cancelOffer(id) {
      if (typeof id === 'string') appStore().cancelOffer(id)
      return status()
    },
    revoke(id) {
      if (typeof id === 'string') appStore().revoke(id)
      return status()
    },
    ownerToken: () => appStore().ownerToken(),
  }
}
