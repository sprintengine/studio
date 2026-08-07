import type { SprintEngineCliPermissionPreset } from './electron-api'
import type { WorkspaceMode } from './workspace-mode'

// Multicode app-automation surface: shared contracts between the main-process
// MCP server, the preload bridge, and the renderer delegate.
//
// The automation server (src/main/automation/) is a local-only MCP endpoint
// owned by the app's main process. Read tools answer from main's authoritative
// stores (workspace-sync snapshot + terminal runtime). Mutation tools are
// delegated to the primary window's renderer, which executes the same store
// actions the UI uses — workspace construction and agent spawning stay
// renderer-owned, and the resulting workspace.created / agent_terminal.*
// events flow through the workspace-sync command bus exactly like
// user-initiated changes. See knowledge/multicode/automation-server.md.

export type AutomationServerStatus = {
  /** Compatibility field; the Studio gateway is always enabled. */
  enabled: boolean
  running: boolean
  /** Unix socket path (POSIX) or named pipe (Windows) while running. */
  socketPath: string | null
  /** Last start/stop failure, surfaced instead of silently staying off. */
  lastError: string | null
  /**
   * Absolute path of the repo/app-shipped stdio bridge script stock MCP
   * clients launch to reach the socket (`node <bridgeScriptPath>`). Static
   * app knowledge, present whether or not the server is running.
   */
  bridgeScriptPath: string | null
}

// Mutations the automation server may ask the primary renderer to perform.
// Kept to the v1 tool surface deliberately — no settings mutation, no file APIs.
export type AutomationRendererRequest =
  | {
      kind: 'workspace.create'
      name?: string
      folderPath?: string
      templateId?: string
      /** Explicit workspace mode (e.g. 'automations-host' for the hidden
       *  background host). Omitted means standard-derivation at creation. */
      mode?: WorkspaceMode
    }
  | {
      kind: 'agent.launch'
      workspaceId: string
      cli?: string
      name?: string
      prompt?: string
      /** Model id passed at launch when the CLI plugin declares modelSelection. */
      cliModel?: string
      /** CLI permission preset (default / auto_workspace / bypass_all). */
      permissionPreset?: SprintEngineCliPermissionPreset
      /** When set, the agent launches as a specialist rather than a general agent. */
      specialistId?: string
      /** Git worktree the agent should run in, instead of the workspace checkout. */
      worktreePath?: string
      /**
       * Catalog connector id (e.g. 'railway'). When set, the renderer resolves it
       * to the connector's single-server MCP and driving skill and launches the
       * agent worktree-isolated with that connector environment — the same
       * isolation invariant as a connector chat.
       */
      connectorId?: string
      /**
       * Built-in skill id (e.g. 'backlog') to attach to the launched agent. Rides
       * AgentState.spawnSkillId, so the terminal spawn best-effort installs the
       * skill into the agent's working directory (the per-run worktree) before the
       * CLI starts — the same seam the composer's "+ Skill" attachment uses.
       * Built-in skills only: they are the ones that install into the worktree.
       */
      spawnSkillId?: string
    }
  | {
      // Remove a spawned automation agent entirely: kill its terminal, drop its
      // tab, and delete the agent record. Used at run finalize so a one-shot
      // automation agent never lingers pointing at a torn-down run worktree (the
      // dead-cwd relaunch loop). Idempotent — a missing workspace/agent is `ok`.
      kind: 'agent.dispose'
      workspaceId: string
      agentId: string
    }
  | {
      // Create a new Sprint Engine run: a sprintengine-mode workspace whose
      // run.yaml is initialized through the same controller path the wizard
      // uses (main spawns the one-shot Python init). Roster defaults resolve
      // like the wizard's roster step (last saved roster, else the built-in
      // default). The board-panel mount owns launching the architect, so the
      // renderer activates the new workspace before answering.
      //
      // TWO CONCEPTS, THREE FIELDS (MC-1874) — do not merge them:
      //   `name`           = RUN IDENTITY seed. Becomes the run's team dir slug.
      //   `refuseTeamSlug` = RUN IDENTITY. A slug to refuse (self-trigger guard).
      //   `rosterName` / `roster` = AGENT CONFIGURATION. Which roles staff the run.
      kind: 'sprint.create'
      folderPath: string
      goal: string
      /** Run name (seeds the team dir slug); defaults to the wizard's 'Sprint Roster'. */
      name?: string
      /** Start the auto-runner (spawns the architect at mount). Default false: a manual run sits idle until opened. */
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

export type AutomationRendererResponse =
  | {
      ok: true
      workspaceId: string
      agentId?: string
      /**
       * Actual mode of the created-or-reused workspace, from the renderer's
       * registry (the domain source of truth). Main's sync snapshot restores
       * restart-survivor workspaces as routing placeholders whose mode is not
       * authoritative, so mode assertions after workspace.create must use this
       * field, never the snapshot placeholder.
       */
      workspaceMode?: WorkspaceMode
    }
  | { ok: false; code: string; message: string }

export const AUTOMATION_REQUEST_CHANNEL = 'automation:request'
export const AUTOMATION_RESPOND_CHANNEL = 'automation:respond'
export const AUTOMATION_GET_STATUS_CHANNEL = 'automation:get-status'
export const AUTOMATION_SET_ENABLED_CHANNEL = 'automation:set-enabled'
