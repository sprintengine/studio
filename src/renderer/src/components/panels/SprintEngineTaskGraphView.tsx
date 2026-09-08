// Sprint Engine task-graph view — the canvas + minimap + legend + zoom
// controls. Split out of SprintEngineBoardPanel.tsx so the orchestrator
// stays focused on state coordination and the graph carries its own
// keyboard / scroll / zoom / minimap concerns.
//
// Pure layout helpers (buildTaskGraphLayout, edge style, etc.) live in the
// sibling ./sprintEngineTaskGraph module and are imported here. The brand
// exception that permits role-tinted accents on a card and a graph node is
// documented in design-system/foundations/principles.md.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  SprintEngineState,
  SprintEngineTaskBoardColumn,
  SprintEngineTaskStatus,
} from '../../types/workspace'
import {
  getSprintEngineRoleAccent,
  getSprintEngineRoleLabel,
  getSprintEngineTaskBoardColumn,
  hexToRgba,
  sprintEngineTaskBoardColumns,
  sprintEngineTaskStateLabel,
  type SprintEngineAgentRosterItem,
} from '../../utils/sprintengine'
import { formatSprintEngineGoal } from '../../utils/sprintengineRunSummary'
import { isEditableTarget } from '../../utils/keyboard'
import { EmptyState, IconButton, LifecycleGlyph, PanelHeader, Tooltip, TruncatedText } from '../ui'
import { taskBoardColumnToLifecycle } from '../../../../shared/sprintengine/state'
import {
  buildTaskGraphLayout,
  defaultTaskGraphZoom,
  getNextTaskGraphZoom,
  getTaskGraphFocusTaskId,
  maxTaskGraphZoom,
  minTaskGraphZoom,
  taskGraphEdgePath,
  type TaskGraphZoomAnchor,
} from './sprintEngineTaskGraph'

function ZoomInSprintEngineIcon() {
 return (
 <svg viewBox="0 0 16 16" aria-hidden="true" className="icon-sm" fill="none">
 <path
 d="M7.25 11.25a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm2.9-1.1 3.1 3.1M7.25 5.45v3.6M5.45 7.25h3.6"
 stroke="currentColor"
 strokeWidth="1.35"
 strokeLinecap="round"
 strokeLinejoin="round"
 />
 </svg>
 )
}

function ZoomOutSprintEngineIcon() {
 return (
 <svg viewBox="0 0 16 16" aria-hidden="true" className="icon-sm" fill="none">
 <path
 d="M7.25 11.25a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm2.9-1.1 3.1 3.1M5.45 7.25h3.6"
 stroke="currentColor"
 strokeWidth="1.35"
 strokeLinecap="round"
 strokeLinejoin="round"
 />
 </svg>
 )
}

function ResetGraphZoomIcon() {
 return (
 <svg viewBox="0 0 16 16" aria-hidden="true" className="icon-sm" fill="none">
 <path
 d="M12.75 5.5A5 5 0 1 0 13 8m-.25-2.5V2.75m0 2.75H10"
 stroke="currentColor"
 strokeWidth="1.35"
 strokeLinecap="round"
 strokeLinejoin="round"
 />
 </svg>
 )
}

function FitGraphZoomIcon() {
 return (
 <svg viewBox="0 0 16 16" aria-hidden="true" className="icon-sm" fill="none">
 <path
 d="M3.25 6V3.25H6m4 0h2.75V6m0 4v2.75H10m-4 0H3.25V10"
 stroke="currentColor"
 strokeWidth="1.35"
 strokeLinecap="round"
 strokeLinejoin="round"
 />
 </svg>
 )
}

function formatSprintEngineGoalPreview(goal: string): string {
 const formatted = formatSprintEngineGoal(goal)
 if (formatted === 'Untitled sprintengine run') return formatted

 const firstLine = goal
 .split(/\r?\n/)
 .map((line) => line.trim())
 .find(Boolean)
 if (!firstLine) return formatted

 const firstSentence = firstLine.match(/^(.+?[.!?])(?:\s|$)/)?.[1]?.trim()
 return firstSentence || firstLine
}

function taskGraphNodeStatusLabel(
 taskStatus: SprintEngineTaskStatus,
 boardColumn: SprintEngineTaskBoardColumn,
): string {
 // Preserve the `ready` and `review` columns over the semantic task status so the
 // graph mirrors the board lane rather than flattening them to todo/in_progress.
 if (boardColumn === 'ready' || boardColumn === 'review') {
 return sprintEngineTaskBoardColumns.find((column) => column.key === boardColumn)?.label
 ?? sprintEngineTaskStateLabel[taskStatus]
 }
 return sprintEngineTaskStateLabel[taskStatus]
}

// Selection and hover on a graph node speak the same language as every list
// row (ruling 7, 2026-09-02): selected is `--bg-selected` on a strong hairline,
// hover is a background change, focus is the one ring. The role hue lives only
// on the swatch beside the role label; it never reaches the node's chrome, and
// there is no glow, no tone-coloured border and no scale.
//
// `focused` is the node the view auto-centred on (`focusTaskId`). It is marked
// with the shared ring — the same `focus-ring` utility every focus treatment in
// the kit draws, standing here rather than triggered — because the two resting
// states above already spend both neutral grounds and the strong hairline, and
// the rulings leave no glow, no scale and no status hue to spend. A ring layers
// over either state, so "the graph scrolled you to this one" still reads on a
// node that is also the selected one, and panning to a node that looks like
// every other node (what dropping the old focus border left behind) cannot
// happen again.
function taskGraphNodeClass(selected: boolean, focused: boolean): string {
 const resting = selected
 ? 'border-[color:var(--border-strong)] bg-[color:var(--bg-selected)]'
 : 'border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] hover:bg-[color:var(--bg-hover)]'
 return focused ? resting + ' focus-ring' : resting
}

export function SprintEngineTaskGraphView({
 sprintEngineState,
 rosterById,
 selectedTaskId,
 onSelectTask,
}: {
 sprintEngineState: SprintEngineState
 rosterById: Record<string, SprintEngineAgentRosterItem | undefined>
 selectedTaskId: string | null
 onSelectTask: (taskId: string) => void
}) {
 const graph = useMemo(() => buildTaskGraphLayout(sprintEngineState.tasks), [sprintEngineState.tasks])
 const focusTaskId = useMemo(() => getTaskGraphFocusTaskId(sprintEngineState.tasks), [sprintEngineState.tasks])
 const [graphZoom, setGraphZoom] = useState(defaultTaskGraphZoom)
 const graphCanvasRef = useRef<HTMLDivElement | null>(null)
 const graphScrollRef = useRef<HTMLDivElement | null>(null)
 const lastCenteredKeyRef = useRef<string | null>(null)
 const zoomAnchorRef = useRef<TaskGraphZoomAnchor | null>(null)
 // Latest zoom mirrored into a ref so the native (non-passive) wheel listener
 // reads the current value without re-binding on every zoom change.
 const graphZoomRef = useRef(graphZoom)
 graphZoomRef.current = graphZoom
 // Drag-to-pan ("hand") session — tracks the pointer + scroll origin so a
 // press-and-drag on empty canvas scrolls the viewport, Excalidraw style.
 const panSessionRef = useRef<{
 pointerId: number
 startX: number
 startY: number
 startScrollLeft: number
 startScrollTop: number
 } | null>(null)
 const [isPanning, setIsPanning] = useState(false)
 const hasNodes = graph.nodes.length > 0

 const captureZoomAnchor = (viewportX?: number, viewportY?: number): TaskGraphZoomAnchor | null => {
 const scrollEl = graphScrollRef.current
 if (!scrollEl) return null

 const resolvedViewportX = viewportX ?? scrollEl.clientWidth / 2
 const resolvedViewportY = viewportY ?? scrollEl.clientHeight / 2

 return {
 graphX: (scrollEl.scrollLeft + resolvedViewportX) / graphZoom,
 graphY: (scrollEl.scrollTop + resolvedViewportY) / graphZoom,
 viewportX: resolvedViewportX,
 viewportY: resolvedViewportY,
 }
 }

 const setGraphZoomFromAnchor = (
 nextZoom: number,
 anchor: TaskGraphZoomAnchor | null = captureZoomAnchor()
 ) => {
 if (Math.abs(nextZoom - graphZoom) < 0.001) return
 zoomAnchorRef.current = anchor
 setGraphZoom(nextZoom)
 }

 const fitGraphToViewport = () => {
 const scrollEl = graphScrollRef.current
 if (!scrollEl) return

 const availableWidth = Math.max(1, scrollEl.clientWidth - 48)
 const availableHeight = Math.max(1, scrollEl.clientHeight - 48)
 const fitZoom = Math.min(1, availableWidth / graph.canvasWidth, availableHeight / graph.canvasHeight)
 setGraphZoomFromAnchor(Math.max(minTaskGraphZoom, Math.min(maxTaskGraphZoom, fitZoom)))
 }

 useEffect(() => {
 const scrollEl = graphScrollRef.current
 const focusNode = focusTaskId ? graph.nodesById[focusTaskId] : null
 if (!scrollEl || !focusNode) return

 const centerKey = `${focusTaskId}:${graph.canvasWidth}:${graph.canvasHeight}`
 if (lastCenteredKeyRef.current === centerKey) return
 lastCenteredKeyRef.current = centerKey

 const frame = window.requestAnimationFrame(() => {
 scrollEl.scrollTo({
 left: Math.max(0, focusNode.x * graphZoom - scrollEl.clientWidth / 2),
 top: Math.max(0, focusNode.y * graphZoom - scrollEl.clientHeight / 2),
 behavior: 'smooth',
 })
 })

 return () => window.cancelAnimationFrame(frame)
 }, [focusTaskId, graph, graphZoom])

 useEffect(() => {
 const scrollEl = graphScrollRef.current
 const anchor = zoomAnchorRef.current
 if (!scrollEl || !anchor) return
 zoomAnchorRef.current = null

 const frame = window.requestAnimationFrame(() => {
 scrollEl.scrollLeft = Math.max(0, anchor.graphX * graphZoom - anchor.viewportX)
 scrollEl.scrollTop = Math.max(0, anchor.graphY * graphZoom - anchor.viewportY)
 })

 return () => window.cancelAnimationFrame(frame)
 }, [graphZoom])

 // Excalidraw-style navigation: a plain scroll wheel / two-finger trackpad
 // swipe pans via the browser's native scrolling, while pinch-zoom — which
 // Chromium delivers as a ctrl/meta + wheel event — zooms toward the cursor.
 // Bound as a native non-passive listener so preventDefault reliably
 // suppresses the browser's own pinch-zoom; React attaches wheel passively.
 useEffect(() => {
 const scrollEl = graphScrollRef.current
 if (!scrollEl) return

 const onWheel = (event: WheelEvent) => {
 if (graph.nodes.length === 0) return
 // Let the native overflow scroll pan the canvas for unmodified wheels.
 if (!event.ctrlKey && !event.metaKey) return
 event.preventDefault()

 const rect = scrollEl.getBoundingClientRect()
 const viewportX = event.clientX - rect.left
 const viewportY = event.clientY - rect.top
 const currentZoom = graphZoomRef.current
 const nextZoom = Math.max(
 minTaskGraphZoom,
 Math.min(maxTaskGraphZoom, currentZoom * Math.exp(-event.deltaY * 0.0015))
 )
 if (Math.abs(nextZoom - currentZoom) < 0.0005) return

 zoomAnchorRef.current = {
 graphX: (scrollEl.scrollLeft + viewportX) / currentZoom,
 graphY: (scrollEl.scrollTop + viewportY) / currentZoom,
 viewportX,
 viewportY,
 }
 setGraphZoom(nextZoom)
 }

 scrollEl.addEventListener('wheel', onWheel, { passive: false })
 return () => scrollEl.removeEventListener('wheel', onWheel)
 }, [graph.nodes.length])

 // Press-and-drag to pan: left button on empty canvas (clicks on task nodes
 // still select them) or middle button anywhere. Pointer capture keeps the
 // drag alive even when the cursor leaves the viewport.
 const handleGraphPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
 const scrollEl = graphScrollRef.current
 if (!scrollEl || graph.nodes.length === 0) return

 const isMiddle = event.button === 1
 const isLeft = event.button === 0
 if (!isMiddle && !isLeft) return
 if (isLeft && (event.target as HTMLElement).closest('[data-task-graph-node]')) return

 panSessionRef.current = {
 pointerId: event.pointerId,
 startX: event.clientX,
 startY: event.clientY,
 startScrollLeft: scrollEl.scrollLeft,
 startScrollTop: scrollEl.scrollTop,
 }
 scrollEl.setPointerCapture(event.pointerId)
 setIsPanning(true)
 if (isMiddle) event.preventDefault()
 }

 const handleGraphPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
 const session = panSessionRef.current
 const scrollEl = graphScrollRef.current
 if (!session || !scrollEl || session.pointerId !== event.pointerId) return

 scrollEl.scrollLeft = session.startScrollLeft - (event.clientX - session.startX)
 scrollEl.scrollTop = session.startScrollTop - (event.clientY - session.startY)
 }

 const endGraphPan = (event: React.PointerEvent<HTMLDivElement>) => {
 const session = panSessionRef.current
 if (!session || session.pointerId !== event.pointerId) return

 panSessionRef.current = null
 setIsPanning(false)
 const scrollEl = graphScrollRef.current
 if (scrollEl?.hasPointerCapture(event.pointerId)) {
 scrollEl.releasePointerCapture(event.pointerId)
 }
 }

 const terminalCount = graph.terminalTaskIds.length
 const zoomPercent = Math.round(graphZoom * 100)
 const canZoomOut = graphZoom > minTaskGraphZoom + 0.001
 const canZoomIn = graphZoom < maxTaskGraphZoom - 0.001
 const canResetZoom = Math.abs(graphZoom - defaultTaskGraphZoom) >= 0.001

 const taskCount = sprintEngineState.tasks.length
 const boardColumnByTaskId = useMemo(() => {
 const map = new Map<string, ReturnType<typeof getSprintEngineTaskBoardColumn>>()
 for (const task of sprintEngineState.tasks) {
 map.set(task.id, getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks))
 }
 return map
 }, [sprintEngineState.tasks])
 const readyCount = useMemo(
 () => sprintEngineState.tasks.filter((task) => boardColumnByTaskId.get(task.id) === 'ready').length,
 [sprintEngineState.tasks, boardColumnByTaskId]
 )
 const doneCount = useMemo(
 () => sprintEngineState.tasks.filter((task) => task.status === 'done').length,
 [sprintEngineState.tasks]
 )
 const inFlightCount = useMemo(
 () => sprintEngineState.tasks.filter(
 (task) => task.status === 'in_progress' || task.status === 'needs_input'
 ).length,
 [sprintEngineState.tasks]
 )
 const reviewCount = useMemo(
 () => sprintEngineState.tasks.filter((task) => boardColumnByTaskId.get(task.id) === 'review').length,
 [sprintEngineState.tasks, boardColumnByTaskId]
 )

 const hasWarning = graph.hasCycle || graph.missingDependencyCount > 0
 const warningMessage = [
 graph.hasCycle ? 'Dependency cycle detected' : null,
 graph.missingDependencyCount > 0
 ? `${graph.missingDependencyCount} missing ${graph.missingDependencyCount === 1 ? 'dependency' : 'dependencies'}`
 : null,
 ].filter(Boolean).join(' · ')

 const [legendOpen, setLegendOpen] = useState(true)
 const [minimapOpen, setMinimapOpen] = useState(true)

 const MINIMAP_MAX_WIDTH = 168
 const MINIMAP_MAX_HEIGHT = 112
 const minimapScale = graph.canvasWidth > 0 && graph.canvasHeight > 0
 ? Math.min(MINIMAP_MAX_WIDTH / graph.canvasWidth, MINIMAP_MAX_HEIGHT / graph.canvasHeight)
 : 1
 const minimapInnerWidth = Math.max(1, graph.canvasWidth * minimapScale)
 const minimapInnerHeight = Math.max(1, graph.canvasHeight * minimapScale)

 // Edges and the per-node "line-blocker" rects derive purely from the graph
 // layout, so memoize them: zoom steps and pan start/stop re-render the view
 // but must not rebuild every SVG path/rect (each edge re-runs taskGraphEdgePath).
 const svgChildElements = useMemo(() => (
 <>
 {graph.edges.map((edge) => {
 const from = graph.nodesById[edge.fromId]
 const to = graph.nodesById[edge.toId]
 if (!from || !to) return null
 return (
 <path
 key={edge.id}
 d={taskGraphEdgePath(from, to)}
 fill="none"
 stroke={edge.color}
 strokeWidth={edge.weight}
 strokeDasharray={edge.dashed ? '7 8' : undefined}
 opacity={edge.opacity}
 strokeLinecap="round"
 strokeLinejoin="round"
 />
 )
 })}
 {graph.nodes.map((node) => (
 <rect
 key={`${node.id}:line-blocker`}
 x={node.x - node.width / 2 - 8}
 y={node.y - node.height / 2 - 8}
 width={node.width + 16}
 height={node.height + 16}
 rx="14"
 fill="var(--bg-app)"
 />
 ))}
 </>
 ), [graph])

 // Minimap dots also derive only from the layout and minimap scale — keep them
 // off the zoom/pan/selection re-render path.
 const minimapDotElements = useMemo(() => graph.nodes.map((node) => {
 if (node.type === 'end') {
 return (
 <div
 key={`mini-${node.id}`}
 className="pointer-events-none absolute rounded-sm"
 style={{
 left: (node.x - node.width / 2) * minimapScale,
 top: (node.y - node.height / 2) * minimapScale,
 width: Math.max(3, node.width * minimapScale),
 height: Math.max(3, node.height * minimapScale),
 backgroundColor: 'color-mix(in srgb, var(--tone-good) 70%, transparent)',
 }}
 />
 )
 }
 return (
 <div
 key={`mini-${node.id}`}
 className="pointer-events-none absolute rounded-sm"
 style={{
 left: (node.x - node.width / 2) * minimapScale,
 top: (node.y - node.height / 2) * minimapScale,
 width: Math.max(3, node.width * minimapScale),
 height: Math.max(3, node.height * minimapScale),
 // A dot has to be drawn to mark the node's position; with no role to
 // tint it, it takes a chrome tone rather than the neutral role accent.
 backgroundColor: node.task.role
 ? hexToRgba(getSprintEngineRoleAccent(node.task.role), 0.55)
 : 'var(--text-subtle)',
 }}
 />
 )
 }), [graph, minimapScale])

 // Task nodes are the heaviest part of the tree (each renders several
 // TruncatedText measurers). Memoize them so zoom/pan re-renders don't rebuild
 // every node — only a real task / selection / focus change does.
 const nodeElements = useMemo(() => graph.nodes.map((node) => {
 if (node.type === 'end') {
 return (
 <div
 key={node.id}
 className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center overflow-hidden [content-visibility:auto] [contain-intrinsic-size:252px_154px] rounded-sm border border-[color:var(--border-default)] bg-[color:var(--tone-good-soft)] px-5 py-4 text-center"
 style={{
 left: node.x,
 top: node.y,
 width: node.width,
 minHeight: node.height,
 }}
 >
 <div className="flex items-center gap-1.5 text-micro font-semibold text-[color:var(--tone-good)]">
 <svg className="icon-xs" viewBox="0 0 12 12" fill="none" aria-hidden="true">
 <path d="M2 6L5 9L10 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 Goal
 </div>
 <TruncatedText
 as="div"
 multiline
 text={formatSprintEngineGoalPreview(sprintEngineState.goal)}
 className="mt-2 line-clamp-3 text-sm font-semibold leading-5 text-[color:var(--tone-good)]"
 />
 <div className="mt-3 text-micro text-[color:var(--text-muted)]">
 {terminalCount} final {terminalCount === 1 ? 'chain' : 'chains'}
 </div>
 </div>
 )
 }

 const task = node.task
 // Fall back to the worker who last implemented the task so a detached
 // in-review/testing/product task still names its owner on the graph node.
 const ownerId = task.ownerAgentId ?? task.lastImplementedByAgentId ?? null
 const ownerAgent = ownerId ? rosterById[ownerId] : undefined
 const ownerRole = ownerAgent?.role ?? (ownerId ? task.role : null)
 const ownerLabel = ownerId ? ownerAgent?.label ?? ownerId : null
 const isFocused = task.id === focusTaskId
 const isSelected = task.id === selectedTaskId
 // Reuse the board-column map computed once per state change rather than
 // re-deriving it per node (each derivation scans every task → O(n²) per
 // render). The map always carries this task, so the fallback is inert.
 const boardColumn = boardColumnByTaskId.get(task.id)
 ?? getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks)
 const dependencyLabel = task.dependsOn.length > 0
 ? `${task.dependsOn.length} ${task.dependsOn.length === 1 ? 'dep' : 'deps'}`
 : 'root'

 return (
 <button
 key={node.id}
 data-task-graph-node={task.id}
 onClick={() => onSelectTask(task.id)}
 aria-pressed={isSelected}
 className={`absolute flex -translate-x-1/2 -translate-y-1/2 cursor-pointer flex-col overflow-hidden rounded-sm border p-3 text-left transition-colors [content-visibility:auto] [contain-intrinsic-size:272px_154px] focus-visible:focus-ring ${taskGraphNodeClass(isSelected, isFocused)} ${
 isSelected || isFocused ? 'z-10' : 'z-0'
 }`}
 style={{
 left: node.x,
 top: node.y,
 width: node.width,
 minHeight: node.height,
 }}
 >
 {/* The node's role swatch and label are the role itself: a task with
 none renders neither, rather than a neutral stand-in (MC-2055). The
 role-accent left bar that used to sit beside them is gone (ruling 7):
 the swatch is the role's one carrier on the node. */}
 <div className="flex items-start justify-between gap-3">
 <div className="min-w-0">
 <TruncatedText as="div" multiline text={task.title} className="line-clamp-2 text-sm font-semibold leading-5 text-[color:var(--text-strong)]" />
 <div className="mt-1 flex min-w-0 items-center gap-1.5 text-micro text-[color:var(--text-muted)]">
 <span>{task.id}</span>
 {task.role ? (
 <>
 {/* design-tokens-allow: role accent swatch on the task-graph node label — role color is the documented exception. */}
 <span
 className="h-1.5 w-1.5 shrink-0 rounded-full"
 style={{
 backgroundColor: getSprintEngineRoleAccent(task.role),
 }}
 />
 <span className="min-w-0 truncate" style={{ color: getSprintEngineRoleAccent(task.role) }}>
 {getSprintEngineRoleLabel(task.role)}
 </span>
 </>
 ) : null}
 </div>
 </div>
 {/* One status idiom: the shared lifecycle glyph beside the word, in
 neutral ink — the tinted pill that used to sit here said the same
 thing a second time, by colour (ruling 7). */}
 <span className="flex max-w-[112px] shrink-0 items-center gap-1 text-micro font-medium text-[color:var(--text-muted)]">
 <LifecycleGlyph state={taskBoardColumnToLifecycle(boardColumn)} live={false} />
 <span className="min-w-0 truncate">{taskGraphNodeStatusLabel(task.status, boardColumn)}</span>
 </span>
 </div>

 <TruncatedText
 as="p"
 multiline
 text={task.description || 'No description recorded.'}
 className="mt-3 line-clamp-2 text-meta leading-5 text-[color:var(--text-muted)]"
 />

 <div className="mt-3 flex flex-wrap gap-x-2 gap-y-1 text-micro text-[color:var(--text-muted)]">
 <span>
 {dependencyLabel}
 </span>
 <span className="text-[color:var(--text-disabled)]">/</span>
 <span>
 {task.acceptanceCriteria.length} checks
 </span>
 {/* The owner is named whether or not it has a role; only the role
 tint is conditional on there being a role to tint with. */}
 {ownerLabel ? (
 <>
 <span className="text-[color:var(--text-disabled)]">/</span>
 <span
 className="max-w-full truncate"
 style={ownerRole ? { color: getSprintEngineRoleAccent(ownerRole) } : undefined}
 >
 {ownerLabel}
 </span>
 </>
 ) : null}
 </div>
 </button>
 )
 }), [graph, rosterById, focusTaskId, selectedTaskId, boardColumnByTaskId, sprintEngineState, terminalCount, onSelectTask])

 // The minimap viewport rectangle is the only thing that tracks scroll position,
 // so we position it imperatively: a passive scroll listener writes straight to
 // this element's style. Routing it through React state instead would re-render
 // the whole graph — every task node, edge, and minimap dot — on every pan
 // frame, which is the source of the graph-mode jank on large runs.
 const minimapViewportRef = useRef<HTMLDivElement | null>(null)
 const minimapMetricsRef = useRef({
 zoom: graphZoom,
 scale: minimapScale,
 innerWidth: minimapInnerWidth,
 innerHeight: minimapInnerHeight,
 })
 minimapMetricsRef.current = {
 zoom: graphZoom,
 scale: minimapScale,
 innerWidth: minimapInnerWidth,
 innerHeight: minimapInnerHeight,
 }

 const applyMinimapViewport = useCallback(() => {
 const scrollEl = graphScrollRef.current
 const rectEl = minimapViewportRef.current
 if (!scrollEl || !rectEl) return
 const { zoom, scale, innerWidth, innerHeight } = minimapMetricsRef.current
 const graphLeft = scrollEl.scrollLeft / zoom
 const graphTop = scrollEl.scrollTop / zoom
 const graphWidth = scrollEl.clientWidth / zoom
 const graphHeight = scrollEl.clientHeight / zoom
 rectEl.style.left = `${Math.max(0, graphLeft * scale)}px`
 rectEl.style.top = `${Math.max(0, graphTop * scale)}px`
 rectEl.style.width = `${Math.max(4, Math.min(innerWidth, graphWidth * scale))}px`
 rectEl.style.height = `${Math.max(4, Math.min(innerHeight, graphHeight * scale))}px`
 }, [])

 useEffect(() => {
 const scrollEl = graphScrollRef.current
 if (!scrollEl) return

 let frame: number | null = null
 const scheduleApply = () => {
 if (frame !== null) return
 frame = window.requestAnimationFrame(() => {
 frame = null
 applyMinimapViewport()
 })
 }

 scheduleApply()
 scrollEl.addEventListener('scroll', scheduleApply, { passive: true })
 const resizeObserver = new ResizeObserver(scheduleApply)
 resizeObserver.observe(scrollEl)

 return () => {
 if (frame !== null) window.cancelAnimationFrame(frame)
 scrollEl.removeEventListener('scroll', scheduleApply)
 resizeObserver.disconnect()
 }
 }, [applyMinimapViewport])

 // Re-apply on zoom, layout, or visibility change — the rect element only mounts
 // while the minimap disclosure is open, and zoom/scale shift its geometry.
 useEffect(() => {
 applyMinimapViewport()
 }, [applyMinimapViewport, graphZoom, minimapScale, minimapInnerWidth, minimapInnerHeight, minimapOpen])

 const panFromMinimap = (clientX: number, clientY: number, element: HTMLElement) => {
 const scrollEl = graphScrollRef.current
 if (!scrollEl || minimapScale <= 0) return
 const rect = element.getBoundingClientRect()
 const graphX = (clientX - rect.left) / minimapScale
 const graphY = (clientY - rect.top) / minimapScale
 scrollEl.scrollTo({
 left: Math.max(0, graphX * graphZoom - scrollEl.clientWidth / 2),
 top: Math.max(0, graphY * graphZoom - scrollEl.clientHeight / 2),
 })
 }

 const handleGraphKeyDown = useCallback(
 (event: React.KeyboardEvent<HTMLDivElement>) => {
 if (isEditableTarget(event.target)) return
 if (event.metaKey || event.ctrlKey || event.altKey) return

 const isArrow = event.key === 'ArrowUp' || event.key === 'ArrowDown'
 || event.key === 'ArrowLeft' || event.key === 'ArrowRight'
 if (!isArrow) return

 const firstTaskNode = graph.nodes.find((node) => node.type === 'task')
 const currentId = selectedTaskId ?? focusTaskId ?? firstTaskNode?.id ?? null
 if (!currentId) return

 event.preventDefault()
 const goBack = event.key === 'ArrowUp' || event.key === 'ArrowLeft'
 let nextId: string | null = null
 if (goBack) {
 const predecessor = graph.edges.find((edge) => edge.toId === currentId)
 if (predecessor) nextId = predecessor.fromId
 } else {
 const successor = graph.edges.find(
 (edge) => edge.fromId === currentId && edge.toId !== 'end-product'
 )
 if (successor) nextId = successor.toId
 }

 if (!nextId) {
 // No neighbor in that direction; if nothing is selected yet, seed selection.
 if (!selectedTaskId) {
 onSelectTask(currentId)
 }
 return
 }

 onSelectTask(nextId)

 const scrollEl = graphScrollRef.current
 const nextNode = graph.nodesById[nextId]
 if (scrollEl && nextNode) {
 scrollEl.scrollTo({
 left: Math.max(0, nextNode.x * graphZoom - scrollEl.clientWidth / 2),
 top: Math.max(0, nextNode.y * graphZoom - scrollEl.clientHeight / 2),
 behavior: 'smooth',
 })
 const button = scrollEl.querySelector<HTMLButtonElement>(
 `[data-task-graph-node="${nextId}"]`
 )
 button?.focus()
 }
 },
 [focusTaskId, graph, graphZoom, onSelectTask, selectedTaskId]
 )

 return (
 <div
 className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[color:var(--bg-surface)]"
 onKeyDown={handleGraphKeyDown}
 >
      {/* The graph's identity row, on the shared primitive. It hand-rolled the
          band at `px-6 py-3` — 12px in from every sibling and 4px taller —
          under a `text-micro font-bold` heading, which is the smallest type in
          the ramp doing a title's job (2112). The per-state counts are the
          title's scope; the zoom cluster is its one control.

          The band used to `flex-wrap`, so on a narrow pane the counts pushed
          the header onto a second line and the graph below it moved. One row
          now: the counts give up their space first, and the warning — which
          must never be the thing that gets clipped — states itself in a band of
          its own beneath. */}
      <PanelHeader
        title="Task graph"
        count={taskCount}
        scope={
          // `overflow-hidden`, not `flex-wrap`: the counts are the first thing
          // that may be given up when the pane narrows, and a header that grows
          // a second line moves the graph under it.
          <div className="flex min-w-0 items-center gap-x-4 overflow-hidden text-meta text-[color:var(--text-subtle)]">
            {readyCount > 0 ? (
              <span className="text-[color:var(--tone-good)]">
                <span className="font-semibold">{readyCount}</span> ready
              </span>
            ) : null}
            {inFlightCount > 0 ? (
              <span className="text-[color:var(--tone-warn)]">
                <span className="font-semibold">{inFlightCount}</span> in flight
              </span>
            ) : null}
            {reviewCount > 0 ? (
              <span className="text-[color:var(--tone-warn)]">
                <span className="font-semibold">{reviewCount}</span> review
              </span>
            ) : null}
            {doneCount > 0 ? (
              <span className="text-[color:var(--tone-good)]">
                <span className="font-semibold">{doneCount}</span> done
              </span>
            ) : null}
            {terminalCount > 0 ? (
              <span>
                <span className="font-semibold text-[color:var(--text-default)]">{terminalCount}</span> final {terminalCount === 1 ? 'chain' : 'chains'}
              </span>
            ) : null}
          </div>
        }
        primaryAction={
          <div className="flex items-center gap-1 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-0.5">
            <Tooltip content="Zoom out">
              <IconButton
                onClick={() => setGraphZoomFromAnchor(getNextTaskGraphZoom(graphZoom, 'out'))}
                disabled={!canZoomOut}
                aria-label="Zoom out task graph"
              >
                <ZoomOutSprintEngineIcon />
              </IconButton>
            </Tooltip>
            <div
              className="min-w-[2.75rem] px-1 text-center text-micro font-semibold tabular-nums text-[color:var(--text-default)]"
              aria-live="polite"
            >
              {zoomPercent}%
            </div>
            <Tooltip content="Zoom in">
              <IconButton
                onClick={() => setGraphZoomFromAnchor(getNextTaskGraphZoom(graphZoom, 'in'))}
                disabled={!canZoomIn}
                aria-label="Zoom in task graph"
              >
                <ZoomInSprintEngineIcon />
              </IconButton>
            </Tooltip>
            <span className="mx-0.5 h-4 w-px bg-[color:var(--border-default)]" aria-hidden="true" />
            <Tooltip content="Fit graph">
              <IconButton onClick={fitGraphToViewport} aria-label="Fit task graph to viewport">
                <FitGraphZoomIcon />
              </IconButton>
            </Tooltip>
            <Tooltip content="Reset zoom">
              <IconButton
                onClick={() => setGraphZoomFromAnchor(defaultTaskGraphZoom)}
                disabled={!canResetZoom}
                aria-label="Reset task graph zoom"
              >
                <ResetGraphZoomIcon />
              </IconButton>
            </Tooltip>
          </div>
        }
      />
      {hasWarning ? (
        <div className="flex shrink-0 items-center border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2">
          <span
            role="alert"
            className="inline-flex items-center gap-1.5 text-micro font-medium text-[color:var(--tone-warn)]"
          >
            <svg className="icon-sm" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 1.75L14.75 13.5H1.25L8 1.75Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
              <path d="M8 6.5V9.75" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <circle cx="8" cy="11.6" r="0.7" fill="currentColor" />
            </svg>
            {warningMessage}
          </span>
        </div>
      ) : null}
 <div className="relative min-h-[460px] flex-1">
 <div
 ref={graphScrollRef}
 onPointerDown={handleGraphPointerDown}
 onPointerMove={handleGraphPointerMove}
 onPointerUp={endGraphPan}
 onPointerCancel={endGraphPan}
 className={`absolute inset-0 overflow-auto ${
 hasNodes ? `select-none ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}` : ''
 }`}
 >
 {taskCount === 0 ? (
 <div className="absolute inset-0">
 <EmptyState
 glyph={
 <span aria-hidden="true" className="block size-icon-lg rounded-full border border-[color:var(--border-default)]" />
 }
 title="Waiting for the architect plan"
 body="Tasks and their dependencies will appear here as the architect builds out the run."
 />
 </div>
 ) : (
 <div
 className="relative"
 style={{
 width: graph.canvasWidth * graphZoom,
 height: graph.canvasHeight * graphZoom,
 }}
 >
 <div
 ref={graphCanvasRef}
 className="relative"
 style={{
 width: graph.canvasWidth,
 height: graph.canvasHeight,
 transform: `scale(${graphZoom})`,
 transformOrigin: 'top left',
 backgroundColor: 'var(--bg-app)',
 }}
 >
 <svg
 className="pointer-events-none absolute inset-0"
 width={graph.canvasWidth}
 height={graph.canvasHeight}
 viewBox={`0 0 ${graph.canvasWidth} ${graph.canvasHeight}`}
 >
 {svgChildElements}
 </svg>

 {nodeElements}
 </div>
 </div>
 )}

 </div>

 {taskCount > 0 ? (
 <div className="pointer-events-none absolute bottom-3 left-3 z-[var(--z-float)]">
 <div className="pointer-events-auto inline-flex flex-col items-start">
 <button
 type="button"
 onClick={() => setLegendOpen((open) => !open)}
 aria-expanded={legendOpen}
 className="flex items-center gap-1.5 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2.5 py-1 text-micro font-semibold text-[color:var(--text-muted)] interactive hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:focus-ring"
 >
 Legend
 <svg
 className={`icon-xs transition-transform ${legendOpen ? 'rotate-180' : ''}`}
 viewBox="0 0 12 12"
 fill="none"
 aria-hidden="true"
 >
 <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 </button>
 {legendOpen ? (
 // Inline disclosure under the legend toggle: flow-positioned, no outside-click,
 // no Escape close. Not a popover semantically — kept as a graph-overlay
 // disclosure card so it doesn't fight canvas pan/zoom interactions.
 <div className="mt-1 rounded-[var(--radius-md)] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-3 text-micro shadow-[var(--shadow-drawer)]">
 <div className="text-meta font-semibold text-[color:var(--text-muted)]">
 Status
 </div>
 {/* The legend is the node's own status idiom enumerated: the same
 LifecycleGlyph over the same board lanes, in the order the board
 shows them. The swatch rows it replaces described a colour channel
 the graph stopped painting when `taskGraphStatusTone` was deleted,
 and contradicted the glyph that took its place — ready and
 in_progress are the accent, only done is --tone-good. */}
 <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[color:var(--text-muted)]">
 {sprintEngineTaskBoardColumns.map((column) => (
 <span key={column.key} className="flex items-center gap-1.5">
 <LifecycleGlyph state={taskBoardColumnToLifecycle(column.key)} live={false} />
 <span>{column.label}</span>
 </span>
 ))}
 </div>
 <div className="mt-3 border-t border-[color:var(--border-default)] pt-2 text-micro leading-5 text-[color:var(--text-subtle)]">
 <div>Edge color &middot; dependency state (green when complete)</div>
 <div>Ring &middot; the task the view centred on</div>
 </div>
 </div>
 ) : null}
 </div>
 </div>
 ) : null}

 {taskCount > 0 ? (
 <div className="pointer-events-none absolute bottom-3 right-3 z-[var(--z-float)]">
 <div className="pointer-events-auto inline-flex flex-col items-end">
 <button
 type="button"
 onClick={() => setMinimapOpen((open) => !open)}
 aria-expanded={minimapOpen}
 className="flex items-center gap-1.5 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2.5 py-1 text-micro font-semibold text-[color:var(--text-muted)] interactive hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:focus-ring"
 >
 Minimap
 <svg
 className={`icon-xs transition-transform ${minimapOpen ? 'rotate-180' : ''}`}
 viewBox="0 0 12 12"
 fill="none"
 aria-hidden="true"
 >
 <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 </button>
 {minimapOpen ? (
 // Inline disclosure under the minimap toggle: flow-positioned, no
 // outside-click, no Escape close. Not a popover semantically — kept as a
 // graph-overlay disclosure card so canvas pan/zoom keeps working.
 <div className="mt-1 rounded-[var(--radius-md)] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-2 shadow-[var(--shadow-drawer)]">
 <div
 className="relative cursor-crosshair overflow-hidden rounded-sm bg-[color:var(--bg-surface)]"
 style={{ width: minimapInnerWidth, height: minimapInnerHeight }}
 onPointerDown={(event) => {
 if (event.button !== 0) return
 const element = event.currentTarget
 element.setPointerCapture(event.pointerId)
 panFromMinimap(event.clientX, event.clientY, element)
 }}
 onPointerMove={(event) => {
 if (event.buttons !== 1) return
 panFromMinimap(event.clientX, event.clientY, event.currentTarget)
 }}
 role="img"
 aria-label="Task graph minimap"
 >
 {minimapDotElements}
 <div
 ref={minimapViewportRef}
 className="pointer-events-none absolute rounded-sm border border-[color:var(--accent-primary-soft)] bg-[color:var(--accent-primary-soft)]"
 style={{ left: 0, top: 0, width: 4, height: 4 }}
 />
 </div>
 </div>
 ) : null}
 </div>
 </div>
 ) : null}
 </div>
 </div>
 )
}
