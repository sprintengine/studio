export type LearningCategory =
  | 'workspace'
  | 'agents'
  | 'sprintengine'
  | 'git'
  | 'knowledge'
  | 'settings'
  | 'mobile'
  | 'local-safety'

type LearningDifficulty = 'basic' | 'intermediate' | 'advanced'

type LearningMedia = {
  type: 'image' | 'gif' | 'video'
  src: string
  posterSrc?: string
  alt: string
}

type LearningActionKind = 'open-learn-center' | 'open-settings-tab' | 'open-url'

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
  sprintengine: 'Sprint',
  git: 'Git',
  knowledge: 'Knowledge Graph',
  settings: 'Settings',
  mobile: 'Mobile',
  'local-safety': 'Local safety',
}
