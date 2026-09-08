import { registerSprintEngineIpc } from '../ipc/sprintengine-ipc'
import { registerSprintEngineAutomationIpc } from '../ipc/sprintengine-automation-ipc'
import { registerSprintRuntimeIpc } from '../ipc/sprint-runtime-ipc'
import { computeSprintEngineTokenUsageReport, tokenLedgerVersion } from '../sprintengine-token-usage'
import { listSprintRuns } from '../sprintengine-run-index'
import { discoverSprintRunsAtBoot } from '../sprintengine-boot-discovery'
import { listKnownWorkspaceRoots } from '../workspace-roots'
import { writeDiagnosticLog } from '../diagnostics-service'
import { sprintTokenUsageDeps } from '../sprintengine-token-sampling'
import type { SprintEngineTokenUsageReport } from '../../shared/sprintengine-token-usage'
import { SprintEngineArtifactsToken, SprintEngineAutomationFrontDoorsToken, SprintEngineAutomationServiceToken, SprintEngineLaunchSettingsToken, SprintEngineMcpHubToken, SprintPullRequestMergePollerToken, SprintRuntimeToken, WorkspaceSyncServiceToken } from '../module-host/service-tokens'
import type { CapabilityModule } from '../module-host/load-modules'
import type { SidecarRunState } from '../module-host/main-host'
import type { SprintEngineMcpHubStatus } from '../sprintengine-mcp-hub'

// Sprint Engine as a capability module (main side).
//
// The Sprint Engine MCP hub is a *lazily-started* shared daemon — it only
// spawns when an agent launches with a managed Sprint Engine run — so its
// sidecar registers with `startOn: 'demand'`. The module owns the hub's
// lifecycle through the kernel: it claims spawn ownership (a disabled module
// means the gate stays closed and the hub process cannot start), spawn failures
// surface as module-identified notifications, and both live disable and app
// shutdown stop the process. A module disabled before main registration still
// needs an app restart after enabling so this ownership hook can be installed.
// Making Sprint Engine fully live-unloadable additionally needs renderer gating
// (panels, workspace mode, the always-on auto-run supervisor).
export const sprintEngineModule: CapabilityModule = {
  manifest: {
    id: 'sprint-engine',
    displayName: 'Sprint Engine',
    version: 1,
    publisher: 'multicode',
    category: 'orchestration',
    summary: 'Autonomous multi-agent sprint board with quality gates and managed MCP runtime.',
    defaultEnabled: true,
    dependsOn: ['agent-runtime'],
  },
  registerMain(host) {
    const artifacts = host.requireService(SprintEngineArtifactsToken)
    const automation = host.requireService(SprintEngineAutomationServiceToken)
    const mcpHub = host.requireService(SprintEngineMcpHubToken)
    const sprintRuntime = host.requireService(SprintRuntimeToken)
    const workspaceSync = host.requireService(WorkspaceSyncServiceToken)
    const prMergePoller = host.requireService(SprintPullRequestMergePollerToken)

    host.provideService(SprintEngineAutomationFrontDoorsToken, () => ({
      setRunnerMode: artifacts.setRunnerMode,
      readProjection: artifacts.readProjection,
      refreshPullRequestStatus: artifacts.refreshPullRequestStatus,
      mergePullRequest: artifacts.mergePullRequest,
    }))

    mcpHub.claimOwnership({
      onSpawnFailure: (message) =>
        host.notify({ severity: 'error', title: 'Sprint Engine MCP hub failed to start', body: message }),
    })
    host.registerSidecar(
      {
        id: 'sprintengine-mcp',
        kind: 'python-mcp',
        module: 'sprintengine_mcp',
        description: 'Shared MCP hub; lazily started on the first managed sprint run.',
        startOn: 'demand',
      },
      {
        start: async () => {
          await mcpHub.ensureStarted()
        },
        stop: () => mcpHub.stop(),
        // The hub also starts outside the kernel handle (agent launches call
        // ensureRunRegistered), so its own state is the status truth source.
        status: () => hubSidecarStatus(mcpHub.status()),
      }
    )

    registerSprintEngineIpc(host.ipcMain, {
      reviewArtifact: artifacts.reviewArtifact,
      initializeSprintEngineState: artifacts.initializeSprintEngineState,
      commentTask: artifacts.commentTask,
      // A successful resolution lifts the external-input blocker, so wake the
      // scheduler from `blocked` (paused/failed/terminal states untouched) —
      // without this the run waits for a manual Resume the UI never asks for
      // while its toast claims "agent resuming". Best-effort like cancel: the
      // engine write is the user-facing truth even if the run was never
      // registered with the scheduler.
      resolveTaskInput: async (payload) => {
        const result = await artifacts.resolveTaskInput(payload)
        if (result.ok) sprintRuntime.resumeIfBlocked(payload.statePath)
        return result
      },
      setTaskStatus: artifacts.setTaskStatus,
      setRunnerMode: artifacts.setRunnerMode,
      // Cancel writes run/task status via the engine op, then parks the
      // automation runtime so a paused/manual run with live agents is also torn
      // down (the auto-run gate only reaches a *running* automation). Runtime
      // teardown is best-effort — a successful state write is the user-facing
      // truth even if the run was never registered with the scheduler.
      cancelRun: async (payload) => {
        const result = await artifacts.cancelRun(payload)
        if (result.ok) sprintRuntime.cancelRun(payload.statePath)
        return result
      },
      createPullRequest: artifacts.createPullRequest,
      mergePullRequest: artifacts.mergePullRequest,
      refreshPullRequestStatus: artifacts.refreshPullRequestStatus,
      ensureTaskWorktree: artifacts.ensureTaskWorktree,
      setRoleRuntime: artifacts.setRoleRuntime,
      enableRole: artifacts.enableRole,
      readProjection: artifacts.readProjection,
      readRegistryRoles: artifacts.readRegistryRoles,
      summarizeFeedback: artifacts.summarizeFeedback,
      readTokenUsage: ({ statePath }) => readTokenUsageCached(statePath),
      listRuns: ({ roots }) => listSprintRuns(roots),
    })

    // MC-1567: the main-owned automation mode intent (read / set / one-time
    // hydrate) + the Phase 2 launch-settings mirror. Broadcasts ride
    // `sprintengine:automation-changed`.
    registerSprintEngineAutomationIpc(host.ipcMain, {
      automation,
      launchSettings: host.requireService(SprintEngineLaunchSettingsToken),
    })

    // Phase 2: the renderer registers run contexts with (and pushes lifecycle
    // stops to) the main scheduler; scheduler store-ops broadcast back on
    // `sprintengine:runtime-op`.
    registerSprintRuntimeIpc(host.ipcMain, {
      sprintRuntime,
    })

    // MC-2153: registration no longer waits for a window. At app ready, scan the
    // project roots main already knows (restored from the persisted routing
    // snapshot) and register every run the user left auto-running, so a machine
    // that reboots into Studio resumes scheduling with no window ever opened.
    // Never awaited by startup and never fatal — a failed scan costs the
    // headless resume, not the app.
    host.onStartup(async () => {
      try {
        const report = await discoverSprintRunsAtBoot({
          listWorkspaceRoots: () => listKnownWorkspaceRoots(workspaceSync.getSnapshot()),
          readAutomationMode: async (statePath) => {
            const result = await automation.readAutomationMode({ statePath })
            return result.ok ? result.record : null
          },
          isRunRegistered: (statePath) => sprintRuntime.inspectRun(statePath) !== null,
          registerRun: (registration) => sprintRuntime.registerRun(registration),
        })
        if (report.registered.length === 0) return
        void writeDiagnosticLog({
          level: 'info',
          source: 'sprintengine',
          title: 'Sprint runs resumed at startup',
          message: `${report.registered.length} of ${report.discovered} discovered sprint runs resumed scheduling before any window opened.`,
          details: report.registered.join('\n'),
        })
      } catch (error) {
        void writeDiagnosticLog({
          level: 'warning',
          source: 'sprintengine',
          title: 'Boot-time sprint run discovery failed',
          message: 'Sprint runs left auto-running will resume when a window opens instead.',
          details: error instanceof Error ? error.stack ?? error.message : String(error),
        })
      }
    })

    // MC-2155: main owns the pull-request merge probe, so a run's merge state
    // self-heals with no window open (the renderer supervisor that used to do it
    // is retired). Started here rather than in app-services so a disabled Sprint
    // Engine module never spawns a `gh` probe. Scans the same roots as boot
    // discovery — a PR is opened as a run FINISHES, and the finished runs whose
    // merge state goes stale are exactly the ones the scheduler stops tracking.
    host.onStartup(async () => {
      try {
        const report = await prMergePoller.start({
          listWorkspaceRoots: () => listKnownWorkspaceRoots(workspaceSync.getSnapshot()),
        })
        if (report.watching.length === 0 && report.skippedStale.length === 0) return
        void writeDiagnosticLog({
          level: 'info',
          source: 'sprintengine',
          title: 'Sprint pull-request merge polling armed',
          message:
            `${report.watching.length} of ${report.discovered} sprint runs have an open pull request and are `
            + `being re-probed without a window${report.skippedStale.length > 0 ? `; ${report.skippedStale.length} untouched for over a month were left alone` : ''}.`,
          details: report.watching.join('\n'),
        })
      } catch (error) {
        void writeDiagnosticLog({
          level: 'warning',
          source: 'sprintengine',
          title: 'Sprint pull-request merge polling failed to start',
          message: 'Run merge state will refresh when a run changes or the app restarts.',
          details: error instanceof Error ? error.stack ?? error.message : String(error),
        })
      }
    })
    // Stop probing before shared infrastructure tears down: an in-flight `gh`
    // subprocess spawned into a quitting app is exactly what the begin phase is
    // for.
    host.onShutdownBegin(() => {
      prMergePoller.dispose()
    })
  },
}

// The token report re-reads CLI session files (bounded by the adapters' own
// mtime-keyed parse memos, but still per-session stat calls), and both the run
// summary panel and the task inspector request it on every projection tick, so
// a short TTL cache absorbs render storms. A cache entry is additionally keyed
// on the run's ledger write-counter: a teardown/session-end sample landing
// right after run completion invalidates the cached report immediately instead
// of pinning pre-completion numbers for the panel's final refetch. The compute
// itself never throws (missing ledger/projection degrade to an empty,
// unmeasured report).
const TOKEN_USAGE_CACHE_TTL_MS = 15_000
const tokenUsageCache = new Map<
  string,
  { at: number; ledgerVersion: number; report: Promise<SprintEngineTokenUsageReport> }
>()

function readTokenUsageCached(statePath: string): Promise<SprintEngineTokenUsageReport> {
  const now = Date.now()
  const ledgerVersion = tokenLedgerVersion(statePath)
  const cached = tokenUsageCache.get(statePath)
  if (cached && now - cached.at < TOKEN_USAGE_CACHE_TTL_MS && cached.ledgerVersion === ledgerVersion) {
    return cached.report
  }
  const report = computeSprintEngineTokenUsageReport(statePath, sprintTokenUsageDeps())
  tokenUsageCache.set(statePath, { at: now, ledgerVersion, report })
  // Drop stale entries so long sessions do not accumulate one per run forever.
  for (const [key, entry] of tokenUsageCache) {
    if (now - entry.at >= TOKEN_USAGE_CACHE_TTL_MS && key !== statePath) tokenUsageCache.delete(key)
  }
  return report
}

const HUB_STATE_TO_SIDECAR_STATE: Record<SprintEngineMcpHubStatus['state'], SidecarRunState> = {
  stopped: 'stopped',
  starting: 'starting',
  ready: 'running',
  failed: 'failed',
}

function hubSidecarStatus(status: SprintEngineMcpHubStatus): { state: SidecarRunState; error?: string } {
  return { state: HUB_STATE_TO_SIDECAR_STATE[status.state], error: status.lastError }
}
