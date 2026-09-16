import { AUTOMATIONS_HOST_WORKSPACE_MODE, type Workspace } from '../../types/workspace'
import { isPlaceholderAgentName } from '../../utils/agentNames'
import {
  isSprintEngineManagedAgent,
  sprintEngineRosterAgentIds,
} from '../../../../shared/sprintengine/agent-identity'
import { normalizeAgentState, pickWorkspaceAgentName } from './agentsSlice'
import { normalizeWorkspaceMemoryConfig } from './memorySlice'
import { normalizeSprintEngineAutoState } from './runStateSlice'
import {
  normalizeWorkspaceBacklogState,
  normalizeWorkspaceFileExplorerState,
  normalizeWorkspaceGitPanelState,
  normalizeWorkspaceMode,
  workspaceFolderKey,
} from './workspacesSlice'
import { normalizeWorkspaceWorktreeState } from './worktreesSlice'
import {
  legacySprintEngineRunState,
  partializeWorkspaceModuleState,
  reconcileWorkspaceModuleState,
  type LegacySprintEnginePersistWorkspace,
} from './workspaceModuleState'
import { partializeWorkspacePaneState } from './workspacePaneSlice'

// Workspace-mode strings whose features were retired. Kept as local literals
// rather than live `WorkspaceMode` constants precisely because nothing may mint
// them again: they are legacy values with no producer left, named here only so
// persisted state written by an older build can be filtered.
//
//   `roadmap`   — store v65: the per-project Roadmap workspace became an
//                 instance-global sidebar surface, and that surface was itself
//                 deleted on 2026-09-05. The plans on disk (the home project's
//                 `backlog/roadmaps/`) are untouched files.
//   `multiloop` — store v66: the feature was removed outright. Any loop state on
//                 disk under the project folder is untouched.
//   `guided-brief` — 2026-09-08: the Design Wizard was deleted outright. The
//                 files it wrote into the project (product/, architecture/,
//                 mockups/, design-system/) are untouched; only the workspace
//                 row, which nothing can render any more, is dropped.
//   `reviews-host` — 2026-09-10: Reviews left the app for an installable module,
//                 which spawns its guide into the workspace the door was opened
//                 from, so the per-project background host has no producer left.
//                 The row and the guide-terminal agent records nested in it go;
//                 the review data on disk (`.sprintengine/review/`) is untouched.
const RETIRED_WORKSPACE_MODES: readonly string[] = ['roadmap', 'multiloop', 'guided-brief', 'reviews-host']

export function mapMigrationWorkspaces<T extends { workspaces: LegacySprintEnginePersistWorkspace[] }>(
  state: T,
  migrate: (workspace: LegacySprintEnginePersistWorkspace) => LegacySprintEnginePersistWorkspace,
): void {
  state.workspaces = state.workspaces.map(migrate)
}

// Sprint Engine roster membership is durable, app-owned PTYs are not: clear the
// launch/resume gate so reopening a run never spawns or resumes an agent on its
// own. Keeps `cliSessionId`/`harnessSessionId` for the same reason the
// automations-host clear does (see the comment there) — identity resolves the
// painted screen; the gate flags are what auto-resume actually reads. The two
// functions stay in step.
export function clearSprintEngineAgentLaunchState(workspace: Workspace): Workspace {
  const run = legacySprintEngineRunState(workspace)
  if (workspace.mode !== 'sprintengine' && !run) return workspace

  const sprintEngineAgentIds = sprintEngineRosterAgentIds(run?.sprintEngineAgents)
  const hasSprintEngineAgents = Object.entries(workspace.agents).some(
    ([id, agent]) => isSprintEngineManagedAgent(agent, { agentId: id, rosterIds: sprintEngineAgentIds })
  )
  if (!hasSprintEngineAgents) return workspace

  return {
    ...workspace,
    agents: Object.fromEntries(
      Object.entries(workspace.agents).map(([id, agent]) => {
        if (!isSprintEngineManagedAgent(agent, { agentId: id, rosterIds: sprintEngineAgentIds })) return [id, agent]
        return [
          id,
          normalizeAgentState({
            ...agent,
            status: 'idle',
            streamBuffer: '',
            cliStartRequested: false,
            cliRestartNonce: 0,
            cliHasLaunched: false,
            cliOnboardingPromptSent: false,
            cliResumeAvailable: false,
            cliResumeRequested: false,
            cliStartupPrompt: undefined,
          }),
        ]
      }),
    ),
  }
}

// The automations-host shell persists and is reused, but its agents are
// finalized automation runs — a full restart must not auto-resume them. Mirror
// `clearSprintEngineAgentLaunchState`: clear the launch/resume GATE
// (`cliHasLaunched`/`cliResumeAvailable`/`cliResumeRequested`/`cliStartRequested`
// + the startup prompt), which is what `shouldResume` reads at mount, so cold
// load never resumes or re-sends the automation directive.
//
// Deliberately KEEP `cliSessionId`/`harnessSessionId`. They are durable
// identity, not launch intent: `cliSessionId` is the key to the painted screen
// on disk (`<userData>/terminal-snapshots/<cliSessionId>.json`), so erasing it
// orphaned the snapshot and left TerminalView minting a fresh uuid — which
// resolved no sidecar, made the paused branch unreachable, and SPAWNED a fresh
// CLI on every cold load. The id is only the resume *token*; nothing auto-resumes
// while the gate flags above stay false.
function clearAutomationsHostAgentLaunchState(workspace: Workspace): Workspace {
  if (workspace.mode !== AUTOMATIONS_HOST_WORKSPACE_MODE) return workspace

  return {
    ...workspace,
    agents: Object.fromEntries(
      Object.entries(workspace.agents).map(([id, agent]) => [
        id,
        normalizeAgentState({
          ...agent,
          status: 'idle',
          streamBuffer: '',
          cliStartRequested: false,
          cliRestartNonce: 0,
          cliHasLaunched: false,
          cliOnboardingPromptSent: false,
          cliResumeAvailable: false,
          cliResumeRequested: false,
          cliStartupPrompt: undefined,
        }),
      ]),
    ),
  }
}

// The Automations host is strictly one-per-project, but the versioned migrate
// ladder is not the only door into the store: backup recovery and cross-window
// storage sync both apply workspace lists without running migrations, and
// pre-v63 builds minted a fresh host per automation run (named after whichever
// run created it). Every list-entry path applies this before accepting a list:
// keep the earliest-created host per folder, drop the later duplicates, and
// restore the kept host's stable 'Automations' surface name when duplicates
// were dropped — a folder that minted duplicates also branded its hosts after
// runs. Hosts with no folder cannot collide and pass through untouched.
// Returns the input array unchanged when there is nothing to dedupe.
export function dedupeAutomationsHostWorkspaces(workspaces: Workspace[]): Workspace[] {
  const hostsByFolder = new Map<string, Workspace[]>()
  for (const workspace of workspaces) {
    if (workspace.mode !== AUTOMATIONS_HOST_WORKSPACE_MODE) continue
    const key = workspaceFolderKey(workspace.folderPath)
    if (key === null) continue
    const group = hostsByFolder.get(key)
    if (group) group.push(workspace)
    else hostsByFolder.set(key, [workspace])
  }

  const keptByFolder = new Map<string, Workspace>()
  for (const [key, group] of hostsByFolder) {
    if (group.length < 2) continue
    keptByFolder.set(
      key,
      group.reduce((earliest, candidate) =>
        (candidate.createdAt ?? 0) < (earliest.createdAt ?? 0) ? candidate : earliest
      ),
    )
  }
  if (keptByFolder.size === 0) return workspaces

  const result: Workspace[] = []
  for (const workspace of workspaces) {
    if (workspace.mode !== AUTOMATIONS_HOST_WORKSPACE_MODE) {
      result.push(workspace)
      continue
    }
    const key = workspaceFolderKey(workspace.folderPath)
    const kept = key === null ? null : keptByFolder.get(key)
    if (!kept) {
      result.push(workspace)
      continue
    }
    if (kept.id !== workspace.id) continue
    result.push(workspace.name === 'Automations' ? workspace : { ...workspace, name: 'Automations' })
  }
  return result
}

// THE retired-workspace-mode filter. One function for every mode in
// RETIRED_WORKSPACE_MODES above, because they all need the same treatment and a
// per-feature copy of it only invites the next one to be forgotten.
//
// It runs on every list-entry path, not only in the migration rung that retired
// each mode: a dev-HMR reload (or any write that stamps the current store
// version onto un-migrated state) would otherwise leave a retired-mode row the
// migrate ladder never revisits, exactly how the v63 host dedupe was bypassed in
// the wild.
//
// This is the only thing standing between a profile written by an older build
// and a workspace row nothing can render, so it outlives the features it names
// and is removable only alongside a store-version floor bump ("we no longer
// migrate profiles older than vNN"). Returns the input array unchanged — same
// reference — when there is no retired-mode row, which is the normal load.
export function dropRetiredModeWorkspaces(workspaces: Workspace[]): Workspace[] {
  const isRetired = (workspace: Workspace): boolean => RETIRED_WORKSPACE_MODES.includes(workspace.mode)
  if (!workspaces.some(isRetired)) return workspaces
  return workspaces.filter((workspace) => !isRetired(workspace))
}

// Every agent carries a real name like the specialists do, but workspaces
// created before that rule (and layout-template seeds that adopted the tab's
// generic label) persisted agents literally named "Agent" / "Agent 2" / "A1".
// Heal them at hydration (merge() runs on every load regardless of the store
// version, like the Automations dedupe above): each placeholder-named agent
// gets a picked name, unique within its workspace, and the layout tab renames
// itself to agent.name on render. Idempotent — a healed name is no longer a
// placeholder — and returns the input array unchanged when nothing needs it.
export function nameGenericWorkspaceAgents(workspaces: Workspace[]): Workspace[] {
  let changed = false
  const next = workspaces.map((workspace) => {
    const entries = Object.entries(workspace.agents ?? {})
    if (!entries.some(([, agent]) => isPlaceholderAgentName(agent.name))) return workspace
    changed = true
    const agents: Workspace['agents'] = { ...workspace.agents }
    for (const [id, agent] of entries) {
      if (!isPlaceholderAgentName(agent.name)) continue
      agents[id] = { ...agent, name: pickWorkspaceAgentName(agents) }
    }
    return { ...workspace, agents }
  })
  return changed ? next : workspaces
}

export function preserveNewerSprintEngineAutomationState(
  incomingWorkspace: Workspace,
  currentWorkspace: Workspace | undefined,
): Workspace {
  if (!currentWorkspace?.sprintEngineAutoState) return incomingWorkspace

  const incomingAutoState = normalizeSprintEngineAutoState(incomingWorkspace.sprintEngineAutoState)
  const currentAutoState = normalizeSprintEngineAutoState(currentWorkspace.sprintEngineAutoState)
  const incomingChangedAt = incomingAutoState.changedAt
  const currentChangedAt = currentAutoState.changedAt
  const currentIsNewer =
    typeof currentChangedAt === 'number'
    && (
      typeof incomingChangedAt !== 'number'
      || currentChangedAt > incomingChangedAt
    )

  if (!currentIsNewer) return incomingWorkspace
  return {
    ...incomingWorkspace,
    sprintEngineAutoState: currentAutoState,
  }
}

export function normalizeWorkspaceForPartialize(workspace: Workspace): Workspace {
  const sprintEngineAutoState = normalizeSprintEngineAutoState(workspace.sprintEngineAutoState)
  const launchSafeWorkspace = reconcileWorkspaceModuleState(
    clearAutomationsHostAgentLaunchState(
      clearSprintEngineAgentLaunchState(workspace),
    ),
  )
  return {
    ...launchSafeWorkspace,
    mode: normalizeWorkspaceMode(launchSafeWorkspace.mode, legacySprintEngineRunState(launchSafeWorkspace)),
    // The live run projection is a cache of on-disk projection.json. Persisting
    // it serialized the full tasks+artifacts blob into localStorage on every
    // 4s poll. Durable identity (context, role CLI defaults) now lives in
    // moduleState.sprintengine and is what survives a restart. The live
    // projection rehydrates from disk within one supervisor tick.
    moduleState: partializeWorkspaceModuleState(launchSafeWorkspace.moduleState),
    memory: normalizeWorkspaceMemoryConfig(launchSafeWorkspace.memory),
    fileExplorerState: normalizeWorkspaceFileExplorerState(launchSafeWorkspace.fileExplorerState),
    backlogState: normalizeWorkspaceBacklogState(launchSafeWorkspace.backlogState),
    gitPanelState: normalizeWorkspaceGitPanelState(launchSafeWorkspace.gitPanelState),
    paneState: partializeWorkspacePaneState(launchSafeWorkspace.paneState),
    sprintEngineAutoState,
    // Session-only creation launch intent; never persist it, or a restart
    // would replay the initial spawns.
    sprintEngineInitialSpawnAgentIds: undefined,
    agents: Object.fromEntries(
      Object.entries(launchSafeWorkspace.agents).map(([id, a]) => {
        const shouldKeepStartupPrompt =
          !a.cliOnboardingPromptSent
          && a.kind === 'specialist'
          && Boolean(a.specialistId)
        const cliStartupPrompt = shouldKeepStartupPrompt ? a.cliStartupPrompt : undefined

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
            cliStartupPrompt,
            cliRestartNonce: 0,
          }),
        ]
      }),
    ),
    worktreeState: normalizeWorkspaceWorktreeState(launchSafeWorkspace.worktreeState),
    editorState: {
      openFiles: (launchSafeWorkspace.editorState?.openFiles ?? []).map(({ content: _content, ...f }) => ({
        ...f,
        isDirty: false,
      })),
      activeFilePath: launchSafeWorkspace.editorState?.activeFilePath ?? null,
    },
  }
}
