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

// The attention a track is holding, attached to the step it happened to. This is
// where the deleted "Waiting on you" strip's job now lives (MC-1922): a reason
// beside the control that resolves it, never a list away from the work.
export type HorizonStepNoticeKind = 'paused' | 'approval' | 'merge'

export type HorizonStepNotice = {
  kind: HorizonStepNoticeKind
  /** Plain sentence: what happened. */
  message: string
  /** The underlying reason (the project, the branch, the failure), when known. */
  detail?: string
  /** The one action that clears it. */
  actionLabel: string
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
  /** This epic's membership moved since it was placed — offer the re-sync. */
  drift?: { gained: number; removed: number }
  /** The ref names no backlog item this Multicode can see. Surfaced, never
   *  silently dropped (Fallback Discipline) — a stale step the author can act on
   *  beats a row that looks ordinary and parks the track when it is reached. */
  unresolved: boolean
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
  /** The name shown when nothing is chosen (the built-in default). */
  defaultRosterLabel: string
  /** Epic drift by authored ref, when the host resolved it. */
  driftByRef?: ReadonlyMap<string, { gained: number; removed: number }>
}

export const HORIZON_PLAN_HEAD_FALLBACK = 'Plan'

// Every park reason the orchestrator can raise, in the words a person would use.
// A reason with no copy here would fall back to "This track is paused", which is
// exactly the unactionable pause MC-1909 was filed on — so the map is exhaustive
// by construction (`Record<RoadmapParkReason, string>` would be, but the reason
// arrives as a plain string on the wire, so the lookup stays defensive).
export const HORIZON_PARK_COPY: Record<string, string> = {
  run_failed: 'A sprint failed.',
  run_canceled: 'A sprint was canceled.',
  needs_input: 'A sprint is waiting on your input.',
  pr_closed: 'A pull request was closed without merging.',
  merge_failed: 'A merge could not complete.',
  start_failed: 'No sprint was created.',
  eligibility_contradiction: 'This track points at an item that no longer exists.',
  unknown_project: 'This track points at a project this Multicode can’t find.',
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
      const rosterName = resolveEntryRoster(entry, { roster: input.policyRoster })
      const missing =
        rosterName !== undefined && !input.knownRosterNames.has(rosterName.trim().toLowerCase())
      // An epic's size comes from the SNAPSHOT (what this step will deliver),
      // resolved against live status through the board unit when it has one, and
      // against the display map otherwise — so a just-dropped epic still counts.
      const childStatuses =
        unit?.children?.map((child) => child.status)
        ?? (entry.kind === 'epic'
          ? entry.children.map((child) => input.refDisplay.get(resolveChildRef(child, entry.projectKey))?.status)
          : [])
      const total = entry.kind === 'epic' ? Math.max(entry.children.length, childStatuses.length) : 0
      const done = roadmapMembersDone(childStatuses)
      const row: HorizonStepRow = {
        key: `${laneIndex}:${entryIndex}:${entry.ref}`,
        laneIndex,
        entryIndex,
        laneTitle: lane.title,
        ref: entry.ref,
        title: unit?.title ?? display?.title ?? entry.relativePath,
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
        // at nothing we can see.
        unresolved: unit?.itemStatus === undefined && display === undefined,
      }
      const drift = input.driftByRef?.get(entry.ref)
      if (drift) row.drift = drift
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

// An epic step delivered every member it snapshotted; an item step delivered
// itself. Read off the size label so the footer's item count and the rows'
// trailing counts can never disagree.
function deliveredItemCount(row: HorizonStepRow): number {
  if (!row.sizeLabel) return 1
  const total = row.sizeLabel.includes('/') ? row.sizeLabel.split('/')[1] : row.sizeLabel
  const parsed = Number.parseInt(total, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

// A snapshotted child inherits its epic's project unless it carries its own
// `alias:` prefix — the same rule `resolveEpicChildRef` applies, restated here
// against the AUTHORED ref (the display map's key) rather than the split pair.
function resolveChildRef(child: string, inherited: ProjectKey): string {
  const normalized = child.replace(/\\/g, '/').replace(/^\/+/, '')
  const colon = normalized.indexOf(':')
  const slash = normalized.indexOf('/')
  if (colon > 0 && (slash === -1 || colon < slash)) return normalized
  return inherited ? `${inherited}:${normalized}` : normalized
}

// Hang the track's attention on the step it belongs to. The target is found by
// STATE (the board already marked the parked unit) or by the raw ref the board
// lifted, and falls back to the first open row so a reason is never lost — a
// pause a person cannot see is the same defect as a pause they cannot act on.
function attachAttention(rows: HorizonStepRow[], board: RoadmapBoardLane | undefined): void {
  if (!board || board.attention === 'none') return
  const openRows = rows.filter((row) => row.state !== 'done')
  if (openRows.length === 0) return

  if (board.attention === 'paused' && board.parked) {
    const target = rows.find((row) => row.state === 'paused') ?? openRows[0]
    const reason = HORIZON_PARK_COPY[board.parked.reason] ?? 'This track is paused.'
    target.notice = {
      kind: 'paused',
      message: board.parked.reason === 'paused' ? reason : `${reason} Resume to continue.`,
      ...(board.parked.detail ? { detail: board.parked.detail } : {}),
      actionLabel: 'Resume',
    }
    return
  }
  if (board.attention === 'approval') {
    const target = rows.find((row) => row.ref === board.pendingApprovalRef) ?? openRows[0]
    target.notice = {
      kind: 'approval',
      message: 'This step is ready. The horizon asks before starting the next sprint.',
      actionLabel: 'Start next',
    }
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
