import type { SprintEngineCliPermissionPreset } from './electron-api'
import type { WorkspaceMode } from '../renderer/src/types/workspace'

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
      // like the wizard's roster step (last saved team, else the built-in
      // default). The board-panel mount owns launching the architect, so the
      // renderer activates the new workspace before answering.
      kind: 'sprint.create'
      folderPath: string
      goal: string
      /** Team name; defaults to the wizard's 'Sprint Roster'. */
      name?: string
      /** Start the auto-runner (spawns the architect at mount). Default false: a manual run sits idle until opened. */
      startRunner?: boolean
      autoApproveArtifacts?: boolean
      useWorktrees?: boolean
      /**
       * Plan-sourced launch (sprint chaining, MC-1438): start the sprint from
       * this project-relative backlog item through the shared plan-sourced
       * creation path instead of the goal-sourced new-team path. `goal` may be
       * empty — it derives from the item's first heading.
       */
      sourceRelativePath?: string
      /** Saved team (roster) name to staff the run with; absent resolves like the wizard (last selected, else default). */
      team?: string
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
