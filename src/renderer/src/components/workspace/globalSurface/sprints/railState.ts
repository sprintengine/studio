import type { LifecycleState } from '../../../../../../shared/sprintengine/run-types'
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
  /** The row's status mark, in the SAME LifecycleGlyph vocabulary the Backlog
   *  rows use (merged branch, ready-for-review branch, completed disc,
   *  needs-input, running spinner) — never a bare tone dot. */
  glyph: { state: LifecycleState; live: boolean; label: string }
}

// One vocabulary with the Backlog's run glyphs (deriveSprintEngineRunGlyph):
// the rail only holds index summaries, so the mapping reads runtimeState +
// repoRollup rather than the full projection, but the states and labels match —
// Merged (purple branch), Ready for review (green branch), Complete (disc).
export function sprintRunLifecycleGlyph(
  summary: SprintRunSummary,
): { state: LifecycleState; live: boolean; label: string } {
  switch (summary.runtimeState) {
    case 'needs_input':
      return { state: 'needs_input', live: false, label: 'Needs input' }
    case 'running':
      return { state: 'in_progress', live: true, label: 'Running' }
    case 'completed': {
      const { declared, open, merged } = summary.repoRollup
      if (declared > 0 && open > 0) return { state: 'done_unmerged', live: false, label: 'Ready for review' }
      if (declared > 0 && merged > 0) return { state: 'done_merged', live: false, label: 'Merged' }
      return { state: 'done', live: false, label: 'Complete' }
    }
    case 'canceled':
      // The house mapping for a canceled terminal (boardColumn → 'archived').
      return { state: 'archived', live: false, label: 'Canceled' }
    case 'idle':
      return { state: 'ready', live: false, label: 'Not started' }
    case 'unknown':
    default:
      // The run exists but its projection could not be read — a neutral empty
      // ring, never an alarm mark for what is usually a transient read.
      return { state: 'todo', live: false, label: 'Details unavailable' }
  }
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
  return stampOf(summary.updatedAt ?? summary.startedAt)
}

function createdStamp(summary: SprintRunSummary): number {
  return stampOf(summary.startedAt)
}

function stampOf(iso: string | null): number {
  if (!iso) return Number.NEGATIVE_INFINITY
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
}

// The rail's sort axis (the Backlog sort idiom, restated for runs): recency is
// the default — a run touched a minute ago leads its group, whatever its state —
// with created-date and status-band orders behind the filter glyph.
export type SprintSort = 'recent' | 'created' | 'status'

export const SPRINT_SORT_ITEMS: ReadonlyArray<{ value: SprintSort; label: string }> = [
  { value: 'recent', label: 'Updated at' },
  { value: 'created', label: 'Created at' },
  { value: 'status', label: 'Status' },
]

function compareSprintRuns(a: SprintRunSummary, b: SprintRunSummary, sort: SprintSort): number {
  if (sort === 'status') {
    // Attention order: needs-input, then running, then finished/quiet/decided,
    // recency inside each band.
    const byRank = RUNTIME_STATE_RANK[a.runtimeState] - RUNTIME_STATE_RANK[b.runtimeState]
    if (byRank !== 0) return byRank
  }
  const stamp = sort === 'created' ? createdStamp : runStamp
  const byStamp = stamp(b) - stamp(a)
  if (byStamp !== 0) return byStamp
  return a.teamName.localeCompare(b.teamName)
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
    case 'needs_input': {
      // An honest age: a sprint that has waited a week says so (concrete date,
      // per copy-voice — never "recently").
      const since = sprintRunShortDate(summary.updatedAt ?? summary.startedAt)
      return since ? `needs your input · since ${since}` : 'needs your input'
    }
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

export type SprintRunOpenFailureCopy = {
  title: string
  hint: string
  retryLabel: string
}

/**
 * What the canvas says when the selected run will not open (MC-2063). Two cases,
 * and telling them apart is the whole point: a store this build is too new to
 * read is PERMANENT and carries its own remedy (delete the directory, named once
 * in `detail`), so promising "usually temporary" and offering "Try again" is a
 * false affordance. Everything else really is usually a mid-write read.
 */
export function sprintRunOpenFailureCopy(summary: SprintRunSummary): SprintRunOpenFailureCopy {
  if (summary.unknownKind === 'unsupported_store') {
    return {
      title: 'This sprint can’t be opened by this version of Multicode.',
      hint: 'Its run store is too old to read, and old stores are never upgraded. Delete the sprint’s folder and start it again — the path is in the details.',
      retryLabel: 'Check again',
    }
  }
  return {
    title: 'Couldn’t open this sprint.',
    hint: 'Its run store is on disk but could not be read just now — this is usually temporary.',
    retryLabel: 'Try again',
  }
}

// Whether a run matches the rail's search query — team name or project name,
// case-insensitive substring. An empty/whitespace query matches everything.
export function sprintRunMatchesSearch(summary: SprintRunSummary, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    summary.teamName.toLowerCase().includes(q) || summary.projectName.toLowerCase().includes(q)
  )
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
 * The rail's rows: every run, narrowed to one project when `projectRoot` is set.
 * `sort` picks the order — recency by default; 'status' is the attention-first
 * order (needs-input leads) the door's auto-select uses. An unknown
 * `projectRoot` yields no rows — the caller shows the "no runs in this project"
 * state rather than silently listing all of them.
 */
export function buildSprintRailRows(
  summaries: ReadonlyArray<SprintRunSummary>,
  projectRoot: string | null,
  sort: SprintSort = 'recent',
): SprintRailRow[] {
  const scoped = projectRoot
    ? summaries.filter((summary) => summary.projectRoot === projectRoot)
    : [...summaries]
  scoped.sort((a, b) => compareSprintRuns(a, b, sort))
  return scoped.map((summary) => ({
    id: summary.statePath,
    title: summary.teamName,
    stateLine: sprintRunStateLine(summary),
    tone: sprintRunTone(summary.runtimeState),
    pulse: summary.runtimeState === 'running',
    glyph: sprintRunLifecycleGlyph(summary),
  }))
}

// The rail's groups (MC-1838): the list IS the inbox. "Needs you" leads with
// the runs waiting on a person, "Active" is genuinely live work, everything
// else — finished, idle, canceled, unreadable — ages into "Recent" with no
// standing block pinned above the page. Empty groups are omitted, not rendered
// as empty headers. Within a group, the ordering is buildSprintRailRows' own.
export type SprintRailGroup = {
  key: 'needs_you' | 'active' | 'recent'
  label: string
  rows: SprintRailRow[]
}

export function buildSprintRailGroups(
  summaries: ReadonlyArray<SprintRunSummary>,
  projectRoot: string | null,
  sort: SprintSort = 'recent',
): SprintRailGroup[] {
  const scoped = projectRoot
    ? summaries.filter((summary) => summary.projectRoot === projectRoot)
    : [...summaries]
  const byPath = new Map(scoped.map((summary) => [summary.statePath, summary]))
  const rows = buildSprintRailRows(scoped, null, sort)
  const groups: SprintRailGroup[] = [
    { key: 'needs_you', label: 'Needs you', rows: [] },
    { key: 'active', label: 'Active', rows: [] },
    { key: 'recent', label: 'Recent', rows: [] },
  ]
  for (const row of rows) {
    const state = byPath.get(row.id)?.runtimeState
    if (state === 'needs_input') groups[0]!.rows.push(row)
    else if (state === 'running') groups[1]!.rows.push(row)
    else groups[2]!.rows.push(row)
  }
  return groups.filter((group) => group.rows.length > 0)
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
