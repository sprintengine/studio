/**
 * Renderer shim over the shared Sprint Engine auto-run executor.
 *
 * The environment-agnostic executor (ports type, `TerminalListIpcError`, the
 * bracketed-paste / IPC-timeout / spawn-failure primitives) relocated to
 * `src/shared/sprintengine/auto-run-executor.ts` (sprint-runtime-ownership
 * Phase 2: the main process drives the same auto-run cycle), following the
 * established shim pattern (`sprintengineAutomationLifecycle.ts`). Existing
 * renderer import sites and tests keep working unchanged.
 *
 * The one renderer-bound piece stays here:
 * `createDefaultSprintEngineAutoRunExecutorPorts` binds the ports to the real
 * `window.api`, the Zustand workspace store, the diagnostics module, the
 * terminal-reveal policy, and the automation stop-reason notifications.
 */

import { useWorkspaceStore } from '../store/workspaceStore'
import { publishDiagnostic } from './diagnostics'
import { applyAgentTerminalRevealPolicy } from './modelRegistry'
import { applySprintEngineAutomationStopReason } from './sprintengineSupervisorNotifications'
import type { SprintEngineAutoRunExecutorPorts } from '../../../shared/sprintengine/auto-run-executor'

export {
  TERMINAL_IPC_TIMEOUT_MS,
  TERMINAL_LIST_IPC_NOTICE_COOLDOWN_MS,
  TerminalListIpcError,
  bracketedTerminalPaste,
  listTerminalSessionsForAutoRun,
  publishTerminalListIpcFailureNotice,
  recordSpawnFailure,
  safeTerminalKill,
  safeTerminalStatus,
  spawnTerminalSession,
  writeBracketedPrompt,
} from '../../../shared/sprintengine/auto-run-executor'
export type {
  AgentExecutionUpdate,
  AgentUpdate,
  RecordSpawnFailureInput,
  SprintEngineAutoRunExecutorPorts,
  TerminalListNoticeCooldown,
  TerminalSpawnArgs,
} from '../../../shared/sprintengine/auto-run-executor'

export function createDefaultSprintEngineAutoRunExecutorPorts(): SprintEngineAutoRunExecutorPorts {
  return {
    terminalList: () => window.api.terminalList(),
    terminalWrite: (sessionId, data) => window.api.terminalWrite(sessionId, data),
    terminalKill: (sessionId) => window.api.terminalKill(sessionId),
    terminalStatus: (sessionId) => window.api.terminalStatus(sessionId),
    terminalSpawn: (args) => window.api.terminalSpawn(
      args.sessionId,
      args.cols,
      args.rows,
      args.cwd,
      args.resume,
      args.sprintEngineStatePath,
      args.cli,
      args.initialPrompt,
      args.cliRuntimes,
      args.shellOnly,
      args.metadata,
    ),
    pathExists: (path) => window.api.pathExists(path),
    readSprintEngineProjection: (statePath) => window.api.readSprintEngineProjection(statePath),
    autoApproveSprintEngineArtifact: (statePath, artifactId) =>
      window.api.autoApproveSprintEngineArtifact(statePath, artifactId),
    memoryResolveRoot: (input) => window.api.memoryResolveRoot(input),
    publishDiagnostic: (input) => publishDiagnostic(input),
    applyTerminalRevealPolicy: applyAgentTerminalRevealPolicy,
    getWorkspace: (workspaceId) =>
      useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspaceId),
    setSprintEngineState: (workspaceId, state) =>
      useWorkspaceStore.getState().setSprintEngineState(workspaceId, state),
    setSprintEngineAutomationMode: (workspaceId, mode) =>
      useWorkspaceStore.getState().setSprintEngineAutomationMode(workspaceId, mode),
    setFolderMissing: (workspaceId, missing) =>
      useWorkspaceStore.getState().setFolderMissing(workspaceId, missing),
    updateAgent: (workspaceId, agentId, update) =>
      useWorkspaceStore.getState().updateAgent(workspaceId, agentId, update),
    markSprintEngineAgentNotificationDelivered: (workspaceId, eventKey) =>
      useWorkspaceStore.getState().markSprintEngineAgentNotificationDelivered(workspaceId, eventKey),
    applyAutomationStopReason: applySprintEngineAutomationStopReason,
  }
}
