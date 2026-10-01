import type { StudioLocalAppsStatus } from '../../shared/studio-local-apps'
import { writeDiagnosticLog } from '../../main/diagnostics-service'
import { createStudioConversationBackend } from '../../main/studio-rpc/studio-conversation-backend'
import { createStudioRpcService, type StudioRpcService } from '../../main/studio-rpc/studio-rpc-service'
import type { StudioCore } from './studio-core'
import type { StudioGateway } from './studio-gateway'

// The Studio RPC over a core: the owner socket in `<dataDir>/run` that local
// applications follow, drive and start chats through. It serves the same
// conversation host the tailnet lane does, starts chats through the same
// launch service, and audits into the gateway's one log, which is why it is
// composed from both. The desktop and the standalone server build it here, so
// it is wired once; each starts it beside its gateway and stops it first.

export type StudioRpcOptions = {
  /** Paired apps or the listener changed (the desktop's Settings listens). */
  onChanged?: (status: StudioLocalAppsStatus) => void
}

export function createStudioRpc(
  core: StudioCore,
  gateway: StudioGateway,
  options: StudioRpcOptions = {},
): StudioRpcService {
  return createStudioRpcService({
    resolveUserDataDir: () => core.platform.paths.dataDir(),
    appVersion: core.platform.identity.version(),
    backend: () =>
      createStudioConversationBackend({
        host: core.createConversationHost(),
        launch: (request) => core.conversationLaunchService.launch(request),
        listSessions: (input) => core.conversations.listSessions(input),
        stopSession: (input) => core.conversations.stopSession(input),
        // The live workspace state the module conversation service reads too.
        getWorkspaceAgents: () => core.workspaceSyncService.getSnapshot().state.workspaces,
      }),
    audit: () => gateway.gatewayAudit(),
    ...(options.onChanged ? { onChanged: options.onChanged } : {}),
    log: (message) => {
      void writeDiagnosticLog({ level: 'warning', source: 'workspace', title: 'Local app socket', message })
    },
  })
}
