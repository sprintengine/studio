import { getRendererHost } from '../../../modules'
import type { CreationMode } from './types'

// Config-step ids for the creation hub. The hub renders a mode's whole flow as
// one pane — the shared name/folder fields ('workspace') plus the flow's config
// steps stacked in order — so a flow is simply that ordered list. The historic
// 'mode' pivot step is gone: the hub's rail IS the type choice.
export type StepId =
  | 'workspace'
  | 'mcp-servers'
  | 'skill-packs'
  | 'knowledge'
  | 'standard-layout'
  | 'multiloop-goal'
  | 'sprintengine-team'
  | 'sprintengine-roster'
  | 'guided-idea'

// The hub's flows are keyed by a closed set of flow ids. A registered workspace
// type points at one of these via its creationStepsId; 'standard' is the
// shell-owned default and the fallback for any mode whose registry entry is
// missing or names an unknown flow.
export type CreationStepsId = 'standard' | 'switchboard' | 'automations' | 'multiloop' | 'sprintengine' | 'guided-brief'

// Default flows keep only the steps a person needs to reach the thing they came
// to make. The developer-configuration steps — 'mcp-servers', 'skill-packs', and
// 'knowledge' — are deliberately NOT in the create gate: they're optional,
// jargon-heavy, and equally reachable from Settings (and the opt-in "Advanced
// setup" disclosure, which the hub shows for any flow with real config steps).
//
// The 'knowledge' step (point new agents at a knowledge-graph folder) is still a
// valid StepId rendered by the optional advanced surface; NewWorkspacePanel also
// drops it for a folder whose project already has a configured/inherited knowledge
// root (see shouldShowKnowledgeStep).
export const STEPS_BY_MODE: Record<CreationStepsId, StepId[]> = {
  standard: ['workspace', 'standard-layout'],
  switchboard: ['workspace'],
  // Zero-config like Switchboard: pick a folder and create; the fixed
  // single-surface template (control center + right-docked run terminals) means
  // no layout-picker step.
  automations: ['workspace'],
  multiloop: ['workspace', 'multiloop-goal'],
  sprintengine: ['workspace', 'sprintengine-team', 'sprintengine-roster'],
  // All three Design Wizard presets (full-brief, frontend-design,
  // design-system) share this flow: the preset is chosen inside the
  // 'guided-idea' step, not by a separate flow id, because presets live inside
  // the guided-brief workspace type rather than being modes of their own.
  'guided-brief': ['workspace', 'guided-idea'],
}

function isCreationStepsId(value: string | undefined): value is CreationStepsId {
  return value !== undefined && value in STEPS_BY_MODE
}

// Resolve a mode id to its flow through the workspace-type registry's
// creationStepsId, defaulting to the standard flow. 'standard' is shell-owned
// and resolves directly; an unknown id (no registry entry, or one whose
// creationStepsId is not a known flow) falls back to standard so the hub never
// crashes.
export function stepsForMode(mode: CreationMode): StepId[] {
  if (mode === 'standard') return STEPS_BY_MODE.standard
  // 'chat' is a shell-owned pseudo-type: it is not a registered workspace type
  // and has no creationStepsId, so it is resolved here (like 'standard') rather
  // than through STEPS_BY_MODE. Its pane embeds the existing AgentComposer,
  // which owns the chat's whole config and create action — no config steps.
  if (mode === 'chat') return ['workspace']
  const stepsId = getRendererHost().getWorkspaceType(mode)?.creationStepsId
  return STEPS_BY_MODE[isCreationStepsId(stepsId) ? stepsId : 'standard']
}
