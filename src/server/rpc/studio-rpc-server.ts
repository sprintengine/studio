import { arch, platform } from 'node:os'

import {
  CONVERSATION_CAPABILITIES,
  CONVERSATION_PROTOCOL_MIN_SUPPORTED,
  CONVERSATION_PROTOCOL_VERSION,
  STUDIO_CAPABILITIES,
  STUDIO_PROTOCOL_MIN_SUPPORTED,
  STUDIO_PROTOCOL_VERSION,
  type StudioWelcomeFrame,
} from '../../../packages/studio-protocol/src/public'
import { createStudioRpcConnection } from './studio-rpc-connection'
import { createStudioRpcListener, type StudioRpcListener } from './studio-rpc-listener'
import { createStudioRpcRouter } from './studio-rpc-router'
import type { StudioAuditEntry, StudioAuthenticator, StudioConversationBackend } from './studio-rpc-types'

// The Studio RPC as one piece: the owner socket, a connection per client, and
// the router behind them. Main constructs it with the conversations it serves
// and who may connect; nothing here knows it is inside Electron.

/**
 * The conversation capabilities the socket serves: every one the contract
 * defines, but the two that describe the tailnet lane's own transport — a
 * picture route beside its WebSocket, and a `hello` frame on it, which here is
 * the connection's own handshake.
 */
export const STUDIO_RPC_CONVERSATION_CAPABILITIES: string[] = CONVERSATION_CAPABILITIES.filter(
  (capability) => capability !== 'conversation-images' && capability !== 'conversation-hello',
)

export type StudioRpcServerOptions = {
  dataDir: string
  version: string
  /** Minted once per data directory; see `StudioEnvironment.id`. */
  environmentId: string
  backend: StudioConversationBackend
  authenticator: StudioAuthenticator
  audit?: (entry: StudioAuditEntry) => void
  resyncRetryAfterMs?: (clientId: string) => number
  socketPath?: string
  helloTimeoutMs?: number
  maxConnections?: number
  log?: (message: string) => void
}

export type StudioRpcServer = StudioRpcListener

export function createStudioRpcServer(options: StudioRpcServerOptions): StudioRpcServer {
  const welcome = (): Omit<StudioWelcomeFrame, 't' | 'grant' | 'pairing'> => ({
    protocolVersion: STUDIO_PROTOCOL_VERSION,
    minProtocolVersion: STUDIO_PROTOCOL_MIN_SUPPORTED,
    server: { name: 'SprintEngine Studio', version: options.version },
    environment: { id: options.environmentId, hostKind: 'local', os: platform(), arch: arch() },
    capabilities: [...STUDIO_CAPABILITIES],
    conversation: {
      protocolVersion: CONVERSATION_PROTOCOL_VERSION,
      minProtocolVersion: CONVERSATION_PROTOCOL_MIN_SUPPORTED,
      capabilities: STUDIO_RPC_CONVERSATION_CAPABILITIES,
    },
  })
  const router = createStudioRpcRouter({ backend: options.backend, info: welcome, audit: options.audit })
  return createStudioRpcListener({
    dataDir: options.dataDir,
    version: options.version,
    ...(options.socketPath ? { socketPath: options.socketPath } : {}),
    ...(options.maxConnections ? { maxConnections: options.maxConnections } : {}),
    log: options.log,
    createConnection: (socket, connectionId, onClosed) =>
      createStudioRpcConnection({
        socket,
        connectionId,
        authenticator: options.authenticator,
        router,
        backend: options.backend,
        welcome,
        audit: options.audit,
        resyncRetryAfterMs: options.resyncRetryAfterMs,
        helloTimeoutMs: options.helloTimeoutMs,
        onClosed,
      }),
  })
}
