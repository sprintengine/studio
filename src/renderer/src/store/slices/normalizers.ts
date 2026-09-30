import type { Workspace } from '../../types/workspace'
import { isRetiredWorkspaceMode } from '../../../../shared/workspace-mode'
import { isPlaceholderAgentName } from '../../utils/agentNames'
import { normalizeAgentState, pickWorkspaceAgentName } from './agentsSlice'
import { normalizeWorkspaceMemoryConfig } from './memorySlice'
import {
  normalizeWorkspaceBacklogState,
  normalizeWorkspaceFileExplorerState,
  normalizeWorkspaceGitPanelState,
  normalizeWorkspaceMode,
} from './workspacesSlice'
import { normalizeWorkspaceWorktreeState } from './worktreesSlice'
import { partializeWorkspaceModuleState } from './workspaceModuleState'
import { partializeWorkspacePaneState } from './workspacePaneSlice'

export function mapMigrationWorkspaces<T extends { workspaces: Workspace[] }>(
  state: T,
  migrate: (workspace: Workspace) => Workspace,
): void {
  state.workspaces = state.workspaces.map(migrate)
}

// THE retired-workspace-mode filter. One function for every mode in
// RETIRED_WORKSPACE_MODES (`shared/workspace-mode.ts`), because they all need the same treatment and a
// per-feature copy of it only invites the next one to be forgotten.
//
// It runs on every list-entry path, not only in the migration rung that retired
// each mode: a dev-HMR reload (or any write that stamps the current store
// version onto un-migrated state) would otherwise leave a retired-mode row the
// migrate ladder never revisits.
//
// This is the only thing standing between a profile written by an older build
// and a workspace row nothing can render, so it outlives the features it names
// and is removable only alongside a store-version floor bump ("we no longer
// migrate profiles older than vNN"). Returns the input array unchanged — same
// reference — when there is no retired-mode row, which is the normal load.
export function dropRetiredModeWorkspaces(workspaces: Workspace[]): Workspace[] {
  const isRetired = (workspace: Workspace): boolean => isRetiredWorkspaceMode(workspace.mode)
  if (!workspaces.some(isRetired)) return workspaces
  return workspaces.filter((workspace) => !isRetired(workspace))
}

// Every agent carries a real name, but workspaces created before that rule
// (and layout-template seeds that adopted the tab's generic label) persisted
// agents literally named "Agent" / "Agent 2" / "A1". Terminal-only registry
// records can also carry their id as the name. Recover a known name first;
// otherwise assign a replacement once and persist it at the registry boundary.
// Heal them at hydration (merge() runs on every load regardless of the store
// version, like the retired-mode filter above): each placeholder-named agent
// gets a picked name, unique within its workspace, and the layout tab renames
// itself to agent.name on render. Idempotent — a healed name is no longer a
// placeholder — and returns the input array unchanged when nothing needs it.
export function nameGenericWorkspaceAgents(
  workspaces: Workspace[],
  recoverName?: (workspaceId: string, agentId: string) => string | undefined,
): Workspace[] {
  let changed = false
  const next = workspaces.map((workspace) => {
    const entries = Object.entries(workspace.agents ?? {})
    if (!entries.some(([id, agent]) => isPlaceholderAgentName(agent.name, id))) return workspace
    changed = true
    const agents: Workspace['agents'] = { ...workspace.agents }
    // Reserve every recovered name before picking replacements, including a
    // recovered name belonging to a later entry in the workspace.
    for (const [id, agent] of entries) {
      if (!isPlaceholderAgentName(agent.name, id)) continue
      const recovered = recoverName?.(workspace.id, id)
      if (!isPlaceholderAgentName(recovered, id)) agents[id] = { ...agent, name: recovered! }
    }
    for (const [id, agent] of Object.entries(agents)) {
      if (isPlaceholderAgentName(agent.name, id)) agents[id] = { ...agent, name: pickWorkspaceAgentName(agents) }
    }
    return { ...workspace, agents }
  })
  return changed ? next : workspaces
}

export function normalizeWorkspaceForPartialize(workspace: Workspace): Workspace {
  return {
    ...workspace,
    mode: normalizeWorkspaceMode(workspace.mode),
    moduleState: partializeWorkspaceModuleState(workspace.moduleState),
    memory: normalizeWorkspaceMemoryConfig(workspace.memory),
    fileExplorerState: normalizeWorkspaceFileExplorerState(workspace.fileExplorerState),
    backlogState: normalizeWorkspaceBacklogState(workspace.backlogState),
    gitPanelState: normalizeWorkspaceGitPanelState(workspace.gitPanelState),
    paneState: partializeWorkspacePaneState(workspace.paneState),
    agents: Object.fromEntries(
      Object.entries(workspace.agents).map(([id, a]) => {
        // Keep durable resume identity in the registry. These fields are not
        // just process noise: Claude uses cliSessionId for `claude --resume`,
        // and Codex uses cliResumeAvailable/cliHasLaunched to restart with
        // `codex resume` after a full app restart. Strip only transient output
        // and one-shot restart state.
        return [
          id,
          normalizeAgentState({
            ...a,
            streamBuffer: '',
            status: 'idle' as const,
            // A prompt that has not reached the CLI yet is launch intent, not
            // durable state: a restart starts the agent at its own prompt.
            cliStartupPrompt: undefined,
            cliRestartNonce: 0,
          }),
        ]
      }),
    ),
    worktreeState: normalizeWorkspaceWorktreeState(workspace.worktreeState),
    editorState: {
      openFiles: (workspace.editorState?.openFiles ?? []).map(({ content: _content, ...f }) => ({
        ...f,
        isDirty: false,
      })),
      activeFilePath: workspace.editorState?.activeFilePath ?? null,
    },
  }
}
