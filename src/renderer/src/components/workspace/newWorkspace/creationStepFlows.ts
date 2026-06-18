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
export type CreationStepsId = 'standard' | 'switchboard' | 'automations' | 'multiloop' | 'sprintengine' | 'guided-brief'

// The 'knowledge' step (point new agents at a knowledge-graph folder) sits with
// the other per-project setup steps after 'skill-packs'. It is conditional, not
// universal: NewWorkspacePanel drops it for a folder whose project already has a
// configured/inherited knowledge root (see shouldShowKnowledgeStep), so existing
// projects don't re-prompt while new ones get the picker — including first-run
// onboarding, whose workspace step is this same panel.
export const STEPS_BY_MODE: Record<CreationStepsId, StepId[]> = {
  standard: ['workspace', 'mode', 'mcp-servers', 'skill-packs', 'knowledge', 'standard-layout'],
  switchboard: ['workspace', 'mode', 'mcp-servers', 'skill-packs', 'knowledge'],
  automations: ['workspace', 'mode', 'mcp-servers', 'skill-packs', 'knowledge'],
  multiloop: ['workspace', 'mode', 'mcp-servers', 'skill-packs', 'knowledge', 'multiloop-goal'],
  sprintengine: ['workspace', 'mode', 'mcp-servers', 'skill-packs', 'knowledge', 'sprintengine-team', 'sprintengine-roster'],
  'guided-brief': ['workspace', 'mode', 'mcp-servers', 'skill-packs', 'knowledge', 'guided-idea'],
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
