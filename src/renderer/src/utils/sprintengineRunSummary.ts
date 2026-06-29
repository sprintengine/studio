import type {
  SprintEngineAgentMetrics,
  SprintEngineRoleId,
  SprintEngineRuntimeAgent,
  SprintEngineRuntimeAgentStatus,
  SprintEngineState,
  SprintEngineTask,
  SprintEngineTaskFeedback,
  SprintEngineTaskFeedbackFinding,
  SprintEngineTaskFeedbackFindingSeverity,
  SprintEngineTaskFeedbackIssue,
  SprintEngineTaskFeedbackScores,
  SprintEngineTaskStatus,
  SprintEngineTokenUsage,
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
  // Sprint-level per-model token total + coverage (Phase 1). Computed in the
  // main process from the durable ledger (it reads CLI transcripts/servers), so
  // it is threaded in by the caller rather than derived from `tasks` here.
  // Absent until the main aggregator has produced it for the run.
  tokenUsage?: SprintEngineTokenUsage
}

export function buildRunSummary(
  tasks: SprintEngineTask[],
  tokenUsage?: SprintEngineTokenUsage,
): SprintEngineRunSummary {
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
    ...(tokenUsage ? { tokenUsage } : {}),
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
    `${task.id}: ${feedbackFindingSeverityLabels[finding.severity]} ${feedbackFindingKindLabels[finding.kind]} in ${feedbackFindingAreaLabels[finding.area]} - ${feedbackFindingTitle(finding)}`
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

// ---------------------------------------------------------------------------
// Structured run report for the rebuilt run-summary panel. The panel renders
// this directly; all feedback-derived per-agent numbers come from the analysis
// payload (single source of truth), while structural data (roster, task counts,
// statuses, durations) is derived from local state here.
// ---------------------------------------------------------------------------

export const findingSeverityOrder: SprintEngineTaskFeedbackFindingSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
]

const agentRoleOrder: SprintEngineRoleId[] = [
  'architect',
  'product',
  'developer',
  'frontend',
  'tester',
  'security',
  'code_reviewer',
  'nuclear_reviewer',
  'spec_reviewer',
  'performance',
  'cross_platform',
]

export type SprintEngineRunFinding = {
  id: string
  taskId: string
  severity: SprintEngineTaskFeedbackFindingSeverity
  kind: SprintEngineTaskFeedbackFinding['kind']
  area: SprintEngineTaskFeedbackFinding['area']
  title: string
  detail: string
  recommendation?: string
  file?: string | null
  status?: SprintEngineTaskFeedbackFinding['status']
  fromReview: boolean
}

export type SprintEngineAgentRow = {
  agentId: string
  role: SprintEngineRoleId
  status: SprintEngineRuntimeAgentStatus | 'idle'
  tasksDone: number
  /** Null when the agent has no recorded feedback (renders as "—"). */
  metrics: SprintEngineAgentMetrics | null
}

/** Run-wide quality roll-up shown as a summary strip at the top. Robust to
 *  per-agent attribution drift: these are run totals/averages regardless of
 *  which agent id a record landed on. */
export type SprintEngineRunQuality = {
  confidencePct: number | null
  hallucinationRiskPct: number | null
  hallucinationRatePct: number | null
  bugs: number
  regressions: number
  missedReqs: number
  hasSelfReported: boolean
  hasMeasured: boolean
}

export type SprintEngineRunReport = {
  totalTasks: number
  doneTasks: number
  statusCounts: Partial<Record<SprintEngineTaskStatus, number>>
  runDurationMs: number | null
  quality: SprintEngineRunQuality
  needsInput: Array<{ taskId: string; role: SprintEngineRoleId; reason: string }>
  openQuestions: Array<{ taskId: string; note: string }>
  remaining: Array<{
    id: string
    title: string
    status: SprintEngineTaskStatus
    role: SprintEngineRoleId
  }>
  findings: SprintEngineRunFinding[]
  findingSeverityCounts: Record<SprintEngineTaskFeedbackFindingSeverity, number>
  metrics: {
    filesTouched: number
    commands: number
    validations: number
    findings: number
    gatesApproved: number
    gatesTotal: number
  }
  agentRows: SprintEngineAgentRow[]
}

function parseTimestampMs(value?: string | null): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

export function computeRunDurationMs(state: SprintEngineState): number | null {
  const starts: number[] = []
  const ends: number[] = []
  const created = parseTimestampMs(state.creation?.createdAt)
  const updated = parseTimestampMs(state.creation?.updatedAt)
  if (created !== null) starts.push(created)
  if (updated !== null) ends.push(updated)
  for (const task of state.tasks) {
    const started = parseTimestampMs(task.startedAt)
    if (started !== null) starts.push(started)
    const completed = parseTimestampMs(task.completedAt)
    if (completed !== null) ends.push(completed)
  }
  if (starts.length === 0 || ends.length === 0) return null
  const duration = Math.max(...ends) - Math.min(...starts)
  return duration > 0 ? duration : null
}

export type SprintEngineBurnupPoint = { atMs: number; done: number }
export type SprintEngineBurnup = {
  points: SprintEngineBurnupPoint[]
  startMs: number
  endMs: number
  total: number
}

/** Cumulative completed-task series across the run, for the burn-up chart.
 *  Returns null when there aren't enough real timestamps to plot honestly. */
export function buildBurnup(state: SprintEngineState): SprintEngineBurnup | null {
  const tasks = state.tasks ?? []
  const completions = tasks
    .map((task) => parseTimestampMs(task.completedAt))
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b)
  if (completions.length < 2) return null

  const created = parseTimestampMs(state.creation?.createdAt)
  const starts = tasks
    .map((task) => parseTimestampMs(task.startedAt))
    .filter((ms): ms is number => ms !== null)
  const startMs = Math.min(created ?? completions[0], completions[0], ...(starts.length ? starts : [completions[0]]))
  const updated = parseTimestampMs(state.creation?.updatedAt)
  const endMs = Math.max(updated ?? completions[completions.length - 1], completions[completions.length - 1])
  if (endMs <= startMs) return null

  const points: SprintEngineBurnupPoint[] = [{ atMs: startMs, done: 0 }]
  completions.forEach((atMs, index) => {
    points.push({ atMs, done: index + 1 })
  })
  if (endMs > completions[completions.length - 1]) {
    points.push({ atMs: endMs, done: completions.length })
  }
  return { points, startMs, endMs, total: completions.length }
}

/** Cardinal-spline path through normalized points (x,y in viewBox units). Used
 *  by the burn-up chart for a smooth, low-noise trend line (per Vercel's
 *  curve-fitting guidance) without pulling in a charting dependency. */
export function cardinalSplinePath(points: Array<[number, number]>, tension = 0.5): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0][0]} ${points[0][1]}`
  let d = `M ${points[0][0]} ${points[0][1]}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? points[i + 1]
    const cp1x = p1[0] + ((p2[0] - p0[0]) / 6) * tension * 2
    const cp1y = p1[1] + ((p2[1] - p0[1]) / 6) * tension * 2
    const cp2x = p2[0] - ((p3[0] - p1[0]) / 6) * tension * 2
    const cp2y = p2[1] - ((p3[1] - p1[1]) / 6) * tension * 2
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`
  }
  return d
}

export function formatRunDuration(durationMs: number | null): string | null {
  if (durationMs === null) return null
  const totalMinutes = Math.round(durationMs / 60000)
  if (totalMinutes < 1) return '< 1m'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}m`
  return `${hours}h ${minutes.toString().padStart(2, '0')}m`
}

// Compact token count for dense numeric columns: 0–999 verbatim, then K/M/B
// with one decimal (trailing ".0" dropped) so a 698M cache-read column stays a
// single readable glyph instead of a nine-digit run. Negative inputs are clamped
// to 0 (token counts are never negative; a bad read should read as 0, not "-1").
export function formatCompactTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  const units: Array<{ limit: number; suffix: string }> = [
    { limit: 1_000_000_000, suffix: 'B' },
    { limit: 1_000_000, suffix: 'M' },
    { limit: 1_000, suffix: 'K' },
  ]
  for (const { limit, suffix } of units) {
    if (value >= limit) {
      const scaled = value / limit
      // One decimal under 100 (1.2M), none above (340M) so width stays bounded.
      const text = scaled >= 100 ? Math.round(scaled).toString() : trimDecimal(scaled)
      return `${text}${suffix}`
    }
  }
  return Math.round(value).toString()
}

function trimDecimal(value: number): string {
  const fixed = value.toFixed(1)
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}

function taskImplementerAgentId(task: SprintEngineTask): string | null {
  return task.lastImplementedByAgentId ?? task.ownerAgentId ?? null
}

function feedbackFindingTitle(finding: SprintEngineTaskFeedbackFinding): string {
  return finding.title?.trim() || feedbackFindingKindLabels[finding.kind]
}

function collectRunFindings(tasks: SprintEngineTask[]): SprintEngineRunFinding[] {
  const findings: SprintEngineRunFinding[] = []
  const push = (
    task: SprintEngineTask,
    finding: SprintEngineTaskFeedbackFinding,
    fromReview: boolean
  ) => {
    findings.push({
      id: finding.id,
      taskId: task.id,
      severity: finding.severity,
      kind: finding.kind,
      area: finding.area,
      title: feedbackFindingTitle(finding),
      detail: finding.detail ?? '',
      recommendation: finding.recommendation,
      file: finding.file,
      status: finding.status,
      fromReview,
    })
  }
  for (const task of tasks) {
    for (const finding of task.feedback?.findings ?? []) push(task, finding, false)
    for (const assessment of task.feedbackAssessments ?? []) {
      for (const finding of assessment.findings ?? []) push(task, finding, true)
    }
  }
  return findings.sort(
    (a, b) =>
      findingSeverityOrder.indexOf(a.severity) - findingSeverityOrder.indexOf(b.severity)
  )
}

export function buildAgentRows(
  agents: Record<string, SprintEngineRuntimeAgent>,
  tasks: SprintEngineTask[],
  analysis: Record<string, SprintEngineAgentMetrics> | null
): SprintEngineAgentRow[] {
  const doneByAgent = new Map<string, number>()
  for (const task of tasks) {
    if (task.status !== 'done') continue
    const implementer = taskImplementerAgentId(task)
    if (!implementer) continue
    doneByAgent.set(implementer, (doneByAgent.get(implementer) ?? 0) + 1)
  }

  const agentIds = new Set<string>([
    ...Object.keys(agents ?? {}),
    ...Object.keys(analysis ?? {}),
  ])

  const rows: SprintEngineAgentRow[] = [...agentIds].map((agentId) => {
    const agent = agents?.[agentId]
    const metrics = analysis?.[agentId] ?? null
    const role = (agent?.role ?? metrics?.role ?? '') as SprintEngineRoleId
    return {
      agentId,
      role,
      status: agent?.status ?? 'idle',
      tasksDone: doneByAgent.get(agentId) ?? 0,
      metrics,
    }
  })

  return rows.sort((a, b) => {
    const orderA = agentRoleOrder.indexOf(a.role)
    const orderB = agentRoleOrder.indexOf(b.role)
    const rankA = orderA === -1 ? agentRoleOrder.length : orderA
    const rankB = orderB === -1 ? agentRoleOrder.length : orderB
    if (rankA !== rankB) return rankA - rankB
    if (b.tasksDone !== a.tasksDone) return b.tasksDone - a.tasksDone
    return a.agentId.localeCompare(b.agentId)
  })
}

function weightedScoreAverage(
  rows: SprintEngineAgentRow[],
  scoreKey: string
): number | null {
  let weighted = 0
  let samples = 0
  for (const row of rows) {
    const stat = row.metrics?.selfReported.scores[scoreKey]
    if (stat) {
      weighted += stat.averagePct * stat.sampleCount
      samples += stat.sampleCount
    }
  }
  return samples > 0 ? Math.round(weighted / samples) : null
}

export function buildRunQualitySummary(rows: SprintEngineAgentRow[]): SprintEngineRunQuality {
  let claims = 0
  let hallucinated = 0
  let bugs = 0
  let regressions = 0
  let missedReqs = 0
  let hasMeasured = false
  let hasSelfReported = false

  for (const row of rows) {
    if ((row.metrics?.selfReported.sampleCount ?? 0) > 0) hasSelfReported = true
    const measured = row.metrics?.measured
    if (!measured || measured.reviewSampleCount === 0) continue
    hasMeasured = true
    claims += measured.counts.claimsChecked ?? 0
    hallucinated += measured.counts.hallucinatedClaims ?? 0
    regressions += measured.counts.regressionCount ?? 0
    missedReqs += measured.counts.missedRequirements ?? 0
    bugs += measured.findingsAgainst?.total ?? 0
  }

  return {
    confidencePct: weightedScoreAverage(rows, 'confidence_pct'),
    hallucinationRiskPct: weightedScoreAverage(rows, 'hallucination_risk_pct'),
    hallucinationRatePct: claims > 0 ? Math.round((hallucinated / claims) * 100) : null,
    bugs,
    regressions,
    missedReqs,
    hasSelfReported,
    hasMeasured,
  }
}

export function buildRunReport(
  state: SprintEngineState,
  analysis: Record<string, SprintEngineAgentMetrics> | null
): SprintEngineRunReport {
  const tasks = state.tasks ?? []

  const statusCounts: Partial<Record<SprintEngineTaskStatus, number>> = {}
  for (const task of tasks) {
    statusCounts[task.status] = (statusCounts[task.status] ?? 0) + 1
  }

  const needsInput = tasks
    .filter((task) => task.status === 'needs_input')
    .map((task) => ({
      taskId: task.id,
      role: task.role,
      reason:
        task.needsInput?.question?.trim() ||
        task.needsInput?.suggestedResolution?.trim() ||
        task.notes[task.notes.length - 1]?.trim() ||
        'Awaiting input to continue.',
    }))

  const openQuestions = tasks.flatMap((task) =>
    task.notes
      .map((note) => note.trim())
      .filter(Boolean)
      .map((note) => ({ taskId: task.id, note }))
  )

  const remaining = tasks
    .filter((task) => task.status !== 'done')
    .map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      role: task.role,
    }))

  const agentRows = buildAgentRows(state.sprintEngineAgents ?? {}, tasks, analysis)

  const findings = collectRunFindings(tasks)
  const findingSeverityCounts: Record<SprintEngineTaskFeedbackFindingSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  }
  for (const finding of findings) findingSeverityCounts[finding.severity] += 1

  let gatesApproved = 0
  let gatesTotal = 0
  for (const task of tasks) {
    for (const gate of task.qualityGates ?? []) {
      gatesTotal += 1
      if (gate.status === 'approved') gatesApproved += 1
    }
  }

  const touchedFiles = uniqueStrings(tasks.flatMap((task) => task.evidence.touchedFiles))
  const commandsRan = uniqueStrings(tasks.flatMap((task) => task.evidence.commandsRan))
  const validations = tasks.reduce((total, task) => total + task.evidence.results.length, 0)

  return {
    totalTasks: tasks.length,
    doneTasks: statusCounts.done ?? 0,
    statusCounts,
    runDurationMs: computeRunDurationMs(state),
    quality: buildRunQualitySummary(agentRows),
    needsInput,
    openQuestions,
    remaining,
    findings,
    findingSeverityCounts,
    metrics: {
      filesTouched: touchedFiles.length,
      commands: commandsRan.length,
      validations,
      findings: findings.length,
      gatesApproved,
      gatesTotal,
    },
    agentRows,
  }
}

// Process-health meters cover the input/process self-report dimensions only.
// Agent-performance dims (confidence, autonomy, hallucination risk) are shown
// per agent in the breakdown table and deliberately excluded here so the same
// metric never appears in two places at two aggregation levels.
export const processHealthDimensions: Array<{
  key: keyof SprintEngineTaskFeedbackScores
  label: string
}> = [
  { key: 'directiveClarityPct', label: 'Directive clarity' },
  { key: 'taskClarityPct', label: 'Task clarity' },
  { key: 'acceptanceCriteriaClarityPct', label: 'Acceptance clarity' },
  { key: 'sprintEngineToolEffectivenessPct', label: 'Tool effectiveness' },
  { key: 'promptOptimizationPct', label: 'Prompt fit' },
  { key: 'contextFitPct', label: 'Context fit' },
  { key: 'roleFitPct', label: 'Role fit' },
]

export type SprintEngineProcessHealthStat = {
  key: keyof SprintEngineTaskFeedbackScores
  label: string
  averagePct: number
  sampleCount: number
}

export function buildProcessHealth(tasks: SprintEngineTask[]): SprintEngineProcessHealthStat[] {
  return processHealthDimensions.flatMap(({ key, label }) => {
    const values = tasks.flatMap((task) => {
      const value = task.feedback?.scores[key]
      return typeof value === 'number' ? [value] : []
    })
    if (values.length === 0) return []
    const averagePct = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    return [{ key, label, averagePct, sampleCount: values.length }]
  })
}

// Human labels for the measured `counts` keys surfaced in the drill-down.
// `claimsChecked` is intentionally omitted — it is the denominator for the
// hallucination rate, not a defect to list.
export const measuredCountLabels: Record<string, string> = {
  implementationMistakes: 'Implementation mistakes',
  missedRequirements: 'Missed requirements',
  regressionCount: 'Regressions',
  unsafeChanges: 'Unsafe changes',
  factualErrors: 'Factual errors',
  testFailuresIntroduced: 'Test failures introduced',
  accessibilityIssues: 'Accessibility issues',
  designIssues: 'Design issues',
  hallucinatedClaims: 'Hallucinated claims',
}

// Agents are grouped into work-type tables: implementers produce reviewed code,
// reviewers run gates, planners shape the work. Each surfaces different metrics.
export type SprintEngineWorkType = 'implementation' | 'review' | 'planning'

const roleWorkType: Record<string, SprintEngineWorkType> = {
  developer: 'implementation',
  frontend: 'implementation',
  performance: 'implementation',
  cross_platform: 'implementation',
  production_readiness_reviewer: 'review',
  ui_ux_reviewer: 'review',
  code_reviewer: 'review',
  nuclear_reviewer: 'review',
  spec_reviewer: 'review',
  tester: 'review',
  security: 'review',
  architect: 'planning',
  product: 'planning',
}

export function agentWorkType(row: SprintEngineAgentRow): SprintEngineWorkType {
  // A reviewer role that also did review work stays review; an agent with only
  // reviewer activity (no implementation role) is review too. Otherwise fall
  // back to the role map, defaulting unknown/custom roles to implementation.
  return roleWorkType[row.role] ?? (row.metrics?.reviewer ? 'review' : 'implementation')
}

export function bucketAgentRowsByWorkType(rows: SprintEngineAgentRow[]): Record<
  SprintEngineWorkType,
  SprintEngineAgentRow[]
> {
  const buckets: Record<SprintEngineWorkType, SprintEngineAgentRow[]> = {
    implementation: [],
    review: [],
    planning: [],
  }
  for (const row of rows) buckets[agentWorkType(row)].push(row)
  return buckets
}

// Implementation defects that reflect code quality. `bugs` come from structured
// findings; the rest are reviewer count fields. Factual errors / hallucinations
// are claim-quality rather than implementation defects, so they're deliberately
// excluded from the Delivery score headline.
const IMPLEMENTATION_ISSUE_KEYS = [
  'bugs',
  'missedRequirements',
  'implementationMistakes',
  'unsafeChanges',
  'regressionCount',
  'testFailuresIntroduced',
] as const

const DELIVERY_SCORE_LOAD_SCALE = 4

const IMPLEMENTATION_ISSUE_WEIGHTS: Record<typeof IMPLEMENTATION_ISSUE_KEYS[number], number> = {
  bugs: 3,
  missedRequirements: 5,
  implementationMistakes: 4,
  unsafeChanges: 8,
  regressionCount: 6,
  testFailuresIntroduced: 4,
}

const BUG_SEVERITY_WEIGHTS: Record<SprintEngineTaskFeedbackFindingSeverity, number> = {
  critical: 8,
  high: 5,
  medium: 3,
  low: 1,
}

const IMPLEMENTATION_ISSUE_SHORT_LABELS: Record<typeof IMPLEMENTATION_ISSUE_KEYS[number], string> = {
  bugs: 'bugs',
  missedRequirements: 'missed reqs',
  implementationMistakes: 'impl. mistakes',
  unsafeChanges: 'unsafe',
  regressionCount: 'regressions',
  testFailuresIntroduced: 'test failures',
}

// One row of the by-type summary. `key` is a role id (role groups) or a CLI id
// (CLI groups); `clis` lists the distinct CLIs the group's agents ran on.
export type SprintEngineTypeStat = {
  key: string
  clis: string[]
  agentCount: number
  tasksDone: number
  totalIssues: number
  weightedIssuePoints: number
  issueLoadPerTask: number | null
  deliveryScore: number | null
  topIssueMix: Array<{ key: string; label: string; count: number }>
}

export type SprintEngineAgentTypeSummary = {
  /** Implementation agents grouped by role (developer, frontend, …). */
  roles: SprintEngineTypeStat[]
  /** The same agents grouped by the CLI they ran on (Claude, Codex, …). */
  clis: SprintEngineTypeStat[]
}

function typeStat(
  key: string,
  group: SprintEngineAgentRow[],
  cliByAgent: Record<string, string | undefined>,
): SprintEngineTypeStat {
  let tasksDone = 0
  let totalIssues = 0
  let weightedIssuePoints = 0
  const issueMix = new Map<typeof IMPLEMENTATION_ISSUE_KEYS[number], number>()
  const clis = new Set<string>()
  for (const row of group) {
    tasksDone += row.tasksDone
    const cli = cliByAgent[row.agentId]
    if (cli) clis.add(cli)
    const metrics = row.metrics
    if (!metrics) continue
    const bugCount = agentIssueCount(metrics, 'bugs') ?? 0
    totalIssues += bugCount
    issueMix.set('bugs', (issueMix.get('bugs') ?? 0) + bugCount)
    const bySeverity = metrics.measured.findingsAgainst?.bySeverity ?? {}
    const weightedBugs = findingSeverityOrder.reduce(
      (sum, severity) => sum + ((bySeverity[severity] ?? 0) * BUG_SEVERITY_WEIGHTS[severity]),
      0,
    )
    const severityBucketedBugs = findingSeverityOrder.reduce(
      (sum, severity) => sum + (bySeverity[severity] ?? 0),
      0,
    )
    const unbucketedBugs = Math.max(0, bugCount - severityBucketedBugs)
    weightedIssuePoints += weightedBugs + unbucketedBugs * IMPLEMENTATION_ISSUE_WEIGHTS.bugs
    for (const issueKey of IMPLEMENTATION_ISSUE_KEYS) {
      if (issueKey === 'bugs') continue
      const count = agentIssueCount(metrics, issueKey) ?? 0
      totalIssues += count
      weightedIssuePoints += count * IMPLEMENTATION_ISSUE_WEIGHTS[issueKey]
      issueMix.set(issueKey, (issueMix.get(issueKey) ?? 0) + count)
    }
  }
  const issueLoadPerTask = tasksDone > 0 ? Math.round((weightedIssuePoints / tasksDone) * 10) / 10 : null
  const deliveryScore =
    issueLoadPerTask === null
      ? null
      : Math.max(0, Math.min(100, Math.round(100 / (1 + issueLoadPerTask / DELIVERY_SCORE_LOAD_SCALE))))
  const topIssueMix = IMPLEMENTATION_ISSUE_KEYS
    .map((key) => ({
      key,
      label: IMPLEMENTATION_ISSUE_SHORT_LABELS[key],
      count: issueMix.get(key) ?? 0,
    }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
  return {
    key,
    clis: [...clis],
    agentCount: group.length,
    tasksDone,
    totalIssues,
    weightedIssuePoints,
    issueLoadPerTask,
    deliveryScore,
    topIssueMix,
  }
}

// Group the implementation agents two ways — by role and by CLI — so a glanceable
// headline can compare both "which roles hit the most issues" and "which CLI
// produced more issues" (the run records a CLI per agent).
export function buildAgentTypeSummary(
  rows: SprintEngineAgentRow[],
  cliByAgent: Record<string, string | undefined>,
): SprintEngineAgentTypeSummary {
  const implRows = rows.filter(
    (row) => agentWorkType(row) === 'implementation' && (row.tasksDone > 0 || row.metrics !== null),
  )
  const roleGroups = new Map<string, SprintEngineAgentRow[]>()
  const cliGroups = new Map<string, SprintEngineAgentRow[]>()
  for (const row of implRows) {
    const roleGroup = roleGroups.get(row.role) ?? []
    roleGroup.push(row)
    roleGroups.set(row.role, roleGroup)
    const cli = cliByAgent[row.agentId]
    if (cli) {
      const cliGroup = cliGroups.get(cli) ?? []
      cliGroup.push(row)
      cliGroups.set(cli, cliGroup)
    }
  }
  const byTasksDesc = (a: SprintEngineTypeStat, b: SprintEngineTypeStat) => b.tasksDone - a.tasksDone
  return {
    roles: [...roleGroups.entries()]
      .map(([key, group]) => typeStat(key, group, cliByAgent))
      .sort(byTasksDesc),
    clis: [...cliGroups.entries()]
      .map(([key, group]) => typeStat(key, group, cliByAgent))
      .sort(byTasksDesc),
  }
}

// The two CLIs with the highest and lowest Delivery score, when the gap is wide
// enough to be worth calling out. Drives the one-line takeaway under the by-type
// panel.
export function compareCliDeliveryScores(
  clis: SprintEngineTypeStat[],
): { worse: SprintEngineTypeStat; better: SprintEngineTypeStat } | null {
  const ranked = clis
    .filter((cli) => cli.tasksDone > 0 && cli.deliveryScore !== null)
    .sort((a, b) => (a.deliveryScore ?? 100) - (b.deliveryScore ?? 100))
  if (ranked.length < 2) return null
  const worse = ranked[0]
  const better = ranked[ranked.length - 1]
  if ((better.deliveryScore ?? 0) - (worse.deliveryScore ?? 0) < 10) return null
  return { worse, better }
}

// The measured issue types surfaced as per-agent columns + the run-wide
// "issues caught in review" chart. `bugs` is special — it comes from structured
// findings (findingsAgainst), the rest are reviewer count fields. Ordered to
// match typical prominence. These are issues reviewers FLAGGED during the run
// (counts carry no fixed/open status; structured findings do).
export const measuredIssueTypes: Array<{ key: string; label: string; short: string }> = [
  { key: 'bugs', label: 'Bugs', short: 'Bugs' },
  { key: 'missedRequirements', label: 'Missed requirements', short: 'Missed' },
  { key: 'implementationMistakes', label: 'Implementation mistakes', short: 'Impl.' },
  { key: 'factualErrors', label: 'Factual errors', short: 'Factual' },
  { key: 'unsafeChanges', label: 'Unsafe changes', short: 'Unsafe' },
  { key: 'hallucinatedClaims', label: 'Hallucinations', short: 'Halluc.' },
  { key: 'regressionCount', label: 'Regressions', short: 'Regr.' },
  { key: 'testFailuresIntroduced', label: 'Test failures', short: 'Test fail' },
]

/** A single agent's count for an issue type. Null = no review of this agent's
 *  work (renders "—"); a number (incl. 0) = reviewed. */
export function agentIssueCount(
  metrics: SprintEngineAgentMetrics | null,
  key: string
): number | null {
  if (!metrics || metrics.measured.reviewSampleCount === 0) return null
  if (key === 'bugs') return metrics.measured.findingsAgainst?.total ?? 0
  return metrics.measured.counts[key] ?? 0
}

export type SprintEngineIssueTotal = { key: string; label: string; short: string; total: number }

/** Run-wide totals per issue type, summed across agents (review attribution). */
export function buildIssueTotals(rows: SprintEngineAgentRow[]): {
  items: SprintEngineIssueTotal[]
  total: number
  hasMeasured: boolean
} {
  let hasMeasured = false
  const sums = new Map<string, number>()
  for (const row of rows) {
    const measured = row.metrics?.measured
    if (!measured || measured.reviewSampleCount === 0) continue
    hasMeasured = true
    for (const type of measuredIssueTypes) {
      const value =
        type.key === 'bugs'
          ? measured.findingsAgainst?.total ?? 0
          : measured.counts[type.key] ?? 0
      sums.set(type.key, (sums.get(type.key) ?? 0) + value)
    }
  }
  const items = measuredIssueTypes.map((type) => ({ ...type, total: sums.get(type.key) ?? 0 }))
  return { items, total: items.reduce((sum, item) => sum + item.total, 0), hasMeasured }
}

export type SprintEngineAgentTaskDetail = {
  id: string
  title: string
  status: SprintEngineTaskStatus
  reviewCount: number
  defects: Array<{ key: string; label: string; count: number }>
  findings: SprintEngineRunFinding[]
}

/** Per-agent drill-down: the tasks an agent implemented, each with the review
 *  signals against it. Task list + titles come from local state; per-task
 *  defect counts come from the analysis; finding prose comes from the local
 *  projection (feedback / reviewer assessments). */
export function buildAgentTaskDetail(
  agentId: string,
  tasks: SprintEngineTask[],
  metrics: SprintEngineAgentMetrics | null
): SprintEngineAgentTaskDetail[] {
  const findingsByTask = new Map<string, SprintEngineRunFinding[]>()
  for (const finding of collectRunFindings(tasks)) {
    const list = findingsByTask.get(finding.taskId)
    if (list) list.push(finding)
    else findingsByTask.set(finding.taskId, [finding])
  }
  const taskCounts = metrics?.measured.taskCounts ?? {}

  return tasks
    .filter((task) => taskImplementerAgentId(task) === agentId)
    .map((task) => {
      const counts = taskCounts[task.id]?.counts ?? {}
      const defects = Object.entries(measuredCountLabels).flatMap(([key, label]) => {
        const count = counts[key] ?? 0
        return count > 0 ? [{ key, label, count }] : []
      })
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        reviewCount: taskCounts[task.id]?.reviewSampleCount ?? 0,
        defects,
        findings: findingsByTask.get(task.id) ?? [],
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
}
