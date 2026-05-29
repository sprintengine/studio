import { registerSprintEngineIpc } from '../ipc/sprintengine-ipc'
import { SprintEngineArtifactsToken } from '../module-host/service-tokens'
import type { CapabilityModule } from '../module-host/load-modules'

// Sprint Engine as a capability module (main side).
//
// Scope note: only the artifact/state IPC is migrated here. The Sprint Engine
// MCP hub is a *lazily-started* shared daemon — `ensureStarted()` only runs
// when an agent spawns with a managed Sprint Engine run — and it is wired into
// the terminal runtime (agent-runtime) and shut down in app-lifecycle. It
// therefore stays foundational for now; it never spawns without a Sprint Engine
// run, so it is already usage-gated. Making Sprint Engine fully user-toggleable
// additionally needs the renderer gating (panels, workspace mode, the always-on
// auto-run supervisor) and a decision on the guided-brief dependency.
export const sprintEngineModule: CapabilityModule = {
  manifest: {
    id: 'sprint-engine',
    displayName: 'Sprint Engine',
    version: 1,
    publisher: 'multicode',
    category: 'orchestration',
    summary: 'Autonomous multi-agent sprint board with quality gates and managed MCP runtime.',
    defaultEnabled: true,
  },
  registerMain(host) {
    const artifacts = host.requireService(SprintEngineArtifactsToken)

    host.registerSidecar({
      id: 'sprintengine-mcp',
      kind: 'python-mcp',
      module: 'sprintengine_mcp',
      description: 'Shared MCP hub; lazily started on the first managed Sprint Engine run.',
    })

    registerSprintEngineIpc(host.ipcMain, {
      openArtifact: artifacts.openArtifact,
      reviewArtifact: artifacts.reviewArtifact,
      readyTask: artifacts.readyTask,
      initializeSprintEngineState: artifacts.initializeSprintEngineState,
      updateTask: artifacts.updateTask,
      createTask: artifacts.createTask,
      commentTask: artifacts.commentTask,
      setRunnerMode: artifacts.setRunnerMode,
      replenishRoster: artifacts.replenishRoster,
      readProjection: artifacts.readProjection,
      readRegistryRoles: artifacts.readRegistryRoles,
      readRegistryRole: artifacts.readRegistryRole,
      readDispatch: artifacts.readDispatch,
    })
  },
}
