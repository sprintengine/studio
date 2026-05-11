import type {
  SprintEngineState,
  SprintEngineWorkspaceContext,
  WorkspaceMode,
} from '../../../types/workspace'

export type CreationMode = WorkspaceMode

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

export type FolderScanResult = {
  teams: ExistingTeam[]
  plans: MarkdownPlanOption[]
}
