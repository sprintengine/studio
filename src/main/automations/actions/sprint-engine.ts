import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { SprintCreateRequest, SprintCreateResult } from '../../../shared/sprint-create'
import type { AutomationActionProvider, AutomationRun } from '../../../shared/automations/contracts'
import { isRecord } from '../../../shared/records'
import type {
  SprintEngineArtifactCommandResult,
  SprintEngineProjectionReadResult,
  SprintEngineRunnerSetInput,
  SprintEngineTaskMutationRole,
} from '../../../shared/electron-api'

export const SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID = 'module:sprint-engine'
export const SPRINT_ENGINE_RUN_ACTION_KIND = 'sprint-engine-run'
export const SPRINT_ENGINE_START_ACTION_KIND = 'sprint-engine-start'

const SPRINT_ENGINE_AUTOMATION_ROLES: SprintEngineTaskMutationRole[] = [
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

export type SprintEngineAutomationFrontDoors = {
  setRunnerMode(input: SprintEngineRunnerSetInput): Promise<SprintEngineArtifactCommandResult>
  /**
   * Read a run's projection.json — the sanctioned read surface for run state
   * (never run-store internals). Used by the `sprint-engine.run-landed` trigger.
   */
  readProjection(input: { statePath: string; knownToken?: string }): Promise<SprintEngineProjectionReadResult>
  /**
   * Idempotent `vcs pr-status` refresh for a run's declared repos, so landed
   * detection does not depend on the renderer's PR sweeps. Read-only on the tree.
   */
  refreshPullRequestStatus(input: { statePath: string }): Promise<SprintEngineArtifactCommandResult>
  /**
   * Merge one project's delivered pull request (`vcs pr-merge`). The engine
   * re-probes state, enforces merge order, and is idempotent. Used by the
   * roadmap orchestrator's `merge: auto` advance (MC-1619).
   */
  mergePullRequest(input: { statePath: string; repo?: string }): Promise<SprintEngineArtifactCommandResult>
}

export function createSprintEngineRunActionProvider(
  frontDoors: SprintEngineAutomationFrontDoors
): AutomationActionProvider {
  return {
    kind: SPRINT_ENGINE_RUN_ACTION_KIND,
    configSchema: {
      type: 'object',
      required: ['team'],
      properties: {
        team: { type: 'string', minLength: 1 },
        role: {
          type: 'string',
          minLength: 1,
          enum: SPRINT_ENGINE_AUTOMATION_ROLES,
        },
      },
    },
    requiredIntegrations: [SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID],
    run: async (config, ctx) => {
      ctx.requireIntegration(SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID)
      const parsed = parseSprintEngineRunConfig(config)
      const statePath = join(ctx.workspaceRoot, '.multi-code', 'sprintengine', parsed.team, 'run.yaml')

      // Enabling the runner starts the sprint; the supervisor mints and spawns
      // task-scoped workers on its own as ready tasks appear (MC-1591 leases —
      // there is no roster to pre-seed). `role` narrows the summary only.
      const runner = await frontDoors.setRunnerMode({ statePath, cliWatchPolling: 'enabled' })
      if (!runner.ok) return failedRun(runner.message)

      return {
        status: 'completed',
        summary: parsed.role
          ? `Started a sprint for team "${parsed.team}" (${parsed.role}).`
          : `Started a sprint for team "${parsed.team}".`,
      }
    },
  }
}

export type SprintEngineStartActionDeps = {
  /**
   * Main's sprint-creation service (MC-2160). A chained sprint no longer needs a
   * window: creation composes in-process and the scheduler bootstraps the
   * coordinator, so an unattended 02:00 chain starts the same as an attended one.
   */
  createSprint(request: SprintCreateRequest): Promise<SprintCreateResult>
  /**
   * Fetch the checkout's upstream and return the freshly-updated remote-tracking
   * ref of the current branch (e.g. `origin/main`), or null when there is no
   * upstream to refresh from (the run then branches from the local base, which
   * is all there is). MUST throw when an upstream exists but the fetch fails —
   * silently proceeding would chain the sprint onto a stale base, the exact
   * defect this plumbing prevents. Injected for tests; defaults to real git.
   */
  resolveBaseStartPoint?(workspaceRoot: string): Promise<string | null>
}

/**
 * Start the next sprint from a chosen backlog item (MC-1438): the `sprint-engine.
 * run-landed` trigger's companion action, composing with `disableAfterRun` for
 * "chain once" pipelines. The chained run always bases on the refreshed base
 * branch — after a merge on GitHub the local checkout is typically stale, so the
 * action fetches first and passes the remote-tracking ref as the worktree START
 * POINT while the PR base stays the plain branch name.
 *
 * The sprint owns its own worktree and PR lifecycle, so this action never calls
 * `ctx.spawnAgent` and the automations per-run worktree/PR wrapper never engages
 * (same posture as `sprint-engine-run`). The automation run finalizes `completed`
 * at successful launch; the sprint's own lifecycle is tracked by sprint-engine
 * surfaces, not automations run history.
 *
 * Chained sprints are SINGLE-PROJECT in v1: the config declares no sibling
 * repos, so the refreshed start point only ever applies to the primary repo —
 * `ensure_run_worktree`'s primary-only `start_point` gating is deliberately
 * sufficient. Extending chaining to multi-repo runs needs a per-repo fetch and
 * per-repo start points first.
 */
export function createSprintEngineStartActionProvider(
  deps: SprintEngineStartActionDeps
): AutomationActionProvider {
  const resolveBaseStartPoint = deps.resolveBaseStartPoint ?? defaultResolveBaseStartPoint
  return {
    kind: SPRINT_ENGINE_START_ACTION_KIND,
    configSchema: {
      type: 'object',
      required: ['backlogItem'],
      properties: {
        backlogItem: { type: 'string', minLength: 1 },
        // Saved ROSTER name (agent config). NOT the run's team dir slug — that
        // is `sprint-engine-run`'s `team`, a different action with a different
        // meaning for the same old word (MC-1874).
        roster: { type: 'string', minLength: 1 },
        sprintName: { type: 'string', minLength: 1 },
        useWorktrees: { type: 'boolean' },
        autoApproveArtifacts: { type: 'boolean' },
      },
    },
    requiredIntegrations: [SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID],
    run: async (config, ctx) => {
      ctx.requireIntegration(SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID)
      const parsed = parseSprintEngineStartConfig(config)
      const useWorktrees = parsed.useWorktrees !== false

      // Self-trigger loop guard: creation refuses when the new run's team dir
      // would equal the trigger's watched team dir. The watched team is only
      // known at fire time (it rides the run-landed payload), so the guard is
      // enforced here, not at definition-write.
      const watchedTeam = typeof ctx.triggerPayload.team === 'string'
        ? ctx.triggerPayload.team.trim()
        : ''

      // Chained sprints base on the refreshed remote base. Non-worktree runs work
      // on the checkout itself and v1 never mutates the user's checkout (no
      // auto-pull) — if the checkout is behind, the sprint builds on what is there.
      const baseStartPoint = useWorktrees ? await resolveBaseStartPoint(ctx.workspaceRoot) : null

      const created = await deps.createSprint({
        folderPath: ctx.workspaceRoot,
        goal: '',
        name: parsed.sprintName,
        sourceRelativePath: parsed.backlogItem,
        rosterName: parsed.roster,
        useWorktrees,
        startRunner: true,
        autoApproveArtifacts: parsed.autoApproveArtifacts === true,
        ...(watchedTeam ? { refuseTeamSlug: watchedTeam } : {}),
        ...(baseStartPoint ? { baseStartPoint } : {}),
      })
      if (!created.ok) return failedRun(created.message)

      return {
        status: 'completed',
        workspaceId: created.workspaceId,
        summary: baseStartPoint
          ? `Started a sprint from ${parsed.backlogItem} on ${baseStartPoint}.`
          : `Started a sprint from ${parsed.backlogItem}.`,
      }
    },
  }
}

function parseSprintEngineStartConfig(config: unknown): {
  backlogItem: string
  roster?: string
  sprintName?: string
  useWorktrees?: boolean
  autoApproveArtifacts?: boolean
} {
  if (!isRecord(config)) throw new Error('sprint-engine-start config must be an object.')
  const backlogItem = optionalString(config.backlogItem)?.replace(/\\/g, '/')
  if (!backlogItem) throw new Error('sprint-engine-start config requires a backlog item.')
  if (/^(?:\/|[A-Za-z]:)/.test(backlogItem) || backlogItem.split('/').includes('..')) {
    throw new Error('sprint-engine-start backlog item must be a project-relative path.')
  }
  if (!backlogItem.startsWith('backlog/') || !backlogItem.endsWith('.md')) {
    throw new Error('sprint-engine-start backlog item must be a markdown file under backlog/.')
  }
  // v1 chains from leaf items: epic launches bundle their children, which is a
  // wizard flow this action does not reproduce.
  if (backlogItem.startsWith('backlog/epics/')) {
    throw new Error('sprint-engine-start cannot chain from an epic; pick one of its member items.')
  }
  const useWorktrees = config.useWorktrees
  if (useWorktrees !== undefined && typeof useWorktrees !== 'boolean') {
    throw new Error('sprint-engine-start useWorktrees must be a boolean.')
  }
  const autoApproveArtifacts = config.autoApproveArtifacts
  if (autoApproveArtifacts !== undefined && typeof autoApproveArtifacts !== 'boolean') {
    throw new Error('sprint-engine-start autoApproveArtifacts must be a boolean.')
  }
  // ONE-TIME LEGACY READ (MC-1874), and the ONLY surviving one. Automation
  // configs are persisted per workspace and have no normalizer pass to migrate
  // through, so the pre-rename `team` spelling is accepted here at parse time
  // and rewritten nowhere. This is NOT a general pattern — every other roster
  // rename migrates once through the settings normalizer and then stops reading
  // the old key. Do not copy this shape elsewhere.
  const roster = optionalString(config.roster) ?? optionalString((config as { team?: unknown }).team)
  return {
    backlogItem,
    ...(roster ? { roster } : {}),
    ...(optionalString(config.sprintName) ? { sprintName: optionalString(config.sprintName) } : {}),
    ...(useWorktrees === undefined ? {} : { useWorktrees }),
    ...(autoApproveArtifacts === undefined ? {} : { autoApproveArtifacts }),
  }
}

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 30_000

// Refresh the checkout's upstream and name the remote-tracking ref the chained
// run's worktree should branch from. Read-only on the tree: `git fetch` updates
// remote-tracking refs, never the checkout. No upstream degrades to null (the
// local base is all there is); a FAILED fetch throws so the run fails visibly
// instead of silently chaining onto a stale base.
async function defaultResolveBaseStartPoint(workspaceRoot: string): Promise<string | null> {
  let upstream: string
  try {
    upstream = (await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      { cwd: workspaceRoot, timeout: GIT_TIMEOUT_MS }
    )).stdout.trim()
  } catch {
    // Detached HEAD / no upstream configured / not a git repo: nothing fresher
    // than the local base exists to branch from.
    return null
  }
  const remote = upstream.split('/')[0]
  if (!upstream || !remote) return null
  try {
    await execFileAsync('git', ['fetch', remote], { cwd: workspaceRoot, timeout: GIT_TIMEOUT_MS })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Could not refresh "${remote}" before starting the chained sprint (the new sprint must base on `
      + `the refreshed ${upstream}, not a stale local branch): ${detail}`
    )
  }
  return upstream
}

function parseSprintEngineRunConfig(config: unknown): {
  team: string
  role?: SprintEngineTaskMutationRole
} {
  if (!isRecord(config)) throw new Error('sprint-engine-run config must be an object.')
  const team = optionalString(config.team)
  if (!team) throw new Error('sprint-engine-run config requires a team.')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(team)) {
    throw new Error('sprint-engine-run team must be a safe sprint roster id.')
  }
  const role = optionalString(config.role)
  let parsedRole: SprintEngineTaskMutationRole | undefined
  if (role) {
    if (!isSprintEngineAutomationRole(role)) {
      throw new Error('sprint-engine-run role must be a known sprint role.')
    }
    parsedRole = role
  }
  return {
    team,
    ...(parsedRole ? { role: parsedRole } : {}),
  }
}

function isSprintEngineAutomationRole(value: string): value is SprintEngineTaskMutationRole {
  return SPRINT_ENGINE_AUTOMATION_ROLES.includes(value as SprintEngineTaskMutationRole)
}

function failedRun(message: string): Partial<AutomationRun> {
  return {
    status: 'failed',
    summary: message,
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

