import type { AgentCli } from '../../../../../shared/electron-api'
import type {
  GuidedBriefHasUi,
  GuidedBriefPreset,
  GuidedBriefStage,
  GuidedBriefAcceptedArtifact,
  GuidedBriefRecordedDecision,
  GuidedBriefRuntimeState,
} from '../../../types/workspace'
import type { GuidedInterviewDecision } from './interviewProtocol'

/**
 * Transport for a Design Wizard specialist CLI. A Claude specialist runs as a
 * conversation session only when the user has explicitly opted into the
 * experimental chat transport (`guidedBriefConversationSessions === true`) and a
 * workspace exists to host the session; every other CLI — and the default
 * profile, which ships opt-out — takes the terminal path.
 */
export function guidedBriefTransportForCli(
  cli: AgentCli,
  opts: { conversationSessionsEnabled: boolean; hasWorkspaceId: boolean },
): 'terminal' | 'conversation' {
  return opts.conversationSessionsEnabled && opts.hasWorkspaceId && cli === 'claude-code'
    ? 'conversation'
    : 'terminal'
}

export type {
  GuidedBriefHasUi,
  GuidedBriefStage,
  GuidedBriefAcceptedArtifact,
  GuidedBriefRecordedDecision,
  GuidedBriefRuntimeState,
}

/**
 * Merge a specialist session's parsed interview decisions into the persisted
 * runtime record, deduped by role + question id (latest label wins). Returns
 * the same state object when nothing changed so effect-driven callers don't
 * trigger redundant persistence.
 */
export function mergeGuidedBriefDecisions(
  state: GuidedBriefRuntimeState,
  role: GuidedBriefRecordedDecision['role'],
  decisions: GuidedInterviewDecision[],
): GuidedBriefRuntimeState {
  if (decisions.length === 0) return state
  const merged = [...(state.guidedDecisions ?? [])]
  let changed = false
  for (const decision of decisions) {
    const entry: GuidedBriefRecordedDecision = {
      role,
      id: decision.id,
      label: decision.label,
      ...(decision.question ? { question: decision.question } : {}),
    }
    const index = merged.findIndex((existing) => existing.role === role && existing.id === decision.id)
    if (index < 0) {
      merged.push(entry)
      changed = true
      continue
    }
    if (merged[index].label !== entry.label || merged[index].question !== entry.question) {
      merged[index] = entry
      changed = true
    }
  }
  return changed ? { ...state, guidedDecisions: merged } : state
}

/**
 * Returns true when the guided runtime is in a stage that holds live work
 * which would be lost on close — strategist or designer working/ready and the
 * handoff card (before Start the build actually fires the Sprint Engine
 * creation). Pre-runtime idea step has no runtime state; post-handoff success
 * tears the panel down so the helper is never asked.
 */
export function isMidStageGuidedRuntime(state: GuidedBriefRuntimeState | null): boolean {
  if (!state) return false
  switch (state.stage) {
    case 'strategist-working':
    case 'strategist-ready':
    case 'architect-working':
    case 'architect-ready':
    case 'designer-working':
    case 'designer-ready':
    case 'handoff':
      return true
    default:
      return false
  }
}

export type GuidedBriefRuntimeProgress = {
  total: number
  active: number
  done: number
}

export function guidedBriefSkipToHandoffState(
  state: GuidedBriefRuntimeState,
): GuidedBriefRuntimeState {
  return {
    ...state,
    stage: 'handoff',
    wantsProductDiscussion: Boolean(state.acceptedProductBrief),
    wantsArchitectureDiscussion: Boolean(state.acceptedArchitecturePlan),
    wantsFrontendDiscussion:
      state.hasUi === 'yes' &&
      Boolean(state.acceptedUiDirection) &&
      state.acceptedMockups.length > 0,
    strategistSessionId: null,
    architectSessionId: null,
    designerSessionId: null,
  }
}

export type GuidedBriefProgressOptions = {
  wantsProductDiscussion?: boolean
  wantsArchitectureDiscussion?: boolean
  wantsFrontendDiscussion?: boolean
  preset?: GuidedBriefPreset
}

function guidedBriefStageOrder(
  hasUi: GuidedBriefHasUi,
  options: GuidedBriefProgressOptions = {},
): GuidedBriefStage[] {
  // The design-system preset is a studio, not a pipeline: the designer stage
  // is the whole flow, and there is no Sprint Engine build tail: the bundle
  // written into the workspace's design-system/ folder is the deliverable.
  if (options.preset === 'design-system') return ['designer-working']
  const wantsProductDiscussion = options.wantsProductDiscussion ?? true
  const wantsArchitectureDiscussion = options.wantsArchitectureDiscussion ?? false
  const wantsFrontendDiscussion = options.wantsFrontendDiscussion ?? hasUi === 'yes'
  const stages: GuidedBriefStage[] = []
  if (wantsProductDiscussion) stages.push('strategist-working')
  if (wantsArchitectureDiscussion) stages.push('architect-working')
  if (hasUi === 'yes' && wantsFrontendDiscussion) stages.push('designer-working')
  stages.push('handoff')
  return stages
}

function stageFamily(stage: GuidedBriefStage): GuidedBriefStage {
  switch (stage) {
    case 'strategist-ready':
      return 'strategist-working'
    case 'architect-ready':
      return 'architect-working'
    case 'designer-ready':
      return 'designer-working'
    default:
      return stage
  }
}

type GuidedBriefStepState = 'done' | 'active' | 'upcoming'

export type GuidedBriefStepInfo = {
  /** The working-family stage this step represents (or `handoff` for Build). */
  stage: GuidedBriefStage
  label: string
  state: GuidedBriefStepState
}

const STEP_LABELS: Partial<Record<GuidedBriefStage, string>> = {
  'strategist-working': 'Strategy',
  'architect-working': 'Architecture',
  'designer-working': 'Design',
  handoff: 'Build',
}

/**
 * Labeled step rail derived from the same stage order as the progress
 * helpers, so the rail and any counters cannot drift. Steps before the
 * active family are done, the active family is active, the rest upcoming.
 */
export function guidedBriefSteps(
  stage: GuidedBriefStage,
  hasUi: GuidedBriefHasUi,
  options: GuidedBriefProgressOptions = {},
): GuidedBriefStepInfo[] {
  const order = guidedBriefStageOrder(hasUi, options)
  const family = stageFamily(stage)
  const foundIndex = order.indexOf(family)
  const activeIndex = foundIndex >= 0 ? foundIndex : order.length - 1
  return order.map((stepStage, index) => ({
    stage: stepStage,
    label:
      options.preset === 'design-system' && stepStage === 'designer-working'
        ? 'Design system'
        : STEP_LABELS[stepStage] ?? stepStage,
    state: index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'upcoming',
  }))
}

export function progressForStage(
  stage: GuidedBriefStage,
  hasUi: GuidedBriefHasUi,
  options: GuidedBriefProgressOptions = {},
): GuidedBriefRuntimeProgress {
  const order = guidedBriefStageOrder(hasUi, options)
  const total = order.length + 1
  const family = stageFamily(stage)
  const foundIndex = order.indexOf(family)
  const index = foundIndex >= 0 ? foundIndex : order.length - 1
  const active = index >= 0 ? index + 1 : order.length
  return { total, active, done: active }
}

export function stepCounterLabel(
  stage: GuidedBriefStage,
  hasUi: GuidedBriefHasUi,
  options: GuidedBriefProgressOptions = {},
): string {
  const progress = progressForStage(stage, hasUi, options)
  const step = Math.min(progress.total, progress.active + 1)
  switch (stage) {
    case 'strategist-working':
      return `Step ${step} of ${progress.total} · strategist working`
    case 'strategist-ready':
      return `Step ${step} of ${progress.total} · brief ready`
    case 'architect-working':
      return `Step ${step} of ${progress.total} · architect working`
    case 'architect-ready':
      return `Step ${step} of ${progress.total} · plan ready`
    case 'designer-working':
      return `Step ${step} of ${progress.total} · designer working`
    case 'designer-ready':
      return `Step ${step} of ${progress.total} · mockups ready`
    case 'handoff':
      return `Step ${step} of ${progress.total} · handoff`
  }
}
