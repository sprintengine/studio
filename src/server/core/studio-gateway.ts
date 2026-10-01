import { parseCliPermissionPreset } from '../../shared/cli-permission-preset'
import type { McpToolRegistration } from '../../shared/modules/mcp-tools'
import type { ConversationEventType } from '../../shared/conversation-runtime'
import { createAutomationService } from '../../main/automation/automation-service'
import { createConversationTools } from '../../main/automation/conversation-tools'
import { launchPermissionCeiling } from '../../main/automation/launch-permission-cap'
import { createStudioGatewayTools } from '../../main/automation/studio-gateway-tools'
import { createConversationGatewayHost } from '../../main/automation/tailnet/tailnet-conversation-host'
import { writeDiagnosticLog } from '../../main/diagnostics-service'
import type { McpToolContribution } from '../../main/module-host/main-host'
import { studioBridgeScriptPath, type StudioCore } from './studio-core'

// The Studio MCP gateway over a core: the always-on socket agents reach the
// app through, the opt-in tailnet listener, and the conversation lane paired
// devices follow chats on. Composed beside the core rather than inside it,
// because the desktop adds tools that act on what only it has (windows,
// terminals, the browser pane, the canvas worker); a standalone server serves
// the core's own tools alone.

/** The conversation events that change what a paired device's list says: a start, an end, a phase. */
const CONVERSATION_LIST_EVENTS = new Set<ConversationEventType>([
  'session_started',
  'session_closed',
  'user_message',
  'turn_started',
  'turn_completed',
  'turn_failed',
  'approval_requested',
  'approval_resolved',
])

export type StudioGatewayOptions = Pick<
  Parameters<typeof createAutomationService>[0],
  'onTailnetEvent' | 'onMeshEvent' | 'hasWindow'
> & {
  /**
   * The gateway's app tools, given the core's own: the desktop places them
   * among its window and terminal tools, a server serves them as they are. The
   * order is the order agents list them in.
   */
  appTools?: (coreTools: McpToolRegistration[]) => McpToolRegistration[]
  /** Module-contributed tools, from the host kernel; empty until modules load. */
  resolveModuleTools?: () => ReadonlyArray<McpToolContribution>
  /** Live enablement of a contributing module; resolved per call, never captured. */
  isModuleEnabled?: (moduleId: string) => boolean
}

export type StudioGateway = ReturnType<typeof createStudioGateway>

export function createStudioGateway(core: StudioCore, options: StudioGatewayOptions = {}) {
  const { platform, workspaceRegistry, workspaceSyncService, conversations } = core
  const coreTools = createConversationTools({
    launch: (request) => core.conversationLaunchService.launch(request),
    resolveAgentPermissionPreset: core.resolveAgentPermissionPreset,
  })

  const automationService = createAutomationService({
    resolveUserDataDir: () => platform.paths.dataDir(),
    appVersion: platform.identity.version(),
    resolveBridgeScriptPath: () => studioBridgeScriptPath(platform.paths),
    ...(options.onTailnetEvent ? { onTailnetEvent: options.onTailnetEvent } : {}),
    ...(options.onMeshEvent ? { onMeshEvent: options.onMeshEvent } : {}),
    ...(options.hasWindow ? { hasWindow: options.hasWindow } : {}),
    resolveConversationHost: () =>
      createConversationGatewayHost(
        conversations,
        (workspaceId) => workspaceRegistry.getRecord(workspaceId)?.folderPath ?? null,
        () =>
          workspaceRegistry
            .getRecords()
            .filter((record) => Boolean(record.folderPath))
            .map((record) => ({
              workspaceId: record.id,
              workspaceRoot: record.folderPath!,
            })),
        // A chat's own agent record carries the preset the person last chose
        // for it; a chat without one starts on the app-wide spawn default, as a
        // new chat in a window does.
        (key) =>
          parseCliPermissionPreset(
            workspaceRegistry.getRecord(key.workspaceId)?.agents[key.agentId]?.cliPermissionPreset,
          ) ?? core.defaultSpawnPermissionPreset(),
        // The agent record's name — the same record, and the same field, this
        // desktop's tab and sidebar read — so a remote lists the chat by the
        // name it has here rather than by its first message.
        (key) => workspaceRegistry.getRecord(key.workspaceId)?.agents[key.agentId]?.name,
        // The chat's CLI catalog as this machine's own picker lists it, so a
        // paired device offers the same models and can switch to no other.
        core.conversationModelCatalog,
      ),
    // The gateway's tool set: core app tools + canonical run tools merged once,
    // module-contributed tools read from the host kernel per request
    // and gated on their owner's live enablement.
    resolveGatewayTools: createStudioGatewayTools({
      resolveModuleTools: () => options.resolveModuleTools?.() ?? [],
      isModuleEnabled: (moduleId) => options.isModuleEnabled?.(moduleId) ?? false,
      // A module tool runs under its caller's launch cap, so a chat the module
      // starts for a capped agent is no looser than that agent.
      callerPermissionCeiling: (context) => launchPermissionCeiling(context, core.resolveAgentPermissionPreset),
      warn: (details) => {
        void writeDiagnosticLog({
          level: 'warning',
          source: 'workspace',
          title: 'Studio MCP gateway',
          message: 'Studio MCP gateway',
          details,
        })
      },
      appTools: options.appTools ? options.appTools(coreTools) : coreTools,
    }),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  // The change feed (2026-09-05): paired devices used to poll workspace.list
  // every thirty seconds; now the registry's accepted events become one small
  // push, throttled in the listener so a burst here is one push there, and a
  // device re-reads only when told to.
  workspaceSyncService.subscribeEvents(() => automationService.notifyWorkspacesChanged())
  // A conversation's row on another machine shows its phase: running, waiting
  // on a person, done. The events that move it (never a token of a reply)
  // become the same throttled push.
  conversations.onEvent((event) => {
    if (CONVERSATION_LIST_EVENTS.has(event.type)) automationService.notifyConversationsChanged()
  })

  return automationService
}
