export type LearningCategory =
  | 'workspace'
  | 'agents'
  | 'guided-brief'
  | 'sprintengine'
  | 'switchboard'
  | 'git'
  | 'knowledge'
  | 'settings'
  | 'mobile'
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
  'guided-brief': 'Design Wizard',
  sprintengine: 'Sprint',
  switchboard: 'Switchboard',
  git: 'Git',
  knowledge: 'Knowledge Graph',
  settings: 'Settings',
  mobile: 'Mobile',
  'local-safety': 'Local safety',
}
