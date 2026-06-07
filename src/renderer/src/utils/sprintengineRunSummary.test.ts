import assert from 'node:assert/strict'
import {
  agentIssueCount,
  buildAgentRows,
  buildAgentTaskDetail,
  buildAgentTypeSummary,
  buildBurnup,
  buildIssueTotals,
  buildProcessHealth,
  buildRunQualitySummary,
  buildRunReport,
  compareCliDeliveryScores,
  computeRunDurationMs,
  formatRunDuration,
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
            agentId: 'code_reviewer-1',
            role: 'developer',
            scores: {},
            findings: [{ id: 'F2', kind: 'security_issue', severity: 'critical', area: 'security', title: 'sev', detail: '' }],
          },
        ],
        qualityGates: [
          { id: 'g1', phase: 'review', role: 'code_reviewer', status: 'approved', required: true, allowSelfReview: false, attempts: [] },
          { id: 'g2', phase: 'testing', role: 'tester', status: 'pending', required: true, allowSelfReview: false, attempts: [] },
        ],
      }),
      makeTask({
        id: 'T2',
        status: 'needs_input',
        role: 'frontend',
        needsInput: { kind: 'user', question: 'Which datastore?' },
        notes: ['Pending a decision on persistence'],
      }),
      makeTask({ id: 'T3', status: 'changes_requested', role: 'developer' }),
    ],
  })

  const report = buildRunReport(state, null)

  assert.equal(report.totalTasks, 3)
  assert.equal(report.doneTasks, 1)
  assert.equal(report.statusCounts.needs_input, 1)
  assert.equal(report.statusCounts.changes_requested, 1)

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
  assert.equal(report.metrics.gatesApproved, 1)
  assert.equal(report.metrics.gatesTotal, 2)

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
          agentId: 'code_reviewer-1',
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
    { agentId: 'code_reviewer-1', role: 'code_reviewer', status: 'done', tasksDone: 2, metrics: null },
    { agentId: 'ui_ux_reviewer-1', role: 'ui_ux_reviewer', status: 'done', tasksDone: 1, metrics: null },
    { agentId: 'architect-1', role: 'architect', status: 'done', tasksDone: 2, metrics: null },
  ]
  const cliByAgent = {
    'developer-1': 'codex',
    'developer-2': 'codex',
    'frontend-1': 'claude-code',
    'code_reviewer-1': 'claude-code',
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

function main(): void {
  testAgentTypeSummaryGroupsByRoleAndCli()
  testCompareCliDeliveryScores()
  testIssueTotalsAndPerAgentCounts()
  testBuildBurnupBuildsCumulativeSeries()
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
