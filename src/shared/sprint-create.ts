/**
 * The `sprint.create` contract (MC-2160).
 *
 * Sprint creation is a main-process capability now: the gateway lane, Horizon's
 * `startSprint`, and the `sprint-engine-start` automation action all call
 * `SprintCreateService` (`src/main/sprint-create-service.ts`) instead of asking
 * a window to run the wizard's store actions. The request shape is unchanged —
 * it moved here from `automation.ts` so a delegate that no longer runs it is
 * not what defines it.
 */
import type { SprintEngineCliPermissionPreset } from './electron-api'

// Create a new Sprint Engine run: a sprintengine-mode workspace whose
// run.yaml is initialized through the same controller path the wizard
// uses (main spawns the one-shot Python init). Roster defaults resolve
// like the wizard's roster step (last saved roster, else the built-in
// default). Creation registers the run with the main-process scheduler,
// whose run-start bootstrap spawns the coordinator seat — there is no board
// mount in the loop, so this works with zero windows open.
//
// TWO CONCEPTS, THREE FIELDS (MC-1874) — do not merge them:
//   `name`           = RUN IDENTITY seed. Becomes the run's team dir slug.
//   `refuseTeamSlug` = RUN IDENTITY. A slug to refuse (self-trigger guard).
//   `rosterName` / `roster` = AGENT CONFIGURATION. Which roles staff the run.
export type SprintCreateRequest = {
  folderPath: string
  goal: string
  /** Run name (seeds the team dir slug); defaults to the wizard's 'Sprint Roster'. */
  name?: string
  /**
   * Start the auto-runner: the scheduler's run-start bootstrap spawns the
   * coordinator seat. Default false — a manual run sits idle until opened.
   */
  startRunner?: boolean
  autoApproveArtifacts?: boolean
  useWorktrees?: boolean
  /**
   * Per-task worktrees (MC-2136): every task gets its own checkout branched
   * off the run branch and merged back at publish, instead of the whole run
   * sharing one. Only ever set alongside `useWorktrees` — the tool that
   * fills this in turns worktrees on with it, and the engine refuses the
   * pair otherwise. Absent is the normal mode: one worktree per sprint.
   */
  taskIsolation?: boolean
  /**
   * Plan-sourced launch (sprint chaining, MC-1438): start the sprint from
   * this project-relative backlog item through the shared plan-sourced
   * creation path instead of the goal-sourced new-team path. `goal` may be
   * empty — it derives from the item's first heading.
   */
  sourceRelativePath?: string
  /**
   * Multi-source launch (MC-2077): start ONE sprint from several backlog
   * items and/or epics through the same selection path the Backlog door's
   * multi-select uses. The first entry is the anchor (the run's primary
   * document). Mutually exclusive with `sourceRelativePath`; a single
   * entry behaves exactly like `sourceRelativePath`.
   */
  sourceRelativePaths?: string[]
  /**
   * How the run gets its task graph (MC-2128/2129). Absent takes the default
   * for the source — `direct` for an epic, `planned` for everything else —
   * which is decided in the engine, not here. Automations and Horizon set it
   * only to override that.
   */
  intake?: 'direct' | 'planned'
  /** Saved ROSTER name to staff the run with; absent resolves like the wizard (last selected, else default). */
  rosterName?: string
  /**
   * Explicit roster: role id -> staffed flag. Wins over `rosterName` and over
   * the saved-roster fallback, so a caller with no saved roster can still staff
   * a run precisely. A role omitted here is OFF — the map is applied over a
   * zero base, never over the default counts (owner, 2026-07-14: absent
   * means off).
   *
   * Counts are effectively boolean: `normalizeSprintEngineRoleCounts`
   * clamps every value to 0 or 1, so this selects WHICH roles run, not how
   * many agents — parallelism is `maxConcurrentAgents`.
   *
   * Role ids are registry-driven (`SprintEngineRoleId` is an open string),
   * so roles outside the wizard's built-in default map — `spec_reviewer`,
   * `nuclear_reviewer` — are accepted and get a CLI default seeded for
   * them. Without that seed they resolve to no CLI and are silently skipped
   * at spawn.
   */
  roster?: Record<string, number>
  /**
   * The CLI permission preset the run's agents SPAWN with (MC-1900).
   *
   * Honored on the PLAN-SOURCED path only — a horizon step, an automation,
   * a chained sprint: there the escalation comes from a human-authored plan
   * file or automation definition, which is consent. The goal-sourced path
   * (an arbitrary external caller with a bare goal) keeps its hardcoded
   * 'default' and cannot be escalated through this field, which is the
   * "external creation never self-escalates" rule the pre-horizon comment
   * was protecting. Absent on the plan-sourced path = bypass, because a
   * plan-sourced run is unwatched by construction.
   *
   * Spawn-time only (MC-1808): a running agent can never be flipped to
   * bypass, so this value matters exactly once, at creation.
   */
  permissionPreset?: SprintEngineCliPermissionPreset
  /**
   * Self-trigger loop guard (sprint chaining): refuse creation when the new
   * run's team dir slug would equal this watched team dir.
   */
  refuseTeamSlug?: string
  /**
   * Worktree start point for chained runs on a refreshed base (e.g.
   * `origin/main` after a fetch). Start point only — the run's PR base stays
   * the plain branch name. Only meaningful alongside `useWorktrees`.
   */
  baseStartPoint?: string
  /**
   * The run-level execution runtime (MC-2120), i.e. the dialog's pool
   * runtime picker: the CLI/model/effort the ROLELESS seat launches on, and
   * the fallback for any staffed role the maps below do not name.
   *
   * A roleless run — now the default sprint kind — has no role ids at all,
   * so the role-keyed maps cannot reach its one seat. Lands in the same
   * `roleRuntimes` entry the wizard writes, under the reserved
   * `(roleless)` key. An absent member keeps today's behaviour: the CLI's
   * stock default for `cli`, and no `--model` / no effort flag.
   */
  runtime?: { cli?: string; model?: string; effort?: string }
  /**
   * Per-role agent CLI, role id -> CLI plugin id (null = fall back to
   * `runtime.cli`, else the role's stock default). The roster editor's
   * per-role CLI column.
   */
  roleClis?: Record<string, string | null>
  /**
   * Per-role explicit launch model, role id -> model id (null = CLI
   * default). Applied over the resolved roster, so a role named here that
   * the run does not staff is a loud failure, never a silent no-op.
   */
  roleModels?: Record<string, string | null>
  /** Per-role reasoning-effort level (MC-1885), same contract as `roleModels`. */
  roleEfforts?: Record<string, string | null>
  /**
   * The run's ceiling on concurrent agent sessions (the dialog's *Max
   * concurrent agents*), clamped 1-10 by the controller. Absent keeps the
   * default of 3. On a roleless run this is also the effective agent count:
   * agents are minted per task up to this ceiling.
   */
  maxConcurrentAgents?: number
}

export type SprintCreateResult =
  | { ok: true; workspaceId: string }
  | { ok: false; code: string; message: string }
