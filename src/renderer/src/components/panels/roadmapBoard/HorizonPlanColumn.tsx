// The plan column (MC-1924, mockup `2026-07-27-horizon-plan-detail-v2.html`
// frame 1) — the middle pane of the Horizon door, and the surface that replaced
// `RoadmapLaneColumn`'s container-for-everything.
//
// What it is: a 360px column of ONE-LINE selectable steps. `Now` names the
// running step because it is the only group the order does not already imply;
// everything after it is a plain ordered list; `Delivered` is a closed footer at
// the bottom. Two or more tracks become named bands in this ONE column — never
// side-by-side kanban — so there is still exactly one selection driving one
// detail pane.
//
// What a row says, and nothing more: a lifecycle glyph, the title, and its size.
// No id (the detail carries it), no status word beside the glyph that already
// says it, and no project tag repeated on every row of a single-project horizon.
//
// Editing happens HERE — drag to reorder within and across tracks, drop from the
// detail pane's backlog mode to add, right-click to remove, the trailing chip to
// staff. Every edit is a write to the horizon file through the shared autosave
// (useRoadmapPlanDraft); there is no edit mode and no save button.
//
// A track's attention — a park, an approval, a merge — renders as a compact
// notice attached to the step it happened to, carrying the real reason and the
// one action that clears it. This is where the deleted "Waiting on you" strip's
// job now lives (MC-1922).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  ContextMenu,
  GhostButton,
  LifecycleGlyph,
  MenuItem,
  OverflowMenu,
  PrimaryButton,
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
import type { HorizonBand, HorizonPlan, HorizonStepRow } from './horizonPlanModel'

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
  onResyncEpic: (laneIndex: number, entryIndex: number) => void
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
  /** The selected step's detail is showing a run strip, which carries the same
   *  merge action louder. ONLY then is the row's merge notice suppressed —
   *  the notice is attached by fallback when the track names no active item, and
   *  suppressing it blindly removed the only way to merge. */
  selectedHasRunStrip?: boolean
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
  onResyncEpic,
  onOpenItem,
  onAddWork,
  addWorkActive,
  libraryDragRef,
  steering,
  onRenameTrack,
  onRemoveTrack,
  cursorRef = null,
  selectedHasRunStrip = false,
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
      className="flex w-[360px] shrink-0 flex-col border-r border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]"
    >
      <header className="flex h-[34px] shrink-0 items-center gap-1.5 border-b border-[color:var(--border-subtle)] pl-2.5 pr-1.5">
        <TruncatedText
          as="h2"
          text={plan.headTitle}
          className="min-w-0 flex-1 text-[13px] font-semibold text-[color:var(--text-strong)]"
        />
        {/* The one call to action on this pane. It reads as current while the
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

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {plan.bands.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] leading-5 text-[color:var(--text-muted)]">
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
              selectedHasRunStrip={selectedHasRunStrip}
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
              onResyncEpic={onResyncEpic}
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
          onResyncEpic={onResyncEpic}
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
  selectedHasRunStrip,
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
  onResyncEpic,
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
  selectedHasRunStrip: boolean
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
  onResyncEpic: (laneIndex: number, entryIndex: number) => void
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
        <div className="flex items-center gap-2 py-1 pl-2.5 pr-1.5 pt-2.5 text-[10px] font-medium text-[color:var(--text-subtle)]">
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
          <li className="list-none px-2.5 py-2 text-[11px] text-[color:var(--text-disabled)]">
            {band.kind === 'track' ? 'No steps in this track yet.' : 'Nothing queued — use “Add work”.'}
          </li>
        ) : null}
        {band.rows.map((row) => (
          <li key={row.ref} className="list-none">
            {showDrop && over?.index === row.entryIndex ? <DropIndicator /> : null}
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
            {row.drift ? (
              <DriftAffordance drift={row.drift} onResync={() => onResyncEpic(row.laneIndex, row.entryIndex)} />
            ) : null}
            {/* The selected step's merge action is already the loud primary in
                the detail pane 400px right, but ONLY when that pane actually
                mounted a run strip for it — the notice can be attached by
                fallback to a step the detail will not claim, and suppressing it
                then removed the only way to merge. */}
            {row.notice
            && !(row.ref === selectedRef && row.notice.kind === 'merge' && selectedHasRunStrip) ? (
              <StepNotice row={row} steering={steering} />
            ) : null}
          </li>
        ))}
        {showDrop && over !== null && over.index > lastShownIndex ? <DropIndicator /> : null}
      </ul>
    </div>
  )
}

// ── the row ──────────────────────────────────────────────────────────────────

function StepRow({
  row,
  selected,
  cursored,
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
        aria-label={`${row.title}${row.sizeLabel ? `, ${row.sizeLabel} items` : ''}`}
        className={`flex h-[26px] w-full min-w-0 items-center gap-1.5 pl-1.5 pr-2 text-left transition-colors ${FOCUS_RING_CLASS} ${
          selected
            ? 'bg-[color:var(--bg-selected)]'
            : 'hover:bg-[color:var(--bg-hover)]'
        } ${cursored ? 'ring-2 ring-inset ring-[color:var(--border-focus)]' : ''}`}
      >
        <span
          aria-hidden="true"
          className="flex w-[11px] shrink-0 cursor-grab justify-center text-[color:var(--text-disabled)] opacity-0 transition-opacity group-hover/step:opacity-100"
        >
          <GripGlyph />
        </span>
        {/* Only a genuinely live run animates; a queued step's glyph is static.
            A ref that resolves to nothing reads blocked, whatever its position. */}
        <LifecycleGlyph
          state={row.unresolved || row.projectUnavailable ? 'blocked' : roadmapUnitLifecycle[row.state]}
          live={!row.unresolved && !row.projectUnavailable && row.state === 'running'}
          className="shrink-0"
        />
        {row.unresolved || row.projectUnavailable ? (
          // Surfaced, never silently dropped — but the two cases are different
          // problems and must not read the same. A step whose PROJECT is closed
          // is probably fine; telling the author to remove it would be wrong,
          // and the detail pane says the opposite 400px to the right.
          <span
            className="min-w-0 flex-1 truncate font-mono text-[11px] text-[color:var(--text-disabled)]"
            title={
              row.projectUnavailable
                ? `${row.projectName} is not open in this Multicode, so this step cannot be read.`
                : `No backlog item matches “${row.ref}”. Remove the stale step, or create the item.`
            }
          >
            {row.projectUnavailable ? `Not open · ${row.projectName}` : `Unknown · ${row.ref}`}
          </span>
        ) : (
          <span
            className={`min-w-0 flex-1 truncate text-[12px] ${
              selected
                ? 'font-medium text-[color:var(--text-strong)]'
                : 'text-[color:var(--text-default)]'
            }`}
            title={row.title}
          >
            {row.title}
          </span>
        )}
        {showProjectTag ? (
          <span
            className="shrink-0 max-w-[7rem] truncate rounded-sm border border-[color:var(--border-subtle)] px-1 font-mono text-[10px] leading-4 text-[color:var(--text-subtle)]"
            title={
              row.state === 'unknown_project'
                ? `${row.projectName} — this project is not open in this Multicode`
                : `In ${row.projectName}`
            }
          >
            {row.projectName}
          </span>
        ) : null}
        {/* Reserve the roster chip's gutter so revealing it never reflows the
            title mid-hover. */}
        <span aria-hidden="true" className="w-[4.25rem] shrink-0" />
        {/* Fixed width, right-aligned: the roster chip is absolutely positioned
            against this gutter, so a wider count ("12/19") must not grow the
            cell and slide under the chip. */}
        {row.sizeLabel ? (
          <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-[color:var(--text-subtle)]">
            {row.sizeLabel}
          </span>
        ) : null}
      </button>
      {/* A sibling of the row button, never nested — one click target per row
          stays the rule, and a button inside a button is invalid HTML. */}
      <span
        className={`absolute top-1/2 -translate-y-1/2 ${row.sizeLabel ? 'right-[2.75rem]' : 'right-2'}`}
      >
        <RosterMenu
          variant="row"
          ariaLabel={`Roster for ${row.title}`}
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

// ── attention, attached to the work ──────────────────────────────────────────

function StepNotice({ row, steering }: { row: HorizonStepRow; steering: HorizonSteering }): JSX.Element {
  const notice = row.notice as NonNullable<HorizonStepRow['notice']>
  const busy = steering.busyLane === row.laneTitle
  const act = (): void => {
    if (notice.kind === 'paused') steering.onResume(row.laneTitle)
    else if (notice.kind === 'approval') steering.onApprove(row.laneTitle)
    else if (notice.kind === 'merge') steering.onMerge(row.laneTitle)
  }
  return (
    <div className="mb-1.5 ml-6 mr-2 mt-0.5 flex items-start gap-2 rounded-r-[5px] border-l-2 border-[color:var(--tone-warn)] bg-[color:var(--tone-warn-soft)] px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="text-[11px] leading-4 text-[color:var(--text-muted)]">{notice.message}</p>
        {/* What actually failed — the project, the branch, the underlying reason.
            A pause a person cannot act on is the defect MC-1909 records; this is
            the reason itself, not added explanation of it. */}
        {notice.detail ? (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-4 text-[color:var(--text-subtle)]">
            {notice.detail}
          </p>
        ) : null}
      </div>
      {/* Only when there IS one action. A track stalled on a prerequisite is
          fixed in the backlog, not here, so it states the reason and offers no
          button rather than a control that cannot help. */}
      {notice.actionLabel ? (
        <PrimaryButton size="xs" disabled={busy} onClick={act} className="shrink-0">
          {notice.actionLabel}
        </PrimaryButton>
      ) : null}
    </div>
  )
}

// The static-plan drift affordance: a calm note that the epic's membership moved
// since it was snapshotted, with one-click re-sync.
function DriftAffordance({
  drift,
  onResync,
}: {
  drift: { gained: number; removed: number }
  onResync: () => void
}): JSX.Element {
  const parts: string[] = []
  if (drift.gained > 0) parts.push(`${drift.gained} new ${drift.gained === 1 ? 'item' : 'items'}`)
  if (drift.removed > 0) parts.push(`${drift.removed} removed`)
  return (
    <div className="mb-1 ml-6 mr-2 mt-0.5 flex items-center gap-2 rounded-[5px] bg-[color:var(--bg-hover)] px-2.5 py-1">
      <span className="min-w-0 flex-1 text-[10px] leading-4 text-[color:var(--text-muted)]">
        This epic has {parts.join(' and ')} since you placed it.
      </span>
      <button
        type="button"
        onClick={onResync}
        className={`interactive shrink-0 rounded px-1.5 text-[10px] font-medium text-[color:var(--accent-primary)] transition-colors hover:bg-[color:var(--bg-active)] ${FOCUS_RING_CLASS}`}
      >
        Update step
      </button>
    </div>
  )
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
        className={`flex w-full items-center gap-1.5 px-2.5 py-2 text-left text-[11px] text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
      >
        <ChevronGlyph open={open} />
        Delivered
        <span className="ml-auto tabular-nums text-[10px] text-[color:var(--text-subtle)]">
          {delivered.steps} {delivered.steps === 1 ? 'step' : 'steps'} · {delivered.items}{' '}
          {delivered.items === 1 ? 'item' : 'items'}
        </span>
      </button>
      {open ? (
        <ul className="max-h-[40vh] overflow-y-auto pb-1">
          {delivered.rows.map((row) => (
            <li key={row.ref} className="list-none">
              <div className="group/step relative flex">
                <button
                  type="button"
                  aria-current={row.ref === selectedRef ? 'true' : undefined}
                  onClick={() => onSelect(row.ref)}
                  className={`flex h-[26px] w-full min-w-0 items-center gap-1.5 pl-1.5 pr-2 text-left transition-colors ${FOCUS_RING_CLASS} ${
                    row.ref === selectedRef
                      ? 'bg-[color:var(--bg-selected)]'
                      : 'hover:bg-[color:var(--bg-hover)]'
                  }`}
                >
                  <span aria-hidden="true" className="w-[11px] shrink-0" />
                  <LifecycleGlyph state="done" live={false} className="shrink-0" />
                  <span
                    className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--text-muted)]"
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
                    className={`absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 text-[10px] font-medium text-[color:var(--accent-primary)] opacity-0 transition-opacity hover:underline group-hover/step:opacity-100 focus-visible:opacity-100 ${FOCUS_RING_CLASS}`}
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
  onResyncEpic,
  onOpenItem,
}: {
  row: HorizonStepRow
  x: number
  y: number
  lanes: RoadmapLane[]
  onClose: () => void
  onLanes: (next: RoadmapLane[]) => void
  onResyncEpic: (laneIndex: number, entryIndex: number) => void
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
      {row.drift ? (
        <MenuItem onClick={close(() => onResyncEpic(row.laneIndex, row.entryIndex))}>Update step</MenuItem>
      ) : null}
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

function DropIndicator(): JSX.Element {
  return <div aria-hidden="true" className="mx-2 my-px h-[2px] rounded-full bg-[color:var(--accent-primary)]" />
}

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
