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

export function buildSprintEnginePlanReviewStartupPrompt(
  role: SprintEngineRoleId,
  agentId: string,
): string {
  return [
    'Fetch the canonical plan review instructions from the Python tool.',
    `Run \`Sprint Engine plan start-review --role ${role} --id ${agentId}\` now.`,
  ].join('\n')
}

export function buildSprintEngineAddressPlanReviewsPrompt(): string {
  return [
    'Fetch the canonical plan review feedback instructions from the Python tool.',
    'Run `Sprint Engine plan address-reviews --actor architect` now.',
  ].join('\n')
}

export type SprintEngineRosterRevisionPromptInput = {
  role: SprintEngineRoleId
  agentId: string
  teamSlug: string
  registry?: SprintEngineRoleRegistry | null
}

export function buildSprintEngineRosterRevisionPrompt(
  input: SprintEngineRosterRevisionPromptInput,
): string {
  const { role, agentId, teamSlug, registry } = input
  const label = getSprintEngineRoleLabel(role, registry ?? null)
  return [
    'Revise this Sprint Engine plan for a newly added roster member.',
    `Team: \`${teamSlug}\``,
    `New roster member: ${label} (\`${role}\`) with agent id \`${agentId}\`.`,
    '',
    'First add the member to the canonical Sprint Engine roster:',
    '',
    '```shell',
    `sprintengine roster add --role ${role} --id ${agentId} --actor architect`,
    '```',
    '',
    'Then inspect the current plan, task graph, completed evidence, and open risks. If this new specialist should do work, add only the needed task cards with normal `Sprint Engine plan add-task` commands and correct dependencies. If no task is needed, record a concise rationale in the architect terminal and stop.',
    '',
    'Do not implement work yourself. Do not create tasks for unrelated roles. Do not edit Sprint Engine run-store files directly.',
  ].join('\n')
}
