import type { GuidedBriefHasUi } from '../newWorkspace/types'
import type { GuidedBriefAcceptedArtifact, GuidedBriefRuntimeState } from './types'

export type GuidedBriefHandoffChecklistItem = {
  label: string
  path: string
  hash?: string
}

export function guidedBriefBuildHandoffRelativePath(): string {
  return 'product/build-handoff.md'
}

export function guidedBriefSprintEngineGoal(handoffContent: string, hasUi: GuidedBriefHasUi): string {
  const match = handoffContent.match(/## Suggested Sprint Engine Goal\s+([\s\S]*?)(?:\n## |\s*$)/)
  const goal = match?.[1]?.trim()
  if (goal) return goal
  return hasUi === 'yes'
    ? 'Build the accepted Guided brief and UI mockups into a production-ready application.'
    : 'Build the accepted Guided brief into a production-ready script or service.'
}

export function guidedBriefHandoffChecklist(state: GuidedBriefRuntimeState): GuidedBriefHandoffChecklistItem[] {
  const items: GuidedBriefHandoffChecklistItem[] = []

  if (state.acceptedProductBrief) {
    items.push(artifactChecklistItem('Accepted brief', state.acceptedProductBrief))
  }
  if (state.acceptedProductOverview) {
    items.push(artifactChecklistItem('Product overview', state.acceptedProductOverview))
  }
  if (state.acceptedArchitecturePlan) {
    items.push(artifactChecklistItem('Architecture plan', state.acceptedArchitecturePlan))
  }
  if (state.acceptedArchitectureOverview) {
    items.push(artifactChecklistItem('Architecture overview', state.acceptedArchitectureOverview))
  }
  if (state.hasUi === 'yes' && state.acceptedUiDirection) {
    items.push(artifactChecklistItem('UI direction', state.acceptedUiDirection))
  }
  if (state.hasUi === 'yes') {
    state.acceptedMockups.forEach((mockup) => {
      items.push(artifactChecklistItem(mockup.title || 'Mockup', mockup))
    })
  }
  items.push({ label: 'Build handoff', path: guidedBriefBuildHandoffRelativePath() })

  return items
}

export function guidedBriefPlanningDecisionNotes(state: GuidedBriefRuntimeState): string[] {
  const notes = [
    state.hasUi === 'yes' ? 'Application includes a visual UI.' : 'No visual UI is required.',
  ]

  if (!state.acceptedProductBrief) {
    notes.push('Product strategy discussion was not requested or was skipped before roster selection.')
  }
  if (!state.acceptedArchitecturePlan) {
    notes.push('Architecture discussion was not requested or was skipped before roster selection.')
  }
  if (state.hasUi === 'yes' && (!state.acceptedUiDirection || state.acceptedMockups.length === 0)) {
    notes.push('Frontend design and mockup discussion was not requested or was skipped before roster selection.')
  }

  return notes
}

export function guidedBriefPlanningValidationNotes(state: GuidedBriefRuntimeState): string[] {
  const notes = ['Validate implementation against any accepted Guided brief artifact snapshot hashes.']

  if (!state.acceptedProductBrief || !state.acceptedArchitecturePlan) {
    notes.push('Resolve missing product or architecture decisions before broad implementation work.')
  }
  if (state.hasUi === 'yes' && (!state.acceptedUiDirection || state.acceptedMockups.length === 0)) {
    notes.push(
      'Create or validate UI direction during Sprint Engine planning because the guided frontend stage was skipped.',
    )
  }

  return notes
}

function artifactChecklistItem(label: string, artifact: GuidedBriefAcceptedArtifact): GuidedBriefHandoffChecklistItem {
  return {
    label,
    path: artifact.path,
    hash: artifact.hash,
  }
}
