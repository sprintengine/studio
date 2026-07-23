import type { SprintRunRuntimeState, SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import type { StatusTone } from '../../../ui/tokens'

// The Sprints door rail's read model (item 1763, mockup §2): every run in this
// Multicode as one dot + title + plain-language state line, filtered by project
// and ordered by what needs a person. Pure over the run-index summaries (T1) —
// no store, no IPC, no clock — so the rail never fans out a per-row call and the
// grouping/filter/ordering rules are unit-testable on their own.
//
// The mockup's four line shapes are the whole vocabulary:
//   multicode · running · 4 of 9 tasks
//   multicode-mobile · needs your input
//   multicode +2 repos · 1 merge left
//   multicode · landed Jul 22

export type SprintRailRow = {
  /** The run's `statePath` — its stable identity and the rail's selection id. */
  id: string
  title: string
  stateLine: string
  tone: StatusTone
  /** A run with work in flight — the dot pulses. */
  pulse: boolean
}

export type SprintProjectChip = {
  /** Absolute project root; the filter value (never the display name, which can collide). */
  projectRoot: string
  /** Folder basename, the chip's label. */
  label: string
  /** How many runs this project contributes — the chip is only offered when ≥ 1. */
  runCount: number
}

// The aggregate the sidebar door dot carries while the surface is closed: any run
// waiting on the operator outranks any run merely running (the backlog-glyph
// precedence rule, same shape as RoadmapAttention).
export type SprintDoorAttention = {
  waiting: boolean
  running: boolean
}

// Attention order, not recency: a run that needs a person leads, then live work,
// then finished/quiet/decided runs, then the ones we could not read. Ties break
// on most-recently-updated, then name, so the rail is stable between refreshes.
const RUNTIME_STATE_RANK: Record<SprintRunRuntimeState, number> = {
  needs_input: 0,
  running: 1,
  completed: 2,
  idle: 3,
  canceled: 4,
  unknown: 5,
}

// One dot idiom carries the tone; `completed` stays good whether or not its
// merges have all landed (the state line names the remaining leg).
export function sprintRunTone(state: SprintRunRuntimeState): StatusTone {
  switch (state) {
    case 'needs_input':
      return 'warn'
    case 'running':
      return 'accent'
    case 'completed':
      return 'good'
    default:
      return 'neutral'
  }
}

// The same six states as a short label for the surface bar's status chip — plain
// words, never the enum. The rail's dot and this chip read the same run, so they
// share one vocabulary.
export function sprintRunStatusLabel(state: SprintRunRuntimeState): string {
  switch (state) {
    case 'running':
      return 'Running'
    case 'needs_input':
      return 'Waiting on you'
    case 'completed':
      return 'Completed'
    case 'canceled':
      return 'Canceled'
    case 'idle':
      return 'Idle'
    case 'unknown':
    default:
      return 'Unavailable'
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "Jul 22" from an ISO instant, read off the date fields directly rather than
// through a Date so the label never shifts a day across time zones. Null for a
// missing or unparseable stamp, so the caller drops the date instead of printing
// "Invalid Date".
export function sprintRunShortDate(iso: string | null): string | null {
  if (!iso) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(iso)
  if (!match) return null
  const month = MONTHS[Number(match[2]) - 1]
  return month ? `${month} ${Number(match[3])}` : null
}

// Sort stamp: last update, falling back to creation. An undated run sorts last
// within its rank rather than jumping the queue.
function runStamp(summary: SprintRunSummary): number {
  const iso = summary.updatedAt ?? summary.startedAt
  if (!iso) return Number.NEGATIVE_INFINITY
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
}

// "multicode" for a single-repo run, "multicode +2 repos" for a run that declares
// siblings — the cross-project marker the mockup leads each row with. Shared by
// the rail's state line and the surface bar's context line, so the two can never
// describe the same run's repo span differently.
export function sprintRunProjectPhrase(summary: SprintRunSummary): string {
  const siblings = summary.repoRollup.declared - 1
  if (siblings < 1) return summary.projectName
  return `${summary.projectName} +${siblings} ${siblings === 1 ? 'repo' : 'repos'}`
}

// Plain words for where the run stands — never a status enum, never a raw error.
function statePhrase(summary: SprintRunSummary): string {
  const { done, total } = summary.taskCounts
  switch (summary.runtimeState) {
    case 'running':
      return total > 0 ? `running · ${done} of ${total} tasks` : 'running'
    case 'needs_input':
      return 'needs your input'
    case 'completed': {
      const { open } = summary.repoRollup
      if (open > 0) return `${open} merge${open === 1 ? '' : 's'} left`
      const landed = sprintRunShortDate(summary.updatedAt)
      return landed ? `landed ${landed}` : 'landed'
    }
    case 'canceled':
      return 'canceled'
    case 'idle':
      return total > 0 ? `${done} of ${total} tasks` : 'not started yet'
    case 'unknown':
    default:
      // The run exists but its projection could not be read. The row stays listed
      // with its identity rather than silently disappearing (T1's contract).
      return 'details unavailable'
  }
}

export function sprintRunStateLine(summary: SprintRunSummary): string {
  return `${sprintRunProjectPhrase(summary)} · ${statePhrase(summary)}`
}

// The filter chips above the rows (mockup §2): one per project that actually has
// a run, labelled by folder basename and keyed by root. Alphabetical by label so
// the chip strip does not reshuffle as runs change state.
export function deriveSprintProjectChips(
  summaries: ReadonlyArray<SprintRunSummary>,
): SprintProjectChip[] {
  const byRoot = new Map<string, SprintProjectChip>()
  for (const summary of summaries) {
    const existing = byRoot.get(summary.projectRoot)
    if (existing) {
      existing.runCount += 1
      continue
    }
    byRoot.set(summary.projectRoot, {
      projectRoot: summary.projectRoot,
      label: summary.projectName,
      runCount: 1,
    })
  }
  return [...byRoot.values()].sort(
    (a, b) => a.label.localeCompare(b.label) || a.projectRoot.localeCompare(b.projectRoot),
  )
}

/**
 * The rail's rows: every run, narrowed to one project when `projectRoot` is set,
 * ordered attention-first. An unknown `projectRoot` yields no rows — the caller
 * shows the "no runs in this project" state rather than silently listing all of
 * them.
 */
export function buildSprintRailRows(
  summaries: ReadonlyArray<SprintRunSummary>,
  projectRoot: string | null,
): SprintRailRow[] {
  const scoped = projectRoot
    ? summaries.filter((summary) => summary.projectRoot === projectRoot)
    : [...summaries]
  scoped.sort((a, b) => {
    const byRank = RUNTIME_STATE_RANK[a.runtimeState] - RUNTIME_STATE_RANK[b.runtimeState]
    if (byRank !== 0) return byRank
    const byStamp = runStamp(b) - runStamp(a)
    if (byStamp !== 0) return byStamp
    return a.teamName.localeCompare(b.teamName)
  })
  return scoped.map((summary) => ({
    id: summary.statePath,
    title: summary.teamName,
    stateLine: sprintRunStateLine(summary),
    tone: sprintRunTone(summary.runtimeState),
    pulse: summary.runtimeState === 'running',
  }))
}

// The door dot's aggregate signal, read across every project's runs.
export function sprintDoorAttention(
  summaries: ReadonlyArray<SprintRunSummary>,
): SprintDoorAttention {
  let waiting = false
  let running = false
  for (const summary of summaries) {
    if (summary.runtimeState === 'needs_input') waiting = true
    else if (summary.runtimeState === 'running') running = true
  }
  return { waiting, running }
}

// Plain-language degraded copy for the canvas when the index itself could not be
// read. Exported so the exact wording is locked by tests (quality-audit rule: a
// failed read never reads as "no sprints").
export const RUN_INDEX_ERROR_TITLE = 'Couldn’t load your sprints.'
export const RUN_INDEX_ERROR_HINT = 'Your runs are still on disk — this is usually temporary.'
