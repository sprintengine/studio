import { app, BrowserWindow, Notification, ipcMain, powerMonitor } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { hostname } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { createAgentConfigImportService } from './agent-config-import'
import { cliTakesLaunchPlugins } from './agent-launch-render'
import {
  ensureAgentIntegrationHome,
  LAUNCH_STATUS_LINE_REL,
  pruneAgentIntegrationHomes,
} from './agent-integration-home'
import { createAgentStateService } from './agent-state-service'
import {
  launchPluginsSupportedOnThisPlatform,
  setLaunchPluginDirsResolver,
  setLaunchStatusLineScriptResolver,
} from './terminal-launch'
import { createAutomationService } from './automation/automation-service'
import { REMOTE_OPEN_REQUESTED_CHANNEL, TAILNET_EVENT_CHANNEL } from '../shared/tailnet'
import { FLEET_EVENT_CHANNEL } from '../shared/tailnet-fleet'
import { CANVAS_MODULE_DEFAULT_ENABLED } from '../shared/modules/manifest'
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
import {
  createBuiltinSkillManager,
  ensureSkillInstalled,
  setDefaultSkillManager,
  setLaunchDeliversBundledSkillsResolver,
} from './builtin-skills'
import { SprintEngineAuthBridge } from './auth-service'
import { createMainDiagnostics } from './main-diagnostics'
import { createTailnetShareService, readTailnetWebTargets } from './automation/tailnet/tailnet-share-service'
import { MobileControlSnapshotService, sanitizeMobileSnapshotForRelay } from './mobile/control/snapshot'
import { MobileControlCommandService } from './mobile/control/command'
import { deepRedactLocalPaths } from './mobile/control/relay-path-safety'
import { listKnownWorkspaceRoots, uniqueResolvedRoots } from './workspace-roots'
import {
  mobileControlProtocolVersion,
  mobileSnapshotCollections,
  type MobileControlCommandType,
  type MobileSnapshotCollection,
} from '../../packages/mobile-control-protocol/src/index'
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
import { createAgentLaunchSettingsStore } from './launch-settings-store'
import { setCliModelDiscoveryRuntimesResolver } from './ipc/cli-model-discovery-ipc'
import { createBackgroundModeStore } from './background-mode-store'
import { createAnalyticsService } from './telemetry/analytics-service'
import { createTelemetryConsentStore } from './telemetry/consent-store'
import { readInstallId } from './telemetry/install-id'
import type { BackgroundStatus } from '../shared/background-mode'
import { resolveMemoryRoot } from './memory-graph'
import { getPluginManifest, listPluginRegistryEntries } from './plugin-registry-instance'
import { createMcpServerResolver } from './mcp-config-readers/resolve-servers'
import { syncStudioMcpConfig } from './studio-mcp-sync'
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
import { createCanvasTools } from './automation/canvas-tools'
import { createCanvasService } from './canvas/canvas-service'
import { createNodeCanvasFs, watchCanvasDirectory } from './canvas/canvas-node-fs'
import { createCanvasSubscriberRegistry } from './canvas/canvas-subscribers'
import { createCanvasWorkerHost } from './canvas/canvas-worker-host'
import { createCanvasWorkerTransport, isCanvasWorkerWindow } from './canvas/canvas-worker-window'
import { broadcastToWorkspaceWindows, isWorkspaceWindowWebContents } from './window-factory'
import { createAgentControlPlane } from './agent-control-plane'
import { createAgentLaunchService } from './agent-launch-service'
import { ConversationRuntime } from './conversation-runtime'
import { getSharedCredentialStore } from './secret-store'
import { createTerminalSnapshotSidecarStore } from './terminal-snapshot-sidecar'
import { SprintEngineUpdateService } from './update-service'
import { createUpdateChannelStore } from './update-channel-store'
import { GitHubTokenStore } from './github-token-store'
import { createWorkspaceBackupService } from './workspace-backup'
import { createWorkspaceRegistryStore } from './workspace-registry-store'
import { createWorkspaceRegistryService } from './workspace-registry-service'
import { createWorkspaceSyncService } from './workspace-sync-service'
import { writeDiagnosticLog } from './diagnostics-service'
import { getPluginRegistry } from './plugin-registry-instance'
import { createStudioPluginService } from './studio-plugin-service'
import { resolveInstalledSkillHarnesses } from './marketplace/skill-harness-targets'

const execFileAsync = promisify(execFile)

export function createAppServices(diagnosticsEnabled: boolean) {
  const { logMainPerfEvent, withIpcDiagnostics } = createMainDiagnostics({
    enabled: diagnosticsEnabled,
  })
  const sprintengineAuth = new SprintEngineAuthBridge()
  const mcpConfigService = createMcpConfigService()
  const resolveStudioMcpBridgeScriptPath = () =>
    app.isPackaged
      ? join(process.resourcesPath, 'automation', 'mcp-stdio-bridge.mjs')
      : join(app.getAppPath(), 'resources', 'automation', 'mcp-stdio-bridge.mjs')
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
  // Declared before the agent-state service because that service's
  // `resolveLaunchInjectsPlugins` closes over it: the launch flag and the
  // workspace installer must read one value, never two that can disagree.
  let agentIntegrationPluginDirs: string[] = []
  // The status-line forwarder inside that copy. Separate from the directories
  // because a status line is not a plugin component — no plugin can declare
  // one — so it travels in the launch's `--settings` document instead.
  let agentIntegrationStatusLinePath = ''
  // THE question every workspace writer asks before touching the repository on
  // behalf of an agent launch: will this CLI's launch carry the app's own plugin
  // directories? One closure, so the launch flag (terminal-launch's
  // `pluginDirsForLaunch` asks the same three things), the agent-state
  // installer, the skill installer and the MCP sync can never disagree — a
  // disagreement is either a doubled registration or a session with none.
  const launchCarriesAppPlugins = (cli: string): boolean =>
    launchPluginsSupportedOnThisPlatform() && agentIntegrationPluginDirs.length > 0 && cliTakesLaunchPlugins(cli)
  // Bundled skills arrive in the `studio-skills` directory of that same copy.
  setLaunchDeliversBundledSkillsResolver(launchCarriesAppPlugins)
  const listAgentStateSpecs = () =>
    getPluginRegistry()
      .loaded()
      .flatMap((plugin) => (plugin.manifest.agentStateSpec ? [plugin.manifest.agentStateSpec] : []))

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
    resolveHostNodeCommand: () => process.execPath,
    // A CLI that takes the app's plugin directories at launch gets this same
    // reporter for the session, so nothing is written into the workspace. Both
    // halves must hold: a manifest that declares the flag, and a materialised
    // copy to point it at — until the copy exists (or if this build shipped
    // none) the workspace install remains the way agent state works at all.
    resolveLaunchInjectsPlugins: launchCarriesAppPlugins,
    // Read when a launch-injected CLI tidies what an earlier build wrote into
    // the workspace: the shared reporter script stays while another CLI's
    // registration there still runs it.
    listAgentStateSpecs,
    resolveReporterTemplatePath: getBundledAgentStateReporterTemplatePath,
    onFrame: (frame) => terminalRuntime.ingestAgentStateFrame(frame),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  // The app's own plugin, materialised ONCE for this build under the profile's
  // userData directory and handed to every launch that can take it
  // (`--plugin-dir`) rather than written into the person's repository. Empty
  // until the copy lands, which is what makes a launch during startup fall back
  // to the workspace installer instead of losing agent state.
  const agentIntegrationReady = (async () => {
    const home = await ensureAgentIntegrationHome({
      templateRoot: getBundledStudioPluginRoot(),
      reporterSourcePath: getBundledAgentStateReporterPath(),
      // The forwarder the launch names in its `--settings` status line: it is
      // how the app reads context usage, cost and lines changed for a session.
      statusLineSourcePath: getBundledStatusLineForwarderPath(),
      userDataDir: app.getPath('userData'),
      tokens: {
        nodeCommand: process.execPath,
        bridgeScriptPath: resolveStudioMcpBridgeScriptPath(),
        userDataDir: app.getPath('userData'),
        agentStateSocketPath: agentStateService.getSocketPath(),
      },
    })
    if (!home.ok) {
      void writeDiagnosticLog({
        level: 'warning',
        title: 'Agent plugin directory unavailable',
        message: 'Agents fall back to the per-workspace install for skills and agent state.',
        details: home.message,
        source: 'workspace',
      })
      return
    }
    agentIntegrationPluginDirs = home.home.pluginDirs
    agentIntegrationStatusLinePath = join(home.home.root, LAUNCH_STATUS_LINE_REL)
    // Old versions are only safe to delete here: a CLI reads a plugin directory
    // as it starts, and every agent this app launches dies with the app, so no
    // live session is reading a sibling version at startup.
    await pruneAgentIntegrationHomes(app.getPath('userData'), home.home.version)
  })()
  setLaunchPluginDirsResolver(() => agentIntegrationPluginDirs)
  setLaunchStatusLineScriptResolver(() => agentIntegrationStatusLinePath)

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
    // Read at install time, not at wiring time, and only once the copy has
    // settled: a workspace opened during startup is then never installed the
    // old way seconds before the launch starts carrying the same pieces, while
    // a build whose copy FAILED still gets the workspace install, which is what
    // keeps agent state working rather than losing it.
    resolveLaunchPluginsActive: () => agentIntegrationPluginDirs.length > 0,
    whenLaunchPluginsSettled: () => agentIntegrationReady,
    listAgentStateSpecs,
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
      const result = await syncStudioMcpConfig(
        {
          workspaceRoot,
          settings: { syncEnabled: false, servers: {} },
          clients: ['claude-code'],
        },
        {
          mcpConfigService,
          studioGateway: () => ({
            command: process.execPath,
            bridgeScriptPath: resolveStudioMcpBridgeScriptPath(),
            userDataDir: app.getPath('userData'),
          }),
        },
      )
      return result.ok ? { ok: true } : result
    },
  })
  conversationRuntime.startIdleSweep()

  // Renderer-pushed "keep running in the background" setting. Read
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
  // anything that records, because `app.boot` is emitted below and the launch
  // paths further down take `analytics` as a dependency.
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

  // The agent-launch settings (CLI runtimes, MCP, knowledge roots, last CLI,
  // spawn permission preset). Main owns them: windows read and patch this
  // store over IPC, and every main-side launch reads it; persisted under
  // userData.
  const agentLaunchSettings = createAgentLaunchSettingsStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'agents' })
    },
  })
  // A model-discovery pass main starts itself (boot, after an install) probes
  // with the same per-CLI command and WSL overrides a launch would use.
  setCliModelDiscoveryRuntimesResolver(() => agentLaunchSettings.get().cliRuntimes)

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
  // Module-contributed MCP tools on the Studio gateway, injected by
  // index.ts from the host kernel after loadMainModules. The gateway is
  // constructed before modules load, so until the seam is wired the registry
  // reads empty — and because the tool set is evaluated per request, module
  // tools appear on the very next call once modules are up.
  let resolveModuleMcpTools: () => ReadonlyArray<McpToolContribution> = () => []
  // The renderer's module registry, mirrored here. Empty until a
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
    syncMcpConfig: (input) =>
      syncStudioMcpConfig(
        {
          ...input,
          // A launch that carries the app's plugin directory gets the gateway
          // from that plugin's own `.mcp.json`; pinning it into the repository
          // as well would be a second copy of the server, and one a plain
          // terminal's `claude` in that checkout would load too.
          studioGatewayDeliveredAtLaunch: input.clients.length === 1 && launchCarriesAppPlugins(input.clients[0]),
        },
        {
          mcpConfigService,
          studioGateway: () => ({
            command: process.execPath,
            bridgeScriptPath: resolveStudioMcpBridgeScriptPath(),
            userDataDir: app.getPath('userData'),
          }),
        },
      ),
    // Debug Mode: make the `debug` skill present in the session CLI's native
    // skill dir before launch. Check-first so already-installed workspaces skip
    // the rewrite; install only fills missing or stale native targets. A CLI
    // whose launch carries the skill in the app's plugin directory gets no copy.
    ensureBuiltinSkillInstalled: async (workspaceRoot, skillId, cli) => {
      const result = await ensureSkillInstalled(workspaceRoot, skillId, { cli })
      if (result.ok) return
      // An id nothing answers to used to be a silent no-op, so a renamed skill
      // or a module that failed to load produced an agent invoking a skill
      // that was never copied — with nothing anywhere saying so.
      const level = result.status === 'unknown-skill' ? 'warn' : 'log'
      console[level](
        `[skills] could not ensure skill "${skillId}" in ${workspaceRoot}: ${result.status}${result.message ? ` — ${result.message}` : ''}`,
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
    prepareAgentStateHook: (workspaceRoot, cli, execution) =>
      agentStateService.installForWorkspace(workspaceRoot, cli, execution),
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
        details: error instanceof Error ? (error.stack ?? error.message) : String(error),
      })
    },
  })
  // The snapshot's `pullRequests` field is filled from here, and nowhere else.
  setSessionPullRequestReader((session) => pullRequestRecord.listForSession(session))
  // Coming back to the app is the cheapest moment to notice a pull request that
  // merged while it was in the background (decision 9), and it is also what
  // first populates the marks after a cold start.
  app.on('browser-window-focus', () => pullRequestRecord.refreshOnFocus())

  // The one interaction path to a live agent session. Every caller
  // that drives an agent — the review guide, later the composer and MCP —
  // goes through this instead of writing to a pty itself, so
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
  // The saved update channel is main's: the updater is configured here, before
  // any renderer exists to ask.
  const updateChannelStore = createUpdateChannelStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'update' })
    },
  })
  const updateService = new SprintEngineUpdateService({ writeDiagnosticLog, channelStore: updateChannelStore })
  const agentConfigImportService = createAgentConfigImportService({
    mcpConfigService,
    builtinSkillManager,
  })
  const githubTokenStore = new GitHubTokenStore()

  // The mobile relay bridge (construction + IPC + shutdown) moved to its
  // capability module (src/main/modules/), registered through the host kernel.
  // The terminal runtime now exposes only generic agent-session seams
  // (spawn/kill/inventory + a session-exit listener); modules layer their own
  // system-specific behavior on top. sprintengineAuth and terminalRuntime are
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
  // The authoritative workspace registry. It replaces the routing
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
  // Composing an agent launch is main's job. Built here, after the
  // terminal runtime and workspace sync, because it reads both: the workspace it
  // launches into comes from the sync snapshot, and the launch itself is the
  // runtime's own spawn handler. Its defaults come from the main-owned launch
  // settings store, so a launch with zero windows open still uses the user's
  // real CLI, permission preset, and MCP servers.
  const composedAgentLaunchService = createAgentLaunchService({
    listWorkspaces: () => workspaceSyncService.getSnapshot().state.workspaces,
    getLaunchSettings: () => agentLaunchSettings.get(),
    // Hooks-only selectability (decision of record 2026-08-31): a KNOWN plugin
    // whose manifest declares no agentStateSpec is refused as an agent. An id
    // the registry does not hold falls through — the launch render's own
    // unknown-plugin error names the real problem, and refusing it here would
    // misattribute a typo to missing hook support.
    isAgentSelectableCli: (cli) => {
      const plugin = getPluginRegistry()
        .loaded()
        .find((candidate) => candidate.manifest.id === cli)
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
  // prompt, name, worktree path and cwd do not: they are the user's words and
  // the user's disk (see the boundary in shared/telemetry.ts).
  const agentLaunchService: typeof composedAgentLaunchService = {
    ...composedAgentLaunchService,
    async launch(request) {
      const result = await composedAgentLaunchService.launch(request)
      if (result.ok) {
        analytics.record('agent.launched', {
          cli: result.cli,
          worktree: request.worktreePath !== undefined,
          connector: request.connectorId !== undefined,
          withPrompt: Boolean(request.prompt),
          ...(request.permissionPreset ? { permissionPreset: request.permissionPreset } : {}),
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
    isAnyWindowFocused: () =>
      BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused()),
    isEnabled: () => automationService.getTailnetStatus().notifications,
    openRemote: () => {
      // Never the hidden canvas worker: `revealMainWindow` shows and focuses
      // what it is given, and with the pane closed and an agent drawing it can
      // be the only window open.
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && !isCanvasWorkerWindow(candidate),
      )
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
      workspaceSyncService.getSnapshot().state.workspaces.find((workspace) => workspace.id === workspaceId)
        ?.folderPath ?? null,
  })
  const browserControl = createBrowserControl(browserManager)
  browserManager.onUnregister((tabId) => browserControl.forget(tabId))

  // The Canvas pane's main half. It owns the `.excalidraw` files under a
  // workspace root — the SAME root the browser sidecar and the backlog resolve
  // against — and it is the only writer of them: the tab commits through it and
  // the `canvas.*` tools call it directly, so a board has one merge and one
  // revision however it was edited. The hidden worker window behind it is built
  // lazily on the first call that needs a DOM and disposed when it goes idle.
  const canvasSubscribers = createCanvasSubscriberRegistry()
  const canvasService = createCanvasService({
    fs: createNodeCanvasFs(),
    now: () => Date.now(),
    resolveWorkspaceRoot: (workspaceId) =>
      workspaceSyncService.getSnapshot().state.workspaces.find((workspace) => workspace.id === workspaceId)
        ?.folderPath ?? null,
    broadcast: broadcastToWorkspaceWindows,
    sendTo: canvasSubscribers.sendTo,
    watch: watchCanvasDirectory,
    worker: createCanvasWorkerHost({
      transport: createCanvasWorkerTransport({
        ipcMain,
        log: (message, details) => {
          void writeDiagnosticLog({
            level: 'warning',
            source: 'workspace',
            title: 'Canvas',
            message,
            ...(details ? { details: JSON.stringify(details) } : {}),
          })
        },
      }),
    }),
    log: (message, details) => {
      void writeDiagnosticLog({
        level: 'info',
        source: 'workspace',
        title: 'Canvas',
        message,
        ...(details ? { details: JSON.stringify(details) } : {}),
      })
    },
  })
  /**
   * Whether the Canvas module is on.
   *
   * `canvas` is a renderer-only module: main's enablement gate resolves the
   * manifests of modules with a MAIN half, and a module whose whole substance
   * is a pane tab is not in that list — it would answer false for a module the
   * person can see switched on. The renderer's mirrored registry is the one
   * place main can read the user's actual switch, and until a window has pushed
   * one the module's own `defaultEnabled` stands: refusing every canvas tool
   * for the first seconds of a run would read as a broken capability, not a
   * disabled one.
   *
   * A snapshot that ARRIVED but carries no `canvas` entry means the same thing
   * as no snapshot at all — the window's registry has not listed it yet — so it
   * falls to the same default. Reading it as "off" put the answer through a
   * resolver that has no canvas manifest to resolve and therefore always says
   * false, which turned a module the person can see switched on into every
   * canvas tool refusing.
   */
  const isCanvasEnabled = (): boolean => {
    const snapshot = moduleRegistryMirror.read()
    const entry = snapshot?.modules.find((module) => module.id === 'canvas')
    if (entry) return entry.enabled
    return CANVAS_MODULE_DEFAULT_ENABLED
  }

  // Instance-global SprintEngine Studio MCP surface: reads come from the
  // workspace-sync snapshot and terminal runtime, and mutations go straight to
  // the main services that own them — one lane, no window required.
  // The gateway starts with the app.
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
    hasWindow: () =>
      BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && !isCanvasWorkerWindow(window)),
    // Terminal streaming for the tailnet listener: the runtime's own
    // multi-viewer port, so a paired device watches the same pty the local
    // window does rather than a second copy of it.
    resolveTerminalHost: () => terminalRuntime.remoteHost,
    // The gateway's tool set: core app tools + canonical run tools merged once,
    // module-contributed tools read from the host kernel per request
    // and gated on their owner's live enablement.
    resolveGatewayTools: createStudioGatewayTools({
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
        ...createCanvasTools({
          service: canvasService,
          hasWorkspace: (workspaceId) =>
            workspaceSyncService.getSnapshot().state.workspaces.some((workspace) => workspace.id === workspaceId),
          isCanvasEnabled,
        }),
        ...createAutomationTools({
          getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
          listTerminalSessions: () => terminalRuntime.ipcHandlers.listTerminals(),
          launchAgent: (request) => agentLaunchService.launch(request),
          // Read live, never captured: the same store the launch service reads, so
          // a preset changed in Settings reaches the next terminal.create without
          // a restart.
          getAgentSpawnPermissionDefault: () => agentLaunchSettings.get().lastAgentSpawnPermissionPreset,
          createWorkspace: (input, actor) => workspaceSyncService.createWorkspace(input, actor),
          listBacklogItems: (workspaceRoot) => listBacklogItems(workspaceRoot),
          readBacklogItem: (workspaceRoot, relativePath) => readBacklogItem(workspaceRoot, relativePath),
          // Same filesystem store the Automations IPC front door reads; roots are
          // snapshot-resolved, so only open workspaces are reachable.
          listAutomationDefinitions: (workspaceRoot) => new AutomationsStore(workspaceRoot).listDefinitions(),
          listAutomationRuns: (workspaceRoot, automationId) =>
            new AutomationsStore(workspaceRoot).listRuns(automationId),
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
          // The mobile companion over the gateway (tailnet-mobile-transport):
          // the SAME snapshot builder and command service the relay bridge uses,
          // wired to the same root/state-path discovery, so the two transports
          // serve one behaviour. Both services are stateless enough to own here;
          // the relay bridge keeps its own instances (it also publishes pushes).
          mobileControl: (() => {
            // Dev servers this machine publishes on the tailnet ride the snapshot
            // so the phone has a door to them. Stateless; the daemon is the truth.
            const shareService = createTailnetShareService()
            const snapshotService = new MobileControlSnapshotService({
              readWebTargets: () => readTailnetWebTargets(shareService),
            })
            const commandService = new MobileControlCommandService()
            // Stable for the app's lifetime; the phone treats it as an opaque id.
            const desktopSessionId = `tailnet:${hostname()}`
            // The commands the gateway transport actually serves: snapshot reads
            // via workspace.snapshot, mutations via workspace.mobile_command's
            // allowlist. Advertised in the snapshot so the phone's affordance
            // gate shows exactly what will work over this transport.
            const gatewayCommands: MobileControlCommandType[] = ['snapshot.request', 'backlog.update']
            const workspaceRoots = () =>
              uniqueResolvedRoots(listKnownWorkspaceRoots(workspaceSyncService.getSnapshot()))
            return {
              async readSnapshot(input: { include?: string[]; knownSnapshotVersion?: string }) {
                const roots = workspaceRoots()
                const include = input.include?.filter((entry): entry is MobileSnapshotCollection =>
                  (mobileSnapshotCollections as readonly string[]).includes(entry),
                )
                const snapshot = await snapshotService.readSnapshot({
                  desktopSessionId,
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
                const result = await commandService.dispatch(
                  {
                    protocolVersion: mobileControlProtocolVersion,
                    commandId: `tnc_${randomUUID()}`,
                    type: input.type,
                    payload: input.payload,
                    deviceId: input.deviceId,
                    issuedAt: new Date().toISOString(),
                    idempotencyKey: input.idempotencyKey,
                    ...(input.expectedSnapshotVersion
                      ? { expectedSnapshotVersion: input.expectedSnapshotVersion }
                      : {}),
                  },
                  { allowedWorkspaceRoots: workspaceRoots() },
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
          // module.*/marketplace.*. The registry snapshot is the
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
          ensureBuiltinSkillInstalled: async (workspaceRoot, skillId, cli) => {
            const result = await ensureSkillInstalled(workspaceRoot, skillId, { cli })
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
      uniqueResolvedRoots(listKnownWorkspaceRoots(workspaceSyncService.getSnapshot())),
    )
  })
  void studioPluginService.ensureInstalledForRoots(
    uniqueResolvedRoots(listKnownWorkspaceRoots(workspaceSyncService.getSnapshot())),
  )
  // And again once the app's own plugin copy exists. That copy is materialised
  // asynchronously, so the pass above ran while launches still had nothing to
  // be handed: it installed the OLD arrangement into every open workspace —
  // hook merged into their Claude settings, reporter copied in. The moment the
  // copy lands, launches start registering that hook themselves, so the pass
  // has to run again to take the workspace copy back out. Without this second
  // pass the two registrations both fire for every event, for the rest of the
  // run, and the next run loses the same race again.
  void agentIntegrationReady.then(() =>
    studioPluginService.ensureInstalledForRoots(
      uniqueResolvedRoots(listKnownWorkspaceRoots(workspaceSyncService.getSnapshot())),
    ),
  )
  // Staying paired across sleep (phase 4): waking re-checks every paired
  // machine and re-dials waiting panes at once. `powerMonitor` needs the app
  // ready; services are built before that, so the hook waits for it.
  void app.whenReady().then(() => {
    const wake = () => automationService.fleet().onWake()
    powerMonitor.on('resume', wake)
    powerMonitor.on('unlock-screen', wake)
  })

  // Background mode: what the tray reports with no window open. Read
  // straight from the live main-process owners — the terminal runtime's session
  // list and the gateway's own status — because a presence that reported a
  // renderer projection would go stale the moment the last window it came from
  // closed.
  function readBackgroundStatus(): BackgroundStatus {
    const sessions = terminalRuntime.ipcHandlers
      .listTerminals()
      .filter((session) => session.kind === 'agent' && session.processAlive && !session.suspended)
    return {
      agentSessions: sessions.length,
      gateway: { running: automationService.getStatus().running },
    }
  }

  return {
    agentConfigImportService,
    agentStateService,
    browserManager,
    canvasService,
    canvasSubscribers,
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
    sprintengineAuth,
    // The provider-agnostic entitlement seam. Feature gates resolve THIS;
    // `sprintengineAuth` is the account-service adapter sitting behind it.
    entitlements: sprintengineAuth.entitlements,
    skillsService,
    agentLaunchSettings,
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
  return getBundledHookReporterPath('sprintengine-agent-state.mjs')
}

// The status-line forwarder, shipped by the same `resources/hooks` entry. Only
// the Claude-family specs that declare `statusLine: true` install it.
function getBundledStatusLineForwarderPath(): string | null {
  return getBundledHookReporterPath('sprintengine-status-line.mjs')
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
