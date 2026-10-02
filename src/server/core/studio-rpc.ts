import { writeDiagnosticLog } from '../../main/diagnostics-service'
import {
  conversationStartedBy,
  createStudioConversationBackend,
} from '../../main/studio-rpc/studio-conversation-backend'
import { createStudioRpcService, type StudioRpcService } from '../../main/studio-rpc/studio-rpc-service'
import { canvasBoardStoreDir } from '../../main/canvas/canvas-board-store'
import { createStudioFiles } from '../rpc/studio-files'
import type { StudioCore } from './studio-core'
import type { StudioGateway } from './studio-gateway'

// The Studio RPC over a core: the owner socket in `<dataDir>/run` that local
// applications follow, drive and start chats through. It serves the same
// conversation host the tailnet lane does, starts chats through the same
// launch service, and audits into the gateway's one log, which is why it is
// composed from both. The desktop and the standalone server build it here, so
// it is wired once; each starts it beside its gateway and stops it first. Its
// paths, version and the push to Settings are the core's platform's.

export function createStudioRpc(core: StudioCore, gateway: StudioGateway): StudioRpcService {
  const service = createStudioRpcService({
    paths: core.platform.paths,
    identity: core.platform.identity,
    clients: core.platform.clients,
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
    tools: gateway.clientTools,
    forgetToolApprovals: (toolsets) => core.approvalRules.forgetGatewayToolsets(toolsets),
    // A workspace's folder, and the board store Studio keeps for it under its
    // data directory: the canvas reads and writes its boards through these.
    files: createStudioFiles({
      resolveRoot: (root) => {
        const folder = core.workspaceSyncService
          .getSnapshot()
          .state.workspaces.find((workspace) => workspace.id === root.workspaceId)?.folderPath
        if (!folder) return null
        return root.kind === 'workspace' ? folder : canvasBoardStoreDir(core.platform.paths.dataDir(), folder)
      },
    }),
    log: (message) => {
      void writeDiagnosticLog({ level: 'warning', source: 'workspace', title: 'Local app socket', message })
    },
  })
  // An app's tools reach the chats it started, and as far as its pairing says.
  gateway.linkClientTools({
    reachOf: (clientId) => service.toolReachOf(clientId),
    startedBy: (conversation) =>
      conversationStartedBy(core.workspaceSyncService.getSnapshot().state.workspaces, conversation),
  })
  // Like the gateway, it binds only once a Studio server this desktop
  // displaced has gone: that server's listener still answers until then, and
  // this one would refuse to start beside it.
  return {
    ...service,
    start: async () => {
      await core.whenDataDirFree
      return service.start()
    },
  }
}
