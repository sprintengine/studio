import { registerSprintEngineIpc } from '../ipc/sprintengine-ipc'
import { registerSprintEngineAutomationIpc } from '../ipc/sprintengine-automation-ipc'
import { registerSprintRuntimeIpc } from '../ipc/sprint-runtime-ipc'
import { computeSprintEngineTokenUsageReport, tokenLedgerVersion } from '../sprintengine-token-usage'
import { sprintTokenUsageDeps } from '../sprintengine-token-sampling'
import type { SprintEngineTokenUsageReport } from '../../shared/sprintengine-token-usage'
import { SprintEngineArtifactsToken, SprintEngineAutomationFrontDoorsToken, SprintEngineAutomationServiceToken, SprintEngineLaunchSettingsToken, SprintEngineMcpHubToken, SprintRuntimeToken } from '../module-host/service-tokens'
import type { CapabilityModule } from '../module-host/load-modules'
import type { SidecarRunState } from '../module-host/main-host'
import type { SprintEngineMcpHubStatus } from '../sprintengine-mcp-hub'

// Sprint Engine as a capability module (main side).
//
// The Sprint Engine MCP hub is a *lazily-started* shared daemon — it only
// spawns when an agent launches with a managed Sprint Engine run — so its
// sidecar registers with `startOn: 'demand'`. The module owns the hub's
// lifecycle through the kernel: it claims spawn ownership (a disabled module
// means the gate stays closed and the hub process cannot start until the
// module is re-enabled and the app restarts), spawn failures surface as
// module-identified notifications, and the kernel's shutdown hook stops the
// process on quit. Making Sprint Engine fully user-toggleable additionally
// needs the renderer gating (panels, workspace mode, the always-on auto-run
// supervisor) and a decision on the guided-brief dependency.
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

    host.provideService(SprintEngineAutomationFrontDoorsToken, () => ({
      setRunnerMode: artifacts.setRunnerMode,
      readProjection: artifacts.readProjection,
      refreshPullRequestStatus: artifacts.refreshPullRequestStatus,
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
      openArtifact: artifacts.openArtifact,
      reviewArtifact: artifacts.reviewArtifact,
      initializeSprintEngineState: artifacts.initializeSprintEngineState,
      updateTask: artifacts.updateTask,
      createTask: artifacts.createTask,
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
      setRoleRuntime: artifacts.setRoleRuntime,
      enableRole: artifacts.enableRole,
      readProjection: artifacts.readProjection,
      readRegistryRoles: artifacts.readRegistryRoles,
      readRegistryRole: artifacts.readRegistryRole,
      summarizeFeedback: artifacts.summarizeFeedback,
      readTokenUsage: ({ statePath }) => readTokenUsageCached(statePath),
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
