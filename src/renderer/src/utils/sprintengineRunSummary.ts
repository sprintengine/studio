import type {
  SprintEngineTask,
  SprintEngineTaskFeedback,
  SprintEngineTaskFeedbackFinding,
  SprintEngineTaskFeedbackIssue,
} from '../types/workspace'

export const feedbackScoreLabels: Array<{ key: keyof SprintEngineTaskFeedback['scores']; label: string }> = [
  { key: 'directiveClarityPct', label: 'Directive clarity' },
  { key: 'taskClarityPct', label: 'Task clarity' },
  { key: 'acceptanceCriteriaClarityPct', label: 'Acceptance clarity' },
  { key: 'sprintEngineToolEffectivenessPct', label: 'Sprint Engine tool' },
  { key: 'promptOptimizationPct', label: 'Prompt fit' },
  { key: 'contextFitPct', label: 'Context fit' },
  { key: 'hallucinationRiskPct', label: 'Hallucination risk' },
  { key: 'roleFitPct', label: 'Role fit' },
  { key: 'autonomyPct', label: 'Autonomy' },
  { key: 'confidencePct', label: 'Confidence' },
]

export const feedbackIssueCategoryLabels: Record<SprintEngineTaskFeedbackIssue['category'], string> = {
  system_prompt: 'System Prompt',
  role_prompt: 'Role Prompt',
  task_card: 'Task Card',
  acceptance_criteria: 'Acceptance Criteria',
  context: 'Context',
  tooling: 'Tooling',
  coordination: 'Coordination',
  validation: 'Validation',
  permissions: 'Permissions',
  ui: 'UI',
  other: 'Other',
}

export const feedbackIssueSeverityLabels: Record<SprintEngineTaskFeedbackIssue['severity'], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

export const feedbackIssueStatusLabels: Record<NonNullable<SprintEngineTaskFeedbackIssue['status']>, string> = {
  new: 'New',
  reviewed: 'Reviewed',
  applied: 'Applied',
  rejected: 'Rejected',
  deferred: 'Deferred',
}

export const feedbackFindingKindLabels: Record<SprintEngineTaskFeedbackFinding['kind'], string> = {
  code_bug: 'Code Bug',
  security_issue: 'Security Issue',
  product_requirement_violation: 'Requirement Violation',
  test_gap: 'Test Gap',
  accessibility_issue: 'Accessibility Issue',
  performance_issue: 'Performance Issue',
  reliability_issue: 'Reliability Issue',
  documentation_gap: 'Documentation Gap',
  other: 'Other',
}

export const feedbackFindingSeverityLabels: Record<SprintEngineTaskFeedbackFinding['severity'], string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

export const feedbackFindingAreaLabels: Record<SprintEngineTaskFeedbackFinding['area'], string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  database: 'Database',
  networking: 'Networking',
  auth: 'Auth',
  security: 'Security',
  filesystem: 'Filesystem',
  cli: 'CLI',
  ipc: 'IPC',
  mobile: 'Mobile',
  testing: 'Testing',
  performance: 'Performance',
  docs: 'Docs',
  product: 'Product',
  other: 'Other',
}

export const feedbackFindingStatusLabels: Record<NonNullable<SprintEngineTaskFeedbackFinding['status']>, string> = {
  open: 'Open',
  accepted: 'Accepted',
  fixed: 'Fixed',
  rejected: 'Rejected',
  deferred: 'Deferred',
}

export type SprintEngineRunSummary = {
  totalTasks: number
  completedTasks: number
  touchedFiles: string[]
  commandsRan: string[]
  results: string[]
  taskSummaries: string[]
  feedbackSummaries: string[]
  promptImprovementSignals: string[]
  findingSummaries: string[]
  openQuestions: string[]
}

export function buildRunSummary(tasks: SprintEngineTask[]): SprintEngineRunSummary {
  const completed = tasks.filter((task) => task.status === 'done')
  const touchedFiles = uniqueStrings(completed.flatMap((task) => task.evidence.touchedFiles))
  const commandsRan = uniqueStrings(completed.flatMap((task) => task.evidence.commandsRan))
  const results = completed.flatMap((task) =>
    task.evidence.results.map((result) => `${task.id}: ${result}`)
  )
  const taskSummaries = completed.map((task) => {
    const summary = task.evidence.summary.trim() || 'No completion summary recorded.'
    return `${task.id} - ${task.title}: ${summary}`
  })
  const feedbackSummaries = buildFeedbackSummary(completed)
  const promptImprovementSignals = buildFeedbackIssueSummary(completed)
  const findingSummaries = buildFeedbackFindingSummary(completed)
  const openQuestions = tasks.flatMap((task) =>
    task.notes.map((note) => `${task.id}: ${note}`)
  )

  return {
    totalTasks: tasks.length,
    completedTasks: completed.length,
    touchedFiles,
    commandsRan,
    results,
    taskSummaries,
    feedbackSummaries,
    promptImprovementSignals,
    findingSummaries,
    openQuestions,
  }
}

export function formatSprintEngineGoal(goal: string): string {
  const trimmed = goal.trim()
  if (!trimmed || trimmed.toLowerCase() === 'launch Sprint Engine mode') {
    return 'Untitled sprintengine run'
  }
  return trimmed
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function buildFeedbackSummary(tasks: SprintEngineTask[]): string[] {
  const feedbackTasks = tasks.filter((task) => task.feedback)
  if (feedbackTasks.length === 0) return []

  return feedbackScoreLabels.flatMap((metric) => {
    const values = feedbackTasks.flatMap((task) => {
      const value = task.feedback?.scores[metric.key]
      return typeof value === 'number' ? [value] : []
    })
    if (values.length === 0) return []
    const average = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    return [`${metric.label}: ${average}% avg across ${values.length} task${values.length === 1 ? '' : 's'}`]
  })
}

function buildFeedbackIssueSummary(tasks: SprintEngineTask[]): string[] {
  return tasks.flatMap((task) =>
    (task.feedback?.issues ?? []).map((issue) => {
      const parts = [
        `${task.id}: ${feedbackIssueSeverityLabels[issue.severity]} ${feedbackIssueCategoryLabels[issue.category]}`,
        issue.target ? `target ${issue.target}` : null,
        issue.title,
        issue.suggestedPromptChange ? `Prompt: ${issue.suggestedPromptChange}` : null,
        issue.suggestedProcessChange ? `Process: ${issue.suggestedProcessChange}` : null,
      ].filter(Boolean)
      return parts.join(' - ')
    })
  )
}

function buildFeedbackFindingSummary(tasks: SprintEngineTask[]): string[] {
  const findings = tasks.flatMap((task) =>
    (task.feedback?.findings ?? []).map((finding) => ({ task, finding }))
  )
  if (findings.length === 0) return []
  const findingRows = findings.map(({ finding }) => finding)

  const total = findings.length
  const severitySummary = summarizeFindingCounts(
    findingRows,
    ['critical', 'high', 'medium', 'low'],
    (finding) => finding.severity,
    feedbackFindingSeverityLabels
  )
  const kindSummary = summarizeFindingCounts(
    findingRows,
    [
      'code_bug',
      'security_issue',
      'product_requirement_violation',
      'test_gap',
      'accessibility_issue',
      'performance_issue',
      'reliability_issue',
      'documentation_gap',
      'other',
    ],
    (finding) => finding.kind,
    feedbackFindingKindLabels
  )
  const areaSummary = summarizeFindingCounts(
    findingRows,
    [
      'frontend',
      'backend',
      'database',
      'networking',
      'auth',
      'security',
      'filesystem',
      'cli',
      'ipc',
      'mobile',
      'testing',
      'docs',
      'product',
      'other',
    ],
    (finding) => finding.area,
    feedbackFindingAreaLabels
  )
  const details = findings.map(({ task, finding }) =>
    `${task.id}: ${feedbackFindingSeverityLabels[finding.severity]} ${feedbackFindingKindLabels[finding.kind]} in ${feedbackFindingAreaLabels[finding.area]} - ${finding.title}`
  )

  return [
    `${total} finding${total === 1 ? '' : 's'} reported`,
    ...(severitySummary ? [`By severity: ${severitySummary}`] : []),
    ...(kindSummary ? [`By type: ${kindSummary}`] : []),
    ...(areaSummary ? [`By area: ${areaSummary}`] : []),
    ...details,
  ]
}

function summarizeFindingCounts<T extends string>(
  findings: SprintEngineTaskFeedbackFinding[],
  order: readonly T[],
  getValue: (finding: SprintEngineTaskFeedbackFinding) => T,
  labels: Record<T, string>
): string {
  const counts = new Map<T, number>()
  for (const finding of findings) {
    const value = getValue(finding)
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return order.flatMap((key) => {
    const count = counts.get(key) ?? 0
    return count > 0 ? [`${labels[key]} ${count}`] : []
  }).join(', ')
}
