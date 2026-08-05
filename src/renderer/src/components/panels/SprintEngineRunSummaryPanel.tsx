import React, { useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  CloseIconButton,
  EmptyState,
  FOCUS_RING_CLASS,
  InlineNotice,
  type InlineNoticeTone,
  LifecycleGlyph,
  PanelHeader,
  RoleGlyph,
  Section,
  StatusDot,
  Table,
  Tooltip,
  TruncatedText,
  type LifecycleState,
  type Tone,
} from '../ui'
import {
  agentIssueSignal,
  buildAgentTaskDetail,
  buildAgentTypeSummary,
  bucketAgentRowsByWorkType,
  buildAgentActivityTimeline,
  buildBurnup,
  buildIssueTotals,
  buildProcessHealth,
  buildRunReport,
  compareCliDeliveryScores,
  feedbackFindingAreaLabels,
  feedbackFindingKindLabels,
  findingSeverityOrder,
  formatRunDuration,
  formatSprintEngineGoal,
  measuredIssueTypes,
  type SprintEngineAgentRow,
  type SprintEngineAgentTaskDetail,
  type SprintEngineAgentTypeSummary,
  type SprintEngineBurnup,
  type SprintEngineRunFinding,
  type SprintEngineRunReport,
  type SprintEngineTypeStat,
} from '../../utils/sprintengineRunSummary'
import { AgentActivityTimeline, IssueBars, ProgressRing, RunBurnupChart } from './runSummaryCharts'
import {
  describeTokenCoverage,
  formatTokenCount,
  tokenReportHasAgents,
} from '../../utils/sprintengineTokenUsage'
import { useSprintEngineTokenUsage } from '../../hooks/useSprintEngineTokenUsage'
import type {
  SprintEngineModelTokenUsage,
  SprintEngineTokenUsageReport,
} from '../../../../shared/sprintengine-token-usage'
import {
  SPRINT_ENGINE_ROLELESS_KEY,
  deriveSprintEngineRepoMergeRollup,
  deriveSprintEngineRunGlyph,
  formatSprintEngineLockAge,
  getSprintEngineRoleLabel,
} from '../../utils/sprintengine'
import { RunPullRequestViewChip } from './runPullRequest'
import CliIcon from '../CliIcon'
import type {
  AgentCli,
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

// Stable empty reference for the agents selector — a fresh `{}` each render would
// trip Zustand v5's "getSnapshot should be cached" guard.
const EMPTY_AGENTS: Record<string, never> = {}

// Human label for a CLI runtime id (the run records which CLI each agent ran on).
function cliLabel(cli: string): string {
  if (cli === 'claude-code') return 'Claude Code'
  if (cli === 'codex') return 'Codex'
  return (
    cli
      .split(/[-_\s]+/u)
      .filter(Boolean)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join(' ') || cli
  )
}

const STATUS_LABEL: Record<SprintEngineTaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  review: 'In review',
  needs_input: 'Needs input',
  done: 'Done',
  canceled: 'Canceled',
}

// Task status → the shared shape-coded lifecycle vocabulary, so the summary's
// status marks read by shape and match the board columns (the values are a
// subset of LifecycleState, but the explicit map guards against divergence).
const STATUS_LIFECYCLE: Record<SprintEngineTaskStatus, LifecycleState> = {
  todo: 'todo',
  in_progress: 'in_progress',
  review: 'review',
  canceled: 'todo',
  needs_input: 'needs_input',
  done: 'done',
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
  const autoState = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.sprintEngineAutoState ?? null
  )
  // Names the per-project pull-request chips: a declared repo's root is relative to
  // the workspace folder, and the primary project's `.` IS this folder.
  const folderPath = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null
  )
  // The CLI each agent ran on lives on the workspace agent record. Select the
  // stable `agents` reference (Zustand v5 rejects fresh-object selectors) and
  // derive the id→cli map with useMemo.
  const agents = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.agents ?? EMPTY_AGENTS
  )
  const cliByAgent = useMemo<Record<string, AgentCli | undefined>>(() => {
    const map: Record<string, AgentCli | undefined> = {}
    for (const [agentId, agent] of Object.entries(agents)) map[agentId] = agent.cli
    return map
  }, [agents])
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

  // Token usage is computed main-side from the run's durable token ledger +
  // projection, fetched on demand like the feedback analysis. A failed read
  // renders no token section — never a fabricated zero.
  const tokenUsage = useSprintEngineTokenUsage(statePath, stateUpdatedAt)

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
  const agentTypeSummary = useMemo(
    () => (report ? buildAgentTypeSummary(report.agentRows, cliByAgent) : null),
    [report, cliByAgent]
  )
  // Role lookup keyed by agent id, from the run report's roster — drives the
  // activity timeline's lane labels.
  const rolesByAgent = useMemo(() => {
    const map: Record<string, SprintEngineRoleId> = {}
    // A roleless agent contributes no entry: the lane then renders the neutral
    // glyph rather than being labelled with someone else's role.
    if (report) for (const row of report.agentRows) if (row.role) map[row.agentId] = row.role
    return map
  }, [report])
  const activityTimeline = useMemo(
    () => (sprintEngineState ? buildAgentActivityTimeline(sprintEngineState, rolesByAgent) : null),
    [sprintEngineState, rolesByAgent]
  )

  if (!sprintEngineState || !report) {
    return (
      <PanelShell titleId={TITLE_ID} subtitle="Sprint state is not available for this workspace." onClose={onClose} embedded={embedded}>
        <EmptyState title="Open a Sprint Engine workspace to see its run summary." />
      </PanelShell>
    )
  }

  const durationLabel = formatRunDuration(report.runDurationMs)
  const issueTotals = buildIssueTotals(report.agentRows)
  const allDone = report.totalTasks > 0 && report.doneTasks === report.totalTasks
  const attention = report.needsInput.length > 0
  // A worktree run that's done but not yet merged is "Ready for review", not
  // "Complete" — it only becomes Complete once its pull request merges. A
  // non-worktree run (no branch to review) is Complete the moment work is done.
  // A run spanning projects is under review until the LAST project's pull request
  // merges, so this counts every declared project rather than the primary alone.
  const mergeRollup = deriveSprintEngineRepoMergeRollup(sprintEngineState.vcs)
  const awaitingReview = !!mergeRollup && !mergeRollup.allMerged
  const phaseLabel =
    report.totalTasks === 0
      ? 'No tasks recorded'
      : !allDone
        ? attention
          ? 'Needs your attention'
          : 'In progress'
        : attention
          ? `${awaitingReview ? 'Ready for review' : 'Complete'} — needs your attention`
          : awaitingReview
            ? 'Ready for review'
            : 'Complete'
  // The verdict carries the same shape-coded run glyph as the board hero and the
  // Backlog/sidebar rows — one run-status vocabulary across surfaces. The glyph's
  // own tone (warn for attention, good for done) does the coloring; the verdict
  // label stays plain strong ink rather than tinted heading chrome.
  const runGlyph = deriveSprintEngineRunGlyph({ sprintEngineState, autoState })

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
        <span className="inline-flex items-center gap-2">
          {runGlyph ? (
            <LifecycleGlyph state={runGlyph.state} live={runGlyph.live} label={`Run: ${runGlyph.label}`} />
          ) : null}
          <span className="text-title font-semibold text-[color:var(--text-strong)]">{phaseLabel}</span>
        </span>
        {report.totalTasks > 0 ? (
          <span className="flex flex-wrap items-baseline gap-x-2 text-meta tabular-nums text-[color:var(--text-muted)]">
            <Crumb>{`${report.doneTasks} / ${report.totalTasks} tasks done`}</Crumb>
            {report.needsInput.length > 0 ? (
              <Crumb>{`${report.needsInput.length} need input`}</Crumb>
            ) : null}
            {durationLabel ? <Crumb>{`ran ${durationLabel}`}</Crumb> : null}
          </span>
        ) : null}
        {/* A run spanning projects lands one branch per project, and the verdict
            above rolls them into a single word — so the projects themselves, and
            which of them have merged, are only readable here. A single-project run
            already says all of this in the verdict and the board's own chip, so it
            adds nothing here. */}
        {mergeRollup && mergeRollup.total > 1 ? (
          <RunPullRequestViewChip vcs={sprintEngineState.vcs} folderPath={folderPath} />
        ) : null}
      </div>

      {report.totalTasks === 0 ? (
        <EmptyState
          density="list"
          title="This run has no tasks yet."
          body="Configure a roster and dispatch work to populate the summary."
        />
      ) : (
        <>
          {/* Overview → output → who-worked-when → by-type headline → measured issues → who. */}
          <RunOverviewSection report={report} burnup={burnup} durationLabel={durationLabel} />
          {activityTimeline ? (
            <SectionDivider>
              <Section title="Agent activity" count={activityTimeline.rows.length} level={3}>
                <AgentActivityTimeline timeline={activityTimeline} durationLabel={durationLabel} />
              </Section>
            </SectionDivider>
          ) : null}
          <RunMetricsSection report={report} />
          <TokenUsageSection report={tokenUsage} />
          {agentTypeSummary ? <AgentTypeSummarySection summary={agentTypeSummary} /> : null}
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
      className="flex h-full min-h-0 flex-col bg-[color:var(--bg-surface)] text-[color:var(--text-default)]"
    >
      {embedded ? null : (
        <div className="relative shrink-0 bg-[color:var(--bg-surface)]">
          <PanelHeader
            tool="sprintengine"
            title="Run summary"
            titleId={titleId}
            subtitle={subtitle}
            // Close is the panel's one action, so it takes the primary slot.
            // It used to ride `overflow`, which is the OverflowMenu's slot —
            // a menu of secondary actions, not a place to park a control that
            // has nowhere else to sit (2112).
            primaryAction={
              onClose ? (
                <CloseIconButton onClick={onClose} aria-label="Close run summary" />
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

// Shared fixed column geometry so the three work-type tables line up: every table
// uses the same agent-column width and the same numeric-column width, packed from
// the left. A narrower table (Review, Planning) simply ends sooner — its columns
// still sit directly beneath Implementation's, so every vertical gridline is shared.
const AGENT_COL_W = 216
const NUM_COL_W = 116
const tableWidthFor = (numCols: number) => AGENT_COL_W + numCols * NUM_COL_W
// The table is `ui/Table` with `fixed` (Tailwind `table-fixed`); this style only
// pins its overall width so the fixed column tracks have an exact box to divide.
const tableStyleFor = (numCols: number) => ({ width: tableWidthFor(numCols) })
// `table-fixed` makes the browser take column widths from the `<colgroup>` rather
// than auto-sizing to content, so all three tables share the same column tracks.
// The table element itself is now `ui/Table` with `fixed` (MC-2117), so
// border-collapse and the base type step are the kit's.
//
// The HEADER classes below stay local and deliberately diverge from
// `Table.Head`: this is a dense comparison matrix whose labels carry full words,
// wrap to two lines and bottom-align just above their numbers, with per-column
// separators. `Table.Head`'s single-line sticky header is right for a scrolling
// log and wrong for a 4-row matrix — sharing the chrome does not mean every
// table wears one header.

// One `<colgroup>` shape for all three tables: the agent column, then `numCols`
// equal numeric columns. This is what pins the columns to the same x across tables.
function ColGroup({ numCols }: { numCols: number }) {
  return (
    <colgroup>
      <col style={{ width: AGENT_COL_W }} />
      {Array.from({ length: numCols }, (_, index) => (
        <col key={index} style={{ width: NUM_COL_W }} />
      ))}
    </colgroup>
  )
}

// A "?" affordance for jargon column headers: a hairline circle that reveals a
// plain-language definition on hover/focus. Rendered inline right after the
// header text (which keeps its normal right-aligned wrapping), so it never
// disturbs the column layout. Kept subtle — muted, brightens on interaction —
// and used sparingly, only on headers whose meaning isn't self-evident.
function ColumnHint({ label, hint }: { label: string; hint: string }) {
  return (
    <Tooltip
      // The tooltip primitive defaults to single-line (`whitespace-nowrap`); a
      // block child with its own width + `whitespace-normal` overrides the
      // inherited nowrap so this longer definition wraps to a calm multi-line box.
      content={
        <span className="block max-w-[260px] whitespace-normal text-left leading-snug">
          {hint}
        </span>
      }
    >
      <button
        type="button"
        aria-label={`What does "${label}" mean?`}
        className={`ml-1 inline-flex size-icon-sm translate-y-[3px] items-center justify-center rounded-full border border-[color:var(--border-strong)] text-micro font-normal leading-none text-[color:var(--text-disabled)] hover:border-[color:var(--text-muted)] hover:text-[color:var(--text-muted)] ${FOCUS_RING_CLASS}`}
      >
        ?
      </button>
    </Tooltip>
  )
}

// Plain-language definitions for the measured-issue columns, keyed by the issue
// `key` in `measuredIssueTypes`. These are reviewer-assigned defect categories, so
// the distinctions (a missed requirement vs an implementation mistake) aren't
// self-evident from the label alone.
const MEASURED_ISSUE_HINTS: Record<string, string> = {
  bugs: "Defects reviewers found in this agent's work — behavior that's incorrect or broken.",
  missedRequirements: "Acceptance criteria or requested behavior the agent didn't deliver.",
  implementationMistakes:
    'Coding errors — wrong logic, mishandled cases, sloppy implementation — as distinct from missing a requirement.',
  factualErrors:
    'Claims the agent made that were untrue — about the code, the task, or what it had done.',
  unsafeChanges: 'Changes that introduced a security, data-loss, or stability risk.',
  hallucinatedClaims:
    "Assertions with no basis — invented files, APIs, or results that don't exist.",
  regressionCount: "Previously-working behavior that this agent's changes broke.",
  testFailuresIntroduced: "Tests that started failing because of this agent's changes.",
}

// Definitions for the review-throughput columns: "reviews" counts passes (a task
// can be reviewed more than once) while "tasks reviewed" counts distinct tasks.
const REVIEW_COLUMN_HINTS = {
  tasksAudited: "Distinct tasks this agent read at least once reviewing another agent's work.",
  passed: 'Reviews that found nothing to fix.',
  fixedForward: 'Reviews that found problems and fixed them in place.',
  escalated: 'Findings too large to fix in place, escalated to the architect or the user.',
} as const

// Definitions for the plan & setup quality dimensions, keyed by the score key in
// `processHealthDimensions`. These are 0–100% ratings the team gave the plan, so
// the dimension names benefit from a one-line gloss.
const PLAN_QUALITY_HINTS: Record<string, string> = {
  directiveClarityPct:
    "How clearly the run's overall directive — the goal and its constraints — was stated, as rated by the agents working from it.",
  taskClarityPct: 'How clearly each task was specified: scope, intent, and what to build.',
  acceptanceCriteriaClarityPct:
    'How clear and testable the acceptance criteria were — whether agents could tell when a task was truly done.',
  sprintEngineToolEffectivenessPct:
    'How well the Sprint Engine tooling supported the work, as rated by the agents using it.',
  promptOptimizationPct: 'How well-tuned the prompts and instructions were for the work at hand.',
  contextFitPct:
    'Whether the agent was given the right context — not too little, not too much — to do the task.',
  roleFitPct: "How well the task matched the agent's role and capabilities.",
}

// Shared table header classes. Labels carry full words and wrap to two lines,
// bottom-aligned so they sit just above the numbers; numeric headers share the
// data cells' px-3 so header and number right-edges line up. The agent header is
// left-aligned and single-line (kept distinct so text-right/text-left never collide).
const HEADER_BASE =
  'border-b border-[color:var(--border-subtle)] pb-1.5 align-bottom text-micro font-medium leading-tight text-[color:var(--text-muted)]'
const NUM_HEADER = `${HEADER_BASE} px-3 text-right`
const AGENT_HEADER = `${HEADER_BASE} pr-3 text-left whitespace-nowrap`
const COL_SEP = 'border-l border-[color:var(--border-subtle)]'

function AgentName({ role, agentId, idle }: { role?: SprintEngineRoleId; agentId: string; idle?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-2 whitespace-nowrap pl-[20px]">
      {/* An agent with no role gets no glyph: the neutral fallback is for a role
          that will not resolve, not for one that is absent (MC-2055). */}
      {role ? <RoleGlyph role={role} size="sm" className="translate-y-[2px]" /> : null}
      <span className="font-mono text-meta text-[color:var(--text-strong)]">{agentId}</span>
      {idle ? <span className="text-micro text-[color:var(--text-disabled)]">idle</span> : null}
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
          <InlineNotice
            tone="error"
            className="mb-2"
            title="Couldn't load agent metrics."
            hint={`${analysisError ? `${analysisError}. ` : ''}Roster and task counts below are from the run state.`}
          />
        ) : analysisStatus === 'unavailable' ? (
          <p className="mb-2 text-meta leading-5 text-[color:var(--text-muted)]">
            Agent metrics are unavailable for this run.
          </p>
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
            totalTasks={report.totalTasks}
          />
        ) : null}

        {idleRows.length > 0 ? (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setShowIdle((value) => !value)}
              aria-expanded={showIdle}
              className={`inline-flex items-baseline gap-1.5 rounded-sm text-meta text-[color:var(--text-muted)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
            >
              <span aria-hidden="true" className="text-micro text-[color:var(--text-disabled)]">
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
  const anySelfReported = rows.some((row) =>
    measuredIssueTypes.some((type) => agentIssueSignal(row.metrics, type.key)?.selfReported)
  )
  return (
    <div className="mt-1">
      <WorkTypeHeading label="Implementation" count={rows.length} />
      <div className="overflow-x-auto">
        <Table fixed style={tableStyleFor(1 + measuredIssueTypes.length)}>
          <ColGroup numCols={1 + measuredIssueTypes.length} />
          <thead>
            <tr>
              <th scope="col" className={AGENT_HEADER}>
                Agent
              </th>
              <th scope="col" className={`${NUM_HEADER} ${COL_SEP}`}>
                Tasks
              </th>
              {measuredIssueTypes.map((type) => (
                <th
                  key={type.key}
                  scope="col"
                  // Full label, wrapping to two lines, bottom-aligned over the
                  // numbers — so "Implementation mistakes" reads in full without
                  // a cryptic abbreviation.
                  className={NUM_HEADER}
                >
                  {type.label}
                  {MEASURED_ISSUE_HINTS[type.key] ? (
                    <ColumnHint label={type.label} hint={MEASURED_ISSUE_HINTS[type.key]} />
                  ) : null}
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
        </Table>
      </div>
      {anySelfReported ? (
        <p className="mt-1.5 text-micro text-[color:var(--text-disabled)]">
          ° Self-reported — found by the agent reviewing its own work; no independent review.
        </p>
      ) : null}
    </div>
  )
}

// Reviewers: what they reviewed and how they ruled.
function ReviewTable({ rows }: { rows: SprintEngineAgentRow[] }) {
  return (
    <div className="mt-5">
      <WorkTypeHeading label="Reviews" count={rows.length} />
      <div className="overflow-x-auto">
        <Table fixed style={tableStyleFor(4)}>
          <ColGroup numCols={4} />
          <thead>
            <tr>
              <th scope="col" className={AGENT_HEADER}>
                Agent
              </th>
              <th scope="col" className={`${NUM_HEADER} ${COL_SEP}`}>
                Tasks audited
                <ColumnHint label="Tasks audited" hint={REVIEW_COLUMN_HINTS.tasksAudited} />
              </th>
              <th scope="col" className={NUM_HEADER}>
                Clean
                <ColumnHint label="Clean" hint={REVIEW_COLUMN_HINTS.passed} />
              </th>
              <th scope="col" className={NUM_HEADER}>
                Fixed
                <ColumnHint label="Fixed" hint={REVIEW_COLUMN_HINTS.fixedForward} />
              </th>
              <th scope="col" className={NUM_HEADER}>
                Escalated
                <ColumnHint label="Escalated" hint={REVIEW_COLUMN_HINTS.escalated} />
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const peerReview = row.metrics?.peerReview
              const border = 'border-b border-[color:var(--border-subtle)]'
              const escalated = peerReview?.escalated ?? 0
              return (
                <tr key={row.agentId}>
                  <td className={`${border} py-1.5 pr-6`}>
                    <AgentName role={row.role} agentId={row.agentId} />
                  </td>
                  <NumCellB border={border} sep={COL_SEP}>
                    {peerReview ? peerReview.tasksAudited : NA}
                  </NumCellB>
                  <NumCellB border={border}>{peerReview ? peerReview.passed : NA}</NumCellB>
                  <NumCellB border={border}>{peerReview ? peerReview.fixedForward : NA}</NumCellB>
                  <NumCellB border={border}>
                    {!peerReview ? (
                      NA
                    ) : escalated > 0 ? (
                      <span className="text-[color:var(--tone-warn)]">{escalated}</span>
                    ) : (
                      <span className="text-[color:var(--text-disabled)]">0</span>
                    )}
                  </NumCellB>
                </tr>
              )
            })}
          </tbody>
        </Table>
      </div>
    </div>
  )
}

// Planners: the architect's estimation accuracy (run-level) + planner task counts.
function PlanningTable({
  rows,
  architectDifficulty,
  planQuality,
  totalTasks,
}: {
  rows: SprintEngineAgentRow[]
  architectDifficulty: SprintEngineArchitectDifficulty | null
  planQuality: ReturnType<typeof buildProcessHealth>
  totalTasks: number
}) {
  const qualitySamples = planQuality.length
    ? Math.max(...planQuality.map((stat) => stat.sampleCount))
    : 0
  return (
    <div className="mt-5">
      <WorkTypeHeading label="Planning" count={rows.length > 0 ? rows.length : undefined} />
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <Table fixed style={tableStyleFor(4)}>
            <ColGroup numCols={4} />
            <thead>
              <tr>
                <th scope="col" className={AGENT_HEADER}>
                  Agent
                </th>
                <th scope="col" className={`${NUM_HEADER} ${COL_SEP}`}>
                  Tasks
                </th>
                <th scope="col" className={NUM_HEADER}>
                  Estimate error
                  <ColumnHint
                    label="Estimate error"
                    hint="Average gap between the architect's difficulty estimate and how hard the task actually proved, ignoring direction. Lower is more accurate."
                  />
                </th>
                <th scope="col" className={NUM_HEADER}>
                  Estimate bias
                  <ColumnHint
                    label="Estimate bias"
                    hint="Which way the estimates leaned. Positive means tasks were estimated harder than they turned out (over-estimated); negative means easier (under-estimated). Near 0 is well-calibrated."
                  />
                </th>
                <th scope="col" className={NUM_HEADER}>
                  Estimates
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const border = 'border-b border-[color:var(--border-subtle)]'
                // Estimation accuracy is the architect's measured calibration —
                // run-level, so it attaches to the architect's row. Other planning
                // roles (if any) carry no estimate and read "—".
                const diff = row.role === 'architect' ? architectDifficulty : null
                return (
                  <tr key={row.agentId}>
                    <td className={`${border} py-1.5 pr-6`}>
                      <AgentName role={row.role} agentId={row.agentId} />
                    </td>
                    <NumCellB border={border} sep={COL_SEP}>
                      {row.tasksDone}
                    </NumCellB>
                    <NumCellB border={border}>
                      {diff ? `±${diff.mean_absolute_error_pct}%` : NA}
                    </NumCellB>
                    <NumCellB border={border}>
                      {diff ? `${diff.bias_pct > 0 ? '+' : ''}${diff.bias_pct}%` : NA}
                    </NumCellB>
                    <NumCellB border={border}>{diff ? diff.sampleCount : NA}</NumCellB>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        </div>
      ) : null}

      {planQuality.length > 0 ? (
        <div className="mt-4">
          <div className="mb-1.5 flex items-baseline gap-1.5 text-meta text-[color:var(--text-muted)]">
            Plan quality
            <span className="text-micro text-[color:var(--text-disabled)]">
              self-reported on {qualitySamples} of {totalTasks} task{totalTasks === 1 ? '' : 's'}
            </span>
          </div>
          <div className="grid gap-x-10 sm:grid-cols-2">
            {planQuality.map((stat) => (
              <div
                key={stat.key}
                className="flex items-baseline justify-between gap-3 border-b border-[color:var(--border-subtle)] py-1.5"
              >
                <span className="text-meta text-[color:var(--text-muted)]">
                  {stat.label}
                  {PLAN_QUALITY_HINTS[stat.key] ? (
                    <ColumnHint label={stat.label} hint={PLAN_QUALITY_HINTS[stat.key]} />
                  ) : null}
                </span>
                <span className="text-meta tabular-nums text-[color:var(--text-default)]">
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
    <div className="mb-1.5 flex items-baseline gap-1.5 text-meta font-medium text-[color:var(--text-muted)]">
      {label}
      {count !== undefined ? (
        <span className="tabular-nums text-[color:var(--text-disabled)]">{count}</span>
      ) : null}
    </div>
  )
}

// Marks a value the agent reported reviewing its OWN work (no independent
// review). Rendered as a superscript ° with the explanation on hover.
function SelfReportedMark() {
  return (
    <span
      title="Self-reported — found by the agent reviewing its own work; no independent review."
      aria-label="self-reported"
      className="ml-0.5 align-super text-micro leading-none text-[color:var(--text-disabled)]"
    >
      °
    </span>
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
  const bugSeverity =
    metrics?.measured.findingsAgainst?.bySeverity
    ?? metrics?.selfReview?.findingsReported?.bySeverity
    ?? {}

  // Fixed-width disclosure slot so expandable and non-expandable rows share the
  // exact same left edge for the glyph + id.
  const chevron = (
    <span
      aria-hidden="true"
      className={`inline-block w-3 text-micro leading-none transition-colors ${
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
      {row.role ? <RoleGlyph role={row.role} size="sm" className="translate-y-[2px]" /> : null}
      <span className="font-mono text-meta text-[color:var(--text-strong)]">{row.agentId}</span>
      {idle ? <span className="text-micro text-[color:var(--text-disabled)]">idle</span> : null}
    </>
  )

  return (
    <tr className={rowClass}>
      <td className={`${cellBorder} py-1.5 pr-6`}>
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
      {/* tasksDone is always-known structural data — show 0, not "—". The
          column separator sits here, right after the agent identity, matching
          the Review and Planning tables. */}
      <NumCellB border={cellBorder} sep={sep}>
        {row.tasksDone}
      </NumCellB>
      {measuredIssueTypes.map((type) => {
        const signal = agentIssueSignal(metrics, type.key)
        let content: React.ReactNode
        if (signal === null) {
          content = dash
        } else if (type.key === 'bugs' && signal.count > 0) {
          content = (
            <span className="inline-flex items-baseline justify-end gap-1.5">
              <StatusDot tone={highestFindingTone(bugSeverity)} className="-translate-y-px" />
              {signal.count}
              {signal.selfReported ? <SelfReportedMark /> : null}
            </span>
          )
        } else if (signal.count === 0) {
          // Zero defects read as a muted "0" so real defect counts pop.
          content = (
            <span className="text-[color:var(--text-disabled)]">
              0{signal.selfReported ? <SelfReportedMark /> : null}
            </span>
          )
        } else {
          content = (
            <span>
              {signal.count}
              {signal.selfReported ? <SelfReportedMark /> : null}
            </span>
          )
        }
        return (
          <NumCellB key={type.key} border={cellBorder}>
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
    <td className={`${border} ${sep ?? ''} py-1.5 px-3 text-right tabular-nums`}>{children}</td>
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
              <LifecycleGlyph state={STATUS_LIFECYCLE[task.status]} live={false} className="self-start translate-y-[2px]" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  {onOpenTask ? (
                    <button
                      type="button"
                      onClick={() => onOpenTask(task.id)}
                      aria-label={`Open task ${task.id}`}
                      className={`group inline-flex min-w-0 items-baseline gap-2 rounded-sm text-left ${FOCUS_RING_CLASS}`}
                    >
                      <span className="font-mono text-micro text-[color:var(--text-muted)] group-hover:text-[color:var(--accent-primary)]">
                        {task.id}
                      </span>
                      <span className="text-body text-[color:var(--text-default)] underline-offset-2 [overflow-wrap:anywhere] group-hover:text-[color:var(--text-strong)] group-hover:underline">
                        {task.title}
                      </span>
                    </button>
                  ) : (
                    <>
                      <span className="font-mono text-micro text-[color:var(--text-muted)]">
                        {task.id}
                      </span>
                      <span className="text-body text-[color:var(--text-default)] [overflow-wrap:anywhere]">
                        {task.title}
                      </span>
                    </>
                  )}
                  <span className="text-micro text-[color:var(--text-disabled)]">
                    {STATUS_LABEL[task.status]}
                  </span>
                </div>
                {task.defects.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-meta text-[color:var(--text-muted)]">
                    {task.defects.map((defect) => (
                      <span key={defect.key} className="whitespace-nowrap">
                        <span className="tabular-nums text-[color:var(--text-default)]">
                          {defect.count}
                        </span>{' '}
                        {defect.label.toLowerCase()}
                        {defect.selfReported ? <SelfReportedMark /> : null}
                      </span>
                    ))}
                  </div>
                ) : null}
                {task.findings.length > 0 ? (
                  <ul className="mt-1.5 space-y-1.5">
                    {task.findings.map((finding) => (
                      <FindingItem
                        key={`${finding.taskId}-${finding.id}`}
                        finding={finding}
                        hideTaskId
                      />
                    ))}
                  </ul>
                ) : null}
                {task.defects.length === 0 && task.findings.length === 0 ? (
                  <div className="mt-0.5 text-meta text-[color:var(--text-disabled)]">
                    {task.reviewCount > 0
                      ? 'Reviewed — no issues recorded.'
                      : task.selfReviewCount > 0
                        ? 'Self-review — no issues recorded.'
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
    <span className="mt-0.5 block text-meta text-[color:var(--text-muted)]">
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
        <span className="font-mono text-micro text-[color:var(--text-muted)]">
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
            <span className="text-body text-[color:var(--text-default)] [overflow-wrap:anywhere]">
              {finding.title}
            </span>
            <span aria-hidden="true" className="ml-1 text-micro text-[color:var(--text-disabled)]">
              {open ? '▾' : '▸'}
            </span>
          </button>
        ) : (
          <span className="text-body text-[color:var(--text-default)] [overflow-wrap:anywhere]">
            {finding.title}
          </span>
        )}
        {meta}
        {open && hasDetail ? (
          <div className="mt-1 border-l-2 border-[color:var(--border-strong)] pl-2.5 text-meta leading-5 text-[color:var(--text-muted)]">
            {finding.detail ? <p className="[overflow-wrap:anywhere]">{finding.detail}</p> : null}
            {finding.recommendation ? (
              <p className="mt-1 [overflow-wrap:anywhere]">
                <span className="text-[color:var(--text-default)]">Recommendation: </span>
                {finding.recommendation}
              </p>
            ) : null}
            {finding.file ? (
              <p className="mt-1 font-mono text-micro text-[color:var(--text-disabled)] [overflow-wrap:anywhere]">
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
          <span className="text-meta text-[color:var(--text-disabled)]">
            {issueTotals.includesSelfReported
              ? issueTotals.hasMeasured
                ? 'flagged by reviewers and self-review during the run'
                : 'found by agents reviewing their own work'
              : 'flagged by reviewers during the run'}
          </span>
        }
        level={3}
      >
        {issueTotals.hasMeasured || issueTotals.includesSelfReported ? (
          <IssueBars items={issueTotals.items} />
        ) : (
          <p className="text-meta text-[color:var(--text-disabled)]">
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
                  key={`${finding.taskId}-${finding.id}`}
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
                <LeftRow key={item.taskId} tone="error" id={item.taskId} title={item.reason} meta={item.role ? getSprintEngineRoleLabel(item.role) : undefined} />
              ))}
            </ul>
          </>
        ) : null}

        {report.remaining.length > 0 ? (
          <>
            <SubHead label="Still open" count={report.remaining.length} />
            <div className="flex flex-wrap gap-x-5 gap-y-1.5 pb-2 pt-0.5">
              {(Object.keys(remainingStatusCounts) as SprintEngineTaskStatus[]).map((status) => (
                <span key={status} className="inline-flex items-center gap-1.5 text-meta">
                  <LifecycleGlyph state={STATUS_LIFECYCLE[status]} live={false} />
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
                  leading={
                    <LifecycleGlyph
                      state={STATUS_LIFECYCLE[task.status]}
                      live={false}
                      label={STATUS_LABEL[task.status]}
                      className="self-start translate-y-px"
                    />
                  }
                  id={task.id}
                  title={task.title}
                  meta={task.role ? getSprintEngineRoleLabel(task.role) : undefined}
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
    <div className="mb-1 mt-3 flex items-baseline gap-1.5 text-meta text-[color:var(--text-muted)] first:mt-0">
      {label}
      <span className="tabular-nums text-[color:var(--text-disabled)]">{count}</span>
    </div>
  )
}

function LeftRow({
  tone,
  leading,
  id,
  title,
  meta,
}: {
  /** Dot tone for an error/attention marker. Ignored when `leading` is set. */
  tone?: Tone
  /** Leading slot — a LifecycleGlyph for rows whose marker is a worklist stage. */
  leading?: React.ReactNode
  id: string
  title: string
  meta?: string
}) {
  return (
    <li className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-2 border-t border-[color:var(--border-subtle)] py-1.5 first:border-t-0">
      {leading ?? <StatusDot tone={tone ?? 'neutral'} className="translate-y-[5px]" />}
      <span className="font-mono text-micro text-[color:var(--text-muted)]">{id}</span>
      <span className="min-w-0">
        <span className="text-body text-[color:var(--text-default)] [overflow-wrap:anywhere]">
          {title}
        </span>
        {meta ? (
          <span className="mt-0.5 block text-meta text-[color:var(--text-muted)]">{meta}</span>
        ) : null}
      </span>
    </li>
  )
}

type StatCell = { label: string; value: React.ReactNode; inverse?: boolean; hint?: string }

function StatStrip({ cells, columns }: { cells: StatCell[]; columns: string }) {
  return (
    <div className={`grid grid-cols-2 sm:grid-cols-3 ${columns}`}>
      {cells.map((cell, index) => (
        <div
          key={cell.label}
          className={`py-0.5 ${index === 0 ? 'pl-0 pr-4' : 'border-l border-[color:var(--border-subtle)] px-4'}`}
        >
          <div className="text-meta text-[color:var(--text-muted)]">
            {cell.label}
            {cell.inverse ? <span className="text-[color:var(--text-disabled)]"> ↓</span> : null}
            {cell.hint ? <ColumnHint label={cell.label} hint={cell.hint} /> : null}
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
  ]
  return (
    <SectionDivider>
      <Section title="Run metrics" level={3}>
        <StatStrip cells={cells} columns="md:grid-cols-3" />
      </Section>
    </SectionDivider>
  )
}

// Sprint token usage: one headline total with truthful coverage, plus the
// per-model breakdown. Token counts only (dollar cost was rejected — prices
// churn too fast to store honestly). The headline counts each token once and
// keeps cache re-reads out of it — see the shared wire type. An agent whose CLI has no readable token
// source is called out as unmeasured rather than silently zeroed, and rows
// from total-only CLIs (Grok) show no input/output split rather than a
// fabricated one.
function TokenUsageSection({ report }: { report: SprintEngineTokenUsageReport | null }) {
  if (!report || !tokenReportHasAgents(report)) return null
  const { run } = report
  const coverageNote = describeTokenCoverage(run.coverage)

  if (run.coverage.measuredAgents === 0) {
    return (
      <SectionDivider>
        <Section title="Token usage" level={3}>
          <EmptyState density="list" title={coverageNote} />
        </Section>
      </SectionDivider>
    )
  }

  const cells: StatCell[] = [
    {
      label: 'Total tokens',
      value: formatTokenCount(run.total.total),
      hint: 'Each token counted once: new input, tokens written to the prompt cache, and output. Context re-read from the cache is the separate Cache read figure.',
    },
    // When any contributing CLI is total-only the component fields undercount,
    // so only the honest headline total is shown.
    ...(run.total.split
      ? [
          {
            label: 'Fresh input',
            value: formatTokenCount(run.total.input),
            hint: 'New (uncached) prompt tokens only. Almost all context arrives through the cache instead, so this number is tiny by design.',
          },
          { label: 'Cache write', value: formatTokenCount(run.total.cacheCreation) },
          { label: 'Output', value: formatTokenCount(run.total.output) },
          {
            label: 'Cache read',
            value: formatTokenCount(run.total.cacheRead),
            hint: "Tokens re-read from the prompt cache. Every API turn re-reads the agent's whole accumulated context, so this grows with turns × context and is not part of the total — counting it there would charge the same context once per turn. Billed at a small fraction of the input price.",
          },
        ]
      : []),
  ]

  return (
    <SectionDivider>
      <Section title="Token usage" level={3}>
        {coverageNote ? (
          <div className="mb-3 text-meta leading-5 text-[color:var(--text-muted)]">{coverageNote}</div>
        ) : null}
        <StatStrip cells={cells} columns="md:grid-cols-5" />
        {run.perModel.length > 0 ? (
          <div className="mt-3 space-y-1">
            {run.perModel.map((row) => (
              <ModelTokenRow key={row.model} row={row} />
            ))}
          </div>
        ) : null}
      </Section>
    </SectionDivider>
  )
}

function ModelTokenRow({ row }: { row: SprintEngineModelTokenUsage }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-meta leading-5">
      <span className="min-w-[10rem] font-medium text-[color:var(--text-default)]">{row.model}</span>
      <span className="tabular-nums text-[color:var(--text-strong)]">{formatTokenCount(row.total)}</span>
      <span className="tabular-nums text-[color:var(--text-muted)]">
        {row.split
          ? `${formatTokenCount(row.input)} in · ${formatTokenCount(row.output)} out · ${formatTokenCount(row.cacheRead)} cache read · ${formatTokenCount(row.cacheCreation)} cache write`
          : 'no input/output breakdown from this CLI'}
      </span>
    </div>
  )
}

// A glanceable headline: implementation agents grouped by role, each showing a
// weighted Delivery score, the normalized issue load, and the top issue mix.
// When two CLIs differ enough, a one-line takeaway calls out the score gap.
function AgentTypeSummarySection({ summary }: { summary: SprintEngineAgentTypeSummary }) {
  if (summary.roles.length === 0) return null
  const comparison = compareCliDeliveryScores(summary.clis)
  return (
    <SectionDivider>
      <Section title="Delivery Score" count={summary.roles.length} level={3}>
        <div className="mb-3 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-meta leading-5 text-[color:var(--text-muted)]">
          {comparison ? (
            <span>
              <CliInline cli={comparison.better.key} /> agents scored{' '}
              <span className="tabular-nums text-[color:var(--text-default)]">
                {comparison.better.deliveryScore}
              </span>{' '}
              on delivery, vs <CliInline cli={comparison.worse.key} />
              {"'s "}
              <span className="tabular-nums text-[color:var(--text-default)]">
                {comparison.worse.deliveryScore}
              </span>
              .
            </span>
          ) : (
            <span>Delivery score compares weighted review issues per completed task.</span>
          )}
          <ColumnHint
            label="Delivery score"
            hint="A 0-100 headline score derived from weighted implementation issues per completed task. Unsafe changes, regressions, missed requirements, implementation mistakes, bugs, and introduced test failures count more heavily than raw task coverage."
          />
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 md:grid-cols-4">
          {summary.roles.map((stat) => (
            <TypeStatCell key={stat.key} stat={stat} />
          ))}
        </div>
      </Section>
    </SectionDivider>
  )
}

// A CLI's brand icon followed by its name, for inline use in the takeaway line.
function CliInline({ cli }: { cli: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 text-[color:var(--text-default)]">
      <CliIcon cli={cli} className="h-3.5 w-3.5 translate-y-[2px]" />
      {cliLabel(cli)}
    </span>
  )
}

function TypeStatCell({ stat }: { stat: SprintEngineTypeStat }) {
  const issues = `${stat.totalIssues} issue${stat.totalIssues === 1 ? '' : 's'}`
  const tasks = `${stat.tasksDone} task${stat.tasksDone === 1 ? '' : 's'}`
  const mix = stat.topIssueMix.length
    ? stat.topIssueMix.map((item) => `${item.count} ${item.label}`).join(', ')
    : 'No issues flagged'
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        {/* The group of agents that have no role names nothing: its key is a map
            key, never a role, and printing it would leak the reserved token to
            the user (MC-2055). The score, the counts and the CLIs still read —
            in a roleless run this is the run's one delivery cell. */}
        <span className="inline-flex items-center gap-1.5 truncate text-meta text-[color:var(--text-default)]">
          {stat.key === SPRINT_ENGINE_ROLELESS_KEY ? null : (
            <>
              <RoleGlyph role={stat.key as SprintEngineRoleId} size="sm" />
              <TruncatedText as="span" text={getSprintEngineRoleLabel(stat.key)} />
            </>
          )}
        </span>
        {stat.clis.length > 0 ? (
          <span className="inline-flex flex-none items-center gap-1">
            {stat.clis.map((cli) => (
              <Tooltip key={cli} content={cliLabel(cli)}>
                <span tabIndex={0} aria-label={`Ran on ${cliLabel(cli)}`} className="inline-flex">
                  <CliIcon cli={cli} className="h-3.5 w-3.5" />
                </span>
              </Tooltip>
            ))}
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 text-[20px] font-semibold tabular-nums text-[color:var(--text-strong)]">
        {stat.deliveryScore === null ? '—' : stat.deliveryScore}
      </div>
      <div className="text-micro text-[color:var(--text-muted)]">Delivery score</div>
      <div className="mt-0.5 text-micro tabular-nums text-[color:var(--text-disabled)]">
        {stat.issueLoadPerTask === null ? '—' : `${stat.issueLoadPerTask} load/task`} · {issues} · {tasks}
      </div>
      <TruncatedText
        as="div"
        text={mix}
        className="mt-0.5 text-micro text-[color:var(--text-disabled)]"
      />
    </div>
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
  const tone: InlineNoticeTone = hasError ? 'error' : 'warn'

  // The kit's notice, tone-matched to the condition: the glyph and the tint are
  // the tone now, where this used to be a neutral bar with the failure spelled in
  // red text (MC-2115).
  return (
    <InlineNotice tone={tone} className="mb-4 text-meta">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-micro text-[color:var(--text-muted)]">Projection</span>
        <span className="text-[color:var(--text-default)]">{projectionSourceLabel[source]}</span>
        {projection?.errorMessage ? (
          <span className="[overflow-wrap:anywhere]">{projection.errorMessage}</span>
        ) : null}
      </div>
      {lockWarnings.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {lockWarnings.map((warning) => (
            <li key={warning.name} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              <span className="font-mono text-micro">{warning.name}</span>
              <span className="[overflow-wrap:anywhere]">
                {warning.message} ({formatSprintEngineLockAge(warning.ageSeconds)})
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </InlineNotice>
  )
}
