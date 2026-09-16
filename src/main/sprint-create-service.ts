/**
 * SprintCreateService — creating a sprint run is a main-process capability
 * (MC-2160).
 *
 * `sprint.create` was the last mutation the automation gateway delegated to a
 * window. Nothing about it needed one: initializing the Python run store,
 * scanning the backlog, composing the handoff prompt, and registering the
 * workspace are all things main can do. What kept it in the renderer was where
 * the CODE lived — the wizard's controllers and the workspace store — so a
 * headless `sprint.create` failed for want of a window, and a windowed one had
 * to wait up to 5s for a FlexLayout model to mount before the board could launch
 * the architect.
 *
 * That composition is shared now (`src/shared/sprintengine/workspace-creation.ts`
 * and `new-team-creation.ts`, byte-identical for both processes), and this
 * service is main's driver for it:
 *
 * - **The roster** resolves from the main-owned launch settings mirror
 *   (MC-2154), through the same `saved-rosters.ts` rules the wizard uses.
 * - **The runtime** (CLI/model/effort) validates against the plugin registry —
 *   the CLIs this app can actually launch.
 * - **The source plan** for a backlog/epic/selection launch comes from the
 *   shared backlog scan driven with node fs, so an epic brings its children and
 *   a multi-selection builds the same bundle the Backlog door builds.
 * - **The workspace** is adopted into main's registry (MC-2158), which makes the
 *   new id readable in the same call — no bus-confirmation poll.
 * - **The architect** is spawned by the scheduler, not by a board mount: the run
 *   registers with `SprintRuntime` and its persisted intent is written, and the
 *   cycle's run-start bootstrap takes it from there. That is the one behavioural
 *   change, and it is what makes creation work with zero windows.
 *
 * A run created here carries no board-mount spawn intent
 * (`sprintEngineInitialSpawnAgentIds`), so a window that is open cannot also
 * consume one — exactly one coordinator spawn either way.
 *
 * KNOWN LIMIT: the coordinator's handoff prompt is delivered to the scheduler
 * in this session only. The workspace registry deliberately strips a sprint
 * agent's `cliStartupPrompt` when it persists (`normalizeWorkspaceForRegistry`),
 * so an app restart between creation and the first spawn loses it, and the
 * coordinator starts on the plain agent prompt instead — it still discovers it
 * must plan through `sprintengine.agent.join`/`task.next`, and the run's sources
 * are already seeded into run.yaml, so this degrades rather than breaks.
 */
import type {
  SprintEngineArtifactCommandResult,
  SprintEngineStateInitializeInput,
} from '../shared/electron-api'
import type { SprintCreateRequest, SprintCreateResult } from '../shared/sprint-create'
import type { SprintEngineLaunchSettings } from '../shared/sprintengine/launch-settings'
import type {
  SprintEngineAutomationIntentRecord,
} from '../shared/sprintengine/automation-intent'
import type {
  SprintEngineAutomationMode,
  SprintEngineCliPermissionPreset,
} from '../shared/sprintengine/automation-types'
import type { SprintRuntimeRunRegistration } from '../shared/sprintengine/runtime-bridge'
import type {
  SprintEngineRoleCounts,
  SprintEngineRoleModelOverrides,
  SprintEngineRoleReasoningOverrides,
  SprintEngineSourceBundleItem,
  SprintEngineSourcePlanKind,
  Workspace,
} from '../renderer/src/types/workspace'
import {
  DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS,
  DEFAULT_SPRINT_ENGINE_ROLE_COUNTS,
  NO_ROLES_ROSTER_ID,
  activeSprintEngineRoleIds,
  findSavedSprintEngineRoster,
  isNoRolesRosterRef,
  resolveInitialSprintEngineRoster,
  sprintEngineLaunchRoleCounts,
} from '../shared/sprintengine/saved-rosters'
import { SPRINT_ENGINE_ROLELESS_KEY } from '../shared/sprintengine/state'
import {
  deriveSprintEngineAutomationDesiredMode,
  normalizeSprintEngineAutoState,
  sprintEngineAutomationInitialStateForMode,
  sprintEngineAutomationModeForRunOptions,
} from '../shared/sprintengine/automation-lifecycle'
import {
  SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS,
  SprintEngineNewTeamCreationError,
  clampSprintEngineMaxParallelAgents,
  runSprintEngineNewTeamCreation,
} from '../shared/sprintengine/new-team-creation'
import { launchPlanSourcedSprint } from '../shared/sprintengine/workspace-creation'
import type {
  SprintEngineWorkspaceCreationPort,
  SprintEngineWorkspaceRegistration,
} from '../shared/sprintengine/workspace-creation-port'
import { composeSprintEngineWorkspaceFromModule } from '../shared/sprintengine/workspace-record'
import { inferSourcePlanKind, joinPath, planBasename, toTitleName, workspaceRelativePath } from '../shared/source-paths'
import { scanBacklog, type BacklogItem, type BacklogFilesystemAdapter } from '../shared/backlog/scan'
import { CLOSED_EPIC_CHILD_STATUSES, isBacklogEpicPath } from '../shared/backlog/epics'
import { buildBacklogSelectionSourcePlan } from '../shared/sprintengine/selection-source-plan'
import { buildSprintEngineRunLink } from '../shared/backlog/sprintengine-links'
import { pickRandomAgentName } from '../shared/agent-names'
import { normalizeSprintEngineRoleCliDefaults } from '../shared/sprintengine/role-cli-defaults'

export type SprintCreateServiceDeps = {
  /** The launch settings main spawns with (MC-2154); saved rosters live here. */
  getLaunchSettings: () => SprintEngineLaunchSettings
  /**
   * CLI plugin ids a sprint may staff: the hook-capable subset of the registry
   * (`cli.runtime.list` flags these `agentSelectable: true`; rows it flags
   * false are registry-held for install/detect only and are refused here).
   */
  listLaunchableClis: () => string[]
  /** The one-shot Python run-store init (`sprintengine-artifacts.ts`). */
  initializeSprintEngineState: (
    input: SprintEngineStateInitializeInput
  ) => Promise<SprintEngineArtifactCommandResult>
  /** Filesystem the backlog scan and source reads run against. */
  fs: BacklogFilesystemAdapter & { readFile: (path: string) => Promise<string> }
  /** Mint the id the adopted workspace record carries. */
  newWorkspaceId: () => string
  /** Commit a composed workspace record to main's registry. */
  adoptWorkspace: (
    workspace: Workspace,
    windowId: string,
    folderPath: string | null,
  ) => { ok: boolean; message?: string }
  /** The window a new workspace joins — main's primary workspace window. */
  primaryWorkspaceWindowId: () => string
  updateWorkspaceAgent: (
    workspaceId: string,
    agentId: string,
    patch: Partial<Workspace['agents'][string]>,
  ) => void
  /** Seed the run's persisted automation intent (`sprintengine-automation-service.ts`). */
  hydrateAutomationMode: (input: {
    statePath: string
    mode: SprintEngineAutomationMode
  }) => Promise<{ ok: boolean; message?: string; record?: SprintEngineAutomationIntentRecord }>
  setCliPermissionPreset: (input: {
    statePath: string
    preset: SprintEngineCliPermissionPreset
  }) => Promise<{ ok: boolean; message?: string }>
  /** Hand the run to the main-process scheduler, which bootstraps its coordinator. */
  registerSprintRun: (registration: SprintRuntimeRunRegistration) => void
  /** Record the Backlog execution link for a `backlog/` source. */
  addBacklogLink: (input: {
    workspaceRoot: string
    relativePath: string
    link: ReturnType<typeof buildSprintEngineRunLink>
    status?: BacklogItem['status']
  }) => Promise<{ ok: boolean; message?: string }>
  /** Surface a start that could not be persisted; never silently swallowed. */
  logDiagnostic?: (input: { level: 'warning'; title: string; message: string; details?: string }) => void
}

export function createSprintCreateService(deps: SprintCreateServiceDeps) {
  // -------------------------------------------------------------------------
  // Roster + runtime resolution
  // -------------------------------------------------------------------------

  type RosterResolution =
    | { ok: true; roster: ReturnType<typeof resolveInitialSprintEngineRoster> }
    | { ok: false; response: SprintCreateResult }

  /**
   * Roster precedence for an externally-created run: an explicit `roster` (role
   * id -> count) wins outright; else a named saved roster (`rosterName`); else
   * the No-roles built-in.
   *
   * The explicit path must seed `roleCliDefaults` for EVERY role it staffs.
   * `DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS` is derived from the built-in count
   * map's keys, which omit registry roles like `spec_reviewer` and
   * `nuclear_reviewer` — a role with no CLI resolves to no runtime and is
   * silently skipped at spawn (the 2026-07-19 gap pinned in
   * auto-run-cycle.test.ts).
   */
  function resolveRequestedRoster(request: SprintCreateRequest): RosterResolution {
    const savedRosters = deps.getLaunchSettings().sprintEngineRoleSettings?.savedRosters ?? []

    const explicit = request.roster
    if (explicit && Object.keys(explicit).length > 0) {
      // Zero-based, NOT seeded from the default counts: absent means off (owner,
      // 2026-07-14). Seeding from `DEFAULT_SPRINT_ENGINE_ROLE_COUNTS` would carry
      // its architect:1 / developer:1 into a roster that never asked for them —
      // the same "a default team that overrides user config" bug the empty-counts
      // base exists to prevent. The full key set is kept so the map stays the
      // shape `Required<>` consumers expect.
      const roleCounts: Record<string, number> = Object.fromEntries(
        Object.keys(DEFAULT_SPRINT_ENGINE_ROLE_COUNTS).map((role) => [role, 0]),
      )
      for (const [role, count] of Object.entries(explicit)) {
        const trimmed = role.trim()
        if (!trimmed) {
          return { ok: false, response: failure('sprint_invalid_roster', 'Roster role ids must be non-empty.') }
        }
        if (!Number.isInteger(count) || count < 0) {
          return {
            ok: false,
            response: failure('sprint_invalid_roster', `Roster count for "${trimmed}" must be a non-negative integer.`),
          }
        }
        roleCounts[trimmed] = count
      }
      if (!Object.values(roleCounts).some((count) => count > 0)) {
        return { ok: false, response: failure('sprint_invalid_roster', 'Roster must staff at least one role.') }
      }
      const roleCliDefaults = { ...DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS } as Record<string, string>
      for (const role of Object.keys(roleCounts)) {
        if (!roleCliDefaults[role]) roleCliDefaults[role] = 'claude-code'
      }
      return {
        ok: true,
        roster: {
          selectedRosterId: null,
          // SEAM (MC-1876 x sprint.create): an EXPLICIT role map is the caller
          // naming exact roles, so it is 'roles' formation by definition and wins
          // over the No-roles default. Deliberate: a caller that went to the
          // trouble of listing roles must not have them replaced by a plain-agent
          // pool. To get No roles, send no roster at all.
          mode: 'roles',
          roleCounts,
          roleModelOverrides: {},
          roleCliDefaults,
        } as ReturnType<typeof resolveInitialSprintEngineRoster>,
      }
    }

    const requestedRosterName = request.rosterName?.trim()

    // The built-in resolves by name or id, and is never "not found".
    if (isNoRolesRosterRef(requestedRosterName)) {
      return { ok: true, roster: builtInRoster(savedRosters, NO_ROLES_ROSTER_ID) }
    }

    // An unknown NAMED roster is an explicit failure — silently falling back
    // would staff the run with a roster the caller never picked. Only an ABSENT
    // roster gets the No-roles default (MC-1876); a named-but-missing one must
    // still fail loudly.
    const namedRoster = findSavedSprintEngineRoster(savedRosters, requestedRosterName)
    if (requestedRosterName && !namedRoster) {
      return {
        ok: false,
        response: failure('sprint_unknown_roster', `Saved roster "${requestedRosterName}" was not found.`),
      }
    }

    // MC-1876 — THE DEFAULT FLIP. An externally-created run (a plan step with
    // no `roster:`, an automation with no roster configured) used to resolve
    // through `lastSelectedRosterId`: whatever roster the user last touched in
    // the sprint WIZARD. A multi-step plan running over days could therefore staff
    // step 3 differently from step 1 because someone opened the wizard in between, and
    // nothing in the UI admitted it. Absent now means No roles — deterministic,
    // and independent of unrelated UI state.
    return { ok: true, roster: builtInRoster(savedRosters, namedRoster?.id ?? NO_ROLES_ROSTER_ID) }
  }

  function builtInRoster(
    savedRosters: NonNullable<SprintEngineLaunchSettings['sprintEngineRoleSettings']['savedRosters']>,
    explicitRosterRef: string,
  ): ReturnType<typeof resolveInitialSprintEngineRoster> {
    return resolveInitialSprintEngineRoster({
      savedRosters,
      lastSelectedRosterId: null,
      savedRoster: null,
      defaultRoleCounts: DEFAULT_SPRINT_ENGINE_ROLE_COUNTS,
      defaultRoleCliDefaults: DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS,
      explicitRosterRef,
    })
  }

  type RuntimeResolution =
    | {
      ok: true
      roleCliDefaults: ReturnType<typeof resolveInitialSprintEngineRoster>['roleCliDefaults']
      roleModelOverrides: SprintEngineRoleModelOverrides
      roleReasoningOverrides: SprintEngineRoleReasoningOverrides
    }
    | { ok: false; response: SprintCreateResult }

  /**
   * The run's execution runtime as the caller asked for it (MC-2120), resolved
   * against the roster that will actually staff the run. Three maps out, exactly
   * the ones `buildSprintEngineRoleRuntimes` unions into run.yaml `roleRuntimes`:
   *
   *   `runtime`  → the ROLELESS seat, and the fallback for every staffed role the
   *                per-role maps do not name. A roleless run has no role ids at
   *                all, so without this its one seat is unpinnable.
   *   `roleClis` / `roleModels` / `roleEfforts` → per role, winning over `runtime`.
   *
   * A role id neither staffed nor the roleless seat is a LOUD failure, matching
   * the unknown-`rosterName` precedent: a typo'd role that silently did nothing
   * would launch a run on models the caller never chose and never be told.
   */
  function resolveRequestedRuntime(
    request: SprintCreateRequest,
    roster: ReturnType<typeof resolveInitialSprintEngineRoster>,
    launchRoleCounts: SprintEngineRoleCounts,
  ): RuntimeResolution {
    // A named runtime that cannot spawn fails the start loudly (MC-2145's trap),
    // matching the unknown-`rosterName` precedent — a silent fallback would
    // launch a plan's every step on an agent the author never picked and
    // never be told.
    const launchable = new Set(deps.listLaunchableClis())
    const requestedClis = [request.runtime?.cli, ...Object.values(request.roleClis ?? {})]
      .filter((cli): cli is string => Boolean(cli))
    if (requestedClis.length > 0) {
      const unknown = requestedClis.find((cli) => !launchable.has(cli))
      if (unknown) {
        return {
          ok: false,
          response: failure(
            'sprint_unknown_runtime',
            `Agent CLI "${unknown}" is not installed, not known, or cannot report agent status, so this sprint cannot start on it. Install a hook-capable CLI, or pick another agent.`,
          ),
        }
      }
    }
    const roleCliDefaults = { ...roster.roleCliDefaults }
    const roleModelOverrides: SprintEngineRoleModelOverrides = { ...roster.roleModelOverrides }
    const roleReasoningOverrides: SprintEngineRoleReasoningOverrides = {}

    // Staffed roles, plus the roleless seat when nothing is staffed — the two
    // shapes a run can take, and the only keys a caller may address.
    const staffed = activeSprintEngineRoleIds(launchRoleCounts).map((role) => String(role))
    const addressable = staffed.length > 0 ? staffed : [SPRINT_ENGINE_ROLELESS_KEY]

    for (const [field, map] of [
      ['roleClis', request.roleClis],
      ['roleModels', request.roleModels],
      ['roleEfforts', request.roleEfforts],
    ] as const) {
      for (const role of Object.keys(map ?? {})) {
        if (addressable.includes(role)) continue
        return {
          ok: false,
          response: failure(
            'sprint_unknown_role',
            staffed.length > 0
              ? `"${field}" names role "${role}", which this run does not staff. Staffed roles: ${staffed.join(', ')}.`
              : `"${field}" names role "${role}", but this run staffs no roles. Use "runtime" to pin its agents' model and effort.`,
          ),
        }
      }
    }

    // The run-level runtime first, so a per-role pick below overrides it. It
    // reaches the roleless seat AND every staffed role: an explicit request field
    // is a more specific intent than whatever a saved roster stored.
    for (const role of addressable) {
      if (request.runtime?.cli) roleCliDefaults[role] = request.runtime.cli
      if (request.runtime?.model) roleModelOverrides[role] = request.runtime.model
      if (request.runtime?.effort) roleReasoningOverrides[role] = request.runtime.effort
    }
    // A null CLI means "no per-role pick", which is the run-level runtime (or the
    // role's stock default) — never a role recorded with no CLI at all, which
    // hard-fails the roster runner at spawn.
    for (const [role, cli] of Object.entries(request.roleClis ?? {})) {
      if (cli) roleCliDefaults[role] = cli
    }
    for (const [role, model] of Object.entries(request.roleModels ?? {})) {
      roleModelOverrides[role] = model
    }
    for (const [role, effort] of Object.entries(request.roleEfforts ?? {})) {
      roleReasoningOverrides[role] = effort
    }
    // Validate the RESOLVED per-role set too, not only what the request typed:
    // a saved roster seeds roleCliDefaults the caller never mentioned, so a
    // roster pinned to a since-retired or hook-incapable CLI would otherwise
    // bypass the loud-failure trap above and hard-fail at spawn instead.
    const unlaunchable = Object.entries(roleCliDefaults).find(
      ([, cli]) => typeof cli === 'string' && cli.length > 0 && !launchable.has(cli)
    )
    if (unlaunchable) {
      return {
        ok: false,
        response: failure(
          'sprint_unknown_runtime',
          `The saved roster pins role "${unlaunchable[0]}" to agent CLI "${unlaunchable[1]}", which is not installed, not known, or cannot report agent status. Update the roster, or pick another agent.`,
        ),
      }
    }
    return { ok: true, roleCliDefaults, roleModelOverrides, roleReasoningOverrides }
  }

  /**
   * The run's agent ceiling: the caller's value when it sent one (the dialog's
   * *Max concurrent agents*), else the default every other creation path takes.
   * Clamped here because the two paths below do not share one clamp — the
   * plan-sourced path writes `sprintEngineAutoState` straight through.
   */
  function requestedMaxConcurrentAgents(request: SprintCreateRequest): number {
    return request.maxConcurrentAgents === undefined
      ? SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS
      : clampSprintEngineMaxParallelAgents(request.maxConcurrentAgents)
  }

  // -------------------------------------------------------------------------
  // Workspace registration
  // -------------------------------------------------------------------------

  /**
   * Main's half of the shared creation port. The composed record is adopted into
   * the registry, which persists it and broadcasts `workspace.created` to every
   * open window — so a window that IS open shows the new sprint without having
   * created it.
   *
   * `initialSpawnRoles` is deliberately dropped: the board-mount handshake is
   * not in this loop. The scheduler's run-start bootstrap spawns the coordinator
   * seat once the run is registered, and leaving a spawn intent on the record
   * would let an open board spawn a second one.
   */
  function workspacePort(): SprintEngineWorkspaceCreationPort & { record: Workspace | null } {
    const port = {
      // The record as COMPOSED, which is what the scheduler is handed. The
      // registry's own copy is normalized on adoption — it drops
      // `sprintEngineState` (the engine owns projection.json) and a
      // sprintengine agent's `cliStartupPrompt` — so re-reading it would hand
      // the scheduler a coordinator with no handoff prompt.
      record: null as Workspace | null,
      addWorkspace(registration: SprintEngineWorkspaceRegistration): string {
        const workspaceId = deps.newWorkspaceId()
        const { workspace } = composeSprintEngineWorkspaceFromModule({
          workspaceId,
          module: {
            state: registration.sprintEngineState,
            context: registration.sprintEngineContext,
            roleCliDefaults: normalizeSprintEngineRoleCliDefaults(registration.roleCliDefaults),
          },
          folderPath: registration.folderPath,
          agentCliOverrides: registration.agentCliOverrides ?? null,
          roleModelOverrides: registration.roleModelOverrides ?? null,
          initialSpawnRoles: null,
          sprintEngineAutoState: normalizeSprintEngineAutoState(registration.sprintEngineAutoState),
          createdAt: Date.now(),
          pickAgentName: (agents) => pickRandomAgentName(Object.values(agents).map((agent) => agent.name)),
          defaults: {
            worktreeState: { containerPath: null, entries: {}, updatedAt: null },
            memory: { relativeRoot: null },
            editorState: { openFiles: [], activeFilePath: null },
            fileExplorerState: { expandedPaths: [], selectedPath: null },
          },
        })
        const adopted = deps.adoptWorkspace(
          workspace,
          registration.windowId?.trim() || deps.primaryWorkspaceWindowId(),
          registration.folderPath,
        )
        if (!adopted.ok) {
          throw new Error(adopted.message || 'The sprint workspace could not be registered.')
        }
        port.record = workspace
        return workspaceId
      },
      setStartupPrompt({ workspaceId, agentId, startupPrompt }: {
        workspaceId: string
        agentId: string
        startupPrompt: string
      }): void {
        const patch = { cliStartupPrompt: startupPrompt, cliOnboardingPromptSent: false }
        // Onto the bus, so an open window's board shows the queued prompt...
        deps.updateWorkspaceAgent(workspaceId, agentId, patch)
        // ...and onto the record the scheduler is registered with, which the
        // registry's normalization would otherwise have stripped it from.
        if (port.record?.id === workspaceId && port.record.agents[agentId]) {
          port.record.agents = {
            ...port.record.agents,
            [agentId]: { ...port.record.agents[agentId], ...patch },
          }
        }
      },
    }
    return port
  }

  /**
   * Persist the run's intent, THEN register it with the scheduler — that order
   * matters. The sidecar write is what lifts a run out of `manual`, and
   * `registerRun` re-reads the sidecar itself, so writing first means the entry
   * adopts the real mode on its own read rather than depending on the hydration
   * notification landing after the entry exists.
   *
   * A `manual` run is registered too — the scheduler holds it idle, and the
   * sidecar records the preset so a restart resumes with the caller's choice
   * rather than the default.
   */
  async function startRun(workspace: Workspace, statePath: string): Promise<void> {
    const autoState = workspace.sprintEngineAutoState
    const mode = deriveSprintEngineAutomationDesiredMode(autoState)
    const preset = autoState?.cliPermissionPreset ?? 'default'

    const hydrated = await deps.hydrateAutomationMode({ statePath, mode })
    if (hydrated.ok) {
      await deps.setCliPermissionPreset({ statePath, preset })
    } else if (mode !== 'manual') {
      // The sidecar IS what lifts the run out of `manual` in the scheduler, so a
      // failed write means a run the caller asked to start will sit idle. Say so
      // rather than leaving it looking started.
      deps.logDiagnostic?.({
        level: 'warning',
        title: 'Sprint run not started',
        message:
          `The sprint "${workspace.name}" was created, but its automation mode could not be written, so the `
          + 'run is registered idle rather than running. Start it from the board, or set its mode again.',
        details: hydrated.message,
      })
    }

    deps.registerSprintRun({
      statePath,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      folderPath: workspace.folderPath ?? '',
      memoryRelativeRoot: workspace.memory?.relativeRoot ?? null,
      cliPermissionPreset: preset,
      maxConcurrentAgents: autoState?.maxConcurrentAgents ?? SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS,
      deliveredAgentNotificationEventKeys: [],
      // A brand-new run has no lifecycle to carry: `idle` lets the sidecar
      // adoption in `registerRun` lift it to `running` when the mode says so.
      runtimeState: 'idle',
      rosterSessions: {},
      agents: workspace.agents,
      agentConfigs: {},
    })
  }

  // -------------------------------------------------------------------------
  // Source-plan resolution (plan-sourced launches)
  // -------------------------------------------------------------------------

  /**
   * The epic launch shape, for a source that IS an epic: `planKind: epic` plus
   * the epic's open children marked as the work list, built through the same
   * builder the dialog uses so an automation-started epic is byte-identical to a
   * hand-started one. Returns null for anything that is not an epic, and for any
   * failure — a scan that cannot read the project must never fail the launch, it
   * just falls back to today's inferred kind.
   */
  async function buildEpicSourcePlan(
    folderPath: string,
    sourceRelativePath: string,
  ): Promise<{
    sourcePlanKind: SprintEngineSourcePlanKind
    sourceBundle: SprintEngineSourceBundleItem[]
    childLinks: Array<{ relativePath: string; priorStatus?: BacklogItem['status'] }>
  } | null> {
    if (!isBacklogEpicPath(sourceRelativePath)) return null
    try {
      const scanned = await scanBacklog(folderPath, deps.fs)
      if (scanned.state !== 'ready') return null
      const epic = scanned.items.find((item) => item.isEpic && item.relativePath === sourceRelativePath)
      if (!epic) return null
      const plan = buildBacklogSelectionSourcePlan({
        workspaceRoot: folderPath,
        items: [epic],
        projectItems: scanned.items,
      })
      if (!plan || plan.sourcePlanKind !== 'epic') return null
      return {
        sourcePlanKind: plan.sourcePlanKind,
        sourceBundle: plan.sourceBundle ?? [],
        childLinks: bundleChildLinks(plan.sourceBundle ?? [], scanned.items),
      }
    } catch {
      return null
    }
  }

  /**
   * The pending child links a launch writes, from a source bundle: one per OPEN
   * epic child (closed children are skipped at import by the engine's
   * CLOSED_CHILD_STATUSES, so a link would sit `pending` forever). Shared by the
   * single-epic and multi-selection paths so claim-time status propagation works
   * identically from every entry point — a link that was never written is never
   * reconciled (MC-2077 review).
   */
  function bundleChildLinks(
    bundle: SprintEngineSourceBundleItem[],
    scannedItems: ReadonlyArray<BacklogItem>,
  ): Array<{ relativePath: string; priorStatus?: BacklogItem['status'] }> {
    const byPath = new Map(scannedItems.map((item) => [item.relativePath, item]))
    return bundle
      .filter((entry) => entry.epicChild)
      .map((entry) => ({
        relativePath: entry.sourceRelativePath,
        priorStatus: byPath.get(entry.sourceRelativePath)?.status,
      }))
      .filter((child) => child.priorStatus === undefined || !CLOSED_EPIC_CHILD_STATUSES.has(child.priorStatus))
  }

  /**
   * The multi-selection shape (MC-2077): every ref resolved against one backlog
   * scan, then through the SAME selection builder the Backlog door's multi-select
   * uses. Unlike the epic helper above, failure here is loud — silently dropping
   * refs would launch a run missing work the caller asked for.
   */
  async function buildSelectionSourcePlan(
    folderPath: string,
    refs: string[],
  ): Promise<
    | {
      ok: true
      plan: NonNullable<ReturnType<typeof buildBacklogSelectionSourcePlan>>
      childLinks: Array<{ relativePath: string; priorStatus?: BacklogItem['status'] }>
    }
    | { ok: false; code: string; message: string }
  > {
    let scanned: Awaited<ReturnType<typeof scanBacklog>>
    try {
      scanned = await scanBacklog(folderPath, deps.fs)
    } catch (error) {
      return {
        ok: false,
        code: 'sprint_backlog_unavailable',
        message: error instanceof Error ? error.message : 'The project backlog could not be scanned.',
      }
    }
    if (scanned.state !== 'ready') {
      return { ok: false, code: 'sprint_backlog_unavailable', message: 'The project backlog could not be scanned.' }
    }
    const byPath = new Map(scanned.items.map((item) => [item.relativePath, item]))
    const items: BacklogItem[] = []
    for (const ref of refs) {
      const item = byPath.get(ref)
      if (!item) {
        return { ok: false, code: 'sprint_source_missing', message: `Sprint source "${ref}" is not a backlog item in this project.` }
      }
      items.push(item)
    }
    const plan = buildBacklogSelectionSourcePlan({ workspaceRoot: folderPath, items, projectItems: scanned.items })
    if (!plan) {
      return { ok: false, code: 'sprint_invalid_source', message: 'The selection did not resolve to a launchable source plan.' }
    }
    return { ok: true, plan, childLinks: bundleChildLinks(plan.sourceBundle ?? [], scanned.items) }
  }

  // -------------------------------------------------------------------------
  // The two creation paths
  // -------------------------------------------------------------------------

  async function createGoalSourcedSprint(request: SprintCreateRequest): Promise<SprintCreateResult> {
    const resolved = resolveRequestedRoster(request)
    if (!resolved.ok) return resolved.response
    const roster = resolved.roster
    // The no-roles/roster selection decides staffing on THIS path too. Both
    // paths resolve a roster through `resolveRequestedRoster`, so both must
    // honor the selection it returns — otherwise a "No roles" run created
    // goal-sourced would silently staff the specialist defaults and seat an
    // architect, which is the exact thing "no roles" excludes.
    const launchRoleCounts = sprintEngineLaunchRoleCounts(roster.selectedRosterId, roster.roleCounts)
    const runtime = resolveRequestedRuntime(request, roster, launchRoleCounts)
    if (!runtime.ok) return runtime.response

    let created: Awaited<ReturnType<typeof runSprintEngineNewTeamCreation>>
    try {
      created = await runSprintEngineNewTeamCreation(
        {
          folderPath: request.folderPath,
          teamName: request.name?.trim() ?? '',
          goal: request.goal,
          visibleRoleCounts: launchRoleCounts,
          maxParallelAgents: requestedMaxConcurrentAgents(request),
          roleCliDefaults: runtime.roleCliDefaults as Required<typeof runtime.roleCliDefaults>,
          roleModelOverrides: runtime.roleModelOverrides,
          roleReasoningOverrides: runtime.roleReasoningOverrides,
          // Not passed on: the board-mount handshake is not in this loop, and
          // the engine-init payload and the coordinator's prompt are both
          // derived from the staffed counts, not from a spawn intent.
          initialSpawnRoles: null,
          startRunner: request.startRunner === true,
          autoApproveArtifacts: request.autoApproveArtifacts === true,
          useWorktrees: request.useWorktrees === true,
          taskIsolation: request.taskIsolation === true,
          // External creation never escalates CLI permissions. This is the
          // GOAL-sourced path: an arbitrary caller with a bare goal and no
          // human-authored plan file behind it, so there is no consent to read.
          // Deliberately does NOT honor `request.permissionPreset` (MC-1900) —
          // otherwise the field would be exactly the self-escalation hole this
          // literal exists to close. An orchestrator always arrives plan-sourced.
          cliPermissionPreset: 'manual',
        },
        {
          pathExists: deps.fs.pathExists,
          initializeSprintEngineState: deps.initializeSprintEngineState,
        },
      )
    } catch (error) {
      if (error instanceof SprintEngineNewTeamCreationError) {
        return failure(
          `sprint_${error.code.replace(/-/g, '_')}`,
          error.message === error.code ? `Sprint run creation failed: ${error.code}.` : error.message,
        )
      }
      throw error
    }
    if (!created.sprintEngineContext) {
      return failure('sprint_missing_folder', 'Sprint run creation failed: missing-folder.')
    }

    const port = workspacePort()
    try {
      port.addWorkspace({
        sprintEngineState: created.sprintEngineState,
        sprintEngineContext: created.sprintEngineContext,
        folderPath: request.folderPath,
        roleCliDefaults: created.roleCliDefaults,
        roleModelOverrides: created.roleModelOverrides,
        initialSpawnRoles: created.initialSpawnRoles,
        sprintEngineAutoState: created.sprintEngineAutoState,
      })
    } catch (error) {
      return failure('sprint_workspace_registration_failed', messageOf(error, 'The sprint workspace could not be registered.'))
    }
    if (!port.record) {
      return failure('sprint_workspace_registration_failed', 'The sprint workspace was not registered.')
    }
    await startRun(port.record, created.sprintEngineContext.statePath)
    return { ok: true, workspaceId: port.record.id }
  }

  /**
   * Sprint chaining (MC-1438): create + start a sprint from a backlog item (or
   * any project-relative plan file) through the SAME plan-sourced creation path
   * the dialog's "Start from backlog" uses, so the Backlog execution link and
   * item lifecycle are preserved. No bespoke sprint bootstrapping.
   */
  async function createPlanSourcedSprint(
    request: SprintCreateRequest,
    sourceRelativePath: string,
    selectionRefs?: string[],
  ): Promise<SprintCreateResult> {
    const normalizedRefs = (selectionRefs ?? [sourceRelativePath]).map((ref) => ref.replace(/\\/g, '/'))
    for (const ref of normalizedRefs) {
      if (/^(?:\/|[A-Za-z]:)/.test(ref) || ref.split('/').includes('..')) {
        return failure('sprint_invalid_source', 'Sprint source must be a project-relative path.')
      }
    }
    const normalizedSourcePath = normalizedRefs[0]

    const resolved = resolveRequestedRoster(request)
    if (!resolved.ok) return resolved.response
    const roster = resolved.roster
    // The selection decides what actually staffs the run. A "No roles" selection
    // launches the plain-agent seed — no staffed role, so the roleless
    // coordinator seat plus one agent minted per task up to the run's
    // max-concurrency setting — NOT the specialist counts the resolver may still
    // be carrying as the wizard's seeded rows.
    const launchRoleCounts = sprintEngineLaunchRoleCounts(roster.selectedRosterId, roster.roleCounts)
    const runtime = resolveRequestedRuntime(request, roster, launchRoleCounts)
    if (!runtime.ok) return runtime.response

    // The multi-selection resolves every ref through one backlog scan; failure is
    // loud (MC-2077). The single-source path keeps its direct file read.
    let selection: Awaited<ReturnType<typeof buildSelectionSourcePlan>> | null = null
    if (selectionRefs) {
      selection = await buildSelectionSourcePlan(request.folderPath, normalizedRefs)
      if (!selection.ok) return failure(selection.code, selection.message)
    }

    let sourceContent: string
    if (selection?.ok) {
      sourceContent = selection.plan.sourceContent
    } else {
      const absoluteSourcePath = joinPath(request.folderPath, normalizedSourcePath)
      if (!(await deps.fs.pathExists(absoluteSourcePath))) {
        return failure('sprint_source_missing', `Sprint source "${normalizedSourcePath}" does not exist.`)
      }
      try {
        sourceContent = await deps.fs.readFile(absoluteSourcePath)
      } catch (error) {
        return failure(
          'sprint_source_unreadable',
          messageOf(error, `Sprint source "${normalizedSourcePath}" could not be read.`),
        )
      }
    }

    // An epic source launched from here gets the same shape the dialog builds:
    // `planKind: epic` plus its open children marked as the work list (MC-2129).
    // Without it `inferSourcePlanKind` calls an epic `unknown`, so an
    // automation- or orchestrator-started epic never reached the epic intake at all.
    const epicSource = selection?.ok
      ? null
      : await buildEpicSourcePlan(request.folderPath, normalizedSourcePath)
    const epicPlan = selection?.ok
      ? { sourcePlanKind: selection.plan.sourcePlanKind, sourceBundle: selection.plan.sourceBundle ?? [] }
      : epicSource
        ? { sourcePlanKind: epicSource.sourcePlanKind, sourceBundle: epicSource.sourceBundle }
        : null
    // Pending child links are written for EVERY launch path that carries epic
    // children — single-epic (automation chaining, MCP sourceRef) and
    // multi-selection alike. Without the link, claim → in_progress and land →
    // completed never fire: propagation only reconciles links that already exist
    // on the item (integration review, 2026-08-05).
    const pendingChildLinks = selection?.ok ? selection.childLinks : epicSource?.childLinks ?? []

    // The derived name is deterministic (config sprint name, else the item's
    // basename), and a team dir with that slug may already exist — a prior dialog
    // launch from the same item, or an earlier fire of a recurring chain. A
    // collision must not hard-fail the chain (the trigger event is dedupe-marked,
    // so a failed fire never retries): the resolver refuses a self-trigger loop up
    // front, then numbers the team the way a user would until the slug is free.
    const baseTeamName = request.name?.trim() || toTitleName(planBasename(normalizedSourcePath))
    const startRunner = request.startRunner === true
    const automationMode = sprintEngineAutomationModeForRunOptions({
      startRunner,
      autoApproveArtifacts: request.autoApproveArtifacts === true,
    })
    const port = workspacePort()
    const launch = await launchPlanSourcedSprint({
      rootPath: request.folderPath,
      baseTeamName,
      refuseTeamSlug: request.refuseTeamSlug,
      stateExists: deps.fs.pathExists,
      buildArgs: (teamName) => ({
        rootPath: request.folderPath,
        teamName,
        // A selection with no caller goal takes the builder's ("Deliver N
        // selected backlog items") — a single source still derives from its
        // heading downstream, exactly as before.
        goal: request.goal.trim() ? request.goal : selection?.ok ? selection.plan.goal ?? '' : request.goal,
        sourcePath: normalizedSourcePath,
        sourceContent,
        sourcePlanKind: epicPlan?.sourcePlanKind ?? inferSourcePlanKind(normalizedSourcePath, sourceContent),
        ...(epicPlan?.sourceBundle ? { sourceBundle: epicPlan.sourceBundle } : {}),
        // Absent leaves the default with the engine: direct for an epic, planned
        // for everything else. Externally-created runs inherit that rather than
        // restating it here.
        ...(request.intake ? { intake: request.intake } : {}),
        roleCounts: launchRoleCounts,
        roleCliDefaults: runtime.roleCliDefaults,
        roleModelOverrides: runtime.roleModelOverrides,
        roleReasoningOverrides: runtime.roleReasoningOverrides,
        // See the goal-sourced twin: the scheduler bootstraps the coordinator,
        // so no run created here carries a board-mount spawn intent.
        initialSpawnRoles: null,
        sprintEngineAutoState: {
          ...sprintEngineAutomationInitialStateForMode(automationMode),
          // Plan-sourced launches are orchestrated: nobody is
          // watching to answer per-tool prompts, so agents spawn in bypass unless
          // the plan file's own `permissions:` policy says otherwise (MC-1900). The
          // escalation is the OWNER'S file, not this caller — which is why the
          // goal-sourced twin refuses to read this field.
          //
          // Spawn-time only (MC-1808): this is the run's one chance to be bypass.
          cliPermissionPreset: request.permissionPreset ?? 'bypass',
          maxConcurrentAgents: requestedMaxConcurrentAgents(request),
        },
        useWorktrees: request.useWorktrees === true,
        taskIsolation: request.taskIsolation === true,
        ...(request.baseStartPoint?.trim() ? { baseStartPoint: request.baseStartPoint.trim() } : {}),
        // Backlog/file sources are referenced in place, never copied.
        sourceReference: true,
        pathExists: deps.fs.pathExists,
        initializeSprintEngineState: deps.initializeSprintEngineState,
        workspace: port,
      }),
    })
    if (!launch.ok) return failure(launch.code, launch.message)
    const { result } = launch

    // Record the Backlog execution link so the item shows the running sprint and
    // its lifecycle flips to in_progress — the same link the dialog's backlog
    // launch writes. Best-effort: the run exists on disk either way.
    if (normalizedSourcePath.startsWith('backlog/')) {
      const runRelativePath = workspaceRelativePath(request.folderPath, result.sprintEngineContext.statePath)
        ?? result.sprintEngineContext.statePath
      try {
        await deps.addBacklogLink({
          workspaceRoot: request.folderPath,
          relativePath: normalizedSourcePath,
          link: buildSprintEngineRunLink({
            teamSlug: result.sprintEngineContext.teamSlug,
            runRelativePath,
          }),
          // An epic derives its status from its children and never carries one of
          // its own — same rule the dialog applies (MC-2077 made epics reachable
          // here as selection anchors).
          ...(isBacklogEpicPath(normalizedSourcePath) ? {} : { status: 'in_progress' as const }),
        })
        // Every epic child in the bundle gets the pending child link the dialog
        // writes, so claim-time status propagation has a link to flip.
        for (const child of pendingChildLinks) {
          await deps.addBacklogLink({
            workspaceRoot: request.folderPath,
            relativePath: child.relativePath,
            link: buildSprintEngineRunLink({
              teamSlug: result.sprintEngineContext.teamSlug,
              runRelativePath,
              status: 'pending',
              ...(child.priorStatus ? { priorStatus: child.priorStatus } : {}),
            }),
          })
        }
      } catch {
        // Link write is bookkeeping; never fail the launch for it.
      }
    }

    if (port.record) await startRun(port.record, result.sprintEngineContext.statePath)
    return { ok: true, workspaceId: result.workspaceId }
  }

  return {
    /**
     * Create (and, with `startRunner`, start) a Sprint Engine run. A
     * source-carrying request creates through the plan-sourced path; a
     * multi-source request rides the same function with the full ref list, and a
     * singleton list is the singular contract, byte-identical.
     */
    async createSprint(request: SprintCreateRequest): Promise<SprintCreateResult> {
      const selectionRefs = (request.sourceRelativePaths ?? []).map((ref) => ref.trim()).filter(Boolean)
      if (selectionRefs.length > 1) {
        return createPlanSourcedSprint(request, selectionRefs[0], selectionRefs)
      }
      const singleRef = selectionRefs[0] ?? request.sourceRelativePath?.trim()
      if (singleRef) return createPlanSourcedSprint(request, singleRef)
      return createGoalSourcedSprint(request)
    },
  }
}

function failure(code: string, message: string): SprintCreateResult {
  return { ok: false, code, message }
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
