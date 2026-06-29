import { basename, dirname, isAbsolute, resolve } from 'node:path'

import { registerSprintEngineIpc, type SprintEngineProjectionReadPayload } from '../ipc/sprintengine-ipc'
import { SprintEngineArtifactsToken, SprintEngineAutomationFrontDoorsToken, SprintEngineMcpHubToken } from '../module-host/service-tokens'
import { computeSprintEngineRunTokenUsage, computeSprintEngineTokenCost } from '../sprintengine-token-usage'
import type { SprintEngineMcpReadResult } from '../../shared/electron-api'
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
    const mcpHub = host.requireService(SprintEngineMcpHubToken)

    host.provideService(SprintEngineAutomationFrontDoorsToken, () => ({
      setRunnerMode: artifacts.setRunnerMode,
      replenishRoster: artifacts.replenishRoster,
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
      readyTask: artifacts.readyTask,
      initializeSprintEngineState: artifacts.initializeSprintEngineState,
      updateTask: artifacts.updateTask,
      createTask: artifacts.createTask,
      commentTask: artifacts.commentTask,
      resolveTaskInput: artifacts.resolveTaskInput,
      setTaskStatus: artifacts.setTaskStatus,
      setRunnerMode: artifacts.setRunnerMode,
      replenishRoster: artifacts.replenishRoster,
      addRosterMember: artifacts.addRosterMember,
      readProjection: artifacts.readProjection,
      readRegistryRoles: artifacts.readRegistryRoles,
      readRegistryRole: artifacts.readRegistryRole,
      readDispatch: artifacts.readDispatch,
      summarizeFeedback: artifacts.summarizeFeedback,
      readTokenUsage,
    })
  },
}

// On-demand sprint token total + cost. The aggregator lives in main (it reads
// CLI transcripts/servers, which python cannot do), so unlike the feedback
// summary — a python MCP read — this is a direct TS call. Wired here rather than
// in the artifacts service so the token-usage data path stays self-contained.
// Cost is a pure function of the aggregated usage (Phase 3), computed here so
// the renderer never has to import the pricing tables across the main boundary;
// `data` carries both. The renderer reads `data.usage` and `data.cost`.
async function readTokenUsage(
  payload: SprintEngineProjectionReadPayload
): Promise<SprintEngineMcpReadResult> {
  try {
    const statePath = validateRunStatePath(payload?.statePath)
    const usage = await computeSprintEngineRunTokenUsage(statePath)
    const cost = computeSprintEngineTokenCost(usage)
    return { ok: true, data: { usage, cost } }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

// Same run-path contract the artifacts service enforces
// (validateSprintEngineStatePath): an absolute path to
// `.multi-code/sprintengine/<team>/run.yaml`. The aggregator reads
// `projection.json` from the run directory, so the path must be shaped, not
// arbitrary.
function validateRunStatePath(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('A sprint run path is required.')
  }
  const rawStatePath = input.trim()
  if (!isAbsolute(rawStatePath)) {
    throw new Error('Sprint run path must be absolute.')
  }
  const statePath = resolve(rawStatePath)
  const teamDirectory = dirname(statePath)
  const sprintEngineDirectory = dirname(teamDirectory)
  const multiCodeDirectory = dirname(sprintEngineDirectory)
  const workspaceRoot = dirname(multiCodeDirectory)
  if (
    basename(statePath) !== 'run.yaml'
    || basename(sprintEngineDirectory) !== 'sprintengine'
    || basename(multiCodeDirectory) !== '.multi-code'
    || workspaceRoot === multiCodeDirectory
  ) {
    throw new Error('Sprint run path must point to .multi-code/sprintengine/<team>/run.yaml.')
  }
  return statePath
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
