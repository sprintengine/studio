// The plan — the `Plan` group of the Horizon door's ONE context rail (item 1993;
// originally MC-1924's middle pane, mockup `2026-07-27-horizon-plan-detail-v2`,
// and the surface that replaced `RoadmapLaneColumn`'s container-for-everything).
//
// What it is: a list of ONE-LINE selectable steps. `Now` names the running step
// because it is the only group the order does not already imply; everything
// after it is a plain ordered list; `Delivered` is a closed footer at the end.
// Two or more tracks become named bands in this ONE list — never side-by-side
// kanban — so there is still exactly one selection driving one detail pane.
//
// It used to be a 360px column of its own, which put it BESIDE the door's rail
// and the app sidebar: three columns of navigation before any content. It is now
// a group of the rail itself — no width, no border, no scrollport (the rail
// scrolls as one list, so the horizons above and the steps below move together
// under one scrollbar). Its selection is the door's `selectedStepRef`, which has
// always lived one level up in `RoadmapGlobalSurface`; folding the column in
// moved the pane, not the state.
//
// What a row says: a lifecycle glyph, then two lines — the id and title (the
// title clamps at two lines, with the full text in a tooltip when clamped), and
// a meta line carrying the Ready chip, the step's size WITH its unit ("5
// items"), and the team chip. Two lines, deliberately: the one-line 26px row
// made every step unrecognizable without clicking it. Still no status word
// beside the glyph that already says it, and no project tag repeated on every
// row of a single-project horizon.
//
// Editing happens HERE — drag to reorder within and across tracks, drop from the
// detail pane's backlog mode to add, right-click to remove, the trailing chip to
// staff. Every edit is a write to the horizon file through the shared autosave
// (useRoadmapPlanDraft); there is no edit mode and no save button.
//
// A track's attention — a park, a merge, a block — is a one-word label on the
// step's own meta line, exactly like the Ready chip. The rail STATES; it never
// explains and never acts. The reason and the action both live on the detail
// pane's header (MC-1909's visibility rule is met there — the reason renders
// inline on the selected step, one click from the label that flagged it).
// Owner, 2026-08-06: extra prose in the sidebar "shouldn't be on this sidebar
// here. That should be within the sprint information on the right hand panel."

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  Badge,
  BoardLaneDropIndicator,
  ContextMenu,
  GhostButton,
  LifecycleGlyph,
  MenuItem,
  OverflowMenu,
  PrimaryButton,
  StatusDot,
  Tooltip,
  TruncatedText,
} from '../../ui'
import { FOCUS_RING_CLASS } from '../../ui/tokens'
import { swallowsRailNavigation } from '../../workspace/globalSurface/surfaceSubstrate'
import {
  addLane,
  mergeLaneDown,
  moveEntry,
  removeEntry,
  setEntryRoster,
  splitLane,
} from '../../backlog/roadmapAuthoring'
import { RosterMenu } from '../../backlog/RosterMenu'
import { NO_ROLES_ROSTER_NAME } from '../../workspace/newWorkspace/savedRosters'
import type { SprintEngineRoster } from '../../../types/workspace'
import type { RoadmapLane } from '../../../../../shared/backlog/roadmap'
import { roadmapUnitLifecycle } from './roadmapMemberLifecycle'
import type { HorizonBand, HorizonPlan, HorizonStepNoticeKind, HorizonStepRow } from './horizonPlanModel'

/** The steering a track's attention notice and its menu can invoke, by track
 *  name. Pause/Resume live on the TRACK's own menu — they act on that track, not
 *  on whichever step happens to be selected. */
export type HorizonSteering = {
  /** A command is in flight for this track — its one action disables. */
  busyLane: string | null
  /** Track names the orchestrator has parked; drives Pause vs Resume. */
  pausedLanes: ReadonlySet<string>
  onPause: (lane: string) => void
  onResume: (lane: string) => void
  onApprove: (lane: string) => void
  onMerge: (lane: string) => void
}

// Pause or Resume for one track, as a menu row. A parked track offers only
// Resume and vice versa — a disabled lookalike says nothing. Exported so the
// rule is provable: a menu's contents live inside a closed popover, which SSR
// never renders.
export function trackSteeringItems(
  laneTitle: string | undefined,
  steering: HorizonSteering,
): Array<{ id: string; label: string; onSelect: () => void; disabled?: boolean }> {
  if (!laneTitle) return []
  const busy = steering.busyLane === laneTitle
  return steering.pausedLanes.has(laneTitle)
    ? [{ id: 'resume', label: 'Resume track', disabled: busy, onSelect: () => steering.onResume(laneTitle) }]
    : [{ id: 'pause', label: 'Pause track', disabled: busy, onSelect: () => steering.onPause(laneTitle) }]
}

/** Where `j`/`k` land next. Pure so the rule is provable: from no cursor the
 *  keyboard picks up at the SELECTION when it is on screen, so it continues from
 *  wherever the pointer left off rather than jumping to the top; from the ends it
 *  clamps rather than wrapping, because a plan is an ordered list and wrapping
 *  past the last step reads as a jump backwards. */
export function nextCursorRef(
  orderedRefs: ReadonlyArray<string>,
  cursor: string | null,
  selectedRef: string | null,
  direction: -1 | 1,
): string | null {
  if (orderedRefs.length === 0) return null
  const index = cursor === null ? -1 : orderedRefs.indexOf(cursor)
  if (index < 0) {
    const fromSelection = selectedRef === null ? -1 : orderedRefs.indexOf(selectedRef)
    return orderedRefs[Math.max(fromSelection, 0)]
  }
  return orderedRefs[Math.min(Math.max(index + direction, 0), orderedRefs.length - 1)]
}

export type HorizonPlanColumnProps = {
  plan: HorizonPlan
  /** The DRAFT's lanes — the transforms every edit is applied to. */
  lanes: RoadmapLane[]
  /** The authored ref of the step whose detail is showing. */
  selectedRef: string | null
  onSelect: (ref: string) => void
  /** The horizon actually spans projects, so a row names the one it changes. */
  showProjectTag: boolean
  rosters: ReadonlyArray<SprintEngineRoster>
  /** The horizon-wide default a step falls back to. */
  policyRoster: string | undefined
  onManageRosters: () => void
  /** Replace the draft's lanes (every structural edit routes through here). */
  onLanes: (next: RoadmapLane[]) => void
  /** Add an authored ref to a track at an index — a drop from the backlog. */
  onAddRef: (laneIndex: number, ref: string, index?: number) => void
  /** Re-snapshot an epic step whose membership moved since it was placed. */
  /** Open this step's backlog item in its own project's Backlog. */
  onOpenItem: (row: HorizonStepRow) => void
  /** Swap the detail pane to the backlog you drag work from. */
  onAddWork: () => void
  /** The backlog mode is already showing — the affordance reads as current. */
  addWorkActive: boolean
  /** A backlog row is being dragged, so a track can accept it as an add. */
  libraryDragRef: string | null
  steering: HorizonSteering
  /** Rename a track (a prompt lives with the host's dialog provider). */
  onRenameTrack: (laneIndex: number) => void
  /** Remove a track, confirming when it still holds steps. */
  onRemoveTrack: (laneIndex: number) => void
  /** The keyboard cursor's step ref (MC-1925), distinct from the selection. */
  cursorRef?: string | null
}

type DragOrigin = { lane: number; index: number } | null
type DropTarget = { lane: number; index: number } | null

export function HorizonPlanColumn({
  plan,
  lanes,
  selectedRef,
  onSelect,
  showProjectTag,
  rosters,
  policyRoster,
  onManageRosters,
  onLanes,
  onAddRef,
  onOpenItem,
  onAddWork,
  addWorkActive,
  libraryDragRef,
  steering,
  onRenameTrack,
  onRemoveTrack,
  cursorRef = null,
}: HorizonPlanColumnProps): JSX.Element {
  const [drag, setDrag] = useState<DragOrigin>(null)
  const [over, setOver] = useState<DropTarget>(null)
  const [deliveredOpen, setDeliveredOpen] = useState(false)
  const [rowMenu, setRowMenu] = useState<{ row: HorizonStepRow; x: number; y: number } | null>(null)
  // Keyboard reorder has no visible drag to follow, so each move is announced.
  const [announcement, setAnnouncement] = useState('')
  // The keyboard cursor (MC-1925): where `j`/`k` are, distinct from the
  // selection driving the detail pane. Null until the keyboard is actually used,
  // so a pointer-driven surface shows no ring it did not ask for.
  const [ownCursor, setOwnCursor] = useState<string | null>(null)
  const rowRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map())
  // A step whose row must regain focus after the re-render a reorder causes.
  const [refocus, setRefocus] = useState<string | null>(null)
  useEffect(() => {
    if (!refocus) return
    rowRefs.current.get(refocus)?.focus()
    setRefocus(null)
  }, [refocus])

  const dropActive = drag !== null || libraryDragRef !== null

  const endDrag = useCallback(() => {
    setDrag(null)
    setOver(null)
  }, [])

  // A drop resolves to a reorder (a step was dragged) or an add (a backlog row
  // was, tracked in libraryDragRef). Either way it lands at the over-index.
  const drop = useCallback(() => {
    if (over) {
      if (drag) onLanes(moveEntry(lanes, drag, over))
      else if (libraryDragRef) onAddRef(over.lane, libraryDragRef, over.index)
    }
    endDrag()
  }, [drag, over, libraryDragRef, lanes, onLanes, onAddRef, endDrag])

  const trackCount = lanes.length

  // ── the keyboard layer (MC-1925) ────────────────────────────────────────────
  // `j`/`k` walk a cursor through the visible steps, `↵` opens the cursored one,
  // `[`/`]` reorder it within (and across) tracks. The horizons rail runs the
  // same idiom one pane over; the two never fight because each handler is scoped
  // to its own subtree, and both ignore keys aimed at a field or a popover.
  const rows = useMemo(() => plan.bands.flatMap((band) => band.rows), [plan.bands])
  const cursor = (cursorRef ?? ownCursor) !== null && rows.some((row) => row.ref === (cursorRef ?? ownCursor))
    ? (cursorRef ?? ownCursor)
    : null

  // Move one step, crossing into the adjacent track at a boundary, so ordering
  // never requires a pointer. Each successful move is announced, because a
  // keyboard reorder has no drag to watch.
  const moveByKey = useCallback(
    (row: HorizonStepRow, direction: -1 | 1) => {
      const { laneIndex, entryIndex } = row
      // Nothing goes in front of the step a sprint is executing. Drag already
      // refuses this (the `Now` band accepts no drops); without the same floor
      // here, one keystroke wrote an order the pointer cannot produce.
      const laneRows = plan.bands.filter((band) => band.laneIndex === laneIndex).flatMap((band) => band.rows)
      const floor = laneRows.reduce(
        (highest, candidate) => (candidate.state === 'running' ? Math.max(highest, candidate.entryIndex + 1) : highest),
        // Delivered steps are not in any band, so the first OPEN entry index is
        // the floor: pushing a step above one would re-open finished work and
        // strip its pull request out of the Delivered footer.
        laneRows.length > 0 ? Math.min(...laneRows.map((candidate) => candidate.entryIndex)) : 0,
      )
      let dest: { lane: number; index: number } | null = null
      if (direction === -1) {
        if (entryIndex > floor) dest = { lane: laneIndex, index: entryIndex - 1 }
        else if (laneIndex > 0) dest = { lane: laneIndex - 1, index: lanes[laneIndex - 1].entries.length }
      } else if (entryIndex < (lanes[laneIndex]?.entries.length ?? 0) - 1) {
        dest = { lane: laneIndex, index: entryIndex + 2 }
      } else if (laneIndex < lanes.length - 1) {
        dest = { lane: laneIndex + 1, index: 0 }
      }
      if (!dest) return
      const next = moveEntry(lanes, { lane: laneIndex, index: entryIndex }, dest)
      onLanes(next)
      for (const lane of next) {
        const position = lane.entries.findIndex((entry) => entry.ref === row.ref)
        if (position >= 0) {
          setAnnouncement(`Moved ${row.title} to position ${position + 1} of ${lane.entries.length} in ${lane.title}.`)
          break
        }
      }
      // Crossing a band or a track remounts the row button; without this the
      // focus lands on <body>, outside the section that owns the key handler, and
      // the keyboard layer works exactly once per click.
      setRefocus(row.ref)
    },
    [lanes, onLanes, plan.bands],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (swallowsRailNavigation(event.target) || rows.length === 0) return
      const index = cursor ? rows.findIndex((row) => row.ref === cursor) : -1
      const focusRow = (ref: string): void => {
        setOwnCursor(ref)
        rowRefs.current.get(ref)?.focus()
      }
      if (event.key === 'j' || event.key === 'ArrowDown' || event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault()
        const down = event.key === 'j' || event.key === 'ArrowDown'
        const next = nextCursorRef(rows.map((row) => row.ref), cursor, selectedRef, down ? 1 : -1)
        if (next) focusRow(next)
        return
      }
      if (event.key === '[' || event.key === ']') {
        const row = index >= 0 ? rows[index] : null
        if (!row) return
        event.preventDefault()
        moveByKey(row, event.key === '[' ? -1 : 1)
        return
      }
      if (event.key === 'Enter' && index >= 0) {
        // A focused row button already opens on Enter; this covers a cursor that
        // has been moved while focus sits elsewhere inside the column.
        if (event.target instanceof HTMLElement && event.target.dataset.stepRow === 'true') return
        event.preventDefault()
        onSelect(rows[index].ref)
      }
    },
    [rows, cursor, selectedRef, moveByKey, onSelect],
  )

  // A single-track plan keeps its track's own actions on the head, beside the
  // name they act on; with two or more tracks they move to each band.
  const headMenu = useMemo(
    () => [
      ...(trackCount === 1
        ? [
            ...trackSteeringItems(lanes[0]?.title, steering),
            { kind: 'separator' as const, id: 'sep-track' },
            { id: 'rename-track', label: 'Rename track…', onSelect: () => onRenameTrack(0) },
          ]
        : []),
      { id: 'add-track', label: 'Add track', onSelect: () => onLanes(addLane(lanes)) },
      ...(trackCount === 1
        ? [
            { kind: 'separator' as const, id: 'sep-remove' },
            {
              id: 'remove-track',
              label: 'Remove track',
              destructive: true,
              onSelect: () => onRemoveTrack(0),
            },
          ]
        : []),
    ],
    [lanes, onLanes, onRenameTrack, onRemoveTrack, trackCount, steering],
  )

  return (
    <section
      aria-label="Plan"
      onKeyDown={handleKeyDown}
      // The rail's focused selection: the horizons group above it tracks outer
      // context and rests permanently (assets/index.css, "Selection tiers"), so
      // this list is the one thing on the screen that reads as chosen.
      className="flex min-w-0 flex-col"
    >
      {/* A rail GROUP header, in the rail's own quiet heading idiom — not a pane
          bar. It earns its place by separating the steps from the horizons above
          them, which is also why the horizons group needs no label of its own:
          the search field over it already reads "Search horizons…". */}
      <header className="flex items-center gap-1.5 px-2 pb-1 pt-2">
        <TruncatedText
          as="h2"
          text={plan.headTitle}
          className="min-w-0 flex-1 text-micro font-semibold text-[color:var(--text-subtle)]"
        />
        {/* The one call to action on this group. It reads as current while the
            detail pane is showing the backlog it opens. */}
        {addWorkActive ? (
          <PrimaryButton size="xs" onClick={onAddWork}>
            Add work
          </PrimaryButton>
        ) : (
          <GhostButton size="xs" onClick={onAddWork}>
            Add work
          </GhostButton>
        )}
        <OverflowMenu ariaLabel="Track options" triggerTooltip="Track options" items={headMenu} />
      </header>

      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <div className="min-w-0 pb-2">
        {plan.bands.length === 0 ? (
          <p className="px-2 py-6 text-center text-meta leading-5 text-[color:var(--text-muted)]">
            No tracks yet. A track is a lane of steps that run in order, one sprint at a time.
          </p>
        ) : (
          plan.bands.map((band, bandIndex) => (
            <PlanBand
              key={band.key}
              band={band}
              leading={bandIndex === 0}
              lanes={lanes}
              trackCount={trackCount}
              selectedRef={selectedRef}
              cursorRef={cursor}
              rowRefs={rowRefs}
              showProjectTag={showProjectTag}
              rosters={rosters}
              policyRoster={policyRoster}
              onManageRosters={onManageRosters}
              drag={drag}
              over={over}
              dropActive={dropActive}
              steering={steering}
              onSelect={onSelect}
              onLanes={onLanes}
              onRenameTrack={onRenameTrack}
              onRemoveTrack={onRemoveTrack}
              onDragStart={setDrag}
              onDragOverTarget={setOver}
              onDrop={drop}
              onDragEnd={endDrag}
              onRowMenu={(row, position) => setRowMenu({ row, ...position })}
            />
          ))
        )}
      </div>

      {plan.delivered.steps > 0 ? (
        <DeliveredFooter
          delivered={plan.delivered}
          open={deliveredOpen}
          onToggle={() => setDeliveredOpen((value) => !value)}
          selectedRef={selectedRef}
          onSelect={onSelect}
        />
      ) : null}

      {rowMenu ? (
        <StepContextMenu
          row={rowMenu.row}
          x={rowMenu.x}
          y={rowMenu.y}
          lanes={lanes}
          onClose={() => setRowMenu(null)}
          onLanes={onLanes}
          onOpenItem={onOpenItem}
        />
      ) : null}
    </section>
  )
}

// ── bands ────────────────────────────────────────────────────────────────────

function PlanBand({
  band,
  leading,
  lanes,
  trackCount,
  selectedRef,
  cursorRef,
  rowRefs,
  showProjectTag,
  rosters,
  policyRoster,
  onManageRosters,
  drag,
  over,
  dropActive,
  steering,
  onSelect,
  onLanes,
  onRenameTrack,
  onRemoveTrack,
  onDragStart,
  onDragOverTarget,
  onDrop,
  onDragEnd,
  onRowMenu,
}: {
  band: HorizonBand
  /** The first band on the surface draws no separating rule above itself. */
  leading: boolean
  lanes: RoadmapLane[]
  trackCount: number
  selectedRef: string | null
  cursorRef: string | null
  rowRefs: React.MutableRefObject<Map<string, HTMLButtonElement | null>>
  showProjectTag: boolean
  rosters: ReadonlyArray<SprintEngineRoster>
  policyRoster: string | undefined
  onManageRosters: () => void
  drag: DragOrigin
  over: DropTarget
  dropActive: boolean
  steering: HorizonSteering
  onSelect: (ref: string) => void
  onLanes: (next: RoadmapLane[]) => void
  onRenameTrack: (laneIndex: number) => void
  onRemoveTrack: (laneIndex: number) => void
  onDragStart: (origin: DragOrigin) => void
  onDragOverTarget: (target: DropTarget) => void
  onDrop: () => void
  onDragEnd: () => void
  onRowMenu: (row: HorizonStepRow, position: { x: number; y: number }) => void
}): JSX.Element {
  const listRef = useRef<HTMLUListElement | null>(null)
  // `Now` is a readout, not a queue: nothing can be inserted before the step
  // that is already executing, so it accepts no drops.
  const acceptsDrops = band.kind !== 'now'

  const handleDragOver = (event: React.DragEvent): void => {
    if (!dropActive || !acceptsDrops) return
    const list = listRef.current
    if (!list) return
    event.preventDefault()
    // The drop effect must be one the drag source allowed, or the browser marks
    // the target invalid and never fires `drop`: a step reorder drags with
    // effectAllowed 'move', a backlog row with 'copy' (the backlog keeps its
    // item). This mismatch was exactly the rail-drag-refused bug.
    event.dataTransfer.dropEffect = drag ? 'move' : 'copy'
    onDragOverTarget({
      lane: band.laneIndex,
      index: insertIndexFor(list, event.clientY, lanes[band.laneIndex]?.entries.length ?? 0),
    })
  }

  const showDrop = dropActive && acceptsDrops && over !== null && over.lane === band.laneIndex
  // The last entry index this band actually shows. A drop past it renders the
  // trailing indicator — the band may hold only part of its track (the ordered
  // remainder beneath `Now`, or a track whose delivered steps moved to the
  // footer), so "the end of the lane" is not the same as "the end of the band".
  const lastShownIndex = band.rows.length > 0 ? band.rows[band.rows.length - 1].entryIndex : -1

  return (
    <div>
      {band.kind === 'rest' && leading ? null : (
        <div className="flex items-center gap-2 px-2 py-1 pt-2.5 text-micro font-medium text-[color:var(--text-subtle)]">
          {band.label ? <span className="shrink-0">{band.label}</span> : null}
          <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-[color:var(--border-subtle)]" />
          {band.count ? (
            <span className="shrink-0 tabular-nums text-[color:var(--text-disabled)]">{band.count}</span>
          ) : null}
          {/* A track band owns its own track's edits; a single-track plan keeps
              them on the head, beside the name they act on. */}
          {band.kind === 'track' ? (
            <OverflowMenu
              ariaLabel={`Options for ${band.label ?? 'this track'}`}
              triggerTooltip="Track options"
              items={[
                ...trackSteeringItems(band.label, steering),
                { kind: 'separator' as const, id: 'sep-track' },
                { id: 'rename', label: 'Rename track…', onSelect: () => onRenameTrack(band.laneIndex) },
                ...(band.laneIndex < trackCount - 1
                  ? [
                      {
                        id: 'merge',
                        label: 'Merge into the track below',
                        onSelect: () => onLanes(mergeLaneDown(lanes, band.laneIndex)),
                      },
                    ]
                  : []),
                {
                  id: 'remove',
                  label: 'Remove track',
                  destructive: true,
                  onSelect: () => onRemoveTrack(band.laneIndex),
                },
              ]}
            />
          ) : null}
        </div>
      )}
      <ul
        ref={listRef}
        className="flex flex-col"
        onDragOver={handleDragOver}
        onDrop={(event) => {
          if (!acceptsDrops) return
          event.preventDefault()
          onDrop()
        }}
      >
        {band.rows.length === 0 && band.kind !== 'now' ? (
          <li className="list-none px-2 py-2 text-micro text-[color:var(--text-muted)]">
            {band.kind === 'track' ? 'No steps in this track yet.' : 'Nothing queued — use “Add work”.'}
          </li>
        ) : null}
        {band.rows.map((row) => (
          <React.Fragment key={row.ref}>
            {/* The kit's lane indicator, a sibling row rather than a stripe
                nested inside the next one. */}
            {showDrop && over?.index === row.entryIndex ? <BoardLaneDropIndicator /> : null}
            <li className="list-none">
              <StepRow
                row={row}
                selected={row.ref === selectedRef}
                cursored={row.ref === cursorRef}
                dragging={drag?.lane === row.laneIndex && drag.index === row.entryIndex}
                showProjectTag={showProjectTag}
                rosters={rosters}
                policyRoster={policyRoster}
                onManageRosters={onManageRosters}
                onSelect={() => onSelect(row.ref)}
                onSetRoster={(roster) => onLanes(setEntryRoster(lanes, row.laneIndex, row.entryIndex, roster))}
                onDragStart={() => onDragStart({ lane: row.laneIndex, index: row.entryIndex })}
                onDragEnd={onDragEnd}
                onMenu={(position) => onRowMenu(row, position)}
                buttonRef={(node) => rowRefs.current.set(row.ref, node)}
              />
            </li>
          </React.Fragment>
        ))}
        {showDrop && over !== null && over.index > lastShownIndex ? <BoardLaneDropIndicator /> : null}
      </ul>
    </div>
  )
}

// ── the row ──────────────────────────────────────────────────────────────────

function StepRow({
  row,
  selected,
  cursored: active,
  dragging,
  showProjectTag,
  rosters,
  policyRoster,
  onManageRosters,
  onSelect,
  onSetRoster,
  onDragStart,
  onDragEnd,
  onMenu,
  buttonRef,
}: {
  row: HorizonStepRow
  selected: boolean
  cursored: boolean
  dragging: boolean
  showProjectTag: boolean
  rosters: ReadonlyArray<SprintEngineRoster>
  policyRoster: string | undefined
  onManageRosters: () => void
  onSelect: () => void
  onSetRoster: (roster: string | undefined) => void
  onDragStart: () => void
  onDragEnd: () => void
  onMenu: (position: { x: number; y: number }) => void
  /** Registers the row button so the column can focus it as the cursor moves. */
  buttonRef: (node: HTMLButtonElement | null) => void
}): JSX.Element {
  return (
    <div
      data-step="true"
      data-entry-index={row.entryIndex}
      data-step-ref={row.ref}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu({ x: event.clientX, y: event.clientY })
      }}
      className={`group/step relative flex ${dragging ? 'opacity-50' : ''}`}
    >
      <button
        ref={buttonRef}
        type="button"
        data-step-row="true"
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        // Identifier and title in one accessible name, as the family contract asks.
        aria-label={`${row.displayId ? `${row.displayId}: ` : ''}${row.title}${
          row.sizeLabel ? `, ${sizeCountLabel(row.sizeLabel)}` : ''
        }${row.ready ? ', ready to start' : row.notice ? `, ${noticeLabel(row.notice.kind).toLowerCase()}` : ''}`}
        // Rounded like every other row in this rail: the plan is a group of the
        // rail now, not a column with its own full-bleed rows.
        // `px-2 gap-2` and the 16px slot below put the title on the rail's own
        // 36px text edge (MC-2099, grid per MC-2101). The height is now
        // content-driven — two lines of text — because the 26px single-line row
        // truncated every title to a stub and made the plan unreadable without
        // clicking each step in turn.
        // Cursor ≠ focus: the j/k cursor is the hover fill, the picked row is
        // the selected fill, and the shared ring marks DOM focus alone. A
        // second inset ring in the focus hue put two rings on one row.
        className={`flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${FOCUS_RING_CLASS} ${
          selected
            ? 'bg-[color:var(--bg-selected)]'
            : active
              ? 'bg-[color:var(--bg-hover)]'
              : 'hover:bg-[color:var(--bg-hover)]'
        }`}
      >
        {/* One icon slot, the same swap the app sidebar's folder rows use: the
            state glyph at rest, the grip on hover. A dedicated 11px handle column
            is what pushed this title 9px past every other row in the column, and
            it bought nothing — the whole row is `draggable`, so the grip is a
            signal that dragging is possible, never the only place to grab.
            `mt-px` optically centres the 16px glyph on the title's first line. */}
        <span className="relative mt-px flex size-icon-sm shrink-0 items-center justify-center">
          {/* Only a genuinely live run animates; a queued step's glyph is static.
              A ref that resolves to nothing reads blocked, whatever its position. */}
          <LifecycleGlyph
            state={row.unresolved || row.projectUnavailable ? 'blocked' : roadmapUnitLifecycle[row.state]}
            live={!row.unresolved && !row.projectUnavailable && row.state === 'running'}
            className="shrink-0 transition-opacity group-hover/step:opacity-0"
          />
          <span
            aria-hidden="true"
            className="absolute inset-0 m-auto flex cursor-grab items-center justify-center text-[color:var(--text-disabled)] opacity-0 transition-opacity group-hover/step:opacity-100"
          >
            <GripGlyph />
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {row.unresolved || row.projectUnavailable ? (
            // Surfaced, never silently dropped — but the two cases are different
            // problems and must not read the same. A step whose PROJECT is closed
            // is probably fine; telling the author to remove it would be wrong,
            // and the detail pane says the opposite 400px to the right.
            <span
              className="min-w-0 truncate font-mono text-micro text-[color:var(--text-disabled)]"
              title={
                row.projectUnavailable
                  ? `${row.projectName} is not open, so this step cannot be read.`
                  : `No backlog item matches “${row.ref}”. Remove the stale step, or create the item.`
              }
            >
              {row.projectUnavailable ? `Not open · ${row.projectName}` : `Unknown · ${row.ref}`}
            </span>
          ) : (
            // The identity line: the minted id, then the title on a two-line
            // clamp with the full text in a tooltip only when clamped. The id
            // hangs at the leading edge so titles align under each other.
            <span className="flex min-w-0 items-baseline gap-1.5">
              {row.displayId ? (
                <span className="shrink-0 font-mono text-micro text-[color:var(--text-subtle)]">
                  {row.displayId}
                </span>
              ) : null}
              <TruncatedText
                as="span"
                multiline
                text={row.title}
                placement="bottom"
                className={`min-w-0 flex-1 line-clamp-2 text-meta leading-snug ${
                  selected
                    ? 'font-medium text-[color:var(--text-strong)]'
                    : 'text-[color:var(--text-default)]'
                }`}
              />
            </span>
          )}
          {/* The meta line. State reads at the leading edge; the count sits
              with the team at the TRAILING edge so nothing strands mid-line —
              the count alone at the left with the chip far right read as two
              unrelated scraps. The trailing spacer is the team chip's gutter,
              reserved rather than filled because the chip is a SIBLING of this
              button (one click target per row). */}
          <span className="flex min-w-0 items-center gap-1.5 text-micro text-[color:var(--text-subtle)]">
            {row.ready ? (
              // Good news in the accent (the lifecycle vocabulary's own "ready"
              // hue), never the warn tone: this is the rail's whole answer to
              // "which step can I start?". The kit badge, with no dot inside it
              // — the pill and a dot said it twice. The row's aria-label already
              // reads "ready to start", so the badge is decorative.
              <Badge tone="accent" decorative className="shrink-0">
                Ready
              </Badge>
            ) : row.notice ? (
              // Attention as ONE word, the same volume as Ready: the status dot
              // and its label. The reason and the action are the detail
              // header's — the rail only flags.
              <span className="inline-flex shrink-0 items-center gap-1 font-medium leading-4 text-[color:var(--text-default)]">
                <StatusDot tone="warn" />
                {noticeLabel(row.notice.kind)}
              </span>
            ) : null}
            {showProjectTag ? (
              <span
                className="shrink-0 max-w-[7rem] truncate rounded-sm border border-[color:var(--border-subtle)] px-1 font-mono leading-4"
                title={
                  row.state === 'unknown_project'
                    ? `${row.projectName} — this project is not open`
                    : `In ${row.projectName}`
                }
              >
                {row.projectName}
              </span>
            ) : null}
            {row.sizeLabel ? (
              <Tooltip
                content={sizeTooltip(row.sizeLabel)}
                placement="top"
                wrapperClassName="ml-auto inline-flex min-w-0"
              >
                <span className="truncate tabular-nums">{sizeCountLabel(row.sizeLabel)}</span>
              </Tooltip>
            ) : null}
            <span
              aria-hidden="true"
              className={`w-[5.25rem] shrink-0 ${row.sizeLabel ? '' : 'ml-auto'}`}
            />
          </span>
        </span>
      </button>
      {/* The step's TEAM, resting on the row (MC-2066) — a sibling of the row
          button, never nested: one click target per row stays the rule, and a
          button inside a button is invalid HTML. Anchored to the meta line's
          trailing edge, inside the gutter that line reserves. Picking a team is
          one click from here; the horizon's default is what an untouched step
          inherits, not the only comfortable way to set anything. */}
      <span className="absolute bottom-1 right-2">
        <RosterMenu
          variant="row"
          ariaLabel={`Team for ${row.title}`}
          rosters={rosters}
          selectedName={row.roster.label}
          inherit={{
            selected: !row.roster.overridden,
            resolvedLabel: policyRoster?.trim() || NO_ROLES_ROSTER_NAME,
            onChoose: () => onSetRoster(undefined),
          }}
          onSelect={(name) => onSetRoster(name ?? NO_ROLES_ROSTER_NAME)}
          onManageRosters={onManageRosters}
        />
      </span>
    </div>
  )
}

/** A track's attention in one word, for the row's meta line. The rail flags;
 *  the detail header explains and acts. */
export function noticeLabel(kind: HorizonStepNoticeKind): string {
  return kind === 'paused' ? 'Paused' : kind === 'merge' ? 'PR waiting' : 'Blocked'
}

/** The count with its unit — "5 items", "1 item", "1/2 items". The bare number
 *  the trailing slot used to show told nobody what it was counting. */
export function sizeCountLabel(sizeLabel: string): string {
  return `${sizeLabel} ${sizeLabel === '1' ? 'item' : 'items'}`
}

/** What the size count means, spelled out for the pointer: the bare "5" told
 *  nobody it was counting an epic's children. */
export function sizeTooltip(sizeLabel: string): string {
  if (sizeLabel.includes('/')) {
    const [done, total] = sizeLabel.split('/')
    return `${done} of ${total} child items delivered`
  }
  return `${sizeLabel} child ${sizeLabel === '1' ? 'item' : 'items'} in this epic`
}

// ── delivered ────────────────────────────────────────────────────────────────

function DeliveredFooter({
  delivered,
  open,
  onToggle,
  selectedRef,
  onSelect,
}: {
  delivered: HorizonPlan['delivered']
  open: boolean
  onToggle: () => void
  selectedRef: string | null
  onSelect: (ref: string) => void
}): JSX.Element {
  return (
    <div className="shrink-0 border-t border-[color:var(--border-subtle)]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`flex w-full items-center gap-1.5 px-2 py-2 text-left text-micro text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
      >
        <ChevronGlyph open={open} />
        Delivered
        <span className="ml-auto tabular-nums text-micro text-[color:var(--text-subtle)]">
          {delivered.steps} {delivered.steps === 1 ? 'step' : 'steps'} · {delivered.items}{' '}
          {delivered.items === 1 ? 'item' : 'items'}
        </span>
      </button>
      {open ? (
        // No height cap and no scrollport: the rail column owns exactly one
        // scroll region and this list is inside it (MC-2099). `max-h-[40vh]
        // overflow-y-auto` made delivered steps scroll independently of the plan
        // they belong to — two wheels in one column, and neither showed how much
        // was left in the other.
        <ul className="pb-1">
          {delivered.rows.map((row) => (
            <li key={row.ref} className="list-none">
              <div className="group/step relative flex">
                <button
                  type="button"
                  aria-current={row.ref === selectedRef ? 'true' : undefined}
                  onClick={() => onSelect(row.ref)}
                  className={`flex h-[26px] w-full min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors ${FOCUS_RING_CLASS} ${
                    row.ref === selectedRef
                      ? 'bg-[color:var(--bg-selected)]'
                      : 'hover:bg-[color:var(--bg-hover)]'
                  }`}
                >
                  {/* The same 16px slot the live steps use — a delivered row has
                      no grip, but it must land on the same text edge. */}
                  <span className="flex size-icon-sm shrink-0 items-center justify-center">
                    <LifecycleGlyph state="done" live={false} className="shrink-0" />
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-meta text-[color:var(--text-muted)]"
                    title={row.title}
                  >
                    {row.title}
                  </span>
                </button>
                {/* The delivering pull request, on the row that delivered it. */}
                {row.prUrl ? (
                  <a
                    href={row.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`View the pull request for ${row.title}`}
                    className={`absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 text-micro font-medium text-[color:var(--accent-primary)] opacity-0 transition-opacity hover:underline group-hover/step:opacity-100 focus-visible:opacity-100 ${FOCUS_RING_CLASS}`}
                  >
                    PR
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

// ── the row's own menu ───────────────────────────────────────────────────────

function StepContextMenu({
  row,
  x,
  y,
  lanes,
  onClose,
  onLanes,
  onOpenItem,
}: {
  row: HorizonStepRow
  x: number
  y: number
  lanes: RoadmapLane[]
  onClose: () => void
  onLanes: (next: RoadmapLane[]) => void
  onOpenItem: (row: HorizonStepRow) => void
}): JSX.Element {
  // Delivered work and a step a sprint is executing are not the plan's to edit:
  // removing either would either re-run finished work or strand a live run.
  const removable = row.state !== 'done' && row.state !== 'running'
  const close = (run: () => void) => () => {
    onClose()
    run()
  }
  return (
    <ContextMenu x={x} y={y} ariaLabel={`Actions for ${row.title}`} onClose={onClose}>
      <MenuItem onClick={close(() => onOpenItem(row))}>Open in Backlog</MenuItem>
      {row.entryIndex > 0 ? (
        <MenuItem onClick={close(() => onLanes(splitLane(lanes, row.laneIndex, row.entryIndex)))}>
          Split the track here
        </MenuItem>
      ) : null}
      {removable ? (
        <MenuItem
          variant="danger"
          onClick={close(() => onLanes(removeEntry(lanes, row.laneIndex, row.entryIndex)))}
        >
          Remove step
        </MenuItem>
      ) : null}
    </ContextMenu>
  )
}

// ── shared chrome ────────────────────────────────────────────────────────────

// Which ENTRY index a drop at this pointer position lands on. Rows carry their
// own entry index, so a band showing only part of a track (the ordered remainder
// beneath `Now`, or a track whose delivered steps moved to the footer) still
// resolves to the right position in the underlying lane.
export function insertIndexFor(list: HTMLElement, clientY: number, laneLength: number): number {
  const rows = list.querySelectorAll<HTMLElement>('[data-step="true"]')
  for (let index = 0; index < rows.length; index += 1) {
    const rect = rows[index].getBoundingClientRect()
    if (clientY < rect.top + rect.height / 2) return Number(rows[index].dataset.entryIndex ?? index)
  }
  const last = rows[rows.length - 1]
  return last ? Number(last.dataset.entryIndex ?? laneLength) + 1 : laneLength
}

function GripGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="icon-xs">
      <circle cx="6" cy="4" r="1.1" />
      <circle cx="10" cy="4" r="1.1" />
      <circle cx="6" cy="8" r="1.1" />
      <circle cx="10" cy="8" r="1.1" />
      <circle cx="6" cy="12" r="1.1" />
      <circle cx="10" cy="12" r="1.1" />
    </svg>
  )
}

function ChevronGlyph({ open }: { open: boolean }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={`icon-xs shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
