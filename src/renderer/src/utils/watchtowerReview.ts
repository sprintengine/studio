import type {
  SpecialistActionId,
  WatchtowerReviewSectorId,
} from '../types/workspace'

export type WatchtowerReviewSector = {
  id: WatchtowerReviewSectorId
  label: string
  reportFile: string
  description: string
}

export type WatchtowerReviewPresetId =
  | 'lean_code_review'
  | 'ui_brand_alignment_review'
  | 'performance_focused_review'
  | 'security_deep_review'
  | 'full_product_review'
  | 'custom'

export type WatchtowerReviewPreset = {
  id: WatchtowerReviewPresetId
  label: string
  description: string
  agents: Partial<Record<SpecialistActionId, WatchtowerReviewSectorId[]>>
}

export const WATCHTOWER_REVIEW_SECTORS: WatchtowerReviewSector[] = [
  { id: 'code_review', label: 'Code Review', reportFile: 'code-review.md', description: 'Bugs, regressions, maintainability, unsafe assumptions, and missing tests.' },
  { id: 'ai_slop', label: 'AI Slop', reportFile: 'ai-slop.md', description: 'Generic boilerplate, fake affordances, hallucinated APIs, dead UI, and shallow abstractions.' },
  { id: 'architecture_quality', label: 'Architecture', reportFile: 'architecture-quality.md', description: 'Boundaries, state ownership, data flow, dependency direction, and migration safety.' },
  { id: 'frontend_design', label: 'Frontend Design', reportFile: 'frontend-design.md', description: 'Layout, hierarchy, interaction states, responsiveness, and visual polish.' },
  { id: 'cross_platform', label: 'Cross Platform', reportFile: 'cross-platform.md', description: 'Windows, macOS, Linux, shell, path, packaging, and WSL assumptions.' },
  { id: 'brand_alignment', label: 'Brand Alignment', reportFile: 'brand-alignment.md', description: 'Knowledge-graph brand guidance, UI surfaces, modals, panels, product naming, copy, palette discipline, and consistency with adjacent product surfaces.' },
  { id: 'security', label: 'Security', reportFile: 'security.md', description: 'Trust boundaries, command execution, filesystem access, IPC, auth, secrets, and unsafe defaults.' },
  { id: 'performance', label: 'Performance', reportFile: 'performance.md', description: 'Startup, render churn, terminal scaling, scans, memory growth, bundle size, and polling.' },
  { id: 'qa_testing', label: 'QA Testing', reportFile: 'qa-testing.md', description: 'Coverage, release readiness, fixtures, edge cases, and regression risk.' },
  { id: 'infrastructure', label: 'Infrastructure', reportFile: 'infrastructure.md', description: 'Packaging, CI, diagnostics, logging, updates, observability, and environment assumptions.' },
  { id: 'product_strategy', label: 'Product Strategy', reportFile: 'product-strategy.md', description: 'Workflow clarity, user value, prioritization, scope fit, and operator confusion.' },
  { id: 'accessibility', label: 'Accessibility', reportFile: 'accessibility.md', description: 'Focus, labels, keyboard navigation, semantic structure, contrast, and reduced motion.' },
  { id: 'documentation', label: 'Documentation', reportFile: 'documentation.md', description: 'User docs, setup docs, command examples, stale docs, and handoff quality.' },
]

const sectorById = new Map(WATCHTOWER_REVIEW_SECTORS.map((sector) => [sector.id, sector]))

export const WATCHTOWER_REVIEW_SPECIALIST_FOCUS: Record<SpecialistActionId, WatchtowerReviewSectorId[]> = {
  architect: ['architecture_quality', 'code_review', 'documentation'],
  'product-strategist': ['product_strategy', 'brand_alignment', 'documentation'],
  developer: ['code_review', 'architecture_quality', 'performance', 'documentation'],
  'devops-infra': ['infrastructure', 'cross_platform', 'performance', 'documentation'],
  performance: ['performance', 'cross_platform'],
  'qa-test': ['qa_testing', 'cross_platform', 'accessibility', 'documentation'],
  'security-review': ['security'],
  'frontend-design-review': ['frontend_design', 'accessibility', 'brand_alignment', 'cross_platform'],
  'blog-writer': ['documentation', 'brand_alignment'],
  'code-review': ['code_review', 'ai_slop', 'architecture_quality', 'documentation'],
}

export const WATCHTOWER_REVIEW_PRESETS: WatchtowerReviewPreset[] = [
  {
    id: 'lean_code_review',
    label: 'Lean Code Review',
    description: 'Fast quality pass for code, tests, and performance risk.',
    agents: {
      'code-review': ['code_review', 'ai_slop'],
      'qa-test': ['qa_testing'],
      performance: ['performance'],
    },
  },
  {
    id: 'ui_brand_alignment_review',
    label: 'UI & Brand Alignment',
    description: 'Focused sweep of panels, modals, UI states, copy, and visual treatment against the knowledge-graph brand guidance.',
    agents: {
      'frontend-design-review': ['frontend_design', 'brand_alignment', 'accessibility', 'cross_platform'],
      'product-strategist': ['brand_alignment', 'product_strategy'],
      'code-review': ['ai_slop'],
    },
  },
  {
    id: 'performance_focused_review',
    label: 'Performance Focus Review',
    description: 'Performance-led review of code, infrastructure, runtime behavior, and regression risk.',
    agents: {
      performance: ['performance', 'cross_platform'],
      'devops-infra': ['infrastructure', 'performance', 'cross_platform'],
      'code-review': ['code_review', 'architecture_quality'],
      'qa-test': ['qa_testing'],
    },
  },
  {
    id: 'security_deep_review',
    label: 'Security Deep Review',
    description: 'Security-led review with quality and test coverage support.',
    agents: {
      'security-review': ['security'],
      'code-review': ['ai_slop', 'code_review'],
      'qa-test': ['qa_testing'],
    },
  },
  {
    id: 'full_product_review',
    label: 'Full Product Review',
    description: 'Broad product, UI, quality, security, performance, and operations review.',
    agents: {
      'product-strategist': ['product_strategy'],
      'frontend-design-review': ['frontend_design', 'accessibility', 'brand_alignment'],
      'qa-test': ['qa_testing', 'cross_platform'],
      'security-review': ['security'],
      performance: ['performance'],
      'code-review': ['code_review', 'ai_slop', 'architecture_quality'],
      'devops-infra': ['infrastructure'],
    },
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Choose specialists and review sectors manually.',
    agents: {},
  },
]

export function getWatchtowerReviewSector(id: WatchtowerReviewSectorId): WatchtowerReviewSector {
  return sectorById.get(id) ?? WATCHTOWER_REVIEW_SECTORS[0]
}

export function sectorLabel(id: WatchtowerReviewSectorId): string {
  return getWatchtowerReviewSector(id).label
}

export function focusSectorsForSpecialist(specialistId: SpecialistActionId): WatchtowerReviewSectorId[] {
  return WATCHTOWER_REVIEW_SPECIALIST_FOCUS[specialistId] ?? []
}

export function focusReviewSectorsForSpecialist(specialistId: SpecialistActionId): WatchtowerReviewSector[] {
  return focusSectorsForSpecialist(specialistId).map(getWatchtowerReviewSector)
}

export function defaultSectorsForSpecialist(specialistId: SpecialistActionId): WatchtowerReviewSectorId[] {
  switch (specialistId) {
    case 'architect':
      return ['architecture_quality', 'code_review']
    case 'product-strategist':
      return ['product_strategy']
    case 'developer':
      return ['code_review', 'architecture_quality']
    case 'devops-infra':
      return ['infrastructure', 'cross_platform']
    case 'performance':
      return ['performance']
    case 'qa-test':
      return ['qa_testing', 'cross_platform']
    case 'security-review':
      return ['security']
    case 'frontend-design-review':
      return ['frontend_design', 'accessibility', 'brand_alignment']
    case 'blog-writer':
      return ['documentation', 'brand_alignment']
    case 'code-review':
      return ['code_review', 'ai_slop']
  }
}


export function normalizeWatchtowerReviewSectors(input: unknown): WatchtowerReviewSectorId[] {
  const values = Array.isArray(input) ? input : []
  const sectors = values.filter((value): value is WatchtowerReviewSectorId =>
    typeof value === 'string' && sectorById.has(value as WatchtowerReviewSectorId)
  )
  return [...new Set(sectors)]
}

export function normalizeWatchtowerReviewSectorsForSpecialist(
  specialistId: SpecialistActionId,
  input: unknown
): WatchtowerReviewSectorId[] {
  const allowed = new Set(focusSectorsForSpecialist(specialistId))
  const sectors = normalizeWatchtowerReviewSectors(input).filter((sector) => allowed.has(sector))
  return sectors.length > 0 ? sectors : defaultSectorsForSpecialist(specialistId)
}
