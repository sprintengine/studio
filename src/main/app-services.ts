import { app, BrowserWindow, Notification, powerMonitor, powerSaveBlocker, shell } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { access, readdir, readFile, stat } from 'fs/promises'
import { hostname } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { createAgentConfigImportService } from './agent-config-import'
import { createAgentStateService } from './agent-state-service'
import { createAutomationService } from './automation/automation-service'
import { REMOTE_OPEN_REQUESTED_CHANNEL, TAILNET_EVENT_CHANNEL } from '../shared/tailnet'
import { FLEET_EVENT_CHANNEL } from '../shared/tailnet-fleet'
import { createTailnetNotifier } from './tailnet-notifications'
import { revealMainWindow } from './window-factory'
import { createAutomationTools } from './automation/automation-tools'
import { createTailnetTools, type TailnetToolsFrontDoor } from './automation/tailnet/tailnet-tools'
import { createStudioGatewayTools } from './automation/studio-gateway-tools'
import type { McpToolContribution } from './module-host/main-host'
import { createDefaultMarketplaceRegistryClient } from './ipc/marketplace-registry-ipc'
import { toThirdPartyModuleView } from './ipc/third-party-module-ipc'
import { readTrustedMarketplacePublisherFingerprintsSync } from './marketplace/trusted-publishers'
import { createModuleRegistryMirror } from './modules/registry-mirror'
import { readTrustedModulesSync } from './modules/trust-store'
import { defaultUserModuleRoot, discoverUserModules } from './modules/user-module-registry'
import { AutomationsStore } from './automations/store'
import type { AutomationsAppFrontDoor } from './ipc/automations-ipc'
import {
  addOrUpdateBacklogLink,
  listBacklogItems,
  readBacklogItem,
  repairBacklogIntegrity,
  updateBacklogDependenciesPlanned,
  updateBacklogEpic,
  updateBacklogStatus,
  updateBacklogTriage,
  updateBacklogType,
} from './backlog-service'
import { createBuiltinSkillManager, ensureSkillInstalled, setDefaultSkillManager } from './builtin-skills'
import { installMulticodeCliTools } from './cli-install'
import { MulticodeAuthBridge } from './auth-service'
import { createMainDiagnostics } from './main-diagnostics'
import { discoverMobileSprintEngineStatePaths } from './mobile-sprintengine-discovery'
import { MobileSprintEngineSnapshotService, sanitizeMobileSnapshotForRelay } from './mobile/sprintengine/snapshot'
import { MobileSprintEngineCommandService } from './mobile/sprintengine/command'
import { validateSprintEngineStatePath } from './mobile/sprintengine/state-path'
import { deepRedactLocalPaths } from './mobile/sprintengine/relay-path-safety'
import { listKnownWorkspaceRoots, uniqueResolvedRoots } from './workspace-roots'
import {
  mobileControlProtocolVersion,
  mobileSnapshotCollections,
  type MobileControlCommandType,
  type MobileSnapshotCollection,
} from '../shared/mobile-control/protocol'
import { createAgentSkillInstaller } from './agent-skill-installer'
import { createCapabilityWatcher } from './capability-watcher'
import { createMcpConfigService } from './mcp-config-service'
import { createSkillsService } from './skills'
import { createGitRepoReader, sweepGitRepoCache } from './skills/git-repo-reader'
import type { SkillRepoReader } from './skills/repo-reader'
import { SKILL_SOURCES_UPDATED_CHANNEL } from './skills/source-updates'
import {
  createAgentCapabilityService,
  createFsSkillDirectoryReader,
  createWorkspaceSkillsService,
} from './workspace-skills-service'
import { createSprintEngineArtifactHandlers } from './sprintengine-artifacts'
import { createSprintEngineAutomationService } from './sprintengine-automation-service'
import { createSprintEngineLaunchSettingsMirror } from './sprintengine-launch-settings-mirror'
import { createBackgroundModeStore } from './background-mode-store'
import { createAnalyticsService } from './telemetry/analytics-service'
import { createTelemetryConsentStore } from './telemetry/consent-store'
import { readInstallId } from './telemetry/install-id'
import type { BackgroundStatus } from '../shared/background-mode'
import { createSprintPowerManager } from './sprint-power-manager'
import { createSprintRuntime, type SprintRuntime } from './sprint-runtime'
import { computeSprintEngineTokenUsageReport } from './sprintengine-token-usage'
import { sprintTokenUsageDeps } from './sprintengine-token-sampling'
import { setSprintEngineAutoRunPerfLogger } from '../shared/sprintengine/auto-run'
import { createSprintEngineRunnerLog } from './sprintengine-runner-log'
import { resolveMemoryRoot } from './memory-graph'
import { getPluginManifest, listPluginRegistryEntries } from './plugin-registry-instance'
import { createMcpServerResolver } from './mcp-config-readers/resolve-servers'
import { SPRINT_ENGINE_AUTOMATION_CHANGED_CHANNEL } from './ipc/sprintengine-automation-ipc'
import { SPRINT_RUNTIME_OP_CHANNEL } from '../shared/sprintengine/runtime-bridge'
import { SPRINT_RUNS_CHANGED_CHANNEL, type SprintRunsChangedEvent } from '../shared/sprintengine/runSummary'
import {
  invalidateSprintRunSummary,
  listSprintRuns,
  readSprintRunVcs,
  watchSprintRunProjections,
} from './sprintengine-run-index'
import { createSprintPullRequestMergePoller } from './sprintengine-pr-merge-poller'
import { createGatedSprintEngineMcpHub, createSprintEngineMcpHubService } from './sprintengine-mcp-hub'
import { syncManagedSprintEngineMcpConfig } from './sprintengine-managed-mcp-sync'
import { createGitWorktree, excludeMcpConfigFromWorktree, getGitRepoRoot } from './git'
import { readBranchName, resolveTrunk } from './git-branch-span'
import { getGitBranches } from './git-read-models'
import { listGitWorktrees } from './git-worktree-list'
import { readRepositoryIdentity } from './repository-identity'
import { agentWorktreePaths } from '../shared/worktree-paths'
import { createConversationPeek } from './conversation-peek/io'
import {
  cliResumeCapabilities,
  createTerminalRuntime,
  getTerminalSessionById,
  listLiveTerminalSessions,
  listTerminalRoots,
  notePullRequestRecordChanged,
  resolveSpawnEventSink,
} from './terminal-runtime'
import { setSessionPullRequestReader } from './terminal-session'
import { createAgentChangelistFeed } from './agent-changelist-feed'
import { createPullRequestRecord } from './pull-request-record'
import { createBrowserManager } from './browser/browser-manager'
import { createBrowserControl } from './browser/browser-control'
import { createBrowserTools } from './automation/browser-tools'
import { broadcastToWorkspaceWindows, isWorkspaceWindowWebContents } from './window-factory'
import { createAgentControlPlane } from './agent-control-plane'
import { createAgentLaunchService } from './agent-launch-service'
import { ConversationRuntime } from './conversation-runtime'
import { getSharedCredentialStore } from './secret-store'
import { createTerminalSnapshotSidecarStore } from './terminal-snapshot-sidecar'
import { MulticodeUpdateService } from './update-service'
import { GitHubTokenStore } from './github-token-store'
import { createWorkspaceBackupService } from './workspace-backup'
import { createWorkspaceRegistryStore } from './workspace-registry-store'
import { createWorkspaceRegistryService } from './workspace-registry-service'
import { createWorkspaceSyncService } from './workspace-sync-service'
import { writeDiagnosticLog } from './diagnostics-service'
import { getPluginRegistry } from './plugin-registry-instance'
import { pathExists } from './filesystem-workspace'
import { createSprintCreateService } from './sprint-create-service'
import { createStudioPluginService } from './studio-plugin-service'
import { resolveInstalledSkillHarnesses } from './marketplace/skill-harness-targets'

const execFileAsync = promisify(execFile)

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
  const workspaceSkillsService = createWorkspaceSkillsService()
  // The watcher is built first because the capability answer has to state
  // whether it can be kept true: a workspace whose paths could not be watched
  // is stale-but-correct, and the surface says so from `diagnostics`.
  const capabilityWatcher = createCapabilityWatcher({
    listPlugins: () => listPluginRegistryEntries(),
    lookupManifest: (pluginId) => getPluginManifest(pluginId),
    onWorkspaceFocus: (listener) => {
      app.on('browser-window-focus', listener)
      return () => app.off('browser-window-focus', listener)
    },
  })
  const agentCapabilityService = createAgentCapabilityService({
    reader: createFsSkillDirectoryReader(),
    listPlugins: () => listPluginRegistryEntries(),
    lookupManifest: (pluginId) => getPluginManifest(pluginId),
    mcpResolver: createMcpServerResolver(),
    freshness: capabilityWatcher,
  })
  const agentSkillInstaller = createAgentSkillInstaller({
    listPlugins: () => listPluginRegistryEntries(),
    invalidate: (workspaceRoot, harnessId) => capabilityWatcher.invalidate(workspaceRoot, harnessId),
  })

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
  // The process-wide `ensureSkillInstalled` — the one the launch boundary,
  // the Backlog action and `MainHost.ensureSkillInstalled` all call — must use
  // THIS manager, the only one that knows the installed CLI plugins and can
  // therefore compute the `all-native` fan-out.
  setDefaultSkillManager(builtinSkillManager)

  // Authoritative agent state: owns the reporter socket + per-workspace install.
  // Created before terminalRuntime so the runtime can install the reporter at
  // launch; `onFrame` resolves to terminalRuntime (declared just below) at
  // frame time, well after construction.
  const agentStateService = createAgentStateService({
    resolveUserDataDir: () => app.getPath('userData'),
    resolveAgentStateSpec: (cli) =>
      getPluginRegistry()
        .loaded()
        .find((plugin) => plugin.manifest.id === cli)?.manifest.agentStateSpec ?? null,
    resolveReporterScriptPath: getBundledAgentStateReporterPath,
    resolveStatusLineScriptPath: getBundledStatusLineForwarderPath,
    resolveReporterTemplatePath: getBundledAgentStateReporterTemplatePath,
    onFrame: (frame) => terminalRuntime.ingestAgentStateFrame(frame),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  // The app's own plugin, installed into every workspace it opens. Declared
  // here because it needs the same bridge path the managed MCP sync uses, and
  // the same reporter the agent-state service installs — one resolver each,
  // never a second spelling of either.
  const studioPluginService = createStudioPluginService({
    resolveTemplateRoot: getBundledStudioPluginRoot,
    resolveAgentStateReporterPath: getBundledAgentStateReporterPath,
    resolveBridgeScriptPath: resolveStudioMcpBridgeScriptPath,
    resolveNodeCommand: () => process.execPath,
    resolveUserDataDir: () => app.getPath('userData'),
    resolveAgentStateSocketPath: () => agentStateService.getSocketPath(),
    listHarnesses: () => resolveInstalledSkillHarnesses(),
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

  // Renderer-pushed "keep running in the background" setting (MC-2156). Read
  // synchronously inside `window-all-closed`, which is precisely when no
  // renderer is left to ask.
  const backgroundModeStore = createBackgroundModeStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  // Renderer-pushed "Share anonymous usage data" setting, and the one service
  // that acts on it. Built here, beside the other userData mirrors and before
  // anything that records, because `app.boot` is emitted below and the sprint
  // and launch paths further down take `analytics` as a dependency.
  //
  // Silent unless a PostHog project key is configured — see
  // `src/shared/telemetry.ts`, which is also where the collection boundary is
  // written down. From-source builds ship no key, so this is inert in dev.
  const telemetryConsentStore = createTelemetryConsentStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })
  const analytics = createAnalyticsService({
    resolveUserDataDir: () => app.getPath('userData'),
    isConsented: () => telemetryConsentStore.isEnabled(),
    appVersion: app.getVersion(),
    // A dev build reports itself as such rather than being filtered out here,
    // so "is anyone using the shipped app" stays answerable without guessing
    // which version strings were builds from someone's laptop.
    packaged: app.isPackaged,
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })
  // The install/active-machine counter. `firstRun` is true only on the boot
  // that minted the install id, which is what separates new installs from
  // returning ones without a second event.
  //
  // Guarded on `isActive` rather than left to `record`'s own no-op: reading the
  // id is what MINTS it, and an unkeyed or opted-out build has no business
  // writing an identity file it will never use.
  if (analytics.isActive()) {
    analytics.record('app.boot', {
      firstRun: readInstallId({ resolveUserDataDir: () => app.getPath('userData') }).created,
    })
  }

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
  // Live main-process module enablement, injected by index.ts once the manifest
  // universe exists; it recomputes on every override the renderer pushes, so a
  // module the user just switched off is off here on the next call. Until then
  // nothing is enabled: a gateway tool that cannot learn its module's state must
  // report the capability as off rather than act on its behalf.
  let resolveModuleEnabled: (moduleId: string) => boolean = () => false
  // Module-contributed MCP tools on the Studio gateway (MC-1855), injected by
  // index.ts from the host kernel after loadMainModules. The gateway is
  // constructed before modules load, so until the seam is wired the registry
  // reads empty — and because the tool set is evaluated per request, module
  // tools appear on the very next call once modules are up.
  let resolveModuleMcpTools: () => ReadonlyArray<McpToolContribution> = () => []
  // The renderer's module registry, mirrored here (MC-2078). Empty until a
  // window pushes one; consumers report "not yet known" rather than "no
  // modules", the same rule the enablement mirror follows.
  const moduleRegistryMirror = createModuleRegistryMirror()
  // The marketplace index reader the `marketplace.list` tool answers from —
  // same client, same on-disk cache, same bundled-first policy as the
  // Extensions storefront's IPC.
  const marketplaceRegistryReader = createDefaultMarketplaceRegistryClient()

  // Agent changelists: an agent's own list, holding exactly the lines it wrote.
  // The feed owns every rule about WHICH checkout a claim belongs to and what it
  // refuses to claim (see agent-changelist-feed.ts); this only hands it the
  // user-data dir it writes under and the way to tell the windows to re-read.
  // Shared by the feed and by the changelist IPC handlers (register-core-ipc):
  // a list moved by an agent and a list renamed by a person reach the other
  // windows the same way.
  const broadcastGitChangelistsChanged = (repoRoot: string): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue
      // Same shape and same spelling the preload subscribes to
      // (`onGitChangelistsChanged`); the renderer re-reads for a matching root.
      window.webContents.send('git:changelists-changed', { repoRoot })
    }
  }
  const agentChangelistFeed = createAgentChangelistFeed({
    userDataDir: app.getPath('userData'),
    broadcast: broadcastGitChangelistsChanged,
  })

  const terminalRuntime = createTerminalRuntime({
    diagnosticsEnabled,
    requireAuthenticatedUser: requireAuthenticatedMulticodeUser,
    logMainPerfEvent,
    // The three agent-changelist seams. Fire-and-forget by contract: the feed
    // swallows its own failures, so none of them can cost a session anything.
    onAgentLaunched: (session) => agentChangelistFeed.onAgentLaunched(session),
    onAgentFileEdit: (input) => agentChangelistFeed.onAgentFileEdit(input),
    onAgentSessionExit: (session) => agentChangelistFeed.onAgentSessionExit(session),
    // The hook capture of a pull request the agent just opened (epic
    // `pull-request-marks`, decision 8b). The record is built below — this
    // closure only runs once a frame arrives, long after — and it is what files
    // the pull request under the URL's own repository.
    onPullRequestCaptured: (input) => pullRequestRecord.noteCaptured(input),
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
      const result = await ensureSkillInstalled(workspaceRoot, skillId)
      if (result.ok) return
      // An id nothing answers to used to be a silent no-op, so a renamed skill
      // or a module that failed to load produced an agent invoking a skill
      // that was never copied — with nothing anywhere saying so.
      const level = result.status === 'unknown-skill' ? 'warn' : 'log'
      console[level](
        `[skills] could not ensure skill "${skillId}" in ${workspaceRoot}: ${result.status}${result.message ? ` — ${result.message}` : ''}`
      )
      void writeDiagnosticLog({
        source: 'terminal',
        level: result.status === 'unknown-skill' ? 'warning' : 'info',
        title: `Skill "${skillId}" was not installed`,
        message: result.message ?? `The skill installer answered "${result.status}".`,
        details: `status=${result.status} workspaceRoot=${workspaceRoot}`,
        extensionsRow: 'skills',
      })
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
  // The conversation pull request record (epic `pull-request-marks`, decision
  // 10): main owns which pull requests a conversation has and what state each is
  // in, keyed by REPOSITORY (`host/owner/name`) and branch — a pull request an
  // agent opened in another repo belongs to that repo, not to the checkout the
  // session happens to sit in. A change re-emits the sessions it reaches over
  // the terminal snapshot channel they already ride.
  const pullRequestRecord = createPullRequestRecord({
    userDataDir: app.getPath('userData'),
    // The session OBJECTS, not snapshots: `listTerminals()` builds a snapshot of
    // every session — each of which reads this very record — so resolving one
    // session that way made a hover O(sessions) snapshot builds. The list is the
    // live sessions only; an exited or disposed one has nothing to re-ask about.
    sessions: {
      get: (sessionId) => getTerminalSessionById(sessionId),
      list: () => listLiveTerminalSessions(),
    },
    onRecordChanged: (change) => {
      notePullRequestRecordChanged((session) => pullRequestRecord.changeAffectsSession(change, session))
      // …and the rows with no session to re-emit (owner, 2026-09-10). The line
      // above only reaches a chat that still has a terminal alive in it, which
      // is precisely the chats that never had this problem. This tells the
      // windows WHICH conversations moved; each one then asks for the lists it
      // is actually showing, so the record itself never leaves main.
      if (change.workspaceIds.length > 0) {
        broadcastToWorkspaceWindows('pullRequest:workspaces-changed', change.workspaceIds)
      }
    },
    logWarning: (message, error) => {
      void writeDiagnosticLog({
        level: 'warning',
        source: 'terminal',
        title: 'Pull request record',
        message,
        details: error instanceof Error ? error.stack ?? error.message : String(error),
      })
    },
  })
  // The snapshot's `pullRequests` field is filled from here, and nowhere else.
  setSessionPullRequestReader((session) => pullRequestRecord.listForSession(session))
  // Coming back to the app is the cheapest moment to notice a pull request that
  // merged while it was in the background (decision 9), and it is also what
  // first populates the marks after a cold start.
  app.on('browser-window-focus', () => pullRequestRecord.refreshOnFocus())

  // The one interaction path to a live agent session (MC-102). Every caller
  // that drives an agent — Sprint Engine dispatch, the review guide, later the
  // composer and MCP — goes through this instead of writing to a pty itself, so
  // concurrent prompts serialize per session and submit determinism lives in
  // one place. It holds no window reference, so it works headless.
  const agentControlPlane = createAgentControlPlane({
    terminal: {
      list: () => terminalRuntime.ipcHandlers.listTerminals(),
      write: (sessionId, data) => terminalRuntime.ipcHandlers.writeTerminal(sessionId, data),
      read: (sessionId) => terminalRuntime.readTerminalOutput(sessionId),
    },
    conversation: {
      // The runtime's list result carries the shared ok/message envelope but
      // never fails; the empty arm is the type's other branch, not a swallowed
      // error — a target that matches nothing fails loudly at the plane.
      list: () => {
        const result = conversationRuntime.listSessions()
        return result.ok ? result.sessions : []
      },
      sendTurn: async ({ sessionId, message }) => {
        const result = await conversationRuntime.sendTurn({ sessionId, message })
        return result.ok ? { ok: true } : { ok: false, message: result.message }
      },
      interrupt: async ({ sessionId }) => {
        const result = await conversationRuntime.interrupt({ sessionId })
        return result.ok ? { ok: true } : { ok: false, message: result.message }
      },
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
  // Invalidate a run's cached summary and tell every open Sprints door to
  // refetch. Fired for every runtime op with a statePath, directly for state
  // writes that happen with no registered runtime (non-resident cancel), and —
  // via the run index's per-run directory watch below — for projection writes
  // by the engine that no runtime op accompanies (MC-1801).
  // MC-2155: the main-owned PR merge poller. Constructed here (it needs the
  // artifact front door and the runs-changed funnel below), STARTED by the Sprint
  // Engine capability module at app ready — so a disabled module never probes,
  // and until then `noteRunChanged` is inert.
  const sprintPullRequestMergePoller = createSprintPullRequestMergePoller({
    listRuns: (roots) => listSprintRuns([...roots]),
    readRunVcs: (statePath) => readSprintRunVcs(statePath),
    probe: async (statePath) => sprintEngineArtifacts.refreshPullRequestStatus({ statePath }),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'sprintengine' })
    },
  })
  const notifySprintRunsChanged = (statePath: string): void => {
    invalidateSprintRunSummary(statePath)
    // The run moved on disk: it may have just opened a pull request (arm) or had
    // its last one merge (disarm). Runs already under watch keep their schedule.
    sprintPullRequestMergePoller.noteRunChanged(statePath)
    const changed: SprintRunsChangedEvent = { statePath }
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue
      window.webContents.send(SPRINT_RUNS_CHANGED_CHANNEL, changed)
    }
  }
  watchSprintRunProjections(notifySprintRunsChanged)
  const sprintRuntime = createSprintRuntime({
    recordRunFinished: ({ outcome }) => analytics.record('sprint.run.finished', { outcome }),
    terminal: {
      list: () => terminalRuntime.ipcHandlers.listTerminals(),
      write: (sessionId, data) => terminalRuntime.ipcHandlers.writeTerminal(sessionId, data),
      // Dispatch prompts go through the control plane, not a bare write pair:
      // the paste and its submit are one queue entry, so nothing interleaves.
      sendPrompt: async (sessionId, text) => {
        const result = await agentControlPlane.send({ sessionId }, text, { submit: true })
        return result.ok ? { ok: true } : { ok: false, message: result.message }
      },
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
        const sender = resolveSpawnEventSink()
        // The spawn payload is flat; `metadata` is the renderer-side bag that
        // preload spreads into it (`...metadata`). An in-process spawn must
        // flatten it the same way or every field in it — permission preset,
        // model, agent binding, MCP settings, reveal policy — is dropped.
        return terminalRuntime.ipcHandlers.spawnTerminal(sender, { ...args, ...metadata })
      },
      adoptWorkspaceId: (input) => {
        terminalRuntime.adoptSprintRunWorkspaceId(input)
      },
    },
    artifacts: {
      readProjection: (input) => sprintEngineArtifacts.readProjection(input),
      autoApproveArtifact: ({ statePath, artifactId }) =>
        sprintEngineArtifacts.reviewArtifact({ statePath, artifactId }, 'approve', 'auto-run'),
      ensureTaskWorktree: (input) => sprintEngineArtifacts.ensureTaskWorktree(input),
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

  // The mobile relay bridge (construction + IPC + shutdown) and the Sprint Engine
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
  // The authoritative workspace registry (MC-2158). It replaces the routing
  // snapshot outright: routing lives IN the record now, so the
  // workspaceNames/workspaceFolderPaths/workspaceModes side-maps that snapshot
  // carried — each added to patch a specific placeholder gap — have nothing
  // left to patch.
  const workspaceRegistryStore = createWorkspaceRegistryStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: logWorkspaceSyncDiagnostic,
  })
  const workspaceRegistry = createWorkspaceRegistryService({
    store: workspaceRegistryStore,
    logDiagnostic: logWorkspaceSyncDiagnostic,
  })
  const workspaceSyncService = createWorkspaceSyncService({
    registry: workspaceRegistry,
    resolveResumeCapabilities: cliResumeCapabilities,
  })
  // Composing an agent launch is main's job (MC-2159). Built here, after the
  // terminal runtime and workspace sync, because it reads both: the workspace it
  // launches into comes from the sync snapshot, and the launch itself is the
  // runtime's own spawn handler. Its defaults come from the main-owned launch
  // settings store, so a launch with zero windows open still uses the user's
  // real CLI, permission preset, and MCP servers.
  const composedAgentLaunchService = createAgentLaunchService({
    listWorkspaces: () => workspaceSyncService.getSnapshot().state.workspaces,
    getLaunchSettings: () => sprintEngineLaunchSettings.get(),
    // Hooks-only selectability (decision of record 2026-08-31): a KNOWN plugin
    // whose manifest declares no agentStateSpec is refused as an agent. An id
    // the registry does not hold falls through — the launch render's own
    // unknown-plugin error names the real problem, and refusing it here would
    // misattribute a typo to missing hook support.
    isAgentSelectableCli: (cli) => {
      const plugin = getPluginRegistry().loaded().find((candidate) => candidate.manifest.id === cli)
      return plugin ? Boolean(plugin.manifest.agentStateSpec) : true
    },
    // The same resolver the renderer reaches over `memory:resolve-root`, so a
    // headless launch carries the project's Knowledge Graph exactly like an
    // interactively-spawned agent does.
    resolveKnowledgeRoot: (input) => resolveMemoryRoot(input.workspaceRoot, input.relativeRoot),
    terminal: {
      list: () => terminalRuntime.ipcHandlers.listTerminals(),
      // A headless launch has no window to be the event sink; the runtime
      // resolves one (or its no-op headless sender) itself.
      spawn: (payload) => terminalRuntime.ipcHandlers.spawnTerminal(resolveSpawnEventSink(), payload),
      kill: (sessionId) => terminalRuntime.ipcHandlers.killTerminal(sessionId),
    },
  })

  // Telemetry rides on the OUTSIDE of the composed service rather than inside
  // it. `createAgentLaunchService` is a pure composer with its own tests; a
  // measurement is not part of what it composes, and every caller — agent.launch,
  // backlog.work, terminal.create, automation spawns — comes through this one
  // door anyway, so wrapping here covers them all without touching that module.
  //
  // Only the resolved CLI and a handful of shape flags go out. The request's
  // prompt, name, specialist id, worktree path and cwd do not: they are the
  // user's words and the user's disk (see the boundary in shared/telemetry.ts).
  const agentLaunchService: typeof composedAgentLaunchService = {
    ...composedAgentLaunchService,
    async launch(request) {
      const result = await composedAgentLaunchService.launch(request)
      if (result.ok) {
        analytics.record('agent.launched', {
          cli: result.cli,
          specialist: request.specialistId !== undefined,
          worktree: request.worktreePath !== undefined,
          connector: request.connectorId !== undefined,
          withPrompt: Boolean(request.prompt),
          ...(request.permissionPreset ? { permissionPreset: request.permissionPreset } : {}),
        })
      }
      return result
    },
  }

  // Creating a sprint run is main's job (MC-2160). Built after workspace sync and
  // the scheduler because it uses both: the composed run's workspace is adopted
  // into the registry, and the run is then handed to `sprintRuntime`, whose
  // run-start bootstrap spawns the coordinator seat. That is what replaces the
  // old board-mount handshake, and it is why creation works with zero windows.
  const composedSprintCreateService = createSprintCreateService({
    getLaunchSettings: () => sprintEngineLaunchSettings.get(),
    // Only hook-capable CLIs (manifest agentStateSpec) may staff a sprint —
    // hooks are the only supported status mechanism, and a sprint on a CLI
    // that cannot report state would run blind (decision of record 2026-08-31).
    // This is the subset `cli.runtime.list` flags `agentSelectable: true`.
    listLaunchableClis: () =>
      getPluginRegistry()
        .loaded()
        .filter((plugin) => Boolean(plugin.manifest.agentStateSpec))
        .map((plugin) => plugin.manifest.id),
    initializeSprintEngineState: (input) => sprintEngineArtifacts.initializeSprintEngineState(input),
    fs: {
      pathExists: (path) => pathExists(path),
      readdir: async (path) => (await readdir(path, { withFileTypes: true }))
        .map((entry) => ({ name: entry.name, isDir: entry.isDirectory() })),
      readfile: (path) => readFile(path, 'utf8'),
      readFile: (path) => readFile(path, 'utf8'),
      statPath: async (path) => {
        const stats = await stat(path)
        return {
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          sizeBytes: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          modifiedAtMs: stats.mtimeMs,
        }
      },
    },
    newWorkspaceId: () => workspaceRegistry.newWorkspaceId(),
    adoptWorkspace: (workspace, windowId, folderPath) => {
      const adopted = workspaceSyncService.adoptWorkspace(workspace, windowId, folderPath, 'automation')
      return adopted.ok ? { ok: true } : { ok: false, message: adopted.message }
    },
    primaryWorkspaceWindowId: () => workspaceSyncService.getSnapshot().state.primaryWorkspaceWindowId,
    updateWorkspaceAgent: (workspaceId, agentId, patch) => {
      workspaceSyncService.updateWorkspaceAgent(workspaceId, agentId, patch, 'automation')
    },
    hydrateAutomationMode: (input) => sprintEngineAutomation.hydrateAutomationMode(input),
    setCliPermissionPreset: (input) =>
      sprintEngineAutomation.setCliPermissionPreset({ ...input, actor: 'automation' }),
    registerSprintRun: (registration) => sprintRuntime.registerRun(registration),
    addBacklogLink: (input) => addOrUpdateBacklogLink(input),
    logDiagnostic: (input) => {
      void writeDiagnosticLog({ ...input, source: 'sprintengine' })
    },
  })

  // Same outside-the-composer wrapping as the agent-launch door above, and the
  // same reason: both app-level creation (the wizard) and automation-driven
  // creation reach `createSprint`, so one wrapper counts every run once.
  //
  // The SHAPE of the run goes out, never its subject: goal text, run name,
  // folder path and the backlog refs it was sourced from all stay here. `roles`
  // is the staffed count, not which ones — role ids are registry-driven and a
  // project can define its own.
  const sprintCreateService: typeof composedSprintCreateService = {
    ...composedSprintCreateService,
    async createSprint(request) {
      const result = await composedSprintCreateService.createSprint(request)
      if (result.ok) {
        const sourceRefs =
          request.sourceRelativePaths ?? (request.sourceRelativePath ? [request.sourceRelativePath] : [])
        analytics.record('sprint.run.created', {
          startRunner: request.startRunner === true,
          worktrees: request.useWorktrees === true,
          taskIsolation: request.taskIsolation === true,
          sources: sourceRefs.length,
          roles: Object.values(request.roster ?? {}).filter((count) => count > 0).length,
          ...(request.intake ? { intake: request.intake } : {}),
        })
      }
      return result
    },
  }

  // Built after workspace sync because adopting the retired skill packs needs to
  // know which projects are open — that is where a previously installed pack's
  // directory would be.
  // Repositories are read over git, not the GitHub API (git-transport ruling,
  // owner 2026-09-08): the API's anonymous limit is what capped a Sync at
  // twenty linked repositories, and git's protocol is not counted by it. The
  // probe runs after the app is ready — not in this constructor, which runs at
  // module load, and not synchronously: on a Mac without the command line
  // tools `git --version` raises Apple's install dialog, which must never be
  // the first thing a person sees. A machine without a usable git keeps the
  // API reader and its cap, and the door says to install git rather than to
  // add a token; the deps are getters, so the service sees the probe's answer
  // the moment it lands and again if git turns up later.
  const skillRepoCacheDir = join(app.getPath('userData'), 'skill-repos')
  const gitTransport = createGitTransportProbe({
    cacheDir: skillRepoCacheDir,
    resolveToken: () => githubTokenStore.resolveToken(),
  })
  void app.whenReady().then(async () => {
    await gitTransport.refresh()
    // Objects fetched into a promisor clone are never repacked away, so a
    // repository that keeps moving grows its clone for as long as it is read.
    // A clone nobody has read in sixty days is not worth the disk, and the
    // reader rebuilds it from the network on the next read (review,
    // 2026-09-09).
    await sweepGitRepoCache(skillRepoCacheDir, SKILL_REPO_CACHE_IDLE_MS).catch(() => undefined)
  })
  const skillsService = createSkillsService(app.getPath('userData'), {
    resolveToken: () => githubTokenStore.resolveToken(),
    get repoReader() {
      return gitTransport.reader
    },
    get repoTransport() {
      return gitTransport.reader ? ('git' as const) : ('api' as const)
    },
    get gitInstalled() {
      return gitTransport.installed
    },
    refreshTransport: () => gitTransport.refresh(),
    // The same bundled tree the plugin installer materialises, read here as the
    // offline seed of our marketplace tab (studio-marketplace ruling,
    // 2026-09-06). One resolver, so a build that ships the plugin can never
    // fail to seed the catalogue that lists it.
    studioMarketplaceSeedRoot: getBundledStudioPluginRoot,
    broadcastSourceUpdates: (check) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(SKILL_SOURCES_UPDATED_CHANNEL, check)
      }
    },
  })
  // The `tailnet.*` tools configure the service that (transitively) owns them,
  // so the tool set cannot capture it at construction. Assigned immediately
  // below; until then those tools answer that they are not wired up yet.
  let tailnetToolsFrontDoor: TailnetToolsFrontDoor | null = null
  // OS notifications for pairing and reachability (pair-from-the-scan-and-
  // stay-paired, phase 3): only while no window is focused, only the events a
  // person is waiting on, never the code. A click brings the app forward and
  // opens the Remote popover in the first workspace window.
  const shownNotices = new Map<string, Notification>()
  const tailnetNotifier = createTailnetNotifier({
    isAnyWindowFocused: () => BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused()),
    isEnabled: () => automationService.getTailnetStatus().notifications,
    openRemote: () => {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
      if (!window) return
      revealMainWindow(window)
      window.webContents.send(REMOTE_OPEN_REQUESTED_CHANNEL)
    },
    show: (notice, onClick) => {
      if (!Notification.isSupported()) return
      // A later phase of the same request replaces the banner rather than
      // stacking "waiting" under "paired".
      shownNotices.get(notice.key)?.close()
      const banner = new Notification({ title: notice.title, body: notice.body, silent: false })
      banner.on('click', onClick)
      banner.on('close', () => {
        if (shownNotices.get(notice.key) === banner) shownNotices.delete(notice.key)
      })
      shownNotices.set(notice.key, banner)
      banner.show()
    },
  })
  // The embedded browser's main half (browser-pane epic): adopts the guests the
  // pane's browser tabs attach, drives them, and finds the dev servers this
  // workspace's terminals are running. The control layer is the agents' hands
  // on those same tabs, exposed as the gateway's browser.* tools below.
  const browserManager = createBrowserManager({
    listTerminalRoots,
    isHostWindow: isWorkspaceWindowWebContents,
    broadcast: broadcastToWorkspaceWindows,
    resolveWorkspaceRoot: (workspaceId) =>
      workspaceSyncService.getSnapshot().state.workspaces.find((workspace) => workspace.id === workspaceId)?.folderPath ?? null,
  })
  const browserControl = createBrowserControl(browserManager)
  browserManager.onUnregister((tabId) => browserControl.forget(tabId))

  // Instance-global SprintEngine Studio MCP surface: reads come from the workspace-sync snapshot
  // and terminal runtime, and mutations go straight to the main services that
  // own them — one lane, no window required (MC-2161). The gateway starts with
  // the app; Python Sprint Engine remains module-owned and lazy.
  const automationService = createAutomationService({
    resolveUserDataDir: () => app.getPath('userData'),
    appVersion: app.getVersion(),
    // Dev runs serve the script straight from the repo; packaged builds ship
    // it via the electron-builder extraResources entry (resources/automation).
    resolveBridgeScriptPath: resolveStudioMcpBridgeScriptPath,
    // The live-state push (remote-sessions-ux): every window hears listener,
    // pairing, and connection changes the moment main does — the fix for pair
    // requests that could expire while only Settings, if open, would show them.
    onTailnetEvent: (payload) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) continue
        window.webContents.send(TAILNET_EVENT_CHANNEL, payload)
      }
      tailnetNotifier.onTailnetEvent(payload)
    },
    onFleetEvent: (event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) continue
        window.webContents.send(FLEET_EVENT_CHANNEL, event)
      }
      tailnetNotifier.onFleetEvent(event)
    },
    hasWindow: () => BrowserWindow.getAllWindows().some((window) => !window.isDestroyed()),
    // Terminal streaming for the tailnet listener (MC-2165): the runtime's own
    // multi-viewer port, so a paired device watches the same pty the local
    // window does rather than a second copy of it.
    resolveTerminalHost: () => terminalRuntime.remoteHost,
    // The gateway's tool set: core app tools + canonical run tools merged once,
    // module-contributed tools (MC-1855) read from the host kernel per request
    // and gated on their owner's live enablement.
    resolveGatewayTools: createStudioGatewayTools({
      sprintEngineMcpHub,
      resolveModuleTools: () => resolveModuleMcpTools(),
      isModuleEnabled: (moduleId) => resolveModuleEnabled(moduleId),
      warn: (details) => {
        void writeDiagnosticLog({
          level: 'warning',
          source: 'workspace',
          title: 'Studio MCP gateway',
          message: 'Studio MCP gateway',
          details,
        })
      },
      appTools: [
        ...createBrowserTools({
          manager: browserManager,
          control: browserControl,
          hasWorkspace: (workspaceId) =>
            workspaceSyncService.getSnapshot().state.workspaces.some((workspace) => workspace.id === workspaceId),
        }),
        ...createAutomationTools({
        getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
        listTerminalSessions: () => terminalRuntime.ipcHandlers.listTerminals(),
        launchAgent: (request) => agentLaunchService.launch(request),
        // Read live, never captured: the same store the launch service reads, so
        // a preset changed in Settings reaches the next terminal.create without
        // a restart.
        getAgentSpawnPermissionDefault: () => sprintEngineLaunchSettings.get().lastAgentSpawnPermissionPreset,
        createWorkspace: (input, actor) => workspaceSyncService.createWorkspace(input, actor),
        createSprint: (request) => sprintCreateService.createSprint(request),
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
          updateDependenciesPlanned: updateBacklogDependenciesPlanned,
          addOrUpdateLink: addOrUpdateBacklogLink,
          repairIntegrity: repairBacklogIntegrity,
        },
        getAutomationsFrontDoor: () => resolveAutomationsAppFrontDoor(),
        listSprintRunStatePaths: (workspaceRoot) => discoverMobileSprintEngineStatePaths([workspaceRoot]),
        readSprintEngineProjection: (statePath) => sprintEngineArtifacts.readProjection({ statePath }),
        // The mobile companion over the gateway (tailnet-mobile-transport):
        // the SAME snapshot builder and command service the relay bridge uses,
        // wired to the same root/state-path discovery, so the two transports
        // serve one behaviour. Both services are stateless enough to own here;
        // the relay bridge keeps its own instances (it also publishes pushes).
        mobileControl: (() => {
          const snapshotService = new MobileSprintEngineSnapshotService()
          const commandService = new MobileSprintEngineCommandService()
          // Stable for the app's lifetime; the phone treats it as an opaque id.
          const desktopSessionId = `tailnet:${hostname()}`
          // The commands the gateway transport actually serves: snapshot reads
          // via workspace.snapshot, mutations via workspace.mobile_command's
          // allowlist. Advertised in the snapshot so the phone's affordance
          // gate shows exactly what will work over this transport.
          const gatewayCommands: MobileControlCommandType[] = ['snapshot.request', 'backlog.update', 'sprintengine.create']
          const workspaceRoots = () => uniqueResolvedRoots(listKnownWorkspaceRoots(workspaceSyncService.getSnapshot()))
          return {
            async readSnapshot(input: { include?: string[]; knownSnapshotVersion?: string }) {
              const roots = workspaceRoots()
              const include = input.include?.filter((entry): entry is MobileSnapshotCollection =>
                (mobileSnapshotCollections as readonly string[]).includes(entry)
              )
              const snapshot = await snapshotService.readSnapshot({
                desktopSessionId,
                statePaths: await discoverMobileSprintEngineStatePaths(roots),
                workspaceRoots: roots,
                commands: gatewayCommands,
                ...(include && include.length > 0 ? { include } : {}),
              })
              const safe = sanitizeMobileSnapshotForRelay(snapshot)
              if (input.knownSnapshotVersion && input.knownSnapshotVersion === safe.snapshotVersion) {
                return { unchanged: true as const, snapshotVersion: safe.snapshotVersion }
              }
              return { unchanged: false as const, snapshot: safe as unknown as Record<string, unknown> }
            },
            async dispatchCommand(input: {
              type: string
              payload: Record<string, unknown>
              deviceId: string
              idempotencyKey: string
              expectedSnapshotVersion?: string
            }) {
              const statePaths = await discoverMobileSprintEngineStatePaths(workspaceRoots())
              // Mirror the relay bridge's scope split exactly: sprint-engine
              // mutations resolve roots from run state paths; workspace-level
              // mutations (backlog.*) also accept the open workspace roots.
              const stateRoots = statePaths.map((statePath) => validateSprintEngineStatePath(statePath).workspaceRoot)
              const allowedWorkspaceRoots =
                input.type === 'sprintengine.create' ? stateRoots : [...stateRoots, ...workspaceRoots()]
              const result = await commandService.dispatch(
                {
                  protocolVersion: mobileControlProtocolVersion,
                  commandId: `tnc_${randomUUID()}`,
                  type: input.type,
                  payload: input.payload,
                  deviceId: input.deviceId,
                  issuedAt: new Date().toISOString(),
                  idempotencyKey: input.idempotencyKey,
                  ...(input.expectedSnapshotVersion ? { expectedSnapshotVersion: input.expectedSnapshotVersion } : {}),
                },
                { statePaths, allowedWorkspaceRoots }
              )
              if (!result.ok) {
                return { ok: false as const, code: result.error.code, message: result.error.message }
              }
              return {
                ok: true as const,
                commandId: result.commandId,
                commandType: result.commandType,
                executedAt: result.executedAt,
                // The result crosses to another device: local paths never do.
                data: deepRedactLocalPaths(result.data),
              }
            },
          }
        })(),
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
          if (result.ok) sprintRuntime.cancelRun(payload.statePath)
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
        createAgentWorktree: async ({ workspaceRoot, name, baseRef }) => {
          const paths = agentWorktreePaths(workspaceRoot, name)
          if (!paths) return { error: `"${name}" does not reduce to a usable worktree name.` }
          const created = await createGitWorktree({
            repoRoot: workspaceRoot,
            containerPath: paths.containerPath,
            destinationPath: paths.destinationPath,
            branchName: paths.branchName,
            // A remote launch names the branch to fork from (its picker lists
            // this checkout's branches); a local one forks HEAD as it always did.
            baseRef: baseRef?.trim() || 'HEAD',
            copyIncludedFiles: true,
          })
          if (!created.ok) return { error: created.message ?? 'Git worktree creation failed.' }
          return { worktreePath: created.data.path, branch: created.data.branch ?? paths.branchName }
        },
        readRepositoryIdentity: (folderPath) => readRepositoryIdentity(folderPath),
        // The facts behind `workspace.checkout` (checkout-and-branch-on-remote-
        // create): the same readers the sidebar rows and the Worktree manager
        // use, so a remote picker lists exactly what this machine's Git view
        // would. Not a repo is an answer, not an error.
        readWorkspaceCheckout: async (workspaceRoot) => {
          const empty = { git: false as const, branch: null, defaultBranch: null, branches: [], worktrees: [] }
          const repoRoot = await getGitRepoRoot(workspaceRoot).catch(() => null)
          if (!repoRoot) return empty
          const [branch, snapshot, worktrees] = await Promise.all([
            readBranchName(repoRoot),
            getGitBranches(repoRoot).catch(() => null),
            listGitWorktrees(repoRoot).catch(() => null),
          ])
          const trunk = await resolveTrunk(repoRoot, branch).catch(() => null)
          return {
            git: true,
            branch,
            defaultBranch: trunk?.name ?? null,
            // `git branch` prints a detached HEAD as a pseudo-entry,
            // "(HEAD detached at abc)", marked current; it is not a ref
            // anyone can fork from and is dropped.
            branches: (snapshot?.branches ?? [])
              .filter((entry) => !entry.name.startsWith('('))
              .map((entry) => ({ name: entry.name, current: entry.current })),
            worktrees: worktrees?.ok
              ? worktrees.data.worktrees
                  .filter((entry) => !entry.bare)
                  // `git worktree list` names the main worktree first, always.
                  .map((entry, index) => ({ path: entry.path, branch: entry.branch, isMain: index === 0 }))
              : [],
          }
        },
        // module.*/marketplace.* (MC-2078). The registry snapshot is the
        // renderer's mirror — main's own module list omits every renderer-only
        // module, so reporting from it would be wrong by construction. Trust
        // and launch readiness stay main-owned (signature verification and the
        // trust store live here), and the marketplace read goes through the
        // same client the Extensions storefront's IPC uses, cache included.
        getModuleRegistrySnapshot: () => moduleRegistryMirror.read(),
        listInstalledThirdPartyModules: async () => {
          const { modules, rejected } = await discoverUserModules(defaultUserModuleRoot(), {
            trustedModules: readTrustedModulesSync(app.getPath('userData')),
            trustedKeyFingerprints: readTrustedMarketplacePublisherFingerprintsSync(),
          })
          return { modules: modules.map((module) => toThirdPartyModuleView(module)), rejected }
        },
        listModuleContributedTools: () =>
          resolveModuleMcpTools().map((tool) => ({ moduleId: tool.moduleId, toolName: tool.registration.name })),
        readMarketplaceRegistry: (input) => marketplaceRegistryReader.read(input),
        // backlog.work composes the target CLI's native skill invocation from the
        // loaded plugin manifests.
        listPlugins: () => getPluginRegistry().loaded(),
        // backlog.work ensures the Backlog skill exists in the CLI's native dir
        // before launch (same getStatus → install seam as Debug Mode). Reports
        // whether the skill is now present; a false result is non-fatal.
        ensureBuiltinSkillInstalled: async (workspaceRoot, skillId) => {
          const result = await ensureSkillInstalled(workspaceRoot, skillId)
          if (!result.ok && result.status === 'unknown-skill') {
            console.warn(`[skills] backlog.work asked for unknown skill "${skillId}".`)
          }
          return result.ok
        },
        }),
        // Remote-control configuration, local socket only: the listener refuses
        // this whole family regardless of a device's scopes (tailnet-scopes.ts).
        ...createTailnetTools({ resolveTailnet: () => tailnetToolsFrontDoor }),
      ],
    }),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })
  tailnetToolsFrontDoor = automationService
  // The conversation peek (hover a chat row or an agent tab): reads the CLI's
  // own transcript, or the prompts the runtime reported since launch, for the
  // session the card is anchored to. Built here rather than inside the runtime
  // so its assembly rules stay Electron-free and testable.
  const conversationPeek = createConversationPeek(terminalRuntime.readConversationPeekSessionState)

  // The change feed (2026-09-05): paired devices used to poll terminal.list
  // and workspace.list every thirty seconds; now the runtime's own coalesced
  // sessions beat, and the registry's accepted events, become one small push
  // each, and a device re-reads only when told to. Both are throttled in the
  // listener, so a burst here is one push there.
  terminalRuntime.subscribeSessionsChanged(() => automationService.notifyTerminalsChanged())
  workspaceSyncService.subscribeEvents(() => automationService.notifyWorkspacesChanged())
  // The app's own plugin goes into every workspace it opens, at the two moments
  // a workspace becomes real to main: the roots the registry already holds when
  // this process starts, and every accepted registry event after that. Not at
  // agent spawn like the hook and the MCP config — an agent that reaches its
  // first prompt without the skills has already lost the session they were for
  // (backlog/2026-09-06-sprintengine-studio-ships-as-a-plugin.md).
  workspaceSyncService.subscribeEvents(() => {
    void studioPluginService.ensureInstalledForRoots(
      uniqueResolvedRoots(listKnownWorkspaceRoots(workspaceSyncService.getSnapshot()))
    )
  })
  void studioPluginService.ensureInstalledForRoots(
    uniqueResolvedRoots(listKnownWorkspaceRoots(workspaceSyncService.getSnapshot()))
  )
  // Staying paired across sleep (phase 4): waking re-checks every paired
  // machine and re-dials waiting panes at once. `powerMonitor` needs the app
  // ready; services are built before that, so the hook waits for it.
  void app.whenReady().then(() => {
    const wake = () => automationService.fleet().onWake()
    powerMonitor.on('resume', wake)
    powerMonitor.on('unlock-screen', wake)
  })

  // Background mode (MC-2156): what the tray reports with no window open. Read
  // straight from the live main-process owners — the scheduler's own run map,
  // the terminal runtime's session list, the gateway's own status — because a
  // presence that reported a renderer projection would go stale the moment the
  // last window it came from closed.
  function readBackgroundStatus(): BackgroundStatus {
    const sessions = terminalRuntime.ipcHandlers
      .listTerminals()
      .filter((session) => session.kind === 'agent' && session.processAlive && !session.suspended)
    return {
      runs: sprintRuntime.listRuns().map((run) => ({ name: run.name, autoRunning: run.autoRunning })),
      agentSessions: sessions.length,
      gateway: { running: automationService.getStatus().running },
    }
  }

  return {
    agentConfigImportService,
    agentStateService,
    browserManager,
    sprintCreateService,
    automationService,
    backgroundModeStore,
    telemetryConsentStore,
    analytics,
    readBackgroundStatus,
    setAutomationsAppFrontDoorResolver(resolver: () => AutomationsAppFrontDoor | null): void {
      resolveAutomationsAppFrontDoor = resolver
    },
    // Read side of the same lazy resolver: the marketplace install path adds a
    // catalogue automation through this door, and gets null while the module is
    // down rather than a second way into the automations store.
    getAutomationsAppFrontDoor: (): AutomationsAppFrontDoor | null => resolveAutomationsAppFrontDoor(),
    setModuleEnabledResolver(resolver: (moduleId: string) => boolean): void {
      resolveModuleEnabled = resolver
    },
    setModuleMcpToolsResolver(resolver: () => ReadonlyArray<McpToolContribution>): void {
      resolveModuleMcpTools = resolver
    },
    moduleRegistryMirror,
    agentControlPlane,
    agentLaunchService,
    builtinSkillManager,
    studioPluginService,
    conversationRuntime,
    githubTokenStore,
    logMainPerfEvent,
    mcpConfigService,
    multicodeAuth,
    // The provider-agnostic entitlement seam. Feature gates resolve THIS;
    // `multicodeAuth` is the account-service adapter sitting behind it.
    entitlements: multicodeAuth.entitlements,
    skillsService,
    sprintEngineArtifacts,
    sprintEngineAutomation,
    sprintEngineLaunchSettings,
    sprintEngineMcpHub,
    sprintPowerManager,
    sprintPullRequestMergePoller,
    sprintRuntime,
    conversationPeek,
    terminalRuntime,
    agentChangelistFeed,
    pullRequestRecord,
    broadcastGitChangelistsChanged,
    updateService,
    withIpcDiagnostics,
    workspaceBackupService,
    workspaceSkillsService,
    agentCapabilityService,
    agentSkillInstaller,
    capabilityWatcher,
    workspaceSyncService,
    workspaceRegistry,
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

// Every command-hook registration shares one stdin-filter reporter; plugin-file
// registrations name their own bundled template (e.g. OpenCode's in-process
// plugin, rewritten to .js on install).
function getBundledAgentStateReporterPath(): string | null {
  return getBundledHookReporterPath('multicode-agent-state.mjs')
}

// The status-line forwarder, shipped by the same `resources/hooks` entry. Only
// the Claude-family specs that declare `statusLine: true` install it.
function getBundledStatusLineForwarderPath(): string | null {
  return getBundledHookReporterPath('multicode-status-line.mjs')
}

// The app's own plugin marketplace, shipped by the `resources/studio-plugin`
// extraResources entry. Same packaged/dev shape as the reporter resolver above;
// null when the entry did not ship, which the service reports rather than
// installing an empty plugin into every workspace.
function getBundledStudioPluginRoot(): string | null {
  const relative = ['studio-plugin']
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, ...relative)
    return existsSync(packaged) ? packaged : null
  }
  const candidates = [
    join(process.cwd(), 'resources', ...relative),
    join(app.getAppPath(), 'resources', ...relative),
    join(__dirname, '..', '..', 'resources', ...relative),
    join(__dirname, '..', '..', '..', 'resources', ...relative),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

// The template name comes from a plugin manifest; constrain it to a bare
// filename so a hostile manifest cannot path-traverse out of resources/hooks.
function getBundledAgentStateReporterTemplatePath(template: string): string | null {
  if (!template || template.includes('/') || template.includes('\\') || template.includes('..')) return null
  return getBundledHookReporterPath(template)
}

/**
 * Whether this machine's git can do what the reader asks of it, asked once the
 * app is ready and again — at most once a minute — while the answer is no.
 *
 * The floor is 2.19: partial clone (`--filter=blob:none`) arrived there, and a
 * git that rejects the filter would fail every read with the API reader sitting
 * unreachable beside it. `git --version` alone proved only that a git exists
 * (review, 2026-09-09).
 */
const GIT_VERSION_FLOOR: readonly [number, number] = [2, 19]
const GIT_REPROBE_MS = 60_000
const SKILL_REPO_CACHE_IDLE_MS = 60 * 24 * 60 * 60 * 1000

function createGitTransportProbe(options: { cacheDir: string; resolveToken: () => Promise<string> }): {
  readonly reader: SkillRepoReader | undefined
  readonly installed: boolean
  refresh(): Promise<void>
} {
  let reader: SkillRepoReader | undefined
  let installed = false
  let probedAt = 0
  let inFlight: Promise<void> | null = null
  const probe = async (): Promise<void> => {
    probedAt = Date.now()
    const usable = await gitMeetsFloor()
    installed = usable
    if (usable && !reader) reader = createGitRepoReader(options)
    if (!usable) reader = undefined
  }
  return {
    get reader() {
      return reader
    },
    get installed() {
      return installed
    },
    refresh() {
      // A usable git stays usable for the app's life; only a missing one is
      // asked again, and not on every call.
      if (installed) return Promise.resolve()
      if (inFlight) return inFlight
      if (probedAt !== 0 && Date.now() - probedAt < GIT_REPROBE_MS) return Promise.resolve()
      inFlight = probe().finally(() => {
        inFlight = null
      })
      return inFlight
    },
  }
}

async function gitMeetsFloor(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['--version'], {
      windowsHide: true,
      timeout: 5_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    const match = /git version (\d+)\.(\d+)/.exec(String(stdout))
    if (!match) return false
    const [major, minor] = [Number(match[1]), Number(match[2])]
    return major > GIT_VERSION_FLOOR[0] || (major === GIT_VERSION_FLOOR[0] && minor >= GIT_VERSION_FLOOR[1])
  } catch {
    return false
  }
}
