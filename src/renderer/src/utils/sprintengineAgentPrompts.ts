import type { SprintEngineRoleId, SprintEngineRoleRegistry } from '../types/workspace'
import { getSprintEngineRoleLabel } from './sprintengine'

// Startup prompts shipped to Sprint Engine agent terminals from the board.
//
// These prompts intentionally point agents at the managed MCP boundary and
// canonical CLI verbs. They MUST NOT contain server-owned routing fields
// like `statePath` or `workspaceRoot` — the managed Sprint Engine MCP
// server resolves those itself (see `knowledge/multicode/sprint-engine.md`).
// If a future change needs new prompt variants, add them here so the same
// rule is enforced for the live board and any other surface that spawns
// Sprint Engine agents.

export function buildSprintEngineRecoveryAuditPrompt(): string {
  return [
    'Fetch the canonical recovery instructions from the Python tool.',
    'Run `sprintengine recover` now.',
  ].join('\n')
}

export type SprintEngineRosterRevisionPromptInput = {
  role: SprintEngineRoleId
  agentId: string
  teamSlug: string
  registry?: SprintEngineRoleRegistry | null
}

// The app-owned add-agent path: the user enabled the role for the run (the
// board wrote configuredRoles via `roster enable`) and spawned a worker on a
// board-minted id (MC-1591 leases), so the architect is asked only to review
// whether the plan needs revision for the new specialist.
export function buildSprintEnginePlanRevisionForNewMemberPrompt(
  input: SprintEngineRosterRevisionPromptInput,
): string {
  const { role, agentId, teamSlug, registry } = input
  const label = getSprintEngineRoleLabel(role, registry ?? null)
  return [
    'The user just enabled a new role for this sprint run; review whether the plan needs revision for it.',
    `Team: \`${teamSlug}\``,
    `New role: ${label} (\`${role}\`), with agent id \`${agentId}\` starting now. The role is already enabled in the run's configuredRoles — nothing to configure.`,
    '',
    'Inspect the current plan, task graph, completed evidence, and open risks. If this new specialist should do work, add only the needed task cards with normal `Sprint Engine plan add-task` commands and correct dependencies. If no task is needed, record a concise rationale in the architect terminal and stop.',
    '',
    'Do not implement work yourself. Do not create tasks for unrelated roles. Do not edit sprint run-store files directly.',
  ].join('\n')
}
