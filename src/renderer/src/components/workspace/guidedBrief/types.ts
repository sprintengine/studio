import type { GuidedBriefHasUi } from '../newWorkspace/types'

export type GuidedBriefStage =
  | 'strategist-working'
  | 'strategist-ready'
  | 'designer-working'
  | 'designer-ready'
  | 'handoff'

export type GuidedBriefAcceptedArtifact = {
  kind: 'product' | 'mockup'
  title: string
  hash: string
  path: string
}

export type GuidedBriefRuntimeState = {
  workspaceRoot: string
  workspaceName: string
  idea: string
  hasUi: GuidedBriefHasUi
  stage: GuidedBriefStage
  acceptedProductBrief: GuidedBriefAcceptedArtifact | null
  acceptedUiDirection: GuidedBriefAcceptedArtifact | null
  acceptedMockups: GuidedBriefAcceptedArtifact[]
  activeMockupPath: string | null
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

export function progressForStage(
  stage: GuidedBriefStage,
  hasUi: GuidedBriefHasUi,
): GuidedBriefRuntimeProgress {
  const total = hasUi === 'yes' ? 4 : 3
  if (hasUi === 'yes') {
    switch (stage) {
      case 'strategist-working':
        return { total, active: 1, done: 1 }
      case 'strategist-ready':
        return { total, active: 1, done: 1 }
      case 'designer-working':
      case 'designer-ready':
        return { total, active: 2, done: 2 }
      case 'handoff':
        return { total, active: 3, done: 3 }
    }
  }
  switch (stage) {
    case 'strategist-working':
    case 'strategist-ready':
      return { total, active: 1, done: 1 }
    case 'designer-working':
    case 'designer-ready':
    case 'handoff':
      return { total, active: 2, done: 2 }
  }
}

export function stepCounterLabel(stage: GuidedBriefStage, hasUi: GuidedBriefHasUi): string {
  const progress = progressForStage(stage, hasUi)
  const step = Math.min(progress.total, progress.active + 1)
  switch (stage) {
    case 'strategist-working':
      return `Step ${step} of ${progress.total} · strategist working`
    case 'strategist-ready':
      return `Step ${step} of ${progress.total} · brief ready`
    case 'designer-working':
      return `Step ${step} of ${progress.total} · designer working`
    case 'designer-ready':
      return `Step ${step} of ${progress.total} · mockups ready`
    case 'handoff':
      return `Step ${step} of ${progress.total} · handoff`
  }
}
