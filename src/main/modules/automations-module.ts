import { app, BrowserWindow } from 'electron'

import { createLocalAutomationExecutor, defaultRemoveRunWorktree } from '../automations/executor-local'
import { openAutomationRunPullRequest } from '../automations/pull-request'
import {
  createAutomationsEngine,
  projectFoldersFromWorkspaceSyncSnapshot,
  type AutomationsEngine,
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
  AutomationDelegateToken,
  AutomationsAppFrontDoorToken,
  AutomationsEngineToken,
  AutomationsModuleServiceToken,
  AutomationsProviderRegistryToken,
  RoadmapAppFrontDoorToken,
  SprintEngineAutomationFrontDoorsToken,
  SwitchboardAutomationFrontDoorsToken,
  TerminalRuntimeToken,
  WorkspaceSyncServiceToken,
} from '../module-host/service-tokens'
import type { CapabilityModule } from '../module-host/load-modules'
import {
  AUTOMATIONS_DEFINITIONS_CHANGED_CHANNEL,
  AUTOMATIONS_RUN_EVENT_CHANNEL,
  type AutomationsDefinitionsChangedEvent,
  type AutomationsRunEvent,
} from '../../shared/automations/contracts'
import {
  SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID,
  type SprintEngineAutomationFrontDoors,
} from '../automations/actions/sprint-engine'
import {
  SWITCHBOARD_AUTOMATION_INTEGRATION_ID,
  WATCHTOWER_AUTOMATION_INTEGRATION_ID,
  type SwitchboardAutomationFrontDoors,
} from '../automations/actions/switchboard'
import { createAutomationWebhookReceiver } from '../automations/webhook-receiver'
import { createRoadmapOrchestrator } from '../roadmap-orchestrator'
import { createRoadmapOrchestratorPorts } from '../roadmap-orchestrator-ports'
import { registerRoadmapOrchestratorIpc } from '../ipc/roadmap-orchestrator-ipc'
import { readRoadmapHomeProjectPath, writeRoadmapHomeProjectPath } from '../roadmap-home-store'

export type AutomationsModuleOptions = {
  createEngine?: (options: AutomationsEngineOptions) => AutomationsEngine
  deliverRunEvent?: (event: AutomationsRunEvent) => void
  checkProviderPermission?: AutomationProviderPermissionChecker
  // Live gate for the roadmap reconcile that rides the engine's evaluation tick
  // (MC-1691). The roadmap orchestrator is built here (D3: it has no timer of its
  // own), but the `roadmap` module toggles independently, so each tick asks
  // whether Roadmap is currently enabled before reconciling. Returning false
  // simply skips the pass — it starts no new sprint and never touches a running
  // one — so disabling Roadmap (or a dependency) stops new work without a reload
  // and without killing a live sprint. Defaults to always-on for tests.
  isRoadmapReconcileEnabled?: () => boolean
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
  windows: readonly RunEventWindow[] = BrowserWindow.getAllWindows()
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

export function broadcastAutomationsDefinitionsChanged(
  event: AutomationsDefinitionsChangedEvent,
  windows: readonly RunEventWindow[] = BrowserWindow.getAllWindows()
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
      publisher: 'multicode',
      category: 'orchestration',
      summary: 'Local-first scheduled agent automations with run history and module-gated execution.',
      defaultEnabled: true,
      dependsOn: ['agent-runtime'],
    },
    registerMain(host) {
      const automationDelegate = host.requireService(AutomationDelegateToken)
      const workspaceSyncService = host.requireService(WorkspaceSyncServiceToken)
      const terminalRuntime = host.requireService(TerminalRuntimeToken)
      const switchboardFrontDoors = serviceBackedSwitchboardFrontDoors(() =>
        host.getService(SwitchboardAutomationFrontDoorsToken)
      )
      const sprintEngineFrontDoors = serviceBackedSprintEngineFrontDoors(() =>
        host.getService(SprintEngineAutomationFrontDoorsToken)
      )
      const isIntegrationAvailable = createFirstPartyAutomationIntegrationResolver({
        hasSwitchboard: () => Boolean(host.getService(SwitchboardAutomationFrontDoorsToken)),
        hasSprintEngine: () => Boolean(host.getService(SprintEngineAutomationFrontDoorsToken)),
      })
      const providerRegistry = createBuiltInAutomationProviderRegistry({
        switchboard: switchboardFrontDoors,
        sprintEngine: sprintEngineFrontDoors,
        delegateToRenderer: (request) => automationDelegate.request(request),
      })
      const checkProviderPermission = options.checkProviderPermission ?? allowAutomationProvider
      host.provideService(AutomationsProviderRegistryToken, () => providerRegistry)
      const getTriggerProviderRegistrations = () => providerRegistry.listTriggerProviderRegistrations()
      const getActionProviderRegistrations = () => providerRegistry.listActionProviderRegistrations()
      const getTriggerProviders = () =>
        executableTriggerProviders(getTriggerProviderRegistrations(), checkProviderPermission)
      const runAutomation = createLocalAutomationExecutor({
        delegateToRenderer: (request) => automationDelegate.request(request),
        getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
        resolveAgentExecutionId: (input) => terminalRuntime.resolveAgentExecutionId(input),
        isIntegrationAvailable,
        getActionProviderRegistrations,
        checkProviderPermission,
      })
      // Late-bound: the registry needs the webhook receiver's refresh (created
      // below, after the engine), while the engine's run-event callback needs
      // the registry. The renderer broadcast is unchanged; module subscribers
      // are notified alongside it, filtered by automation ownership.
      let moduleAutomations: ReturnType<typeof createModuleAutomationsRegistry> | undefined
      const deliverRunEvent = options.deliverRunEvent ?? broadcastAutomationsRunEvent

      // The roadmap orchestrator (MC-1619): a main-process reconciler one level up
      // from the pool supervisor that walks each active roadmap lane. It owns no
      // timer — it rides the automations engine's evaluation tick below
      // (`onEvaluation`), so it extends this engine rather than standing up a new
      // runtime, and consumes existing run/PR machinery through the shared front
      // doors. Reconcile is single-flight and fail-soft, so a slow or throwing
      // pass never blocks the engine tick that triggered it.
      // The instance roadmap lives in a designated HOME PROJECT (D1), recorded as
      // an app-level setting under userData. The orchestrator reads it every
      // reconcile; the creation flow (MC-1689) sets it over the home IPC below.
      const userDataDir = app.getPath('userData')
      const roadmapOrchestrator = createRoadmapOrchestrator(
        createRoadmapOrchestratorPorts({
          frontDoors: sprintEngineFrontDoors,
          delegateToRenderer: (request) => automationDelegate.request(request),
          getHomeProjectRoot: () => readRoadmapHomeProjectPath(userDataDir),
          // All open roots — used to resolve a `projects:` alias path to a known
          // workspace root (an unresolvable alias parks the lane `unknown_project`).
          getWorkspaceRoots: () =>
            projectFoldersFromWorkspaceSyncSnapshot(workspaceSyncService.getSnapshot()).map(
              (folder) => folder.folderPath,
            ),
          notify: (input) => host.notify(input),
        }),
      )
      registerRoadmapOrchestratorIpc(host.ipcMain, roadmapOrchestrator, {
        getHomeProjectPath: () => readRoadmapHomeProjectPath(userDataDir),
        setHomeProjectPath: (path) => writeRoadmapHomeProjectPath(userDataDir, path),
      })
      // Expose the instance roadmap's read + plan + steer surface to app-level
      // callers (the automation server's roadmap.* tools), resolved lazily like the
      // Automations front door — the orchestrator's public API is a superset of it.
      host.provideService(RoadmapAppFrontDoorToken, () => roadmapOrchestrator)

      const engine = host.provideService(AutomationsEngineToken, () =>
        (options.createEngine ?? createAutomationsEngine)({
          getWorkspaceSnapshot: () => workspaceSyncService.getSnapshot(),
          getTriggerProviders,
          isIntegrationAvailable,
          runAutomation,
          onEvaluation: () => {
            // Off means off: when the roadmap module is disabled, skip reconcile
            // entirely so no new sprint is started. A sprint already running is
            // owned by the pool supervisor, untouched by skipping this tick.
            if (options.isRoadmapReconcileEnabled && !options.isRoadmapReconcileEnabled()) return
            void roadmapOrchestrator.reconcile().catch(() => undefined)
          },
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
              autonomy: input.autonomy,
            }),
          removeRunWorktree: defaultRemoveRunWorktree,
          disposeRunAgent: (input) =>
            automationDelegate
              .request({ kind: 'agent.dispose', workspaceId: input.workspaceId, agentId: input.agentId })
              .then(() => undefined),
          getLiveAgentExecutionIds: () =>
            terminalRuntime.getLiveAgentExecutionIds().map((execution) => execution.executionId),
        })
      )

      // Agent-lifecycle finalize triggers. The engine owns the match-vs-ignore
      // decision for both; the module only routes.
      //
      // Phase transitions are the primary channel: an agent-backed run finalizes
      // when its agent ends its turn (settle window, guards, and correlation all
      // live in the engine). The pty exit is the secondary channel: an agent that
      // dies without a turn end failed. Both unregister on module teardown so a
      // live disable→enable cycle never leaks a listener pointed at a stopped
      // engine.
      const unregisterAgentPhaseListener = terminalRuntime.registerAgentPhaseListener((event) =>
        engine.noteAgentPhase(event)
      )
      const unregisterAgentExitListener = terminalRuntime.registerAgentSessionExitListener((event) =>
        engine.finalizeRunOnAgentExit({
          executionId: event.executionId,
          workspaceId: event.workspaceId,
          agentId: event.agentId,
          exitCode: event.exitCode,
        })
      )
      host.onShutdown(() => {
        unregisterAgentPhaseListener()
        unregisterAgentExitListener()
      })
      const webhookReceiver = createAutomationWebhookReceiver({
        getProjectFolders: () => projectFoldersFromWorkspaceSyncSnapshot(workspaceSyncService.getSnapshot()),
        deliverTriggerEvent: (input) => engine.deliverTriggerEvent(input),
      })

      // The module-scoped Automations service (SDK getAutomationsService).
      // Shares the write-path deps with registerAutomationsIpc below so both
      // front doors run the same definition-write core.
      // Runs after every definition write from either front door: refresh the
      // webhook receiver, then tell every window so an open Automations panel
      // reflects module-driven (and other-window) writes without a remount.
      const onDefinitionsChanged = async (workspaceRoot: string): Promise<void> => {
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
        })
      )
      const moduleAutomationsRegistry = moduleAutomations
      host.onShutdown(() => moduleAutomationsRegistry.dispose())

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
          },
          stop: async () => {
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
        }
      )

      const appFrontDoor = registerAutomationsIpc(host, {
        engine,
        getTriggerProviderRegistrations,
        getActionProviderRegistrations,
        checkProviderPermission,
        isIntegrationAvailable,
        getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
        getEngineSidecarStatus: () => engineSidecar.status(),
        onDefinitionsChanged,
      })
      // The automation server's automation.create/automation.run resolve this
      // lazily; module disabled ⇒ token absent ⇒ explicit tool failure.
      host.provideService(AutomationsAppFrontDoorToken, () => appFrontDoor)
    },
  }
}

export const automationsModule = createAutomationsModule()

function createFirstPartyAutomationIntegrationResolver(input: {
  hasSwitchboard(): boolean
  hasSprintEngine(): boolean
}): (id: string) => boolean | undefined {
  return (id) => {
    if (id === SWITCHBOARD_AUTOMATION_INTEGRATION_ID) return input.hasSwitchboard()
    if (id === WATCHTOWER_AUTOMATION_INTEGRATION_ID) return input.hasSwitchboard()
    if (id === SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID) return input.hasSprintEngine()
    return undefined
  }
}

function serviceBackedSwitchboardFrontDoors(
  resolve: () => SwitchboardAutomationFrontDoors | undefined
): SwitchboardAutomationFrontDoors {
  return {
    readAllTasks: async (input) =>
      resolve()?.readAllTasks(input) ?? { ok: false, message: 'Switchboard is unavailable.' },
    tickRunner: async (input) =>
      resolve()?.tickRunner(input) ?? { ok: false, message: 'Switchboard is unavailable.' },
    startWatchtowerReview: async (input) =>
      resolve()?.startWatchtowerReview(input) ?? { ok: false, message: 'Watchtower is unavailable.' },
  }
}

function serviceBackedSprintEngineFrontDoors(
  resolve: () => SprintEngineAutomationFrontDoors | undefined
): SprintEngineAutomationFrontDoors {
  return {
    setRunnerMode: async (input) =>
      resolve()?.setRunnerMode(input) ?? { ok: false, message: 'Sprint Engine is unavailable.' },
    readProjection: async (input) =>
      resolve()?.readProjection(input) ?? { ok: false, message: 'Sprint Engine is unavailable.' },
    refreshPullRequestStatus: async (input) =>
      resolve()?.refreshPullRequestStatus(input) ?? { ok: false, message: 'Sprint Engine is unavailable.' },
    mergePullRequest: async (input) =>
      resolve()?.mergePullRequest(input) ?? { ok: false, message: 'Sprint Engine is unavailable.' },
  }
}
