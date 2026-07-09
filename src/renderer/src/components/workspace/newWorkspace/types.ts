import type { ComponentType } from 'react'
import type {
  SprintEngineState,
  SprintEngineWorkspaceContext,
  WorkspaceMode,
  GuidedBriefHasUi,
} from '../../../types/workspace'

// The wizard's mode is whatever the workspace-type registry can contribute, plus
// the shell-owned 'standard'. It is open (WorkspaceMode) so the mode picker can
// surface registry-discovered ids without the bundled union gating the list.
export type CreationMode = WorkspaceMode

export type { GuidedBriefHasUi }

// What a single mode card needs to render. Sourced from the workspace-type
// registry for contributed types and from the shell for 'standard'; the card
// itself stays presentation-only.
export type ModeCardModel = {
  id: CreationMode
  label: string
  description: string
  icon: ComponentType<{ className?: string }>
}

export type MarkdownPlanOption = {
  path: string
  relativePath: string
}

export type ExistingTeam = {
  slug: string
  displayName: string
  context: SprintEngineWorkspaceContext
  state: SprintEngineState
}

export type SprintEnginePath = 'new' | 'existing' | 'plan'

/**
 * A team folder the wizard found but cannot open — today, a pre-MC-1542 run store.
 * Surfaced rather than silently skipped: a sprint that vanishes from the picker
 * with no explanation is indistinguishable from a bug.
 */
export type UnreadableTeam = {
  slug: string
  message: string
}

export type FolderScanResult = {
  teams: ExistingTeam[]
  unreadableTeams: UnreadableTeam[]
  plans: MarkdownPlanOption[]
}
