import { isAbsolute } from 'path'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type {
  SprintEngineArtifactCommandResult,
  SprintEngineAutomationReadResult,
  SprintEngineAutomationWriteResult,
  SprintEngineMutationRefreshData,
  SprintEngineProjectionReadResult,
  SprintEngineTaskCommentInput,
  SprintEngineTaskCreateInput,
  SprintEngineTaskMutationRole,
  SprintEngineTaskResolveInput,
  SprintEngineTaskStatusSetInput,
  SprintEngineTaskUpdateInput,
  TerminalSessionSnapshot,
} from '../../shared/electron-api'
import type { SprintEngineAutomationMode } from '../../shared/sprintengine/automation-types'
import type { SprintEngineTaskStatus, SprintEngineVcs } from '../../shared/sprintengine/run-types'
import type { SprintEngineTokenUsageReport } from '../../shared/sprintengine-token-usage'
import type { SetSprintEngineAutomationModeInput } from '../sprintengine-automation-service'
import type {
  SprintEngineArtifactReviewAction,
  SprintEngineArtifactReviewPayload,
  SprintEngineVcsPayload,
} from '../ipc/sprintengine-ipc'
import type { SprintCreateRequest, SprintCreateResult } from '../../shared/sprint-create'
import type { Workspace } from '../../renderer/src/types/workspace'
import type {
  BacklogListItemsResult,
  BacklogReadItemResult,
} from '../backlog-service'
import type { McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import { resolveWorkspaceSidecar } from '../workspace-sidecar'

const LAUNCH_CONFIRM_TIMEOUT_MS = 20_000
const CONFIRM_POLL_INTERVAL_MS = 150

export type SprintGatewayBackends = {
  getWorkspaceSyncSnapshot(): WorkspaceSyncSnapshot
  listTerminalSessions(): TerminalSessionSnapshot[]
  createSprint(request: SprintCreateRequest): Promise<SprintCreateResult>
  listBacklogItems(workspaceRoot: string): Promise<BacklogListItemsResult>
  readBacklogItem(workspaceRoot: string, relativePath: string): Promise<BacklogReadItemResult>
  listSprintRunStatePaths(workspaceRoot: string): Promise<string[]>
  readSprintEngineProjection(statePath: string): Promise<SprintEngineProjectionReadResult>
  readSprintAutomationMode(input: { statePath: string }): Promise<SprintEngineAutomationReadResult>
  setSprintAutomationMode(input: SetSprintEngineAutomationModeInput): Promise<SprintEngineAutomationWriteResult>
  resumeSprintRun(statePath: string): void
  cancelSprintRun(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>
  reviewSprintArtifact(
    payload: SprintEngineArtifactReviewPayload,
    action: SprintEngineArtifactReviewAction
  ): Promise<SprintEngineArtifactCommandResult>
  commentSprintTask(payload: SprintEngineTaskCommentInput): Promise<SprintEngineArtifactCommandResult>
  resolveSprintTaskInput(payload: SprintEngineTaskResolveInput): Promise<SprintEngineArtifactCommandResult>
  setSprintTaskStatus(payload: SprintEngineTaskStatusSetInput): Promise<SprintEngineArtifactCommandResult>
  createSprintTask(payload: SprintEngineTaskCreateInput): Promise<SprintEngineArtifactCommandResult>
  updateSprintTask(payload: SprintEngineTaskUpdateInput): Promise<SprintEngineArtifactCommandResult>
  createSprintPullRequest(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>
  refreshSprintPullRequestStatus(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>
  readSprintTokenUsage(statePath: string): Promise<SprintEngineTokenUsageReport>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export function createSprintGatewayTools(backends: SprintGatewayBackends): McpToolRegistration[] {
  const now = backends.now ?? Date.now
  const sleep = backends.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  async function waitFor<T>(timeoutMs: number, probe: () => T | null): Promise<T | null> {
    const deadline = now() + timeoutMs
    for (;;) {
      const found = probe()
      if (found !== null) return found
      if (now() >= deadline) return null
      await sleep(CONFIRM_POLL_INTERVAL_MS)
    }
  }

  function findWorkspace(workspaceId: string): Workspace | null {
    return backends.getWorkspaceSyncSnapshot().state.workspaces.find((candidate) => candidate.id === workspaceId) ?? null
  }

  function resolveWorkspaceRoot(workspaceId: string): { root: string } | McpToolResult {
    const workspace = findWorkspace(workspaceId)
    if (!workspace) return failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
    if (!workspace.folderPath) {
      return failure(
        'workspace_without_folder',
        `Workspace "${workspaceId}" has no usable folder path in this app session; open it in the app first.`
      )
    }
    return { root: workspace.folderPath }
  }

  const SPRINT_SLUG_RE = /^[A-Za-z0-9._-]+$/

  // The three real automation modes; `paused` is not one of them — pause is
  // `manual`, matching the board (epic decision, no `paused` pseudo-mode).
  const SPRINT_AUTOMATION_MODES: readonly SprintEngineAutomationMode[] = [
    'manual',
    'run_agents',
    'run_agents_and_approve_artifacts',
  ]

  // The task-status vocabulary sprint.task.set_status validates against, mirrored
  // from SprintEngineTaskStatus (run-types.ts) — the `readonly [...]` typing fails
  // the build if any listed value leaves the union. The engine still rejects
  // illegal transitions; this only fails fast on a value that is not a status.
  const SPRINT_TASK_STATUSES: readonly SprintEngineTaskStatus[] = [
    'todo',
    'in_progress',
    'review',
    'needs_input',
    'done',
    'canceled',
  ]

  // The 9 roles sprint.task.create/update may assign, mirrored from
  // SprintEngineTaskMutationRole (electron-api.ts). Same build-time guard as the
  // statuses above: a value outside the union fails to compile here.
  const SPRINT_TASK_MUTATION_ROLES: readonly SprintEngineTaskMutationRole[] = [
    'architect',
    'product',
    'developer',
    'frontend',
    'tester',
    'security',
    'performance',
    'production_readiness_reviewer',
    'cross_platform',
  ]

  function sprintStatePath(root: string, slug: string): string {
    return [root, resolveWorkspaceSidecar(root).dirName, 'sprintengine', slug, 'run.yaml'].join('/')
  }

  // Every sprint tool is keyed workspaceId + slug and NEVER accepts a caller
  // statePath: resolve the workspace root through the sync snapshot, validate
  // the slug against SPRINT_SLUG_RE, and reconstruct the statePath ourselves.
  function resolveSprintStatePath(args: Record<string, unknown>): { statePath: string; slug: string } | McpToolResult {
    const workspaceId = requireString(args, 'workspaceId')
    if (typeof workspaceId !== 'string') return workspaceId
    const slug = requireString(args, 'slug')
    if (typeof slug !== 'string') return slug
    if (!SPRINT_SLUG_RE.test(slug) || slug === '.' || slug === '..') {
      return failure('invalid_arguments', '"slug" must be a plain run slug from sprint.list.')
    }
    const resolved = resolveWorkspaceRoot(workspaceId)
    if (!('root' in resolved)) return resolved
    return { statePath: sprintStatePath(resolved.root, slug), slug }
  }

  // The mutation tools gate on the run actually existing on disk before writing:
  // a projection read that fails is an unknown run, not a mode/cancel failure.
  async function ensureSprintRunExists(statePath: string): Promise<McpToolResult | null> {
    const projection = await backends.readSprintEngineProjection(statePath)
    if (!projection.ok) return failure('sprint_not_found', projection.message)
    return null
  }

  const sprintList: McpToolRegistration = {
    name: 'sprint.list',
    description:
      "List a workspace's Sprint Engine runs from their on-disk state (newest first). Read-only; each entry's "
      + 'slug feeds sprint.status.',
    inputSchema: {
      type: 'object',
      properties: { workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' } },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const resolved = resolveWorkspaceRoot(workspaceId)
      if (!('root' in resolved)) return resolved
      const statePaths = await backends.listSprintRunStatePaths(resolved.root)
      return success({
        runs: statePaths.map((statePath) => {
          const segments = statePath.split(/[\\/]/)
          // Disclose the state file as a project-relative path, matching the
          // backlog tools; the absolute form is machine-specific noise.
          const relative = statePath.startsWith(resolved.root)
            ? statePath.slice(resolved.root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
            : statePath
          return { slug: segments[segments.length - 2] ?? '', statePath: relative }
        }),
      })
    },
  }

  const sprintStatus: McpToolRegistration = {
    name: 'sprint.status',
    description:
      "One Sprint Engine run's current projection (goal, tasks, artifacts, roster, completion) read from disk, "
      + 'plus its main-owned automation mode (manual/run_agents/run_agents_and_approve_artifacts). automationMode '
      + 'is null only when the mode has never been set for this run (the board treats that as manual). Steer the '
      + 'mode with sprint.set_mode.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
      },
      required: ['workspaceId', 'slug'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const projection = await backends.readSprintEngineProjection(resolvedRun.statePath)
      if (!projection.ok) return failure('sprint_status_failed', projection.message)
      // Automation mode is supplementary: a read failure discloses null rather
      // than failing the whole status read (the projection is the primary
      // payload). No sidecar record → manual, matching the board.
      const mode = await backends.readSprintAutomationMode({ statePath: resolvedRun.statePath })
      const automationMode: SprintEngineAutomationMode | null = mode.ok ? mode.record?.desiredMode ?? 'manual' : null
      return success({
        slug: resolvedRun.slug,
        projection: projection.data,
        changeToken: projection.token ?? null,
        automationMode,
      })
    },
  }

  const sprintSetMode: McpToolRegistration = {
    name: 'sprint.set_mode',
    description:
      "Set a Sprint Engine run's automation mode through the main-owned intent service. \"manual\" pauses the "
      + 'auto-runner (there is no separate paused state — pause is manual); "run_agents" runs agents; '
      + '"run_agents_and_approve_artifacts" also auto-approves review artifacts. Idempotent: setting the mode '
      + 'the run already has returns changed:false. Verify the live effect with sprint.status.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
        mode: {
          type: 'string',
          enum: [...SPRINT_AUTOMATION_MODES],
          description: 'Target automation mode.',
        },
      },
      required: ['workspaceId', 'slug', 'mode'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const mode = requireString(args, 'mode')
      if (typeof mode !== 'string') return mode
      if (!SPRINT_AUTOMATION_MODES.includes(mode as SprintEngineAutomationMode)) {
        return failure('invalid_arguments', `"mode" must be one of: ${SPRINT_AUTOMATION_MODES.join(', ')}.`)
      }
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const written = await backends.setSprintAutomationMode({
        statePath: resolvedRun.statePath,
        mode: mode as SprintEngineAutomationMode,
        actor: 'automation',
        reason: 'automation-server',
      })
      if (!written.ok) return failure('sprint_mode_failed', written.message)
      return success({ mode: written.record.desiredMode, changed: written.changed })
    },
  }

  const sprintResume: McpToolRegistration = {
    name: 'sprint.resume',
    description:
      "Re-arm a stopped Sprint Engine run's scheduler for its current mode (the board's Resume). Fire-and-forget: "
      + 'this requests a resume and gives no confirmation of the run reaching a running state — verify with '
      + 'sprint.status. Has no effect on a run the scheduler is not holding.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
      },
      required: ['workspaceId', 'slug'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      backends.resumeSprintRun(resolvedRun.statePath)
      return success({ resumed: { slug: resolvedRun.slug, requested: true } })
    },
  }

  const sprintCancel: McpToolRegistration = {
    name: 'sprint.cancel',
    description:
      'Cancel a Sprint Engine run: writes run/task status through the engine cancel op, then tears down the '
      + "scheduler so a paused or manual run's live agents are also stopped. Terminal — a canceled run cannot be "
      + 'resumed.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
      },
      required: ['workspaceId', 'slug'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const canceled = await backends.cancelSprintRun({ statePath: resolvedRun.statePath })
      if (!canceled.ok) {
        const detail = [canceled.stdout, canceled.stderr].filter((part) => Boolean(part && part.trim())).join('\n')
        return failure('sprint_cancel_failed', detail ? `${canceled.message}\n${detail}` : canceled.message)
      }
      return success({ canceled: { slug: resolvedRun.slug } })
    },
  }

  const sprintCreate: McpToolRegistration = {
    name: 'sprint.create',
    description:
      'Create a Sprint Engine run in a new workspace, through the same creation path the app wizard uses. '
      + 'Roster precedence: an explicit `roster` map, else a named saved '
      + 'roster (`rosterName`), else the last saved roster, else the built-in roster. Pass `sourceRef` to plan the run FROM a '
      + 'backlog item or epic (or any project-relative plan file or HTML mockup) — the architect then plans '
      + 'against the item and its children, and for a backlog source the execution link is written; '
      + '`goal` may be empty because it derives from the item heading. '
      + 'CLI PERMISSIONS are not selectable here and differ by path: a goal-only run is pinned to "manual" '
      + '(an external caller with no human-authored source never self-escalates), while a source-launched run '
      + 'spawns its agents in bypass — the unwatched plan-sourced contract automations already '
      + 'run under. A person can create the run in the app if that is not what you want. '
      + 'With startRunner the run is handed to the scheduler, which launches the architect, and success is '
      + 'confirmed by its live terminal session; without it the run is created in manual mode and sits idle '
      + 'until a person opens it. '
      + 'Execution runtime: `runtime` pins the CLI/model/effort for a roleless run (no `roster` — the default '
      + 'kind) and backs any unnamed role, `roleClis`/`roleModels`/`roleEfforts` pin individual roles, and '
      + '`maxConcurrentAgents` sets how many agents work at once. Needs no open app window.',
    inputSchema: {
      type: 'object',
      properties: {
        folderPath: { type: 'string', description: 'Absolute project folder for the run workspace.' },
        goal: { type: 'string', description: 'The sprint goal the architect plans against. May be empty when sourceRef is given.' },
        name: { type: 'string', description: 'Run display name (seeds the run directory slug).' },
        sourceRef: {
          type: 'string',
          description:
            'Project-relative backlog item or epic to plan the run from, e.g. "backlog/epics/foo.md". '
            + 'Uses the shared plan-sourced creation path (epic children included), not the goal-only path. '
            + 'Any project-relative plan file or HTML mockup also works — the dialog\'s "choose a source file" — '
            + 'but only a backlog/ source gets the Backlog execution link and item lifecycle.',
        },
        sourceRefs: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description:
            'Several project-relative backlog items and/or epics to start ONE sprint from, e.g. '
            + '["backlog/epics/foo.md", "backlog/bar.md"] — the same mixed-selection launch the Backlog '
            + 'door\'s multi-select uses (MC-2060/2061). The first entry is the anchor document; epics '
            + 'bring their open children; the run records planKind "selection". Mutually exclusive with '
            + '`sourceRef`; a single entry behaves exactly like `sourceRef`.',
        },
        rosterName: { type: 'string', description: 'Saved roster name. Unknown names fail loudly rather than falling back.' },
        roster: {
          type: 'object',
          description:
            'Explicit roster as role id -> staffed flag, e.g. {"architect":1,"developer":1,"spec_reviewer":1}. '
            + 'Wins over `rosterName`. A role is ON (any count > 0) or OFF; the engine normalizes every count to 0 or 1, '
            + 'so this picks WHICH roles run, not how many agents — run parallelism is maxConcurrentAgents. '
            + 'A role omitted here is OFF, never defaulted on. Role ids are registry-driven, so roles outside the '
            + 'wizard default map (spec_reviewer, nuclear_reviewer) are accepted and get a CLI default seeded.',
          additionalProperties: { type: 'integer', minimum: 0 },
        },
        startRunner: { type: 'boolean', description: 'Start the auto-runner (launches the architect). Default false.' },
        autoApproveArtifacts: { type: 'boolean', description: 'Auto-approve run artifacts (only with startRunner).' },
        useWorktrees: {
          type: 'boolean',
          description:
            'Run the sprint in ONE shared git worktree (a per-run isolated checkout on its own branch), '
            + 'keeping agents out of the main working tree. Kept for compatibility and equivalent to '
            + '`isolation`: true = "sprint", false = "none". Prefer `isolation`, which says the same thing '
            + 'and can also ask for a worktree per task. NOTE: omitting BOTH fields now means one worktree '
            + 'per sprint, not the main working tree — pass false (or `isolation: "none"`) for that.',
        },
        isolation: {
          type: 'string',
          enum: ['none', 'sprint', 'task'],
          description:
            'Where this sprint works. "none" = the project folder itself (agents edit the working tree you '
            + 'have open). "sprint" = ONE shared worktree for the whole run, on its own branch. "task" = a '
            + 'worktree PER TASK, branched off the run branch and merged back at publish, so two tasks '
            + 'changing the same file meet as a merge conflict instead of overwriting each other; each '
            + 'agent\'s terminal opens in its own task\'s tree. Omit BOTH this and `useWorktrees` and the '
            + 'run takes the default: "sprint", one worktree for the whole run. An explicit `useWorktrees` '
            + 'still decides on its own ("sprint" when true, "none" when false). Fixed at run creation.',
        },
        runtime: {
          type: 'object',
          description:
            'The run-level execution runtime — the same picker the New Sprint dialog shows above the roster '
            + '(MC-2120). It is the CLI, model, and reasoning effort the ROLELESS seat launches on, and the '
            + 'fallback for any staffed role the per-role maps below do not name — including one whose saved '
            + 'roster stored a pick, since an explicit field here is the more specific intent. A roleless run (no `roster`, '
            + 'the default sprint kind) has no role ids, so this is the ONLY way to pin its model. Omitted '
            + 'members keep the CLI\'s own defaults: no model flag, no effort flag. Use cli.runtime.list to see '
            + 'which CLIs, models, and effort levels are launchable.',
          properties: {
            cli: { type: 'string', description: 'Agent CLI plugin id, e.g. "claude-code" (cli.runtime.list enumerates them).' },
            model: { type: 'string', description: 'Model id for that CLI; omitted means the CLI\'s own default.' },
            effort: { type: 'string', description: 'Reasoning-effort level the CLI declares, e.g. "high".' },
          },
          additionalProperties: false,
        },
        roleClis: {
          type: 'object',
          description:
            'Per-role agent CLI, role id -> CLI plugin id, e.g. {"architect":"claude-code","developer":"codex"} '
            + '— the roster editor\'s per-role CLI column. null means that role takes the run-level `runtime.cli`, '
            + 'else its stock default. Same unknown-role rule as `roleModels`.',
          additionalProperties: { type: ['string', 'null'] },
        },
        roleModels: {
          type: 'object',
          description:
            'Per-role launch model, role id -> model id, e.g. {"architect":"claude-opus-5","developer":"claude-sonnet-5"}. '
            + 'null means that role takes its CLI default. A role that the run does not staff fails loudly '
            + '(the `rosterName` precedent) rather than silently doing nothing. Roleless runs have no role ids — '
            + 'use `runtime` instead.',
          additionalProperties: { type: ['string', 'null'] },
        },
        roleEfforts: {
          type: 'object',
          description:
            'Per-role reasoning-effort level, role id -> level id, e.g. {"architect":"high"}. Same rules as '
            + '`roleModels`; each level must be one the role\'s CLI declares (cli.runtime.list reports them).',
          additionalProperties: { type: ['string', 'null'] },
        },
        maxConcurrentAgents: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description:
            'The run\'s ceiling on agents working at once (the dialog\'s "Max concurrent agents"). Default 3. '
            + 'On a roleless run this is also the effective agent count — agents are minted per task up to it — '
            + 'so it, not `roster`, is how a roleless run is made wider or narrower.',
        },
        intake: {
          type: 'string',
          enum: ['direct', 'planned'],
          description:
            'How the run gets its task graph. "direct" imports it from the source epic\'s child items at '
            + 'creation — one task per open child, ordered by the items\' own dependsOn, with no planning agent '
            + 'and no plan-approval gate. "planned" runs a planning agent behind the plan gate. Omit to take the '
            + 'default for the source: direct for an epic, planned for everything else. "direct" only exists for '
            + 'a single-epic source — on any other source shape (a selection, a goal) the engine DOWNGRADES it '
            + 'to planned and records a warning on the run, since there is no authored order to import.',
        },
      },
      required: ['folderPath'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const folderPath = requireString(args, 'folderPath')
      if (typeof folderPath !== 'string') return folderPath
      if (!isAbsolute(folderPath)) {
        return failure('invalid_arguments', '"folderPath" must be an absolute path.')
      }
      const invalid = firstInvalidOptionalString(args, ['name', 'sourceRef', 'rosterName', 'goal'])
      if (invalid) return invalid
      let sourceRef = optionalString(args.sourceRef)
      // MC-2077: the plural form. Validated here so the renderer only ever sees
      // a clean list; a single entry collapses onto the singular contract so
      // downstream behaviour is byte-identical to `sourceRef`.
      let sourceRefs: string[] | undefined
      if (args.sourceRefs !== undefined) {
        if (!Array.isArray(args.sourceRefs) || args.sourceRefs.length === 0) {
          return failure('invalid_arguments', '"sourceRefs" must be a non-empty array of project-relative paths.')
        }
        if (sourceRef) {
          return failure('invalid_arguments', 'Pass either "sourceRef" or "sourceRefs", not both.')
        }
        const cleaned: string[] = []
        for (const entry of args.sourceRefs) {
          if (typeof entry !== 'string' || !entry.trim()) {
            return failure('invalid_arguments', '"sourceRefs" entries must be non-empty strings.')
          }
          if (!cleaned.includes(entry.trim())) cleaned.push(entry.trim())
        }
        if (cleaned.length === 1) sourceRef = cleaned[0]
        else sourceRefs = cleaned
      }
      const goal = optionalString(args.goal) ?? ''
      // `goal` is only derivable from the item heading on the plan-sourced path;
      // a goal-only run has nothing else to plan against.
      if (!sourceRef && !sourceRefs && !goal.trim()) {
        return failure('invalid_arguments', '"goal" is required when neither "sourceRef" nor "sourceRefs" is provided.')
      }
      for (const key of ['startRunner', 'autoApproveArtifacts', 'useWorktrees']) {
        if (args[key] !== undefined && typeof args[key] !== 'boolean') {
          return failure('invalid_arguments', `"${key}" must be a boolean when provided.`)
        }
      }
      // One field, two spellings (MC-2136). `isolation` is the whole ladder;
      // `useWorktrees` is its first two rungs and stays accepted, so a caller
      // written before this creates the byte-identical run it always did.
      // Sending both a `task` isolation and `useWorktrees: false` is a
      // contradiction, refused rather than silently resolved either way.
      if (args.isolation !== undefined && !['none', 'sprint', 'task'].includes(args.isolation as string)) {
        return failure('invalid_arguments', '"isolation" must be "none", "sprint", or "task".')
      }
      // Omitting BOTH is the ruled default (MC-2136): one worktree per sprint,
      // the normal mode. An explicit `useWorktrees` still decides on its own, so
      // a caller that states what it wants keeps the run it always got.
      const isolation: 'none' | 'sprint' | 'task' = (args.isolation as 'none' | 'sprint' | 'task' | undefined)
        ?? (args.useWorktrees === false ? 'none' : 'sprint')
      if (args.isolation !== undefined && args.useWorktrees !== undefined
        && (isolation !== 'none') !== (args.useWorktrees === true)) {
        return failure(
          'invalid_arguments',
          `"isolation": "${args.isolation as string}" contradicts "useWorktrees": ${String(args.useWorktrees)}. Pass one, or agreeing values.`
        )
      }
      let roster: Record<string, number> | undefined
      if (args.roster !== undefined) {
        if (typeof args.roster !== 'object' || args.roster === null || Array.isArray(args.roster)) {
          return failure('invalid_arguments', '"roster" must be an object of role id to count.')
        }
        roster = {}
        for (const [role, count] of Object.entries(args.roster as Record<string, unknown>)) {
          if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
            return failure('invalid_arguments', `"roster.${role}" must be a non-negative integer.`)
          }
          roster[role] = count
        }
        if (Object.keys(roster).length === 0) {
          return failure('invalid_arguments', '"roster" must name at least one role.')
        }
      }
      // The runtime block (MC-2120). Validated here so the renderer only ever
      // sees trimmed strings; WHICH roles may be named is checked in the
      // renderer, where the roster is actually resolved.
      let runtime: { cli?: string; model?: string; effort?: string } | undefined
      if (args.runtime !== undefined) {
        if (typeof args.runtime !== 'object' || args.runtime === null || Array.isArray(args.runtime)) {
          return failure('invalid_arguments', '"runtime" must be an object with optional "cli", "model", and "effort".')
        }
        const raw = args.runtime as Record<string, unknown>
        for (const key of Object.keys(raw)) {
          if (!['cli', 'model', 'effort'].includes(key)) {
            return failure('invalid_arguments', `"runtime.${key}" is not a runtime field; use "cli", "model", or "effort".`)
          }
          if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !(raw[key] as string).trim())) {
            return failure('invalid_arguments', `"runtime.${key}" must be a non-empty string when provided.`)
          }
        }
        const entries = {
          ...(optionalString(raw.cli) ? { cli: (raw.cli as string).trim() } : {}),
          ...(optionalString(raw.model) ? { model: (raw.model as string).trim() } : {}),
          ...(optionalString(raw.effort) ? { effort: (raw.effort as string).trim() } : {}),
        }
        if (Object.keys(entries).length > 0) runtime = entries
      }
      // Role-keyed model/effort maps. `null` is meaningful — it is an explicit
      // "this role takes its CLI default" — so it is kept, not dropped.
      const roleOverrides: Partial<Record<'roleClis' | 'roleModels' | 'roleEfforts', Record<string, string | null>>> = {}
      for (const key of ['roleClis', 'roleModels', 'roleEfforts'] as const) {
        if (args[key] === undefined) continue
        const value = args[key]
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return failure('invalid_arguments', `"${key}" must be an object of role id to value.`)
        }
        const map: Record<string, string | null> = {}
        for (const [role, entry] of Object.entries(value as Record<string, unknown>)) {
          if (!role.trim()) return failure('invalid_arguments', `"${key}" role ids must be non-empty.`)
          if (entry !== null && (typeof entry !== 'string' || !entry.trim())) {
            return failure('invalid_arguments', `"${key}.${role}" must be a non-empty string or null.`)
          }
          map[role.trim()] = entry === null ? null : (entry as string).trim()
        }
        if (Object.keys(map).length > 0) roleOverrides[key] = map
      }
      if (args.maxConcurrentAgents !== undefined) {
        const value = args.maxConcurrentAgents
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10) {
          return failure('invalid_arguments', '"maxConcurrentAgents" must be an integer between 1 and 10.')
        }
      }
      if (args.intake !== undefined && args.intake !== 'direct' && args.intake !== 'planned') {
        return failure('invalid_arguments', '"intake" must be "direct" or "planned" when provided.')
      }
      const intake = args.intake as 'direct' | 'planned' | undefined
      const startRunner = args.startRunner === true
      // The epic ordering gate (MC-2137). It never blocks: an unmarked epic that
      // explicitly asked for `direct` still starts, and the caller is TOLD the
      // items will run unordered. Read at the tool boundary because this is the
      // only place that answer reaches the caller — the run itself resolves the
      // same flag independently, so a read that fails here costs the warning,
      // never the run.
      const warnings = sourceRef ? await epicOrderingWarnings(folderPath, sourceRef, intake) : []

      const created = await backends.createSprint({
        folderPath,
        goal,
        name: optionalString(args.name),
        ...(sourceRef ? { sourceRelativePath: sourceRef } : {}),
        ...(sourceRefs ? { sourceRelativePaths: sourceRefs } : {}),
        ...(optionalString(args.rosterName) ? { rosterName: optionalString(args.rosterName) } : {}),
        ...(roster ? { roster } : {}),
        // The runtime the wizard's pickers write (MC-2120). Each is omitted
        // when unset so a caller written before this creates the same run.
        ...(runtime ? { runtime } : {}),
        ...(roleOverrides.roleClis ? { roleClis: roleOverrides.roleClis } : {}),
        ...(roleOverrides.roleModels ? { roleModels: roleOverrides.roleModels } : {}),
        ...(roleOverrides.roleEfforts ? { roleEfforts: roleOverrides.roleEfforts } : {}),
        ...(args.maxConcurrentAgents !== undefined
          ? { maxConcurrentAgents: args.maxConcurrentAgents as number }
          : {}),
        startRunner,
        autoApproveArtifacts: args.autoApproveArtifacts === true,
        useWorktrees: isolation !== 'none',
        ...(isolation === 'task' ? { taskIsolation: true } : {}),
        // Omitted leaves the default with the engine, which knows the source shape.
        ...(intake ? { intake } : {}),
      })
      if (!created.ok) return failure(created.code, created.message)
      const workspaceId = created.workspaceId

      // No bus-confirmation poll: main committed the record before answering,
      // so the id is readable in this very call (MC-2158/2160). What still needs
      // waiting for is the coordinator's live terminal session on a started run
      // — the scheduler spawns it on its next tick — using the same proof
      // agent.launch uses. A manual run has deliberately launched nothing.
      const workspace = findWorkspace(workspaceId)
      if (!workspace) {
        return failure(
          'creation_confirmation_failed',
          `Sprint workspace "${workspaceId}" was created but is not readable from the workspace registry; treat the creation as unverified and read workspace.status.`
        )
      }
      if (startRunner) {
        const architectLive = await waitFor(LAUNCH_CONFIRM_TIMEOUT_MS, () => {
          const session = backends
            .listTerminalSessions()
            .find(
              (candidate) =>
                candidate.kind === 'agent' && candidate.workspaceId === workspaceId && candidate.processAlive
            )
          return session ?? null
        })
        if (!architectLive) {
          return failure(
            'launch_confirmation_timeout',
            `Sprint run and workspace "${workspaceId}" were created, but no live agent terminal registered within ${LAUNCH_CONFIRM_TIMEOUT_MS}ms — the architect start is unverified. Read sprint.status and workspace.status for the current state.`
          )
        }
      }
      return success({ workspaceId, started: startRunner, ...(warnings.length > 0 ? { warnings } : {}) })
    },
  }

  // The two things a caller must hear about an epic whose ordering was never
  // marked done (MC-2137): that an explicit `direct` is running items with no
  // authored order, or that omitting `intake` did NOT take the epic default.
  // Silence on both would be the old behaviour — a plannerless run over an
  // unordered epic, with nothing said.
  async function epicOrderingWarnings(
    folderPath: string,
    sourceRef: string,
    intake: 'direct' | 'planned' | undefined,
  ): Promise<string[]> {
    if (intake === 'planned') return []
    // Only a ref that will actually LAUNCH as an epic source can be affected:
    // the launch path requires `backlog/epics/…` (isBacklogEpicPath) on top of
    // the item being an epic. A `type: epic` file outside that directory is not
    // an epic intake at all — the run plans whatever the caller asked for, and
    // saying otherwise here would be a confident, wrong warning.
    if (!sourceRef.replace(/\\/g, '/').toLowerCase().startsWith('backlog/epics/')) return []
    const read = await backends.readBacklogItem(folderPath, sourceRef).catch(() => null)
    if (!read?.ok || !read.item.isEpic || read.item.dependenciesPlanned === true) return []
    const mark =
      `Set "dependenciesPlanned: true" on ${sourceRef} once its children's dependsOn order is authored `
      + '(no edges at all is a valid answer — it means deliberately parallel), '
      + 'or with backlog.update {path, dependenciesPlanned: true}.'
    return intake === 'direct'
      ? [
        `Epic ${sourceRef} is not marked dependenciesPlanned, so its ordering was never declared finished. `
        + `The run was started anyway with intake "direct": its items run unordered, all claimable at once. ${mark}`,
      ]
      : [
        `Epic ${sourceRef} is not marked dependenciesPlanned, so this run takes intake "planned" `
        + `(a planning agent orders the work) instead of importing the epic as its task graph. ${mark}`,
      ]
  }

  const sprintArtifactApprove: McpToolRegistration = {
    name: 'sprint.artifact.approve',
    description:
      "Approve a Sprint Engine run's review artifact (plan, spec review, etc.), the human-proxy approval the board "
      + 'offers. Direct-main, keyed workspaceId + slug; review mode is pinned to a human approval, never the '
      + "auto-runner's policy approval. Optional feedback rides the approval. Verify the effect with sprint.status.",
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
        artifactId: { type: 'string', description: 'Artifact id from the run projection (sprint.status).' },
        feedback: { type: 'string', description: 'Optional note recorded with the approval.' },
      },
      required: ['workspaceId', 'slug', 'artifactId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const artifactId = requireString(args, 'artifactId')
      if (typeof artifactId !== 'string') return artifactId
      const invalid = firstInvalidOptionalString(args, ['feedback'])
      if (invalid) return invalid
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const reviewed = await backends.reviewSprintArtifact(
        { statePath: resolvedRun.statePath, artifactId, ...(optionalString(args.feedback) ? { feedback: optionalString(args.feedback) } : {}) },
        'approve'
      )
      if (!reviewed.ok) return sprintCommandResultFailure('sprint_artifact_approve_failed', reviewed)
      return success({ approved: { slug: resolvedRun.slug, artifactId } })
    },
  }

  const sprintArtifactRequestChanges: McpToolRegistration = {
    name: 'sprint.artifact.request_changes',
    description:
      "Request changes on a Sprint Engine run's review artifact, returning it to its author with required feedback. "
      + 'Direct-main, keyed workspaceId + slug. Feedback is required and non-empty at the tool boundary (the engine '
      + 'also enforces it). Verify the effect with sprint.status.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
        artifactId: { type: 'string', description: 'Artifact id from the run projection (sprint.status).' },
        feedback: { type: 'string', description: 'Required note describing the changes to make.' },
      },
      required: ['workspaceId', 'slug', 'artifactId', 'feedback'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const artifactId = requireString(args, 'artifactId')
      if (typeof artifactId !== 'string') return artifactId
      const feedback = requireString(args, 'feedback')
      if (typeof feedback !== 'string') return feedback
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const reviewed = await backends.reviewSprintArtifact(
        { statePath: resolvedRun.statePath, artifactId, feedback },
        'request-changes'
      )
      if (!reviewed.ok) return sprintCommandResultFailure('sprint_artifact_request_changes_failed', reviewed)
      return success({ requestedChanges: { slug: resolvedRun.slug, artifactId } })
    },
  }

  const sprintTaskComment: McpToolRegistration = {
    name: 'sprint.task.comment',
    description:
      "Add a comment to a Sprint Engine task — the same board comment an operator leaves. Direct-main, keyed "
      + 'workspaceId + slug; the comment is visible to the task owner.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
        taskId: { type: 'string', description: 'Task id from the run projection (sprint.status).' },
        body: { type: 'string', description: 'Comment body.' },
      },
      required: ['workspaceId', 'slug', 'taskId', 'body'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const taskId = requireString(args, 'taskId')
      if (typeof taskId !== 'string') return taskId
      const body = requireString(args, 'body')
      if (typeof body !== 'string') return body
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const commented = await backends.commentSprintTask({ statePath: resolvedRun.statePath, taskId, body })
      if (!commented.ok) return sprintCommandResultFailure('sprint_task_comment_failed', commented)
      return success({ commented: { slug: resolvedRun.slug, taskId } })
    },
  }

  const sprintTaskResolveInput: McpToolRegistration = {
    name: 'sprint.task.resolve_input',
    description:
      "Answer a Sprint Engine task's needs_input question so its owner can resume. Direct-main, keyed workspaceId + "
      + 'slug. `resolution` is the answer; optional `complete` closes the task instead of returning it to work. '
      + 'Pairs with the run-needs-input trigger, whose payload carries the taskId + question.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
        taskId: { type: 'string', description: 'Task id from the run projection (sprint.status).' },
        resolution: { type: 'string', description: 'The answer to the task\'s needs_input question.' },
        complete: { type: 'boolean', description: 'Close the task on resolution instead of returning it to work.' },
      },
      required: ['workspaceId', 'slug', 'taskId', 'resolution'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const taskId = requireString(args, 'taskId')
      if (typeof taskId !== 'string') return taskId
      const resolution = requireString(args, 'resolution')
      if (typeof resolution !== 'string') return resolution
      if (args.complete !== undefined && typeof args.complete !== 'boolean') {
        return failure('invalid_arguments', '"complete" must be a boolean when provided.')
      }
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const resolved = await backends.resolveSprintTaskInput({
        statePath: resolvedRun.statePath,
        taskId,
        resolution,
        ...(args.complete === true ? { complete: true } : {}),
      })
      if (!resolved.ok) return sprintCommandResultFailure('sprint_task_resolve_input_failed', resolved)
      return success({ resolved: { slug: resolvedRun.slug, taskId, complete: args.complete === true } })
    },
  }

  const sprintTaskSetStatus: McpToolRegistration = {
    name: 'sprint.task.set_status',
    description:
      "Set a Sprint Engine task's status (todo, in_progress, review, needs_input, done, canceled). Direct-main, "
      + 'keyed workspaceId + slug. The engine rejects illegal transitions; the common use is reopening a reviewed '
      + 'or done task with "in_progress" for rework under its original owner.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
        taskId: { type: 'string', description: 'Task id from the run projection (sprint.status).' },
        status: { type: 'string', enum: [...SPRINT_TASK_STATUSES], description: 'Target task status.' },
      },
      required: ['workspaceId', 'slug', 'taskId', 'status'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const taskId = requireString(args, 'taskId')
      if (typeof taskId !== 'string') return taskId
      const status = requireString(args, 'status')
      if (typeof status !== 'string') return status
      if (!SPRINT_TASK_STATUSES.includes(status as SprintEngineTaskStatus)) {
        return failure('invalid_arguments', `"status" must be one of: ${SPRINT_TASK_STATUSES.join(', ')}.`)
      }
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const set = await backends.setSprintTaskStatus({ statePath: resolvedRun.statePath, taskId, status })
      if (!set.ok) return sprintCommandResultFailure('sprint_task_set_status_failed', set)
      return success({ statusSet: { slug: resolvedRun.slug, taskId, status } })
    },
  }

  const sprintTaskCreate: McpToolRegistration = {
    name: 'sprint.task.create',
    description:
      'Add a task to a Sprint Engine run mid-flight. Direct-main, keyed workspaceId + slug. `role` must be an '
      + 'assignable Sprint Engine role. acceptanceCriteria / implementationNotes / notes are arrays of non-empty '
      + 'strings (a bare string is rejected). Verify the added task with sprint.status.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
        title: { type: 'string', description: 'Task title.' },
        role: { type: 'string', enum: [...SPRINT_TASK_MUTATION_ROLES], description: 'Assigned role.' },
        description: { type: 'string', description: 'Task description / body.' },
        acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria bullets.' },
        implementationNotes: { type: 'array', items: { type: 'string' }, description: 'Implementation hints.' },
        notes: { type: 'array', items: { type: 'string' }, description: 'Freeform notes.' },
      },
      required: ['workspaceId', 'slug', 'title', 'role'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const title = requireString(args, 'title')
      if (typeof title !== 'string') return title
      const role = requireString(args, 'role')
      if (typeof role !== 'string') return role
      if (!SPRINT_TASK_MUTATION_ROLES.includes(role as SprintEngineTaskMutationRole)) {
        return failure('invalid_arguments', `"role" must be one of: ${SPRINT_TASK_MUTATION_ROLES.join(', ')}.`)
      }
      const invalid = firstInvalidOptionalString(args, ['description'])
      if (invalid) return invalid
      const badArray = firstInvalidStringArray(args, ['acceptanceCriteria', 'implementationNotes', 'notes'])
      if (badArray) return badArray
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const created = await backends.createSprintTask({
        statePath: resolvedRun.statePath,
        title,
        role: role as SprintEngineTaskMutationRole,
        ...(optionalString(args.description) ? { description: optionalString(args.description) } : {}),
        ...(optionalStringArray(args.acceptanceCriteria) ? { acceptanceCriteria: optionalStringArray(args.acceptanceCriteria) } : {}),
        ...(optionalStringArray(args.implementationNotes) ? { implementationNotes: optionalStringArray(args.implementationNotes) } : {}),
        ...(optionalStringArray(args.notes) ? { notes: optionalStringArray(args.notes) } : {}),
      })
      if (!created.ok) return sprintCommandResultFailure('sprint_task_create_failed', created)
      return success({ created: { slug: resolvedRun.slug, title, role } })
    },
  }

  const sprintTaskUpdate: McpToolRegistration = {
    name: 'sprint.task.update',
    description:
      "Update an existing Sprint Engine task's fields (title, description, role, acceptanceCriteria, "
      + 'implementationNotes, notes). Direct-main, keyed workspaceId + slug. Only supplied fields change; array '
      + 'fields are arrays of non-empty strings (a bare string is rejected). Verify with sprint.status.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
        taskId: { type: 'string', description: 'Task id from the run projection (sprint.status).' },
        title: { type: 'string', description: 'New task title.' },
        role: { type: 'string', enum: [...SPRINT_TASK_MUTATION_ROLES], description: 'Reassigned role.' },
        description: { type: 'string', description: 'New task description / body.' },
        acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria bullets.' },
        implementationNotes: { type: 'array', items: { type: 'string' }, description: 'Implementation hints.' },
        notes: { type: 'array', items: { type: 'string' }, description: 'Freeform notes.' },
      },
      required: ['workspaceId', 'slug', 'taskId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const taskId = requireString(args, 'taskId')
      if (typeof taskId !== 'string') return taskId
      const invalid = firstInvalidOptionalString(args, ['title', 'description'])
      if (invalid) return invalid
      if (args.role !== undefined && !SPRINT_TASK_MUTATION_ROLES.includes(args.role as SprintEngineTaskMutationRole)) {
        return failure('invalid_arguments', `"role" must be one of: ${SPRINT_TASK_MUTATION_ROLES.join(', ')}.`)
      }
      const badArray = firstInvalidStringArray(args, ['acceptanceCriteria', 'implementationNotes', 'notes'])
      if (badArray) return badArray
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const updated = await backends.updateSprintTask({
        statePath: resolvedRun.statePath,
        taskId,
        ...(optionalString(args.title) ? { title: optionalString(args.title) } : {}),
        ...(args.role !== undefined ? { role: args.role as SprintEngineTaskMutationRole } : {}),
        ...(optionalString(args.description) ? { description: optionalString(args.description) } : {}),
        ...(optionalStringArray(args.acceptanceCriteria) ? { acceptanceCriteria: optionalStringArray(args.acceptanceCriteria) } : {}),
        ...(optionalStringArray(args.implementationNotes) ? { implementationNotes: optionalStringArray(args.implementationNotes) } : {}),
        ...(optionalStringArray(args.notes) ? { notes: optionalStringArray(args.notes) } : {}),
      })
      if (!updated.ok) return sprintCommandResultFailure('sprint_task_update_failed', updated)
      return success({ updated: { slug: resolvedRun.slug, taskId } })
    },
  }

  const sprintPrCreate: McpToolRegistration = {
    name: 'sprint.pr.create',
    description:
      "Open a Sprint Engine run's pull request through the engine's own VCS command. Direct-main, keyed workspaceId "
      + '+ slug; idempotent per the underlying command (re-opening an existing PR is safe). On success the run\'s '
      + 'refreshed vcs block (pull-request URL, branch, merge state) rides the payload so no second sprint.status is '
      + 'needed. A non-worktree run surfaces the engine\'s own refusal — the tool does not pre-empt it.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
      },
      required: ['workspaceId', 'slug'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const created = await backends.createSprintPullRequest({ statePath: resolvedRun.statePath })
      if (!created.ok) return sprintCommandResultFailure('sprint_pr_failed', created)
      return success({ slug: resolvedRun.slug, vcs: sprintVcsFromCommandResult(created.data) })
    },
  }

  const sprintPrStatus: McpToolRegistration = {
    name: 'sprint.pr.status',
    description:
      "Refresh and read a Sprint Engine run's pull-request merge state. Direct-main, keyed workspaceId + slug; runs "
      + 'the engine pr-status probe (read-only, no working-tree mutation) then returns the refreshed vcs block. Read '
      + 'vcs.pullRequestState (open | merged | closed | null) from the payload — this is the precondition a landed-run '
      + 'trigger polls.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
      },
      required: ['workspaceId', 'slug'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const refreshed = await backends.refreshSprintPullRequestStatus({ statePath: resolvedRun.statePath })
      if (!refreshed.ok) return sprintCommandResultFailure('sprint_pr_status_failed', refreshed)
      return success({ slug: resolvedRun.slug, vcs: sprintVcsFromCommandResult(refreshed.data) })
    },
  }

  const sprintTokenUsage: McpToolRegistration = {
    name: 'sprint.token_usage',
    description:
      "A Sprint Engine run's token accounting report (per-run totals, per-agent and per-task breakdowns, measurement "
      + 'coverage), computed from the run ledger and CLI transcripts. Direct-main, keyed workspaceId + slug. For '
      + 'budget-aware orchestration; unmeasured agents are reported as such, never as zero.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
      },
      required: ['workspaceId', 'slug'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      // Gate on the run existing so a bad slug returns sprint_not_found rather
      // than the compute's truthful-but-misleading empty report for a run that
      // is not there (fallback discipline — no invented empty data).
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const tokenUsage = await backends.readSprintTokenUsage(resolvedRun.statePath)
      return success({ slug: resolvedRun.slug, tokenUsage })
    },
  }


  return [
    sprintList,
    sprintStatus,
    sprintCreate,
    sprintSetMode,
    sprintResume,
    sprintCancel,
    sprintArtifactApprove,
    sprintArtifactRequestChanges,
    sprintTaskComment,
    sprintTaskResolveInput,
    sprintTaskSetStatus,
    sprintTaskCreate,
    sprintTaskUpdate,
    sprintPrCreate,
    sprintPrStatus,
    sprintTokenUsage,
  ].map(asModuleOwned)
}

function asModuleOwned(registration: McpToolRegistration): McpToolRegistration {
  const mutating = !['sprint.list', 'sprint.status', 'sprint.pr.status', 'sprint.token_usage'].includes(registration.name)
  return mutating ? { ...registration, mutates: true } : registration
}

function success(structured: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  }
}

function failure(code: string, message: string): McpToolResult {
  const structured = { error: { code, message } }
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    isError: true,
  }
}

function requireString(args: Record<string, unknown>, key: string): string | McpToolResult {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    return failure('invalid_arguments', `"${key}" must be a non-empty string.`)
  }
  return value.trim()
}

function sprintCommandResultFailure(
  code: string,
  result: { message: string; stdout?: string; stderr?: string }
): McpToolResult {
  const detail = [result.stdout, result.stderr].filter((part) => Boolean(part && part.trim())).join('\n')
  return failure(code, detail ? `${result.message}\n${detail}` : result.message)
}

function sprintVcsFromCommandResult(data: SprintEngineMutationRefreshData): SprintEngineVcs | null {
  if (typeof data.projectionContent !== 'string') return null
  try {
    const parsed = JSON.parse(data.projectionContent) as { vcs?: SprintEngineVcs | null }
    return parsed.vcs ?? null
  } catch {
    return null
  }
}

function firstInvalidStringArray(args: Record<string, unknown>, keys: string[]): McpToolResult | null {
  for (const key of keys) {
    const value = args[key]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
      return failure('invalid_arguments', `"${key}" must be an array of non-empty strings.`)
    }
  }
  return null
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? (value as string[]) : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function firstInvalidOptionalString(args: Record<string, unknown>, keys: string[]): McpToolResult | null {
  for (const key of keys) {
    if (args[key] !== undefined && typeof args[key] !== 'string') {
      return failure('invalid_arguments', `"${key}" must be a string when provided.`)
    }
  }
  return null
}
