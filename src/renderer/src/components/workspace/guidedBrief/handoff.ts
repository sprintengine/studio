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
  if (state.acceptedArchitecturePlan) {
    items.push(artifactChecklistItem('Architecture plan', state.acceptedArchitecturePlan))
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

function artifactChecklistItem(label: string, artifact: GuidedBriefAcceptedArtifact): GuidedBriefHandoffChecklistItem {
  return {
    label,
    path: artifact.path,
    hash: artifact.hash,
  }
}
