// The plan column's read model (MC-1924): the pure projection that turns the
// authored plan plus the live runtime into the bands and one-line rows the
// column renders. Kept DOM-free so the band rules — what `Now` holds, what falls
// into `Delivered`, which step owns a track's attention — are exhaustively
// testable without a running app.
//
// Two inputs, deliberately: the DRAFT's lanes are the authoring truth (a drag
// lands instantly, before the file has been written), while the board lanes are
// the runtime overlay (running / paused / delivered, the pull request, the
// track's attention). They are joined on the authored ref rather than by index,
// so a draft that is momentarily ahead of disk still shows the right state
// against the rows that already existed, and a just-dropped row simply has no
// runtime yet.
//
// One readout per fact (the epic's density rule): the row's trailing slot owns
// STEP SIZE, the bar owns horizon progress, and the detail's own bar owns an
// epic's children. Nothing here emits a second progress string.

import {
  resolveEntryRoster,
  type ProjectKey,
  type RoadmapEntryKind,
  type RoadmapLane,
} from '../../../../../shared/backlog/roadmap'
import type { BacklogItemStatusPayload } from '../../../../../shared/electron-api'
import type { RoadmapBoardLane, RoadmapUnitState } from '../../../../../shared/sprintengine/roadmap-surface'
import { roadmapMembersDone } from './roadmapMemberLifecycle'

// The per-ref display facts the column resolves a step's title through.
// Structural, so the renderer's own `RoadmapRefDisplay` map satisfies it without
// this module importing the renderer scan model.
export type HorizonRefDisplay = {
  title: string
  displayId?: string
  status?: BacklogItemStatusPayload
}

// How a step is staffed, resolved exactly once — through `resolveEntryRoster`,
// the same function the orchestrator staffs a launch with, so what the row shows
// and what the sprint runs with cannot drift.
export type HorizonStepRoster = {
  /** The resolved roster name, or the built-in default's name. */
  label: string
  /** This step overrides the horizon's default (it carries its own `@roster=`). */
  overridden: boolean
  /** The named roster no longer exists — the start will fail loudly, so say so. */
  missing: boolean
}

/** What the step's team band has to say (MC-2066). The choice is the New sprint
 *  dialog's, because it is the same choice: `plain_agents` means no roles, so
 *  what matters is which agent runs the step; `roster` means the roster carries
 *  the agents, and its roles are the answer. */
export type HorizonStepTeamKind = 'missing' | 'plain_agents' | 'roster'

/** Which of the three a step's staffing is. Pure so the ORDER is provable: a
 *  name that resolves to no saved roster reads MISSING first and never falls
 *  through to the built-in default — a step naming a deleted roster fails its
 *  start loudly (the epic's standing decision), and softening that here would
 *  make the band promise a run that cannot happen. */
export function horizonStepTeamKind(
  roster: HorizonStepRoster,
  /** The label resolves to one of the user's saved rosters. */
  resolvesToSavedRoster: boolean,
): HorizonStepTeamKind {
  if (roster.missing) return 'missing'
  return resolvesToSavedRoster ? 'roster' : 'plain_agents'
}

// The attention a track is holding, attached to the step it happened to. This is
// where the deleted "Waiting on you" strip's job now lives (MC-1922): a reason
// beside the control that resolves it, never a list away from the work.
//
// `approval` is deliberately NOT a notice kind. A step waiting for the go-ahead
// is a healthy state, not a problem, and rendering it in the warn advisory made
// every ready horizon read as broken. It is the row's `ready` flag instead, and
// the action lives where the eyes already are — the detail pane's header.
export type HorizonStepNoticeKind = 'paused' | 'merge' | 'blocked'

export type HorizonStepNotice = {
  kind: HorizonStepNoticeKind
  /** Plain sentence: what happened. */
  message: string
  /** The underlying reason (the project, the branch, the failure), when known. */
  detail?: string
  /** The one action that clears it, when there is one — rendered by the DETAIL
   *  pane's header, never as a button in the rail (the rail only states). A
   *  track stalled on a prerequisite has none: the fix is in the backlog, so
   *  both surfaces state the reason and offer no control that cannot help. */
  actionLabel?: string
}

export type HorizonStepRow = {
  /** Stable across re-renders and unique within the plan. */
  key: string
  laneIndex: number
  entryIndex: number
  laneTitle: string
  /** The authored ref — the plan's own identity for this step. */
  ref: string
  title: string
  /** The item's minted id (`MC-1234`), when the scan has one. Leads the title on
   *  the row — a step must be recognizable without clicking it. */
  displayId?: string
  kind: RoadmapEntryKind
  state: RoadmapUnitState
  projectKey: ProjectKey
  projectName: string
  /** Step SIZE for an epic — `7/10` once anything is delivered, else `10`.
   *  Undefined for a single item, which is its own size. */
  sizeLabel?: string
  roster: HorizonStepRoster
  /** The delivering pull request, on a delivered step. */
  prUrl?: string
  notice?: HorizonStepNotice
  /** The horizon is waiting for the go-ahead to start THIS step. Good news, so
   *  it renders as a quiet chip on the row — the start action itself is the
   *  detail pane header's, never a button buried in the rail. */
  ready?: boolean
  /** The ref names no backlog item this Multicode can see. Surfaced, never
   *  silently dropped (Fallback Discipline) — a stale step the author can act on
   *  beats a row that looks ordinary and parks the track when it is reached. */
  unresolved: boolean
  /** …but its PROJECT is not open, so the file may be perfectly fine and we
   *  simply cannot see it. A different problem with a different fix, and the
   *  detail pane already says so — the row must not contradict it by calling a
   *  healthy step stale. */
  projectUnavailable: boolean
}

export type HorizonBandKind =
  // The running step. The only band that earns a name in a single-track plan,
  // because it is the only group the order does not already imply.
  | 'now'
  // The plain ordered remainder — no label, because "next" is what order means.
  | 'rest'
  // One track of a multi-track plan: a named band in the ONE column, never a
  // second column, so there is still exactly one selection driving one detail.
  | 'track'

export type HorizonBand = {
  key: string
  kind: HorizonBandKind
  laneIndex: number
  label?: string
  /** `2/4` — a TRACK's own progress, not the horizon's. */
  count?: string
  rows: HorizonStepRow[]
}

export type HorizonPlan = {
  /** The single track's own name, or `Plan` when there is more than one. */
  headTitle: string
  bands: HorizonBand[]
  delivered: {
    rows: HorizonStepRow[]
    steps: number
    /** Backlog items delivered — an epic step counts its members. */
    items: number
  }
}

export type HorizonPlanInput = {
  /** The authored plan (the draft), in plan order. */
  lanes: ReadonlyArray<RoadmapLane>
  /** The live runtime overlay. Empty for a draft horizon — every step then
   *  classifies from backlog status alone, which is the honest draft reading. */
  boardLanes: ReadonlyArray<RoadmapBoardLane>
  refDisplay: ReadonlyMap<string, HorizonRefDisplay>
  projectNameByKey: ReadonlyMap<ProjectKey, string>
  /** The horizon-wide default a step falls back to. */
  policyRoster: string | undefined
  /** Saved roster names, lowercased — a name outside this set reads "not found".
   *  The caller includes the built-in default's own name, so deliberately
   *  choosing "No roles" is never marked missing. */
  knownRosterNames: ReadonlySet<string>
  /** The projects this Multicode can actually read (home is always in it). A
   *  step outside this set is unreadable, not stale. */
  resolvableProjects?: ReadonlySet<ProjectKey>
  /** The name shown when nothing is chosen (the built-in default). */
  defaultRosterLabel: string
  /** An epic step's live members, keyed by the epic's AUTHORED ref and valued by
   *  the members' authored refs (`refDisplay`'s key). The host resolves it from
   *  the scan; a step with no runtime yet sizes from this. */
  epicMembersByRef?: ReadonlyMap<string, ReadonlyArray<string>>
}

export const HORIZON_PLAN_HEAD_FALLBACK = 'Plan'

// Every park reason the orchestrator can raise, in the words a person would use.
// A reason with no copy here would fall back to "This track is paused", which is
// exactly the unactionable pause MC-1909 was filed on — so the map is exhaustive
// by construction (`Record<RoadmapParkReason, string>` would be, but the reason
// arrives as a plain string on the wire, so the lookup stays defensive).
/** What Resume does after each park, in honest words. A canceled sprint is
 *  gone; resuming starts a fresh one on the same step — the orchestrator's
 *  resume issues a `start` for the lane's frontier, never a mid-flight pickup. */
export const RESUME_HINT: Record<string, string> = {
  run_canceled: 'Resuming starts a new sprint for this step.',
  run_failed: 'Resuming starts a new sprint for this step.',
  start_failed: 'Resuming tries the start again.',
}

export const HORIZON_PARK_COPY: Record<string, string> = {
  run_failed: 'A sprint failed.',
  run_canceled: 'A sprint was canceled.',
  needs_input: 'A sprint is waiting on your input.',
  pr_closed: 'A pull request was closed without merging.',
  merge_failed: 'A merge could not complete.',
  start_failed: 'No sprint was created.',
  eligibility_contradiction: 'This track points at an item that no longer exists.',
  unknown_project: 'This track points at a project that can’t be found.',
  paused: 'You paused this track.',
}

export function buildHorizonPlan(input: HorizonPlanInput): HorizonPlan {
  const boardByTitle = new Map(input.boardLanes.map((lane) => [lane.lane, lane]))
  const bands: HorizonBand[] = []
  const deliveredRows: HorizonStepRow[] = []
  const multiTrack = input.lanes.length > 1

  input.lanes.forEach((lane, laneIndex) => {
    const board = boardByTitle.get(lane.title)
    const unitByRef = new Map((board?.units ?? []).map((unit) => [unit.ref, unit]))

    const rows = lane.entries.map((entry, entryIndex) => {
      const unit = unitByRef.get(entry.ref)
      const display = input.refDisplay.get(entry.ref)
      const projectReadable =
        unit?.state !== 'unknown_project'
        && (input.resolvableProjects === undefined || input.resolvableProjects.has(entry.projectKey))
      const rosterName = resolveEntryRoster(entry, { roster: input.policyRoster })
      const missing =
        rosterName !== undefined && !input.knownRosterNames.has(rosterName.trim().toLowerCase())
      // An epic's size is its LIVE membership (MC-2031), read through the board
      // unit when it has one and off the host's membership map otherwise — so a
      // just-dropped epic, which has no runtime yet, still counts.
      const members = entry.kind === 'epic' ? (input.epicMembersByRef?.get(entry.ref) ?? []) : []
      const childStatuses =
        unit?.children?.map((child) => child.status)
        ?? members.map((member) => input.refDisplay.get(member)?.status)
      const total = entry.kind === 'epic' ? childStatuses.length : 0
      const done = roadmapMembersDone(childStatuses)
      const row: HorizonStepRow = {
        key: `${laneIndex}:${entryIndex}:${entry.ref}`,
        laneIndex,
        entryIndex,
        laneTitle: lane.title,
        ref: entry.ref,
        title: unit?.title ?? display?.title ?? entry.relativePath,
        ...(display?.displayId ? { displayId: display.displayId } : {}),
        kind: unit?.kind ?? entry.kind,
        state: unit?.state ?? 'queued',
        projectKey: entry.projectKey,
        projectName:
          unit?.projectName ?? input.projectNameByKey.get(entry.projectKey) ?? entry.projectKey ?? 'This project',
        ...(total > 0 ? { sizeLabel: done > 0 ? `${done}/${total}` : `${total}` } : {}),
        roster: {
          label: rosterName ?? input.defaultRosterLabel,
          overridden: Boolean(entry.roster?.trim()),
          missing,
        },
        ...(unit?.prUrl ? { prUrl: unit.prUrl } : {}),
        // The board resolves an item's status only when it found the file; the
        // display map is the draft-side equivalent. Neither means the ref points
        // at nothing we can see — but only counts as STALE when the project is
        // one we can read in the first place.
        unresolved: unit?.itemStatus === undefined && display === undefined && projectReadable,
        projectUnavailable: !projectReadable,
      }
      return row
    })

    attachAttention(rows, board)

    const open: HorizonStepRow[] = []
    for (const row of rows) {
      if (row.state === 'done') deliveredRows.push(row)
      else open.push(row)
    }

    if (multiTrack) {
      bands.push({
        key: `track:${laneIndex}:${lane.title}`,
        kind: 'track',
        laneIndex,
        label: lane.title,
        ...(board ? { count: `${board.doneCount}/${board.total}` } : {}),
        rows: open,
      })
      return
    }

    // One track: `Now` names the running step, and everything after it is a
    // plain ordered list. Both bands are emitted even when empty so a drop can
    // land in the right place in an empty plan.
    const running = open.filter((row) => row.state === 'running')
    const rest = open.filter((row) => row.state !== 'running')
    if (running.length > 0) {
      bands.push({ key: `now:${laneIndex}`, kind: 'now', laneIndex, label: 'Now', rows: running })
    }
    bands.push({ key: `rest:${laneIndex}`, kind: 'rest', laneIndex, rows: rest })
  })

  return {
    headTitle: multiTrack ? HORIZON_PLAN_HEAD_FALLBACK : (input.lanes[0]?.title ?? HORIZON_PLAN_HEAD_FALLBACK),
    bands,
    delivered: {
      rows: deliveredRows,
      steps: deliveredRows.length,
      items: deliveredRows.reduce((sum, row) => sum + deliveredItemCount(row), 0),
    },
  }
}

// An epic step delivered every member it carried; an item step delivered itself.
// Read off the size label so the footer's item count and the rows' trailing
// counts can never disagree.
function deliveredItemCount(row: HorizonStepRow): number {
  if (!row.sizeLabel) return 1
  const total = row.sizeLabel.includes('/') ? row.sizeLabel.split('/')[1] : row.sizeLabel
  const parsed = Number.parseInt(total, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

// Hang the track's attention on the step it belongs to. The target is found by
// STATE (the board already marked the parked unit) or by the raw ref the board
// lifted, and falls back to the first open row so a reason is never lost — a
// pause a person cannot see is the same defect as a pause they cannot act on.
function attachAttention(rows: HorizonStepRow[], board: RoadmapBoardLane | undefined): void {
  if (!board) return
  const openRows = rows.filter((row) => row.state !== 'done')
  if (openRows.length === 0) return

  // A track can be stalled without WAITING on anyone: its frontier's backlog
  // prerequisite is unfinished, so the orchestrator will not start it and there
  // is nothing here to approve, merge or resume. `attention` is `none` for this,
  // which is why it reads as an ordinary ready step — a plan that simply is not
  // moving, with no reason anywhere. The retired editor said "Blocked" beside
  // the track name; the reason belongs on the step instead.
  if (board.attention === 'none') {
    if (board.reason === 'blocked') {
      openRows[0].notice = {
        kind: 'blocked',
        message: 'This step is waiting on work it depends on. Finish that first, or drop the prerequisite.',
      }
    }
    return
  }

  if (board.attention === 'paused' && board.parked) {
    const target = rows.find((row) => row.state === 'paused') ?? openRows[0]
    const reason = HORIZON_PARK_COPY[board.parked.reason] ?? 'This track is paused.'
    // What Resume actually DOES, not a vague "continue": for a canceled or
    // failed sprint the orchestrator starts a NEW sprint at the lane's frontier
    // (roadmap-orchestrator.test.ts: "the lane resumes working the current
    // plan") — the stopped sprint is never resurrected, so the copy must not
    // imply it picks back up mid-flight.
    const resumeHint = RESUME_HINT[board.parked.reason] ?? 'Resume to continue.'
    target.notice = {
      kind: 'paused',
      message: board.parked.reason === 'paused' ? reason : `${reason} ${resumeHint}`,
      ...(board.parked.detail ? { detail: board.parked.detail } : {}),
      actionLabel: 'Resume',
    }
    return
  }
  if (board.attention === 'approval') {
    // Not a notice: waiting for the go-ahead is the healthy resting state of an
    // ask-first horizon, and the warn card made it read as a defect. The row
    // shows a quiet Ready chip; the loud "Start sprint" is the detail header's.
    const target = rows.find((row) => row.ref === board.pendingApprovalRef) ?? openRows[0]
    target.ready = true
    return
  }
  const target =
    rows.find((row) => row.ref === board.activeItemRef)
    ?? rows.find((row) => row.state === 'running')
    ?? openRows[0]
  target.notice = {
    kind: 'merge',
    message: 'This step delivered. Its pull request is waiting on you.',
    actionLabel: 'Approve & merge',
  }
}
