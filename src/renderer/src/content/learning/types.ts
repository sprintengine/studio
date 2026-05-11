export type LearningCategory =
  | 'workspace'
  | 'agents'
  | 'sprintengine'
  | 'switchboard'
  | 'knowledge'
  | 'local-safety'

export type LearningDifficulty = 'basic' | 'intermediate' | 'advanced'

export type LearningMedia = {
  type: 'image' | 'gif' | 'video'
  src: string
  posterSrc?: string
  alt: string
}

export type LearningActionKind = 'open-learn-center' | 'open-settings-tab' | 'open-url'

export type LearningAction = {
  label: string
  kind: LearningActionKind
  args?: Record<string, string>
}

export type LearningContextRule = {
  kind:
    | 'workspace-mode'
    | 'has-terminal'
    | 'has-sprintengine-state'
    | 'has-knowledge-root'
    | 'has-switchboard-state'
  value?: string | boolean
}

export type LearningItem = {
  id: string
  title: string
  summary: string
  category: LearningCategory
  difficulty: LearningDifficulty
  body?: string
  media?: LearningMedia
  action?: LearningAction
  showWhen?: LearningContextRule[]
}

export const LEARNING_CATEGORY_LABELS: Record<LearningCategory, string> = {
  workspace: 'Workspaces',
  agents: 'Agents',
  sprintengine: 'Sprint Engine',
  switchboard: 'Switchboard',
  knowledge: 'Knowledge Graph',
  'local-safety': 'Local safety',
}
