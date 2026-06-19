import { getRendererHost } from '../../../modules'
import type { CreationMode } from './types'

// Wizard step ids for the new-workspace flow. Shared by NewWorkspacePanel for
// step rendering/readiness and resolved per mode below.
export type StepId =
  | 'workspace'
  | 'mode'
  | 'mcp-servers'
  | 'skill-packs'
  | 'knowledge'
  | 'standard-layout'
  | 'multiloop-goal'
  | 'sprintengine-team'
  | 'sprintengine-roster'
  | 'guided-idea'

// The wizard's step flows are keyed by a closed set of flow ids. A registered
// workspace type points at one of these via its creationStepsId; 'standard' is
// the shell-owned default and the fallback for any mode whose registry entry is
// missing or names an unknown flow.
export type CreationStepsId = 'standard' | 'switchboard' | 'multiloop' | 'sprintengine' | 'guided-brief'

// Default flows keep only the steps a person needs to reach the thing they came
// to make. The developer-configuration steps — 'mcp-servers', 'skill-packs', and
// 'knowledge' — are deliberately NOT in the linear gate: they're optional, jargon-
// heavy, and equally reachable from Settings (and, going forward, an opt-in
// "Advanced setup" disclosure). 'mode' stays in every flow because it is the pivot
// step where the workspace type is chosen and the flow is recomputed live.
//
// The 'knowledge' step (point new agents at a knowledge-graph folder) is still a
// valid StepId rendered by the optional advanced surface; NewWorkspacePanel also
// drops it for a folder whose project already has a configured/inherited knowledge
// root (see shouldShowKnowledgeStep).
export const STEPS_BY_MODE: Record<CreationStepsId, StepId[]> = {
  standard: ['workspace', 'mode', 'standard-layout'],
  switchboard: ['workspace', 'mode'],
  multiloop: ['workspace', 'mode', 'multiloop-goal'],
  sprintengine: ['workspace', 'mode', 'sprintengine-team', 'sprintengine-roster'],
  'guided-brief': ['workspace', 'mode', 'guided-idea'],
}

function isCreationStepsId(value: string | undefined): value is CreationStepsId {
  return value !== undefined && value in STEPS_BY_MODE
}

// Resolve a mode id to its wizard step flow through the workspace-type registry's
// creationStepsId, defaulting to the standard flow. 'standard' is shell-owned and
// resolves directly; an unknown id (no registry entry, or one whose creationStepsId
// is not a known flow) falls back to standard so the wizard never crashes.
export function stepsForMode(mode: CreationMode): StepId[] {
  if (mode === 'standard') return STEPS_BY_MODE.standard
  const stepsId = getRendererHost().getWorkspaceType(mode)?.creationStepsId
  return STEPS_BY_MODE[isCreationStepsId(stepsId) ? stepsId : 'standard']
}
