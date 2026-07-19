import assert from 'node:assert/strict'
import {
  agentIssueCount,
  agentIssueSignal,
  buildAgentRows,
  buildAgentTaskDetail,
  buildAgentTypeSummary,
  buildBurnup,
  buildIssueTotals,
  buildProcessHealth,
  buildRunQualitySummary,
  buildRunReport,
  compareCliDeliveryScores,
  buildAgentActivityTimeline,
  computeRunDurationMs,
  formatRunDuration,
  monotoneCubicPath,
  type SprintEngineAgentRow,
  type SprintEngineTypeStat,
} from './sprintengineRunSummary'
import type {
  SprintEngineAgentMetrics,
  SprintEngineRuntimeAgent,
  SprintEngineState,
  SprintEngineTask,
} from '../types/workspace'

function makeTask(overrides: Partial<SprintEngineTask>): SprintEngineTask {
  return {
    id: 'T0',
    title: 'Task',
    description: '',
    role: 'developer',
    status: 'done',
    ownerAgentId: null,
    dependsOn: [],
    ownedPaths: [],
    acceptanceCriteria: [],
    implementationNotes: [],
    evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
    notes: [],
    comments: [],
    startedAt: null,
    completedAt: null,
    ...overrides,
  } as SprintEngineTask
}

function makeState(overrides: Partial<SprintEngineState>): SprintEngineState {
  return {
    name: 'run',
    goal: 'Goal',
    roleCounts: {},
    sprintEngineAgents: {},
    events: [],
    tasks: [],
    artifacts: [],
    ...overrides,
  } as SprintEngineState
}

function agent(role: string, status = 'idle'): SprintEngineRuntimeAgent {
  return { role, status, currentTaskId: null } as unknown as SprintEngineRuntimeAgent
}

function testBuildAgentRowsJoinsRosterTasksAndMetrics(): void {
  const agents: Record<string, SprintEngineRuntimeAgent> = {
    'developer-1': agent('developer', 'done'),
    'frontend-1': agent('frontend', 'done'),
    'security-1': agent('security', 'idle'),
  }
  const tasks = [
    makeTask({ id: 'T1', status: 'done', lastImplementedByAgentId: 'developer-1' }),
    makeTask({ id: 'T2', status: 'done', ownerAgentId: 'frontend-1', role: 'frontend' }),
    makeTask({ id: 'T3', status: 'in_progress', ownerAgentId: 'developer-1' }),
  ]
  const analysis: Record<string, SprintEngineAgentMetrics> = {
    'developer-1': {
      role: 'developer',
      selfReported: { sampleCount: 1, scores: { confidence_pct: { label: 'Confidence', averagePct: 80, sampleCount: 1 } } },
      measured: { reviewSampleCount: 1, scores: {}, counts: { regressionCount: 2 } },
      findingsRaised: 0,
    },
  }

  const rows = buildAgentRows(agents, tasks, analysis)

  // Whole roster is represented, including the idle security agent.
  assert.deepEqual(rows.map((r) => r.agentId).sort(), ['developer-1', 'frontend-1', 'security-1'])

  const dev = rows.find((r) => r.agentId === 'developer-1')!
  assert.equal(dev.tasksDone, 1, 'only done tasks count toward tasksDone')
  assert.ok(dev.metrics, 'developer-1 has analysis metrics')

  const fe = rows.find((r) => r.agentId === 'frontend-1')!
  assert.equal(fe.tasksDone, 1, 'ownerAgentId is used when lastImplementedByAgentId is absent')
  assert.equal(fe.metrics, null, 'agents without feedback have null metrics (render as —)')

  const sec = rows.find((r) => r.agentId === 'security-1')!
  assert.equal(sec.tasksDone, 0)
  assert.equal(sec.metrics, null)

  // architect/product/developer/frontend/... ordering: developer before frontend before security.
  assert.deepEqual(rows.map((r) => r.agentId), ['developer-1', 'frontend-1', 'security-1'])
}

function testBuildAgentRowsIncludesAnalysisOnlyAgents(): void {
  const rows = buildAgentRows(
    {},
    [],
    {
      'ghost-1': {
        role: 'developer',
        selfReported: { sampleCount: 1, scores: {} },
        measured: { reviewSampleCount: 0, scores: {}, counts: {} },
        findingsRaised: 0,
      },
    }
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].agentId, 'ghost-1')
  assert.equal(rows[0].role, 'developer', 'role falls back to analysis metrics when not in roster')
}

function testBuildRunReportDerivesStatusesNeedsInputAndFindings(): void {
  const state = makeState({
    creation: { createdAt: '2026-06-03T10:00:00Z', updatedAt: '2026-06-03T13:42:00Z' },
    tasks: [
      makeTask({
        id: 'T1',
        status: 'done',
        evidence: { summary: '', touchedFiles: ['a.ts', 'b.ts'], commandsRan: ['pytest'], results: ['passed'] },
        feedback: {
          schemaVersion: 1,
          capturedAt: '',
          source: 'agent_self_report',
          agentId: 'developer-1',
          role: 'developer',
          scores: {},
          findings: [{ id: 'F1', kind: 'code_bug', severity: 'low', area: 'backend', title: 'minor', detail: '' }],
        },
        feedbackAssessments: [
          {
            schemaVersion: 1,
            capturedAt: '',
            source: 'reviewer_assessment',
            agentId: 'security-1',
            role: 'developer',
            scores: {},
            findings: [{ id: 'F2', kind: 'security_issue', severity: 'critical', area: 'security', title: 'sev', detail: '' }],
          },
        ],
      }),
      makeTask({
        id: 'T2',
        status: 'needs_input',
        role: 'frontend',
        needsInput: { kind: 'user', question: 'Which datastore?' },
        notes: ['Pending a decision on persistence'],
      }),
      makeTask({ id: 'T3', status: 'review', role: 'developer' }),
    ],
  })

  const report = buildRunReport(state, null)

  assert.equal(report.totalTasks, 3)
  assert.equal(report.doneTasks, 1)
  assert.equal(report.statusCounts.needs_input, 1)
  assert.equal(report.statusCounts.review, 1)

  assert.equal(report.needsInput.length, 1)
  assert.equal(report.needsInput[0].reason, 'Which datastore?', 'needs-input reason comes from the question')

  assert.equal(report.openQuestions.length, 1)
  assert.equal(report.remaining.length, 2, 'non-done tasks are listed as remaining')

  // Findings collected from both self-report and reviewer assessment, severity-sorted.
  assert.equal(report.findings.length, 2)
  assert.equal(report.findings[0].severity, 'critical', 'critical findings sort first')
  assert.equal(report.findings[0].fromReview, true)
  assert.equal(report.findingSeverityCounts.critical, 1)
  assert.equal(report.findingSeverityCounts.low, 1)

  assert.equal(report.metrics.filesTouched, 2)
  assert.equal(report.metrics.commands, 1)
  assert.equal(report.metrics.validations, 1)
  assert.equal(report.metrics.findings, 2)

  assert.equal(report.runDurationMs, 3 * 3600_000 + 42 * 60_000)
}

function testProcessHealthExcludesAgentPerformanceDimensions(): void {
  const tasks = [
    makeTask({
      id: 'T1',
      feedback: {
        schemaVersion: 1,
        capturedAt: '',
        source: 'agent_self_report',
        agentId: 'developer-1',
        role: 'developer',
        scores: { directiveClarityPct: 80, contextFitPct: 90, confidencePct: 70 },
      },
    }),
    makeTask({
      id: 'T2',
      feedback: {
        schemaVersion: 1,
        capturedAt: '',
        source: 'agent_self_report',
        agentId: 'developer-2',
        role: 'developer',
        scores: { directiveClarityPct: 100, contextFitPct: 70 },
      },
    }),
  ]
  const health = buildProcessHealth(tasks)
  const byKey = Object.fromEntries(health.map((h) => [h.key, h]))

  assert.equal(byKey.directiveClarityPct.averagePct, 90, 'averages across tasks')
  assert.equal(byKey.directiveClarityPct.sampleCount, 2)
  assert.equal(byKey.contextFitPct.averagePct, 80)
  assert.ok(!('confidencePct' in byKey), 'confidence is shown per-agent, not in process health')
}

function testDurationFormatting(): void {
  assert.equal(formatRunDuration(null), null)
  assert.equal(formatRunDuration(52 * 60_000), '52m')
  assert.equal(formatRunDuration(3 * 3600_000 + 42 * 60_000), '3h 42m')
  assert.equal(formatRunDuration(20_000), '< 1m')
  // No timestamps anywhere → null.
  assert.equal(computeRunDurationMs(makeState({ tasks: [makeTask({ startedAt: null, completedAt: null })] })), null)
}

function testQualitySummaryRollsUpAcrossAgents(): void {
  const rows: SprintEngineAgentRow[] = [
    {
      agentId: 'developer-1',
      role: 'developer',
      status: 'done',
      tasksDone: 2,
      metrics: {
        role: 'developer',
        selfReported: { sampleCount: 2, scores: { confidence_pct: { label: 'Confidence', averagePct: 90, sampleCount: 2 } } },
        measured: { reviewSampleCount: 1, scores: {}, counts: { claimsChecked: 10, hallucinatedClaims: 3, regressionCount: 1, missedRequirements: 2 }, findingsAgainst: { total: 3, bySeverity: { high: 1, low: 2 } } },
        findingsRaised: 0,
      },
    },
    {
      agentId: 'frontend-1',
      role: 'frontend',
      status: 'done',
      tasksDone: 1,
      metrics: {
        role: 'frontend',
        selfReported: { sampleCount: 1, scores: { confidence_pct: { label: 'Confidence', averagePct: 60, sampleCount: 1 } } },
        measured: { reviewSampleCount: 1, scores: {}, counts: { claimsChecked: 10, hallucinatedClaims: 1, regressionCount: 2 } },
        findingsRaised: 0,
      },
    },
    { agentId: 'idle-1', role: 'tester', status: 'idle', tasksDone: 0, metrics: null },
  ]

  const q = buildRunQualitySummary(rows)
  assert.equal(q.hasSelfReported, true)
  assert.equal(q.hasMeasured, true)
  // Weighted by sampleCount: (90*2 + 60*1) / 3 = 80.
  assert.equal(q.confidencePct, 80)
  // Summed across agents.
  assert.equal(q.bugs, 3)
  assert.equal(q.regressions, 3)
  assert.equal(q.missedReqs, 2)
  // Measured rate: (3 + 1) hallucinated / (10 + 10) claims = 20%.
  assert.equal(q.hallucinationRatePct, 20)
}

function testQualitySummaryDistinguishesNoMeasuredData(): void {
  const q = buildRunQualitySummary([
    { agentId: 'a', role: 'developer', status: 'done', tasksDone: 1, metrics: null },
  ])
  assert.equal(q.hasMeasured, false)
  assert.equal(q.hasSelfReported, false)
  assert.equal(q.hallucinationRatePct, null)
  assert.equal(q.confidencePct, null)
  assert.equal(q.bugs, 0)
}

function testBuildBurnupBuildsCumulativeSeries(): void {
  const state = makeState({
    creation: { createdAt: '2026-06-03T10:00:00Z', updatedAt: '2026-06-03T14:00:00Z' },
    tasks: [
      makeTask({ id: 'T1', status: 'done', completedAt: '2026-06-03T11:00:00Z' }),
      makeTask({ id: 'T2', status: 'done', completedAt: '2026-06-03T12:00:00Z' }),
      makeTask({ id: 'T3', status: 'done', completedAt: '2026-06-03T13:00:00Z' }),
      makeTask({ id: 'T4', status: 'in_progress', completedAt: null }),
    ],
  })
  const burnup = buildBurnup(state)
  assert.ok(burnup, 'burnup builds when timestamps exist')
  assert.equal(burnup!.total, 3, 'counts only completed tasks')
  assert.deepEqual(burnup!.points.map((p) => p.done), [0, 1, 2, 3, 3])
  assert.equal(burnup!.startMs, Date.parse('2026-06-03T10:00:00Z'))
  assert.equal(burnup!.endMs, Date.parse('2026-06-03T14:00:00Z'))

  assert.equal(
    buildBurnup(makeState({ tasks: [makeTask({ status: 'done', completedAt: '2026-06-03T11:00:00Z' })] })),
    null
  )
  assert.equal(buildBurnup(makeState({ tasks: [] })), null)
}

function testBuildAgentTaskDetailJoinsTasksCountsAndFindings(): void {
  const tasks = [
    makeTask({
      id: 'T7',
      title: 'Staff management backend',
      status: 'done',
      lastImplementedByAgentId: 'developer-1',
      feedbackAssessments: [
        {
          schemaVersion: 1,
          capturedAt: '',
          source: 'reviewer_assessment',
          agentId: 'security-1',
          role: 'developer',
          scores: {},
          findings: [
            {
              id: 'T7-F1',
              kind: 'code_bug',
              severity: 'high',
              area: 'backend',
              title: 'Race in availability lock',
              detail: 'Concurrent bookings can double-allocate a slot.',
              recommendation: 'Take a row lock.',
            },
          ],
        },
      ],
    }),
    makeTask({ id: 'T2', title: 'Scaffold repo', status: 'done', lastImplementedByAgentId: 'developer-1' }),
    makeTask({ id: 'T9', title: 'Other agent task', status: 'done', lastImplementedByAgentId: 'frontend-1' }),
  ]
  const metrics: SprintEngineAgentMetrics = {
    role: 'developer',
    selfReported: { sampleCount: 0, scores: {} },
    measured: {
      reviewSampleCount: 8,
      scores: {},
      counts: {},
      taskCounts: {
        T7: { reviewSampleCount: 5, counts: { implementationMistakes: 2, missedRequirements: 2, claimsChecked: 111 } },
        T2: { reviewSampleCount: 3, counts: { claimsChecked: 38 } },
      },
    },
    findingsRaised: 0,
  }

  const detail = buildAgentTaskDetail('developer-1', tasks, metrics)

  // Only the agent's own tasks, sorted naturally (T2 before T7).
  assert.deepEqual(detail.map((d) => d.id), ['T2', 'T7'])

  const t7 = detail.find((d) => d.id === 'T7')!
  // claimsChecked (denominator) is excluded; defects are labeled.
  assert.deepEqual(
    t7.defects.map((d) => `${d.label} ${d.count}`).sort(),
    ['Implementation mistakes 2', 'Missed requirements 2']
  )
  assert.equal(t7.reviewCount, 5)
  assert.equal(t7.findings.length, 1)
  assert.equal(t7.findings[0].detail, 'Concurrent bookings can double-allocate a slot.')

  const t2 = detail.find((d) => d.id === 'T2')!
  // reviewed but only claimsChecked → no defects, no findings.
  assert.equal(t2.defects.length, 0)
  assert.equal(t2.findings.length, 0)
  assert.equal(t2.reviewCount, 3)
}

function testIssueTotalsAndPerAgentCounts(): void {
  const rows: SprintEngineAgentRow[] = [
    {
      agentId: 'developer-1',
      role: 'developer',
      status: 'done',
      tasksDone: 2,
      metrics: {
        role: 'developer',
        selfReported: { sampleCount: 0, scores: {} },
        measured: {
          reviewSampleCount: 3,
          scores: {},
          counts: { missedRequirements: 5, implementationMistakes: 2, unsafeChanges: 1 },
          findingsAgainst: { total: 2, bySeverity: { high: 1, low: 1 } },
        },
        findingsRaised: 0,
      },
    },
    {
      agentId: 'frontend-1',
      role: 'frontend',
      status: 'done',
      tasksDone: 1,
      metrics: {
        role: 'frontend',
        selfReported: { sampleCount: 0, scores: {} },
        measured: { reviewSampleCount: 1, scores: {}, counts: { missedRequirements: 2, regressionCount: 1 } },
        findingsRaised: 0,
      },
    },
    { agentId: 'tester-1', role: 'tester', status: 'idle', tasksDone: 0, metrics: null },
  ]

  const { items, total, hasMeasured } = buildIssueTotals(rows)
  const byKey = Object.fromEntries(items.map((i) => [i.key, i.total]))
  assert.equal(hasMeasured, true)
  assert.equal(byKey.missedRequirements, 7) // 5 + 2 across agents
  assert.equal(byKey.implementationMistakes, 2)
  assert.equal(byKey.unsafeChanges, 1)
  assert.equal(byKey.regressionCount, 1)
  assert.equal(byKey.bugs, 2) // from findingsAgainst totals
  assert.equal(total, 13)

  // Per-agent accessor: bugs from findings, counts from counts, 0 when reviewed
  // but absent, null when never reviewed.
  assert.equal(agentIssueCount(rows[0].metrics, 'bugs'), 2)
  assert.equal(agentIssueCount(rows[0].metrics, 'missedRequirements'), 5)
  assert.equal(agentIssueCount(rows[0].metrics, 'factualErrors'), 0)
  assert.equal(agentIssueCount(rows[2].metrics, 'bugs'), null)
}

function testSelfReviewFallbackWhenNoIndependentReview(): void {
  // An agent whose work no reviewer measured, but which recorded self-review
  // telemetry on task.advance (the single-owner engine's default shape).
  const selfOnly: SprintEngineAgentRow = {
    agentId: 'developer-1',
    role: 'developer',
    status: 'done',
    tasksDone: 1,
    metrics: {
      role: 'developer',
      selfReported: { sampleCount: 1, scores: {} },
      measured: { reviewSampleCount: 0, scores: {}, counts: {} },
      findingsRaised: 2,
      selfReview: {
        phasesClosed: 1,
        passed: 0,
        fixedForward: 1,
        escalated: 0,
        counts: { claimsChecked: 6, missedRequirements: 1 },
        findingsReported: { total: 2, bySeverity: { high: 1, low: 1 } },
        taskCounts: { T1: { reviewSampleCount: 1, counts: { missedRequirements: 1 } } },
      },
    },
  }
  const noSignals: SprintEngineAgentRow = {
    agentId: 'ghost-1', role: 'developer', status: 'idle', tasksDone: 0, metrics: null,
  }

  // Per-agent signal: self-reported values, flagged as such; null without data.
  assert.deepEqual(agentIssueSignal(selfOnly.metrics, 'bugs'), { count: 2, selfReported: true })
  assert.deepEqual(agentIssueSignal(selfOnly.metrics, 'missedRequirements'), { count: 1, selfReported: true })
  assert.deepEqual(agentIssueSignal(selfOnly.metrics, 'regressionCount'), { count: 0, selfReported: true })
  assert.equal(agentIssueSignal(noSignals.metrics, 'bugs'), null)
  // agentIssueCount stays measured-only (Delivery score never mixes self data).
  assert.equal(agentIssueCount(selfOnly.metrics, 'bugs'), null)

  // Run totals include the self-reported contribution and say so.
  const totals = buildIssueTotals([selfOnly, noSignals])
  assert.equal(totals.hasMeasured, false)
  assert.equal(totals.includesSelfReported, true)
  const byKey = Object.fromEntries(totals.items.map((i) => [i.key, i.total]))
  assert.equal(byKey.bugs, 2)
  assert.equal(byKey.missedRequirements, 1)

  // Quality strip falls back to self-review sums per agent.
  const quality = buildRunQualitySummary([selfOnly])
  assert.equal(quality.hasMeasured, false)
  assert.equal(quality.hasSelfReported, true)
  assert.equal(quality.bugs, 2)
  assert.equal(quality.missedReqs, 1)
  assert.equal(quality.hallucinationRatePct, 0) // 0 hallucinated / 6 claims

  // Drill-down: self-review per-task counts surface with provenance; the
  // empty-state can distinguish self-reviewed-clean from no-signals.
  const detail = buildAgentTaskDetail(
    'developer-1',
    [makeTask({ id: 'T1', status: 'done', lastImplementedByAgentId: 'developer-1' })],
    selfOnly.metrics,
  )
  assert.equal(detail[0].reviewCount, 0)
  assert.equal(detail[0].selfReviewCount, 1)
  assert.deepEqual(detail[0].defects, [
    { key: 'missedRequirements', label: 'Missed requirements', count: 1, selfReported: true },
  ])

  // An independently reviewed agent is untouched by the fallback.
  const reviewed: SprintEngineAgentRow = {
    ...selfOnly,
    metrics: {
      ...selfOnly.metrics!,
      measured: {
        reviewSampleCount: 1,
        scores: {},
        counts: { missedRequirements: 3 },
        findingsAgainst: { total: 1, bySeverity: { high: 1 } },
      },
    },
  }
  assert.deepEqual(agentIssueSignal(reviewed.metrics, 'bugs'), { count: 1, selfReported: false })
  assert.deepEqual(agentIssueSignal(reviewed.metrics, 'missedRequirements'), { count: 3, selfReported: false })
}

function implRow(
  agentId: string,
  role: string,
  tasksDone: number,
  taskCounts: Record<string, { reviewSampleCount: number; counts: Record<string, number> }>,
  findingsAgainstTotal = 0,
): SprintEngineAgentRow {
  const counts: Record<string, number> = {}
  for (const task of Object.values(taskCounts)) {
    for (const [key, value] of Object.entries(task.counts)) counts[key] = (counts[key] ?? 0) + value
  }
  return {
    agentId,
    role: role as SprintEngineAgentRow['role'],
    status: 'done',
    tasksDone,
    metrics: {
      role: role as SprintEngineAgentMetrics['role'],
      selfReported: { sampleCount: 0, scores: {} },
      measured: {
        reviewSampleCount: 1,
        scores: {},
        counts,
        taskCounts,
        ...(findingsAgainstTotal > 0
          ? { findingsAgainst: { total: findingsAgainstTotal, bySeverity: { high: findingsAgainstTotal } } }
          : {}),
      },
      findingsRaised: 0,
    },
  }
}

function testAgentTypeSummaryGroupsByRoleAndCli(): void {
  const rows: SprintEngineAgentRow[] = [
    implRow('developer-1', 'developer', 3, {
      T1: { reviewSampleCount: 1, counts: { implementationMistakes: 1 } },
      T2: { reviewSampleCount: 1, counts: { missedRequirements: 2 } },
      T3: { reviewSampleCount: 1, counts: { claimsChecked: 9 } },
    }, 1),
    implRow('developer-2', 'developer', 1, {
      T4: { reviewSampleCount: 1, counts: { claimsChecked: 4 } },
    }),
    implRow('frontend-1', 'frontend', 2, {
      T5: { reviewSampleCount: 1, counts: { claimsChecked: 3 } },
      T6: { reviewSampleCount: 1, counts: {} },
    }),
    // Reviewer + planner rows must be excluded from an implementation headline.
    { agentId: 'security-1', role: 'security', status: 'done', tasksDone: 2, metrics: null },
    { agentId: 'ui_ux_reviewer-1', role: 'ui_ux_reviewer', status: 'done', tasksDone: 1, metrics: null },
    { agentId: 'architect-1', role: 'architect', status: 'done', tasksDone: 2, metrics: null },
  ]
  const cliByAgent = {
    'developer-1': 'codex',
    'developer-2': 'codex',
    'frontend-1': 'claude-code',
    'security-1': 'claude-code',
    'ui_ux_reviewer-1': 'claude-code',
    'architect-1': 'codex',
  }

  const summary = buildAgentTypeSummary(rows, cliByAgent)

  // Only implementation roles, sorted by tasks done (developer 4 > frontend 2).
  assert.deepEqual(summary.roles.map((r) => r.key), ['developer', 'frontend'])

  const dev = summary.roles[0]
  assert.equal(dev.agentCount, 2)
  assert.equal(dev.tasksDone, 4)
  assert.equal(dev.totalIssues, 4, '1 bug (finding) + 1 mistake + 2 missed reqs')
  assert.equal(dev.weightedIssuePoints, 19)
  assert.equal(dev.issueLoadPerTask, 4.8)
  assert.equal(dev.deliveryScore, 45)
  assert.deepEqual(dev.topIssueMix.map((item) => [item.key, item.count]), [
    ['missedRequirements', 2],
    ['bugs', 1],
    ['implementationMistakes', 1],
  ])
  assert.deepEqual(dev.clis, ['codex'])

  const fe = summary.roles[1]
  assert.equal(fe.totalIssues, 0)
  assert.equal(fe.issueLoadPerTask, 0)
  assert.equal(fe.deliveryScore, 100)
  assert.deepEqual(fe.clis, ['claude-code'])

  // CLI grouping spans roles: codex = the two developers, claude-code = frontend only.
  const byCli = Object.fromEntries(summary.clis.map((c) => [c.key, c]))
  assert.equal(byCli.codex.tasksDone, 4)
  assert.equal(byCli.codex.deliveryScore, 45)
  assert.equal(byCli['claude-code'].deliveryScore, 100)
}

function testCompareCliDeliveryScores(): void {
  const stat = (key: string, deliveryScore: number | null, tasksDone = 4): SprintEngineTypeStat => ({
    key,
    clis: [key],
    agentCount: 1,
    tasksDone,
    totalIssues: 0,
    weightedIssuePoints: 0,
    issueLoadPerTask: 0,
    deliveryScore,
    topIssueMix: [],
  })

  const wide = compareCliDeliveryScores([stat('claude-code', 90), stat('codex', 45)])
  assert.ok(wide)
  assert.equal(wide!.worse.key, 'codex')
  assert.equal(wide!.better.key, 'claude-code')

  // A single CLI, or a gap under 10 points, isn't worth a takeaway.
  assert.equal(compareCliDeliveryScores([stat('codex', 60)]), null)
  assert.equal(compareCliDeliveryScores([stat('claude-code', 52), stat('codex', 58)]), null)
  // Zero-task CLIs are ignored.
  assert.equal(compareCliDeliveryScores([stat('claude-code', null, 0), stat('codex', 40)]), null)
}

// The burn-up curve is cumulative, so its smoothing must never overshoot: every
// point of the rendered curve has to stay within the y-range of the segment it
// lies on. A cardinal spline fails this on a long flat run followed by a steep
// finish (the bug that drew a ballooning blob); monotone cubic must not.
function testMonotoneCubicNeverOvershoots(): void {
  // Chart-space points (y shrinks as more tasks complete): flat for most of the
  // run, then a sharp climb to the top in the final stretch.
  const points: Array<[number, number]> = [
    [0, 100],
    [40, 100],
    [120, 100],
    [300, 92],
    [520, 90],
    [555, 12],
    [560, 12],
  ]
  const d = monotoneCubicPath(points)
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  assert.ok(nums.length >= 2, 'path emits coordinates')

  // Walk the cubic segments (M x y, then repeating C c1 c2 end) and sample each.
  let px = nums[0]
  let py = nums[1]
  let idx = 2
  const eps = 0.01
  while (idx + 6 <= nums.length) {
    const [c1x, c1y, c2x, c2y, x, y] = nums.slice(idx, idx + 6)
    void c1x
    void c2x
    const lo = Math.min(py, y) - eps
    const hi = Math.max(py, y) + eps
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const mt = 1 - t
      const by = mt * mt * mt * py + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * y
      assert.ok(by >= lo && by <= hi, `curve stays within [${lo}, ${hi}] at t=${t.toFixed(2)} (got ${by.toFixed(2)})`)
    }
    px = x
    py = y
    idx += 6
  }
  void px

  // Degenerate inputs stay safe.
  assert.equal(monotoneCubicPath([]), '')
  assert.equal(monotoneCubicPath([[3, 4]]), 'M 3 4')
  assert.equal(monotoneCubicPath([[0, 0], [10, 5]]), 'M 0.00 0.00 L 10.00 5.00')
}

function activityEntry(
  timestamp: string,
  actor: string,
  type: string,
  status?: string,
): SprintEngineTask['activity'] extends Array<infer E> | undefined ? E : never {
  return { id: `${actor}-${timestamp}`, timestamp, actor, type, message: '', status } as never
}

function agentRecord(role: string, extra: Record<string, unknown> = {}): SprintEngineRuntimeAgent {
  // `extra` may carry now-untracked fields (joinedAt/leftAt) the builder ignores —
  // they just confirm lifecycle timestamps don't affect the task-time timeline.
  return { role, status: 'idle', currentTaskId: null, ...extra } as unknown as SprintEngineRuntimeAgent
}

function testBuildAgentActivityTimelineDerivesHandoffs(): void {
  const tasks = [
    makeTask({
      id: 'T1',
      status: 'done',
      completedAt: '2026-06-03T10:40:00Z',
      lastImplementedByAgentId: 'developer-1',
      // dev claims, adds evidence (same holder), then a reviewer takes it to review and done.
      activity: [
        activityEntry('2026-06-03T10:00:00Z', 'developer-1', 'claim'),
        activityEntry('2026-06-03T10:05:00Z', 'developer-1', 'evidence'),
        activityEntry('2026-06-03T10:30:00Z', 'security-1', 'status_change', 'review'),
        activityEntry('2026-06-03T10:40:00Z', 'security-1', 'status_change', 'done'),
      ],
    }),
    // No activity log: falls back to the implementer's started→completed window.
    makeTask({
      id: 'T2',
      status: 'done',
      startedAt: '2026-06-03T10:50:00Z',
      completedAt: '2026-06-03T11:10:00Z',
      ownerAgentId: 'developer-1',
    }),
  ]
  const timeline = buildAgentActivityTimeline(
    makeState({
      tasks,
      creation: { createdAt: '2026-06-03T09:55:00Z', updatedAt: '2026-06-03T11:15:00Z' },
      sprintEngineAgents: {
        'developer-1': agentRecord('developer', { joinedAt: '2026-06-03T09:58:00Z' }),
        'security-1': agentRecord('security', { joinedAt: '2026-06-03T10:25:00Z' }),
      },
    }),
    { 'developer-1': 'developer', 'security-1': 'security' }
  )
  assert.ok(timeline, 'timeline builds when activity/timing exist')

  // Window spans creation → last update, not just the work segments.
  assert.equal(timeline!.startMs, Date.parse('2026-06-03T09:55:00Z'))
  assert.equal(timeline!.endMs, Date.parse('2026-06-03T11:15:00Z'))

  // MC-1542 single-owner tasks: every phase of a task — implementation and its
  // own review — belongs to the one agent that owns it. The reviewer-authored
  // status_change entries do NOT give security-1 its own lane; the review
  // phase is attributed to the implementer, so only developer-1 gets a lane.
  const dev = timeline!.rows.find((r) => r.agentId === 'developer-1')
  const reviewer = timeline!.rows.find((r) => r.agentId === 'security-1')
  assert.ok(dev, 'the implementer gets a lane')
  assert.ok(!reviewer, 'a status-change-only reviewer never gets its own lane under single-owner tasks')
  assert.equal(timeline!.rows.length, 1, 'only the implementer holds task time')

  // dev's implementation + review slivers on T1 merge into one contiguous bar
  // [10:00,10:40], and the activity-less T2 adds a second bar [10:50,11:10].
  assert.equal(dev!.role, 'developer')
  assert.deepEqual(
    dev!.segments.map((s) => [s.taskId, s.status, s.startMs, s.endMs]),
    [
      ['T1', 'in_progress', Date.parse('2026-06-03T10:00:00Z'), Date.parse('2026-06-03T10:40:00Z')],
      ['T2', 'in_progress', Date.parse('2026-06-03T10:50:00Z'), Date.parse('2026-06-03T11:10:00Z')],
    ]
  )
  assert.equal(dev!.activeMs, 40 * 60000 + 20 * 60000, 'active time sums both bars')

  // Earliest-active agent leads the lane order.
  assert.equal(timeline!.rows[0].agentId, 'developer-1')
}

function testBuildAgentActivityTimelineOnlyTaskHolders(): void {
  const tasks = [
    makeTask({
      id: 'T1',
      status: 'done',
      completedAt: '2026-06-03T10:20:00Z',
      lastImplementedByAgentId: 'developer-1',
      activity: [
        activityEntry('2026-06-03T10:00:00Z', 'developer-1', 'claim'),
        activityEntry('2026-06-03T10:20:00Z', 'developer-1', 'status_change', 'done'),
      ],
    }),
  ]
  const timeline = buildAgentActivityTimeline(
    makeState({
      tasks,
      creation: { createdAt: '2026-06-03T09:55:00Z', updatedAt: '2026-06-03T10:30:00Z' },
      sprintEngineAgents: {
        'developer-1': agentRecord('developer', {}),
        // On the roster but never held a task — no lane (lifecycle is not tracked).
        'security-1': agentRecord('security', { leftAt: '2026-06-03T10:10:00Z' }),
        'tester-1': agentRecord('tester', {}),
      },
    }),
    { 'developer-1': 'developer', 'security-1': 'security', 'tester-1': 'tester' }
  )
  assert.ok(timeline)
  assert.deepEqual(
    timeline!.rows.map((r) => r.agentId),
    ['developer-1'],
    'only agents that held a task get a lane; idle/departed agents do not'
  )
}

function testBuildAgentActivityTimelineAttributesByPhase(): void {
  // An architect comment lands mid-implementation, and a non-roster actor (the
  // user) posts an artifact. Neither must fragment the developer's bar or create
  // a lane: the implementation phase belongs to the implementer end-to-end.
  const tasks = [
    makeTask({
      id: 'T1',
      status: 'done',
      startedAt: '2026-06-03T10:00:00Z',
      completedAt: '2026-06-03T11:00:00Z',
      lastImplementedByAgentId: 'developer-1',
      activity: [
        activityEntry('2026-06-03T10:00:00Z', 'developer-1', 'claim'),
        activityEntry('2026-06-03T10:15:00Z', 'usr_abc', 'artifact'),
        activityEntry('2026-06-03T10:20:00Z', 'architect-1', 'feedback'),
        activityEntry('2026-06-03T10:40:00Z', 'developer-1', 'evidence'),
        activityEntry('2026-06-03T10:50:00Z', 'developer-1', 'status_change', 'review'),
        activityEntry('2026-06-03T10:52:00Z', 'performance-1', 'gate_claim'),
        activityEntry('2026-06-03T11:00:00Z', 'performance-1', 'gate_verdict'),
        activityEntry('2026-06-03T11:00:00Z', 'performance-1', 'status_change', 'done'),
      ],
    }),
  ]
  const timeline = buildAgentActivityTimeline(
    makeState({
      tasks,
      creation: { createdAt: '2026-06-03T09:59:00Z', updatedAt: '2026-06-03T11:05:00Z' },
      sprintEngineAgents: {
        'developer-1': agentRecord('developer', { joinedAt: '2026-06-03T09:59:00Z' }),
        'architect-1': agentRecord('architect', { joinedAt: '2026-06-03T09:59:00Z' }),
        'performance-1': agentRecord('performance', { joinedAt: '2026-06-03T09:59:00Z' }),
      },
    }),
    { 'developer-1': 'developer', 'architect-1': 'architect', 'performance-1': 'performance' }
  )
  assert.ok(timeline)

  // MC-1542 single-owner tasks: the implementer owns every phase of its task —
  // both implementation and its own review. The mid-build architect feedback and
  // user artifact do not split the bar, and the reviewer-authored status_change
  // entries do not hand the review phase to another lane. developer-1's
  // implementation [10:00,10:50] and review [10:50,11:00] merge into ONE bar.
  const dev = timeline!.rows.find((r) => r.agentId === 'developer-1')
  assert.deepEqual(
    dev!.segments.map((s) => [s.taskId, s.status, s.startMs, s.endMs]),
    [['T1', 'in_progress', Date.parse('2026-06-03T10:00:00Z'), Date.parse('2026-06-03T11:00:00Z')]]
  )

  // No one but the implementer holds task time: the reviewer, the mid-build
  // architect commenter, and the non-roster user actor all get no lane.
  assert.equal(timeline!.rows.find((r) => r.agentId === 'performance-1'), undefined)
  assert.equal(timeline!.rows.find((r) => r.agentId === 'architect-1'), undefined)
  assert.equal(timeline!.rows.find((r) => r.agentId === 'usr_abc'), undefined)
  assert.equal(timeline!.rows.length, 1, 'only the implementer holds task time')
}

function testBuildAgentActivityTimelineEmptyCases(): void {
  assert.equal(buildAgentActivityTimeline(makeState({ tasks: [] }), {}), null)
  // Tasks with no activity and no usable timing yield no lanes.
  assert.equal(
    buildAgentActivityTimeline(makeState({ tasks: [makeTask({ id: 'T1', status: 'todo' })] }), {}),
    null
  )
}

function main(): void {
  testAgentTypeSummaryGroupsByRoleAndCli()
  testCompareCliDeliveryScores()
  testIssueTotalsAndPerAgentCounts()
  testSelfReviewFallbackWhenNoIndependentReview()
  testBuildBurnupBuildsCumulativeSeries()
  testMonotoneCubicNeverOvershoots()
  testBuildAgentActivityTimelineDerivesHandoffs()
  testBuildAgentActivityTimelineOnlyTaskHolders()
  testBuildAgentActivityTimelineAttributesByPhase()
  testBuildAgentActivityTimelineEmptyCases()
  testBuildAgentTaskDetailJoinsTasksCountsAndFindings()
  testQualitySummaryRollsUpAcrossAgents()
  testQualitySummaryDistinguishesNoMeasuredData()
  testBuildAgentRowsJoinsRosterTasksAndMetrics()
  testBuildAgentRowsIncludesAnalysisOnlyAgents()
  testBuildRunReportDerivesStatusesNeedsInputAndFindings()
  testProcessHealthExcludesAgentPerformanceDimensions()
  testDurationFormatting()
  console.log('sprintengineRunSummary.test.ts: ok')
}

main()
