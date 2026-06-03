import React, { useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  CloseIconButton,
  FOCUS_RING_CLASS,
  PanelHeader,
  RoleGlyph,
  Section,
  StatusDot,
  type Tone,
} from '../ui'
import {
  agentIssueCount,
  bucketAgentRowsByWorkType,
  buildAgentTaskDetail,
  buildBurnup,
  buildIssueTotals,
  buildProcessHealth,
  buildRunReport,
  feedbackFindingAreaLabels,
  feedbackFindingKindLabels,
  findingSeverityOrder,
  formatRunDuration,
  formatSprintEngineGoal,
  measuredIssueTypes,
  type SprintEngineAgentRow,
  type SprintEngineAgentTaskDetail,
  type SprintEngineBurnup,
  type SprintEngineRunFinding,
  type SprintEngineRunReport,
} from '../../utils/sprintengineRunSummary'
import { IssueBars, ProgressRing, RunBurnupChart } from './runSummaryCharts'
import { formatSprintEngineLockAge, getSprintEngineRoleLabel } from '../../utils/sprintengine'
import type {
  SprintEngineAgentMetrics,
  SprintEngineArchitectDifficulty,
  SprintEngineFeedbackAnalysisData,
  SprintEngineProjectionSource,
  SprintEngineRoleId,
  SprintEngineState,
  SprintEngineTask,
  SprintEngineTaskFeedbackFindingSeverity,
  SprintEngineTaskStatus,
} from '../../types/workspace'

const projectionSourceLabel: Record<SprintEngineProjectionSource, string> = {
  folder_store: 'Folder store',
  unavailable: 'Projection unavailable',
}

const STATUS_LABEL: Record<SprintEngineTaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  changes_requested: 'Changes requested',
  review: 'In review',
  testing: 'In testing',
  product: 'Product check',
  needs_input: 'Needs input',
  done: 'Done',
}

const STATUS_TONE: Record<SprintEngineTaskStatus, Tone> = {
  todo: 'neutral',
  in_progress: 'accent',
  changes_requested: 'warn',
  review: 'accent',
  testing: 'accent',
  product: 'accent',
  needs_input: 'error',
  done: 'good',
}

const SEVERITY_TONE: Record<SprintEngineTaskFeedbackFindingSeverity, Tone> = {
  critical: 'error',
  high: 'error',
  medium: 'warn',
  low: 'neutral',
}

type Props = {
  workspaceId: string
  /** Dismiss control for the standalone (non-embedded) presentation. */
  onClose?: () => void
  /** Rendered inside the board as the "Summary" view — drops the panel's own
   *  header/close chrome since the board tab provides identity + navigation. */
  embedded?: boolean
  /** Open a task's detail (reuses the board inspector). When provided, task ids
   *  in the per-agent drill-down become clickable. */
  onOpenTask?: (taskId: string) => void
}

const TITLE_ID = 'sprintengine-run-summary-title'

type AnalysisState =
  | { status: 'loading'; analysis: null; architectDifficulty: null }
  | {
      status: 'ready'
      analysis: Record<string, SprintEngineAgentMetrics>
      architectDifficulty: SprintEngineArchitectDifficulty | null
    }
  | { status: 'error'; analysis: null; architectDifficulty: null; error: string }
  | { status: 'unavailable'; analysis: null; architectDifficulty: null }

export default function SprintEngineRunSummaryPanel({
  workspaceId,
  onClose,
  embedded = false,
  onOpenTask,
}: Props) {
  const sprintEngineState = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.sprintEngineState ?? null
  )
  const statePath = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.sprintEngineContext?.statePath ?? null
  )
  // Re-fetch the on-demand analysis when the run state changes.
  const stateUpdatedAt = sprintEngineState?.updatedAt ?? null

  const [analysisState, setAnalysisState] = useState<AnalysisState>({
    status: 'loading',
    analysis: null,
    architectDifficulty: null,
  })

  useEffect(() => {
    if (!statePath) {
      setAnalysisState({ status: 'unavailable', analysis: null, architectDifficulty: null })
      return
    }
    let cancelled = false
    setAnalysisState({ status: 'loading', analysis: null, architectDifficulty: null })
    window.api
      .summarizeSprintEngineFeedback(statePath)
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setAnalysisState({ status: 'error', analysis: null, architectDifficulty: null, error: result.message })
          return
        }
        const summary = (result.data as SprintEngineFeedbackAnalysisData | undefined)?.summary
        setAnalysisState({
          status: 'ready',
          analysis: summary?.aggregateByAgent ?? {},
          architectDifficulty: summary?.difficultyAnalytics?.architect ?? null,
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setAnalysisState({
          status: 'error',
          analysis: null,
          architectDifficulty: null,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    return () => {
      cancelled = true
    }
  }, [statePath, stateUpdatedAt])

  const report = useMemo<SprintEngineRunReport | null>(
    () => (sprintEngineState ? buildRunReport(sprintEngineState, analysisState.analysis) : null),
    [sprintEngineState, analysisState.analysis]
  )
  const processHealth = useMemo(
    () => (sprintEngineState ? buildProcessHealth(sprintEngineState.tasks) : []),
    [sprintEngineState]
  )
  const burnup = useMemo(
    () => (sprintEngineState ? buildBurnup(sprintEngineState) : null),
    [sprintEngineState]
  )

  if (!sprintEngineState || !report) {
    return (
      <PanelShell titleId={TITLE_ID} subtitle="Sprint Engine state is not available for this workspace." onClose={onClose} embedded={embedded}>
        <div className="border-l-2 border-[color:var(--border-strong)] pl-3 text-[13px] leading-6 text-[color:var(--text-muted)]">
          Open a Sprint Engine workspace to see its run summary.
        </div>
      </PanelShell>
    )
  }

  const durationLabel = formatRunDuration(report.runDurationMs)
  const issueTotals = buildIssueTotals(report.agentRows)
  const allDone = report.totalTasks > 0 && report.doneTasks === report.totalTasks
  const changesRequested = report.statusCounts.changes_requested ?? 0
  const attention = report.needsInput.length > 0 || changesRequested > 0
  const phase: { label: string; tone: Tone } =
    report.totalTasks === 0
      ? { label: 'No tasks recorded', tone: 'neutral' }
      : allDone && !attention
        ? { label: 'Complete', tone: 'good' }
        : allDone
          ? { label: 'Complete — needs your attention', tone: 'warn' }
          : attention
            ? { label: 'Needs your attention', tone: 'warn' }
            : { label: 'In progress', tone: 'accent' }

  // Open findings (not marked fixed/rejected) are leftovers that still need fixing.
  const openFindings = report.findings.filter(
    (finding) => finding.status !== 'fixed' && finding.status !== 'rejected'
  )
  const hasRemaining =
    report.needsInput.length > 0 || report.remaining.length > 0 || openFindings.length > 0

  return (
    <PanelShell
      titleId={TITLE_ID}
      subtitle={formatSprintEngineGoal(sprintEngineState.goal)}
      onClose={onClose}
      embedded={embedded}
    >
      <ProjectionStatusBanner state={sprintEngineState} />

      {/* Verdict — the one clear visual priority */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pb-3">
        <span className="inline-flex items-center gap-2 text-[16px] font-semibold text-[color:var(--text-strong)]">
          <StatusDot tone={phase.tone} label={phase.label} />
          {phase.label}
        </span>
        {report.totalTasks > 0 ? (
          <span className="flex flex-wrap items-baseline gap-x-2 text-[12px] tabular-nums text-[color:var(--text-muted)]">
            <Crumb>{`${report.doneTasks} / ${report.totalTasks} tasks done`}</Crumb>
            {report.needsInput.length > 0 ? (
              <Crumb>{`${report.needsInput.length} need input`}</Crumb>
            ) : null}
            {changesRequested > 0 ? <Crumb>{`${changesRequested} changes requested`}</Crumb> : null}
            {durationLabel ? <Crumb>{`ran ${durationLabel}`}</Crumb> : null}
          </span>
        ) : null}
      </div>

      {report.totalTasks === 0 ? (
        <div className="border-l-2 border-[color:var(--border-strong)] pl-3 text-[13px] leading-6 text-[color:var(--text-muted)]">
          This run has no tasks yet. Configure a roster and dispatch work to populate the summary.
        </div>
      ) : (
        <>
          {/* Overview → output → the real measured issues → who, in detail. */}
          <RunOverviewSection report={report} burnup={burnup} durationLabel={durationLabel} />
          <RunMetricsSection report={report} />
          <IssuesCaughtSection issueTotals={issueTotals} />
          <AgentBreakdownSection
            report={report}
            tasks={sprintEngineState.tasks}
            analysisStatus={analysisState.status}
            analysisError={analysisState.status === 'error' ? analysisState.error : undefined}
            architectDifficulty={analysisState.architectDifficulty}
            planQuality={processHealth}
            onOpenTask={onOpenTask}
          />
          {/* Lower-priority: what still needs a human, at the bottom. */}
          {hasRemaining ? <WhatsLeftSection report={report} openFindings={openFindings} /> : null}

          <div className="mt-4 border-l-2 border-[color:var(--tone-warn)] pl-3 text-[13px] leading-6 text-[color:var(--text-default)]">
            <span className="text-[color:var(--text-strong)]">Next step:</span> manually test the
            uncommitted changes in the workspace before committing or reverting.
          </div>
        </>
      )}
    </PanelShell>
  )
}

function PanelShell({
  titleId,
  subtitle,
  onClose,
  embedded,
  children,
}: {
  titleId: string
  subtitle: string
  onClose?: () => void
  embedded?: boolean
  children: React.ReactNode
}) {
  return (
    <section
      aria-labelledby={embedded ? undefined : titleId}
      aria-label={embedded ? 'Run summary' : undefined}
      className="flex h-full min-h-0 flex-col bg-[color:var(--bg-app)] text-[color:var(--text-default)]"
    >
      {embedded ? null : (
        <div className="relative shrink-0 bg-[color:var(--bg-surface)]">
          <PanelHeader
            tool="sprintengine"
            title="Run summary"
            titleId={titleId}
            subtitle={subtitle}
            overflow={
              onClose ? (
                <div className="flex items-center gap-2">
                  <kbd className="hidden rounded border border-[color:var(--border-default)] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--text-muted)] sm:inline-block">
                    Esc
                  </kbd>
                  <CloseIconButton onClick={onClose} aria-label="Close run summary" />
                </div>
              ) : undefined
            }
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Embedded (board Summary tab) fills the board content width; the
            standalone presentation keeps a centered reading column. */}
        <div className={embedded ? 'w-full px-6 py-5' : 'mx-auto w-full max-w-[960px] px-5 py-5'}>
          {children}
        </div>
      </div>
    </section>
  )
}

function Crumb({ children }: { children: React.ReactNode }) {
  return (
    <span className="before:mx-2 before:text-[color:var(--text-disabled)] before:content-['·'] first:before:hidden">
      {children}
    </span>
  )
}

function highestFindingTone(bySeverity: Record<string, number>): Tone {
  for (const severity of findingSeverityOrder) {
    if (bySeverity[severity]) return SEVERITY_TONE[severity]
  }
  return 'neutral'
}

// "—" for no data, the number (incl. 0) when data exists.
const NA = <span className="text-[color:var(--text-disabled)]">—</span>

// Shared table header classes. Numeric headers right-align over their data; the
// agent header is left-aligned (kept distinct so text-right/text-left never collide).
const HEADER_BASE =
  'border-b border-[color:var(--border-subtle)] pb-1.5 text-[11px] font-medium text-[color:var(--text-muted)] whitespace-nowrap'
const NUM_HEADER = `${HEADER_BASE} px-3 text-right`
const AGENT_HEADER = `${HEADER_BASE} pr-3 text-left`
const COL_SEP = 'border-l border-[color:var(--border-subtle)]'
// Issue-type headers carry full labels that wrap to two lines (no `whitespace-nowrap`),
// bottom-aligned so they sit just above the numbers. Shares the data cells' px-3
// so header and number right-edges line up.
const ISSUE_HEADER =
  'border-b border-[color:var(--border-subtle)] pb-1.5 px-3 align-bottom text-right text-[11px] font-medium leading-tight text-[color:var(--text-muted)]'

function AgentName({ role, agentId, idle }: { role: SprintEngineRoleId; agentId: string; idle?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-2 whitespace-nowrap pl-[20px]">
      <RoleGlyph role={role} size="sm" className="translate-y-[2px]" />
      <span className="font-mono text-[12px] text-[color:var(--text-strong)]">{agentId}</span>
      {idle ? <span className="text-[11px] text-[color:var(--text-disabled)]">idle</span> : null}
    </span>
  )
}

function AgentBreakdownSection({
  report,
  tasks,
  analysisStatus,
  analysisError,
  architectDifficulty,
  planQuality,
  onOpenTask,
}: {
  report: SprintEngineRunReport
  tasks: SprintEngineTask[]
  analysisStatus: AnalysisState['status']
  analysisError?: string
  architectDifficulty: SprintEngineArchitectDifficulty | null
  planQuality: ReturnType<typeof buildProcessHealth>
  onOpenTask?: (taskId: string) => void
}) {
  const [showIdle, setShowIdle] = useState(false)

  const activeRows = report.agentRows.filter((row) => row.tasksDone > 0 || row.metrics !== null)
  const idleRows = report.agentRows.filter((row) => row.tasksDone === 0 && row.metrics === null)
  const {
    implementation: implRows,
    review: reviewRows,
    planning: planningRows,
  } = bucketAgentRowsByWorkType(activeRows)

  return (
    <SectionDivider>
      <Section title="Per-agent breakdown" count={activeRows.length} level={3}>
        {analysisStatus === 'error' ? (
          <div className="mb-2 border-l-2 border-[color:var(--tone-error)] pl-3 text-[12px] leading-5 text-[color:var(--tone-error)]">
            Couldn't load agent metrics{analysisError ? `: ${analysisError}` : '.'} Roster and task
            counts below are from the run state.
          </div>
        ) : analysisStatus === 'unavailable' ? (
          <div className="mb-2 border-l-2 border-[color:var(--border-strong)] pl-3 text-[12px] leading-5 text-[color:var(--text-muted)]">
            Agent metrics are unavailable for this run.
          </div>
        ) : null}

        {implRows.length > 0 ? (
          <ImplementationTable
            rows={implRows}
            tasks={tasks}
            loading={analysisStatus === 'loading'}
            onOpenTask={onOpenTask}
          />
        ) : null}
        {reviewRows.length > 0 ? <ReviewTable rows={reviewRows} /> : null}
        {planningRows.length > 0 || architectDifficulty || planQuality.length > 0 ? (
          <PlanningTable
            rows={planningRows}
            architectDifficulty={architectDifficulty}
            planQuality={planQuality}
          />
        ) : null}

        {idleRows.length > 0 ? (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setShowIdle((value) => !value)}
              aria-expanded={showIdle}
              className={`inline-flex items-baseline gap-1.5 rounded-sm text-[12px] text-[color:var(--text-muted)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
            >
              <span aria-hidden="true" className="text-[11px] text-[color:var(--text-disabled)]">
                {showIdle ? '▾' : '▸'}
              </span>
              {showIdle
                ? 'Hide idle agents'
                : `Show ${idleRows.length} idle agent${idleRows.length === 1 ? '' : 's'}`}
            </button>
            {showIdle ? (
              <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1.5">
                {idleRows.map((row) => (
                  <li key={row.agentId}>
                    <AgentName role={row.role} agentId={row.agentId} idle />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </Section>
    </SectionDivider>
  )
}

// Implementers: tasks done + the issues reviewers flagged in their work, one
// column per issue type. Rows expand to per-task detail.
function ImplementationTable({
  rows,
  tasks,
  loading,
  onOpenTask,
}: {
  rows: SprintEngineAgentRow[]
  tasks: SprintEngineTask[]
  loading: boolean
  onOpenTask?: (taskId: string) => void
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (agentId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(agentId)) next.delete(agentId)
      else next.add(agentId)
      return next
    })
  return (
    <div className="mt-1">
      <WorkTypeHeading label="Implementation" count={rows.length} />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              <th scope="col" className={AGENT_HEADER}>
                Agent
              </th>
              <th scope="col" className={NUM_HEADER}>
                Tasks
              </th>
              {measuredIssueTypes.map((type, index) => (
                <th
                  key={type.key}
                  scope="col"
                  // Full label, wrapping to two lines, bottom-aligned over the
                  // numbers — so "Implementation mistakes" reads in full without
                  // a wide column or a cryptic abbreviation.
                  className={`${ISSUE_HEADER}${index === 0 ? ` ${COL_SEP}` : ''}`}
                >
                  {type.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const detail = buildAgentTaskDetail(row.agentId, tasks, row.metrics)
              const isExpanded = expanded.has(row.agentId)
              return (
                <React.Fragment key={row.agentId}>
                  <AgentRow
                    row={row}
                    loading={loading}
                    sep={COL_SEP}
                    expandable={detail.length > 0}
                    expanded={isExpanded}
                    onToggle={() => toggle(row.agentId)}
                  />
                  {isExpanded && detail.length > 0 ? (
                    <AgentDetailRow detail={detail} onOpenTask={onOpenTask} />
                  ) : null}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// Reviewers: what they reviewed and how they ruled.
function ReviewTable({ rows }: { rows: SprintEngineAgentRow[] }) {
  return (
    <div className="mt-5">
      <WorkTypeHeading label="Review" count={rows.length} />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              <th scope="col" className={AGENT_HEADER}>
                Agent
              </th>
              <th scope="col" className={`${NUM_HEADER} ${COL_SEP}`}>
                Reviews
              </th>
              <th scope="col" className={NUM_HEADER}>
                Tasks reviewed
              </th>
              <th scope="col" className={NUM_HEADER}>
                Approved
              </th>
              <th scope="col" className={NUM_HEADER}>
                Changes requested
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const reviewer = row.metrics?.reviewer
              const border = 'border-b border-[color:var(--border-subtle)]'
              const changes = reviewer?.changesRequested ?? 0
              return (
                <tr key={row.agentId}>
                  <td className={`${border} py-[7px] pr-6`}>
                    <AgentName role={row.role} agentId={row.agentId} />
                  </td>
                  <NumCellB border={border} sep={COL_SEP}>
                    {reviewer ? reviewer.reviewsPerformed : NA}
                  </NumCellB>
                  <NumCellB border={border}>{reviewer ? reviewer.tasksReviewed : NA}</NumCellB>
                  <NumCellB border={border}>{reviewer ? reviewer.approved : NA}</NumCellB>
                  <NumCellB border={border}>
                    {!reviewer ? (
                      NA
                    ) : changes > 0 ? (
                      <span className="text-[color:var(--tone-warn)]">{changes}</span>
                    ) : (
                      <span className="text-[color:var(--text-disabled)]">0</span>
                    )}
                  </NumCellB>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// Planners: the architect's estimation accuracy (run-level) + planner task counts.
function PlanningTable({
  rows,
  architectDifficulty,
  planQuality,
}: {
  rows: SprintEngineAgentRow[]
  architectDifficulty: SprintEngineArchitectDifficulty | null
  planQuality: ReturnType<typeof buildProcessHealth>
}) {
  const qualitySamples = planQuality.length
    ? Math.max(...planQuality.map((stat) => stat.sampleCount))
    : 0
  return (
    <div className="mt-5">
      <WorkTypeHeading label="Planning" count={rows.length > 0 ? rows.length : undefined} />
      {architectDifficulty ? (
        <div className="mb-2.5 flex flex-wrap gap-x-7 gap-y-1 text-[12px] text-[color:var(--text-muted)]">
          <span>
            Architect estimate accuracy{' '}
            <span className="tabular-nums text-[color:var(--text-default)]">
              ±{architectDifficulty.mean_absolute_error_pct}%
            </span>{' '}
            <span className="text-[color:var(--text-disabled)]">avg error</span>
          </span>
          <span>
            Bias{' '}
            <span className="tabular-nums text-[color:var(--text-default)]">
              {architectDifficulty.bias_pct > 0 ? '+' : ''}
              {architectDifficulty.bias_pct}%
            </span>
          </span>
          <span className="tabular-nums text-[color:var(--text-disabled)]">
            {architectDifficulty.sampleCount} estimate{architectDifficulty.sampleCount === 1 ? '' : 's'}
          </span>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr>
                <th scope="col" className={AGENT_HEADER}>
                  Agent
                </th>
                <th scope="col" className={`${NUM_HEADER} ${COL_SEP}`}>
                  Tasks
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const border = 'border-b border-[color:var(--border-subtle)]'
                return (
                  <tr key={row.agentId}>
                    <td className={`${border} py-[7px] pr-6`}>
                      <AgentName role={row.role} agentId={row.agentId} />
                    </td>
                    <NumCellB border={border} sep={COL_SEP}>
                      {row.tasksDone}
                    </NumCellB>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {planQuality.length > 0 ? (
        <div className="mt-4">
          <div className="mb-2 flex items-baseline gap-1.5 text-[12px] text-[color:var(--text-muted)]">
            Plan &amp; setup quality
            <span className="text-[11px] text-[color:var(--text-disabled)]">
              rated by the team across {qualitySamples} task{qualitySamples === 1 ? '' : 's'}
            </span>
          </div>
          <div className="grid gap-x-8 gap-y-1.5 md:grid-cols-2">
            {planQuality.map((stat) => (
              <div
                key={stat.key}
                className="grid grid-cols-[140px_1fr_auto] items-center gap-2.5 py-0.5"
                aria-label={`${stat.label}: ${stat.averagePct} percent, rated across ${stat.sampleCount} task${stat.sampleCount === 1 ? '' : 's'}`}
              >
                <span className="text-[12px] text-[color:var(--text-muted)]">{stat.label}</span>
                <span
                  aria-hidden="true"
                  className="h-1 overflow-hidden rounded-full bg-[color:var(--border-subtle)]"
                >
                  <span
                    className="block h-full rounded-full bg-[color:var(--text-muted)]"
                    style={{ width: `${stat.averagePct}%` }}
                  />
                </span>
                <span className="text-right text-[12px] tabular-nums text-[color:var(--text-default)]">
                  {stat.averagePct}%
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function WorkTypeHeading({ label, count }: { label: string; count?: number }) {
  return (
    <div className="mb-1.5 flex items-baseline gap-1.5 text-[12px] font-medium text-[color:var(--text-muted)]">
      {label}
      {count !== undefined ? (
        <span className="tabular-nums text-[color:var(--text-disabled)]">{count}</span>
      ) : null}
    </div>
  )
}

function AgentRow({
  row,
  loading,
  sep,
  expandable,
  expanded,
  onToggle,
}: {
  row: SprintEngineAgentRow
  loading: boolean
  sep: string
  expandable: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const metrics = row.metrics
  const idle = !metrics && row.tasksDone === 0
  const rowClass = idle ? 'text-[color:var(--text-disabled)]' : ''
  // The detail row carries the bottom hairline when expanded, so the agent row
  // drops its own border to avoid a double line.
  const cellBorder = expanded ? '' : 'border-b border-[color:var(--border-subtle)]'

  // While metrics are still loading we show "…" rather than a misleading "—".
  const pending = loading && !metrics
  const dash = pending ? <span className="text-[color:var(--text-disabled)]">…</span> : NA
  const bugSeverity = metrics?.measured.findingsAgainst?.bySeverity ?? {}

  // Fixed-width disclosure slot so expandable and non-expandable rows share the
  // exact same left edge for the glyph + id.
  const chevron = (
    <span
      aria-hidden="true"
      className={`inline-block w-3 text-[11px] leading-none transition-colors ${
        expanded
          ? 'text-[color:var(--accent-primary)]'
          : 'text-[color:var(--text-disabled)] group-hover:text-[color:var(--text-muted)]'
      }`}
    >
      {expandable ? (expanded ? '▾' : '▸') : ''}
    </span>
  )
  const identity = (
    <>
      {chevron}
      <RoleGlyph role={row.role} size="sm" className="translate-y-[2px]" />
      <span className="font-mono text-[12px] text-[color:var(--text-strong)]">{row.agentId}</span>
      {idle ? <span className="text-[11px] text-[color:var(--text-disabled)]">idle</span> : null}
    </>
  )

  return (
    <tr className={rowClass}>
      <td className={`${cellBorder} py-[7px] pr-6`}>
        {/* glyph + id already encode the role — the verbose role label was
            dropped to give the numeric columns room to breathe. */}
        {expandable ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className={`group inline-flex items-baseline gap-2 whitespace-nowrap rounded-sm text-left ${FOCUS_RING_CLASS}`}
          >
            {identity}
          </button>
        ) : (
          <span className="inline-flex items-baseline gap-2 whitespace-nowrap">{identity}</span>
        )}
      </td>
      {/* tasksDone is always-known structural data — show 0, not "—". */}
      <NumCellB border={cellBorder}>{row.tasksDone}</NumCellB>
      {measuredIssueTypes.map((type, index) => {
        const count = agentIssueCount(metrics, type.key)
        let content: React.ReactNode
        if (count === null) {
          content = dash
        } else if (type.key === 'bugs' && count > 0) {
          content = (
            <span className="inline-flex items-baseline justify-end gap-1.5">
              <StatusDot tone={highestFindingTone(bugSeverity)} className="-translate-y-px" />
              {count}
            </span>
          )
        } else {
          // Zero defects read as a muted "0" so real defect counts pop.
          content = count === 0 ? <span className="text-[color:var(--text-disabled)]">0</span> : count
        }
        return (
          <NumCellB key={type.key} border={cellBorder} sep={index === 0 ? sep : undefined}>
            {content}
          </NumCellB>
        )
      })}
    </tr>
  )
}

function NumCellB({
  children,
  border,
  sep,
}: {
  children: React.ReactNode
  border: string
  sep?: string
}) {
  return (
    <td className={`${border} ${sep ?? ''} py-[7px] px-3 text-right tabular-nums`}>{children}</td>
  )
}

function AgentDetailRow({
  detail,
  onOpenTask,
}: {
  detail: SprintEngineAgentTaskDetail[]
  onOpenTask?: (taskId: string) => void
}) {
  return (
    <tr>
      <td
        colSpan={2 + measuredIssueTypes.length}
        className="border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3 py-3"
      >
        <ul className="space-y-3">
          {detail.map((task) => (
            <li key={task.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2.5">
              <StatusDot tone={STATUS_TONE[task.status]} className="translate-y-[6px]" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  {onOpenTask ? (
                    <button
                      type="button"
                      onClick={() => onOpenTask(task.id)}
                      aria-label={`Open task ${task.id}`}
                      className={`group inline-flex min-w-0 items-baseline gap-2 rounded-sm text-left ${FOCUS_RING_CLASS}`}
                    >
                      <span className="font-mono text-[11px] text-[color:var(--text-muted)] group-hover:text-[color:var(--accent-primary)]">
                        {task.id}
                      </span>
                      <span className="text-[13px] text-[color:var(--text-default)] underline-offset-2 [overflow-wrap:anywhere] group-hover:text-[color:var(--text-strong)] group-hover:underline">
                        {task.title}
                      </span>
                    </button>
                  ) : (
                    <>
                      <span className="font-mono text-[11px] text-[color:var(--text-muted)]">
                        {task.id}
                      </span>
                      <span className="text-[13px] text-[color:var(--text-default)] [overflow-wrap:anywhere]">
                        {task.title}
                      </span>
                    </>
                  )}
                  <span className="text-[11px] text-[color:var(--text-disabled)]">
                    {STATUS_LABEL[task.status]}
                  </span>
                </div>
                {task.defects.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[color:var(--text-muted)]">
                    {task.defects.map((defect) => (
                      <span key={defect.key} className="whitespace-nowrap">
                        <span className="tabular-nums text-[color:var(--text-default)]">
                          {defect.count}
                        </span>{' '}
                        {defect.label.toLowerCase()}
                      </span>
                    ))}
                  </div>
                ) : null}
                {task.findings.length > 0 ? (
                  <ul className="mt-1.5 space-y-1.5">
                    {task.findings.map((finding) => (
                      <FindingItem
                        key={`${finding.taskId}-${finding.kind}-${finding.area}-${finding.title}`}
                        finding={finding}
                        hideTaskId
                      />
                    ))}
                  </ul>
                ) : null}
                {task.defects.length === 0 && task.findings.length === 0 ? (
                  <div className="mt-0.5 text-[12px] text-[color:var(--text-disabled)]">
                    {task.reviewCount > 0
                      ? 'Reviewed — no issues recorded.'
                      : 'No review signals recorded.'}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </td>
    </tr>
  )
}

// Shared expandable finding: summary line that opens to reveal the reviewer's
// full description + recommendation. Used in the issues list and the per-agent
// drill-down (where the task id is already shown by the task header).
function FindingItem({
  finding,
  hideTaskId = false,
}: {
  finding: SprintEngineRunFinding
  hideTaskId?: boolean
}) {
  const [open, setOpen] = useState(false)
  const hasDetail = Boolean(finding.detail || finding.recommendation || finding.file)
  const meta = (
    <span className="mt-0.5 block text-[12px] text-[color:var(--text-muted)]">
      {feedbackFindingKindLabels[finding.kind]} · {feedbackFindingAreaLabels[finding.area]}
      {finding.status === 'fixed' ? ' · fixed' : ''}
    </span>
  )
  return (
    <li className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-2">
      <StatusDot tone={SEVERITY_TONE[finding.severity]} className="translate-y-[5px]" />
      {hideTaskId ? (
        <span />
      ) : (
        <span className="font-mono text-[11px] text-[color:var(--text-muted)]">
          {finding.taskId}
        </span>
      )}
      <span className="min-w-0">
        {hasDetail ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className={`rounded-sm text-left ${FOCUS_RING_CLASS}`}
          >
            <span className="text-[13px] text-[color:var(--text-default)] [overflow-wrap:anywhere]">
              {finding.title}
            </span>
            <span aria-hidden="true" className="ml-1 text-[11px] text-[color:var(--text-disabled)]">
              {open ? '▾' : '▸'}
            </span>
          </button>
        ) : (
          <span className="text-[13px] text-[color:var(--text-default)] [overflow-wrap:anywhere]">
            {finding.title}
          </span>
        )}
        {meta}
        {open && hasDetail ? (
          <div className="mt-1 border-l-2 border-[color:var(--border-strong)] pl-2.5 text-[12px] leading-5 text-[color:var(--text-muted)]">
            {finding.detail ? <p className="[overflow-wrap:anywhere]">{finding.detail}</p> : null}
            {finding.recommendation ? (
              <p className="mt-1 [overflow-wrap:anywhere]">
                <span className="text-[color:var(--text-default)]">Recommendation: </span>
                {finding.recommendation}
              </p>
            ) : null}
            {finding.file ? (
              <p className="mt-1 font-mono text-[11px] text-[color:var(--text-disabled)] [overflow-wrap:anywhere]">
                {finding.file}
              </p>
            ) : null}
          </div>
        ) : null}
      </span>
    </li>
  )
}

function IssuesCaughtSection({
  issueTotals,
}: {
  issueTotals: ReturnType<typeof buildIssueTotals>
}) {
  return (
    <SectionDivider>
      <Section
        title="Issues caught in review"
        count={issueTotals.total > 0 ? issueTotals.total : undefined}
        action={
          <span className="text-[12px] text-[color:var(--text-disabled)]">
            flagged by reviewers during the run
          </span>
        }
        level={3}
      >
        {issueTotals.hasMeasured ? (
          <IssueBars items={issueTotals.items} />
        ) : (
          <p className="text-[12px] text-[color:var(--text-disabled)]">
            No issues were flagged by reviewers this run.
          </p>
        )}
      </Section>
    </SectionDivider>
  )
}

function WhatsLeftSection({
  report,
  openFindings,
}: {
  report: SprintEngineRunReport
  openFindings: SprintEngineRunFinding[]
}) {
  const total = openFindings.length + report.needsInput.length + report.remaining.length
  const remainingStatusCounts = report.remaining.reduce<Partial<Record<SprintEngineTaskStatus, number>>>(
    (acc, task) => {
      acc[task.status] = (acc[task.status] ?? 0) + 1
      return acc
    },
    {}
  )

  return (
    <SectionDivider>
      <Section title="What's left" count={total} level={3}>
        {openFindings.length > 0 ? (
          <>
            <SubHead label="Remaining issues — not yet fixed" count={openFindings.length} />
            <ul className="space-y-1.5">
              {openFindings.map((finding) => (
                <FindingItem
                  key={`${finding.taskId}-${finding.kind}-${finding.area}-${finding.title}`}
                  finding={finding}
                />
              ))}
            </ul>
          </>
        ) : null}

        {report.needsInput.length > 0 ? (
          <>
            <SubHead label="Needs your input" count={report.needsInput.length} />
            <ul>
              {report.needsInput.map((item) => (
                <LeftRow key={item.taskId} tone="error" id={item.taskId} title={item.reason} meta={getSprintEngineRoleLabel(item.role)} />
              ))}
            </ul>
          </>
        ) : null}

        {report.remaining.length > 0 ? (
          <>
            <SubHead label="Still open" count={report.remaining.length} />
            <div className="flex flex-wrap gap-x-5 gap-y-1.5 pb-2 pt-0.5">
              {(Object.keys(remainingStatusCounts) as SprintEngineTaskStatus[]).map((status) => (
                <span key={status} className="inline-flex items-baseline gap-1.5 text-[12px]">
                  <StatusDot tone={STATUS_TONE[status]} className="translate-y-px" />
                  <span className="text-[color:var(--text-default)]">{STATUS_LABEL[status]}</span>
                  <span className="tabular-nums text-[color:var(--text-muted)]">
                    {remainingStatusCounts[status]}
                  </span>
                </span>
              ))}
            </div>
            <ul>
              {report.remaining.map((task) => (
                <LeftRow
                  key={task.id}
                  tone={STATUS_TONE[task.status]}
                  id={task.id}
                  title={task.title}
                  meta={getSprintEngineRoleLabel(task.role)}
                />
              ))}
            </ul>
          </>
        ) : null}
      </Section>
    </SectionDivider>
  )
}

function SubHead({ label, count }: { label: string; count: number }) {
  return (
    <div className="mb-1 mt-3 flex items-baseline gap-1.5 text-[12px] text-[color:var(--text-muted)] first:mt-0">
      {label}
      <span className="tabular-nums text-[color:var(--text-disabled)]">{count}</span>
    </div>
  )
}

function LeftRow({
  tone,
  id,
  title,
  meta,
}: {
  tone: Tone
  id: string
  title: string
  meta?: string
}) {
  return (
    <li className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-2 border-t border-[color:var(--border-subtle)] py-1.5 first:border-t-0">
      <StatusDot tone={tone} className="translate-y-[5px]" />
      <span className="font-mono text-[11px] text-[color:var(--text-muted)]">{id}</span>
      <span className="min-w-0">
        <span className="text-[13px] text-[color:var(--text-default)] [overflow-wrap:anywhere]">
          {title}
        </span>
        {meta ? (
          <span className="mt-0.5 block text-[12px] text-[color:var(--text-muted)]">{meta}</span>
        ) : null}
      </span>
    </li>
  )
}

type StatCell = { label: string; value: React.ReactNode; inverse?: boolean }

function StatStrip({ cells, columns }: { cells: StatCell[]; columns: string }) {
  return (
    <div className={`grid grid-cols-2 sm:grid-cols-3 ${columns}`}>
      {cells.map((cell, index) => (
        <div
          key={cell.label}
          className={`py-0.5 ${index === 0 ? 'pl-0 pr-4' : 'border-l border-[color:var(--border-subtle)] px-4'}`}
        >
          <div className="text-[12px] text-[color:var(--text-muted)]">
            {cell.label}
            {cell.inverse ? <span className="text-[color:var(--text-disabled)]"> ↓</span> : null}
          </div>
          <div className="mt-0.5 text-[20px] font-semibold tabular-nums text-[color:var(--text-strong)]">
            {cell.value}
          </div>
        </div>
      ))}
    </div>
  )
}

function RunOverviewSection({
  report,
  burnup,
  durationLabel,
}: {
  report: SprintEngineRunReport
  burnup: SprintEngineBurnup | null
  durationLabel: string | null
}) {
  const completionPct =
    report.totalTasks > 0 ? Math.round((report.doneTasks / report.totalTasks) * 100) : 0
  const gatesPct =
    report.metrics.gatesTotal > 0
      ? Math.round((report.metrics.gatesApproved / report.metrics.gatesTotal) * 100)
      : 0
  return (
    <Section title="Run overview" level={3}>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-5">
        <div className="flex items-center gap-7">
          <ProgressRing
            valuePct={completionPct}
            primaryLabel={`${completionPct}%`}
            sublabel={`${report.doneTasks} / ${report.totalTasks}`}
            caption="Tasks done"
            tone="good"
          />
          {report.metrics.gatesTotal > 0 ? (
            <ProgressRing
              valuePct={gatesPct}
              primaryLabel={`${gatesPct}%`}
              sublabel={`${report.metrics.gatesApproved} / ${report.metrics.gatesTotal}`}
              caption="Gates passed"
              tone="accent"
            />
          ) : null}
        </div>
        {burnup ? (
          <div className="min-w-[280px] flex-1">
            <RunBurnupChart burnup={burnup} totalTasks={report.totalTasks} durationLabel={durationLabel} />
          </div>
        ) : null}
      </div>
    </Section>
  )
}

function RunMetricsSection({ report }: { report: SprintEngineRunReport }) {
  const cells: StatCell[] = [
    { label: 'Files touched', value: report.metrics.filesTouched },
    { label: 'Commands', value: report.metrics.commands },
    { label: 'Validations', value: report.metrics.validations },
    {
      label: 'Gates passed',
      value:
        report.metrics.gatesTotal > 0
          ? `${report.metrics.gatesApproved} / ${report.metrics.gatesTotal}`
          : '—',
    },
    { label: 'Findings', value: report.metrics.findings },
  ]
  return (
    <SectionDivider>
      <Section title="Run metrics" level={3}>
        <StatStrip cells={cells} columns="md:grid-cols-5" />
      </Section>
    </SectionDivider>
  )
}

function SectionDivider({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 border-t border-[color:var(--border-subtle)] pt-2">{children}</div>
}

function ProjectionStatusBanner({ state }: { state: SprintEngineState }) {
  // Only surface the projection row when something is actually wrong — a healthy
  // folder-store projection is internal plumbing the user doesn't need to see.
  const projection = state.projection
  const lockWarnings = state.locks?.warnings ?? []
  const hasError = projection?.source === 'unavailable' || Boolean(projection?.errorMessage)
  if (!hasError && lockWarnings.length === 0) return null

  const source: SprintEngineProjectionSource = projection?.source ?? 'folder_store'
  const tone: Tone = hasError ? 'error' : 'warn'

  return (
    <div className="mb-4 border-l-2 border-[color:var(--border-strong)] pl-3 text-[12px] leading-5 text-[color:var(--text-default)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={tone} />
          <span className="font-mono text-[11px] text-[color:var(--text-muted)]">Projection</span>
        </span>
        <span className="text-[color:var(--text-default)]">{projectionSourceLabel[source]}</span>
        {projection?.errorMessage ? (
          <span className="text-[color:var(--tone-error)] [overflow-wrap:anywhere]">
            {projection.errorMessage}
          </span>
        ) : null}
      </div>
      {lockWarnings.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-[color:var(--tone-warn)]">
          {lockWarnings.map((warning) => (
            <li key={warning.name} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              <span className="font-mono text-[11px]">{warning.name}</span>
              <span className="[overflow-wrap:anywhere]">
                {warning.message} ({formatSprintEngineLockAge(warning.ageSeconds)})
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
