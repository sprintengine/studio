import { BrowserWindow, app } from 'electron'

import { createLocalAutomationExecutor, defaultRemoveRunWorktree } from '../automations/executor-local'
import { openAutomationRunPullRequest } from '../automations/pull-request'
import {
  automationApprovalLedgerPath,
  createAutomationApprovalLedger,
  type AutomationApprovalLedger,
} from '../automations/approval-ledger'
import {
  AUTOMATION_NEEDS_APPROVAL_CODE,
  createAutomationsEngine,
  projectFoldersFromWorkspaceSyncSnapshot,
  type AutomationsEngine,
  type AutomationsEngineEvaluationResult,
  type AutomationsEngineOptions,
} from '../automations/engine'
import {
  allowAutomationProvider,
  createBuiltInAutomationProviderRegistry,
  executableTriggerProviders,
  type AutomationProviderPermissionChecker,
} from '../automations/provider-registry'
import { createModuleAutomationsRegistry } from '../automations/module-service'
import { AutomationsStore } from '../automations/store'
import { registerAutomationsIpc } from '../ipc/automations-ipc'
import {
  AutomationsAppFrontDoorToken,
  AutomationsEngineToken,
  AutomationsModuleServiceToken,
  AutomationsProviderRegistryToken,
  WorkspaceSyncServiceToken,
} from '../module-host/service-tokens'
import { ConversationLaunchServiceToken, ConversationRuntimeToken } from '../module-host/conversation-launch-token'
import type { CapabilityModule } from '../module-host/load-modules'
import {
  AUTOMATIONS_DEFINITIONS_CHANGED_CHANNEL,
  AUTOMATIONS_RUN_EVENT_CHANNEL,
  type AutomationsDefinitionsChangedEvent,
  type AutomationsRunEvent,
} from '../../shared/automations/contracts'
import { createAutomationWebhookReceiver } from '../automations/webhook-receiver'
import { summarizeConversationReply } from '../automations/transcript-summary'
import { powerActivity } from '../power-activity'
import { conversationWorkingRoot } from '../../shared/agent-state'
import type { ConversationEvent } from '../../shared/conversation-runtime'

export type AutomationsModuleOptions = {
  createEngine?: (options: AutomationsEngineOptions) => AutomationsEngine
  deliverRunEvent?: (event: AutomationsRunEvent) => void
  checkProviderPermission?: AutomationProviderPermissionChecker
  /** Defaults to the ledger file in userData; injected by tests. */
  approvalLedger?: AutomationApprovalLedger
}

type RunEventWindow = {
  isDestroyed(): boolean
  webContents: {
    isDestroyed(): boolean
    send(channel: string, payload: AutomationsRunEvent | AutomationsDefinitionsChangedEvent): void
  }
}

export function broadcastAutomationsRunEvent(
  event: AutomationsRunEvent,
  windows: readonly RunEventWindow[] = BrowserWindow.getAllWindows(),
): void {
  for (const window of windows) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    try {
      window.webContents.send(AUTOMATIONS_RUN_EVENT_CHANNEL, event)
    } catch {
      // Keep run-event delivery best-effort per renderer window.
    }
  }
}

function broadcastAutomationsDefinitionsChanged(
  event: AutomationsDefinitionsChangedEvent,
  windows: readonly RunEventWindow[] = BrowserWindow.getAllWindows(),
): void {
  for (const window of windows) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    try {
      window.webContents.send(AUTOMATIONS_DEFINITIONS_CHANGED_CHANNEL, event)
    } catch {
      // Keep delivery best-effort per renderer window.
    }
  }
}

export function createAutomationsModule(options: AutomationsModuleOptions = {}): CapabilityModule {
  return {
    manifest: {
      id: 'automations',
      displayName: 'Automations',
      version: 1,
      publisher: 'sprintengine',
      category: 'orchestration',
      summary: 'Local-first scheduled chat-agent automations with run history and module-gated execution.',
      defaultEnabled: true,
      dependsOn: ['agent-runtime'],
    },
    registerMain(host) {
      const conversationLaunchService = host.requireService(ConversationLaunchServiceToken)
      const conversationRuntime = host.requireService(ConversationRuntimeToken)
      const workspaceSyncService = host.requireService(WorkspaceSyncServiceToken)
      const providerRegistry = createBuiltInAutomationProviderRegistry()
      const checkProviderPermission = options.checkProviderPermission ?? allowAutomationProvider
      // One ledger for every door onto the automations: the engine and webhook
      // receiver ask it, and the write paths and the review's Allow record to it.
      const approvalLedger =
        options.approvalLedger ??
        createAutomationApprovalLedger({ filePath: () => automationApprovalLedgerPath(app.getPath('userData')) })
      host.provideService(AutomationsProviderRegistryToken, () => providerRegistry)
      const getTriggerProviderRegistrations = () => providerRegistry.listTriggerProviderRegistrations()
      const getActionProviderRegistrations = () => providerRegistry.listActionProviderRegistrations()
      const getTriggerProviders = () =>
        executableTriggerProviders(getTriggerProviderRegistrations(), checkProviderPermission)
      // Late-bound: the executor reports a refused first message to the
      // engine, which is created after it.
      let engineRef: AutomationsEngine | undefined
      const runAutomation = createLocalAutomationExecutor({
        launchConversation: (request) => conversationLaunchService.launch(request),
        reportConversationEnd: (event) => void engineRef?.finalizeRunOnConversationEnd(event),
        createWorkspace: (input, actor) => workspaceSyncService.createWorkspace(input, actor),
        getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
        getActionProviderRegistrations,
        checkProviderPermission,
      })
      const liveSession = (sessionId: string) => {
        const listed = conversationRuntime.listSessions()
        return listed.ok ? listed.sessions.find((session) => session.sessionId === sessionId) : undefined
      }
      // Late-bound: the registry needs the webhook receiver's refresh (created
      // below, after the engine), while the engine's run-event callback needs
      // the registry. The renderer broadcast is unchanged; module subscribers
      // are notified alongside it, filtered by automation ownership.
      let moduleAutomations: ReturnType<typeof createModuleAutomationsRegistry> | undefined
      const deliverRunEvent = options.deliverRunEvent ?? broadcastAutomationsRunEvent

      // A definition that starts waiting for approval without a write through
      // the app — a `git pull` changed it, a clone brought it — is first seen
      // by the engine. Tell the windows when one does, so the Automations
      // screen and the run supervisor's notice pick it up now rather than on
      // the next write. Only a newly waiting one: announcing every pass would
      // re-read every project each time the scheduler woke.
      let waitingForApproval = new Set<string>()
      const announceNewlyWaiting = (result: AutomationsEngineEvaluationResult): void => {
        const waiting = new Map<string, string>()
        for (const problem of result.problems) {
          if (problem.code !== AUTOMATION_NEEDS_APPROVAL_CODE || !problem.workspaceRoot || !problem.automationId) {
            continue
          }
          waiting.set(`${problem.workspaceRoot}\u0000${problem.automationId}`, problem.workspaceRoot)
        }
        const roots = new Set<string>()
        for (const [key, workspaceRoot] of waiting) if (!waitingForApproval.has(key)) roots.add(workspaceRoot)
        waitingForApproval = new Set(waiting.keys())
        for (const workspaceRoot of roots) broadcastAutomationsDefinitionsChanged({ workspaceRoot })
      }

      const engine = host.provideService(AutomationsEngineToken, () =>
        (options.createEngine ?? createAutomationsEngine)({
          approvals: approvalLedger,
          onEvaluation: announceNewlyWaiting,
          getWorkspaceSnapshot: () => workspaceSyncService.getSnapshot(),
          getTriggerProviders,
          runAutomation,
          onRunEvent: (event, definition) => {
            deliverRunEvent(event)
            moduleAutomations?.deliverRunEvent(event, definition)
          },
          openRunPullRequest: (input) =>
            openAutomationRunPullRequest({
              worktreePath: input.worktreePath,
              branch: input.branch,
              title: input.title,
              body: input.body,
            }),
          removeRunWorktree: defaultRemoveRunWorktree,
          // Disposing the run's chat is main's own work: its session is
          // stopped and its record removed through the sequenced workspace bus,
          // so every window drops the chat with no window needing to be open —
          // and nobody is left able to type into a chat whose worktree is gone.
          disposeRunAgent: async (input) => {
            const listed = conversationRuntime.listSessions({ workspaceId: input.workspaceId, agentId: input.agentId })
            for (const session of listed.ok ? listed.sessions : []) {
              if (session.status === 'stopped') continue
              await conversationRuntime.stopSession({ sessionId: session.sessionId }).catch(() => undefined)
            }
            workspaceSyncService.updateWorkspaceAgent(input.workspaceId, input.agentId, null, 'automation')
          },
          getLiveConversationSessionIds: () => {
            const listed = conversationRuntime.listSessions()
            return listed.ok
              ? listed.sessions.filter((session) => session.status !== 'stopped').map((session) => session.sessionId)
              : []
          },
          // The run's closing message, read from its conversation before its
          // worktree (where a worktree chat keeps its transcript) is removed.
          readRunConversationSummary: async (input) => {
            if (!input.workspaceId || !input.agentId) return undefined
            const workspace = workspaceSyncService
              .getSnapshot()
              .state.workspaces.find((candidate) => candidate.id === input.workspaceId)
            const workspaceRoot = conversationWorkingRoot(
              workspace?.agents[input.agentId],
              workspace?.folderPath ?? null,
            )
            if (!workspaceRoot) return undefined
            const transcript = await conversationRuntime.readTranscript({
              workspaceRoot,
              workspaceId: input.workspaceId,
              agentId: input.agentId,
            })
            return transcript.ok ? summarizeConversationReply(transcript.events) : undefined
          },
        }),
      )
      engineRef = engine

      // Conversation finalize triggers. Every chat's events pass through; the
      // engine owns the match-vs-ignore decision, and the module only routes.
      //
      // A turn's end is the primary channel: a run finalizes when its agent's
      // turn ends and stays ended (settle window, guards and correlation all
      // live in the engine). A turn a steer closed carries on as the next one,
      // so it is not an end. The session closing is the secondary channel: a
      // conversation that closes without a turn end failed. The listener is
      // removed on module teardown so a live disable→enable cycle never leaks
      // one pointed at a stopped engine.
      const routeConversationEvent = (event: ConversationEvent): void => {
        const turn = { sessionId: event.sessionId, workspaceId: event.workspaceId, agentId: event.agentId }
        if (event.type === 'turn_started' || event.type === 'turn_failed') {
          void engine.noteConversationTurn({ type: event.type, ...turn })
        } else if (event.type === 'turn_completed') {
          if (event.payload?.steered === true) return
          void engine.noteConversationTurn({
            type: 'turn_completed',
            ...turn,
            backgroundAgents: liveSession(event.sessionId)?.backgroundAgents ?? 0,
          })
        } else if (event.type === 'subagent_status') {
          // The last background agent reporting back between turns: if the
          // conversation does not carry on, this is where its work ended.
          const session = liveSession(event.sessionId)
          if (session && !session.backgroundAgents && session.phase === 'completed' && !session.turnStartedAt) {
            void engine.noteConversationTurn({ type: 'turn_completed', ...turn, backgroundAgents: 0 })
          }
        } else if (event.type === 'session_closed') {
          const message = typeof event.payload?.message === 'string' ? event.payload.message : undefined
          void engine.finalizeRunOnConversationEnd({ reason: 'session_closed', ...turn, message })
        }
      }
      const unregisterConversationListener = conversationRuntime.onEvent(routeConversationEvent)
      host.onShutdown(() => {
        unregisterConversationListener()
      })
      const webhookReceiver = createAutomationWebhookReceiver({
        approvals: approvalLedger,
        getProjectFolders: () => projectFoldersFromWorkspaceSyncSnapshot(workspaceSyncService.getSnapshot()),
        deliverTriggerEvent: (input) => engine.deliverTriggerEvent(input),
      })

      // The module-scoped Automations service (SDK getAutomationsService).
      // Shares the write-path deps with registerAutomationsIpc below so both
      // front doors run the same definition-write core.
      // Runs after every definition write from either front door: refresh the
      // webhook receiver, then tell every window so an open Automations panel
      // reflects module-driven (and other-window) writes without a remount.
      // The scheduler sleeps until the next run it knows about, so a write that
      // adds or moves a schedule wakes it to re-read.
      const onDefinitionsChanged = async (workspaceRoot: string): Promise<void> => {
        engine.wake()
        try {
          await webhookReceiver.refresh()
        } finally {
          broadcastAutomationsDefinitionsChanged({ workspaceRoot })
        }
      }
      moduleAutomations = host.provideService(AutomationsModuleServiceToken, () =>
        createModuleAutomationsRegistry({
          createStore: (workspaceRoot) => new AutomationsStore(workspaceRoot),
          getTriggerProviderRegistrations,
          getActionProviderRegistrations,
          checkProviderPermission,
          now: Date.now,
          onDefinitionsChanged,
          getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
          approvalLedger,
        }),
      )
      const moduleAutomationsRegistry = moduleAutomations
      host.onShutdown(() => moduleAutomationsRegistry.dispose())

      let releaseEngineWakeOnResume: (() => void) | null = null
      const engineSidecar = host.registerSidecar(
        {
          id: 'automations-engine',
          kind: 'scheduler',
          description: 'App-active Automations scheduler; starts only while the Automations module is enabled.',
          startOn: 'startup',
        },
        {
          start: async () => {
            await webhookReceiver.refresh()
            engine.start()
            // A timer armed before a sleep only counts awake time, so a schedule
            // that came due during the nap is evaluated on waking, not whenever
            // the stretched timer finally fires.
            releaseEngineWakeOnResume?.()
            releaseEngineWakeOnResume = powerActivity.onResume(() => engine.wake())
          },
          stop: async () => {
            releaseEngineWakeOnResume?.()
            releaseEngineWakeOnResume = null
            await webhookReceiver.stop()
            engine.stop()
          },
          status: () => {
            const receiverStatus = webhookReceiver.status()
            return {
              state: receiverStatus.error ? 'failed' : engine.isRunning() ? 'running' : 'stopped',
              ...(receiverStatus.error ? { error: `Webhook receiver: ${receiverStatus.error}` } : {}),
            }
          },
        },
      )

      const appFrontDoor = registerAutomationsIpc(host, {
        engine,
        getTriggerProviderRegistrations,
        getActionProviderRegistrations,
        checkProviderPermission,
        getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
        getEngineSidecarStatus: () => engineSidecar.status(),
        onDefinitionsChanged,
        approvalLedger,
      })
      // The automation server's automation.create/automation.run resolve this
      // lazily; module disabled ⇒ token absent ⇒ explicit tool failure.
      host.provideService(AutomationsAppFrontDoorToken, () => appFrontDoor)
    },
  }
}
