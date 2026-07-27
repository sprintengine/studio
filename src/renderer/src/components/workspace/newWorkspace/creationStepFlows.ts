import { getRendererHost } from '../../../modules'
import type { CreationMode } from './types'

// Config-step ids for the creation hub. A flow is an ordered list of PAGES: the
// hub shows one step at a time — the shared name/folder fields ('workspace')
// first, then the flow's config steps — with a Continue footer between them, so
// the order here is the order the user walks.
//
// Every flow is shaped: 'workspace' (always required — you must pick a folder),
// then AT MOST ONE required-intent step, then only defaulted refinement steps.
// The intent steps are 'guided-idea' and 'sprintengine-team':
// they carry something only the user knows, so they are never defaulted (a sprint
// with an auto-generated objective is worse than one that asks). Everything after
// them is seeded with a working default, which is what lets the footer offer
// "Skip the rest and create" the moment the intent step is answered. Adding a new
// step that cannot be defaulted breaks that promise — put it before the
// refinement steps, and expect the skip affordance to disappear until it is
// answered.
//
// The historic 'mode' pivot step is gone: the hub's rail IS the type choice, and
// picking a type is never a step.
export type StepId =
  | 'workspace'
  | 'mcp-servers'
  | 'skill-packs'
  | 'knowledge'
  | 'standard-layout'
  | 'sprintengine-team'
  | 'sprintengine-roster'
  | 'sprintengine-tools'
  | 'sprintengine-start'
  | 'guided-idea'
  | 'review-source'

// The hub's flows are keyed by a closed set of flow ids. A registered workspace
// type points at one of these via its creationStepsId; 'standard' is the
// shell-owned default and the fallback for any mode whose registry entry is
// missing or names an unknown flow.
export type CreationStepsId = 'standard' | 'switchboard' | 'automations' | 'sprintengine' | 'guided-brief' | 'review'

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
  // The sprint's team page carries the only required intent (an objective, or a
  // backlog item / plan file / existing team). Everything after it — the team
  // roster, the optional tools & skills, and the final review-&-start summary —
  // is fully defaulted, so each pages separately and all of them sit behind
  // "Skip the rest and create" (MC-1646: one reading column per page, no
  // settings dump).
  sprintengine: [
    'workspace',
    'sprintengine-team',
    'sprintengine-roster',
    'sprintengine-tools',
    'sprintengine-start',
  ],
  // Name/folder, then the single required-intent step: what are you reviewing?
  // Everything after it (knowledge graph, guide, depth) is defaulted, so the
  // footer offers "Skip the rest and create" as soon as a source resolves.
  review: ['workspace', 'review-source'],
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
  const definition = getRendererHost().getWorkspaceType(mode)
  const stepsId = definition?.creationStepsId
  if (isCreationStepsId(stepsId)) return STEPS_BY_MODE[stepsId]
  // A registered type with no shell flow (module-contributed types) ships its
  // own createTemplate(): zero-config like switchboard — showing the standard
  // layout picker would override the type's template with an IDE layout.
  if (definition) return ['workspace']
  return STEPS_BY_MODE.standard
}
