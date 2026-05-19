import type {
  GuidedBriefHasUi,
  GuidedBriefStage,
  GuidedBriefAcceptedArtifact,
  GuidedBriefRuntimeState,
} from '../../../types/workspace'

export type {
  GuidedBriefHasUi,
  GuidedBriefStage,
  GuidedBriefAcceptedArtifact,
  GuidedBriefRuntimeState,
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
}

function guidedBriefStageOrder(
  hasUi: GuidedBriefHasUi,
  options: GuidedBriefProgressOptions = {},
): GuidedBriefStage[] {
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
