import { app, BrowserWindow, powerSaveBlocker, shell } from 'electron'
import { existsSync } from 'fs'
import { access } from 'fs/promises'
import { join } from 'path'
import { createAgentConfigImportService } from './agent-config-import'
import { createAgentStateService } from './agent-state-service'
import { createAutomationService } from './automation/automation-service'
import { createAutomationTools } from './automation/automation-tools'
import { createReviewGatewayTools } from './automation/studio-gateway-tools'
import { BRIEF_RUN_EVENT_CHANNEL } from './review/brief-run-service'
import {
  recordGuideRunEvent,
  type ReviewGuideTerminalService,
} from './review/guide-terminal-service'
import { createRendererAutomationDelegate } from './automation/renderer-delegate'
import { AutomationsStore } from './automations/store'
import type { AutomationsAppFrontDoor } from './ipc/automations-ipc'
import type { RoadmapAppFrontDoor } from './roadmap-orchestrator'
import {
  addOrUpdateBacklogLink,
  listBacklogItems,
  readBacklogItem,
  repairBacklogIntegrity,
  updateBacklogEpic,
  updateBacklogStatus,
  updateBacklogTriage,
  updateBacklogType,
} from './backlog-service'
import { createBuiltinSkillManager } from './builtin-skills'
import { installMulticodeCliTools } from './cli-install'
import { MulticodeAuthBridge } from './auth-service'
import { createMainDiagnostics } from './main-diagnostics'
import { discoverMobileSprintEngineStatePaths } from './mobile-sprintengine-discovery'
import { createMcpConfigService } from './mcp-config-service'
import { createSkillPackService } from './skill-pack-service'
import { createSkillsService } from './skills'
import { createWorkspaceSkillsService } from './workspace-skills-service'
import { createSprintEngineArtifactHandlers } from './sprintengine-artifacts'
import { createSprintEngineAutomationService } from './sprintengine-automation-service'
import { createSprintEngineLaunchSettingsMirror } from './sprintengine-launch-settings-mirror'
import { createSprintPowerManager } from './sprint-power-manager'
import { createSprintRuntime, type SprintRuntime } from './sprint-runtime'
import { createTrackerWriteBackRuntime } from './tracker/writeback'
import { computeSprintEngineTokenUsageReport } from './sprintengine-token-usage'
import { sprintTokenUsageDeps } from './sprintengine-token-sampling'
import { setSprintEngineAutoRunPerfLogger } from '../shared/sprintengine/auto-run'
import { createSprintEngineRunnerLog } from './sprintengine-runner-log'
import { resolveMemoryRoot } from './memory-graph'
import { listPluginRegistryEntries } from './plugin-registry-instance'
import { SPRINT_ENGINE_AUTOMATION_CHANGED_CHANNEL } from './ipc/sprintengine-automation-ipc'
import { SPRINT_RUNTIME_OP_CHANNEL } from '../shared/sprintengine/runtime-bridge'
import { SPRINT_RUNS_CHANGED_CHANNEL, type SprintRunsChangedEvent } from '../shared/sprintengine/runSummary'
import { invalidateSprintRunSummary, watchSprintRunProjections } from './sprintengine-run-index'
import { createGatedSprintEngineMcpHub, createSprintEngineMcpHubService } from './sprintengine-mcp-hub'
import { syncManagedSprintEngineMcpConfig } from './sprintengine-managed-mcp-sync'
import { createGitWorktree, excludeMcpConfigFromWorktree } from './git'
import { agentWorktreePaths } from '../shared/worktree-paths'
import { cliResumeCapabilities, createTerminalRuntime } from './terminal-runtime'
import { ConversationRuntime } from './conversation-runtime'
import { getSharedCredentialStore } from './secret-store'
import { createTerminalSnapshotSidecarStore } from './terminal-snapshot-sidecar'
import { createHeadlessTerminalSender } from './terminal-session'
import { MulticodeUpdateService } from './update-service'
import { GitHubTokenStore } from './github-token-store'
import { createWorkspaceBackupService } from './workspace-backup'
import { createWorkspaceSyncRoutingSnapshotStore } from './workspace-sync-routing-snapshot'
import { createWorkspaceSyncService } from './workspace-sync-service'
import { writeDiagnosticLog } from './diagnostics-service'
import { getPluginRegistry } from './plugin-registry-instance'

// All the review gateway's brief sink needs from the review module's guide
// service: release a delivered run's terminal back to the idle reaper. Narrow on
// purpose — a brief landing must not become a second way to drive the guide.
type ReviewGuideReapRelease = Pick<ReviewGuideTerminalService, 'clearReapExempt'>

export function createAppServices(diagnosticsEnabled: boolean) {
  const { logMainPerfEvent, withIpcDiagnostics } = createMainDiagnostics({
    enabled: diagnosticsEnabled,
  })
  const cliInstallResult = installMulticodeCliTools()
  if (!cliInstallResult.ok) {
    void writeDiagnosticLog({
      level: 'warning',
      source: 'workspace',
      title: 'Multicode CLI install failed',
      message: `Unable to install all Multicode CLI tools into ${cliInstallResult.binDir}.`,
      details: cliInstallResult.errors.join('; '),
    })
  }

  const multicodeAuth = new MulticodeAuthBridge()
  const mcpConfigService = createMcpConfigService()
  const resolveStudioMcpBridgeScriptPath = () =>
    app.isPackaged
      ? join(process.resourcesPath, 'automation', 'mcp-stdio-bridge.mjs')
      : join(app.getAppPath(), 'resources', 'automation', 'mcp-stdio-bridge.mjs')
  // Spawn ownership of the hub belongs to the sprint-engine capability module
  // (it claims the gate when it registers its sidecar); a disabled module
  // means the hub process cannot start, by explicit error rather than silence.
  const sprintEngineMcpHub = createGatedSprintEngineMcpHub(createSprintEngineMcpHubService({ logMainPerfEvent }))
  const skillPackService = createSkillPackService()
  const workspaceSkillsService = createWorkspaceSkillsService({ skillPackService })

  function getAuthenticatedMulticodeUserId(): string | null {
    const state = multicodeAuth.getState()
    if (!state.authenticated) return null
    return state.user?.id?.trim() || state.entitlements?.userId?.trim() || null
  }

  function requireAuthenticatedMulticodeUser(message: string): void {
    if (!getAuthenticatedMulticodeUserId()) {
      throw new Error(message)
    }
  }

  // Declared before terminalRuntime so the runtime can ensure-install skills
  // (Debug Mode) at spawn. Reads loaded CLI plugins to compute native targets.
  const builtinSkillManager = createBuiltinSkillManager({
    listPlugins: () => getPluginRegistry().loaded(),
  })

  // Authoritative agent state: owns the reporter socket + per-workspace install.
  // Created before terminalRuntime so the runtime can install the reporter at
  // launch; `onFrame` resolves to terminalRuntime (declared just below) at
  // frame time, well after construction.
  const agentStateService = createAgentStateService({
    resolveUserDataDir: () => app.getPath('userData'),
    resolveReporterScriptPath: getBundledAgentStateReporterPath,
    resolveOpencodeReporterScriptPath: getBundledOpencodeAgentStateReporterPath,
    onFrame: (frame) => terminalRuntime.ingestAgentStateFrame(frame),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  // Conversation-agent runtime (chat sessions, incl. headless Claude child
  // processes). Owned here — not inside the IPC factory — so app shutdown can
  // dispose its child processes and diagnostics can inventory them.
  const conversationRuntime = new ConversationRuntime({
    secretStore: getSharedCredentialStore(),
    prepareStudioMcp: async ({ workspaceRoot }) => {
      const result = await syncManagedSprintEngineMcpConfig(
        {
          workspaceRoot,
          settings: { syncEnabled: false, servers: {} },
          clients: ['claude-code'],
        },
        {
          mcpConfigService,
          sprintEngineMcpHub,
          studioGateway: () => ({
            command: process.execPath,
            bridgeScriptPath: resolveStudioMcpBridgeScriptPath(),
            userDataDir: app.getPath('userData'),
          }),
        }
      )
      return result.ok ? { ok: true } : result
    },
  })
  conversationRuntime.startIdleSweep()

  // Created before terminalRuntime: the automation service needs the runner
  // CLI seam and the terminal runtime's mobile command service needs the
  // automation write path (MC-1497 setAutomationMode, headless-capable).
  const sprintEngineArtifacts = createSprintEngineArtifactHandlers({
    getAuthenticatedUserId: getAuthenticatedMulticodeUserId,
    openExternal: (url) => shell.openExternal(url),
  })

  // Main-owned Sprint Engine automation mode intent (MC-1567). The one write
  // path for every mode writer: desktop UI (IPC), phone (mobile command), and
  // any future scheduler/CLI. Persists `automation.json` beside run.yaml,
  // audits manual transitions, bridges cliWatchPolling, and broadcasts.
  // The sprint scheduler is created below (it needs the terminal runtime);
  // the automation broadcast wakes it through this late-bound reference.
  let sprintRuntimeRef: SprintRuntime | null = null

  const sprintEngineAutomation = createSprintEngineAutomationService({
    setRunnerCliWatchPolling: async ({ statePath, cliWatchPolling }) => {
      const result = await sprintEngineArtifacts.setRunnerMode({ statePath, cliWatchPolling })
      return result.ok ? { ok: true } : { ok: false, message: result.message }
    },
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog(diagnostic)
    },
    broadcast: (event) => {
      // The scheduler adopts the new mode before any window does, so an
      // enabling write starts progressing even if every window is busy.
      sprintRuntimeRef?.notifyAutomationChanged(event.statePath, event.record)
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) continue
        window.webContents.send(SPRINT_ENGINE_AUTOMATION_CHANGED_CHANNEL, event)
      }
    },
    // Hydration seeds the sidecar for fresh/legacy runs without a window
    // broadcast; the scheduler still adopts the mode (lifecycle-preserving)
    // or the run would never leave 'manual' in main.
    notifyHydrated: (statePath, record) => {
      sprintRuntimeRef?.adoptAutomationRecord(statePath, record)
    },
  })

  // Renderer-pushed agent-launch settings (cliRuntimes/mcp/knowledge/model
  // catalog) for main-side sprint agent spawns; persisted under userData.
  const sprintEngineLaunchSettings = createSprintEngineLaunchSettingsMirror({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'sprintengine' })
    },
  })

  // The Automations module (and its app front door) registers on the module
  // kernel AFTER app services are constructed; index.ts injects the resolver once
  // the kernel is up. Declared here because both the automation tools and the
  // terminal runtime's mobile command service (the phone's `automations.control`)
  // resolve it lazily, at call time. Until the module is up, both report the
  // module as unavailable rather than buffering.
  let resolveAutomationsAppFrontDoor: () => AutomationsAppFrontDoor | null = () => null
  // The instance roadmap's front door (roadmap.* tools) is provided by the same
  // module and resolved lazily for the same reason — null until the module is up.
  let resolveRoadmapAppFrontDoor: () => RoadmapAppFrontDoor | null = () => null
  // Live main-process module enablement, injected by index.ts once the manifest
  // universe exists; it recomputes on every override the renderer pushes, so a
  // module the user just switched off is off here on the next call. Until then
  // nothing is enabled: a gateway tool that cannot learn its module's state must
  // report the capability as off rather than act on its behalf.
  let resolveModuleEnabled: (moduleId: string) => boolean = () => false
  // The review guide's terminal service, provided by the review capability
  // module. Resolved lazily like the front doors — null when the module never
  // registered, in which case there is no guide terminal to release either.
  let resolveReviewGuideTerminals: () => ReviewGuideReapRelease | null = () => null

  const terminalRuntime = createTerminalRuntime({
    diagnosticsEnabled,
    requireAuthenticatedUser: requireAuthenticatedMulticodeUser,
    logMainPerfEvent,
    // Item 47: the phone enables, pauses and fires automations through the same
    // front door the desktop UI writes through.
    resolveAutomationsFrontDoor: () => resolveAutomationsAppFrontDoor(),
    // Durable freeze-the-view: suspended agent terminals persist their painted
    // screen to disk and reopen painted-and-paused after an app restart.
    snapshotSidecars: createTerminalSnapshotSidecarStore({
      resolveUserDataDir: () => app.getPath('userData'),
      logDiagnostic: (diagnostic) => {
        void writeDiagnosticLog({ ...diagnostic, source: 'terminal' })
      },
    }),
    // Reaper decision trail (actions + rate-limited skips) into the daily
    // diagnostics JSONL — the in-memory reap ring buffer dies with the process.
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'terminal' })
    },
    syncMcpConfig: (input) => syncManagedSprintEngineMcpConfig(input, {
      mcpConfigService,
      sprintEngineMcpHub,
      studioGateway: () => ({
        command: process.execPath,
        bridgeScriptPath: resolveStudioMcpBridgeScriptPath(),
        userDataDir: app.getPath('userData'),
      }),
    }),
    callManagedSprintEngineTool: (input) => sprintEngineMcpHub.callRunTool(input),
    // Debug Mode: make the `debug` skill present in the session CLI's native
    // skill dir before launch. Check-first so already-installed workspaces skip
    // the rewrite; install only fills missing or stale native targets.
    ensureBuiltinSkillInstalled: async (workspaceRoot, skillId) => {
      const status = await builtinSkillManager.getStatus(workspaceRoot, skillId)
      if (status.ok && (status.status === 'missing' || status.status === 'update-available')) {
        await builtinSkillManager.install(workspaceRoot, skillId)
      }
    },
    // Connector launch: keep the generated managed MCP config out of the
    // connector chat's worktree git (`.mcp.json` / `.codex/config.toml`).
    excludeWorktreeMcpConfig: (worktreePath) => excludeMcpConfigFromWorktree(worktreePath),
    releaseManagedSprintEngineRun: async (input) => {
      await sprintEngineMcpHub.unregisterRun(input.runId)
      if (input.cleanupMcpConfig) {
        mcpConfigService.removeManagedSprintEngine({
          workspaceRoot: input.workspaceRoot,
          clients: input.clients,
        })
      }
    },
    prepareAgentStateHook: (workspaceRoot, cli) => agentStateService.installForWorkspace(workspaceRoot, cli),
    // MC-1497: the phone's setAutomationMode writes the main-owned intent
    // directly — no renderer round-trip, works headless.
    setSprintEngineAutomationMode: async (input) => {
      const result = await sprintEngineAutomation.setAutomationMode({
        statePath: input.statePath,
        mode: input.mode,
        actor: 'mobile',
        deviceId: input.deviceId ?? null,
      })
      if (result.ok) return { ok: true }
      return { ok: false, retryable: false, message: result.message }
    },
  })
  // The main-process sprint scheduler (sprint-runtime-ownership Phase 2):
  // drives the shared auto-run cycle against the terminal runtime in-process,
  // immune to renderer occlusion throttling. Spawns still need a window as the
  // terminal event sink (Phase 3 removes that).
  const sprintPowerManager = createSprintPowerManager({
    powerSaveBlocker,
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'sprintengine' })
    },
  })
  // Tracker write-back (MC-1640): opt-in comments/transitions posted to the
  // linked issue as a run progresses. Default off per connection, so with no
  // tracker connection this is inert (the engine early-outs before any scan). It
  // has no run-event push channel, so it reconciles: the runtime op broadcast
  // below wakes it, and it reads fresh run state and posts whatever is newly due.
  const trackerWriteBack = createTrackerWriteBackRuntime({
    readProjection: (input) => sprintEngineArtifacts.readProjection(input),
    logDiagnostic: (event, payload) => {
      void writeDiagnosticLog({
        level: 'warning',
        source: 'sprintengine',
        title: 'Tracker write-back',
        message: event,
        details: JSON.stringify(payload),
      })
    },
  })
  // Invalidate a run's cached summary and tell every open Sprints door to
  // refetch. Fired for every runtime op with a statePath, directly for state
  // writes that happen with no registered runtime (non-resident cancel), and —
  // via the run index's per-run directory watch below — for projection writes
  // by the engine that no runtime op accompanies (MC-1801).
  const notifySprintRunsChanged = (statePath: string): void => {
    invalidateSprintRunSummary(statePath)
    const changed: SprintRunsChangedEvent = { statePath }
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue
      window.webContents.send(SPRINT_RUNS_CHANGED_CHANNEL, changed)
    }
  }
  watchSprintRunProjections(notifySprintRunsChanged)
  const sprintRuntime = createSprintRuntime({
    terminal: {
      list: () => terminalRuntime.ipcHandlers.listTerminals(),
      write: (sessionId, data) => terminalRuntime.ipcHandlers.writeTerminal(sessionId, data),
      kill: (sessionId) => terminalRuntime.ipcHandlers.killTerminal(sessionId),
      status: async (sessionId) => {
        const status = await terminalRuntime.ipcHandlers.getTerminalStatus(sessionId)
        return { processAlive: status.processAlive }
      },
      spawn: async ({ metadata, ...args }) => {
        // Prefer a live window as the event sink so output streams to the UI
        // immediately; with every window closed (Phase 3 headless auto-run)
        // spawn against the headless sender — the PTY runs and buffers, and a
        // reopened window's TerminalView reattaches with scrollback.
        const sender = BrowserWindow.getAllWindows()
          .find((window) => !window.isDestroyed() && !window.webContents.isDestroyed())
          ?.webContents
          ?? createHeadlessTerminalSender()
        // The spawn payload is flat; `metadata` is the renderer-side bag that
        // preload spreads into it (`...metadata`). An in-process spawn must
        // flatten it the same way or every field in it — permission preset,
        // model, agent binding, MCP settings, reveal policy — is dropped.
        return terminalRuntime.ipcHandlers.spawnTerminal(sender, { ...args, ...metadata })
      },
    },
    artifacts: {
      readProjection: (input) => sprintEngineArtifacts.readProjection(input),
      autoApproveArtifact: ({ statePath, artifactId }) =>
        sprintEngineArtifacts.reviewArtifact({ statePath, artifactId }, 'approve', 'auto-run'),
    },
    pathExists: async (path) => {
      try {
        await access(path)
        return true
      } catch {
        return false
      }
    },
    resolveMemoryRoot: (workspaceRoot, relativeRoot) => resolveMemoryRoot(workspaceRoot, relativeRoot),
    getPluginCatalogEntries: () => listPluginRegistryEntries(),
    getLaunchSettings: () => sprintEngineLaunchSettings.get(),
    readAutomationMode: async (statePath) => {
      const result = await sprintEngineAutomation.readAutomationMode({ statePath })
      return result.ok ? result.record : null
    },
    persistRuntimeResidue: (statePath, runtime) => {
      void sprintEngineAutomation.updateRuntimeResidue({ statePath, runtime })
    },
    powerManager: sprintPowerManager,
    broadcastOp: (op) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) continue
        window.webContents.send(SPRINT_RUNTIME_OP_CHANNEL, op)
      }
      // Every runtime op means a run's state may have moved; wake write-back to
      // reconcile it against the tracker (debounced, and inert when off).
      if (op.statePath) trackerWriteBack.notifyRunActivity(op.statePath)
      // …and its cross-project run-index summary may be stale: drop the memo and
      // notify any open Sprints door so it refetches without polling (MC-1761).
      if (op.statePath) notifySprintRunsChanged(op.statePath)
    },
    notifyRunsChanged: notifySprintRunsChanged,
    logDiagnostic: (diagnostic) => writeDiagnosticLog(diagnostic),
  })
  sprintRuntimeRef = sprintRuntime
  // The shared auto-run corpus logs through an injected perf seam. The
  // renderer used to inject its own logger; with scheduling in main, wire the
  // seam to main perf diagnostics so supervise/spawn/retire events — the
  // primary debugging surface for this subsystem — stay observable.
  // Phase 3 (MC-1754): the same events also land in the owning run's on-disk
  // `runner/runner-log.jsonl`, so a runner incident is reconstructable from
  // files alone — console perf logging is diagnostics-flag-gated and gone
  // with the process.
  const sprintRunnerLog = createSprintEngineRunnerLog(
    (workspaceId) => sprintRuntimeRef?.resolveRunnerLogTarget(workspaceId) ?? null
  )
  setSprintEngineAutoRunPerfLogger((scope, event, payload) => {
    logMainPerfEvent(scope, event, payload ?? {})
    sprintRunnerLog.write(scope, event, payload ?? {})
  })

  const updateService = new MulticodeUpdateService({ writeDiagnosticLog })
  const agentConfigImportService = createAgentConfigImportService({
    mcpConfigService,
    builtinSkillManager,
  })
  const githubTokenStore = new GitHubTokenStore()
  const skillsService = createSkillsService(app.getPath('userData'), {
    resolveToken: () => githubTokenStore.resolveToken(),
  })

  // The mobile relay bridge (construction + IPC + shutdown) and the Switchboard
  // session spawner/stopper/inventory/exit-recording wiring moved to their
  // capability modules (src/main/modules/), registered through the host kernel.
  // The terminal runtime now exposes only generic agent-session seams
  // (spawn/kill/inventory + a session-exit listener); modules layer their own
  // system-specific behavior on top. multicodeAuth and terminalRuntime are
  // seeded into the kernel so those modules can build on them via the service
  // bridge.

  const workspaceBackupService = createWorkspaceBackupService({
    resolveUserDataDir: () => app.getPath('userData'),
  })
  const logWorkspaceSyncDiagnostic = (diagnostic: {
    level: 'warning'
    title: string
    message: string
    details?: string
  }) => {
    void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
  }
  const workspaceSyncRoutingSnapshotStore = createWorkspaceSyncRoutingSnapshotStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: logWorkspaceSyncDiagnostic,
  })
  const workspaceSyncService = createWorkspaceSyncService({
    initialRoutingSnapshot: workspaceSyncRoutingSnapshotStore.read() ?? undefined,
    persistRoutingSnapshot: (snapshot) => workspaceSyncRoutingSnapshotStore.write(snapshot),
    logDiagnostic: logWorkspaceSyncDiagnostic,
    resolveResumeCapabilities: cliResumeCapabilities,
  })
  // Instance-global SprintEngine Studio MCP surface: reads come from the workspace-sync snapshot
  // and terminal runtime; mutations are delegated to the primary renderer so
  // they run the same store actions as the UI. The gateway starts with the
  // app; Python Sprint Engine remains module-owned and lazy.
  const automationDelegate = createRendererAutomationDelegate()
  const automationService = createAutomationService({
    resolveUserDataDir: () => app.getPath('userData'),
    appVersion: app.getVersion(),
    // Dev runs serve the script straight from the repo; packaged builds ship
    // it via the electron-builder extraResources entry (resources/automation).
    resolveBridgeScriptPath: resolveStudioMcpBridgeScriptPath,
    sprintEngineMcpHub,
    tools: createAutomationTools({
      getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
      listTerminalSessions: () => terminalRuntime.ipcHandlers.listTerminals(),
      delegateToRenderer: (request) => automationDelegate.request(request),
      listBacklogItems: (workspaceRoot) => listBacklogItems(workspaceRoot),
      readBacklogItem: (workspaceRoot, relativePath) => readBacklogItem(workspaceRoot, relativePath),
      // Same filesystem store the Automations IPC front door reads; roots are
      // snapshot-resolved, so only open workspaces are reachable.
      listAutomationDefinitions: (workspaceRoot) => new AutomationsStore(workspaceRoot).listDefinitions(),
      listAutomationRuns: (workspaceRoot, automationId) => new AutomationsStore(workspaceRoot).listRuns(automationId),
      backlogWrite: {
        updateStatus: updateBacklogStatus,
        updateType: updateBacklogType,
        updateTriage: updateBacklogTriage,
        updateEpic: updateBacklogEpic,
        addOrUpdateLink: addOrUpdateBacklogLink,
        repairIntegrity: repairBacklogIntegrity,
      },
      getAutomationsFrontDoor: () => resolveAutomationsAppFrontDoor(),
      // The instance roadmap's read + plan + steer surface for the roadmap.* tools;
      // null until the automations module (which owns the orchestrator) is up.
      getRoadmapFrontDoor: () => resolveRoadmapAppFrontDoor(),
      listSprintRunStatePaths: (workspaceRoot) => discoverMobileSprintEngineStatePaths([workspaceRoot]),
      readSprintEngineProjection: (statePath) => sprintEngineArtifacts.readProjection({ statePath }),
      // Sprint lifecycle control (MC-1653): mode writes go through the main-owned
      // intent service (same lane as the mobile relay/sprint.status), never the
      // renderer delegate. Cancel is the composed op the IPC channel uses — the
      // engine cancel write, then scheduler teardown on success — so a paused or
      // manual run's live agents are also stopped (sprint-engine-module).
      readSprintAutomationMode: (input) => sprintEngineAutomation.readAutomationMode(input),
      setSprintAutomationMode: (input) => sprintEngineAutomation.setAutomationMode(input),
      resumeSprintRun: (statePath) => sprintRuntime.applyResume(statePath),
      cancelSprintRun: async (payload) => {
        const result = await sprintEngineArtifacts.cancelRun(payload)
        if (result.ok) {
          sprintRuntime.cancelRun(payload.statePath)
          // A roadmap lane may be running this sprint: reconcile now so the
          // board parks promptly instead of on the next 60s engine tick.
          void resolveRoadmapAppFrontDoor()?.reconcile().catch(() => undefined)
        }
        return result
      },
      // Sprint steering (MC-1654): artifact review + task mutation, all through
      // the main-owned sprintEngineArtifacts handlers (two-lane rule, not the
      // renderer delegate). Review mode is pinned 'user' — the external caller is
      // a human-proxy surface, never the auto-runner's 'auto-run' policy path.
      reviewSprintArtifact: (payload, action) => sprintEngineArtifacts.reviewArtifact(payload, action, 'user'),
      commentSprintTask: (payload) => sprintEngineArtifacts.commentTask(payload),
      // Like the IPC front door: a successful resolution lifts the
      // external-input blocker, so wake the scheduler from `blocked`
      // (paused/failed/terminal states untouched).
      resolveSprintTaskInput: async (payload) => {
        const result = await sprintEngineArtifacts.resolveTaskInput(payload)
        if (result.ok) sprintRuntime.resumeIfBlocked(payload.statePath)
        return result
      },
      setSprintTaskStatus: (payload) => sprintEngineArtifacts.setTaskStatus(payload),
      createSprintTask: (payload) => sprintEngineArtifacts.createTask(payload),
      updateSprintTask: (payload) => sprintEngineArtifacts.updateTask(payload),
      // Sprint VCS + usage reads (MC-1655): PR open/refresh run the engine's own
      // vcs CLI (main-owned, like the steering block); each re-reads the run
      // projection so the tool can hand back the refreshed vcs block. Token usage
      // computes straight off the ledger — the module's 15s render-storm cache
      // (sprint-engine-module) is not needed at MCP call cadence, so this calls
      // the underlying compute directly (it never throws, degrading to empty).
      createSprintPullRequest: (payload) => sprintEngineArtifacts.createPullRequest(payload),
      refreshSprintPullRequestStatus: (payload) => sprintEngineArtifacts.refreshPullRequestStatus(payload),
      readSprintTokenUsage: (statePath) => computeSprintEngineTokenUsageReport(statePath, sprintTokenUsageDeps()),
      // Agent-at-launch worktrees (agent.launch isolation + every connector
      // launch): derive the `agent/<slug>` branch and container the Worktree
      // manager uses, then create through the shared git helper. Mirrors
      // WorkspaceManager's own worktree-agent spawn (copyIncludedFiles carries
      // the repo's worktree-include set into the isolated tree).
      createAgentWorktree: async ({ workspaceRoot, name }) => {
        const paths = agentWorktreePaths(workspaceRoot, name)
        if (!paths) return { error: `"${name}" does not reduce to a usable worktree name.` }
        const created = await createGitWorktree({
          repoRoot: workspaceRoot,
          containerPath: paths.containerPath,
          destinationPath: paths.destinationPath,
          branchName: paths.branchName,
          baseRef: 'HEAD',
          copyIncludedFiles: true,
        })
        if (!created.ok) return { error: created.message ?? 'Git worktree creation failed.' }
        return { worktreePath: created.data.path, branch: created.data.branch ?? paths.branchName }
      },
      // backlog.work composes the target CLI's native skill invocation from the
      // loaded plugin manifests.
      listPlugins: () => getPluginRegistry().loaded(),
      // backlog.work ensures the Backlog skill exists in the CLI's native dir
      // before launch (same getStatus → install seam as Debug Mode). Reports
      // whether the skill is now present; a false result is non-fatal.
      ensureBuiltinSkillInstalled: async (workspaceRoot, skillId) => {
        try {
          const status = await builtinSkillManager.getStatus(workspaceRoot, skillId)
          if (!status.ok) return false
          if (status.status === 'missing' || status.status === 'update-available') {
            const installed = await builtinSkillManager.install(workspaceRoot, skillId)
            return installed.ok
          }
          // installed / local / modified: already present in the native dir.
          return true
        } catch {
          return false
        }
      },
    }),
    // Review tools on the same gateway (plan §3.3). They validate and persist the
    // guide's brief server-side; a caller-named projectRoot is trusted only when it
    // is an open project folder, and a landed brief broadcasts the brief-run event
    // so an open Reviews door reloads it with no app restart.
    reviewTools: createReviewGatewayTools({
      isReviewModuleEnabled: () => resolveModuleEnabled('review'),
      listOpenProjectRoots: () =>
        workspaceSyncService
          .getSnapshot()
          .state.workspaces.map((workspace) => workspace.folderPath)
          .filter((folderPath): folderPath is string => typeof folderPath === 'string' && folderPath.length > 0),
      homeDir: () => app.getPath('home'),
      emitBriefRunEvent: (event) => {
        // The tool knows nothing about runs, so record the landed brief against
        // the guide-run registry before announcing it: without this a terminal
        // guide would finish while the run-status IPC still reported it working,
        // and the next start would join a run that already delivered.
        recordGuideRunEvent(event)
        // The guide took its terminal out of the idle reaper's reach for the
        // duration of the run; a delivered brief is where that run ends, and the
        // reviewer may never open the terminal to end it any other way.
        if (event.phase === 'done') resolveReviewGuideTerminals()?.clearReapExempt(event.workspaceId)
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send(BRIEF_RUN_EVENT_CHANNEL, event)
        }
      },
    }),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  return {
    agentConfigImportService,
    agentStateService,
    automationDelegate,
    automationService,
    setAutomationsAppFrontDoorResolver(resolver: () => AutomationsAppFrontDoor | null): void {
      resolveAutomationsAppFrontDoor = resolver
    },
    setRoadmapAppFrontDoorResolver(resolver: () => RoadmapAppFrontDoor | null): void {
      resolveRoadmapAppFrontDoor = resolver
    },
    setModuleEnabledResolver(resolver: (moduleId: string) => boolean): void {
      resolveModuleEnabled = resolver
    },
    setReviewGuideTerminalsResolver(resolver: () => ReviewGuideReapRelease | null): void {
      resolveReviewGuideTerminals = resolver
    },
    builtinSkillManager,
    conversationRuntime,
    githubTokenStore,
    logMainPerfEvent,
    mcpConfigService,
    multicodeAuth,
    skillPackService,
    skillsService,
    sprintEngineArtifacts,
    sprintEngineAutomation,
    sprintEngineLaunchSettings,
    sprintEngineMcpHub,
    sprintPowerManager,
    sprintRuntime,
    trackerWriteBack,
    terminalRuntime,
    updateService,
    withIpcDiagnostics,
    workspaceBackupService,
    workspaceSkillsService,
    workspaceSyncService,
    workspaceSyncRoutingSnapshotStore,
  }
}

export type AppServices = ReturnType<typeof createAppServices>

// Resolves a bundled hook reporter script across packaged and dev layouts.
// Mirrors memory-activity's resolver: extraResources ships resources/hooks/*.mjs
// to <resourcesPath>/hooks in packaged builds.
function getBundledHookReporterPath(filename: string): string | null {
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, 'hooks', filename)
    return existsSync(packaged) ? packaged : null
  }
  const candidates = [
    join(process.cwd(), 'resources', 'hooks', filename),
    join(app.getAppPath(), 'resources', 'hooks', filename),
    join(__dirname, '..', '..', 'resources', 'hooks', filename),
    join(__dirname, '..', '..', '..', 'resources', 'hooks', filename),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

// Claude Code + Codex share one stdin-filter reporter; OpenCode uses a separate
// in-process plugin template (rewritten to .js on install).
function getBundledAgentStateReporterPath(): string | null {
  return getBundledHookReporterPath('multicode-agent-state.mjs')
}

function getBundledOpencodeAgentStateReporterPath(): string | null {
  return getBundledHookReporterPath('opencode-agent-state.mjs')
}
