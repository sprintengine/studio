/**
 * The Sprint Engine workspace record, composed in one place (MC-2160).
 *
 * A sprint workspace is not a plain workspace: its agent map is seeded from the
 * run's lazy roster (one record per seat, each carrying the CLI/model/effort the
 * roster picked), its layout is the board tab rather than the template's, and
 * its engine identity lives in `moduleState.sprintengine`.
 *
 * That composition used to live inside the renderer store's `addWorkspace`.
 * Main mints sprint workspaces itself now (a headless `sprint.create`), so a
 * second copy would drift on the next field added — the store's sprint branch
 * and main's creation service both call in here instead.
 *
 * Pure: every impure input (the id, the clock, the random agent name) arrives as
 * an argument.
 */
import type { IJsonModel } from 'flexlayout-react'
import type {
  AgentCli,
  LayoutTemplate,
  SprintEngineAutoState,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleId,
  SprintEngineRoleModelOverrides,
  SprintEngineState,
  SprintEngineWorkspaceContext,
  Workspace,
} from '../../renderer/src/types/workspace'
import { defaultAgent } from './agent-state'
import {
  buildSprintEngineAgentRosterForState,
  resolveSprintEngineRoleRuntime,
  sprintEngineRoleKey,
} from './state'

/** The module id the canonical `moduleState` entry is keyed by. */
export const SPRINT_ENGINE_WORKSPACE_MODULE_ID = 'sprintengine'

/**
 * The `moduleState.sprintengine` bag entry (MC-2573). Durable identity
 * (`context`, `roleCliDefaults`) lives here and persists; the live run
 * projection (`state`) is a cache of on-disk `projection.json` and is
 * stripped at persist. Re-exported from the renderer workspace-type module
 * so MC-2577 can consume the same shape.
 */
export type SprintEngineModuleState = {
  state?: SprintEngineState | null
  context?: SprintEngineWorkspaceContext | null
  roleCliDefaults?: SprintEngineRoleCliDefaults
}

/** The template id every sprint workspace records, and the picker entry's id. */
const SPRINT_ENGINE_TEMPLATE_ID = 'sprintengine-mode'

const sprintEngineBoardTab = (): Record<string, unknown> => ({
  type: 'tab',
  name: 'Sprint',
  component: 'sprintengine',
  enableClose: false,
})

const sprintEngineAgentTab = (id: string, name: string): Record<string, unknown> => ({
  type: 'tab',
  name,
  component: 'agent',
  config: { agentId: id },
})

/**
 * The board layout a sprint workspace stores. `includeAgentTabs: false` is what
 * creation uses — the roster's terminals are docked on demand, not seeded as
 * tabs — while the migration/rehydration callers keep the agent column.
 */
export function sprintEngineTabsLayoutModel(
  sprintEngineState: SprintEngineState | null,
  agents: Workspace['agents'] = {},
  options?: { includeAgentTabs?: boolean },
): IJsonModel {
  return {
    global: { tabSetEnableDrop: true, tabEnableClose: true },
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          weight: options?.includeAgentTabs === false ? 100 : 58,
          // The SE board owns its own segmented nav (workspace top bar), so the
          // FlexLayout tab strip on this tabset would just be redundant chrome.
          enableTabStrip: false,
          children: [sprintEngineBoardTab()],
        },
        ...(options?.includeAgentTabs === false
          ? []
          : [{
            type: 'tabset',
            weight: 42,
            children: buildSprintEngineAgentRosterForState(sprintEngineState).map((agent) =>
              sprintEngineAgentTab(agent.id, agents[agent.id]?.name ?? agent.label)),
          }]),
      ],
    },
  } as IJsonModel
}

/**
 * The picker/template descriptor a sprint workspace is minted from. Returns a
 * fresh object per call because callers hand `layout` on to layout transforms
 * that may rewrite it in place.
 */
export function createSprintEngineLayoutTemplate(): LayoutTemplate {
  return {
    id: SPRINT_ENGINE_TEMPLATE_ID,
    name: 'Sprint',
    description: 'Inbox, Agents, and Tasks together in one stable board.',
    previewSlots: [{ x: 4, y: 4, w: 292, h: 102, type: 'editor', label: 'Sprint' }],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            weight: 100,
            children: [sprintEngineBoardTab()],
          },
        ],
      },
    } as LayoutTemplate['layout'],
  }
}

type SprintEngineWorkspaceAgentsInput = {
  sprintEngineState: SprintEngineState
  /** Normalized role -> CLI map; every seat resolves through it. */
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>
  /** Per-agent CLI the operator pinned in the roster editor, by agent id. */
  agentCliOverrides?: Record<string, string> | null
  roleModelOverrides?: SprintEngineRoleModelOverrides | null
  /** Role keys whose seat carries a start-at-launch intent. */
  initialSpawnRoles?: SprintEngineRoleId[] | null
  /** Mints the human name a fresh seat gets; impure, so it is injected. */
  pickAgentName: (agents: Workspace['agents']) => string
}

type SprintEngineWorkspaceAgents = {
  agents: Workspace['agents']
  initialSpawnAgentIds: string[]
}

/**
 * Seed one agent record per roster seat.
 *
 * The seeded cli/model/effort are not decoration: the coordinator seat launches
 * from THIS record before any projection arrives, so a value left out here
 * silently launches the run's first agent on the CLI's own defaults (MC-1450).
 */
function buildSprintEngineWorkspaceAgents(
  input: SprintEngineWorkspaceAgentsInput,
): SprintEngineWorkspaceAgents {
  const agents: Workspace['agents'] = {}
  const initialSpawnRoles = new Set(input.initialSpawnRoles ?? [])
  const initialSpawnAgentIds: string[] = []

  for (const agent of buildSprintEngineAgentRosterForState(input.sprintEngineState)) {
    const overrideCli = input.agentCliOverrides?.[agent.id]
    const rosterCli = typeof overrideCli === 'string' && overrideCli.trim()
      ? overrideCli.trim()
      : resolveSprintEngineRoleCli(input.roleCliDefaults, agent.role)
    // An explicit roster model choice wins; null or absent means the user picked
    // the CLI default (no model flag).
    const modelOverride = input.roleModelOverrides?.[sprintEngineRoleKey(agent.role)]
    const rosterModel = modelOverride === null ? undefined : modelOverride?.trim() || undefined
    // The effort level comes from the run's own `roleRuntimes` (what init just
    // wrote, read back off the projection) rather than a second map, so this
    // seeded record already says what the first reconcile would say.
    const rosterReasoning = resolveSprintEngineRoleRuntime(
      input.sprintEngineState.roleRuntimes,
      agent.role,
    )?.cliReasoning
    agents[agent.id] = {
      ...defaultAgent(agent.id, input.pickAgentName(agents), 'sprintengine'),
      cli: rosterCli,
      cliModel: rosterModel,
      ...(rosterReasoning ? { cliReasoning: rosterReasoning } : {}),
      // An explicit per-agent CLI pick outranks the role config on every later
      // reconcile (MC-1450 hierarchy), so record it as a durable override rather
      // than a silent snapshot.
      ...(typeof overrideCli === 'string' && overrideCli.trim()
        ? { cliRuntimeOverride: { cli: overrideCli.trim() } }
        : {}),
    }
    if (initialSpawnRoles.has(sprintEngineRoleKey(agent.role))) initialSpawnAgentIds.push(agent.id)
  }

  return { agents, initialSpawnAgentIds }
}

/**
 * The CLI one roster seat launches on. Keyed through `sprintEngineRoleKey`, so a
 * roleless run's seats resolve against the roleless entry the roster seeds
 * rather than falling through.
 *
 * SprintEngineRoleId is open-ended (custom/user-defined roles), so a role
 * missing from the defaults map must never throw here: workspace registration
 * runs AFTER the engine init has written run.yaml and (in worktree mode) created
 * the git worktree+branch, so a throw orphans a real on-disk run with no
 * workspace. Fall back to the team's architect CLI when one is configured, else
 * the universal default.
 */
export function resolveSprintEngineRoleCli(
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>,
  role: SprintEngineRoleId | undefined,
): AgentCli {
  const cli = roleCliDefaults[sprintEngineRoleKey(role)]
  if (typeof cli === 'string' && cli.trim()) return cli.trim()
  return roleCliDefaults.architect?.trim() || 'claude-code'
}

export type SprintEngineWorkspaceRecordInput = SprintEngineWorkspaceAgentsInput & {
  workspaceId: string
  /** Already-normalized run context; null only when the run has no folder. */
  sprintEngineContext: SprintEngineWorkspaceContext | null
  folderPath: string | null
  /** Already-normalized automation state (mode, preset, concurrency cap). */
  sprintEngineAutoState: SprintEngineAutoState
  createdAt: number
  /** Defaults for the workspace sub-states the store owns elsewhere. */
  defaults: {
    worktreeState: Workspace['worktreeState']
    memory: Workspace['memory']
    editorState: Workspace['editorState']
    fileExplorerState: Workspace['fileExplorerState']
  }
  /** Set only when the run works in a git worktree. */
  worktree?: Workspace['worktree'] | null
}

export type SprintEngineWorkspaceRecord = {
  workspace: Workspace
  agents: Workspace['agents']
  initialSpawnAgentIds: string[]
}

/**
 * The full sprint workspace record. `name` is the run's own name, which is
 * always meaningful, so `titleLocked` is set — the first prompt must never
 * auto-title over a roster name.
 */
export function composeSprintEngineWorkspaceRecord(
  input: SprintEngineWorkspaceRecordInput,
): SprintEngineWorkspaceRecord {
  const { agents, initialSpawnAgentIds } = buildSprintEngineWorkspaceAgents(input)
  const workspace: Workspace = {
    id: input.workspaceId,
    name: input.sprintEngineState.name,
    titleLocked: true,
    mode: 'sprintengine',
    folderPath: input.folderPath,
    folderMissing: false,
    ...(input.worktree ? { worktree: input.worktree } : {}),
    templateId: SPRINT_ENGINE_TEMPLATE_ID,
    layoutModel: sprintEngineTabsLayoutModel(input.sprintEngineState, agents, { includeAgentTabs: false }),
    agents,
    worktreeState: input.defaults.worktreeState,
    memory: input.defaults.memory,
    editorState: input.defaults.editorState,
    fileExplorerState: input.defaults.fileExplorerState,
    moduleState: {
      [SPRINT_ENGINE_WORKSPACE_MODULE_ID]: {
        state: input.sprintEngineState,
        context: input.sprintEngineContext,
        roleCliDefaults: input.roleCliDefaults,
      } satisfies SprintEngineModuleState,
    },
    ...(initialSpawnAgentIds.length > 0 ? { sprintEngineInitialSpawnAgentIds: initialSpawnAgentIds } : {}),
    sprintEngineAutoState: input.sprintEngineAutoState,
    createdAt: input.createdAt,
  }
  return { workspace, agents, initialSpawnAgentIds }
}

export type SprintEngineWorkspaceModuleComposeInput = Omit<
  SprintEngineWorkspaceRecordInput,
  'sprintEngineState' | 'sprintEngineContext' | 'roleCliDefaults'
> & {
  module: {
    state: SprintEngineState
    context: SprintEngineWorkspaceContext | null
    roleCliDefaults: SprintEngineRoleCliDefaults
  }
}

/** Compose a sprint workspace from the module bag shape (MC-2573). */
export function composeSprintEngineWorkspaceFromModule(
  input: SprintEngineWorkspaceModuleComposeInput,
): SprintEngineWorkspaceRecord {
  const { module, ...rest } = input
  return composeSprintEngineWorkspaceRecord({
    ...rest,
    sprintEngineState: module.state,
    sprintEngineContext: module.context,
    roleCliDefaults: module.roleCliDefaults,
  })
}
