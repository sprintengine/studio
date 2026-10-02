import type { McpToolRegistration } from '../../shared/modules/mcp-tools'
import type { ConversationEventType } from '../../shared/conversation-runtime'
import { createAutomationService } from '../../main/automation/automation-service'
import { createConversationTools } from '../../main/automation/conversation-tools'
import { launchPermissionCeiling } from '../../main/automation/launch-permission-cap'
import { createStudioGatewayTools } from '../../main/automation/studio-gateway-tools'
import { writeDiagnosticLog } from '../../main/diagnostics-service'
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

// The module host's contribution type, read off the tool set rather than
// imported from the host, whose file also names Electron's IPC types.
type GatewayToolsOptions = Parameters<typeof createStudioGatewayTools>[0]

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
  resolveModuleTools?: GatewayToolsOptions['resolveModuleTools']
  /** Live enablement of a contributing module; resolved per call, never captured. */
  isModuleEnabled?: (moduleId: string) => boolean
}

export type StudioGateway = ReturnType<typeof createStudioGateway>

export function createStudioGateway(core: StudioCore, options: StudioGatewayOptions = {}) {
  const { platform, workspaceSyncService, conversations } = core
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
    resolveConversationHost: core.createConversationHost,
    // The run lock's holder removes a stale socket; nobody else does. A desktop
    // that could not take the lock still may, as builds before it did: its
    // single-instance lock already rules out a second app on this profile.
    holdsDataDir: () => (core.dataDirLock ? core.dataDirLock.isHeld() : core.role === 'desktop'),
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

  // A desktop that displaced a Studio server from its data directory opens
  // the socket only once that server has exited: closing its listener
  // removes the socket file at the shared path, which would take the
  // desktop's new one with it. Agent launches wait on the same.
  return {
    ...automationService,
    initialize: async () => {
      await core.whenDataDirFree
      return automationService.initialize()
    },
    whenGatewayReady: async () => {
      await core.whenDataDirFree
      return automationService.whenGatewayReady()
    },
  }
}
