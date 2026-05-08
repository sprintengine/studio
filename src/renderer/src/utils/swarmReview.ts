import type {
  AgentCli,
  AgentId,
  SpecialistActionId,
  SwarmReviewAgent,
  SwarmReviewSectorId,
  SwarmReviewWorkspaceState,
} from '../types/workspace'

export type SwarmReviewSector = {
  id: SwarmReviewSectorId
  label: string
  reportFile: string
  description: string
}

export type SwarmReviewPresetId = 'lean_code_review' | 'security_deep_review' | 'full_product_review' | 'custom'

export type SwarmReviewPreset = {
  id: SwarmReviewPresetId
  label: string
  description: string
  agents: Partial<Record<SpecialistActionId, SwarmReviewSectorId[]>>
}

export const SWARM_REVIEW_SECTORS: SwarmReviewSector[] = [
  { id: 'code_review', label: 'Code Review', reportFile: 'code-review.md', description: 'Bugs, regressions, maintainability, unsafe assumptions, and missing tests.' },
  { id: 'ai_slop', label: 'AI Slop', reportFile: 'ai-slop.md', description: 'Generic boilerplate, fake affordances, hallucinated APIs, dead UI, and shallow abstractions.' },
  { id: 'architecture_quality', label: 'Architecture', reportFile: 'architecture-quality.md', description: 'Boundaries, state ownership, data flow, dependency direction, and migration safety.' },
  { id: 'frontend_design', label: 'Frontend Design', reportFile: 'frontend-design.md', description: 'Layout, hierarchy, interaction states, responsiveness, and visual polish.' },
  { id: 'cross_platform', label: 'Cross Platform', reportFile: 'cross-platform.md', description: 'Windows, macOS, Linux, shell, path, packaging, and WSL assumptions.' },
  { id: 'brand_alignment', label: 'Brand Alignment', reportFile: 'brand-alignment.md', description: 'Multicode tone, product naming, dark-native command-center aesthetic, copy, and palette discipline.' },
  { id: 'security', label: 'Security', reportFile: 'security.md', description: 'Trust boundaries, command execution, filesystem access, IPC, auth, secrets, and unsafe defaults.' },
  { id: 'performance', label: 'Performance', reportFile: 'performance.md', description: 'Startup, render churn, terminal scaling, scans, memory growth, bundle size, and polling.' },
  { id: 'qa_testing', label: 'QA Testing', reportFile: 'qa-testing.md', description: 'Coverage, release readiness, fixtures, edge cases, and regression risk.' },
  { id: 'infrastructure', label: 'Infrastructure', reportFile: 'infrastructure.md', description: 'Packaging, CI, diagnostics, logging, updates, observability, and environment assumptions.' },
  { id: 'product_strategy', label: 'Product Strategy', reportFile: 'product-strategy.md', description: 'Workflow clarity, user value, prioritization, scope fit, and operator confusion.' },
  { id: 'accessibility', label: 'Accessibility', reportFile: 'accessibility.md', description: 'Focus, labels, keyboard navigation, semantic structure, contrast, and reduced motion.' },
  { id: 'documentation', label: 'Documentation', reportFile: 'documentation.md', description: 'User docs, setup docs, command examples, stale docs, and handoff quality.' },
]

const sectorById = new Map(SWARM_REVIEW_SECTORS.map((sector) => [sector.id, sector]))

export const SWARM_REVIEW_SPECIALIST_FOCUS: Record<SpecialistActionId, SwarmReviewSectorId[]> = {
  architect: ['architecture_quality', 'code_review', 'documentation'],
  'product-strategist': ['product_strategy', 'brand_alignment', 'documentation'],
  developer: ['code_review', 'architecture_quality', 'performance', 'documentation'],
  'devops-infra': ['infrastructure', 'cross_platform', 'performance', 'documentation'],
  performance: ['performance', 'cross_platform'],
  'qa-test': ['qa_testing', 'cross_platform', 'accessibility', 'documentation'],
  'security-review': ['security'],
  'frontend-design-review': ['frontend_design', 'accessibility', 'brand_alignment', 'cross_platform'],
  'code-review': ['code_review', 'ai_slop', 'architecture_quality', 'documentation'],
}

export const SWARM_REVIEW_PRESETS: SwarmReviewPreset[] = [
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

export function getSwarmReviewSector(id: SwarmReviewSectorId): SwarmReviewSector {
  return sectorById.get(id) ?? SWARM_REVIEW_SECTORS[0]
}

export function sectorLabel(id: SwarmReviewSectorId): string {
  return getSwarmReviewSector(id).label
}

export function focusSectorsForSpecialist(specialistId: SpecialistActionId): SwarmReviewSectorId[] {
  return SWARM_REVIEW_SPECIALIST_FOCUS[specialistId] ?? []
}

export function focusReviewSectorsForSpecialist(specialistId: SpecialistActionId): SwarmReviewSector[] {
  return focusSectorsForSpecialist(specialistId).map(getSwarmReviewSector)
}

export function defaultSectorsForSpecialist(specialistId: SpecialistActionId): SwarmReviewSectorId[] {
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
    case 'code-review':
      return ['code_review', 'ai_slop']
  }
}

export function normalizeSwarmReviewSectorsForSpecialist(
  specialistId: SpecialistActionId,
  input: unknown
): SwarmReviewSectorId[] {
  const allowed = new Set(focusSectorsForSpecialist(specialistId))
  const sectors = normalizeSwarmReviewSectors(input).filter((sector) => allowed.has(sector))
  return sectors.length > 0 ? sectors : defaultSectorsForSpecialist(specialistId)
}

export function slugifySwarmReviewName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'swarm-review'
}

function pathSeparatorFor(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

function joinPath(parent: string, child: string): string {
  const separator = pathSeparatorFor(parent)
  return `${parent}${parent.endsWith(separator) ? '' : separator}${child}`
}

export function buildSwarmReviewOutputDirectory(folderPath: string, runId: string): string {
  return joinPath(joinPath(joinPath(folderPath, '.multi-code'), 'swarm-reviews'), runId)
}

export function buildSwarmReviewReportPath(outputDirectory: string, sectors: SwarmReviewSectorId[]): string {
  const firstSector = sectors[0] ? getSwarmReviewSector(sectors[0]) : SWARM_REVIEW_SECTORS[0]
  return joinPath(outputDirectory, firstSector.reportFile)
}

export function createSwarmReviewRunId(name: string, now = new Date()): string {
  const date = now.toISOString().slice(0, 10)
  return `${date}-${slugifySwarmReviewName(name)}`
}

export function createSwarmReviewState(input: {
  name: string
  objective: string
  folderPath: string
  selectedAgents: Array<{
    specialistId: SpecialistActionId
    sectors: SwarmReviewSectorId[]
    cli: AgentCli
  }>
  now?: Date
}): SwarmReviewWorkspaceState {
  const name = input.name.trim() || 'Swarm Review'
  const runId = createSwarmReviewRunId(name, input.now)
  const outputDirectory = buildSwarmReviewOutputDirectory(input.folderPath, runId)
  const agents: SwarmReviewAgent[] = input.selectedAgents.map((agent) => {
    const sectors = normalizeSwarmReviewSectorsForSpecialist(agent.specialistId, agent.sectors)
    const agentId = `swarm-review-${agent.specialistId}`
    return {
      agentId,
      specialistId: agent.specialistId,
      sectors,
      status: 'ready',
      reportPath: buildSwarmReviewReportPath(outputDirectory, sectors),
      cli: agent.cli,
    }
  })

  return {
    schemaVersion: 1,
    runId,
    name,
    objective: input.objective.trim(),
    createdAt: (input.now ?? new Date()).toISOString(),
    status: 'ready',
    outputDirectory,
    agents,
  }
}

export function normalizeSwarmReviewSectors(input: unknown): SwarmReviewSectorId[] {
  const values = Array.isArray(input) ? input : []
  const sectors = values.filter((value): value is SwarmReviewSectorId =>
    typeof value === 'string' && sectorById.has(value as SwarmReviewSectorId)
  )
  return [...new Set(sectors)]
}

function normalizeAgent(input: Partial<SwarmReviewAgent> | undefined, outputDirectory: string): SwarmReviewAgent | null {
  if (!input?.agentId || !input.specialistId) return null
  const normalizedSectors = normalizeSwarmReviewSectorsForSpecialist(input.specialistId, input.sectors)
  return {
    agentId: input.agentId,
    specialistId: input.specialistId,
    sectors: normalizedSectors,
    status: input.status === 'running' || input.status === 'done' || input.status === 'needs_input' || input.status === 'error'
      ? input.status
      : 'ready',
    reportPath: input.reportPath || buildSwarmReviewReportPath(outputDirectory, normalizedSectors),
    cli: input.cli === 'claude' ? 'claude' : input.cli === 'codex' ? 'codex' : undefined,
  }
}

export function normalizeSwarmReviewState(input: Partial<SwarmReviewWorkspaceState> | null | undefined): SwarmReviewWorkspaceState | null {
  if (!input?.runId || !input.name || !input.outputDirectory) return null
  const status = input.status === 'draft' || input.status === 'running' || input.status === 'complete'
    ? input.status
    : 'ready'
  const agents = (Array.isArray(input.agents) ? input.agents : [])
    .map((agent) => normalizeAgent(agent, input.outputDirectory ?? ''))
    .filter((agent): agent is SwarmReviewAgent => Boolean(agent))
  return {
    schemaVersion: 1,
    runId: input.runId,
    name: input.name,
    objective: input.objective ?? '',
    createdAt: input.createdAt ?? new Date().toISOString(),
    status,
    outputDirectory: input.outputDirectory,
    agents,
  }
}

export function getSwarmReviewAgentLabel(agentId: AgentId, fallback: string): string {
  return fallback || agentId
}
