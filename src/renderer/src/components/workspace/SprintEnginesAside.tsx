import { useCallback, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import {
  CloseIconButton,
  ContextMenu,
  FilterMenu,
  InboxRow,
  InboxSearchInput,
  LifecycleGlyph,
  MenuItem,
  PanelHeader,
  type SelectItem,
} from '../ui'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { deriveWorkspaceRunGlyph } from '../../utils/workspaceRunGlyph'
import {
  buildSprintEngineNavRows,
  compareSprintsRows,
  isSprintEngineWorkspace,
  matchesSprintsQuery,
  matchesSprintsView,
  type SprintsSort,
  type SprintsView,
} from '../../utils/sprintEnginesNav'
import type { WorkspaceId } from '../../types/workspace'
import { FOCUS_RING_CLASS } from '../ui/tokens'
import {
  SPRINTS_ASIDE_DEFAULT_WIDTH,
  SPRINTS_ASIDE_MIN_WIDTH,
  clampSprintsAsideWidth,
} from './sprintsAsideWidth'

type SprintEnginesAsideProps = {
  // The window's active workspace, not the global one — selection highlights
  // and row activation stay window-scoped like the sidebar's.
  activeWorkspaceId: WorkspaceId | null
  // Workspaces routed to THIS window. setActiveWorkspaceForWindow silently
  // no-ops for a workspace hosted in another window, so those rows render
  // disabled instead of swallowing the click.
  windowWorkspaceIds: ReadonlySet<string>
  onSelectWorkspace: (workspaceId: WorkspaceId) => void
  onClose: () => void
}

const VIEW_ITEMS: ReadonlyArray<SelectItem<SprintsView>> = [
  { value: 'active', label: 'All' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
]

const SORT_ITEMS: ReadonlyArray<SelectItem<SprintsSort>> = [
  { value: 'attention', label: 'Attention first' },
  { value: 'updated_desc', label: 'Recently updated' },
  { value: 'updated_asc', label: 'Oldest updated' },
  { value: 'created_desc', label: 'Recently created' },
  { value: 'created_asc', label: 'Oldest created' },
]

const ALL_PROJECTS = '__all_projects__'

type RowMenuState = {
  workspaceId: WorkspaceId
  name: string
  archived: boolean
  canArchive: boolean
  inWindow: boolean
  x: number
  y: number
}

// The global Sprint Engines aside: "what is running and what needs me" across
// every workspace. It docks OUTSIDE the rounded workspace card, on the same
// --bg-app gutter as the workspace sidebar, so the ink scale itself says
// "app-level survey" — per-workspace tools (Files / Git / Backlog) live inside
// the card; this surface deliberately does not. Selecting a row swaps the
// workspace card underneath while the aside stays put, which is the whole
// point of hoisting it out of the per-workspace FlexLayout model.
//
// Toolbar mirrors the Backlog panel idiom: an at-rest search input plus one
// FilterMenu glyph holding the View / Project / Sort axes. Search is ephemeral
// component state; the axes live in the store (sprintsAsideView) so they
// survive closing and reopening the aside. Archiving is presentation-level: it
// stamps `archivedAt` on the workspace, which hides it from the sidebar rail
// and this list's default lenses — the Archived lens shows and restores them.
export default function SprintEnginesAside({
  activeWorkspaceId,
  windowWorkspaceIds,
  onSelectWorkspace,
  onClose,
}: SprintEnginesAsideProps) {
  // The aside only ever shows Sprint Engine workspaces, so subscribe to just
  // those (the same useShallow pattern as BacklogPanel Task 1). With Task 3's
  // no-op guard keeping unchanged workspace refs stable, an unrelated workspace's
  // projection tick — or any non-Sprint-Engine change — leaves this slice
  // shallow-equal and does not re-render the global aside. The run glyph is a
  // pure function of sprint state (deriveWorkspaceRunGlyph → the Sprint Engine
  // provider), so terminal-session churn no longer touches this surface at all.
  const sprintEngineWorkspaces = useWorkspaceStore(
    useShallow((state) => state.workspaces.filter((workspace) => isSprintEngineWorkspace(workspace))),
  )
  const { view, project, sort } = useWorkspaceStore(useShallow((state) => state.sprintsAsideView))
  const setSprintsAsideView = useWorkspaceStore((state) => state.setSprintsAsideView)
  const setWorkspaceArchived = useWorkspaceStore((state) => state.setWorkspaceArchived)
  const sprintsAsideWidth = useWorkspaceStore((state) => state.sprintsAsideWidth)
  const setSprintsAsideWidth = useWorkspaceStore((state) => state.setSprintsAsideWidth)

  const [search, setSearch] = useState('')
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null)

  const asideRef = useRef<HTMLElement>(null)
  // Live width during an active drag — written straight to the element (never
  // the store) so no frame pays for a persisted-registry re-serialization; the
  // store gets the final width once on pointer-up. A stray re-render mid-drag
  // re-reads this ref instead of snapping back to the stale store value. Same
  // idiom as the workspace sidebar's resize (WorkspaceSidebar).
  const dragWidthRef = useRef<number | null>(null)

  // Drag the aside's left edge to resize. The aside is right-docked, so moving
  // the pointer LEFT widens it. rAF-coalesced: at most one pure DOM width
  // write per frame.
  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      const startX = event.clientX
      const startWidth = dragWidthRef.current ?? sprintsAsideWidth
      let frame: number | null = null
      let pendingX = startX
      dragWidthRef.current = startWidth

      const apply = () => {
        frame = null
        const width = clampSprintsAsideWidth(startWidth + (startX - pendingX))
        dragWidthRef.current = width
        if (asideRef.current) asideRef.current.style.width = `${width}px`
      }
      const onMove = (e: PointerEvent) => {
        pendingX = e.clientX
        if (frame === null) frame = window.requestAnimationFrame(apply)
      }
      const onUp = () => {
        if (frame !== null) window.cancelAnimationFrame(frame)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        const finalWidth = dragWidthRef.current
        dragWidthRef.current = null
        if (finalWidth !== null) setSprintsAsideWidth(finalWidth)
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [sprintsAsideWidth, setSprintsAsideWidth]
  )

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const STEP = 16
      // Left-docked edge of a right-docked panel: ArrowLeft widens.
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setSprintsAsideWidth(sprintsAsideWidth + STEP)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        setSprintsAsideWidth(Math.max(SPRINTS_ASIDE_MIN_WIDTH, sprintsAsideWidth - STEP))
      } else if (event.key === 'Home') {
        event.preventDefault()
        setSprintsAsideWidth(SPRINTS_ASIDE_DEFAULT_WIDTH)
      }
    },
    [sprintsAsideWidth, setSprintsAsideWidth]
  )

  const rows = useMemo(
    () => buildSprintEngineNavRows(sprintEngineWorkspaces, (workspace) => deriveWorkspaceRunGlyph(workspace)),
    [sprintEngineWorkspaces],
  )

  const projectItems = useMemo(() => {
    const names = [...new Set(
      rows.map((row) => row.projectName).filter((name): name is string => name !== null),
    )].sort((a, b) => a.localeCompare(b))
    return [
      { value: ALL_PROJECTS, label: 'All projects' },
      ...names.map((name) => ({ value: name, label: name })),
    ]
  }, [rows])

  // A remembered project whose sprints have all gone away falls back to All
  // instead of silently filtering everything out.
  const effectiveProject = useMemo(
    () => (project !== null && projectItems.some((item) => item.value === project) ? project : null),
    [project, projectItems],
  )

  // One filter+sort pipeline, all pure functions (sprintEnginesNav) — the list
  // recomputes only when its inputs change, never per keystroke elsewhere.
  const filtered = useMemo(
    () =>
      rows
        .filter(
          (row) =>
            matchesSprintsView(row, view)
            && (effectiveProject === null || row.projectName === effectiveProject)
            && matchesSprintsQuery(row, search),
        )
        .sort((a, b) => compareSprintsRows(a, b, sort)),
    [rows, view, effectiveProject, search, sort],
  )

  return (
    <aside
      ref={asideRef}
      aria-label="Sprints"
      className="relative flex h-full shrink-0 flex-col bg-[color:var(--bg-app)]"
      // No entrance animation on purpose: animating the width reflows the
      // whole workspace card (terminals included) every frame and reads as
      // lag. The aside mounts instantly, like the workspace sidebar. During a
      // drag the live width comes from dragWidthRef (written straight to the
      // element), so a mid-drag re-render keeps the pointer width.
      style={{ width: clampSprintsAsideWidth(dragWidthRef.current ?? sprintsAsideWidth) }}
    >
      {/* Drag the left edge to resize (same idiom as the workspace sidebar). */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Sprints panel"
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
        className={`group absolute left-0 top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize focus:outline-none ${FOCUS_RING_CLASS}`}
      >
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[color:var(--accent-primary)] opacity-0 transition-opacity group-hover:opacity-60"
        />
      </div>
      <PanelHeader
        tool="sprintengine"
        title="Sprints"
        subtitle={view === 'archived' ? 'archived' : undefined}
        count={filtered.length > 0 ? filtered.length : undefined}
        primaryAction={<CloseIconButton aria-label="Close Sprints" onClick={onClose} />}
      />
      <div
        className="flex shrink-0 items-center gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && search) {
            event.stopPropagation()
            setSearch('')
          }
        }}
      >
        <div className="flex min-w-0 flex-1">
          <InboxSearchInput
            value={search}
            onChange={setSearch}
            ariaLabel="Search sprints"
            placeholder="Search sprints…"
            clearAriaLabel="Clear sprint search"
          />
        </div>
        <FilterMenu
          ariaLabel="Filter and sort sprints"
          className="shrink-0"
          groups={[
            {
              label: 'View',
              items: VIEW_ITEMS,
              value: view,
              defaultValue: 'active',
              onChange: (value) => setSprintsAsideView({ view: value as SprintsView }),
            },
            {
              label: 'Project',
              items: projectItems,
              value: effectiveProject ?? ALL_PROJECTS,
              defaultValue: ALL_PROJECTS,
              onChange: (value) =>
                setSprintsAsideView({ project: value === ALL_PROJECTS ? null : value }),
            },
            {
              label: 'Sort by',
              items: SORT_ITEMS,
              value: sort,
              defaultValue: 'attention',
              onChange: (value) => setSprintsAsideView({ sort: value as SprintsSort }),
            },
          ]}
        />
      </div>
      {rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <div className="max-w-xs">
            <div className="text-[13px] font-semibold text-[color:var(--text-strong)]">
              No sprints running yet
            </div>
            <p className="mt-2 text-[12px] leading-5 text-[color:var(--text-muted)]">
              Sprints appear here with their live run state. Start one from a
              Backlog item with &ldquo;Run a Sprint&rdquo;, or create a sprint
              workspace.
            </p>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <div className="max-w-xs">
            <div className="text-[13px] font-semibold text-[color:var(--text-strong)]">
              No sprints match
            </div>
            <p className="mt-2 text-[12px] leading-5 text-[color:var(--text-muted)]">
              Adjust the view, project, or search to see more.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto py-1">
          {filtered.map((row) => {
            const inWindow = windowWorkspaceIds.has(row.workspaceId)
            const supporting = [row.projectName, row.goal].filter(Boolean).join(' · ')
            return (
              <div
                key={row.workspaceId}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setRowMenu({
                    workspaceId: row.workspaceId,
                    name: row.name,
                    archived: row.archived,
                    // A live or input-awaiting run must stay visible — archiving
                    // it would hide a sprint that still needs the user.
                    canArchive: !(row.glyph?.live || row.glyph?.state === 'needs_input'),
                    inWindow,
                    x: event.clientX,
                    y: event.clientY,
                  })
                }}
              >
                <InboxRow
                  hideDot
                  leading={
                    row.glyph ? (
                      <LifecycleGlyph state={row.glyph.state} live={row.glyph.live} label={row.glyph.label} />
                    ) : undefined
                  }
                  title={row.name}
                  supporting={inWindow ? supporting || undefined : 'Open in another window'}
                  trailing={row.totalTasks > 0 ? `${row.doneTasks}/${row.totalTasks}` : undefined}
                  selected={row.workspaceId === activeWorkspaceId}
                  disabled={!inWindow}
                  ariaLabel={inWindow ? undefined : `${row.name} — open in another window`}
                  onSelect={() => onSelectWorkspace(row.workspaceId)}
                />
              </div>
            )
          })}
        </div>
      )}
      {rowMenu ? (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          ariaLabel={`Sprint actions — ${rowMenu.name}`}
          onClose={() => setRowMenu(null)}
        >
          <MenuItem
            disabled={!rowMenu.inWindow}
            onClick={() => {
              onSelectWorkspace(rowMenu.workspaceId)
              setRowMenu(null)
            }}
          >
            Open
          </MenuItem>
          {rowMenu.archived ? (
            <MenuItem
              onClick={() => {
                setWorkspaceArchived(rowMenu.workspaceId, false)
                setRowMenu(null)
              }}
            >
              Unarchive sprint
            </MenuItem>
          ) : (
            <MenuItem
              disabled={!rowMenu.canArchive}
              onClick={() => {
                setWorkspaceArchived(rowMenu.workspaceId, true)
                setRowMenu(null)
              }}
            >
              {rowMenu.canArchive ? 'Archive sprint' : 'Archive sprint (run is active)'}
            </MenuItem>
          )}
        </ContextMenu>
      ) : null}
    </aside>
  )
}
